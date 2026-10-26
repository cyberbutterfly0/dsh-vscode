/**
 * runtime 获取：spawn 自己的 `dsh web --port 0 --no-open`，或者 attach 用户已有的实例。
 *
 * 本文件只负责「找到 dsh 可执行文件 + 起进程 + 从 stdout 抓 tokenized URL」。
 * 鉴权在 auth.ts，连接管理在 client.ts。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseLaunchUrl, type LaunchTarget } from './auth';
import type { Logger } from '../log';

export interface CliCandidate {
  file: string;
  args: string[];
  /** 人类可读的来源说明，报错时给用户看 */
  source: string;
  useShell: boolean;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function which(cmd: string): string | undefined {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return undefined;
    const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** 常见 npm 全局安装下的 dsh 入口（不依赖 PATH）。 */
export function knownInstallPaths(): string[] {
  const out: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) out.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  const home = os.homedir();
  out.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  out.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  out.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  return out;
}

/**
 * 按优先级给出一串「怎么起 dsh」的候选。
 * 上层逐个尝试，第一个能打出 tokenized URL 的胜出。
 */
export function findDshCandidates(cliPath?: string): CliCandidate[] {
  const list: CliCandidate[] = [];
  const envCli = process.env.DSH_CLI;
  const configured = (cliPath || '').trim();

  for (const [value, source] of [
    [configured, 'dsh.cliPath'],
    [envCli, 'DSH_CLI 环境变量'],
  ] as const) {
    if (!value) continue;
    if (value.endsWith('.js') || value.endsWith('.cjs') || value.endsWith('.mjs')) {
      list.push({ file: process.env.DSH_NODE || which('node') || 'node', args: [value], source, useShell: false });
    } else {
      list.push({ file: value, args: [], source, useShell: process.platform === 'win32' });
    }
  }

  const onPath = which('dsh');
  if (onPath) list.push({ file: onPath, args: [], source: 'PATH', useShell: process.platform === 'win32' });

  const nodeExe = which('node');
  if (nodeExe) {
    for (const p of knownInstallPaths()) {
      if (exists(p)) list.push({ file: nodeExe, args: [p], source: `全局安装 ${p}`, useShell: false });
    }
  }

  return list;
}

export interface SpawnOptions {
  cliPath?: string;
  extraArgs?: string[];
  cwd?: string;
  logger: Logger;
  timeoutMs?: number;
}

export interface SpawnedRuntime {
  launchUrl: string;
  target: LaunchTarget;
  child: ChildProcess;
  /** 停进程（Windows 上要把整棵进程树干掉） */
  dispose(): void;
  /** 子进程退出时回调 */
  onExit(cb: (code: number | null) => void): void;
}

export class RuntimeUnavailableError extends Error {
  constructor(
    message: string,
    readonly tried: string[],
  ) {
    super(message);
    this.name = 'RuntimeUnavailableError';
  }
}

const URL_RE = /dsh web:\s*(https?:\/\/\S+)/i;

function waitForUrl(
  child: ChildProcess,
  timeoutMs: number,
  logger: Logger,
  onLine: (line: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`等待 dsh 打印 URL 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    const finish = (err: Error | undefined, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(url as string);
    };

    const consume = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        onLine(line);
        const m = URL_RE.exec(line) || (line.includes('token=') ? /(https?:\/\/\S+)/.exec(line) : null);
        if (m) finish(undefined, m[1]);
      }
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-8 * 1024);
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('exit', (code) => finish(new Error(`dsh 进程提前退出（code=${code}）`)));
    child.on('error', (e) => finish(e));
  });
}

function killTree(child: ChildProcess, logger: Logger): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      logger('debug', 'taskkill 失败', (e as Error).message);
    }
  } else {
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000).unref?.();
    } catch {
      /* ignore */
    }
  }
}

async function trySpawn(candidate: CliCandidate, noOpen: boolean, opts: SpawnOptions): Promise<SpawnedRuntime> {
  const args = [...candidate.args, 'web', '--port', '0', ...(noOpen ? ['--no-open'] : []), ...(opts.extraArgs || [])];
  opts.logger('info', `spawn: ${candidate.file} ${args.join(' ')} (${candidate.source})`);
  const child = spawn(candidate.file, args, {
    cwd: opts.cwd || os.tmpdir(),
    shell: candidate.useShell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_VSCODE_SPAWNED: '1' },
  });

  const stderrTail: string[] = [];
  try {
    const rawUrl = await waitForUrl(child, opts.timeoutMs ?? 45000, opts.logger, (line) => {
      if (line.trim()) {
        if (stderrTail.length > 40) stderrTail.shift();
        stderrTail.push(line);
        opts.logger('debug', `[dsh] ${line}`);
      }
    });
    const target = parseLaunchUrl(rawUrl);
    if (!target) {
      killTree(child, opts.logger);
      throw new Error(`dsh 打印的 URL 里没有 token：${rawUrl}`);
    }
    return {
      launchUrl: rawUrl,
      target,
      child,
      dispose: () => killTree(child, opts.logger),
      onExit: (cb) => child.on('exit', (code) => cb(code)),
    };
  } catch (e) {
    killTree(child, opts.logger);
    const msg = (e as Error).message;
    const detail = stderrTail.slice(-8).join(' | ');
    const err = new Error(`${msg}${detail ? ' :: ' + detail : ''}`);
    (err as Error & { stderrTail?: string }).stderrTail = detail;
    throw err;
  }
}

/**
 * 起一个 dsh web 实例并拿到 tokenized URL。
 * 会依次尝试候选 CLI；`--no-open` 不被支持时自动去掉重试。
 */
export async function spawnRuntime(opts: SpawnOptions): Promise<SpawnedRuntime> {
  const candidates = findDshCandidates(opts.cliPath);
  if (!candidates.length) {
    throw new RuntimeUnavailableError(
      '没有找到 dsh。请先安装：npm i -g @deepseek-ai/dsh，或在设置里填 dsh.cliPath。',
      [],
    );
  }

  const tried: string[] = [];
  let lastErr: Error | undefined;
  for (const candidate of candidates) {
    for (const noOpen of [true, false]) {
      tried.push(`${candidate.file} (${candidate.source})${noOpen ? '' : ' [no --no-open]'}`);
      try {
        return await trySpawn(candidate, noOpen, opts);
      } catch (e) {
        lastErr = e as Error;
        const msg = lastErr.message || '';
        opts.logger('debug', `候选失败 ${candidate.file}: ${msg}`);
        // 只有「不认识 --no-open」才值得去掉参数重试，其它错误直接换下一个候选
        if (noOpen && !/unknown option|unknown argument|--no-open/i.test(msg)) break;
      }
    }
  }
  throw new RuntimeUnavailableError(`启动 dsh runtime 失败：${lastErr?.message ?? '未知错误'}`, tried);
}

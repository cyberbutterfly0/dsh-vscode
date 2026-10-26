/**
 * 连接管理器：把「凭据 + 一元 RPC + WS 多路复用 + typed API」捏成一个对象。
 *
 * 多窗口单例的关键在 `credentials.json`：VS Code 每个窗口是独立进程，
 * 但 dsh 一个 authority 只认一个 operator（重新 /connect 会顶掉前一个），
 * 所以把换出来的 v2 cookie 落盘，后开的窗口先拿它探活，活了就直接用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DshApi } from './api';
import { exchangeLaunchToken, parseLaunchUrl, probeCookie, type ApiSession, type LaunchTarget } from './auth';
import { MuxClient, type MuxState, type StreamHandle, type StreamHandlers } from './mux';
import { UnaryClient } from './rpc';
import { spawnRuntime, type SpawnedRuntime } from './runtime';
import type { SessionEventEntry, SessionFollowFrame, SessionControlFrame } from './types';
import type { Logger } from '../log';

export type ConnectMode = 'auto' | 'spawn' | 'attach';

export interface ConnectOptions {
  mode: ConnectMode;
  /** attach 模式下的 URL（带 token）或裸 base */
  attachUrl?: string;
  cliPath?: string;
  extraSpawnArgs?: string[];
  /** spawn 后等 URL 的超时 */
  startTimeoutMs?: number;
  /** 追加给 dsh 进程的环境变量 */
  env?: Record<string, string>;
  logger: Logger;
  /** 凭据共享文件，默认 ~/.dsh/dsh-vscode/instances.json */
  stateFile?: string;
  onMuxState?: (state: MuxState, detail?: string) => void;
}

export interface ConnectResult {
  authority: string;
  base: string;
  launchUrl: string;
  /** spawned：我们自己起的；attached：连的别人的 */
  origin: 'spawned' | 'attached';
  reusedCredential: boolean;
}

interface StoredInstance {
  authority: string;
  base: string;
  launchUrl: string;
  cookie: string;
  cookieName: string;
  expiresAt?: number;
  /** 谁起的进程：'vscode' 表示本扩展起的，窗口关了应该杀掉 */
  owner: 'vscode' | 'external';
  savedAt: number;
}

interface StoreFile {
  version: 1;
  instances: Record<string, StoredInstance>;
}

export function defaultStateFile(): string {
  return path.join(os.homedir(), '.dsh', 'dsh-vscode', 'instances.json');
}

function readStore(file: string, logger: Logger): StoreFile {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw) as StoreFile;
    if (obj && obj.version === 1 && obj.instances) return obj;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logger('debug', `读取凭据文件失败: ${file}`, (e as Error).message);
  }
  return { version: 1, instances: {} };
}

function writeStore(file: string, store: StoreFile, logger: Logger): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    logger('warn', `写入凭据文件失败: ${file}`, (e as Error).message);
  }
}

export class DshConnection {
  readonly api: DshApi;
  readonly mux: MuxClient;
  private readonly unary: UnaryClient;
  private readonly opts: ConnectOptions;
  private readonly stateFile: string;
  private session: ApiSession;
  private runtime: SpawnedRuntime | undefined;
  private disposed = false;
  /** 上次「接管连接」的时间戳，用于 409 冷却，避免两个窗口互相踢 */
  private lastTakeoverAt = 0;
  /** 连续 401 换凭据的次数：一直失败说明有人在同一 token 上反复顶你，别再死循环 */
  private auth401Streak = 0;

  private constructor(opts: ConnectOptions, session: ApiSession, logger: Logger) {
    this.opts = opts;
    this.stateFile = opts.stateFile || defaultStateFile();
    this.session = session;
    this.unary = new UnaryClient({
      base: session.base,
      cookie: session.cookie,
      logger,
      onUnauthorized: () => this.refreshCredential(),
    });
    this.api = new DshApi(this.unary);
    this.mux = new MuxClient({
      getAuth: async () => ({ authority: this.session.authority, cookie: this.session.cookie }),
      logger,
      onState: (state) => {
        // 连上了就把 401 连败计数清掉
        if (state === 'open') this.auth401Streak = 0;
        opts.onMuxState?.(state);
      },
      // 一个 cookie 只能挂一条 mux socket：被 409/401 拒了就换凭据再来一次。
      // 换凭据会让此前用同一 cookie 的 peer（另一个 VS Code 窗口）掉线，这是设计上的取舍。
      onAuthReject: async (status) => {
        // 401 = 凭据过期/被顶掉，必须刷新才可能恢复，不受冷却限制。
        // 409 = 同一个 cookie 已有一条 socket（另一个窗口），抢会把它踢下线，
        //       所以要冷却：60 秒内已经抢过一次就先让给对方，避免互踢成死循环。
        if (status !== 401 && Date.now() - this.lastTakeoverAt < 60_000) {
          logger('warn', 'mux 仍被占用；60 秒内已接管过一次，这次先不抢（另一个窗口正在用）');
          return false;
        }
        if (status === 401) {
          this.auth401Streak += 1;
          if (this.auth401Streak > 3) {
            logger(
              'error',
              '连续换凭据仍被 401 拒：很可能有另一个客户端在用同一个 token 反复顶掉你。停在这里，不再重试。',
            );
            return false;
          }
        } else {
          this.auth401Streak = 0;
        }
        logger(
          'warn',
          status === 409
            ? 'mux 被 409 拒（这个 cookie 已有连接），接管：换新凭据，另一个窗口会掉线'
            : 'mux 被 401 拒（cookie 过期），换新凭据',
        );
        const fresh = await this.refreshCredential().catch((e: Error) => {
          logger('error', '换凭据失败', e.message);
          return undefined;
        });
        if (fresh && status !== 401) this.lastTakeoverAt = Date.now();
        return !!fresh;
      },
    });
  }

  get authority(): string {
    return this.session.authority;
  }

  get base(): string {
    return this.session.base;
  }

  /** 给 iframe 用的带 token URL（token 换 v1 cookie，跟 v2 不互认） */
  get launchUrl(): string {
    return `${this.session.base}/?token=${this.session.launchToken}`;
  }

  get cookie(): string {
    return this.session.cookie;
  }

  // ── 建立连接 ────────────────────────────────────────────────────────────

  static async open(opts: ConnectOptions): Promise<{ connection: DshConnection; result: ConnectResult }> {
    const logger = opts.logger;
    const stateFile = opts.stateFile || defaultStateFile();
    const store = readStore(stateFile, logger);

    // 1) 明确要接入的实例：先看有没有还能用的 cookie，避免 /connect 顶掉别人
    const wanted = opts.attachUrl?.trim();
    if (wanted) {
      const target = parseLaunchUrl(wanted);
      const base = target?.base ?? wanted.replace(/\/+$/, '');
      const authority = target?.authority ?? new URL(base).host;

      const cached = store.instances[authority];
      if (cached && (!cached.expiresAt || cached.expiresAt > Date.now() + 60_000)) {
        if (await probeCookie({ base: cached.base, cookie: cached.cookie }, 5000).catch(() => false)) {
          logger('info', `复用已有凭据连 ${authority}`);
          const session: ApiSession = {
            authority,
            base: cached.base,
            cookie: cached.cookie,
            cookieName: cached.cookieName,
            expiresAt: cached.expiresAt,
            launchToken: tokenOf(cached.launchUrl) ?? target?.token ?? '',
          };
          const conn = new DshConnection({ ...opts, stateFile }, session, logger);
          await conn.mux.start();
          return {
            connection: conn,
            result: { authority, base: cached.base, launchUrl: conn.launchUrl, origin: 'attached', reusedCredential: true },
          };
        }
        logger('debug', `缓存凭据已失效 ${authority}`);
      }

      if (!target?.token) {
        throw new Error(`无法连接 ${authority}：URL 里没有 token，且本地没有可用凭据。请从 dsh 启动输出里复制完整 URL。`);
      }
      const session = await exchangeLaunchToken(base, target.token);
      const conn = new DshConnection({ ...opts, stateFile }, session, logger);
      store.instances[authority] = {
        authority,
        base: session.base,
        launchUrl: conn.launchUrl,
        cookie: session.cookie,
        cookieName: session.cookieName,
        expiresAt: session.expiresAt,
        owner: 'external',
        savedAt: Date.now(),
      };
      writeStore(stateFile, store, logger);
      await conn.mux.start();
      return {
        connection: conn,
        result: { authority, base: session.base, launchUrl: conn.launchUrl, origin: 'attached', reusedCredential: false },
      };
    }

    // 2) 没给 URL：看本地有没有还活着的实例可复用（多窗口共享 / 重启扩展续用）
    for (const inst of Object.values(store.instances)) {
      if (inst.expiresAt && inst.expiresAt <= Date.now() + 60_000) continue;
      const alive = await probeCookie({ base: inst.base, cookie: inst.cookie }, 3000).catch(() => false);
      if (!alive) {
        logger('debug', `清理失效实例 ${inst.authority}`);
        delete store.instances[inst.authority];
        continue;
      }
      logger('info', `复用运行中的 dsh ${inst.authority}`);
      const session: ApiSession = {
        authority: inst.authority,
        base: inst.base,
        cookie: inst.cookie,
        cookieName: inst.cookieName,
        expiresAt: inst.expiresAt,
        launchToken: tokenOf(inst.launchUrl) ?? '',
      };
      store.instances[inst.authority] = { ...inst, savedAt: Date.now() };
      writeStore(stateFile, store, logger);
      const conn = new DshConnection({ ...opts, stateFile }, session, logger);
      await conn.mux.start();
      return {
        connection: conn,
        result: {
          authority: inst.authority,
          base: inst.base,
          launchUrl: conn.launchUrl,
          origin: inst.owner === 'vscode' ? 'spawned' : 'attached',
          reusedCredential: true,
        },
      };
    }
    writeStore(stateFile, store, logger);

    // 3) attach 模式但什么都没给：报错，让上层弹输入框
    if (opts.mode === 'attach') {
      throw new Error('没有可连接的 dsh 实例。请在设置里填 dsh.attachUrl，或改用 spawn 模式。');
    }

    // 4) spawn 自己的实例
    const runtime = await spawnRuntime({
      cliPath: opts.cliPath,
      extraArgs: opts.extraSpawnArgs,
      logger,
      cwd: os.homedir(),
      timeoutMs: opts.startTimeoutMs,
      env: opts.env,
    });
    const target: LaunchTarget = runtime.target;
    let session: ApiSession;
    try {
      session = await exchangeLaunchToken(target.base, target.token);
    } catch (e) {
      runtime.dispose();
      throw e;
    }
    const conn = new DshConnection({ ...opts, stateFile }, session, logger);
    conn.runtime = runtime;
    runtime.onExit((code) => {
      logger('warn', `dsh 进程退出 code=${code}`);
      if (!conn.disposed) opts.onMuxState?.('closed', `runtime 退出 (code=${code})`);
    });
    const fresh = readStore(stateFile, logger);
    fresh.instances[target.authority] = {
      authority: target.authority,
      base: target.base,
      launchUrl: conn.launchUrl,
      cookie: session.cookie,
      cookieName: session.cookieName,
      expiresAt: session.expiresAt,
      owner: 'vscode',
      savedAt: Date.now(),
    };
    writeStore(stateFile, fresh, logger);
    await conn.mux.start();
    return {
      connection: conn,
      result: { authority: target.authority, base: target.base, launchUrl: conn.launchUrl, origin: 'spawned', reusedCredential: false },
    };
  }

  // ── 凭据续期 ────────────────────────────────────────────────────────────

  private async refreshCredential(): Promise<string | undefined> {
    const token = this.session.launchToken;
    if (!token) return undefined;
    try {
      const fresh = await exchangeLaunchToken(this.session.base, token);
      this.session = { ...fresh, authority: this.session.authority };
      this.unary.setCookie(fresh.cookie);
      const store = readStore(this.stateFile, this.opts.logger);
      store.instances[this.session.authority] = {
        authority: this.session.authority,
        base: this.session.base,
        launchUrl: this.launchUrl,
        cookie: fresh.cookie,
        cookieName: fresh.cookieName,
        expiresAt: fresh.expiresAt,
        owner: this.runtime ? 'vscode' : 'external',
        savedAt: Date.now(),
      };
      writeStore(this.stateFile, store, this.opts.logger);
      return fresh.cookie;
    } catch (e) {
      this.opts.logger('error', '重新换取凭据失败', (e as Error).message);
      return undefined;
    }
  }

  // ── 流 ──────────────────────────────────────────────────────────────────

  follow(sessionId: string, handlers: StreamHandlers, opts?: { maxMessages?: number; turnWindow?: number }): StreamHandle {
    return this.mux.open(
      'session/follow',
      {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
          ...(opts?.maxMessages ? { maxMessages: opts.maxMessages } : {}),
          ...(opts?.turnWindow ? { turnWindow: opts.turnWindow } : {}),
        },
      },
      handlers,
      'f',
    );
  }

  /** 会话级投影增量流。args 是 `{}`（不带 address）。 */
  control(handlers: StreamHandlers): StreamHandle {
    return this.mux.open('session/control', {}, handlers, 'c');
  }

  /**
   * 全局事件通道 `$events`。审批卡片、提问卡片、会话 running 状态都从这里来。
   * 帧：`{type:'item', value:{type:'ready'|'emit'|'waterfall'|'cancel', …}}`。
   */
  events(handlers: StreamHandlers): StreamHandle {
    return this.mux.open('$events', {}, handlers, 'e');
  }

  workspaceFollow(handlers: StreamHandlers): StreamHandle {
    return this.mux.open('workspace/follow', {}, handlers, 'w');
  }

  // ── 清理 ────────────────────────────────────────────────────────────────

  /** 只是断开连接，不动 runtime（多窗口场景下别的窗口可能还在用） */
  disconnect(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mux.close();
  }

  /** 断开并杀掉我们起的 runtime（显式「重启 runtime」时用） */
  async dispose(opts?: { killRuntime?: boolean }): Promise<void> {
    this.disconnect();
    if (opts?.killRuntime && this.runtime) {
      this.runtime.dispose();
      this.runtime = undefined;
      const store = readStore(this.stateFile, this.opts.logger);
      delete store.instances[this.session.authority];
      writeStore(this.stateFile, store, this.opts.logger);
    }
  }

  get spawnedByUs(): boolean {
    return !!this.runtime;
  }
}

function tokenOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

export type { SessionFollowFrame, SessionEventEntry, SessionControlFrame, StreamHandle };


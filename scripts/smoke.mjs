/**
 * 端到端 smoke：真的起一个 dsh web，走完整连接链路。
 *
 * 用法：
 *   node scripts/smoke.mjs                # 自己 spawn 一个临时实例（不碰用户已有实例）
 *   node scripts/smoke.mjs --attach URL   # 连指定实例（会抢 operator，慎用）
 *   node scripts/smoke.mjs --prompt "你好"  # 额外发一条消息验证流式
 *
 * 只验证扩展自己的 dsh 客户端层（core.ts），不需要 VS Code。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const attachUrl = flag('attach', '');
const promptText = flag('prompt', '');

const tmpBase = path.join(root, '.smoke-tmp');
fs.mkdirSync(tmpBase, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'run-'));
const bundlePath = path.join(tmpDir, 'core.cjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src/chat/core.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
});

const { SessionCore } = createRequire(import.meta.url)(bundlePath);

const messages = [];
const waiters = [];
const post = (msg) => {
  messages.push(msg);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].pred(msg)) {
      waiters[i].resolve(msg);
      waiters.splice(i, 1);
    }
  }
};

function waitFor(pred, timeoutMs = 60000, label = '等待消息') {
  const hit = messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${label}（${timeoutMs}ms）`)), timeoutMs);
    waiters.push({
      pred,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
}

const logger = (level, ...rest) => {
  if (level === 'debug') return;
  console.log(`  [${level}] ${rest.join(' ')}`);
};

console.log(`smoke: ${attachUrl ? `attach ${attachUrl}` : 'spawn 自己的实例'}`);

const core = new SessionCore({
  config: {
    mode: attachUrl ? 'attach' : 'spawn',
    attachUrl,
    cliPath: '',
    extraSpawnArgs: [],
    autoStart: false,
    defaultCwd: '',
    defaultPermission: 'workspace-write',
    sendWorkspaceContext: false,
  },
  logger,
  post,
  version: 'smoke',
});

const cleanup = () => {
  try {
    core.dispose();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

const started = Date.now();
try {
  await core.connect();
  const init = await waitFor((m) => m.type === 'init', 90000, 'init');
  console.log(`✔ 连接成功 ${init.state.authority}（${Date.now() - started}ms）`);
  console.log(`  会话数: ${init.state.sessions.length}，模型默认: ${init.state.catalog?.default?.model ?? '?'}`);

  if (!init.state.connected) throw new Error('init 里 connected 是 false');

  // 新会话：验证 create + follow 流
  const cwdBase = path.join(root, '.smoke-tmp');
  const cwd = fs.mkdtempSync(path.join(cwdBase, 'cwd-'));
  await core.newSession(cwd);
  console.log(`✔ 新会话已打开: ${core.state.sessionId}`);

  if (promptText) {
    const t0 = Date.now();
    await core.sendPrompt(promptText);
    const done = await waitFor(
      (m) =>
        m.type === 'event' &&
        (m.event?.type === 'turn/end' || m.event?.kind === 'turn/end') &&
        (m.sessionId === undefined || m.sessionId === core.state.sessionId),
      180000,
      'turn/end',
    );
    const texts = messages.filter((m) => m.type === 'stream').length;
    console.log(`✔ 收到回复（${Date.now() - t0}ms），流帧 ${texts} 个，最后事件 ${done.event.type ?? done.event.kind}`);
  }

  console.log('smoke 通过');
} catch (e) {
  console.error(`smoke 失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}

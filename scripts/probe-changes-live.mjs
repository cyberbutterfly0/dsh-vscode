/**
 * 活实例内测 changes API：在本进程刚产生改动后，立刻查
 *   /api/changes.summary
 *   /api/changes.diff
 * 看真实形状（重点：有没有 snapshot 字段）。
 *
 * 用法：node scripts/probe-changes-live.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmpBase = path.join(root, '.smoke-tmp');
fs.mkdirSync(tmpBase, { recursive: true });

const bundlePath = path.join(tmpBase, 'core-live.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/chat/core.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
});

const require = createRequire(import.meta.url);
const { SessionCore } = require(bundlePath);

const messages = [];
const waiters = [];
const post = (msg) => {
  messages.push(msg);
  if (msg.type === 'event') console.log(`    · event ${msg.event?.type ?? '?'}`);
  if (msg.type === 'notice') console.log(`    ! notice ${msg.text}`);
  for (let i = waiters.length - 1; i >= 0; i -= 1) {
    if (waiters[i].pred(msg)) {
      waiters[i].resolve(msg);
      waiters.splice(i, 1);
    }
  }
};
function waitFor(pred, timeoutMs = 180000, label = '消息') {
  const hit = messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`超时：${label}`)), timeoutMs);
    waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
  });
}

const core = new SessionCore({
  config: {
    mode: 'spawn',
    attachUrl: '',
    cliPath: '',
    extraSpawnArgs: [],
    autoStart: false,
    defaultCwd: '',
    defaultPermission: 'workspace-write',
    sendWorkspaceContext: false,
  },
  logger: (lvl, ...rest) => {
    if (lvl === 'debug') return;
    console.log(`  [${lvl}] ${rest.join(' ')}`);
  },
  post,
  version: 'probe-live',
});

const cleanup = () => {
  try {
    core.dispose();
  } catch {
    /* ignore */
  }
};

try {
  console.log('连接 dsh …');
  await core.connect();
  await waitFor((m) => m.type === 'init', 120000, 'init');
  console.log(`已连 ${core.state.authority ?? ''}`);

  const cwd = fs.mkdtempSync(path.join(tmpBase, 'cwd-live-'));
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'one\ntwo\nthree\n');
  await core.newSession(cwd);
  console.log(`新会话 ${core.state.sessionId} cwd=${cwd}`);

  await core.sendPrompt('把 keep.txt 里的 two 改成 TWO，再新增一行 four。只改这两个文件，不要解释。');
  await waitFor(
    (m) => m.type === 'event' && (m.event?.type === 'turn/end' || m.event?.type === 'turn/end') && m.sessionId === core.state.sessionId,
    480000,
    'turn/end',
  );
  console.log('本轮结束');

  // 从 bridge/core 收到的 changes 消息里拿 seq（core 自己会拉 summary 并 post）
  const changesMsg = messages.filter((m) => m.type === 'changes').pop();
  if (!changesMsg) {
    console.log('⚠ core 没 post changes（可能 summary 拉取失败，看上面日志）');
  } else {
    console.log('core 收到的 changes：', JSON.stringify(changesMsg.changes).slice(0, 600));
  }

  // 再从会话日志里数出 seq（core 不暴露），直接用 summary 的最新一次
  const { base, cookie } = readCredential();
  const sessionId = core.state.sessionId;

  async function getJson(pathname, params) {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${base}${pathname}?${qs}`, { headers: { Cookie: cookie } });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json };
  }

  const seq = changesMsg?.changes?.seq;
  if (seq == null) {
    console.log('拿不到 seq，跳过 API 形状打印');
  } else {
    const s = await getJson('/api/changes.summary', { sessionId, seq });
    console.log(`\n=== summary（seq=${seq}）HTTP ${s.status} ===`);
    console.log(JSON.stringify(s.json, null, 1).slice(0, 2000));

    if (s.status === 200 && s.json?.files?.length) {
      const d = await getJson('/api/changes.diff', { sessionId, seq, index: 0 });
      console.log(`\n=== diff（index=0）HTTP ${d.status} ===`);
      console.log(JSON.stringify(d.json, null, 1).slice(0, 2500));
      if (s.json.files.length > 1) {
        const d2 = await getJson('/api/changes.diff', { sessionId, seq, index: 1 });
        console.log(`\n=== diff（index=1）HTTP ${d2.status} ===`);
        console.log(JSON.stringify(d2.json, null, 1).slice(0, 1200));
      }
    }
  }
} finally {
  cleanup();
}

function readCredential() {
  const file = path.join(os.homedir(), '.dsh', 'dsh-vscode', 'instances.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Object.values(data.instances);
  const hit = entries[entries.length - 1];
  return { base: hit.base, cookie: `${hit.cookieName}=${hit.cookie.split('=').slice(1).join('=')}` };
}

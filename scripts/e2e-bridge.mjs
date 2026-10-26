/**
 * 端到端联调桥：把真 dsh 的会话流灌进真 webview 前端。
 *
 * 为什么要这个：VS Code 里的 webview 只能在 GUI 里看，肉眼验收又慢又不可重复。
 * 这里把同一份 media/chat.js + chat.css 放进普通浏览器，用一条 WebSocket 同时接管
 *   post()（扩展 → webview 的消息）与 handle()（webview → 扩展的消息），
 * 于是「core.ts → protocol → chat.js 渲染」整条链路可以在浏览器里跑真数据。
 *
 * 用法：
 *   node scripts/e2e-bridge.mjs                # spawn 自己的 dsh
 *   node scripts/e2e-bridge.mjs --attach URL
 * 然后浏览器打开 http://127.0.0.1:8902/bridge.html
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import * as esbuild from 'esbuild';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mediaDir = path.join(root, 'media');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const attachUrl = flag('attach', '');
const port = Number(flag('port', '8902'));
const verbose = args.includes('--verbose');

// ── 1. 把 core.ts 打成可 require 的 CJS ────────────────────────────────────
const tmpBase = path.join(root, '.smoke-tmp');
fs.mkdirSync(tmpBase, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'bridge-'));
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
const { SessionCore } = require(bundlePath);

// ── 2. HTTP + WS ──────────────────────────────────────────────────────────
const clients = new Set();
let connecting = false;

const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh e2e bridge</title>
<link rel="stylesheet" href="/chat.css">
<style>
  :root {
    --vscode-font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #cccccc;
    --vscode-foreground: #cccccc;
    --vscode-sideBar-background: #252526;
    --vscode-panel-background: #1e1e1e;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editorWidget-background: #252526;
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #ffffff;
    --vscode-textLink-foreground: #3794ff;
    --vscode-textCodeBlock-background: #2d2d2d;
    --vscode-editorError-foreground: #f14c4c;
    --vscode-charts-green: #89d185;
    --vscode-charts-blue: #3794ff;
    --vscode-charts-orange: #d18616;
    --vscode-charts-red: #f14c4c;
    --vscode-focusBorder: #007fd4;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-scrollbarSlider-background: #79797966;
  }
  html, body { margin: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  #dsx-root { height: 100%; }
  #bridge-bar { position: fixed; right: 8px; bottom: 4px; font-size: 11px; color: #888; z-index: 99; }
</style></head>
<body>
<div id="dsx-root"></div>
<div id="bridge-bar">e2e bridge</div>
<script>
  var ws = new WebSocket('ws://' + location.host + '/ws');
  var queue = [];
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        if (ws.readyState === 1) ws.send(JSON.stringify(m));
        else queue.push(m);
      },
      getState: function () { return undefined; },
      setState: function () {}
    };
  };
  ws.addEventListener('open', function () {
    while (queue.length) ws.send(JSON.stringify(queue.shift()));
  });
  ws.addEventListener('message', function (ev) {
    var data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    window.dispatchEvent(new MessageEvent('message', { data: data }));
  });
</script>
<script src="/chat.js"></script>
</body></html>`;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/bridge.html' || url === '/') {
    res.writeHead(200, { 'content-type': types['.html'] });
    res.end(page);
    return;
  }
  const file = path.join(mediaDir, url.replace(/^\//, ''));
  if (!file.startsWith(mediaDir)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (e, buf) => {
    if (e) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

// ── 3. core 实例 ──────────────────────────────────────────────────────────
const log = (level, ...rest) => {
  console.log(`[${level}] ${rest.join(' ')}`);
};

let core;
const post = (msg) => {
  if (verbose) console.log(`[→web] ${msg.type}${msg.type === 'notice' ? ' ' + (msg.level ?? '') : ''}`);
  const text = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === 1) c.send(text);
  }
};

core = new SessionCore({
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
  logger: log,
  post,
  version: 'bridge',
});

wss.on('connection', async (socket) => {
  clients.add(socket);
  log('info', `浏览器连上了（${clients.size} 个）`);
  // VS Code 里这一步由 controller.ensureConnected() 做，桥里我们见到浏览器就连
  if (!core.state.connected && !connecting) {
    connecting = true;
    try {
      await core.connect();
      // 所有 dsh 实例共享同一份会话存储，connect 会自动打开「最近会话」——
      // 那可能是用户正在用的会话，绝不能在上面发消息。
      // 联调一律新建一条空会话。
      if (core.state.sessionId) {
        const cwd = fs.mkdtempSync(path.join(tmpBase, 'cwd-'));
        await core.newSession(cwd);
        log('info', `已新建联调会话 ${core.state.sessionId} cwd=${cwd}`);
      }
    } catch (e) {
      log('error', '连接 dsh 失败', e.message);
      post({ type: 'notice', level: 'error', text: e.message });
    } finally {
      connecting = false;
    }
  }
  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      if (verbose) console.log(`[←web] ${msg.type}`);
      await core.handle(msg);
    } catch (e) {
      log('error', 'handle 失败', e.message);
      post({ type: 'notice', level: 'error', text: e.message });
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    log('info', `浏览器断开（剩 ${clients.size} 个）`);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`e2e bridge: http://127.0.0.1:${port}/bridge.html`);
  console.log(attachUrl ? `模式：attach ${attachUrl}` : '模式：spawn 自己的 dsh 实例');
});

const shutdown = async () => {
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
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


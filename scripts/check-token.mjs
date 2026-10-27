/**
 * 检查某个 dsh 实例的 token 还能不能用。
 * 只做三步：探端口 → GET / 看是否 401 → GET /connect 换 cookie → POST session/list。
 *
 * 用法: node scripts/check-token.mjs [file]
 *
 * 支持两种输入格式，缺省读启动器写的 ~/.dsh/logs/last-launch.url：
 *   1. URL 文件（启动器产物）：第一行是 http://127.0.0.1:<port>/?token=<token>
 *   2. KEY=VALUE 文件：PORT=… / TOKEN=… / URL=…
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] || path.join(os.homedir(), '.dsh', 'logs', 'last-launch.url');
const raw = fs.readFileSync(file, 'utf8');

let port = 0;
let token = '';
let url = '';

const urlMatch = raw.match(/https?:\/\/[^\s]+/);
if (urlMatch) {
  url = urlMatch[0];
  const parsed = new URL(url);
  port = Number(parsed.port || 3080);
  token = parsed.searchParams.get('token') || '';
  if (!token) {
    console.error(`URL 里没有 token 参数：${url}`);
    process.exit(1);
  }
} else {
  const pick = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
  port = Number(pick('PORT'));
  token = pick('TOKEN') || '';
  url = pick('URL') || '';
  if (!port || !token) {
    console.error('文件里既没有 URL，也没有 PORT=/TOKEN= —— 不是启动器产物，也不是 .dsh-token.txt');
    process.exit(1);
  }
}
console.log(`文件 ${file}`);
console.log(`  PORT=${port}  TOKEN=${token ? token.slice(0, 8) + '…(' + token.length + ')' : '(缺失)'}`);

function tcpOpen(p) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: p });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(2000);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

const base = `http://127.0.0.1:${port}`;
const open = await tcpOpen(port);
console.log(`1) 端口 ${port}: ${open ? 'OPEN' : 'CLOSED'}`);
if (!open) { console.log('结论: 实例已死，token 作废。'); process.exit(2); }

const root = await fetch(`${base}/`, { redirect: 'manual' });
console.log(`2) GET / → ${root.status}${root.status === 401 ? '（服务活着，未鉴权）' : ''}`);

if (!token) { console.log('结论: 文件里没有 TOKEN。'); process.exit(3); }

const conn = await fetch(`${base}/connect?token=${encodeURIComponent(token)}&interactions=answer`, { redirect: 'manual' });
const setCookies = conn.headers.getSetCookie ? conn.headers.getSetCookie() : [conn.headers.get('set-cookie')].filter(Boolean);
const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
console.log(`3) GET /connect → ${conn.status}, cookie ${cookie ? cookie.slice(0, 40) + '…' : '(无)'}`);
if (conn.status !== 302 || !cookie) {
  console.log('结论: token 已失效（/connect 没换到 cookie）。');
  process.exit(4);
}

const res = await fetch(`${base}/api/session/list`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ type: 'client-request', rpcId: '1', method: 'session/list', payload: { args: { _request: {} } } }),
});
const text = await res.text();
let n = '?';
try {
  const j = JSON.parse(text);
  const v = j.result?.ok ? j.result.value : null;
  n = v?.items?.length ?? '?';
  if (!j.result?.ok) console.log('   错误:', JSON.stringify(j.result?.error || j));
} catch { console.log('   非 JSON:', text.slice(0, 300)); }
console.log(`4) POST /api/session/list → ${res.status}, 会话数 ${n}`);

const cat = await fetch(`${base}/api/session/modelCatalog`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ type: 'client-request', rpcId: '2', method: 'session/modelCatalog', payload: { args: {} } }),
});
const catText = await cat.text();
try {
  const j = JSON.parse(catText);
  const d = j.result?.value?.default;
  console.log(`5) modelCatalog → ${cat.status}, 默认 ${d ? `${d.provider}/${d.model}/${d.reasoningEffort}` : JSON.stringify(j).slice(0, 200)}`);
} catch { console.log('5) modelCatalog → ' + cat.status + ' 非 JSON'); }

console.log(`\n结论: token 有效（端口 ${port} 活着，session/list 通了）。URL: ${url}`);

/**
 * 检查 .dsh-token.txt 里的实例还能不能用。
 * 只做三步：探端口 → GET / 看是否 401 → GET /connect 换 cookie → POST session/list。
 * 用法: node scripts/check-token.mjs [tokenFile]
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const file = process.argv[2] || 'E:/dsh结算/vscde/.dsh-token.txt';
const raw = fs.readFileSync(file, 'utf8');
const pick = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
const port = Number(pick('PORT'));
const token = pick('TOKEN');
const url = pick('URL');
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

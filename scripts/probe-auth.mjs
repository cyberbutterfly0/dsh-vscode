// Step-1 probe: /connect -> v2 cookie -> session/list
// usage: node scripts/probe-auth.mjs <authority> <token>
const authority = process.argv[2] || '127.0.0.1:51713';
const token = process.argv[3];
if (!token) { console.error('need token'); process.exit(2); }
const base = `http://${authority}`;

const log = (...a) => console.log(...a);

// 1. unauthenticated index
{
  const r = await fetch(base + '/', { redirect: 'manual' });
  log(`[index-nocookie] ${r.status}`);
}

// 2. /connect
const r = await fetch(`${base}/connect?token=${encodeURIComponent(token)}&interactions=answer`, { redirect: 'manual' });
log(`[connect] ${r.status} location=${r.headers.get('location')}`);
const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
log('[connect] set-cookie:', sc);
if (!sc.length) process.exit(3);
const cookie = sc.map((c) => c.split(';')[0]).join('; ');

// 3. decode v2 payload
{
  const v = sc[0].split(';')[0];
  const val = v.slice(v.indexOf('=') + 1);
  const parts = val.split('.');
  log('[cookie] version tag =', parts[0]);
  try { log('[cookie] payload =', Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { log('[cookie] payload decode failed', e.message); }
  log('[cookie] name =', v.slice(0, v.indexOf('=')).length, 'chars');
}

// 4. index with v2 cookie -> expect 401
{
  const r2 = await fetch(base + '/', { headers: { Cookie: cookie }, redirect: 'manual' });
  log(`[index-v2cookie] ${r2.status}  (expect 401)`);
}

// 5. session/list
{
  const r3 = await fetch(`${base}/api/session/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p1', method: 'session/list', payload: { args: { _request: {} } } }),
  });
  const text = await r3.text();
  log(`[session/list] ${r3.status} ${text.slice(0, 800)}`);
}

// 6. wrong method name check
{
  const r4 = await fetch(`${base}/api/session/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p2', method: 'session/other', payload: { args: { _request: {} } } }),
  });
  log(`[bad-method] ${r4.status} ${(await r4.text()).slice(0, 300)}`);
}

// 7. modelCatalog
{
  const r5 = await fetch(`${base}/api/session/modelCatalog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p3', method: 'session/modelCatalog', payload: { args: {} } }),
  });
  log(`[modelCatalog] ${r5.status} ${(await r5.text()).slice(0, 1200)}`);
}

console.log('COOKIE_JSON=' + JSON.stringify(cookie));

/**
 * 实测 /api/changes.summary 与 /api/changes.diff 的返回形状，重点看：
 *   1. summary 里有没有 snapshot（有的话原生 diff 不用反推 before/after）
 *   2. 旧 seq 的 diff 还能不能取到（决定历史轮次要不要降级成片段视图）
 *
 * 用法：node scripts/probe-changes.mjs
 * 会自己 spawn 一个 dsh web 实例，不碰任何已有实例。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 找一个有 workspace/changes 的会话，从日志里取 seq ─────────────────
function decodeSession(rawPath) {
  const buf = fs.readFileSync(rawPath);
  const marks = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) marks.push(i);
  }
  let text = '';
  for (let k = 0; k < marks.length; k += 1) {
    const seg = buf.subarray(marks[k], k + 1 < marks.length ? marks[k + 1] : buf.length);
    try {
      text += zlib.zstdDecompressSync(seg).toString('utf8');
    } catch {
      /* 帧尾对齐问题，跳过 */
    }
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findChangeSession() {
  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  const candidates = [];
  for (const ws of fs.readdirSync(sessionsRoot)) {
    const wsDir = path.join(sessionsRoot, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) candidates.push({ workspace: ws, sessionId: s, file: f, mtime: fs.statSync(f).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, 20)) {
    const events = decodeSession(c.file);
    const changes = events.filter((e) => e.type === 'workspace/changes');
    if (changes.length > 0) {
      return { ...c, changes: changes.map((e) => ({ seq: e.seq, data: e.data })) };
    }
  }
  return null;
}

const found = findChangeSession();
if (!found) {
  console.error('没找到带 workspace/changes 的会话，先随便让 dsh 改个文件');
  process.exit(1);
}
console.log(`会话 ${found.sessionId}（workspace=${found.workspace}）`);
console.log(`workspace/changes 事件 ${found.changes.length} 个：${found.changes.map((c) => `seq=${c.seq} data=${JSON.stringify(c.data)}`).join(' | ')}`);

// ── 2. spawn 一个实例拿 cookie ───────────────────────────────────────────
console.log('\nspawn dsh web …');
const child = spawn('dsh', ['web', '--port', '0', '--no-open'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('spawn 超时')), 90000);
  const onData = (chunk) => {
    out += String(chunk);
    for (const line of out.split('\n')) {
      if (line.includes('dsh web:')) {
        const m = line.match(/dsh web:\s*(https?:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => reject(new Error(`spawn 退出 ${code}`)));
});

try {
  const u = new URL(url);
  const base = u.origin;
  const token = u.searchParams.get('token');
  console.log(`实例 ${base}`);

  const connectRes = await fetch(`${base}/connect?token=${encodeURIComponent(token)}&interactions=answer`, { redirect: 'manual' });
  const rawCookie = (connectRes.headers.get('set-cookie') ?? '').split(';')[0];
  console.log(`cookie: ${rawCookie.slice(0, 40)}…`);
  const auth = { Cookie: rawCookie };

  async function getJson(pathname, params) {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`${base}${pathname}?${qs}`, { headers: auth });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json };
  }

  for (const c of found.changes) {
    console.log(`\n=== seq=${c.seq} 的 summary ===`);
    const s = await getJson('/api/changes.summary', { sessionId: found.sessionId, seq: c.seq });
    console.log(`HTTP ${s.status}`);
    console.log(JSON.stringify(s.json).slice(0, 1200));

    if (s.status === 200 && s.json?.files?.length) {
      const first = s.json.files[0];
      console.log(`\n--- seq=${c.seq} index=0 的 diff（${first.display}）---`);
      const d = await getJson('/api/changes.diff', { sessionId: found.sessionId, seq: c.seq, index: 0 });
      console.log(`HTTP ${d.status}`);
      console.log(JSON.stringify(d.json).slice(0, 1500));
    }
  }

  // 对比：不存在的 seq 会怎样
  console.log('\n=== 不存在的 seq=999999 的 summary ===');
  const bad = await getJson('/api/changes.summary', { sessionId: found.sessionId, seq: 999999 });
  console.log(`HTTP ${bad.status} ${JSON.stringify(bad.json).slice(0, 300)}`);
} finally {
  child.kill();
}

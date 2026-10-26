/**
 * 打包构建：优先用 esbuild 的原生二进制。
 *
 * 为什么不用 esbuild 的 JS API：它要靠管道和 service 子进程通信，
 * 而受限沙箱里 `child_process.spawn(..., {stdio:'pipe'})` 会 EPERM。
 * 原生的 esbuild.exe 交给 `spawnSync(..., {stdio:'inherit'})` 就没问题。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function nativeBinary() {
  const pkgName = `@esbuild/${process.platform}-${process.arch}`;
  const base = path.join(root, 'node_modules', pkgName);
  const candidates = ['esbuild.exe', 'esbuild', path.join('bin', 'esbuild')];
  for (const rel of candidates) {
    const abs = path.join(base, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return '';
}

const exe = nativeBinary();
if (!exe) {
  console.error('找不到 esbuild 原生二进制，先跑 npm install');
  process.exit(1);
}

const args = [
  'src/extension.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  '--external:vscode',
  '--external:bufferutil',
  '--external:utf-8-validate',
  '--outfile=dist/extension.js',
  '--log-level=warning',
];
if (production) args.push('--minify');
if (watch) args.push('--watch');

const result = spawnSync(exe, args, { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`esbuild 启动失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

/**
 * 本地安装：build → 打 vsix → 清掉旧版本目录 → 装进去。
 *
 * 为什么需要清旧版本：`code --install-extension` 升级时**不会删旧版本的目录**，
 * VS Code 有可能仍然从 `~/.vscode/extensions/local.dsh-vscode-0.1.0` 加载旧代码，
 * 于是改了半天样式/逻辑都不生效，DevTools 里看到的还是旧路径。
 * 这个脚本会把同名扩展的所有旧版本目录挪到 .smoke-tmp/ext-backup-<version>/（可恢复），只留当前版本。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function findCodeCli() {
  if (process.env.DSH_CODE_CLI) return process.env.DSH_CODE_CLI;
  const candidates = [
    'E:\\vs code\\Microsoft VS Code\\bin\\code.cmd',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  // 最后试 PATH
  try {
    const out = execFileSync('where', ['code'], { encoding: 'utf8', shell: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch {
    /* ignore */
  }
  throw new Error('找不到 code CLI，设 DSH_CODE_CLI 环境变量指到 bin/code.cmd');
}

const CODE_CLI = findCodeCli();

function run(cmd, args, opts = {}) {
  // Windows 下 .cmd 要走 shell；路径含空格时必须自己加引号，否则 cmd 会按空格断开
  const quoted = /[\\/]/.test(cmd) && /\s/.test(cmd) ? `"${cmd}"` : cmd;
  return execFileSync(quoted, args, { stdio: 'inherit', shell: true, ...opts });
}

console.log(`[1/4] build`);
run('npm', ['run', 'build'], { cwd: root });

console.log(`[2/4] package`);
run('node', ['scripts/make-vsix.mjs'], { cwd: root });

const vsix = path.join(root, 'dist', `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) throw new Error(`没打出来：${vsix}`);

const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
const backupRoot = path.join(root, '.smoke-tmp');
const prefix = `${pkg.publisher}.${pkg.name}-`;

console.log(`[3/4] 清理旧版本目录（${extRoot}）`);
if (fs.existsSync(extRoot)) {
  for (const name of fs.readdirSync(extRoot)) {
    if (!name.startsWith(prefix)) continue;
    if (name === `${prefix}${pkg.version}`) continue;
    const from = path.join(extRoot, name);
    const to = path.join(backupRoot, `ext-backup-${name.slice(prefix.length)}`);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    console.log(`  ${name} → ${to}`);
  }
}

console.log(`[4/4] install`);
run(CODE_CLI, ['--install-extension', vsix, '--force']);

console.log('');
console.log('装好了。**在 VS Code 里执行一次 Developer: Reload Window**，否则跑的还是旧代码。');
console.log(`版本：${pkg.version}，包：${vsix}`);

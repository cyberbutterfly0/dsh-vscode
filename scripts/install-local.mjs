/**
 * 本地安装：build → 打 vsix → 清掉旧版本目录 → 装进去（含所有 profile）。
 *
 * 为什么需要清旧版本：`code --install-extension` 升级时**不会删旧版本的目录**，
 * VS Code 有可能仍然从 `~/.vscode/extensions/local.dsh-vscode-0.1.0` 加载旧代码，
 * 于是改了半天样式/逻辑都不生效，DevTools 里看到的还是旧路径。
 * 这个脚本会把同名扩展的所有旧版本目录挪到 .smoke-tmp/ext-backup-<version>/（可恢复），只留当前版本。
 *
 * 用法：
 *   npm run install:local                    # 默认 profile + 所有已知 profile
 *   node scripts/install-local.mjs --only-default
 *   node scripts/install-local.mjs --profile stm32 --profile ti
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const onlyDefault = argv.includes('--only-default');
const explicitProfiles = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--profile' && argv[i + 1]) explicitProfiles.push(argv[i + 1]);
}

function findCodeCli() {
  if (process.env.DSH_CODE_CLI) return process.env.DSH_CODE_CLI;
  const candidates = [
    'E:\\vs code\\Microsoft VS Code\\bin\\code.cmd',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    '/usr/local/bin/code',
    '/usr/bin/code',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'code';
}

const CODE_CLI = findCodeCli();

/** 用 spawnSync + inherit：沙箱里 spawn 配 pipe 会 EPERM，inherit 不会 */
function run(cmd, args, opts = {}) {
  const quoted = /[\\/]/.test(cmd) && /\s/.test(cmd) ? `"${cmd}"` : cmd;
  const r = spawnSync(quoted, args, { stdio: 'inherit', shell: true, cwd: root, ...opts });
  if (r.error) throw new Error(`${cmd} 启动失败：${r.error.message}`);
  if ((r.status ?? 1) !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

/** 从 VS Code 的 storage.json 里读出用户建过的 profile 名字 */
function knownProfiles() {
  const names = new Set();
  for (const base of [
    path.join(process.env.APPDATA || '', 'Code', 'User'),
    path.join(os.homedir(), '.config', 'Code', 'User'),
  ]) {
    const file = path.join(base, 'globalStorage', 'storage.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const p of raw.userDataProfiles ?? []) if (p?.name) names.add(p.name);
    } catch {
      /* 没有就算了 */
    }
  }
  return [...names];
}

console.log('[1/4] build');
run('node', ['scripts/build.mjs', '--production']);

console.log('[2/4] package');
run('node', ['scripts/make-vsix.mjs']);

const vsix = path.join(root, 'dist', `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) throw new Error(`没打出来：${vsix}`);

const extRoot = path.join(process.env.USERPROFILE || os.homedir(), '.vscode', 'extensions');
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

const profiles = onlyDefault ? [] : explicitProfiles.length ? explicitProfiles : knownProfiles();
console.log(`[4/4] install（默认 profile${profiles.length ? ` + ${profiles.join(', ')}` : ''}）`);
run(CODE_CLI, ['--install-extension', vsix, '--force']);
for (const name of profiles) {
  try {
    run(CODE_CLI, ['--profile', name, '--install-extension', vsix, '--force']);
  } catch (e) {
    console.warn(`  装到 profile「${name}」失败（跳过）：${e.message}`);
  }
}

console.log('');
console.log('装好了。**在 VS Code 里执行一次 Developer: Reload Window**，否则跑的还是旧代码。');
console.log(`版本：${pkg.version}，包：${vsix}`);

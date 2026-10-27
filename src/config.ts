/** 读取扩展设置。所有默认值集中在这里，其它模块不要再写死。 */

import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { ConnectMode } from './dsh/client';

export interface DshConfig {
  mode: ConnectMode;
  cliPath: string;
  attachUrl: string;
  /**
   * 启动器写的 token URL 文件（第一行是 http://127.0.0.1:PORT/?token=...）。
   * attach 模式下扩展只读它，不自己起 dsh，也不杀任何进程。
   */
  launchFile: string;
  autoStart: boolean;
  defaultCwd: string;
  defaultPermission: string;
  extraSpawnArgs: string[];
  logLevel: 'off' | 'error' | 'warn' | 'info' | 'debug';
  sendWorkspaceContext: boolean;
  openViewOnStart: boolean;
  /** 完整 UI（iframe）缩放，0.5–1.5 */
  fullUiZoom: number;
  /** spawn 后等 dsh 打印 URL 的超时（毫秒） */
  startTimeoutMs: number;
  /** 扩展退出时是否杀掉自己 spawn 的 dsh 进程 */
  stopOnExit: boolean;
  /** 窗口失焦后是否自动让位：停掉内置 runtime，把会话写锁让给别的 dsh 客户端 */
  yieldOnBlur: boolean;
  /** 失焦多久之后让位（毫秒） */
  yieldDelayMs: number;
  /** 重新拿到焦点时是否自动把 runtime 起回来 */
  yieldResumeOnFocus: boolean;
  /** 追加给 dsh 进程的环境变量 */
  env: Record<string, string>;
}

const DEFAULT_START_TIMEOUT_MS = 45_000;
const MIN_START_TIMEOUT_MS = 5_000;
const MAX_START_TIMEOUT_MS = 300_000;

const DEFAULT_YIELD_DELAY_MS = 20_000;
const MIN_YIELD_DELAY_MS = 5_000;
const MAX_YIELD_DELAY_MS = 600_000;

/**
 * 启动器（`dsh-launch.ps1`）写的 token URL 文件。
 * 没有这个文件 = 用户还没点启动器，或者 dsh 进程已经退了。
 */
export function defaultLaunchFile(): string {
  return path.join(os.homedir(), '.dsh', 'logs', 'last-launch.url');
}

/**
 * 只读「工作区级」的 dsh.attachUrl。
 *
 * 这是「一个项目连一个 dsh 实例」的关键：双实例模式下两个项目各自在
 * 自己的 `.vscode/settings.json` 里写不同的 `dsh.attachUrl`，全局设置留空，
 * 互不干扰。
 *
 * 这里用 `inspect()` 只取 workspace 级的值，故意不读 global，
 * 免得和 readConfig() 互相递归。
 */
export function readWorkspaceAttachUrl(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return '';
  const info = vscode.workspace.getConfiguration('dsh', folder.uri);
  const inspected = info.inspect<string>('attachUrl');
  return (inspected?.workspaceValue || inspected?.workspaceFolderValue || '').trim();
}

/**
 * 解析「这次该连哪个 dsh」。
 *
 * 优先级：工作区设置 > 全局设置 > 空（空则交给 launchFile 去读启动器写的 URL）。
 */
export function resolveAttachUrl(): string {
  const fromWorkspace = readWorkspaceAttachUrl();
  if (fromWorkspace) return fromWorkspace;
  return (vscode.workspace.getConfiguration('dsh').get<string>('attachUrl') || '').trim();
}

export function readConfig(): DshConfig {
  const c = vscode.workspace.getConfiguration('dsh');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return {
    // 0.3.0 起默认 attach：只连用户自己启动器拉起来的那个 dsh。
    // spawn 模式下扩展起的每个进程都会重新持有一份会话写锁，
    // 用户切回浏览器就报 session/writer-held——这正是 0.2.x 的毛病。
    mode: (c.get<string>('mode') as ConnectMode) || 'attach',
    cliPath: (c.get<string>('cliPath') || '').trim(),
    attachUrl: (c.get<string>('attachUrl') || '').trim(),
    launchFile: (c.get<string>('launchFile') || '').trim() || defaultLaunchFile(),
    autoStart: c.get<boolean>('autoStart') ?? true,
    defaultCwd: (c.get<string>('defaultCwd') || '').trim() || folder,
    defaultPermission: (c.get<string>('defaultPermission') || '').trim(),
    extraSpawnArgs: c.get<string[]>('extraSpawnArgs') || [],
    logLevel: (c.get<string>('logLevel') as DshConfig['logLevel']) || 'info',
    sendWorkspaceContext: c.get<boolean>('sendWorkspaceContext') ?? true,
    openViewOnStart: c.get<boolean>('openViewOnStart') ?? false,
    fullUiZoom: clampNumber(c.get<number>('fullUiZoom'), 0.5, 1.5, 1),
    startTimeoutMs: clampNumber(
      c.get<number>('startTimeoutMs'),
      MIN_START_TIMEOUT_MS,
      MAX_START_TIMEOUT_MS,
      DEFAULT_START_TIMEOUT_MS,
    ),
    stopOnExit: c.get<boolean>('stopOnExit') ?? false,
    // 让位默认关：attach 模式下没有自己的 runtime 可让；
    // 而 spawn 模式下自动杀进程会让用户「聊到一半窗口消失」。0.3.0 把它降为手动兜底。
    yieldOnBlur: c.get<boolean>('yieldOnBlur') ?? false,
    yieldDelayMs: clampNumber(c.get<number>('yieldDelayMs'), MIN_YIELD_DELAY_MS, MAX_YIELD_DELAY_MS, DEFAULT_YIELD_DELAY_MS),
    yieldResumeOnFocus: c.get<boolean>('yieldResumeOnFocus') ?? true,
    env: sanitizeEnv(c.get<Record<string, unknown>>('env')),
  };
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 环境变量只收字符串值，空 key 丢掉——免得把 undefined 传进 spawn */
function sanitizeEnv(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof value === 'string') out[name] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[name] = String(value);
  }
  return out;
}

export function workspaceCwd(fallback?: string): string {
  return (
    fallback ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
    readConfig().defaultCwd ||
    ''
  );
}

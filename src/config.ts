/** 读取扩展设置。所有默认值集中在这里，其它模块不要再写死。 */

import * as vscode from 'vscode';

import type { ConnectMode } from './dsh/client';

export interface DshConfig {
  mode: ConnectMode;
  cliPath: string;
  attachUrl: string;
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
  /** 追加给 dsh 进程的环境变量 */
  env: Record<string, string>;
}

const DEFAULT_START_TIMEOUT_MS = 45_000;
const MIN_START_TIMEOUT_MS = 5_000;
const MAX_START_TIMEOUT_MS = 300_000;

export function readConfig(): DshConfig {
  const c = vscode.workspace.getConfiguration('dsh');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return {
    mode: (c.get<string>('mode') as ConnectMode) || 'auto',
    cliPath: (c.get<string>('cliPath') || '').trim(),
    attachUrl: (c.get<string>('attachUrl') || '').trim(),
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

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
}

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
  };
}

export function workspaceCwd(fallback?: string): string {
  return (
    fallback ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
    readConfig().defaultCwd ||
    ''
  );
}

/**
 * 侧栏会话列表：只做「看 + 点」，聊天本身在编辑器 tab 里。
 *
 * 刻意不复刻文件树 / Git / 编辑器——那些 VS Code 原生更强。
 */

import * as vscode from 'vscode';

import type { UiSessionRow } from '../protocol';
import type { ChatController } from '../chat/controller';
import { t } from '../i18n';

type Node = ActionNode | SessionNode | InfoNode;

interface ActionNode {
  kind: 'action';
  label: string;
  description?: string;
  icon: string;
  command: string;
  args?: unknown[];
}

interface SessionNode {
  kind: 'session';
  row: UiSessionRow;
  current: boolean;
}

interface InfoNode {
  kind: 'info';
  label: string;
  description?: string;
  icon?: string;
}

function relTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export class SessionsView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: ChatController) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'action') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.command = { command: node.command, title: node.label, arguments: node.args };
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.description) item.description = node.description;
      return item;
    }
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.description) item.description = node.description;
      return item;
    }
    const item = new vscode.TreeItem(node.row.title || '（空会话）', vscode.TreeItemCollapsibleState.None);
    item.id = node.row.sessionId;
    item.description = [node.current ? '当前' : '', node.row.running ? '运行中' : '', relTime(node.row.updatedAt)]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${node.row.title || '（空会话）'}**`,
        '',
        `- id: \`${node.row.sessionId.slice(0, 8)}…\``,
        node.row.cwd ? `- 目录: \`${node.row.cwd}\`` : '',
        node.row.parentSessionId ? `- 父会话: \`${node.row.parentSessionId.slice(0, 8)}…\`` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(node.row.running ? 'loading~spin' : node.current ? 'comment-discussion' : 'comment');
    item.command = {
      command: 'dsh.openChat',
      title: '打开会话',
      arguments: [{ sessionId: node.row.sessionId }],
    };
    item.contextValue = node.row.blank ? 'dsh.session.blank' : 'dsh.session';
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node) return [];

    const state = this.controller.coreRef.state;
    const out: Node[] = [];

    if (!state.connected) {
      out.push({
        kind: 'action',
        label: '连接 dsh',
        description: '还没连上',
        icon: 'plug',
        command: 'dsh.connectExisting',
      });
    } else {
      out.push({
        kind: 'action',
        label: '新建会话',
        description: state.authority,
        icon: 'add',
        command: 'dsh.newSession',
      });
    }

    const rows = state.sessions ?? [];
    if (!rows.length) {
      out.push({
        kind: 'info',
        label: state.connected ? '还没有会话' : '等待连接…',
        icon: 'info',
      });
      return out;
    }

    const current = state.sessionId;
    const sorted = [...rows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const row of sorted) {
      out.push({ kind: 'session', row, current: row.sessionId === current });
    }
    return out;
  }

  getParent(): Node | undefined {
    return undefined;
  }
}

export const SESSION_VIEW_COMMANDS: { id: string; label: string }[] = [
  { id: 'dsh.refreshSessions', label: t('cmd.refreshSessions') },
];

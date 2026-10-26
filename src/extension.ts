/**
 * 扩展入口：命令注册、侧栏、状态栏、日志通道。
 *
 * 业务全在 chat/core.ts（无 vscode 依赖），这里只做胶水。
 */

import * as vscode from 'vscode';

import { readConfig, type DshConfig } from './config';
import { ChatController } from './chat/controller';
import { collectEditorContext } from './chat/editor-context';
import { ChatPanel, type PanelState } from './chat/panel';
import { ChatView, traceChatView } from './chat/view';
import { applyFullUiZoom, closeFullUi, openFullUi } from './chat/full-ui';
import { defaultStateFile } from './dsh/client';
import { t } from './i18n';
import { createLogger, type Logger } from './log';
import { SessionsView } from './views/sessions';

let controller: ChatController | undefined;
let sessionsView: SessionsView | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;

function makeLogger(channel: vscode.OutputChannel, level: DshConfig['logLevel']): Logger {
  return createLogger(level, (line) => channel.appendLine(line));
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('dsh');
  const config = readConfig();
  const logger = makeLogger(output, config.logLevel);
  logger('info', `dsh 扩展激活（v${context.extension.packageJSON.version}）`);
  traceActivation(context);

  controller = new ChatController(context, logger, config);

  // ── 侧栏 ────────────────────────────────────────────────────────────────
  sessionsView = new SessionsView(controller);
  controller.refreshTree = () => sessionsView?.refresh();
  const tree = vscode.window.createTreeView('dsh.sessions', {
    treeDataProvider: sessionsView,
    showCollapseAll: false,
  });
  context.subscriptions.push(tree);

  // ── 聊天视图（可拖到辅助侧边栏） ─────────────────────────────────────────
  const chatView = new ChatView(context, controller);
  controller.attachView(chatView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── 状态栏 ──────────────────────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'dsh.openChat';
  statusBar.text = '$(comment-discussion) dsh';
  statusBar.tooltip = '点击打开 dsh 聊天';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── 命令 ────────────────────────────────────────────────────────────────
  const reg = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          const err = e as Error;
          logger('error', `命令 ${id} 失败`, err.message);
          void vscode.window.showErrorMessage(t('ext.connectFailed', { message: err.message }));
        }
      }),
    );

  reg('dsh.openChat', async (arg?: unknown) => {
    await openChat(arg);
  });
  // 打开侧栏里的聊天视图（用户还可以把它拖到辅助侧边栏/面板）
  reg('dsh.openChatView', async () => {
    traceChatView('cmd-start');
    try {
      await vscode.commands.executeCommand('workbench.view.extension.dshContainer');
      traceChatView('container-open');
      await vscode.commands.executeCommand('dsh.chatView.focus');
      traceChatView('focus-ok');
    } catch (err) {
      traceChatView('cmd-fail: ' + (err as Error).message);
    }
  });
  reg('dsh.newSession', async () => {
    await openChat();
    await controller?.newSession(workspaceCwdOrUndefined());
  });
  reg('dsh.connectExisting', async () => {
    const url = await vscode.window.showInputBox({
      title: t('ext.needToken'),
      prompt: t('ext.tokenPrompt'),
      placeHolder: 'http://127.0.0.1:51713/?token=…',
      ignoreFocusOut: true,
      validateInput: (v) => (v.includes('token=') ? undefined : t('ext.tokenEmpty')),
    });
    if (!url) return;
    await openChat();
    await controller?.connect(url.trim());
  });
  reg('dsh.restartRuntime', async () => {
    await openChat();
    await controller?.restartRuntime();
  });
  reg('dsh.disconnect', async () => {
    await controller?.disconnect();
  });
  reg('dsh.openFullUI', async () => {
    await openChat();
    const url = controller?.fullUiUrl;
    if (!url) {
      void vscode.window.showWarningMessage('还没连上 dsh，先连接再切完整界面');
      return;
    }
    openFullUi({
      url,
      sessionId: controller?.currentSessionId || undefined,
      zoom: config?.fullUiZoom,
    });
  });
  reg('dsh.zoomFullUi', async () => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '75%', value: 0.75 },
        { label: '90%', value: 0.9 },
        { label: '100%（默认）', value: 1 },
        { label: '110%', value: 1.1 },
        { label: '125%', value: 1.25 },
        { label: '150%', value: 1.5 },
      ],
      { title: '完整 dsh UI 缩放', placeHolder: '窗口窄的时候调小一点' },
    );
    if (!picked) return;
    await vscode.workspace
      .getConfiguration('dsh')
      .update('fullUiZoom', picked.value, vscode.ConfigurationTarget.Global);
    applyFullUiZoom(picked.value);
  });
  reg('dsh.selectModel', async () => {
    await openChat();
    await controller?.selectModelFromCatalog();
  });
  reg('dsh.selectPermission', async () => {
    await openChat();
    await controller?.selectPermissionFromCatalog();
  });
  reg('dsh.pickWorkspace', async () => {
    const dir = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: '把 dsh 会话建在这个目录',
    });
    if (!dir?.[0]) return;
    await openChat();
    await controller?.newSession(dir[0].fsPath);
  });
  reg('dsh.showLog', async () => {
    output?.show(true);
  });
  reg('dsh.revealState', async () => {
    const file = defaultStateFile();
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc);
    } catch {
      void vscode.window.showInformationMessage(`凭据文件还没生成：${file}`);
    }
  });

  // 会话重命名：侧栏会话项右键触发，参数是 getTreeItem 生成的那个节点
  reg('dsh.renameSession', async (item?: unknown) => {
    const row = (item as { row?: { sessionId?: string; title?: string } } | undefined)?.row;
    const sessionId = row?.sessionId;
    if (!sessionId || !controller) return;
    const next = await vscode.window.showInputBox({
      title: '重命名会话',
      prompt: '给这条会话起个名字',
      value: row?.title ?? '',
      validateInput: (v) => (v.trim() ? undefined : '名字不能为空'),
    });
    const title = next?.trim();
    if (!title) return;
    try {
      await controller.handleWebMessage({ type: 'rename-session', sessionId, title });
    } catch (e) {
      void vscode.window.showErrorMessage(`重命名失败：${(e as Error).message}`);
    }
  });
  reg('dsh.refreshSessions', async () => {
    await controller?.coreRef.refreshSessions();
    sessionsView?.refresh();
  });

  // ── 编辑器侧入口 ────────────────────────────────────────────────────────
  // 右键菜单把「选中的代码」「当前文件」直接丢给 dsh，不用先切到聊天面板再复制粘贴。
  reg('dsh.explainSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('先选中一段代码');
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const from = editor.selection.start.line + 1;
    const to = editor.selection.end.line + 1;
    const code = editor.document.getText(editor.selection);
    const question = await vscode.window.showInputBox({
      title: '问 dsh',
      prompt: `解释/修改 ${rel}:${from}-${to}，可以直接说想干什么`,
      placeHolder: '例如：这段为什么慢？ / 改成 async / 有没有越界风险？',
      value: '解释这段代码',
    });
    if (question === undefined) return;
    const body = `文件 ${rel} 第 ${from}-${to} 行：\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\``;
    await controller?.askWithText(body, { prompt: question });
  });
  reg('dsh.askAboutFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('先打开一个文件');
      return;
    }
    const context = collectEditorContext();
    if (!context) {
      void vscode.window.showInformationMessage('没取到编辑器上下文（没有活动文件？）');
      return;
    }
    const question = await vscode.window.showInputBox({
      title: '就这个文件问 dsh',
      prompt: '想问它这个文件的什么？',
      placeHolder: '例如：帮我 review / 报错是什么原因 / 怎么加个测试',
      value: '帮我看一下这个文件',
    });
    if (question === undefined) return;
    await controller?.askWithText(context, { prompt: question });
  });

  // ── webview 恢复 ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('dsh.chat', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        if (!controller) {
          panel.dispose();
          return;
        }
        controller.revive(panel, (state ?? {}) as PanelState);
      },
    }),
  );

  // ── 配置变化 ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('dsh')) return;
      const next = readConfig();
      await controller?.reloadConfig(next);
      // 缩放改了要立刻反映到已经开着的完整 UI 面板
      applyFullUiZoom(next.fullUiZoom);
      logger('info', '配置已重新读取');
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      closeFullUi();
      controller?.dispose({ killRuntime: readConfig().stopOnExit });
      controller = undefined;
      output?.dispose();
      output = undefined;
    },
  });

  // 启动即打开侧栏聊天视图（可关，默认关；开着方便用户直接看到界面）
  if (config.openViewOnStart) {
    setTimeout(() => {
      void vscode.commands
        .executeCommand('dsh.openChatView')
        .then(undefined, (err: Error) => logger('warn', '打开侧栏视图失败', err.message));
    }, 1500);
  }

  // 自动连接（可关）
  if (config.autoStart) {
    void controller.ensureConnected().catch((e: Error) => logger('warn', '自动连接失败', e.message));
  }
}

export function deactivate(): void {
  closeFullUi();
  // 只在用户开了 dsh.stopOnExit 时杀掉我们自己 spawn 的 dsh；
  // 连的是别人的实例时 core 内部会忽略 killRuntime。
  controller?.dispose({ killRuntime: readConfig().stopOnExit });
  controller = undefined;
}

async function openChat(arg?: unknown): Promise<void> {
  if (!controller) return;
  await controller.show();
  const sessionId =
    typeof arg === 'string'
      ? arg
      : arg && typeof arg === 'object' && typeof (arg as { sessionId?: unknown }).sessionId === 'string'
        ? (arg as { sessionId: string }).sessionId
        : undefined;
  if (sessionId) await controller.openSession(sessionId);
}

function workspaceCwdOrUndefined(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : undefined;
}

/**
 * 往 ~/.dsh/dsh-vscode/activate.log 追加一行激活记录。
 * 命令行排查（以及 CI 里验证扩展真的加载了）时不用开 GUI 就能确认。
 * 写失败一律忽略，绝不影响扩展本身。
 */
function traceActivation(context: vscode.ExtensionContext): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = path.join(os.homedir(), '.dsh', 'dsh-vscode');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      version: context.extension.packageJSON.version,
      vscode: vscode.version,
      mode: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    });
    fs.appendFileSync(path.join(dir, 'activate.log'), line + '\n', 'utf8');
  } catch {
    /* 忽略 */
  }
}

export { ChatPanel };

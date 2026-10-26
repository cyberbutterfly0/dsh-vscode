/**
 * 把 SessionCore（纯逻辑，无 vscode 依赖）接到 VS Code 的 webview 上。
 *
 * 分工：
 * - core.ts      负责 dsh 协议、会话状态
 * - controller.ts 负责 vscode 能力（剪贴板、外链、选目录、打开完整 UI）
 * - panel.ts     只负责 webview 载体
 */

import * as vscode from 'vscode';

import type { DshConfig } from '../config';
import { workspaceCwd } from '../config';
import { t } from '../i18n';
import type { Logger } from '../log';
import type { HostToWeb, WebToHost } from '../protocol';
import { SessionCore } from './core';
import { collectEditorContext } from './editor-context';
import { openFullUi } from './full-ui';
import { ChatPanel, type ChatHost, type PanelState } from './panel';
import { ChatView } from './view';

export class ChatController implements ChatHost {
  private readonly core: SessionCore;
  private host: ChatPanel | undefined;
  private view: ChatView | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private config: DshConfig,
  ) {
    this.core = new SessionCore({
      config: {
        mode: this.config.mode,
        attachUrl: this.config.attachUrl,
        cliPath: this.config.cliPath,
        extraSpawnArgs: this.config.extraSpawnArgs,
        autoStart: this.config.autoStart,
        defaultCwd: this.config.defaultCwd,
        defaultPermission: this.config.defaultPermission,
        sendWorkspaceContext: this.config.sendWorkspaceContext,
      },
      logger: this.logger,
      post: (msg: HostToWeb) => this.broadcast(msg),
      onTitle: (title) => this.setTitle(title),
      onSessionChanged: () => void this.refreshTree?.(),
      requestToken: (reason) => void this.promptForToken(reason),
      version: String(this.context.extension.packageJSON.version ?? '0.0.0'),
    });
  }

  /** 由 extension.ts 注入，用来刷新侧栏 TreeView */
  refreshTree: (() => void | Promise<void>) | undefined;

  get currentSessionId(): string | undefined {
    return this.core.state.sessionId;
  }

  get coreRef(): SessionCore {
    return this.core;
  }

  get isConnected(): boolean {
    return this.core.state.connected;
  }

  /** extension.ts 注册侧栏视图时注入，之后 core 的消息会同时广播给 tab 和视图 */
  attachView(view: ChatView): void {
    this.view = view;
  }

  private broadcast(msg: HostToWeb): void {
    this.host?.post(msg);
    this.view?.post(msg);
  }

  private setTitle(title: string): void {
    // 编辑器 tab 有标题栏可改；侧栏视图的标题由 package.json 固定
    this.host?.setTitle(title);
    this.view?.setTitle(title);
  }

  /** 打开（或聚焦）聊天 tab，并按需连接 */
  async show(): Promise<ChatPanel> {
    this.host = ChatPanel.existing ?? ChatPanel.show(this.context, this);
    this.setTitle(this.core.state.title || t('chat.title'));
    if (!this.core.state.connected) {
      void this.core.connect({ attachUrl: this.config.attachUrl || undefined }).catch((e: Error) => {
        this.logger('error', '首次连接失败', e.message);
      });
    } else {
      this.core.requestInit();
    }
    return this.host;
  }

  revive(panel: vscode.WebviewPanel, state: PanelState): void {
    this.host = ChatPanel.revive(this.context, panel, this, state);
    if (state.sessionId && state.sessionId !== this.core.state.sessionId) {
      void this.core.openSession(state.sessionId).catch((e: Error) => this.logger('warn', '恢复会话失败', e.message));
    }
  }

  async reloadConfig(config: DshConfig): Promise<void> {
    this.config = config;
    await this.core.applyConfig({
      mode: config.mode,
      attachUrl: config.attachUrl,
      cliPath: config.cliPath,
      extraSpawnArgs: config.extraSpawnArgs,
      autoStart: config.autoStart,
      defaultCwd: config.defaultCwd,
      defaultPermission: config.defaultPermission,
      sendWorkspaceContext: config.sendWorkspaceContext,
    });
  }

  // ── ChatHost ────────────────────────────────────────────────────────────

  handleWebMessage(msg: WebToHost): void {
    void this.route(msg).catch((e: Error) => {
      this.logger('error', `处理 ${msg.type} 失败`, e.message);
      this.broadcast({ type: 'notice', level: 'error', text: e.message });
    });
  }

  private async route(msg: WebToHost): Promise<void> {
    switch (msg.type) {
      case 'open-full-ui': {
        const url = this.core.fullUiUrl;
        if (!url) {
          this.broadcast({ type: 'notice', level: 'warn', text: '还没连上 dsh，先连接再切完整界面' });
          return;
        }
        openFullUi(url);
        return;
      }
      case 'pick-cwd': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: '把 dsh 会话建在这个目录',
          defaultUri: workspaceCwd() ? vscode.Uri.file(workspaceCwd()) : undefined,
        });
        if (picked?.[0]) await this.core.newSession(picked[0].fsPath);
        return;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(msg.text);
        this.broadcast({ type: 'notice', level: 'info', text: '已复制' });
        return;
      }
      case 'open-link': {
        const href = msg.href.trim();
        if (!/^https?:\/\//i.test(href)) {
          this.broadcast({ type: 'notice', level: 'warn', text: '只支持 http/https 链接' });
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(href));
        return;
      }
      case 'insert-file-reference': {
        await this.insertFileReference(msg.query);
        return;
      }
      case 'prompt': {
        // 编辑器上下文：用户开着「把当前文件/选区/报错一起发」时，拼在消息前面
        if (this.config.sendWorkspaceContext) {
          const context = collectEditorContext();
          if (context) {
            await this.core.handle({ ...msg, text: `${context}\n\n${msg.text}` });
            return;
          }
        }
        await this.core.handle(msg);
        return;
      }
      case 'open-file': {
        const path = msg.path.trim();
        if (!path) return;
        // path 相对会话 cwd，也可能是绝对路径（工作区外）
        const abs = path.match(/^[a-zA-Z]:[\\/]|^\//) ? path : vscode.Uri.joinPath(vscode.Uri.file(this.core.cwd || workspaceCwd() || ''), path).fsPath;
        try {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
        } catch (e) {
          this.broadcast({ type: 'notice', level: 'warn', text: `打不开这个文件：${(e as Error).message}` });
        }
        return;
      }
      default:
        // 其余全交给 core（prompt/cancel/会话/模型/权限/翻页/回答/reconnect…）
        await this.core.handle(msg);
    }
  }

  private async insertFileReference(query?: string): Promise<void> {
    const files = await vscode.workspace.findFiles(
      query && query.trim() ? `**/*${query.trim()}*` : '**/*',
      '**/node_modules/**',
      200,
    );
    if (!files.length) {
      this.broadcast({ type: 'notice', level: 'info', text: '工作区里没找到文件' });
      return;
    }
    const picks = await vscode.window.showQuickPick(
      files.map((uri) => ({
        label: vscode.workspace.asRelativePath(uri, false),
        uri,
      })),
      { placeHolder: '选一个文件引用，插到输入框里', matchOnDescription: true },
    );
    if (!picks) return;
    const rel = vscode.workspace.asRelativePath(picks.uri, false);
    const doc = await vscode.workspace.openTextDocument(picks.uri);
    const selection = vscode.window.activeTextEditor?.selection;
    const snippet =
      selection && !selection.isEmpty ? doc.getText(selection) : doc.getText(new vscode.Range(0, 0, Math.min(20, doc.lineCount), 0));
    await vscode.env.clipboard.writeText(snippet);
    this.broadcast({
      type: 'notice',
      level: 'info',
      text: `已把 ${rel} 的内容放进剪贴板（消息里可以先写 @${rel}）`,
    });
  }

  onWebReady(): void {
    // 侧栏视图可能是整个扩展里第一个挂载的 webview，这里要能自己把连接拉起来
    if (!this.core.state.connected) {
      void this.core.connect({ attachUrl: this.config.attachUrl || undefined }).catch((e: Error) => {
        this.logger('warn', '侧栏视图初始化连接失败', e.message);
      });
      return;
    }
    // webview 每次挂载都重放一次 init，之后 core 会把流补上
    this.core.requestInit();
  }

  /** core 发现凭据失效/缺失时回调，这里弹输入框 */
  private async promptForToken(reason: 'no-token' | 'expired'): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: reason === 'expired' ? t('notice.authExpired') : t('ext.needToken'),
      prompt: t('ext.tokenPrompt'),
      placeHolder: 'http://127.0.0.1:51713/?token=…',
      ignoreFocusOut: true,
      validateInput: (v) => (v.includes('token=') ? undefined : t('ext.tokenEmpty')),
    });
    if (!url) return;
    try {
      await this.core.connect({ attachUrl: url.trim(), force: true });
    } catch (e) {
      this.logger('warn', '用新 URL 连接失败', (e as Error).message);
    }
  }

  onPanelDisposed(): void {
    this.host = undefined;
    if (this.disposed) return;
    // 面板关了但连接留着：多窗口/重开要能秒回到原会话
    this.logger('debug', '聊天面板已关闭，连接保持');
  }

  // ── 供 extension.ts 的命令用 ──────────────────────────────────────────────

  async newSession(cwd?: string): Promise<void> {
    await this.ensureConnected();
    await this.core.newSession(cwd && cwd.trim() ? cwd : undefined);
  }

  async openSession(sessionId: string): Promise<void> {
    await this.ensureConnected();
    await this.core.openSession(sessionId);
  }

  async connect(attachUrl?: string): Promise<void> {
    await this.core.connect({ attachUrl: attachUrl || undefined, force: true });
  }

  async restartRuntime(): Promise<void> {
    await this.core.connect({ force: true, mode: 'spawn' });
    this.broadcast({ type: 'notice', level: 'info', text: t('ext.runtimeRestarted') });
  }

  async disconnect(): Promise<void> {
    await this.core.disconnectOnly();
    this.broadcast({ type: 'notice', level: 'info', text: t('ext.disconnected') });
    await this.refreshTree?.();
  }

  async ensureConnected(): Promise<void> {
    if (this.core.state.connected) return;
    await this.core.connect({ attachUrl: this.config.attachUrl || undefined });
  }

  /**
   * 编辑器侧入口：把一段文本（选区、文件、问题）直接发进当前会话。
   * 没连就先连，没会话就新建一个，然后打开聊天面板让用户看到结果。
   */
  async askWithText(text: string, opts?: { prompt?: string }): Promise<void> {
    const body = text.trim();
    if (!body) {
      void vscode.window.showInformationMessage('没有可发送的内容（先选中一段代码，或打开一个文件）');
      return;
    }
    await this.ensureConnected();
    if (!this.core.state.sessionId) {
      await this.core.newSession(workspaceCwd());
    }
    await this.openChat();
    const question = opts?.prompt?.trim();
    const payload = question ? `${body}\n\n${question}` : body;
    await this.core.handle({ type: 'prompt', text: payload });
  }

  /** 打开（或聚焦）聊天面板 */
  async openChat(): Promise<void> {
    await this.show();
  }

  async selectModelFromCatalog(): Promise<void> {
    await this.ensureConnected();
    const { options } = this.core.modelCatalogForPicker();
    if (!options.length) {
      vscode.window.showInformationMessage('没拿到模型目录（可能还没连上 dsh）');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      options.map((o) => ({ label: o.label, description: o.description, selection: o.selection })),
      { placeHolder: '选模型 / 推理档' },
    );
    if (!picked) return;
    await this.core.selectModel(picked.selection);
  }

  async selectPermissionFromCatalog(): Promise<void> {
    await this.ensureConnected();
    const presets = this.core.permissionPresets;
    if (!presets.length) {
      vscode.window.showInformationMessage('没拿到权限档目录');
      return;
    }
    const current = this.core.currentPermission;
    const picked = await vscode.window.showQuickPick(
      presets.map((p) => ({
        label: p.name,
        description: [p.id, p.id === current ? '当前' : ''].filter(Boolean).join(' · '),
        id: p.id,
      })),
      { placeHolder: '选权限档（read-only / workspace-write / danger-full-access / auto）' },
    );
    if (!picked) return;
    await this.core.setPermission(picked.id);
  }

  get fullUiUrl(): string | undefined {
    return this.core.fullUiUrl;
  }

  dispose(): void {
    this.disposed = true;
    this.core.dispose();
  }
}


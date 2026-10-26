/**
 * 聊天面板：一个编辑器区 tab，里面是 media/chat.js 画的界面。
 *
 * 面板只负责「装 webview + 转发消息」，所有业务在 controller.ts。
 * 这样面板可以被序列化恢复（窗口重载后 sessionId 还在），也能被
 * 「完整 dsh UI」那个 iframe 面板复用同样的手势。
 */

import * as vscode from 'vscode';

import type { HostToWeb, WebToHost } from '../protocol';
import { t } from '../i18n';
import { MEDIA_ROOT, renderChatHtml } from './html';

export interface ChatHost {
  /** 面板重新加载时要重放的会话 id */
  readonly currentSessionId: string | undefined;
  handleWebMessage(msg: WebToHost): void;
  /** webview 每次挂载（含 reload）都会触发 */
  onWebReady(): void;
  onPanelDisposed(): void;
}

export interface PanelState {
  sessionId?: string;
}

export class ChatPanel {
  private static current: ChatPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pending: HostToWeb[] = [];

  static get existing(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  static show(context: vscode.ExtensionContext, host: ChatHost): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(undefined, false);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'dsh.chat',
      t('chat.title'),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [MEDIA_ROOT(context)],
      },
    );
    ChatPanel.current = new ChatPanel(context, panel, host);
    return ChatPanel.current;
  }

  /** 窗口重载后的恢复路径 */
  static revive(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, host: ChatHost, state: PanelState): ChatPanel {
    ChatPanel.current = new ChatPanel(context, panel, host, state);
    return ChatPanel.current;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly host: ChatHost,
    private state: PanelState = {},
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dsh.svg');
    panel.webview.html = this.renderHtml();

    panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const msg = raw as WebToHost;
        if ((msg as { type?: string }).type === 'ready') {
          this.ready = true;
          const queued = this.pending;
          this.pending = [];
          for (const m of queued) void panel.webview.postMessage(m);
          this.host.onWebReady();
          return;
        }
        try {
          this.host.handleWebMessage(msg);
        } catch (e) {
          void panel.webview.postMessage({
            type: 'notice',
            level: 'error',
            text: `处理消息失败：${(e as Error).message}`,
          } satisfies HostToWeb);
        }
      },
      null,
      this.disposables,
    );

    panel.onDidDispose(
      () => {
        ChatPanel.current = undefined;
        for (const d of this.disposables.splice(0)) d.dispose();
        this.host.onPanelDisposed();
      },
      null,
      this.disposables,
    );

    panel.onDidChangeViewState(
      () => {
        if (panel.visible && this.ready) this.host.onWebReady();
      },
      null,
      this.disposables,
    );
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  get disposed(): boolean {
    return !ChatPanel.current;
  }

  setTitle(title: string): void {
    this.panel.title = title || t('chat.title');
  }

  serialize(): PanelState {
    return { sessionId: this.host.currentSessionId ?? this.state.sessionId };
  }

  /** 发消息给 webview；没 ready 就排队，等 ready 后一次补发。 */
  post(msg: HostToWeb): void {
    if (!this.ready) {
      // ready 之前只保留最后一条 init，其余按序排队
      this.pending.push(msg);
      if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private renderHtml(): string {
    return renderChatHtml(this.panel.webview, this.context);
  }
}

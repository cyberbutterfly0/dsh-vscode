/**
 * 聊天视图：注册成 VS Code 的 view，放在活动栏的 DSH 容器里。
 *
 * 和编辑器 tab（panel.ts）的区别只是载体：
 * - panel  是 createWebviewPanel，占一个编辑器 tab，适合大屏全窗口
 * - view   是 WebviewView，可以被用户拖到「辅助侧边栏 / 面板 / 主侧边栏」
 *
 * 两者共用同一份 SessionCore 状态，由 controller 广播消息。
 */

import * as vscode from 'vscode';

import type { HostToWeb, WebToHost } from '../protocol';
import type { ChatHost } from './panel';
import { MEDIA_ROOT, renderChatHtml } from './html';

/**
 * 视图生命周期留痕：用户报「侧栏打不开」时，看
 * ~/.dsh/dsh-vscode/view.log 就知道是没 resolve 还是 resolve 了但前端没 ready。
 */
export function traceChatView(event: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');
    const dir = path.join(os.homedir(), '.dsh', 'dsh-vscode');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'view.log'),
      JSON.stringify({ at: new Date().toISOString(), event }) + '\n',
      'utf8',
    );
  } catch {
    /* 忽略 */
  }
}

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewType = 'dsh.chatView';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private pending: HostToWeb[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ChatHost,
  ) {}

  get attached(): boolean {
    return !!this.view;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    traceChatView('resolve');
    this.teardown();
    this.view = view;
    this.ready = false;
    this.pending = [];

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [MEDIA_ROOT(this.context)],
    };
    view.webview.html = renderChatHtml(view.webview, this.context);
    view.title = undefined;

    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const msg = raw as WebToHost;
        if ((msg as { type?: string }).type === 'ready') {
          this.ready = true;
          traceChatView('ready');
          const queued = this.pending;
          this.pending = [];
          for (const m of queued) void view.webview.postMessage(m);
          this.host.onWebReady();
          return;
        }
        try {
          this.host.handleWebMessage(msg);
        } catch (e) {
          void view.webview.postMessage({
            type: 'notice',
            level: 'error',
            text: `处理消息失败：${(e as Error).message}`,
          } satisfies HostToWeb);
        }
      }),
      view.onDidChangeVisibility(() => {
        // 从隐藏恢复时 webview 内容还在，但要跟后端对齐一次快照
        if (view.visible && this.ready) this.host.onWebReady();
      }),
      view.onDidDispose(() => this.teardown()),
    );
  }

  /** 发消息给视图；没挂载或没 ready 就排队。 */
  post(msg: HostToWeb): void {
    if (!this.view) return;
    if (!this.ready) {
      this.pending.push(msg);
      if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  /** 侧栏视图没有标题栏文案可改，留给将来复用 */
  setTitle(_title: string): void {
    /* 视图标题由 package.json 里 name 决定；会话标题在 webview 顶栏里显示 */
  }

  private teardown(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.view = undefined;
    this.ready = false;
    this.pending = [];
  }
}

/**
 * 聊天 webview 的 HTML 外壳（编辑器 tab 和侧边栏视图共用一份）。
 *
 * CSP 只放行 media/ 下的 chat.js + chat.css，脚本用 nonce。
 */

import * as fs from 'node:fs';

import * as vscode from 'vscode';

import { t } from '../i18n';

let nonceSeed = 0;

function nonce(): string {
  nonceSeed += 1;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return `${s}${nonceSeed}`;
}

export const MEDIA_ROOT = (context: vscode.ExtensionContext): vscode.Uri =>
  vscode.Uri.joinPath(context.extensionUri, 'media');

/**
 * 给资源 URI 加一个按修改时间变化的查询串。
 *
 * webview 是按 URI 缓存 css/js 的，文件内容变了但 URI 不变时会继续用旧的 ——
 * 改完样式刷新窗口都看不到效果就是这个原因。带上 mtime 后每次改动必然换 URI。
 */
function cacheKey(context: vscode.ExtensionContext, name: string): string {
  try {
    return String(Math.trunc(fs.statSync(vscode.Uri.joinPath(MEDIA_ROOT(context), name).fsPath).mtimeMs));
  } catch {
    return '0';
  }
}

export function renderChatHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const mediaRoot = MEDIA_ROOT(context);
  const script = webview
    .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'))
    .with({ query: `v=${cacheKey(context, 'chat.js')}` });
  const style = webview
    .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'))
    .with({ query: `v=${cacheKey(context, 'chat.css')}` });
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';" />
<link rel="stylesheet" href="${style}" />
<style>
  /* 兜底（随 HTML 每次生成，不受 css 缓存影响），并排在外部样式之后生效：
     少数主题把 --vscode-input-border / --vscode-panel-border 设成强调色，
     会让输入框看起来一直处于聚焦状态。这里固定成中性灰。 */
  .dsx-composer { border-color: rgba(128, 128, 128, 0.32); }
</style>
<title>dsh</title>
</head>
<body>
<div id="app" class="app booting">
  <div class="boot">${t('ext.connecting')}</div>
</div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}

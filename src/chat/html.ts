/**
 * 聊天 webview 的 HTML 外壳（编辑器 tab 和侧边栏视图共用一份）。
 *
 * CSP 只放行 media/ 下的 chat.js + chat.css，脚本用 nonce。
 */

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

export function renderChatHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const mediaRoot = MEDIA_ROOT(context);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chat.css'));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';" />
<link rel="stylesheet" href="${style}" />
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

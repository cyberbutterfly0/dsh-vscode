/**
 * 编辑器区「完整 dsh UI」：把 dsh web 自己的前端塞进 iframe。
 *
 * 关键约束（实测）：iframe 必须**自己**去加载 `/?token=…` 换 v1 cookie，
 * 扩展不能代劳（v1/v2 cookie 同名不互认）。
 */

import * as vscode from 'vscode';

let current: vscode.WebviewPanel | undefined;

export function openFullUi(url: string): vscode.WebviewPanel {
  if (current) {
    current.webview.html = render(current.webview, url);
    current.reveal(undefined, false);
    return current;
  }

  const panel = vscode.window.createWebviewPanel(
    'dsh.full',
    'dsh 完整界面',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = render(panel.webview, url);
  panel.onDidDispose(() => {
    if (current === panel) current = undefined;
  });
  current = panel;
  return panel;
}

export function closeFullUi(): void {
  current?.dispose();
  current = undefined;
}

function render(webview: vscode.Webview, url: string): string {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return 'http://127.0.0.1';
    }
  })();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { border: 0; width: 100%; height: 100vh; display: block; }
  .fallback { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; line-height: 1.6; }
  .fallback a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
<iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe>
<noscript><div class="fallback">需要启用脚本。<a href="${url}">在浏览器里打开</a></div></noscript>
</body>
</html>`;
}

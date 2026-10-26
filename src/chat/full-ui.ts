/**
 * 编辑器区「完整 dsh UI」：把 dsh web 自己的前端塞进 iframe。
 *
 * 关键约束（实测）：iframe 必须**自己**去加载 `/?token=…` 换 v1 cookie，
 * 扩展不能代劳（v1/v2 cookie 同名不互认）。
 *
 * 支持多 tab：每个会话一个面板，最多 MAX_PANELS 个，超了关最老的。
 * 支持缩放：`dsh.fullUiZoom`（0.5–1.5），CSS zoom 缩放整个 iframe。
 */

import * as vscode from 'vscode';

const MAX_PANELS = 5;
const DEFAULT_KEY = 'default';

interface Entry {
  panel: vscode.WebviewPanel;
  sessionId?: string;
  url: string;
  title: string;
}

const entries = new Map<string, Entry>();

export interface OpenFullUiOptions {
  url: string;
  /** 有 sessionId 就按会话独立开 tab，没有就复用 default */
  sessionId?: string;
  /** 面板标题；默认带会话 id 后缀 */
  title?: string;
  /** 0.5–1.5，undefined 用默认 1 */
  zoom?: number;
}

function clampZoom(z: number | undefined): number {
  if (typeof z !== 'number' || !Number.isFinite(z)) return 1;
  return Math.min(1.5, Math.max(0.5, z));
}

export function openFullUi(opts: OpenFullUiOptions): vscode.WebviewPanel {
  const key = opts.sessionId ?? DEFAULT_KEY;
  const zoom = clampZoom(opts.zoom);
  const title = opts.title ?? (opts.sessionId ? `dsh · ${shortId(opts.sessionId)}` : 'dsh 完整界面');

  const existing = entries.get(key);
  if (existing) {
    existing.url = opts.url;
    existing.title = title;
    existing.panel.title = title;
    existing.panel.webview.html = render(opts.url, zoom);
    existing.panel.reveal(undefined, false);
    return existing.panel;
  }

  // 超出上限：关掉最老的
  if (entries.size >= MAX_PANELS) {
    const oldest = entries.keys().next();
    if (!oldest.done) {
      const victim = entries.get(oldest.value);
      entries.delete(oldest.value);
      victim?.panel.dispose();
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'dsh.full',
    title,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = render(opts.url, zoom);

  const entry: Entry = { panel, sessionId: opts.sessionId, url: opts.url, title };
  entries.set(key, entry);
  panel.onDidDispose(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return panel;
}

export function closeFullUi(sessionId?: string): void {
  if (sessionId) {
    const entry = entries.get(sessionId);
    entries.delete(sessionId);
    entry?.panel.dispose();
    return;
  }
  for (const entry of entries.values()) entry.panel.dispose();
  entries.clear();
}

/** 改缩放后立刻重画所有已打开的完整 UI 面板 */
export function applyFullUiZoom(zoom: number): void {
  const z = clampZoom(zoom);
  for (const entry of entries.values()) {
    entry.panel.webview.html = render(entry.url, z);
  }
}

export function hasFullUi(sessionId?: string): boolean {
  return entries.has(sessionId ?? DEFAULT_KEY);
}

function shortId(id: string): string {
  const core = id.replace(/^session-/, '');
  return core.slice(0, 8);
}

function render(url: string, zoom: number): string {
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
  .frame-wrap { width: 100%; height: 100vh; overflow: hidden; }
  iframe { border: 0; width: 100%; height: 100vh; display: block; zoom: ${zoom}; }
  .fallback { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; line-height: 1.6; }
  .fallback a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
<div class="frame-wrap"><iframe src="${url}" allow="clipboard-read; clipboard-write"></iframe></div>
<noscript><div class="fallback">需要启用脚本。<a href="${url}">在浏览器里打开</a></div></noscript>
</body>
</html>`;
}

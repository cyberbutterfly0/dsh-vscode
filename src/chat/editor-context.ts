/**
 * 编辑器上下文：把「用户此刻在看的文件/选区/报错」变成一段文本，附在消息前面。
 *
 * 只做只读采集，不改编辑器状态。默认关闭（`dsh.sendWorkspaceContext`），
 * 因为每轮都带会明显吃 token。
 */

import * as vscode from 'vscode';

/** 选区最多带这么多字符，再多就截断（够模型看懂，又不会把整文件灌进去） */
const MAX_SELECTION_CHARS = 2000;
/** 诊断最多带这么多条 */
const MAX_DIAGNOSTICS = 5;

function workspaceRelative(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) return vscode.workspace.asRelativePath(uri, false);
  // 没打开工作区文件夹时，绝对路径太长，退回文件名（够模型定位）
  const parts = uri.fsPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : uri.fsPath;
}

function severityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}

/**
 * 采集当前编辑器上下文。没有活动编辑器、或没有工作区时返回 undefined。
 */
export function collectEditorContext(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  const doc = editor.document;
  const rel = workspaceRelative(doc.uri);
  const lines: string[] = [];

  lines.push(`当前文件: ${rel} (${doc.languageId}, ${doc.lineCount} 行)`);
  if (doc.isDirty) lines.push('状态: 有未保存修改');

  const sel = editor.selection;
  if (!sel.isEmpty) {
    const text = doc.getText(sel);
    const clipped =
      text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}\n…（选区共 ${text.length} 字，已截断）` : text;
    lines.push(`选区 (第 ${sel.start.line + 1}-${sel.end.line + 1} 行):`);
    lines.push('```');
    lines.push(clipped);
    lines.push('```');
  } else {
    lines.push(`光标: 第 ${sel.active.line + 1} 行，第 ${sel.active.character + 1} 列`);
    // 光标所在行的内容，帮助模型理解「这里」指什么
    const currentLine = doc.lineAt(Math.min(sel.active.line, Math.max(0, doc.lineCount - 1))).text;
    const trimmed = currentLine.trim();
    if (trimmed) {
      lines.push(`该行内容: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed}`);
    }
  }

  // 该文件的诊断（别人改坏的、自己写错的，都能让模型少走弯路）
  let diagnostics: vscode.Diagnostic[] = [];
  try {
    diagnostics = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
  } catch {
    diagnostics = [];
  }
  if (diagnostics.length > 0) {
    lines.push(`诊断 (${diagnostics.length} 条${diagnostics.length > MAX_DIAGNOSTICS ? `，只列前 ${MAX_DIAGNOSTICS}` : ''}):`);
    for (const d of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      const where = `第 ${d.range.start.line + 1} 行 ${d.range.start.character + 1} 列`;
      lines.push(`- [${severityName(d.severity)}] ${where}: ${d.message}`);
    }
  }

  return `<editor-context>\n${lines.join('\n')}\n</editor-context>`;
}

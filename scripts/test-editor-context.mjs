/**
 * 用假的 vscode 模块跑 editor-context 的真实逻辑（不需要开 VS Code 窗口）。
 * 用法：node .smoke-tmp/test-editor-context.mjs
 */

import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const requireCjs = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, '.smoke-tmp', 'editor-context.cjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src/chat/editor-context.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

// ── 假 vscode ────────────────────────────────────────────────────────────
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

const makeDoc = (text, opts = {}) => {
  const lines = text.split('\n');
  return {
    uri: { fsPath: path.join('E:\\work\\proj', opts.rel ?? 'src/app.ts'), scheme: 'file' },
    languageId: opts.languageId ?? 'typescript',
    lineCount: lines.length,
    isDirty: opts.isDirty ?? false,
    getText: (sel) => {
      if (!sel) return text;
      return lines.slice(sel.start.line, sel.end.line + 1).join('\n');
    },
    lineAt: (n) => ({ text: lines[n] ?? '' }),
  };
};

const fakeState = { editor: null, diagnostics: [] };

const fakeVscode = {
  DiagnosticSeverity,
  window: {
    get activeTextEditor() {
      return fakeState.editor;
    },
  },
  workspace: {
    getWorkspaceFolder: () => ({ uri: { fsPath: 'E:\\work\\proj' } }),
    asRelativePath: (uri) => path.relative('E:\\work\\proj', uri.fsPath).split(path.sep).join('/'),
  },
  languages: {
    getDiagnostics: () => fakeState.diagnostics,
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, parent, isMain);
};

const { collectEditorContext } = requireCjs(out);

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

// 1. 没有活动编辑器
fakeState.editor = null;
check('无编辑器时返回 undefined', collectEditorContext() === undefined);

// 2. 无选区，光标在第 2 行，带两条诊断
const doc = makeDoc('export function add(a: number, b: number) {\n  return a + b;\n}\n', { isDirty: true });
fakeState.editor = {
  document: doc,
  selection: {
    isEmpty: true,
    start: { line: 1, character: 2 },
    end: { line: 1, character: 2 },
    active: { line: 1, character: 2 },
  },
};
fakeState.diagnostics = [
  { severity: DiagnosticSeverity.Error, message: "Type 'string' is not assignable to type 'number'.", range: { start: { line: 2, character: 4 } } },
  { severity: DiagnosticSeverity.Warning, message: 'Unused variable.', range: { start: { line: 0, character: 0 } } },
  { severity: DiagnosticSeverity.Hint, message: 'should be filtered out', range: { start: { line: 0, character: 0 } } },
];

const ctx = collectEditorContext();
console.log('\n--- 无选区 + 诊断 ---\n' + ctx + '\n');
check('包在 <editor-context> 里', /^<editor-context>[\s\S]*<\/editor-context>$/.test(ctx ?? ''));
check('带相对路径与语言', ctx?.includes('当前文件: src/app.ts (typescript, 4 行)'));
check('带未保存标记', ctx?.includes('状态: 有未保存修改'));
check('带光标位置', ctx?.includes('光标: 第 2 行，第 3 列'));
check('带该行内容', ctx?.includes('该行内容: return a + b;'));
check('诊断只保留 error/warning', ctx?.includes('- [error] 第 3 行 5 列') && ctx?.includes('- [warning] 第 1 行 1 列'));
check('hint 被过滤', !ctx?.includes('should be filtered out'));

// 3. 有选区，超长截断
const longText = 'x'.repeat(3000);
const doc2 = makeDoc(`line1\n${longText}\nline3`);
fakeState.editor = {
  document: doc2,
  selection: {
    isEmpty: false,
    start: { line: 1, character: 0 },
    end: { line: 1, character: 3000 },
    active: { line: 1, character: 3000 },
  },
};
fakeState.diagnostics = [];
const ctx2 = collectEditorContext();
check('选区带行号范围', ctx2?.includes('选区 (第 2-2 行):'));
check('超 2000 字截断并注明', ctx2?.includes('选区共 3000 字，已截断'));
check('截断后长度受控', (ctx2?.length ?? 0) < 2400, `实际 ${ctx2?.length}`);

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exitCode = failed === 0 ? 0 : 1;



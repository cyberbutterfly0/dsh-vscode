/**
 * diff-build 单测：不需要 dsh，也不需要 VS Code。
 *
 *   npm run test:diff-build
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, '.smoke-tmp');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'diff-build.mjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src/chat/diff-build.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
});

const { rebuildBefore, buildDiffSides, buildFragmentSides } = await import(pathToFileURL(outFile).href);

let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ── 纯新增：文件原本不存在 ────────────────────────────────────────────────
test('新增文件：before 为空，after 是全文', () => {
  const hunks = [
    { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+alpha', '+beta', '+gamma'] },
  ];
  const sides = buildDiffSides({ afterText: 'alpha\nbeta\n gamma'.replace(' gamma', 'gamma') + '\n', hunks, before: false, after: true });
  assert.equal(sides.before, '');
  assert.equal(sides.after, 'alpha\nbeta\ngamma\n');
});

// ── 纯删除：整个文件被删 ─────────────────────────────────────────────────
test('删除文件：after 为空，before 保留内容', () => {
  const hunks = [
    { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-a', '-b'] },
  ];
  const sides = buildDiffSides({ afterText: '', hunks, before: true, after: false });
  assert.equal(sides.after, '');
  assert.ok(sides.before.includes('a'));
  assert.ok(sides.before.includes('b'));
});

// ── 改一行：反推应还原出原文 ─────────────────────────────────────────────
test('改一行：rebuildBefore 还原原文', () => {
  const after = 'one\nTWO\nthree\nfour\n';
  const hunks = [
    { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-two', '+TWO'] },
    { oldStart: 4, oldLines: 0, newStart: 4, newLines: 1, lines: ['+four'] },
  ];
  assert.equal(rebuildBefore(after, hunks), 'one\ntwo\nthree\n');
});

// ── 纯增行 ───────────────────────────────────────────────────────────────
test('纯增行：before 比 after 少一行', () => {
  const after = 'a\nb\nnew\nc\n';
  const hunks = [{ oldStart: 3, oldLines: 0, newStart: 3, newLines: 1, lines: ['+new'] }];
  assert.equal(rebuildBefore(after, hunks), 'a\nb\nc\n');
});

// ── 纯删行 ───────────────────────────────────────────────────────────────
test('纯删行：before 比 after 多一行', () => {
  const after = 'a\nc\n';
  const hunks = [{ oldStart: 2, oldLines: 1, newStart: 1, newLines: 0, lines: ['-b'] }];
  assert.equal(rebuildBefore(after, hunks), 'a\nb\nc\n');
});

// ── 相邻 hunk：行号不能被前一个改动推偏 ──────────────────────────────────
test('相邻 hunk 倒序应用', () => {
  const after = 'A\nB\nC\nD\n';
  const hunks = [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] },
    { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-c', '+C'] },
  ];
  assert.equal(rebuildBefore(after, hunks), 'a\nB\nc\nD\n');
});

// ── 空文件 → 有内容 ──────────────────────────────────────────────────────
test('空文件变有内容', () => {
  const after = 'hello\n';
  const hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] }];
  assert.equal(rebuildBefore(after, hunks), '\n');
});

// ── 行尾没有换行 ─────────────────────────────────────────────────────────
test('行尾无换行时保持无换行', () => {
  const after = 'a\nb';
  const hunks = [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-B', '+b'] }];
  assert.equal(rebuildBefore(after, hunks), 'a\nB');
});

// ── 无 hunks（coarse）：原样返回 ─────────────────────────────────────────
test('没有 hunks 时原样返回', () => {
  assert.equal(rebuildBefore('x\ny\n', []), 'x\ny\n');
});

// ── 上下文行也要参与替换 ─────────────────────────────────────────────────
test('带上下文行的 hunk', () => {
  const after = 'keep1\nnew\nkeep3\n';
  const hunks = [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' keep1', '-old', '+new', ' keep3'] },
  ];
  assert.equal(rebuildBefore(after, hunks), 'keep1\nold\nkeep3\n');
});

// ── 历史轮次降级：片段视图 ───────────────────────────────────────────────
test('片段视图只保留 hunk 覆盖的行', () => {
  const hunks = [
    { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-before-line', '+after-line'] },
  ];
  const frag = buildFragmentSides(hunks);
  assert.equal(frag.before, 'before-line\n');
  assert.equal(frag.after, 'after-line\n');
});

// ── 拿不到磁盘内容时返回 undefined ───────────────────────────────────────
test('afterText 缺失且不是删除 → undefined', () => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
  assert.equal(buildDiffSides({ afterText: undefined, hunks, before: true, after: true }), undefined);
});

for (const c of cases) {
  try {
    await c.fn();
    passed += 1;
    console.log(`✔ ${c.name}`);
  } catch (e) {
    console.error(`✘ ${c.name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`\n${passed}/${cases.length} 通过`);

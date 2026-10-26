/**
 * 从 dsh 给的 hunks 重建 before/after 文本。
 *
 * 纯函数，不依赖 vscode / dsh，方便单测（scripts/test-diff-build.mjs）。
 *
 * 坐标约定（来自 dsh 的 WorkspaceDiffHunk，跟 unified diff 一致）：
 *   oldStart / oldLines —— 改动前文件里的起始行（1-based）与行数
 *   newStart / newLines —— 改动后文件里的起始行（1-based）与行数
 *   lines —— 每行首字符 '+' / '-' / ' '
 * 行数为 0 表示该侧完全为空（纯新增或纯删除），此时 start 是 0。
 */

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffSides {
  before: string;
  after: string;
}

/** 把 hunk 的某侧（'old' | 'new'）取出来，去掉行首标记 */
export function sideLines(hunk: DiffHunk, side: 'old' | 'new'): string[] {
  const marker = side === 'old' ? '-' : '+';
  const other = side === 'old' ? '+' : '-';
  return hunk.lines.filter((l) => l[0] !== other).map((l) => l.slice(1));
}

/** 1-based 起点转 0-based；0（空侧）当 0 处理 */
function startIndex(start: number): number {
  return start <= 1 ? 0 : start - 1;
}

/**
 * 用 after 的整篇文章 + hunks，反向重建 before。
 *
 * 前提：afterText 就是这批 hunks 对应的那个版本（本轮刚结束时成立）。
 * hunks 倒序应用，避免前面的改动把后面的行号推偏。
 */
export function rebuildBefore(afterText: string, hunks: DiffHunk[]): string {
  if (hunks.length === 0) return afterText;

  const trailingNewline = afterText.endsWith('\n');
  const lines = afterText.split('\n');
  if (trailingNewline) lines.pop();

  const ordered = [...hunks].sort((a, b) => b.newStart - a.newStart);
  for (const hunk of ordered) {
    const start = hunk.newLines === 0 ? hunk.newStart : startIndex(hunk.newStart);
    const added = sideLines(hunk, 'old');
    // 该 hunk 在 after 里占的行数：上下文 + 新增
    const consumed = hunk.newLines === 0 && hunk.newStart === 0 ? 0 : hunk.newLines;
    // newLines 有时和 lines 里 '+'/' ' 的数量对不上（边界情况），以 lines 为准
    const actual = hunk.lines.filter((l) => l[0] !== '-').length;
    const take = Math.max(consumed, actual);
    lines.splice(start, take, ...added);
  }

  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/**
 * 一次给出 before/after 两侧文本。
 *
 * - `before: false` → 这是新增的文件，before 为空
 * - `after: false`  → 这是被删掉的文件，after 为空
 * - `afterText` 传 undefined → 调用方拿不到磁盘内容（历史轮次），返回 undefined
 */
export function buildDiffSides(params: {
  afterText: string | undefined;
  hunks: DiffHunk[];
  before: boolean;
  after: boolean;
}): DiffSides | undefined {
  const { afterText, hunks, before, after } = params;

  if (!after && before) {
    // 整个文件被删掉了：磁盘上没有内容，只能从 hunks 的 old 侧拼回来
    const fromHunks = hunks.length > 0 ? buildFragmentSides(hunks).before : (afterText ?? '');
    return { before: fromHunks, after: '' };
  }
  if (afterText === undefined) return undefined;
  if (!before) return { before: '', after: afterText };
  return { before: rebuildBefore(afterText, hunks), after: afterText };
}

/**
 * 历史轮次降级用：只取 hunk 覆盖的那几段，拼成两个小文本。
 * 行号会失真，但内容对比是真的。
 */
export function buildFragmentSides(hunks: DiffHunk[]): DiffSides {
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  for (const h of hunks) {
    beforeParts.push(...sideLines(h, 'old'));
    afterParts.push(...sideLines(h, 'new'));
  }
  const fin = (parts: string[]) => (parts.length === 0 ? '' : `${parts.join('\n')}\n`);
  return { before: fin(beforeParts), after: fin(afterParts) };
}

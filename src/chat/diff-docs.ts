/**
 * 原生并排 diff：把 dsh 给的 hunks 变成两个虚拟文档，交给 `vscode.diff`。
 *
 * 为什么不用临时文件：虚拟文档不落盘、不进工作区、关掉就没了，也不会污染 git。
 */

import * as vscode from 'vscode';

import { buildDiffSides, buildFragmentSides, type DiffSides } from './diff-build';

const SCHEME = 'dsh-diff';
/** 同时保留的虚拟文档上限，超了丢最老的（diff 页仍开着就是空内容，可接受） */
const MAX_ENTRIES = 40;

interface Entry {
  content: string;
}

class DiffDocProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, Entry>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.toString())?.content ?? '';
  }

  put(key: string, path: string, side: 'before' | 'after', content: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: SCHEME,
      path: `/${path.replace(/^[\\/]+/, '').replace(/\\/g, '/')}`,
      query: `side=${side}&key=${encodeURIComponent(key)}`,
    });
    this.store.set(uri.toString(), { content });
    while (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
    return uri;
  }

  clear(): void {
    this.store.clear();
  }
}

let provider: DiffDocProvider | undefined;

function ensureProvider(context: vscode.ExtensionContext): DiffDocProvider {
  if (!provider) {
    provider = new DiffDocProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
      // 扩展卸载/重载时清干净
      new vscode.Disposable(() => provider?.clear()),
    );
  }
  return provider;
}

export interface OpenNativeDiffInput {
  /** 用来给虚拟文档做 key，同时决定标题后缀 */
  sessionId: string;
  seq: number;
  index: number;
  /** 相对路径（工作区内）或绝对路径（区外） */
  path: string;
  /** 给人看的路径 */
  display: string;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
  /** 改动前文件是否存在 */
  before: boolean;
  /** 改动后文件是否存在 */
  after: boolean;
  coarse?: boolean;
}

export class DiffUnavailableError extends Error {}

/**
 * 打开一个文件的原生 diff。返回 undefined 表示成功，抛错表示没法开（调用方负责提示）。
 */
export async function openNativeDiff(
  context: vscode.ExtensionContext,
  input: OpenNativeDiffInput,
): Promise<void> {
  const absPath = resolvePath(input.path);
  const afterOnDisk = input.after ? await readTextSafe(absPath) : undefined;

  let sides: DiffSides | undefined;
  let suffix = '（本轮改动）';

  if (input.coarse || input.hunks.length === 0) {
    // coarse：没有行级信息。只有"整文件新增/删除"还能给出一侧空白，其余没得比
    if (!input.before && input.after) {
      sides = { before: '', after: afterOnDisk ?? '' };
    } else if (input.before && !input.after) {
      sides = { before: afterOnDisk ?? '', after: '' };
    } else {
      throw new DiffUnavailableError(
        '这个文件本轮是整文件重写，dsh 没有给出行级对比。下面用内联红色卡片看增删行数。',
      );
    }
  } else {
    sides = buildDiffSides({
      afterText: input.after ? afterOnDisk : undefined,
      hunks: input.hunks,
      before: input.before,
      after: input.after,
    });
    if (!sides) {
      // 磁盘内容读不到（文件已被删/移走），退化成 hunk 片段
      sides = buildFragmentSides(input.hunks);
      suffix = '（片段）';
    } else if (input.after && afterOnDisk === undefined) {
      sides = buildFragmentSides(input.hunks);
      suffix = '（片段）';
    }
  }

  const docs = ensureProvider(context);
  const key = `${input.sessionId}:${input.seq}:${input.index}`;
  const beforeUri = docs.put(key, input.display, 'before', sides.before);
  const afterUri = docs.put(key, input.display, 'after', sides.after);

  const title = `${input.display} ${suffix}`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeUri,
    afterUri,
    title,
    { preview: false, preserveFocus: false } as vscode.TextDocumentShowOptions,
  );
}

/** 相对路径按工作区根拼；绝对路径原样用 */
function resolvePath(p: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) return p;
  const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rootDir) return p;
  return vscode.Uri.joinPath(vscode.Uri.file(rootDir), p).fsPath;
}

async function readTextSafe(absPath: string): Promise<string | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    const text = Buffer.from(buf).toString('utf8');
    // 二进制探测：出现 NUL 就当二进制，别塞进 diff 编辑器
    if (text.includes('\u0000')) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

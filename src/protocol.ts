/**
 * 扩展 (extension host) ↔ 聊天 webview 的消息契约。
 *
 * 这个文件是两边的唯一接口，冻结后两边各自实现，互不 import 对方的内部模块。
 * webview 侧对应 media/chat.js，扩展侧对应 src/chat/panel.ts。
 */

import type {
  AssistantStreamBaseline,
  AssistantStreamFrame,
  JsonValue,
  ModelCatalog,
  ModelSelection,
  SessionHistoryRecord,
  SessionProjectionBaseline,
  SessionWireEvent,
  SessionWireHeader,
  TokenUsage,
} from './dsh/types';

// ── 会话列表行（比 SessionSummary 轻，只给侧栏/切换器用）──────────────────────

export interface UiSessionRow {
  sessionId: string;
  title: string;
  running: boolean;
  blank: boolean;
  updatedAt: number;
  cwd?: string;
  parentSessionId?: string;
  /** 是否当前正在看的会话 */
  active?: boolean;
}

export interface UiPermissionPreset {
  id: string;
  name: string;
  description?: string;
}

export interface UiModelGroup {
  id: string;
  name: string;
  models: {
    id: string;
    name: string;
    description?: string;
    efforts: { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  }[];
}

export interface UiCatalog {
  default: ModelSelection;
  groups: UiModelGroup[];
  failures: { name: string; message: string }[];
}

/** 需要用户回答的东西：审批卡片 / 提问卡片。 */
export interface UiAsk {
  id: string;
  kind: 'approval' | 'question';
  title: string;
  body?: string;
  /** 命令、参数、diff 之类，前端原样展示 */
  detail?: string;
  options?: { id: string; label: string; description?: string; destructive?: boolean }[];
  multiSelect?: boolean;
  createdAt: number;
}

export interface UiUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  pressureTokens?: number;
}

// ── 扩展 → webview ──────────────────────────────────────────────────────────

export type HostToWeb =
  /** webview 挂载完成后的第一条状态包 */
  | {
      type: 'init';
      state: {
        connected: boolean;
        authority?: string;
        cwd?: string;
        sessionId?: string;
        sessionTitle?: string;
        sessions: UiSessionRow[];
        catalog?: UiCatalog;
        selection?: ModelSelection;
        permissions?: { current?: string; presets: UiPermissionPreset[] };
        defaultPermission?: string;
        running: boolean;
        asks: UiAsk[];
        version: string;
      };
    }
  | { type: 'sessions'; sessions: UiSessionRow[] }
  /** 切到一个会话：整窗口重建（snapshot 权威） */
  | { type: 'open'; sessionId: string; title?: string; header?: SessionWireHeader; records: SessionHistoryRecord[]; projections?: SessionProjectionBaseline; hasMore?: boolean; assistantStream?: AssistantStreamBaseline }
  /** 追加一条持久事件 */
  | { type: 'event'; event: SessionWireEvent }
  /** 追加一条历史 record（往上翻页时） */
  | { type: 'records'; records: SessionHistoryRecord[]; prepend?: boolean }
  | { type: 'stream'; frame: AssistantStreamFrame }
  /** 断线重连：清掉进行中的流式渲染，等下一帧 snapshot */
  | { type: 'reset' }
  | { type: 'title'; title: string }
  | { type: 'projections'; values: Record<string, JsonValue>; asOfSeq?: number }
  | { type: 'models'; catalog: UiCatalog; selection?: ModelSelection }
  | { type: 'permissions'; current?: string; presets: UiPermissionPreset[] }
  | { type: 'status'; connected: boolean; running: boolean; detail?: string }
  | { type: 'ask'; ask: UiAsk }
  | { type: 'ask-close'; id: string }
  | { type: 'usage'; usage: UiUsage }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /** 某一轮的改动汇总（来自 workspace/changes 事件 + /api/changes.summary） */
  | { type: 'changes'; changes: UiChanges }
  /** 变更汇总里某个文件的对比（/api/changes.diff 的结果） */
  | { type: 'diff'; diff: UiDiff }
  | { type: 'auth-needed'; reason: 'no-token' | 'token-expired' | 'disconnected'; authority?: string }
  /** 用户选好了图片（dataUrl 给 webview 直接当缩略图用） */
  | { type: 'image-picked'; id: string; name: string; mediaType: string; dataUrl: string; bytes: number }
  | { type: 'image-error'; text: string };

// ── 改动可视化 ──────────────────────────────────────────────────────────────

export interface UiChangedFile {
  /** 汇总里的下标，取 diff 时用它 */
  index: number;
  path: string;
  display: string;
  added: number;
  deleted: number;
  binary?: boolean;
  oversized?: boolean;
}

export interface UiChanges {
  sessionId: string;
  /** workspace/changes 事件的 seq，取 diff 的坐标之一 */
  seq: number;
  turn: number;
  files: UiChangedFile[];
  total: number;
  added: number;
  deleted: number;
}

export interface UiDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface UiDiff {
  sessionId: string;
  seq: number;
  index: number;
  kind: 'text' | 'binary' | 'oversized';
  path: string;
  display: string;
  /** kind==='text' 才有 */
  before?: boolean;
  after?: boolean;
  hunks?: UiDiffHunk[];
  coarse?: boolean;
}

// ── webview → 扩展 ──────────────────────────────────────────────────────────

export interface UiImagePart {
  /** 图片 MIME，如 image/png */
  mediaType: string;
  /** base64，不带 data: 前缀 */
  data: string;
  name?: string;
}

export interface PromptPayload {
  text: string;
  /** 文本块（保留字段，目前与 text 等价） */
  content?: { type: 'text'; text: string }[];
  /** 随消息一起发出去的图片 */
  images?: UiImagePart[];
  mode?: 'queue' | 'steer';
}

export type WebToHost =
  | { type: 'ready' }
  | ({ type: 'prompt' } & PromptPayload)
  | { type: 'cancel' }
  | { type: 'new-session'; cwd?: string }
  | { type: 'open-session'; sessionId: string }
  | { type: 'close-session' }
  | { type: 'rename-session'; sessionId: string; title: string }
  | { type: 'select-model'; selection: ModelSelection }
  | { type: 'set-permission'; preset: string }
  | { type: 'open-full-ui' }
  | { type: 'pick-cwd' }
  | { type: 'load-older' }
  | { type: 'answer'; id: string; value: JsonValue }
  | { type: 'cancel-ask'; id: string }
  | { type: 'copy'; text: string }
  | { type: 'open-link'; href: string }
  /** 展开某个文件的改动对比 */
  | { type: 'load-diff'; sessionId: string; seq: number; index: number }
  /** 用 VS Code 原生并排 diff 打开某个文件的改动 */
  | { type: 'open-native-diff'; sessionId: string; seq: number; index: number }
  /** 用 VS Code 打开这个文件 */
  | { type: 'open-file'; path: string }
  | { type: 'reconnect' }
  /** 让扩展弹「选择图片」，选完通过 HostToWeb.image-picked 回传 */
  | { type: 'pick-image' }
  | { type: 'insert-file-reference'; query?: string };

export type { JsonValue, TokenUsage };

/**
 * dsh 线上契约的 TypeScript 镜像。
 *
 * 只收录扩展真正用到的部分。字段名/形状对齐 dsh 0.2.1-rc.2 的
 * `@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts`。
 * 不要在这里引任何 @deepseek-ai/* 包——本文件是手写镜像。
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// ── 一元 RPC 信封 ────────────────────────────────────────────────────────────

export interface ClientRequest {
  type: 'client-request';
  rpcId: string;
  /** 必须等于 URL 里的 endpoint，否则 200 + gateway/bad-request */
  method: string;
  payload: { args: Record<string, unknown> };
}

export interface RemoteError {
  code: string;
  message: string;
  details?: JsonValue;
}

export interface ServerResponse {
  type: 'server-response';
  rpcId: string;
  result: { ok: true; value: unknown } | { ok: false; error: RemoteError };
}

// ── WS 多路复用帧 ───────────────────────────────────────────────────────────

export type MuxUp =
  | { type: 'open'; streamId: string; endpoint: string; payload: { args: Record<string, unknown> } }
  | { type: 'item'; streamId: string; value?: JsonValue }
  | { type: 'end'; streamId: string }
  | { type: 'cancel'; streamId: string };

export type MuxDown =
  | { type: 'item'; streamId: string; value: JsonValue }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: RemoteError };

// ── session/follow ──────────────────────────────────────────────────────────

export type SessionAddress =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' | 'unknown' };

export interface SessionWireEvent {
  type: string;
  seq: number;
  time: number;
  data: JsonValue;
  ignorable?: true;
  sourceEventSeqs?: JsonValue;
  surfaceOp?: JsonValue;
}

export interface SessionEventEntry {
  type: 'event';
  event: SessionWireEvent;
}

export type SessionHistoryRecord = SessionEventEntry;

export interface SessionWireHeader {
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  isSeeded: boolean;
  origin?: 'subagent';
  delegationDepth?: number;
  agentPreset?: string;
}

/** 统一块协议：chunk 不是 provider 原生格式，直接渲染。 */
export type AssistantChunk =
  | { type: 'block-start'; index: number; blockType: 'reasoning' | 'text' }
  | { type: 'block-end'; index: number; block: { type: 'reasoning' | 'text'; text: string } }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'usage'; usage: TokenUsage };

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export type AssistantStreamFrame =
  | {
      type: 'start';
      attemptId: string;
      revision: number;
      startedAfterSeq: number;
      turn: number;
      step: number;
    }
  | {
      type: 'chunk';
      attemptId: string;
      revision: number;
      index: number;
      time: number;
      chunk: AssistantChunk;
    }
  | {
      type: 'end';
      attemptId: string;
      revision: number;
      index: number;
      outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number } | { kind: 'abandoned' };
    };

export interface AssistantStreamAttempt {
  attemptId: string;
  startedAfterSeq: number;
  turn: number;
  step: number;
  nextIndex: number;
  stream: AssistantChunk[];
}

export interface AssistantStreamBaseline {
  revision: number;
  activeAttempt?: AssistantStreamAttempt;
}

export interface SessionProjectionBaseline {
  asOfSeq: number;
  values: Record<string, JsonValue>;
}

export type SessionFollowFrame =
  | {
      type: 'snapshot';
      header: SessionWireHeader;
      cursor: number;
      records: SessionHistoryRecord[];
      hasMore: boolean;
      projections: SessionProjectionBaseline;
      assistantStream?: AssistantStreamBaseline;
    }
  | SessionEventEntry
  | { type: 'assistant-stream'; frame: AssistantStreamFrame };

// ── session/control ─────────────────────────────────────────────────────────

export type SessionControlFrame =
  | { type: 'baseline'; value: { projections: Record<string, SessionProjectionBaseline> } }
  | { type: 'projection'; sessionId: string; key: string; value: JsonValue; seq: number };

// ── 列表 / 模型 / 权限 ───────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  agentAvailable: boolean;
  formatStatus?: 'current' | 'migration-required';
  parentSessionId?: string;
  origin?: 'subagent';
  cwd?: string;
  projections?: {
    kind: 'cached' | 'sequenced';
    asOfSeq: number;
    values: Record<string, JsonValue>;
  };
}

export interface SessionListValue {
  items: SessionSummary[];
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: { efforts: ModelReasoningEffort[]; defaultEffort?: string };
}

export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

export interface ModelCatalog {
  default: ModelSelection;
  routableProviders: string[];
  groups: ModelProviderGroup[];
  failures: { id: string; name: string; message: string }[];
}

/** session/updateQueue 的 action（排队消息编辑/删除/介入） */
export type QueueAction =
  | { kind: 'edit'; content: { type: 'text'; text: string }[] }
  | { kind: 'remove' }
  | { kind: 'steer' };

export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string };

// ── 权限（permission-presets 包，已从 lib/types/types.d.ts 核对）──────────

export interface PermissionPresetOption {
  /** 稳定值：配置的 preset key、活的 `auto`、或派生的 `custom` */
  value: string;
  name: string;
  description?: string;
}

export interface PermissionCatalog {
  options: PermissionPresetOption[];
  /** 可作为新会话默认档的预设 */
  defaultOptions: PermissionPresetOption[];
  defaultPreset: string;
}

/** Session 的 `permissions` projection：当前生效档位 */
export interface PermissionSelection {
  currentValue: string;
}

// ── ask_user_question（dsh-user-questions/lib/types）──────────────────────

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionIntent {
  kind: 'plan-review';
  approve: string;
  callId?: string;
}

export interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
  intent?: AskUserQuestionIntent;
}

export interface AskUserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
}

/** Session 的 `userQuestions` projection 里的一条待答问题 */
export interface PendingUserQuestion {
  callId: string;
  questions: readonly AskUserQuestionItem[];
  state: 'open' | 'continued';
}

// ── 改动可视化（dsh-workspace-changes）────────────────────────────────────
//
// session 事件 `workspace/changes` 的 payload 只有 `{turn}`；真正的摘要在 Host，
// 用该事件的 seq 去 `/api/changes.summary` 取，单个文件的对比去 `/api/changes.diff`。

/** 汇总里的一个改动文件。path/display 都用 `/`，工作区外的 path 是绝对路径 */
export interface WorkspaceChangedFile {
  path: string;
  display: string;
  added: number;
  deleted: number;
  binary?: true;
  oversized?: true;
}

export interface WorkspaceChangesSummary {
  turn: number;
  cwd?: string;
  files: WorkspaceChangedFile[];
  /** 全量计数（files 可能被 maxFiles 截断） */
  total: number;
  added: number;
  deleted: number;
  snapshot?: { before: string; after: string };
}

export interface WorkspaceDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 每行带 `+` / `-` / 空格前缀 */
  lines: string[];
}

export interface WorkspaceFileDiffText {
  kind: 'text';
  path: string;
  display: string;
  /** 本轮之前是否存在 */
  before: boolean;
  /** 本轮之后是否存在 */
  after: boolean;
  hunks: WorkspaceDiffHunk[];
  /** true = 行级对比不可用，只有整体替换 */
  coarse: boolean;
}

export interface WorkspaceFileDiffOpaque {
  kind: 'binary' | 'oversized';
  path: string;
  display: string;
}

export type WorkspaceFileDiff = WorkspaceFileDiffText | WorkspaceFileDiffOpaque;
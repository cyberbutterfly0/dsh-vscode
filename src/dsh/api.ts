/**
 * dsh 的 typed 客户端封装：一个方法一个 Remote 端点，args 形状与各
 * `@deepseek-ai/dsh-xxx` 包的 lib/typert.remote-client.d.ts 里 TypertRemoteMethod 一致。
 *
 * 约定（来自 typert）：`session/list` 用 `{ _request }`，其余一律包一层 `{ request }`；
 * 无参端点（modelCatalog / permissionPresets catalog / agentPresets list）用 `{}`。
 */

import type { UnaryClient } from './rpc';
import type {
  ModelCatalog,
  SessionAddress,
  SessionSummary,
  PromptContentPart,
  SessionWireEvent,
  PermissionCatalog,
  PermissionSelection,
  AskUserQuestionAnswer,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from './types';

export interface SessionListItem extends SessionSummary {
  [k: string]: unknown;
}

export interface SessionListValue {
  items: SessionListItem[];
  cursor?: string;
  [k: string]: unknown;
}

export interface SessionPageValue {
  events: SessionWireEvent[];
  hasMore: boolean;
  cursor?: string | null;
  [k: string]: unknown;
}

export interface SessionPageRequest {
  address: SessionAddress;
  /** 锚点：从这一 seq 往前取 */
  throughSeq?: number;
  beforeSeq?: number;
  maxMessages?: number;
  turnWindow?: number;
}

export interface SessionCreateRequest {
  cwd?: string;
  workspaceId?: string;
  sessionId?: string;
  agentPreset?: string;
}

export interface SessionPromptRequest {
  requestId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  content: PromptContentPart[];
  clientTimeZone?: string;
}

export interface SessionSelectModelRequest {
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface CommandsExecuteRequest {
  agentId: string;
  line: string;
  submittedAttachments: unknown[];
}

export interface CommandExecutionValue {
  commandId: string;
  result?: { kind: 'success' | 'error'; text?: string };
}

export interface EventsOutcome {
  /** `next` = 跳过这条（不回答，直接交给下一个处理者） */
  kind: 'result' | 'next';
  value?: unknown;
}

export interface EventsResultRequest {
  clientId: string;
  eventId: string;
  outcome: EventsOutcome;
}

export class DshApi {
  constructor(private readonly rpc: UnaryClient) {}

  // ── 会话 ────────────────────────────────────────────────────────────────

  sessionList(cursor?: string): Promise<SessionListValue> {
    return this.rpc.call<SessionListValue>('session/list', { _request: cursor ? { cursor } : {} });
  }

  sessionCreate(request: SessionCreateRequest): Promise<{ sessionId: string } & Record<string, unknown>> {
    return this.rpc.call('session/create', { request });
  }

  /** 往上翻历史。注意：**没有顶层 sessionId**，会话靠 `address` 定位。 */
  sessionPage(request: SessionPageRequest): Promise<SessionPageValue> {
    return this.rpc.call<SessionPageValue>('session/page', { request });
  }

  sessionPrompt(request: SessionPromptRequest): Promise<{ accepted?: boolean } & Record<string, unknown>> {
    return this.rpc.call('session/prompt', { request });
  }

  sessionCancel(request: { sessionId: string }): Promise<unknown> {
    return this.rpc.call('session/cancel', { request });
  }

  sessionRename(request: { sessionId: string; title: string }): Promise<unknown> {
    return this.rpc.call('session/rename', { request });
  }

  sessionFork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string } & Record<string, unknown>> {
    return this.rpc.call('session/fork', { request });
  }

  sessionProjections(request: { sessionId: string }): Promise<{ projections: Record<string, unknown> }> {
    return this.rpc.call('session/projections', { request });
  }

  sessionSelectModel(request: SessionSelectModelRequest): Promise<unknown> {
    return this.rpc.call('session/selectModel', { request });
  }

  sessionUpdateQueue(request: {
    sessionId: string;
    action: string;
    [k: string]: unknown;
  }): Promise<unknown> {
    return this.rpc.call('session/updateQueue', { request });
  }

  modelCatalog(): Promise<ModelCatalog> {
    return this.rpc.call<ModelCatalog>('session/modelCatalog', {});
  }

  // ── 权限 ────────────────────────────────────────────────────────────────

  permissionCatalog(): Promise<PermissionCatalog> {
    return this.rpc.call<PermissionCatalog>('permissionPresets/catalog', {});
  }

  // 切权限档**没有**专用端点（`session/permission` 不存在）。
  // 正确做法：`commands/execute` 发 `/permission <preset>`，档名只能是
  // read-only / workspace-write / danger-full-access / auto；
  // 真实状态变化从 follow 流的 permission/preset + sandbox/mode + approval/policy 事件里看。

  /** 执行一条斜杠命令（/permission、/plan、/goal…）。返回 commandId，副作用全走事件流。 */
  commandsExecute(request: CommandsExecuteRequest): Promise<CommandExecutionValue> {
    return this.rpc.call<CommandExecutionValue>('commands/execute', { ...request });
  }

  // ── $events：审批 / 提问的回送通道 ───────────────────────────────────────

  /**
   * 回送一次 waterfall 请求的结果。
   * approval 的 outcome.value 是 `'allowed-once'` / `'rejected'`；
   * 提问的 outcome.value 是 `{answers:[{id, selected:[…], custom?}]}`。
   */
  eventsResult(request: EventsResultRequest): Promise<unknown> {
    return this.rpc.call('$events/result', { ...request });
  }

  // ── 提问（审批卡片 / ask_user_question）─────────────────────────────────

  answerQuestion(agentId: string, callId: string, answer: AskUserQuestionAnswer): Promise<boolean> {
    return this.rpc.call<boolean>('userQuestions/answer', { agentId, callId, answer });
  }

  // ── 杂项 ────────────────────────────────────────────────────────────────

  skillsList(request: { sessionId: string }): Promise<unknown> {
    return this.rpc.call('skills/list', { request });
  }

  commandsList(agentId: string): Promise<unknown> {
    return this.rpc.call('commands/list', { agentId });
  }

  agentPresetsList(): Promise<unknown> {
    return this.rpc.call('agentPresets/list', {});
  }

  settingsDescribe(): Promise<unknown> {
    return this.rpc.call('settings/describe', {});
  }

  /** 逃生口：新端点 / 形状不确定的实验调用。 */
  raw<K = unknown>(endpoint: string, args: unknown): Promise<K> {
    return this.rpc.call<K>(endpoint, args as Record<string, unknown>);
  }

  // ── 改动可视化（普通 GET 路由，不是 typert RPC）─────────────────────────
  //
  // session 事件 `workspace/changes` 的 payload 只有 `{turn}`，真正摘要留在 Host，
  // 必须拿该事件的 seq 去这两个路由取。两者都在 connection 鉴权 fence 里。

  /** 某个 `workspace/changes` 事件（按 seq）公布的改动汇总。 */
  changesSummary(sessionId: string, seq: number): Promise<WorkspaceChangesSummary> {
    return this.rpc.getJson<WorkspaceChangesSummary>('/api/changes.summary', { sessionId, seq });
  }

  /** 汇总里第 index 个文件的本轮前后对比。 */
  changesDiff(sessionId: string, seq: number, index: number): Promise<WorkspaceFileDiff> {
    return this.rpc.getJson<WorkspaceFileDiff>('/api/changes.diff', { sessionId, seq, index });
  }
}

export type { PermissionSelection, PermissionCatalog };

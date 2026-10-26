/**
 * 会话核心：所有业务逻辑都在这里，**不 import vscode**。
 *
 * 这样同一份代码能在 node 下跑 smoke 测试（scripts/smoke.mjs），
 * vscode 胶水只剩 controller.ts 里那点薄壳。
 *
 * 对外只有一个出口：`post(msg)` 把 HostToWeb 消息发给 webview。
 */

import { DshConnection, type ConnectMode } from '../dsh/client';
import type { Logger } from '../log';
import type {
  HostToWeb,
  UiAsk,
  UiCatalog,
  UiPermissionPreset,
  UiSessionRow,
  UiUsage,
  WebToHost,
} from '../protocol';
import type {
  AskUserQuestionItem,
  AssistantStreamBaseline,
  AssistantStreamFrame,
  JsonValue,
  ModelSelection,
  SessionFollowFrame,
  SessionWireEvent,
} from '../dsh/types';

export interface CoreConfig {
  mode: ConnectMode;
  attachUrl: string;
  cliPath: string;
  extraSpawnArgs: string[];
  autoStart: boolean;
  defaultCwd: string;
  defaultPermission: string;
  sendWorkspaceContext: boolean;
}

export interface CoreOptions {
  config: CoreConfig;
  logger: Logger;
  post: (msg: HostToWeb) => void;
  /** tab 标题跟着会话标题变 */
  onTitle?: (title: string) => void;
  /** 会话切换（外部命令要跟着改 tab） */
  onSessionChanged?: (sessionId: string | undefined, title: string | undefined) => void;
  /** 需要弹出输入 token 的框 */
  requestToken?: (reason: 'no-token' | 'expired') => void;
  version: string;
}

const PAGE_SIZE = 60;
const SESSIONS_REFRESH_MS = 20000;

export class SessionCore {
  private conn: DshConnection | undefined;
  private sessions: UiSessionRow[] = [];
  private catalog: UiCatalog | undefined;
  private permissions: UiPermissionPreset[] = [];
  private currentPermissionValue: string | undefined;
  private sessionId: string | undefined;
  private sessionTitle: string | undefined;
  private sessionCwd: string | undefined;
  private running = false;
  private asks = new Map<string, UiAsk>();
  private projections: Record<string, JsonValue> = {};
  private followHandle: { close(): void } | undefined;
  private controlHandle: { close(): void } | undefined;
  private eventsHandle: { close(): void } | undefined;
  /** `$events` 握手后下发的客户端 id，回送审批/回答时必须带上 */
  private clientId: string | undefined;
  /** askId(eventId) → 回送时需要的上下文 */
  private askCtx = new Map<
    string,
    { kind: 'approval' | 'question'; sessionId?: string; questions?: AskUserQuestionItem[] }
  >();
  private earliestSeq = 0;
  private hasMore = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private pendingUsage: UiUsage = {};
  /** 最近一次 assistant-stream baseline，重连后要清 */
  private activeAttempt: string | undefined;
  private connecting: Promise<void> | undefined;

  constructor(private readonly opts: CoreOptions) {}

  get state() {
    return {
      connected: !!this.conn,
      authority: this.conn?.authority,
      sessionId: this.sessionId,
      title: this.sessionTitle,
      running: this.running,
      sessions: this.sessions,
      cwd: this.sessionCwd ?? this.opts.config.defaultCwd,
    };
  }

  get currentPermission(): string | undefined {
    return this.currentPermissionValue;
  }

  get permissionPresets(): UiPermissionPreset[] {
    return this.permissions;
  }

  /** 命令面板用：扁平化成 QuickPick 条目 */
  modelCatalogForPicker(): { options: { label: string; description: string; selection: ModelSelection }[] } {
    const options: { label: string; description: string; selection: ModelSelection }[] = [];
    const currentSel = this.catalog?.default;
    for (const g of this.catalog?.groups ?? []) {
      for (const m of g.models) {
        const efforts = m.efforts.length ? m.efforts : [{ id: '', name: '默认' }];
        for (const e of efforts) {
          const effort = e.id || m.defaultEffort || '';
          const isCurrent = currentSel?.model === m.id && (currentSel?.reasoningEffort ?? '') === effort;
          options.push({
            label: `${g.name} / ${m.name}${efforts.length > 1 && e.id ? ` (${e.name})` : ''}`,
            description: [isCurrent ? '当前' : '', g.id].filter(Boolean).join(' · '),
            selection: {
              provider: currentSel?.provider ?? 'deepseek-official',
              model: m.id,
              ...(effort ? { reasoningEffort: effort } : {}),
            },
          });
        }
      }
    }
    return { options };
  }

  get fullUiUrl(): string | undefined {
    return this.conn?.launchUrl;
  }

  /** 当前会话 cwd（改动文件里的相对路径要基于它解析）。 */
  get cwd(): string | undefined {
    return this.sessionCwd;
  }

  get cookie(): string | undefined {
    return this.conn?.cookie;
  }

  get authority(): string | undefined {
    return this.conn?.authority;
  }

  // ── 连接 ────────────────────────────────────────────────────────────────

  /** webview 重新挂载（或从隐藏恢复）时重放一次完整 init */
  requestInit(): void {
    if (this.conn) this.postInit();
  }

  /** 配置项变更：只影响下一次连接，不打断当前会话 */
  applyConfig(patch: Partial<CoreConfig>): void {
    Object.assign(this.opts.config, patch);
    this.opts.logger('debug', '配置已更新', JSON.stringify(patch));
  }

  async connect(opts?: { force?: boolean; attachUrl?: string; mode?: ConnectMode }): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect(opts).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(opts?: { force?: boolean; attachUrl?: string; mode?: ConnectMode }): Promise<void> {
    if (this.conn) {
      if (!opts?.force) return;
      await this.conn.dispose({ killRuntime: true });
      this.conn = undefined;
    }
    const cfg = this.opts.config;
    const mode = opts?.mode ?? cfg.mode;
    const attachUrl = opts?.attachUrl ?? cfg.attachUrl;
    this.opts.logger('info', `连接 dsh（mode=${mode}）`);
    try {
      const { connection, result } = await DshConnection.open({
        mode,
        attachUrl: attachUrl || undefined,
        cliPath: cfg.cliPath || undefined,
        extraSpawnArgs: cfg.extraSpawnArgs,
        logger: this.opts.logger,
        onMuxState: (state, detail) => {
          if (state === 'reconnecting') {
            this.opts.post({ type: 'status', connected: false, running: this.running, detail });
          } else if (state === 'closed') {
            this.opts.post({ type: 'status', connected: false, running: false, detail });
            this.opts.post({ type: 'auth-needed', reason: 'disconnected', authority: this.conn?.authority });
          }
        },
      });
      this.conn = connection;
      this.opts.logger('info', `已连接 ${result.authority}（${result.origin}${result.reusedCredential ? '，复用凭据' : ''}）`);
      this.openGlobalStreams();
      await this.loadCatalogs();
      await this.refreshSessions();
      this.startSessionRefresh();
      this.postInit();
      // 没有当前会话就连最近一个，方便开箱即用
      if (!this.sessionId) {
        const first = this.sessions[0];
        if (first && !first.blank) await this.openSession(first.sessionId);
      }
    } catch (e) {
      const err = e as Error;
      this.opts.logger('error', `连接失败: ${err.message}`);
      if (/握手失败 409/.test(err.message)) {
        this.opts.post({
          type: 'notice',
          level: 'warn',
          text: '另一个窗口正在使用这条 dsh 连接（一个 token 只能有一处连着）。关掉那个窗口，或点「重试连接」把连接抢过来。',
        });
      } else {
        this.opts.post({ type: 'auth-needed', reason: 'no-token' });
        this.opts.post({ type: 'notice', level: 'error', text: `连接 dsh 失败：${err.message}` });
      }
      throw e;
    }
  }

  private postInit(): void {
    this.opts.post({
      type: 'init',
      state: {
        connected: !!this.conn,
        authority: this.conn?.authority,
        cwd: this.sessionCwd ?? this.opts.config.defaultCwd,
        sessionId: this.sessionId,
        sessionTitle: this.sessionTitle,
        sessions: this.sessions,
        catalog: this.catalog,
        selection: this.catalog?.default,
        permissions: { current: this.currentPermissionValue, presets: this.permissions },
        defaultPermission: this.opts.config.defaultPermission || undefined,
        running: this.running,
        asks: [...this.asks.values()],
        version: this.opts.version,
      },
    });
  }

  private postSessions(): void {
    this.opts.post({ type: 'sessions', sessions: this.sessions });
  }

  // ── 目录 ────────────────────────────────────────────────────────────────

  private async loadCatalogs(): Promise<void> {
    if (!this.conn) return;
    try {
      const cat = await this.conn.api.modelCatalog();
      this.catalog = {
        default: cat.default,
        groups: (cat.groups ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          models: (g.models ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            efforts: (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id, name: e.name, description: e.description })),
            defaultEffort: m.reasoning?.defaultEffort,
          })),
        })),
        failures: (cat.failures ?? []).map((f) => ({ name: f.name, message: f.message })),
      };
    } catch (e) {
      this.opts.logger('warn', '拉模型目录失败', (e as Error).message);
    }
    try {
      const pc = await this.conn.api.permissionCatalog();
      this.permissions = (pc.options ?? []).map((o) => ({ id: o.value, name: o.name, description: o.description }));
      if (!this.currentPermissionValue) this.currentPermissionValue = pc.defaultPreset;
    } catch (e) {
      this.opts.logger('warn', '拉权限目录失败', (e as Error).message);
      // 目录端点不通时给三档兜底，别让 UI 空着
      this.permissions = [
        { id: 'read-only', name: '只读' },
        { id: 'workspace-write', name: '工作区可写' },
        { id: 'danger-full-access', name: '完全访问' },
        { id: 'auto', name: '自动' },
      ];
    }
    if (this.catalog) this.opts.post({ type: 'models', catalog: this.catalog, selection: this.catalog.default });
    this.opts.post({ type: 'permissions', current: this.currentPermissionValue, presets: this.permissions });
  }

  async refreshSessions(): Promise<void> {
    if (!this.conn || this.disposed) return;
    try {
      const page = await this.conn.api.sessionList();
      const rows: UiSessionRow[] = (page.items ?? []).map((it) => ({
        sessionId: it.sessionId,
        title: titleOf(it.projections?.values) || fallbackTitle(it),
        running: !!it.running,
        blank: !!it.blank,
        updatedAt: it.updatedAt,
        cwd: it.cwd ?? strOf(it.projections?.values?.workingDirectory),
        parentSessionId: it.parentSessionId,
        active: it.sessionId === this.sessionId,
      }));
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      this.sessions = rows;
      this.postSessions();
    } catch (e) {
      if (!this.disposed) this.opts.logger('warn', '刷新会话列表失败', (e as Error).message);
    }
  }

  private startSessionRefresh(): void {
    this.stopSessionRefresh();
    this.refreshTimer = setInterval(() => void this.refreshSessions(), SESSIONS_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  private stopSessionRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  // ── 会话 ────────────────────────────────────────────────────────────────

  async newSession(cwd?: string): Promise<void> {
    if (!this.conn) throw new Error('还没连上 dsh');
    const dir = cwd || this.opts.config.defaultCwd;
    const created = await this.conn.api.sessionCreate(dir ? { cwd: dir } : {});
    const id = (created.sessionId as string) || '';
    if (!id) throw new Error('session/create 没返回 sessionId');
    this.opts.logger('info', `新建会话 ${id} cwd=${dir || '(默认)'}`);
    await this.refreshSessions();
    await this.openSession(id);
  }

  async openSession(sessionId: string): Promise<void> {
    if (!this.conn) throw new Error('还没连上 dsh');
    if (this.sessionId === sessionId) return;
    this.closeFollow();
    // 保险：全局流万一早先被关掉过，这里补开，否则审批/投影收不到
    if (!this.eventsHandle || !this.controlHandle) this.openGlobalStreams();
    this.sessionId = sessionId;
    this.sessionTitle = undefined;
    this.projections = {};
    this.pendingUsage = {};
    this.activeAttempt = undefined;
    this.asks.clear();
    this.earliestSeq = 0;
    this.hasMore = false;
    this.running = false;

    const conn = this.conn;
    this.followHandle = conn.follow(sessionId, {
      onValue: (value) => this.onFollowFrame(value as unknown as SessionFollowFrame),
      onError: (err) => {
        this.opts.logger('error', `follow 出错 ${err.code}`, err.message);
        this.opts.post({ type: 'notice', level: 'error', text: `订阅会话失败：${err.message}` });
      },
      onReopen: () => {
        this.opts.logger('info', 'follow 流重连，丢弃增量等新快照');
        this.activeAttempt = undefined;
        this.opts.post({ type: 'reset' });
      },
      onEnd: () => this.opts.logger('debug', 'follow 流结束'),
    });

    // 全局流（投影 baseline + $events）在 connect 时已经开好，这里只管 follow
    this.refreshSessions();
    this.opts.onSessionChanged?.(sessionId, this.sessionTitle);
  }

  private closeStreams(): void {
    this.closeFollow();
    this.controlHandle?.close();
    this.controlHandle = undefined;
    this.eventsHandle?.close();
    this.eventsHandle = undefined;
    this.clientId = undefined;
  }

  /**
   * 只关会话级的 follow 流。
   * 全局的 `session/control`（投影）和 `$events`（审批/提问）是连接级的，
   * 换会话时**绝不能**跟着断——断了就再也收不到 approval/request。
   */
  private closeFollow(): void {
    this.followHandle?.close();
    this.followHandle = undefined;
  }

  /**
   * 只重开 follow（不动全局流）。用于 writer-held 之类的临时占用：
   * 关掉旧句柄再开，等于把会话的写句柄让出去再要回来。
   */
  private async reopenFollow(): Promise<void> {
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (!conn || !sessionId) return;
    this.followHandle?.close();
    this.followHandle = undefined;
    await new Promise((r) => setTimeout(r, 250));
    this.followHandle = conn.follow(sessionId, {
      onValue: (value) => this.onFollowFrame(value as unknown as SessionFollowFrame),
      onError: (err) => this.opts.logger('warn', `follow 出错 ${err.code}`, err.message),
      onReopen: () => {
        this.activeAttempt = undefined;
        this.opts.post({ type: 'reset' });
      },
      onEnd: () => this.opts.logger('debug', 'follow 流结束'),
    });
  }

  // ── 全局流：投影 baseline + $events ──────────────────────────────────────

  /** 连上之后立刻开两条全局流，跟当前看哪个会话无关。 */
  private openGlobalStreams(): void {
    const conn = this.conn;
    if (!conn) return;
    this.controlHandle?.close();
    this.eventsHandle?.close();
    this.controlHandle = conn.control({
      onValue: (value) => this.onControlFrame(value as unknown as JsonValue),
      onReopen: () => this.opts.logger('debug', 'control 流重连'),
      onError: (err) => this.opts.logger('warn', `control 出错 ${err.code}`, err.message),
    });
    this.eventsHandle = conn.events({
      onValue: (value) => this.onEventsFrame(value as unknown as JsonValue),
      onReopen: () => this.opts.logger('debug', '$events 流重连'),
      onError: (err) => this.opts.logger('warn', `$events 出错 ${err.code}`, err.message),
    });
  }

  /**
   * `$events` 帧。审批和提问**只从这里来**（follow 事件和投影里都没有）。
   * - ready:      {clientId, host}            → 记下 clientId，回送时要用
   * - emit:       {event:'api-session/status'|'api-session/activity', args:[…]}
   * - waterfall:  {event:'approval/request'|'user-questions/request', eventId, agentId, request}
   * - cancel:     {eventId}                   → 这条请求被别处处理/超时了，收卡片
   */
  private onEventsFrame(value: JsonValue): void {
    if (!value || typeof value !== 'object') return;
    const v = value as {
      type?: string;
      clientId?: string;
      event?: string;
      args?: JsonValue[];
      eventId?: string;
      agentId?: string;
      request?: JsonValue;
    };

    if (v.type === 'ready') {
      this.clientId = v.clientId;
      this.opts.logger('debug', `$events 就绪 clientId=${v.clientId}`);
      return;
    }

    // 未知/未处理的帧也留痕，排查时不用猜
    if (v.type === 'waterfall') {
      this.opts.logger('debug', `$events waterfall event=${v.event} eventId=${v.eventId}`);
    } else if (v.type !== 'emit') {
      this.opts.logger('debug', `$events 帧 ${v.type} event=${v.event ?? ''}`);
    }

    if (v.type === 'emit') {
      // 所有 emit 都留一行：排查「审批/提问到底有没有推过来」时靠它
      this.opts.logger('debug', `$events emit ${v.event ?? ''}`);
      if (v.event === 'api-session/status') {
        const args = (v.args ?? []) as [string, boolean];
        const sid = args[0];
        const running = !!args[1];
        // 只跟当前会话的 running 走；别的会话不干扰状态条
        if (sid && sid !== this.sessionId) return;
        if (this.running === running) return;
        this.running = running;
        this.opts.post({ type: 'status', connected: true, running });
        if (!running) this.postUsage();
      }
      return;
    }

    if (v.type === 'cancel' && v.eventId) {
      this.dropAsk(v.eventId);
      return;
    }

    if (v.type === 'waterfall' && v.eventId) {
      if (v.event === 'approval/request') {
        this.pushApprovalAsk(v.eventId, v.agentId, (v.request ?? {}) as ApprovalRequest);
      } else if (v.event === 'user-questions/request') {
        this.pushQuestionAsk(v.eventId, v.agentId, (v.request ?? {}) as { questions?: AskUserQuestionItem[] });
      }
    }
  }

  private pushApprovalAsk(eventId: string, agentId: string | undefined, req: ApprovalRequest): void {
    const ask: UiAsk = {
      id: eventId,
      kind: 'approval',
      title: req.toolName ? `需要审批：${req.toolName}` : '需要审批',
      body: req.displayReason?.zh || req.reason || '这个操作被权限策略拦住了。',
      detail: req.callId ? `callId: ${req.callId}` : undefined,
      options: [
        { id: 'allowed-once', label: '允许一次' },
        { id: 'rejected', label: '拒绝', destructive: true },
      ],
      createdAt: Date.now(),
    };
    this.asks.set(eventId, ask);
    this.askCtx.set(eventId, { kind: 'approval', sessionId: agentId });
    this.opts.post({ type: 'ask', ask });
  }

  private pushQuestionAsk(
    eventId: string,
    agentId: string | undefined,
    req: { questions?: AskUserQuestionItem[] },
  ): void {
    const qs = req?.questions ?? [];
    const first = qs[0];
    if (!first) {
      this.opts.logger('warn', '收到空的 user-questions 请求，忽略');
      return;
    }
    const ask: UiAsk = {
      id: eventId,
      kind: 'question',
      title: first.header || '需要你确认',
      body: first.question,
      detail: first.detail,
      options: (first.options ?? []).map((o, i) => ({ id: `opt-${i}`, label: o.label, description: o.description })),
      multiSelect: !!first.multiSelect,
      createdAt: Date.now(),
    };
    this.asks.set(eventId, ask);
    this.askCtx.set(eventId, { kind: 'question', sessionId: agentId, questions: qs });
    this.opts.post({ type: 'ask', ask });
  }

  private dropAsk(id: string): void {
    if (!this.asks.delete(id)) return;
    this.askCtx.delete(id);
    this.opts.post({ type: 'ask-close', id });
  }

  private onFollowFrame(frame: SessionFollowFrame): void {
    if (!frame || typeof frame !== 'object') return;
    const type = (frame as { type?: string }).type;
    if (type === 'snapshot') {
      const snap = frame as Extract<SessionFollowFrame, { type: 'snapshot' }>;
      this.projections = snap.projections?.values ?? {};
      this.currentPermissionValue = this.permissionOf(this.projections);
      this.sessionCwd = snap.header?.cwd ?? this.sessionCwd;
      const title = titleOf(this.projections);
      if (title) this.setTitle(title);
      const records = snap.records ?? [];
      this.earliestSeq = minSeq(records);
      this.hasMore = !!snap.hasMore;
      this.applyAssistantBaseline(snap.assistantStream);
      this.opts.post({
        type: 'open',
        sessionId: this.sessionId ?? '',
        title: this.sessionTitle,
        header: snap.header,
        records,
        projections: snap.projections,
        hasMore: this.hasMore,
        assistantStream: snap.assistantStream,
      });
      this.opts.post({ type: 'permissions', current: this.currentPermissionValue, presets: this.permissions });
      this.postUsage();
      // 历史回放：把这段记录里最后一条 workspace/changes 的改动卡片也补出来
      // （records 里只带事件本身，摘要得再拉一次）
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const ev = records[i]?.event;
        if (ev?.type === 'workspace/changes') {
          void this.loadChanges(ev.seq);
          break;
        }
      }
      return;
    }
    if (type === 'event') {
      const ev = (frame as { event: SessionWireEvent }).event;
      if (!ev) return;
      this.earliestSeq = this.earliestSeq === 0 ? ev.seq : Math.min(this.earliestSeq, ev.seq);
      this.onSessionEvent(ev);
      this.opts.post({ type: 'event', event: ev });
      return;
    }
    if (type === 'assistant-stream') {
      const frameInner = (frame as { frame: AssistantStreamFrame }).frame;
      if (frameInner) this.onAssistantFrame(frameInner);
    }
  }

  private onSessionEvent(ev: SessionWireEvent): void {
    switch (ev.type) {
      case 'session/title': {
        const d = ev.data as { title?: string } | undefined;
        if (d?.title) this.setTitle(d.title);
        break;
      }
      case 'turn/start':
        this.running = true;
        this.opts.post({ type: 'status', connected: true, running: true });
        break;
      case 'turn/end':
        this.running = false;
        this.opts.post({ type: 'status', connected: true, running: false });
        this.postUsage();
        void this.refreshSessions();
        break;
      case 'permission/preset': {
        const cur = this.permissionOf({ permissions: ev.data as JsonValue });
        if (cur) {
          this.currentPermissionValue = cur;
          this.opts.post({ type: 'permissions', current: cur, presets: this.permissions });
        }
        break;
      }
      case 'usage': {
        const u = ev.data as Partial<UiUsage> | undefined;
        if (u) {
          this.pendingUsage = { ...this.pendingUsage, ...u };
          this.postUsage();
        }
        break;
      }
      case 'workspace/changes':
        // payload 只有 {turn}；摘要得拿这条事件的 seq 去 /api/changes.summary 取
        void this.loadChanges(ev.seq);
        break;
      default:
        break;
    }
  }

  /**
   * 取某一轮的改动汇总并推给 webview。
   * 失败不吵：这条链是锦上添花，拿不到就不显示卡片。
   */
  private async loadChanges(seq: number): Promise<void> {
    const conn = this.conn;
    const sessionId = this.sessionId;
    if (!conn || !sessionId) return;
    try {
      const summary = await conn.api.changesSummary(sessionId, seq);
      if (this.sessionId !== sessionId) return;
      this.opts.post({
        type: 'changes',
        changes: {
          sessionId,
          seq,
          turn: summary.turn,
          total: summary.total,
          added: summary.added,
          deleted: summary.deleted,
          files: (summary.files ?? []).map((f, index) => ({
            index,
            path: f.path,
            display: f.display,
            added: f.added,
            deleted: f.deleted,
            binary: f.binary === true,
            oversized: f.oversized === true,
          })),
        },
      });
    } catch (e) {
      this.opts.logger('debug', `取改动汇总失败 seq=${seq}`, (e as Error).message);
    }
  }

  /** webview 点开某个文件时取它的对比。 */
  async loadDiff(sessionId: string, seq: number, index: number): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    try {
      const diff = await conn.api.changesDiff(sessionId, seq, index);
      if (this.sessionId !== sessionId) return;
      if (diff.kind === 'text') {
        this.opts.post({
          type: 'diff',
          diff: {
            sessionId,
            seq,
            index,
            kind: 'text',
            path: diff.path,
            display: diff.display,
            before: diff.before,
            after: diff.after,
            hunks: diff.hunks ?? [],
            coarse: diff.coarse === true,
          },
        });
      } else {
        this.opts.post({
          type: 'diff',
          diff: { sessionId, seq, index, kind: diff.kind, path: diff.path, display: diff.display },
        });
      }
    } catch (e) {
      this.opts.logger('warn', `取文件对比失败 ${index}`, (e as Error).message);
      this.opts.post({ type: 'notice', level: 'warn', text: `取不到这个文件的改动：${(e as Error).message}` });
    }
  }

  private onAssistantFrame(frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.activeAttempt = frame.attemptId;
      this.running = true;
    } else if (frame.type === 'end') {
      this.activeAttempt = undefined;
      if (frame.outcome?.kind === 'abandoned') this.opts.post({ type: 'reset' });
    } else if (frame.type === 'chunk' && frame.chunk?.type === 'usage') {
      this.pendingUsage = { ...this.pendingUsage, ...frame.chunk.usage };
      this.postUsage();
    }
    this.opts.post({ type: 'stream', frame });
  }

  private applyAssistantBaseline(baseline: AssistantStreamBaseline | undefined): void {
    this.activeAttempt = baseline?.activeAttempt?.attemptId;
    if (baseline?.activeAttempt) {
      const u = lastUsage(baseline.activeAttempt.stream);
      if (u) this.pendingUsage = { ...this.pendingUsage, ...u };
    }
  }

  private onControlFrame(value: JsonValue): void {
    if (!value || typeof value !== 'object') return;
    const v = value as { type?: string; value?: JsonValue; projections?: JsonValue; key?: string; sessionId?: string };
    if (v.type === 'baseline') {
      // {projections: {<sessionId>: {asOfSeq, values}}} 或 {values}
      const holder = v.value as { projections?: Record<string, { values?: Record<string, JsonValue> }> } | undefined;
      const all = holder?.projections;
      if (all && this.sessionId && all[this.sessionId]?.values) {
        this.projections = all[this.sessionId].values ?? {};
        this.currentPermissionValue = this.permissionOf(this.projections);
        this.opts.post({ type: 'projections', values: this.projections });
        this.opts.post({ type: 'permissions', current: this.currentPermissionValue, presets: this.permissions });
        this.postUsage();
      }
      return;
    }
    if (v.type === 'projection' && v.key) {
      if (v.sessionId && v.sessionId !== this.sessionId) return;
      this.projections = { ...this.projections, [v.key]: v.value as JsonValue };
      if (v.key === 'title' && typeof v.value === 'string') this.setTitle(v.value);
      if (v.key === 'permissions') {
        this.currentPermissionValue = this.permissionOf(this.projections);
        this.opts.post({ type: 'permissions', current: this.currentPermissionValue, presets: this.permissions });
      }
      if (v.key === 'tokenUsage' || v.key === 'contextPressure') this.postUsage();
      this.opts.post({ type: 'projections', values: this.projections });
    }
  }

  private permissionOf(values: Record<string, JsonValue> | { permissions?: JsonValue }): string | undefined {
    const cell = (values as Record<string, JsonValue>).permissions as { currentValue?: string } | undefined;
    return cell?.currentValue;
  }

  private postUsage(): void {
    const tu = this.projections.tokenUsage as
      | { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
    const cp = this.projections.contextPressure as
      | { pressureTokens?: number; contextWindow?: number; projectedTokens?: number }
      | undefined;
    const usage: UiUsage = {
      ...this.pendingUsage,
      ...(tu
        ? {
            inputTokens: tu.uncachedInputTokens,
            outputTokens: tu.outputTokens,
            cacheReadTokens: tu.cacheReadTokens,
            cacheWriteTokens: tu.cacheWriteTokens,
          }
        : {}),
      ...(cp ? { pressureTokens: cp.pressureTokens ?? cp.projectedTokens, contextWindow: cp.contextWindow } : {}),
    };
    this.opts.post({ type: 'usage', usage });
  }

  private setTitle(title: string): void {
    if (this.sessionTitle === title) return;
    this.sessionTitle = title;
    this.opts.post({ type: 'title', title });
    this.opts.onTitle?.(title);
    const row = this.sessions.find((s) => s.sessionId === this.sessionId);
    if (row) row.title = title;
    this.opts.onSessionChanged?.(this.sessionId, title);
  }

  // ── 发消息 ──────────────────────────────────────────────────────────────

  async sendPrompt(text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    if (!this.conn) throw new Error('还没连上 dsh');
    if (!this.sessionId) await this.newSession();
    const sessionId = this.sessionId as string;
    const body = text.trim();
    if (!body) return;
    const request = {
      requestId: `vsc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode,
      content: [{ type: 'text' as const, text: body }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    try {
      await this.conn.api.sessionPrompt(request);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (!/writer-held/i.test(err.message) && err.code !== 'session/writer-held') throw e;
      // 写句柄被别的连接占着（多半是上一个窗口/进程没退干净）。
      // 把本地 follow 关掉再重开一次，给服务端一个回收的机会，然后重试一次。
      this.opts.logger('warn', 'prompt 被 writer-held 拒，重开 follow 后重试一次');
      await this.reopenFollow();
      await new Promise((r) => setTimeout(r, 800));
      try {
        await this.conn.api.sessionPrompt(request);
      } catch (again) {
        // 还是被占：多半是这条会话在别的进程里留着写句柄（旧窗口/旧实例没退干净）。
        // 这条会话基本废了，直接告诉用户换新会话，别把线上英文原文甩到脸上。
        const detail = (again as Error).message;
        this.opts.logger('error', 'prompt 仍被 writer-held 拒', detail);
        throw new Error('这条会话被另一个窗口或进程占着写句柄，当前发不出去。新建一个会话继续（旧会话的内容不会丢）。');
      }
    }
    this.running = true;
    this.opts.post({ type: 'status', connected: true, running: true });
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    await this.conn.api.sessionCancel({ sessionId: this.sessionId });
  }

  async selectModel(selection: ModelSelection): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error('没有打开的会话');
    await this.conn.api.sessionSelectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    });
    this.opts.post({ type: 'models', catalog: this.catalog!, selection });
  }

  async setPermission(preset: string): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error('没有打开的会话');
    // 没有 session/permission 这种端点：权限档靠斜杠命令切
    const res = await this.conn.api.commandsExecute({
      agentId: this.sessionId,
      line: `/permission ${preset}`,
      submittedAttachments: [],
    });
    if (res.result?.kind === 'error') {
      throw new Error(res.result.text || `切到 ${preset} 失败`);
    }
    // 真实状态会由事件回写，这里先乐观更新一下让 UI 不闪
    this.currentPermissionValue = preset;
    this.opts.post({ type: 'permissions', current: preset, presets: this.permissions });
  }

  /**
   * 回送一次审批 / 提问。
   * webview 侧 value 约定：
   * - 审批：`'allowed-once'` 或 `'rejected'`（也可以直接发 boolean）
   * - 提问：`{selected: string[] | string, custom?: string}`，selected 里是选项 id（`opt-0`）或 label
   */
  async answerAsk(id: string, value: JsonValue): Promise<void> {
    if (!this.conn) throw new Error('还没连上 dsh');
    const clientId = this.clientId;
    if (!clientId) throw new Error('$events 还没握手完成，等一下再试');

    const ctx = this.askCtx.get(id);
    let outcomeValue: unknown;

    if (ctx?.kind === 'question') {
      const q = ctx.questions?.[0];
      const raw = value as unknown;
      const picked: string[] = Array.isArray(raw)
        ? raw.map(String)
        : raw && typeof raw === 'object' && Array.isArray((raw as { selected?: unknown }).selected)
          ? ((raw as { selected: unknown[] }).selected ?? []).map(String)
          : raw == null
            ? []
            : [String(raw)];
      const custom = raw && typeof raw === 'object' ? (raw as { custom?: string }).custom : undefined;
      // opt-N → 真实 label；已经是 label 的原样留着
      const selected = picked.map((pid) => {
        const m = /^opt-(\d+)$/.exec(pid);
        const label = m ? q?.options?.[Number(m[1])]?.label : undefined;
        return label ?? pid;
      });
      outcomeValue = { answers: [{ id: q?.id ?? 'q', selected, ...(custom ? { custom } : {}) }] };
    } else {
      outcomeValue = value === true || String(value) === 'allowed-once' ? 'allowed-once' : 'rejected';
    }

    await this.conn.api.eventsResult({
      clientId,
      eventId: id,
      outcome: { kind: 'result', value: outcomeValue },
    });
    this.asks.delete(id);
    this.askCtx.delete(id);
    this.opts.post({ type: 'ask-close', id });
  }

  /** 用户点了「忽略」：回一个 next，把这条请求让给别的处理者（没有就等超时）。 */
  dismissAsk(id: string): void {
    const clientId = this.clientId;
    if (this.conn && clientId) {
      void this.conn.api
        .eventsResult({ clientId, eventId: id, outcome: { kind: 'next' } })
        .catch((e: Error) => this.opts.logger('warn', '忽略请求失败', e.message));
    }
    this.dropAsk(id);
  }

  async loadOlder(): Promise<void> {
    if (!this.conn || !this.sessionId || !this.hasMore) return;
    const sid = this.sessionId;
    const page = await this.conn.api.sessionPage({
      address: { kind: 'session', sessionId: sid },
      beforeSeq: this.earliestSeq || undefined,
      maxMessages: PAGE_SIZE,
    });
    const records = (page.events ?? []).map((event) => ({ type: 'event' as const, event }));
    this.hasMore = !!page.hasMore;
    this.earliestSeq = minSeq(records, this.earliestSeq);
    this.opts.post({ type: 'records', records, prepend: true });
  }

  /** 命令面板用：执行任意斜杠命令（/plan、/goal…） */
  async runCommand(line: string): Promise<string> {
    if (!this.conn || !this.sessionId) throw new Error('没有打开的会话');
    const res = await this.conn.api.commandsExecute({
      agentId: this.sessionId,
      line,
      submittedAttachments: [],
    });
    return res.result?.text || res.result?.kind || '';
  }

  // ── 输入分发 ────────────────────────────────────────────────────────────

  /** webview 发来的消息里，跟 dsh 有关的那部分在这里处理；UI 相关的留给 controller。 */
  async handle(msg: WebToHost): Promise<boolean> {
    switch (msg.type) {
      case 'ready':
        this.postInit();
        // webview 重挂载（窗口重载、面板切走再回来）后本地消息全没了：
        // 重开 follow 拿一份新快照，把 open + records 重新发一遍。
        if (this.conn && this.sessionId) void this.reopenFollow();
        return true;
      case 'prompt':
        await this.sendPrompt(msg.text, msg.mode ?? 'queue');
        return true;
      case 'cancel':
        await this.cancel();
        return true;
      case 'new-session':
        await this.newSession(msg.cwd);
        return true;
      case 'open-session':
        await this.openSession(msg.sessionId);
        return true;
      case 'select-model':
        await this.selectModel(msg.selection);
        return true;
      case 'set-permission':
        await this.setPermission(msg.preset);
        return true;
      case 'load-older':
        await this.loadOlder();
        return true;
      case 'load-diff':
        await this.loadDiff(String(msg.sessionId), Number(msg.seq), Number(msg.index));
        return true;
      case 'answer':
        await this.answerAsk(String(msg.id), msg.value);
        return true;
      case 'cancel-ask':
        this.dismissAsk(String(msg.id));
        return true;
      case 'rename-session':
        if (this.conn) {
          await this.conn.api.sessionRename({ sessionId: msg.sessionId, title: msg.title });
          await this.refreshSessions();
        }
        return true;
      case 'reconnect':
        await this.connect({ force: true });
        return true;
      default:
        return false;
    }
  }

  /** 只断开，不杀 runtime 进程（用户可能还想在浏览器里用那个实例） */
  async disconnectOnly(): Promise<void> {
    this.stopSessionRefresh();
    this.closeStreams();
    await this.conn?.disconnect();
    this.conn = undefined;
    this.opts.post({ type: 'status', connected: false, running: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSessionRefresh();
    this.closeStreams();
    void this.conn?.disconnect();
    this.conn = undefined;
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** `$events` 里 approval/request 的 request 形状（实测） */
interface ApprovalRequest {
  toolName?: string;
  callId?: string;
  reason?: string;
  displayReason?: { en?: string; zh?: string };
  [k: string]: unknown;
}

function titleOf(values: Record<string, JsonValue> | undefined): string | undefined {
  if (!values) return undefined;
  const t = values.title;
  return typeof t === 'string' && t.trim() ? t : undefined;
}

function strOf(v: JsonValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function fallbackTitle(it: { sessionId: string; blank?: boolean; cwd?: string }): string {
  return it.blank ? '新会话' : it.sessionId.slice(0, 12);
}

function minSeq(records: { event?: { seq: number } }[], fallback = 0): number {
  let min = fallback;
  for (const r of records) {
    const seq = r.event?.seq;
    if (typeof seq !== 'number') continue;
    min = min === 0 ? seq : Math.min(min, seq);
  }
  return min;
}

function lastUsage(chunks: { type: string; usage?: UiUsage }[] | undefined): UiUsage | undefined {
  if (!chunks) return undefined;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    if (chunks[i].type === 'usage' && chunks[i].usage) return chunks[i].usage;
  }
  return undefined;
}



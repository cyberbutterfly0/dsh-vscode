/*
 * dsh × VS Code —— 开发预览假宿主（仅用于 media/preview.html，不进 VS Code）
 *
 * 作用：
 *   1. 在 chat.js 之前 stub 掉 acquireVsCodeApi()，把 webview 发出的消息记到
 *      window.__DSX_OUTBOX__ 并显示在左下角「发送日志」里；
 *   2. 造一套 VS Code 深/浅色主题变量（真实环境由 VS Code 注入），
 *      方便直接双击 preview.html 在浏览器里看效果；
 *   3. 用假的 HostToWeb 消息（init / open / event / stream / ask …）把每种
 *      组件都喂出来：消息流、流式、工具卡、审批/提问、待办、计划、用量条、
 *      空态、通知、错误。
 *
 * 用法：浏览器打开 media/preview.html，点顶部工具栏换场景。
 * 契约字段名与 src/protocol.ts、docs/render-spec.md 保持一致。
 */
(function () {
  'use strict';

  if (window.__DSX_FIXTURES__) return;
  window.__DSX_FIXTURES__ = true;

  // ═══════════════════════════ 1. 假容器 API ═══════════════════════════

  var outbox = [];
  window.__DSX_OUTBOX__ = outbox;

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        outbox.push(msg);
        renderOutbox();
      },
      getState: function () {
        return {};
      },
      setState: function () {}
    };
  };

  /** 发一条 HostToWeb 消息；走真实的 window.message 监听路径。 */
  function host(msg) {
    window.postMessage(msg, '*');
  }

  // ═══════════════════════════ 2. 预览外壳（主题 + 工具栏）═══════════════════════════

  var DARK_VARS = {
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-editor-foreground': '#cccccc',
    '--vscode-sideBar-background': '#181818',
    '--vscode-panel-border': '#2b2b2b',
    '--vscode-widget-border': '#313131',
    '--vscode-editorWidget-background': '#202020',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-disabledForeground': 'rgba(204, 204, 204, 0.5)',
    '--vscode-textLink-foreground': '#4daafc',
    '--vscode-textCodeBlock-background': '#2b2b2b',
    '--vscode-input-background': '#313131',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-border': 'transparent',
    '--vscode-input-placeholderForeground': '#989898',
    '--vscode-button-background': '#0078d4',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#026ec1',
    '--vscode-button-secondaryBackground': '#313131',
    '--vscode-button-secondaryForeground': '#cccccc',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-list-activeSelectionBackground': '#04395e',
    '--vscode-focusBorder': '#0078d4',
    '--vscode-errorForeground': '#f85149',
    '--vscode-editorWarning-foreground': '#cca700',
    '--vscode-testing-iconPassed': '#73c991',
    '--vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-purple': '#b180d7',
    '--vscode-charts-green': '#89d185',
    '--vscode-progressBar-background': '#0078d4',
    '--vscode-editor-selectionBackground': '#264f78',
    '--vscode-diffEditor-insertedTextBackground': 'rgba(70, 149, 74, 0.22)',
    '--vscode-diffEditor-removedTextBackground': 'rgba(229, 83, 75, 0.22)',
    '--vscode-inputValidation-errorBackground': 'rgba(248, 81, 73, 0.16)',
    '--vscode-font-family': "'Segoe UI', system-ui, -apple-system, sans-serif",
    '--vscode-editor-font-family': "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    '--vscode-font-size': '13px'
  };

  var LIGHT_VARS = {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#3b3b3b',
    '--vscode-sideBar-background': '#f8f8f8',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-widget-border': '#e5e5e5',
    '--vscode-editorWidget-background': '#f8f8f8',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-disabledForeground': 'rgba(97, 97, 97, 0.5)',
    '--vscode-textLink-foreground': '#006ab1',
    '--vscode-textCodeBlock-background': '#f2f2f2',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-border': '#cecece',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-button-background': '#005fb8',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0258a8',
    '--vscode-button-secondaryBackground': '#e5e5e5',
    '--vscode-button-secondaryForeground': '#3b3b3b',
    '--vscode-list-hoverBackground': '#f2f2f2',
    '--vscode-list-activeSelectionBackground': '#e8e8e8',
    '--vscode-focusBorder': '#005fb8',
    '--vscode-errorForeground': '#e51400',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-testing-iconPassed': '#388a34',
    '--vscode-scrollbarSlider-background': 'rgba(100, 100, 100, 0.3)',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.12)',
    '--vscode-charts-blue': '#006ab1',
    '--vscode-charts-purple': '#a01ea0',
    '--vscode-charts-green': '#388a34',
    '--vscode-progressBar-background': '#005fb8',
    '--vscode-editor-selectionBackground': '#add6ff',
    '--vscode-diffEditor-insertedTextBackground': 'rgba(156, 204, 156, 0.4)',
    '--vscode-diffEditor-removedTextBackground': 'rgba(255, 147, 147, 0.4)',
    '--vscode-inputValidation-errorBackground': 'rgba(229, 20, 0, 0.1)',
    '--vscode-font-family': "'Segoe UI', system-ui, -apple-system, sans-serif",
    '--vscode-editor-font-family': "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    '--vscode-font-size': '13px'
  };

  function varBlock(sel, vars) {
    var lines = [sel + ' {'];
    Object.keys(vars).forEach(function (k) {
      lines.push('  ' + k + ': ' + vars[k] + ';');
    });
    lines.push('}');
    return lines.join('\n');
  }

  var PREVIEW_CSS = [
    varBlock(':root', DARK_VARS),
    varBlock('html[data-theme="light"]', LIGHT_VARS),
    'html, body { margin: 0; height: 100%; overflow: hidden; }',
    '#dsx-root { position: fixed; top: 40px; left: 0; right: 0; bottom: 0; }',
    /* 让出顶部预览工具栏：真实 webview 里没有这一条 */
    ':root { --dsx-app-top: 40px; }',
    '#preview-bar {' +
      'position: fixed; top: 0; left: 0; right: 0; height: 40px; z-index: 1000;' +
      'display: flex; align-items: center; gap: 6px; padding: 0 10px;' +
      'box-sizing: border-box; overflow-x: auto; white-space: nowrap;' +
      'background: #252526; border-bottom: 1px solid #3c3c3c;' +
      'font: 12px/1.4 "Segoe UI", system-ui, sans-serif; color: #cccccc;' +
    '}',
    'html[data-theme="light"] #preview-bar { background: #f3f3f3; border-bottom-color: #dddddd; color: #3b3b3b; }',
    '#preview-bar .pv-brand { font-weight: 600; opacity: 0.85; margin-right: 4px; }',
    '#preview-bar button {' +
      'font: inherit; padding: 3px 9px; border-radius: 4px; cursor: pointer;' +
      'border: 1px solid #4a4a4a; background: #333333; color: inherit; line-height: 1.6;' +
    '}',
    'html[data-theme="light"] #preview-bar button { border-color: #cecece; background: #ffffff; }',
    '#preview-bar button:hover { background: #3f3f46; }',
    'html[data-theme="light"] #preview-bar button:hover { background: #e8e8e8; }',
    '#preview-bar button.is-active { background: #0078d4; border-color: #0078d4; color: #fff; }',
    '#preview-bar .pv-gap { flex: 1 1 auto; }',
    '#preview-sent {' +
      'position: fixed; left: 8px; bottom: 8px; z-index: 1000; width: 340px;' +
      'max-height: 168px; overflow: auto; padding: 6px 8px; box-sizing: border-box;' +
      'border: 1px solid #3c3c3c; border-radius: 4px; background: #1b1b1b;' +
      'font: 11px/1.45 "Cascadia Code", Consolas, monospace; color: #9d9d9d;' +
    '}',
    'html[data-theme="light"] #preview-sent { background: #f8f8f8; border-color: #dddddd; color: #616161; }',
    '#preview-sent[hidden] { display: none; }',
    '#preview-sent .pv-sent-hd { color: #6f9bd1; display: block; margin-bottom: 2px; }',
    '#preview-sent .pv-sent-row { white-space: pre-wrap; overflow-wrap: anywhere; }',
    '#preview-sent .pv-sent-row + .pv-sent-row { margin-top: 2px; }'
  ].join('\n');

  function injectStyle() {
    var style = document.createElement('style');
    style.id = 'preview-style';
    style.textContent = PREVIEW_CSS;
    document.head.appendChild(style);
  }

  var SCENARIOS = [
    { id: 'full', label: '完整会话', run: scenarioFull },
    { id: 'stream', label: '流式输出', run: scenarioStream },
    { id: 'asks', label: '审批 / 提问', run: scenarioAsks },
    { id: 'empty', label: '空态（未连接）', run: scenarioEmpty },
    { id: 'auth', label: '空态（未登录）', run: scenarioAuth },
    { id: 'error', label: '中断与错误', run: scenarioError },
    { id: 'queue', label: '排队 / 长历史', run: scenarioQueue },
    { id: 'changes', label: '改动卡片', run: scenarioChanges },
    { id: 'changes-open', label: '改动卡片-展开', run: scenarioChangesOpen }
  ];

  var bar = null;
  var sentBox = null;
  var activeBtn = null;

  function buildBar() {
    bar = document.createElement('div');
    bar.id = 'preview-bar';

    var brand = document.createElement('span');
    brand.className = 'pv-brand';
    brand.textContent = 'dsh chat 预览';
    bar.appendChild(brand);

    SCENARIOS.forEach(function (sc) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = sc.label;
      b.setAttribute('data-scenario', sc.id);
      b.addEventListener('click', function () {
        play(sc);
      });
      bar.appendChild(b);
    });

    var gap = document.createElement('span');
    gap.className = 'pv-gap';
    bar.appendChild(gap);

    var theme = document.createElement('button');
    theme.id = 'pv-theme';
    theme.type = 'button';
    theme.textContent = '浅色/深色';
    theme.addEventListener('click', function () {
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      if (light) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'light');
    });
    bar.appendChild(theme);

    var logBtn = document.createElement('button');
    logBtn.id = 'pv-log';
    logBtn.type = 'button';
    logBtn.textContent = '发送日志';
    logBtn.addEventListener('click', function () {
      sentBox.hidden = !sentBox.hidden;
    });
    bar.appendChild(logBtn);

    document.body.appendChild(bar);

    sentBox = document.createElement('div');
    sentBox.id = 'preview-sent';
    sentBox.hidden = true;
    document.body.appendChild(sentBox);
    renderOutbox();
  }

  var OUTBOX_SHOWN = 10;

  function renderOutbox() {
    if (!sentBox) return;
    sentBox.textContent = '';
    var hd = document.createElement('span');
    hd.className = 'pv-sent-hd';
    hd.textContent = 'webview → 扩展（共 ' + outbox.length + ' 条，显示最近 ' + OUTBOX_SHOWN + '）';
    sentBox.appendChild(hd);
    var start = Math.max(0, outbox.length - OUTBOX_SHOWN);
    for (var i = start; i < outbox.length; i++) {
      var row = document.createElement('span');
      row.className = 'pv-sent-row';
      var txt = '';
      try {
        txt = JSON.stringify(outbox[i]);
      } catch (e) {
        txt = String(outbox[i]);
      }
      row.textContent = '· ' + (txt.length > 220 ? txt.slice(0, 220) + '…' : txt);
      sentBox.appendChild(row);
    }
    sentBox.scrollTop = sentBox.scrollHeight;
  }

  // ═══════════════════════════ 3. 假数据 ═══════════════════════════

  var T0 = Date.now() - 9 * 60 * 1000;
  var seq = 0;
  var CWD = 'E:\\dsh结算\\vscde\\extension';
  var SESSION = 'sess-8f3a2c11';

  /** 造一条持久事件（records 里的元素和 {type:'event'} 共用） */
  function ev(type, data, dt) {
    seq += 1;
    return {
      type: 'event',
      event: { type: type, seq: seq, time: T0 + (typeof dt === 'number' ? dt : seq * 1000), data: data }
    };
  }

  function textBlock(t) {
    return { type: 'text', text: t };
  }

  function userMsg(id, text, source) {
    return ev('user/message', {
      id: id,
      role: 'user',
      content: [textBlock(text)],
      source: source || { kind: 'user' }
    });
  }

  function modelSource(model) {
    return { kind: 'model', provider: 'deepseek', model: model || 'deepseek-chat' };
  }

  function assistantMsg(id, blocks, opts) {
    opts = opts || {};
    return ev('assistant/message', {
      turn: opts.turn || 1,
      step: opts.step || 1,
      message: { id: id, role: 'assistant', content: blocks, source: modelSource(opts.model) },
      stream: (blocks || []).map(function (b) {
        return { text: b.text || '', kind: b.type === 'reasoning' ? 'reasoning' : 'text' };
      }),
      usage: opts.usage,
      interrupted: opts.interrupted || undefined
    });
  }

  function toolCall(callId, name, args, opts) {
    return ev('tool/call', {
      turn: (opts && opts.turn) || 1,
      step: (opts && opts.step) || 1,
      callId: callId,
      name: name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args, null, 2)
    });
  }

  function toolResult(callId, text, opts) {
    opts = opts || {};
    var data = {
      turn: opts.turn || 1,
      step: opts.step || 1,
      message: {
        id: 'res-' + callId,
        role: 'tool',
        toolCallId: callId,
        content: [textBlock(text)],
        source: { kind: 'tool', name: opts.tool || 'tool' },
        isError: opts.isError === true ? true : undefined
      }
    };
    if (opts.error) data.error = opts.error;
    if (opts.meta) data.meta = opts.meta;
    return ev('tool/result', data);
  }

  var CATALOG = {
    default: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
    groups: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          {
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            description: '通用对话，速度快',
            efforts: [
              { id: 'minimal', name: '最省' },
              { id: 'low', name: '低' },
              { id: 'medium', name: '中' },
              { id: 'high', name: '高' }
            ],
            defaultEffort: 'medium'
          },
          {
            id: 'deepseek-reasoner',
            name: 'DeepSeek Reasoner',
            description: '长思考，适合复杂改造',
            efforts: [
              { id: 'medium', name: '中' },
              { id: 'high', name: '高' }
            ],
            defaultEffort: 'high'
          }
        ]
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            description: '长上下文，代码理解强',
            efforts: [
              { id: 'low', name: '低' },
              { id: 'medium', name: '中' },
              { id: 'high', name: '高' }
            ],
            defaultEffort: 'high'
          }
        ]
      }
    ],
    failures: [{ name: 'openrouter', message: '缺少 OPENROUTER_API_KEY，未加载 32 个模型' }]
  };

  var PERMISSIONS = {
    current: 'workspace-write',
    presets: [
      { id: 'read-only', name: '只读', description: '只能读文件，不能执行命令' },
      { id: 'workspace-write', name: '工作区可写', description: '可改工作区文件，危险操作逐次审批' },
      { id: 'danger-full-access', name: '完全访问', description: '不受工作区限制，慎用' },
      { id: 'auto', name: '自动', description: '由模型自行判断，不逐次询问' }
    ]
  };

  var SESSIONS = [
    { sessionId: SESSION, title: '给 protocol.ts 补注释', running: false, blank: false, updatedAt: T0 + 540000, cwd: CWD, active: true },
    { sessionId: 'sess-11ab90', title: '排查 mux 重连丢帧', running: true, blank: false, updatedAt: T0 + 120000, cwd: CWD, active: false },
    { sessionId: 'sess-77c201', title: '新建会话', running: false, blank: true, updatedAt: T0 - 3600000, cwd: CWD, active: false }
  ];

  function initState(over) {
    var base = {
      connected: true,
      authority: 'http://127.0.0.1:3080',
      cwd: CWD,
      sessionId: SESSION,
      sessionTitle: '给 protocol.ts 补注释',
      sessions: SESSIONS,
      catalog: CATALOG,
      selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
      permissions: PERMISSIONS,
      defaultPermission: 'workspace-write',
      running: false,
      asks: [],
      version: '0.8.2'
    };
    Object.keys(over || {}).forEach(function (k) {
      base[k] = over[k];
    });
    return base;
  }

  var TODOS = [
    { content: '通读 src/protocol.ts 的 HostToWeb 变体', status: 'completed' },
    { content: '给 15 个变体各补一行注释', status: 'completed' },
    { content: 'node --check media/chat.js 校验语法', status: 'completed' },
    { content: '把改动同步进 docs/render-spec.md', status: 'in_progress' },
    { content: '等 lead 复核后提交', status: 'pending' }
  ];

  var PROJECTIONS = {
    title: '给 protocol.ts 补注释',
    goal: { objective: '给 HostToWeb 每个变体补注释', status: 'active' },
    tokenUsage: {
      uncachedInputTokens: 18342,
      outputTokens: 2411,
      cacheReadTokens: 96128,
      cacheWriteTokens: 4096
    },
    contextPressure: { pressureTokens: 64280, projectedTokens: 65100, contextWindow: 128000 },
    contextBreakdown: { systemTokens: 3180, toolsTokens: 9420, messageTokens: 51680 },
    inbox: { 'next-turn': [], 'next-step': [] },
    todos: TODOS,
    plan: { active: true, pending: false },
    permissions: { currentValue: 'workspace-write' },
    workingDirectory: CWD,
    modelSelection: {
      lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
      next: null
    },
    sessionStats: { turns: 2, steps: 5, toolCalls: 4, durationMs: 214000 },
    userQuestions: { active: [], settled: [] },
    sessionListMetadata: { blank: false, lastPromptAt: T0 + 520000 }
  };

  /** 主动写回几条 projection（验证 last-write-wins 更新路径） */
  function pushProjections(values) {
    host({ type: 'projections', values: values, asOfSeq: seq });
  }

  // ═══════════════════════════ 4. 场景：完整会话 ═══════════════════════════

  function historyFull() {
    seq = 0;
    var records = [];

    // ── 第 1 轮：读文件 → 改文件 → 校验 ──
    records.push(ev('turn/start', { turn: 1 }, 1000));
    records.push(ev('system/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'sys-1',
        role: 'system',
        content: [textBlock(
          'You are dsh, a coding agent embedded in VS Code.\n\n' +
          '工作目录：' + CWD + '\n' +
          '权限档：workspace-write（改文件需审批，执行命令需审批）\n' +
          '可用工具：read / edit / write / bash / grep / glob / todo_write'
        )],
        source: { kind: 'system-prompt' }
      }
    }, 1400));
    records.push(userMsg('u-1', '帮我把 src/protocol.ts 里 HostToWeb 每个变体上方补一行注释，别改字段名。', { kind: 'user' }));
    records.push(ev('step/start', { turn: 1, step: 1 }, 2600));
    records.push(assistantMsg('a-1', [
      { type: 'reasoning', text: '先读文件确认 HostToWeb 的实际结构和行号，避免按记忆写错变体。注释只加在变体上方，不动字段。' },
      { type: 'text', text: '先看一下 `src/protocol.ts` 里 `HostToWeb` 的实际结构。' }
    ], {
      turn: 1, step: 1,
      usage: { inputTokens: 12480, outputTokens: 326, cacheReadTokens: 8192, cacheWriteTokens: 0 }
    }));
    records.push(toolCall('call_a1', 'read', { file_path: 'src/protocol.ts', offset: 80, limit: 46 }, { turn: 1, step: 1 }));
    records.push(toolResult('call_a1',
      '    84  export type HostToWeb =\n' +
      '    85    | { type: \'init\'; state: { connected: boolean; authority?: string } }\n' +
      '    86    | { type: \'sessions\'; sessions: UiSessionRow[] }\n' +
      '    87    | { type: \'open\'; sessionId: string; title?: string; records: SessionHistoryRecord[] }\n' +
      '    88    | { type: \'event\'; event: SessionWireEvent }\n' +
      '    89    | { type: \'records\'; records: SessionHistoryRecord[]; prepend?: boolean }\n' +
      '    90    | { type: \'stream\'; frame: AssistantStreamFrame }\n' +
      '    91    | { type: \'reset\' }\n' +
      '    92    | { type: \'title\'; title: string }\n' +
      '    93    | { type: \'projections\'; values: Record<string, JsonValue> }\n' +
      '    94    | { type: \'models\'; catalog: UiCatalog; selection?: ModelSelection }\n' +
      '    95    | { type: \'permissions\'; current?: string; presets: UiPermissionPreset[] }\n' +
      '    96    | { type: \'status\'; connected: boolean; running: boolean }\n' +
      '    97    | { type: \'ask\'; ask: UiAsk }\n' +
      '    98    | { type: \'ask-close\'; id: string }\n' +
      '    99    | { type: \'usage\'; usage: UiUsage }\n' +
      '   100    | { type: \'notice\'; level: \'info\' | \'warn\' | \'error\'; text: string }',
      { turn: 1, step: 1, tool: 'read' }));
    records.push(ev('step/end', { turn: 1, step: 1 }, 5200));
    records.push(ev('step/start', { turn: 1, step: 2 }, 5400));
    records.push(assistantMsg('a-2', [
      { type: 'text', text: '共 15 个变体，逐个加注释。第一次 `old_string` 选得太短，试失败了一次。' }
    ], { turn: 1, step: 2 }));
    records.push(toolCall('call_a2', 'edit', {
      file_path: 'src/protocol.ts',
      old_string: "  | { type: 'ask'; ask: UiAsk }",
      new_string: '  /** 需要用户回答：审批卡片 / 提问卡片。 */\n  | { type: \'ask\'; ask: UiAsk }'
    }, { turn: 1, step: 2 }));
    records.push(toolResult('call_a2',
      '编辑失败：old_string 在文件中出现 2 次（protocol.ts:119、chat.js:2135），请提供更多上下文。',
      {
        turn: 1, step: 2, tool: 'edit', isError: true,
        error: { name: 'ToolError', code: 'E_AMBIGUOUS_MATCH', reason: 'old_string 在文件中出现 2 次，请提供更多上下文' }
      }));
    records.push(assistantMsg('a-3', [
      { type: 'text', text: '`old_string` 不唯一，加上上文再试。' }
    ], { turn: 1, step: 2 }));
    records.push(toolCall('call_a3', 'edit', {
      file_path: 'src/protocol.ts',
      old_string: "  | { type: 'ask'; ask: UiAsk }",
      new_string: '  /** 审批 / 提问卡片；webview 回 {type:"answer"} 结案。 */\n  | { type: \'ask\'; ask: UiAsk }',
      replace_all: false
    }, { turn: 1, step: 2 }));
    records.push(toolResult('call_a3', '已更新 src/protocol.ts（+1 行）', { turn: 1, step: 2, tool: 'edit' }));
    records.push(ev('step/end', { turn: 1, step: 2 }, 7600));
    records.push(ev('step/start', { turn: 1, step: 3 }, 7800));
    records.push(toolCall('call_a4', 'bash', {
      command: 'node --check media/chat.js && node --check media/dev-fixtures.js',
      description: '语法校验 webview 脚本'
    }, { turn: 1, step: 3 }));
    records.push(toolResult('call_a4', '(无输出，退出码 0)', {
      turn: 1, step: 3, tool: 'bash', meta: { exitCode: 0, durationMs: 412 }
    }));
    records.push(assistantMsg('a-4', [
      { type: 'text', text: [
        '## 已完成',
        '',
        '`src/protocol.ts` 里 `HostToWeb` 的 **15 个变体**逐个加了一行注释，字段名一个没动。',
        '',
        '| 变体 | 注释 | 状态 |',
        '| --- | --- | --- |',
        '| `init` | 首屏状态包 | 完成 |',
        '| `ask` | 审批 / 提问卡片 | 完成 |',
        '| `auth-needed` | 登录失效引导 | 完成 |',
        '',
        '```ts',
        'export type HostToWeb =',
        "  | { type: 'ready' }",
        "  | { type: 'prompt' } & PromptPayload;",
        '```',
        '',
        '两点说明：',
        '',
        '- 注释只写在变体上方，展开处（`...`）没加，避免和上游 diff 冲突；',
        '- *没有*改 `UiAsk.detail` 的语义，仍是原样展示。',
        '',
        '> 需要我把 `WebToHost` 也一起补上吗？',
        '',
        '参考 [dsh 的注释风格](https://github.com/deepseek-ai/dsh)。'
      ].join('\n') }
    ], { turn: 1, step: 3, usage: { inputTokens: 16220, outputTokens: 686, cacheReadTokens: 32768 } }));
    records.push(ev('todo/write', { turn: 1, todos: TODOS }, 9200));
    records.push(ev('deliverables/presented', {
      turn: 1,
      callId: 'call_a4',
      files: [
        { path: 'src/protocol.ts', bytes: 8214 },
        { path: 'media/chat.js', bytes: 74620 },
        { path: 'docs/render-spec.md', bytes: 15320 }
      ]
    }, 9400));
    records.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9600));

    // ── 第 2 轮：注入上下文 + 命令 + 压缩 + 未采用尝试 ──
    records.push(ev('turn/start', { turn: 2 }, 10200));
    records.push(userMsg('u-2',
      '<system-reminder>\nAGENTS.md 在 12:04 被外部修改，新增「代码注释用中文」一条。\n</system-reminder>',
      { kind: 'user', form: 'injection', summary: 'AGENTS.md 已更新' }));
    records.push(ev('command/run', { commandId: 'cmd-1', name: 'compact', args: '--keep 6', source: 'user' }, 10400));
    records.push(ev('command/done', { commandId: 'cmd-1', kind: 'success', text: '已压缩：摘要 8.2k tokens，保留最近 6 条消息' }, 11000));
    records.push(ev('compaction/start', { compactionId: 'cmp-1', turn: 2 }, 11200));
    records.push(ev('compaction/summary', {
      compactionId: 'cmp-1',
      turn: 2,
      shadowedTokenCount: 41230,
      summary: [textBlock(
        '前两轮已完成：读取 protocol.ts、给 HostToWeb 15 个变体补注释、' +
        '修掉一次 old_string 歧义、node --check 通过。待办里还剩「同步进 render-spec.md」。'
      )]
    }, 11800));
    records.push(ev('compaction/end', { compactionId: 'cmp-1' }, 12000));
    records.push(userMsg('u-3', '再确认一下 mux 重连时 seq 会不会跳。'));
    records.push(ev('step/start', { turn: 2, step: 1 }, 12400));
    records.push(ev('assistant/attempt', {
      turn: 2,
      step: 1,
      stream: [
        { kind: 'text', text: '让我先查 ' },
        { kind: 'text', text: 'mux 的 follow 断线逻辑……' }
      ]
    }, 12600));
    records.push(assistantMsg('a-5', [
      { type: 'reasoning', text: '重连后是否丢帧取决于 follow 是否带 cursor。看 probe/chat.cjs 里 open 时没带 seq，所以是整段重放，不会跳。' },
      {
        type: 'text', text: [
          '不会跳。`session/follow` 的 `open` 里没带 cursor，重连等于整段重放：',
          '',
          '1. 扩展先发 `{type:\'reset\'}` 清掉流式占位；',
          '2. 再用 `{type:\'open\'}` 的 `records` 覆盖整棵树；',
          '3. 后续 `event` 的 `seq` 单调递增，webview 侧按 `seq <= lastSeq` 去重。',
          '',
          '所以唯一的风险是 **`open` 和后续 `event` 之间** 有空档（这时依赖扩展侧先 snapshot 再 subscribe）。'
        ].join('\n')
      }
    ], { turn: 2, step: 1, usage: { inputTokens: 9860, outputTokens: 402, cacheReadTokens: 65536 } }));
    // 未知事件走通用兜底渲染
    records.push(ev('plugin:demo/beat', { reason: 'heartbeat', payload: { rtt: 42, peers: 2 } }, 13200));
    records.push(ev('step/end', { turn: 2, step: 1 }, 13400));
    records.push(ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 13600));
    records.push(ev('session/title', { title: '给 protocol.ts 补注释 · 已定稿' }, 13800));

    return records;
  }

  function scenarioFull() {
    resetHost();
    host({ type: 'init', state: initState() });
    host({
      type: 'open',
      sessionId: SESSION,
      title: '给 protocol.ts 补注释',
      header: { version: 1, id: SESSION, createdAt: T0, cwd: CWD, isSeeded: false },
      records: historyFull(),
      projections: { asOfSeq: seq, values: JSON.parse(JSON.stringify(PROJECTIONS)) },
      hasMore: true
    });
    host({ type: 'status', connected: true, running: false });
    host({
      type: 'ask',
      ask: {
        id: 'ask-approve-1',
        kind: 'approval',
        title: '允许执行命令？',
        body: '模型请求在工作区执行一条命令：',
        detail: 'node --check media/chat.js && node --check media/dev-fixtures.js',
        options: [
          { id: 'allowed-once', label: '允许一次' },
          { id: 'rejected', label: '拒绝', destructive: true }
        ],
        createdAt: Date.now()
      }
    });
    host({ type: 'notice', level: 'info', text: '会话已从磁盘恢复（2 轮、5 步）' });
    setTimeout(function () {
      pushProjections({
        contextPressure: { pressureTokens: 65880, projectedTokens: 66420, contextWindow: 128000 },
        tokenUsage: { uncachedInputTokens: 18920, outputTokens: 2612, cacheReadTokens: 96128, cacheWriteTokens: 4096 },
        inbox: { 'next-turn': [], 'next-step': [] }
      });
    }, 900);
  }

  // ═══════════════════════════ 5. 场景：流式输出 ═══════════════════════════

  var timers = [];

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function clearTimers() {
    timers.forEach(function (t) { clearTimeout(t); });
    timers = [];
  }

  function scenarioStream() {
    resetHost();
    var base = historyFull();
    // 只保留前两轮，第 3 轮正在跑
    host({ type: 'init', state: initState({ running: true, sessionTitle: '给 render-spec 写渲染规则' }) });
    host({
      type: 'open',
      sessionId: SESSION,
      title: '给 render-spec 写渲染规则',
      header: { version: 1, id: SESSION, createdAt: T0, cwd: CWD, isSeeded: false },
      records: base,
      projections: { asOfSeq: seq, values: JSON.parse(JSON.stringify(PROJECTIONS)) },
      hasMore: false
    });
    host({ type: 'status', connected: true, running: true });

    var attemptId = 'att-stream-1';
    var revision = 7;
    var reasoning = '用户要的是渲染规则，不是实现细节。先把 24 个投影里 UI 用得到的挑出来：todos、plan、contextPressure、contextBreakdown、tokenUsage。然后按 event.type 列规则，最后补状态机。';
    var answer = [
      '写好了，`docs/render-spec.md` 分四段：',
      '',
      '1. **组件清单** —— 顶栏、消息流、工具卡、审批卡、用量条、composer；',
      '2. **event.type 渲染规则** —— 已知 20 种显式渲染，其余走通用兜底；',
      '3. **CSS 类名表** —— 与 `media/chat.css` 一一对应；',
      '4. **消息流状态机** —— snapshot → event/stream → 断线 reset → 新 snapshot。',
      '',
      '需要我再补一张「组件 ↔ 契约字段」对照表吗？'
    ].join('\n');

    later(function () {
      host({ type: 'stream', frame: { type: 'start', attemptId: attemptId, revision: revision, turn: 3, step: 1 } });
    }, 120);

    later(function () {
      host({ type: 'stream', frame: { type: 'chunk', attemptId: attemptId, revision: revision, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } });
    }, 260);

    typeOut(reasoning, 320, 24, function (i) {
      return { type: 'stream', frame: { type: 'chunk', attemptId: attemptId, revision: revision, chunk: { type: 'text-delta', index: 0, text: i } } };
    }, function () {
      host({ type: 'stream', frame: { type: 'chunk', attemptId: attemptId, revision: revision, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } } });
      host({ type: 'stream', frame: { type: 'chunk', attemptId: attemptId, revision: revision, chunk: { type: 'block-start', index: 1, blockType: 'text' } } });
      typeOut(answer, 120, 18, function (i) {
        return { type: 'stream', frame: { type: 'chunk', attemptId: attemptId, revision: revision, chunk: { type: 'text-delta', index: 1, text: i } } };
      }, function () {
        host({ type: 'stream', frame: { type: 'chunk', attemptId: attemptId, revision: revision, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: answer } } } });
        host({
          type: 'stream',
          frame: {
            type: 'chunk', attemptId: attemptId, revision: revision,
            chunk: { type: 'usage', usage: { inputTokens: 21440, outputTokens: 918, cacheReadTokens: 57344, cacheWriteTokens: 0 } }
          }
        });
        host({ type: 'stream', frame: { type: 'end', attemptId: attemptId, revision: revision, outcome: { kind: 'committed', eventType: 'assistant/message', seq: seq + 1 } } });
        var done = assistantMsg('a-stream', [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text: answer }
        ], { turn: 3, step: 1, usage: { inputTokens: 21440, outputTokens: 918, cacheReadTokens: 57344 } });
        host({ type: 'event', event: done.event });
        host({ type: 'status', connected: true, running: false });
        pushProjections({
          tokenUsage: { uncachedInputTokens: 21440, outputTokens: 918, cacheReadTokens: 57344, cacheWriteTokens: 0 },
          contextPressure: { pressureTokens: 74120, projectedTokens: 74800, contextWindow: 128000 }
        });
      });
    });
  }

  /** 把一段文本切成小块，按节奏逐条送出（模拟 text-delta） */
  function typeOut(text, initialDelay, chunkSize, makeMsg, done) {
    var pos = 0;
    function step() {
      if (pos >= text.length) {
        done();
        return;
      }
      var piece = text.slice(pos, pos + chunkSize);
      pos += chunkSize;
      host(makeMsg(piece));
      later(step, 42);
    }
    later(step, initialDelay);
  }

  // ═══════════════════════════ 6. 场景：审批 / 提问 ═══════════════════════════

  function scenarioAsks() {
    resetHost();
    host({ type: 'init', state: initState({ sessionTitle: '审批与提问卡' }) });
    host({
      type: 'open',
      sessionId: SESSION,
      title: '审批与提问卡',
      records: [
        ev('turn/start', { turn: 1 }),
        userMsg('u-a1', '把 dist/ 整个删掉，然后重新打包。'),
        ev('step/start', { turn: 1, step: 1 }),
        assistantMsg('a-a1', [{ type: 'text', text: '删除 `dist/` 是不可逆操作，先请求确认。' }], { turn: 1, step: 1 }),
        toolCall('call_d1', 'bash', { command: 'rm -rf dist/ && npm run build', description: '清空 dist 并重新构建' }, { turn: 1, step: 1 })
      ],
      projections: { asOfSeq: seq, values: { plan: { active: false, pending: true }, inbox: { 'next-turn': ['u-q1'] } } }
    });
    host({ type: 'status', connected: true, running: true });

    host({
      type: 'ask',
      ask: {
        id: 'ask-approve-rm',
        kind: 'approval',
        title: '允许执行危险命令？',
        body: '这条命令会 **删除** `dist/` 下所有文件，然后调用构建脚本。',
        detail: 'rm -rf dist/ && npm run build',
        options: [
          { id: 'allowed-once', label: '允许一次', description: '仅本次' },
          { id: 'rejected', label: '拒绝', description: '保留 dist/', destructive: true }
        ],
        createdAt: Date.now()
      }
    });

    later(function () {
      host({
        type: 'ask',
        ask: {
          id: 'ask-question-single',
          kind: 'question',
          title: '构建用哪种目标？',
          body: '`npm run build` 有两个模式，需要你选一个。',
          options: [
            { id: 'opt-0', label: 'production', description: '压缩、去掉 sourcemap' },
            { id: 'opt-1', label: 'development', description: '保留 sourcemap，便于调试' }
          ],
          createdAt: Date.now() + 10
        }
      });
    }, 400);

    later(function () {
      host({
        type: 'ask',
        ask: {
          id: 'ask-question-multi',
          kind: 'question',
          title: '还有哪些要一起处理？',
          body: '可多选。',
          multiSelect: true,
          options: [
            { id: 'opt-0', label: '清理 .vscode-test/', description: '约 42 MB' },
            { id: 'opt-1', label: '重跑 npm install', description: '会改 package-lock.json' },
            { id: 'opt-2', label: '只打包，不动其它' }
          ],
          createdAt: Date.now() + 20
        }
      });
    }, 700);
  }

  // ═══════════════════════════ 7. 场景：空态 ═══════════════════════════

  function scenarioEmpty() {
    resetHost();
    host({
      type: 'init',
      state: initState({
        connected: false,
        authority: 'http://127.0.0.1:3080',
        sessionId: undefined,
        sessionTitle: '',
        sessions: [],
        running: false
      })
    });
    host({ type: 'status', connected: false, running: false });
  }

  function scenarioAuth() {
    resetHost();
    host({
      type: 'init',
      state: initState({
        connected: false,
        authority: 'http://127.0.0.1:3080',
        sessionId: undefined,
        sessionTitle: '',
        sessions: [],
        running: false
      })
    });
    host({ type: 'auth-needed', reason: 'token-expired', authority: 'http://127.0.0.1:3080' });
    host({ type: 'notice', level: 'error', text: 'access token 已过期，请重新登录' });
  }

  // ═══════════════════════════ 8. 场景：中断与错误 ═══════════════════════════

  function scenarioError() {
    resetHost();
    host({ type: 'init', state: initState({ sessionTitle: '中断与错误' }) });
    host({
      type: 'open',
      sessionId: SESSION,
      title: '中断与错误',
      records: [
        ev('turn/start', { turn: 1 }),
        userMsg('u-e1', '跑一遍全量测试，然后修掉失败项。'),
        ev('step/start', { turn: 1, step: 1 }),
        toolCall('call_e1', 'bash', { command: 'npm test -- --runInBand', description: '全量测试' }, { turn: 1, step: 1 }),
        toolResult('call_e1',
          'FAIL src/mux/resume.test.ts\n  ● resume > replays missed frames after reconnect\n\n' +
          '    expect(received).toEqual(expected)\n\n    - Expected  - 2\n    + Received  + 2\n\n' +
          '    Array [\n      12,\n    - 13,\n    - 14,\n    + 15,\n    + 16,\n    ]\n\n' +
          'Tests: 1 failed, 62 passed, 63 total',
          {
            turn: 1, step: 1, tool: 'bash', isError: true,
            error: { name: 'CommandError', code: 'E_EXIT_1', reason: '测试失败：resume.test.ts 期望重放 13/14，实际收到 15/16' },
            meta: { exitCode: 1, durationMs: 18420 }
          }),
        assistantMsg('a-e1', [
          { type: 'reasoning', text: '失败原因是重连后 cursor 用的是「最后写入 seq」而不是「最后确认 seq」，导致漏了 13/14 两帧。' },
          { type: 'text', text: '找到原因了：重连 cursor 取的是最后写入 seq，应该取最后**确认** seq。' }
        ], { turn: 1, step: 1 }),
        ev('step/start', { turn: 1, step: 2 }, 8000),
        toolCall('call_e2', 'edit', { file_path: 'src/dsh/mux.ts', old_string: 'cursor = lastWrittenSeq', new_string: 'cursor = lastAckedSeq' }, { turn: 1, step: 2 }),
        assistantMsg('a-e2', [
          { type: 'text', text: '改到一半用户点了停止。' }
        ], { turn: 1, step: 2, interrupted: true, usage: { inputTokens: 8420, outputTokens: 128, cacheReadTokens: 16384 } }),
        ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 11000),
        ev('turn/start', { turn: 2 }, 12000),
        userMsg('u-e2', '先别改 mux，把测试的超时时间调一下。'),
        ev('step/start', { turn: 2, step: 1 }, 12400),
        assistantMsg('a-e3', [{ type: 'text', text: '好，先只动 `vitest.config.ts` 的 `testTimeout`。' }], { turn: 2, step: 1 }),
        ev('turn/end', { turn: 2, reason: { kind: 'error', error: '模型返回 429 Too Many Requests（provider: deepseek）' } }, 13000)
      ],
      projections: { asOfSeq: seq, values: { todos: TODOS.slice(0, 3), plan: { active: false, pending: false }, inbox: { 'next-turn': [], 'next-step': [] } } }
    });
    host({ type: 'status', connected: true, running: false });
    host({ type: 'notice', level: 'warn', text: '模型限流，60 秒后自动重试' });
    host({ type: 'notice', level: 'error', text: '本轮失败：429 Too Many Requests' });
  }

  // ═══════════════════════════ 9. 场景：排队 / 长历史 ═══════════════════════════

  function scenarioQueue() {
    resetHost();
    host({ type: 'init', state: initState({ running: true, sessionTitle: '长历史与排队' }) });
    var records = [];
    var stats = 'src/dsh/mux.ts   | 214 ++++++++++++++++++-----------------\n' +
      ' src/dsh/rpc.ts   |  88 ++++++++-----\n' +
      ' src/chat/panel.ts| 412 ++++++++++++++++++++++++++++++++++++++++++++----\n' +
      ' media/chat.js    | 1104 +++++++++++++++++++++++++++++++++++++++++++++++\n' +
      ' 4 files changed, 1490 insertions(+), 328 deletions(-)';
    for (var t = 1; t <= 8; t++) {
      records.push(ev('turn/start', { turn: t }));
      records.push(userMsg('u-q' + t, t === 1 ? '先看下 git status 和最近 5 条提交。' : '继续，第 ' + t + ' 步。'));
      records.push(ev('step/start', { turn: t, step: 1 }));
      records.push(toolCall('call_q' + t, t % 3 === 0 ? 'bash' : 'read', t % 3 === 0
        ? { command: 'git diff --stat', description: '看改动规模' }
        : { file_path: 'src/dsh/mux.ts', limit: 80 }, { turn: t, step: 1 }));
      records.push(toolResult('call_q' + t, t % 3 === 0 ? stats : 'mux.ts 前 80 行……（略）', { turn: t, step: 1, tool: t % 3 === 0 ? 'bash' : 'read' }));
      records.push(assistantMsg('a-q' + t, [{ type: 'text', text: '第 ' + t + ' 轮：' + (t === 1 ? '工作区有 4 个文件改动，最近提交是 `feat(chat): webview 骨架`。' : '继续向前推进，当前没有阻塞。') }], { turn: t, step: 1 }));
      records.push(ev('turn/end', { turn: t, reason: { kind: 'completed' } }));
    }
    host({
      type: 'open',
      sessionId: SESSION,
      title: '长历史与排队',
      records: records,
      hasMore: true,
      projections: {
        asOfSeq: seq,
        values: {
          todos: TODOS,
          plan: { active: true, pending: false },
          inbox: { 'next-turn': ['再顺手把 README 的截图换掉', '顺便跑一下 lint'], 'next-step': [] },
          contextPressure: { pressureTokens: 118640, projectedTokens: 120400, contextWindow: 128000 }
        }
      }
    });
    host({ type: 'status', connected: true, running: true, detail: '正在执行第 9 轮' });
  }

  // ═══════════════════════════ 10. 调度 ═══════════════════════════

  /** 清空当前会话内容（用一次空 open 覆盖，走真实的重建路径） */
  // ═══════════════════════════ 8. 场景：改动卡片 ═══════════════════════════

  /** 一轮普通对话，用来承载改动卡片 */
  function changesHistory() {
    var records = [];
    records.push(userMsg('u-chg-1', '把「改动可视化」接上：changes 卡片 + 懒加载 diff。'));
    records.push(ev('step/start', { turn: 1, step: 1 }, 3000));
    records.push(assistantMsg('a-chg-1', [
      { type: 'reasoning', text: '先看 protocol.ts 里 UiChanges / UiDiff 的字段，再决定卡片挂在轮末、diff 走懒加载。' },
      {
        type: 'text',
        text: '改动可视化接好了：\n\n- `changes` 渲染成轮末卡片，`+a` 绿、`−d` 红；\n- 点文件行发 `load-diff`，结果填进行下方；\n- `workspace/changes` 事件保持静默，卡片只由消息驱动。'
      }
    ], { turn: 1, step: 1, usage: { inputTokens: 3200, outputTokens: 210, cacheReadTokens: 40960 } }));
    records.push(ev('step/end', { turn: 1, step: 1 }, 6000));
    records.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6400));
    return records;
  }

  var CHANGES_SEQ = 9001;

  function changesPayload() {
    return {
      sessionId: SESSION,
      seq: CHANGES_SEQ,
      turn: 1,
      files: [
        { index: 0, path: CWD + '\\src\\protocol.ts', display: 'src/protocol.ts', added: 18, deleted: 2 },
        { index: 1, path: CWD + '\\media\\chat.js', display: 'media/chat.js', added: 20, deleted: 4 },
        { index: 2, path: CWD + '\\docs\\render-spec.md', display: 'docs/render-spec.md', added: 4, deleted: 1 }
      ],
      total: 3,
      added: 42,
      deleted: 7
    };
  }

  /** 两个 hunk：含 + 行、- 行、上下文行 */
  function diffPayload() {
    return {
      sessionId: SESSION,
      seq: CHANGES_SEQ,
      index: 0,
      kind: 'text',
      path: CWD + '\\src\\protocol.ts',
      display: 'src/protocol.ts',
      before: false,
      after: false,
      hunks: [
        {
          oldStart: 62, oldLines: 2, newStart: 62, newLines: 4,
          lines: [
            '   detail?: string;',
            '+  /** 某一轮的改动汇总（来自 workspace/changes 事件） */',
            '+  changes?: UiChanges;',
            ' }'
          ]
        },
        {
          oldStart: 118, oldLines: 3, newStart: 120, newLines: 5,
          lines: [
            "   | { type: 'auth-needed'; reason: 'no-token' | 'token-expired' | 'disconnected' }",
            "+  | { type: 'changes'; changes: UiChanges }",
            "+  | { type: 'diff'; diff: UiDiff }",
            "-  | { type: 'copy'; text: string }",
            "   | { type: 'open-link'; href: string };"
          ]
        }
      ]
    };
  }

  function scenarioChanges() {
    resetHost();
    // 历史回放路径：records 里直接夹一条 changes 记录
    var records = changesHistory();
    records.push({ type: 'changes', changes: changesPayload() });
    host({ type: 'init', state: initState({ sessionTitle: '改动可视化：changes + diff' }) });
    host({
      type: 'open',
      sessionId: SESSION,
      title: '改动可视化：changes + diff',
      header: { version: 1, id: SESSION, createdAt: T0, cwd: CWD, isSeeded: false },
      records: records,
      projections: { asOfSeq: seq, values: JSON.parse(JSON.stringify(PROJECTIONS)) },
      hasMore: false
    });
    host({ type: 'status', connected: true, running: false });
  }

  function scenarioChangesOpen() {
    // 实时路径：先 open 再推 changes
    resetHost();
    host({ type: 'init', state: initState({ sessionTitle: '改动可视化：changes + diff' }) });
    host({
      type: 'open',
      sessionId: SESSION,
      title: '改动可视化：changes + diff',
      header: { version: 1, id: SESSION, createdAt: T0, cwd: CWD, isSeeded: false },
      records: changesHistory(),
      projections: { asOfSeq: seq, values: JSON.parse(JSON.stringify(PROJECTIONS)) },
      hasMore: false
    });
    host({ type: 'status', connected: true, running: false });
    host({ type: 'changes', changes: changesPayload() });
    // 模拟用户点开第一个文件：webview 会发 load-diff，这里 220ms 后回一条 diff
    later(function () {
      var row = document.querySelector('.dsx-changes .dsx-chg-file');
      if (row) row.click();
    }, 220);
    later(function () {
      host({ type: 'diff', diff: diffPayload() });
    }, 420);
  }

  function resetHost() {
    clearTimers();
    outbox.length = 0;
    host({
      type: 'open',
      sessionId: SESSION,
      title: '',
      records: [],
      projections: { asOfSeq: 0, values: {} },
      hasMore: false
    });
  }

  function play(sc) {
    if (activeBtn) activeBtn.classList.remove('is-active');
    var btn = bar.querySelector('[data-scenario="' + sc.id + '"]');
    if (btn) {
      btn.classList.add('is-active');
      activeBtn = btn;
    }
    try {
      sc.run();
    } catch (e) {
      if (window.console && console.error) console.error('[preview] 场景失败:', e);
    }
  }

  function start() {
    injectStyle();
    buildBar();
    // 支持 URL hash 直接开某个场景：preview.html#changes-open
    var hash = String(location.hash || '').replace(/^#/, '');
    var picked = null;
    for (var i = 0; i < SCENARIOS.length; i++) {
      if (SCENARIOS[i].id === hash) picked = SCENARIOS[i];
    }
    // 默认场景：完整会话
    if (!picked) picked = SCENARIOS[0];
    if (picked) play(picked);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

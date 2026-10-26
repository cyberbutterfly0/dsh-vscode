/**
 * dsh × VS Code —— 聊天 webview 前端（原生 JS，零依赖）
 *
 * 入口：<script nonce="...">chat.js</script> 加载后立即 boot()；
 * 通过 acquireVsCodeApi() 与扩展通信，消息契约见 src/protocol.ts（字段名照抄）。
 *
 * 挂载：优先 #dsx-root，没有就挂到 document.body。
 * 渲染：所有模型文本先 escapeHTML，再套「受控 markdown」（粗体/斜体/行内代码/
 *       围栏代码/标题/列表/引用/表格/链接）；任何地方不直接 innerHTML 拼未转义内容。
 * 流式：assistant-stream 的四个 chunk 增量追加 DOM，只有单个块的 markdown 会按
 *       150ms 节流重排，整棵树不重建。
 *
 * 代码注释为中文；函数尽量小而单一。
 */
(function () {
  'use strict';

  // ═══════════════════════════ 0. 基础工具 ═══════════════════════════

  var ESC_RE = /[&<>"']/g;
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** 转义 HTML（所有外部文本的第一步） */
  function escapeHTML(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(ESC_RE, function (ch) { return ESC_MAP[ch]; });
  }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function str(v, fallback) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
    return fallback === undefined ? '' : fallback;
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /** 建元素；text 走 textContent，天然安全 */
  function mk(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function formatTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return trimNum(n / 1000) + 'K';
    return trimNum(n / 1000000) + 'M';
  }

  function trimNum(x) {
    var s = (Math.round(x * 10) / 10).toFixed(1);
    return s.replace(/\.0$/, '');
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return trimNum(ms / 1000) + 's';
    var m = Math.floor(ms / 60000);
    var s = Math.round((ms % 60000) / 1000);
    return m + 'm' + (s ? s + 's' : '');
  }

  function formatClock(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /** 把「可能是 JSON 字符串」的值整理成可读文本 */
  function prettyJsonText(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') {
      var t = raw.trim();
      if (t && (t.charAt(0) === '{' || t.charAt(0) === '[')) {
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return raw; }
      }
      return raw;
    }
    try { return JSON.stringify(raw, null, 2); } catch (e) { return String(raw); }
  }

  /** 解析工具参数（tool/call.arguments 是模型原样输出的 JSON 字符串） */
  function parseToolArgs(raw) {
    if (isObj(raw)) return raw;
    if (typeof raw !== 'string') return null;
    try {
      var v = JSON.parse(raw);
      return isObj(v) ? v : null;
    } catch (e) { return null; }
  }

  var ARG_SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt', 'text', 'label', 'name'];

  /** 工具卡标题右侧的一行摘要 */
  function summarizeToolCall(name, rawArgs) {
    var args = parseToolArgs(rawArgs);
    if (!args) {
      var line = prettyJsonText(rawArgs).split('\n')[0] || '';
      return firstLine(line, 90);
    }
    var keys = Object.keys(args);
    for (var i = 0; i < ARG_SUMMARY_KEYS.length; i++) {
      var k = ARG_SUMMARY_KEYS[i];
      if (typeof args[k] === 'string' && args[k]) return firstLine(args[k], 90);
    }
    for (var j = 0; j < keys.length; j++) {
      if (typeof args[keys[j]] === 'string' && args[keys[j]]) return firstLine(args[keys[j]], 90);
    }
    return firstLine(JSON.stringify(args), 90);
  }

  function firstLine(s, max) {
    var one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (one.length > max) one = one.slice(0, max - 1) + '…';
    return one;
  }

  function blockTexts(content) {
    if (!Array.isArray(content)) return '';
    var out = [];
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'reasoning' && typeof b.text === 'string') out.push(b.text);
      else if (b.type === 'image') out.push('[图片]');
      else if (b.type === 'file') out.push('[文件]');
    }
    return out.join('\n');
  }

  // ═══════════════════════════ 1. 受控 markdown ═══════════════════════════

  /**
   * 行内标记：输入已被 escapeHTML 过的文本，返回 HTML 字符串。
   * 行内代码先抽成占位符，避免内部再被解析。
   */
  function inlineMd(escaped) {
    var codes = [];
    var t = escaped.replace(/`([^`\n]+)`/g, function (m, code) {
      codes.push(code);
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });
    // 链接 [文本](地址) —— 地址已在转义后的文本里
    // 只放行 http(s)/file/mailto/vscode 与相对路径；javascript: 之类退化成纯文本
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
      if (!/^(?:https?:|file:|mailto:|vscode:|\.{0,2}\/)/i.test(href)) {
        return label + ' (' + href + ')';
      }
      return '<a class="dsx-link" data-href="' + href + '" title="' + href + '">' + label + '</a>';
    });
    // 粗体
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    // 斜体（避开已经成对的 **）
    t = t.replace(/(^|[^*])\*([^*\s][^*\n]*?)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_/g, '$1<em>$2</em>');
    // 删除线
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // 行内换行折叠成空格（段落内）
    t = t.replace(/\n/g, ' ');
    // 还回行内代码
    t = t.replace(/\u0000C(\d+)\u0000/g, function (m, idx) {
      return '<code class="dsx-inline-code">' + codes[Number(idx)] + '</code>';
    });
    return t;
  }

  function splitTableRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|');
  }

  function isTableSeparator(line) {
    var s = line.trim();
    if (s.indexOf('-') === -1) return false;
    return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(s);
  }

  /**
   * 受控 markdown → HTML 字符串。
   * 支持的块：围栏代码、标题(1-6)、分割线、引用、表格、无序/有序列表、段落。
   */
  function renderMarkdown(src) {
    var text = String(src === null || src === undefined ? '' : src).replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    var out = [];
    var listType = null;
    var i = 0;

    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; }
    }
    function openList(type) {
      if (listType === type) return;
      closeList();
      out.push('<' + type + ' class="dsx-' + (type === 'ul' ? 'ul' : 'ol') + '">');
      listType = type;
    }

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块
      var fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        closeList();
        var marker = fence[1].charAt(0);
        var lang = fence[2] || '';
        var buf = [];
        i += 1;
        var endRe = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{3,}\\s*$');
        while (i < lines.length && !endRe.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1; // 吃掉结束围栏
        out.push('<pre class="dsx-pre"><code class="dsx-code"' +
          (lang ? ' data-lang="' + escapeHTML(lang) + '"' : '') + '>' +
          escapeHTML(buf.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { closeList(); i += 1; continue; }

      // 表格：本行含 | 且下一行是分隔行
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        closeList();
        var head = splitTableRow(line);
        var aligns = splitTableRow(lines[i + 1]);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        var html = '<table class="dsx-table"><thead><tr>';
        for (var c = 0; c < head.length; c++) {
          var al = (aligns[c] || '').trim();
          var style = /^:-+:$/.test(al) ? ' style="text-align:center"' : /^-+:$/.test(al) ? ' style="text-align:right"' : '';
          html += '<th' + style + '>' + inlineMd(escapeHTML(head[c].trim())) + '</th>';
        }
        html += '</tr></thead><tbody>';
        for (var r = 0; r < rows.length; r++) {
          html += '<tr>';
          for (var c2 = 0; c2 < head.length; c2++) {
            html += '<td>' + inlineMd(escapeHTML((rows[r][c2] || '').trim())) + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        out.push(html);
        continue;
      }

      // 标题
      var hd = line.match(/^(#{1,6})\s+(.*)$/);
      if (hd) {
        closeList();
        var level = hd[1].length;
        out.push('<h' + level + ' class="dsx-h">' + inlineMd(escapeHTML(hd[2].trim())) + '</h' + level + '>');
        i += 1;
        continue;
      }

      // 分割线
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        out.push('<hr class="dsx-hr" />');
        i += 1;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        closeList();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote class="dsx-quote">' + renderMarkdown(quote.join('\n')) + '</blockquote>');
        continue;
      }

      // 列表项
      var li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        var ordered = /\d/.test(li[2]);
        openList(ordered ? 'ol' : 'ul');
        var deep = li[1].length >= 2 ? ' dsx-li-deep' : '';
        out.push('<li class="dsx-li' + deep + '">' + inlineMd(escapeHTML(li[3])) + '</li>');
        i += 1;
        continue;
      }

      // 普通段落：合并到下一个空行/块级标记
      var para = [line];
      i += 1;
      while (i < lines.length) {
        var next = lines[i];
        if (!next.trim()) break;
        if (/^\s*(```|~~~)/.test(next)) break;
        if (/^\s*#{1,6}\s/.test(next)) break;
        if (/^\s*>\s?/.test(next)) break;
        if (/^\s*([-*+]|\d+[.)])\s+/.test(next)) break;
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(next)) break;
        if (next.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
        para.push(next);
        i += 1;
      }
      out.push('<p class="dsx-p">' + inlineMd(escapeHTML(para.join('\n'))) + '</p>');
    }
    closeList();
    return out.join('');
  }

  // ═══════════════════════════ 2. 常量表 ═══════════════════════════

  /** 这些持久事件只更新投影/内部状态，不进消息流 */
  var SILENT_EVENTS = {
    'request/header': 1, 'request/context': 1, 'agent/inbox/spliced': 1,
    'session/title-llm-request': 1, 'model/selection': 1, 'permission/preset': 1,
    'sandbox/mode': 1, 'approval/policy': 1, 'approval/asked': 1, 'approval/decided': 1,
    'image/offload': 1, 'hook/invoked': 1, 'hook/result': 1, 'llm/retry': 1, 'llm/retry-started': 1,
    'developer/message': 1, 'session/end-seed': 1, 'working-directory/change': 1,
    'workspace/changes': 1, 'feedback/message-delete': 1, 'feedback/message-put': 1,
    'feedback/record': 1, 'goal/change': 1, 'schedule/change': 1, 'job/registered': 1,
    'job/settled': 1, 'subagent/descriptor': 1, 'subagent/catalog': 1,
    'subagent/model-selection-policy': 1, 'agent-preset/selected': 1,
    'session-log-deepseek/delivery-accepted': 1, 'web/deepseek-search-llm-request': 1,
    'team/member': 1, 'team/message/delivered': 1, 'team/message/queued': 1,
    'team/task': 1, 'compaction/prune': 1, 'tool-workflow/agent-start': 1,
    'tool-workflow/agent-end': 1, 'tool-workflow/run-start': 1, 'tool-workflow/run-end': 1
  };

  var SOURCE_LABELS = {
    'user': '用户', 'agent': '代理注入', 'plan-mode': '计划模式', 'system-reminder': '系统提醒',
    'skill': '技能上下文', 'runtime-context': '运行时上下文', 'context': '上下文注入',
    'file-change': '文件变更', 'compaction': '压缩摘要', 'goal': '目标续跑', 'cron': '定时任务'
  };

  var TURN_END_LABELS = {
    completed: '完成', interrupted: '已中断', error: '出错', aborted: '已中止',
    cancelled: '已取消', failed: '失败', stopped: '已停止'
  };

  function sourceInfo(source) {
    var s = isObj(source) ? source : {};
    var kind = str(s.kind, 'unknown');
    var human = kind === 'user' && !s.form && !s.summary;
    var label = SOURCE_LABELS[kind] || kind;
    return { human: human, kind: kind, label: label, summary: str(s.summary, '') };
  }

  // ═══════════════════════════ 3. 状态 ═══════════════════════════

  var S = {
    connected: false,
    authority: '',
    cwd: '',
    sessionId: '',
    sessionTitle: '',
    header: null,
    sessions: [],
    catalog: null,
    selection: null,
    permissions: { current: '', presets: [] },
    defaultPermission: '',
    running: false,
    version: '',
    asks: [],                 // [{ask, el}]，按 createdAt 排序
    authNeeded: '',
    usage: {},                // {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,contextWindow,pressureTokens}
    projections: {},          // 24 key 投影，整值 last-write-wins
    projectionsAsOf: 0,
    stream: null,             // 流式状态
    tools: {},                // callId → {el, time, name, filled}
    commands: {},             // commandId → element
    turns: {},                // turn → {el, time, durEl}
    changes: {},              // "sessionId|seq" → {changes, el, items:{index:{...}}}
    diffs: {},                // "sessionId|seq|index" → UiDiff（已到但行可能还没展开）
    lastSeq: 0,
    msgCount: 0,
    follow: true,             // 是否贴底自动滚动
    menu: null,
    noticeTimer: null,
    draft: ''
  };

  var U = {};                 // DOM 引用

  // ═══════════════════════════ 4. 通信 ═══════════════════════════

  var vscode = null;
  var postQueue = [];

  function post(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (vscode && typeof vscode.postMessage === 'function') {
      try { vscode.postMessage(msg); return; } catch (e) { /* 落空 */ }
    }
    postQueue.push(msg);
  }

  // ═══════════════════════════ 5. 外壳与布局 ═══════════════════════════

  function buildShell(root) {
    var app = mk('div', 'dsx-app');
    app.id = 'dsx-app';

    // ── 顶栏 ──
    var hd = mk('header', 'dsx-hd');
    var lead = mk('div', 'dsx-hd-lead');
    U.dot = mk('span', 'dsx-dot dsx-dot-bad');
    U.dot.title = '未连接';
    U.title = mk('button', 'dsx-title');
    U.title.type = 'button';
    U.title.title = '当前会话';
    U.sub = mk('span', 'dsx-hd-sub');
    lead.appendChild(U.dot);
    lead.appendChild(U.title);
    lead.appendChild(U.sub);

    var actions = mk('div', 'dsx-hd-actions');
    U.btnSessions = chip('会话');
    U.btnSessions.classList.add('dsx-hd-sessions');
    U.btnSessions.title = '切换会话';
    U.btnModels = chip('模型');
    U.btnModels.title = '选择模型与推理档';
    U.btnPerms = chip('权限');
    U.btnPerms.classList.add('dsx-hd-perms');
    U.btnPerms.title = '选择权限档';
    U.btnStop = mk('button', 'dsx-btn dsx-btn-stop', '停止');
    U.btnStop.type = 'button';
    U.btnStop.title = '取消当前回合';
    U.btnNew = actionBtn('新建会话', '+');
    U.btnNew.title = '新建会话';
    U.btnFull = actionBtn('打开完整 dsh UI', '完整界面');
    U.btnFull.title = '在浏览器里打开 dsh Web UI';
    actions.appendChild(U.btnSessions);
    actions.appendChild(U.btnModels);
    actions.appendChild(U.btnPerms);
    actions.appendChild(U.btnStop);
    actions.appendChild(U.btnNew);
    actions.appendChild(U.btnFull);

    hd.appendChild(lead);
    hd.appendChild(actions);

    // ── 消息流 ──
    var transcript = mk('div', 'dsx-transcript');
    U.transcript = transcript;
    U.inner = mk('div', 'dsx-log-inner');
    U.empty = mk('div', 'dsx-empty');
    U.empty.hidden = true;
    U.inner.appendChild(U.empty);
    U.loadOlder = mk('div', 'dsx-load-older');
    U.loadOlderBtn = mk('button', 'dsx-btn dsx-btn-ghost', '加载更早的历史');
    U.loadOlderBtn.type = 'button';
    U.loadOlder.appendChild(U.loadOlderBtn);
    U.loadOlder.hidden = true;
    U.inner.appendChild(U.loadOlder);
    transcript.appendChild(U.inner);
    U.jump = mk('button', 'dsx-jump', '↓ 回到底部');
    U.jump.type = 'button';
    U.jump.hidden = true;
    transcript.appendChild(U.jump);

    // ── 底部：审批/提问 dock + 卡片 + composer + 用量条 ──
    var bottom = mk('div', 'dsx-bottom');
    U.dock = mk('div', 'dsx-dock');
    U.cards = mk('div', 'dsx-cards');
    U.composer = mk('div', 'dsx-composer');
    U.input = mk('textarea', 'dsx-input');
    U.input.rows = 1;
    U.input.placeholder = '给 dsh 发消息…（Enter 发送，Shift+Enter 换行）';
    U.input.setAttribute('aria-label', '消息输入框');
    var crow = mk('div', 'dsx-composer-row');
    var cleft = mk('div', 'dsx-composer-left');
    U.planChip = mk('button', 'dsx-chip dsx-plan-chip', 'Plan');
    U.planChip.type = 'button';
    U.planChip.hidden = true;
    U.planChip.title = '计划模式已开启';
    U.btnImage = mk('button', 'dsx-chip dsx-img-btn', '图片');
    U.btnImage.type = 'button';
    U.btnImage.title = '选一张图片附到这条消息';
    U.btnImage.setAttribute('aria-label', '添加图片');
    U.hint = mk('span', 'dsx-hint');
    cleft.appendChild(U.planChip);
    cleft.appendChild(U.btnImage);
    cleft.appendChild(U.hint);
    var cright = mk('div', 'dsx-composer-right');
    U.btnSend = mk('button', 'dsx-btn dsx-btn-primary dsx-send', '发送');
    U.btnSend.type = 'button';
    cright.appendChild(U.btnSend);
    crow.appendChild(cleft);
    crow.appendChild(cright);
    U.composer.appendChild(U.input);
    // 已选图片的缩略图条（有图才显示）
    U.attach = mk('div', 'dsx-attach');
    U.attach.hidden = true;
    U.composer.appendChild(U.attach);
    U.composer.appendChild(crow);
    U.meter = mk('div', 'dsx-meter');
    bottom.appendChild(U.dock);
    bottom.appendChild(U.cards);
    bottom.appendChild(U.composer);
    bottom.appendChild(U.meter);

    U.notices = mk('div', 'dsx-notices');
    U.menuHost = mk('div', 'dsx-menu-host');

    app.appendChild(hd);
    app.appendChild(transcript);
    app.appendChild(bottom);
    app.appendChild(U.notices);
    app.appendChild(U.menuHost);

    // .dsx-app 用 position:fixed 铺满 webview 视口，挂载容器自身的定位/高度都不必关心，
    // 这样扩展侧生成的 HTML 即使没有给 #dsx-root 设尺寸也不会出现空白面板。
    root.appendChild(app);
  }

  function chip(text) {
    var b = mk('button', 'dsx-chip');
    b.type = 'button';
    b.appendChild(mk('span', 'dsx-chip-text', text));
    b.appendChild(mk('span', 'dsx-caret', '▾'));
    return b;
  }

  /**
   * 胶囊的「主值 + 副值」两段式文本。
   * 副值（例如推理档「中」）在窄面板下由 CSS 隐藏，只留当前值。
   */
  function chipParts(btn, main, sub) {
    var t = btn.querySelector('.dsx-chip-text');
    if (t) t.textContent = main;
    var s = btn.querySelector('.dsx-chip-sub');
    if (sub) {
      if (!s) {
        s = mk('span', 'dsx-chip-sub', sub);
        var caret = btn.querySelector('.dsx-caret');
        if (caret) btn.insertBefore(s, caret); else btn.appendChild(s);
      } else {
        s.textContent = sub;
      }
    } else if (s && s.parentNode) {
      s.parentNode.removeChild(s);
    }
  }

  /** 带头/短两套文案的按钮：窄面板下只显示短文案（CSS 切换） */
  function actionBtn(longText, shortText) {
    var b = mk('button', 'dsx-btn');
    b.type = 'button';
    b.appendChild(mk('span', 'dsx-btn-long', longText));
    if (shortText) b.appendChild(mk('span', 'dsx-btn-short', shortText));
    return b;
  }

  function chipLabel(btn, text) {
    chipParts(btn, text, '');
  }

  // ═══════════════════════════ 6. 顶栏渲染 ═══════════════════════════

  function currentTitle() {
    var t = str(S.sessionTitle) || str(S.projections.title);
    if (t) return t;
    for (var i = 0; i < S.sessions.length; i++) {
      if (S.sessions[i] && S.sessions[i].sessionId === S.sessionId) return str(S.sessions[i].title, '未命名会话');
    }
    return S.sessionId ? '未命名会话' : '新会话';
  }

  function renderHeader() {
    // 连接状态点
    U.dot.className = 'dsx-dot ' + (S.connected ? (S.running ? 'dsx-dot-run' : 'dsx-dot-ok') : 'dsx-dot-bad');
    U.dot.title = S.connected ? (S.running ? '已连接 · 运行中' : '已连接') : '未连接';

    var titleText = currentTitle();
    U.title.textContent = titleText;
    U.title.title = titleText;
    U.sub.textContent = S.cwd ? S.cwd : '';
    U.sub.title = S.cwd ? S.cwd : '';

    // 模型：主值=模型名，副值=推理档（窄面板下副值被 CSS 隐藏）
    var modelMain = '模型';
    var modelSub = '';
    var sel = S.selection;
    if (sel && sel.model) {
      modelMain = modelName(sel);
      if (sel.reasoningEffort) modelSub = '· ' + effortName(sel);
    } else if (S.projections.modelSelection && S.projections.modelSelection.next) {
      var nx = S.projections.modelSelection.next;
      modelMain = str(nx.model, '模型');
      if (nx.reasoningEffort) modelSub = '· ' + nx.reasoningEffort;
    }
    chipParts(U.btnModels, modelMain, modelSub);

    // 权限
    var permText = '权限';
    var cur = S.permissions.current || '';
    for (var i = 0; i < S.permissions.presets.length; i++) {
      if (S.permissions.presets[i].id === cur) { permText = str(S.permissions.presets[i].name, cur); break; }
    }
    if (permText === '权限' && cur) permText = cur;
    chipParts(U.btnPerms, permText, '');

    // 会话数量放副值，窄面板隐藏
    U.btnSessions.hidden = !S.sessions.length;
    chipParts(U.btnSessions, '会话', S.sessions.length > 1 ? String(S.sessions.length) : '');
    U.btnStop.hidden = !S.running;
    var activeRow = null;
    for (var j = 0; j < S.sessions.length; j++) {
      if (S.sessions[j] && S.sessions[j].active) activeRow = S.sessions[j];
    }
    if (!activeRow) {
      for (var k = 0; k < S.sessions.length; k++) {
        if (S.sessions[k] && S.sessions[k].sessionId === S.sessionId) activeRow = S.sessions[k];
      }
    }
    U.btnSessions.title = activeRow ? '当前所在：' + str(activeRow.cwd, '') : '切换会话';
  }

  function modelName(sel) {
    var catalog = S.catalog;
    if (catalog && Array.isArray(catalog.groups)) {
      for (var i = 0; i < catalog.groups.length; i++) {
        var g = catalog.groups[i];
        if (!g || !Array.isArray(g.models)) continue;
        if (g.id !== sel.provider) continue;
        for (var j = 0; j < g.models.length; j++) {
          var m = g.models[j];
          if (m && m.id === sel.model) return str(m.name, m.id);
        }
      }
    }
    return str(sel.model);
  }

  function effortName(sel) {
    var catalog = S.catalog;
    if (catalog && Array.isArray(catalog.groups)) {
      for (var i = 0; i < catalog.groups.length; i++) {
        var g = catalog.groups[i];
        if (!g || !Array.isArray(g.models)) continue;
        for (var j = 0; j < g.models.length; j++) {
          var m = g.models[j];
          if (!m || m.id !== sel.model || !Array.isArray(m.efforts)) continue;
          for (var k = 0; k < m.efforts.length; k++) {
            if (m.efforts[k] && m.efforts[k].id === sel.reasoningEffort) return str(m.efforts[k].name, sel.reasoningEffort);
          }
        }
      }
    }
    return str(sel.reasoningEffort);
  }

  // ═══════════════════════════ 7. 弹层（模型/权限/会话）═══════════════════════════

  function openMenu(trigger, build) {
    if (S.menu && S.menu.trigger === trigger) { closeMenus(); return; }
    closeMenus();
    var menu = mk('div', 'dsx-menu');
    build(menu);
    U.menuHost.appendChild(menu);
    var r = trigger.getBoundingClientRect();
    var mw = menu.offsetWidth || 260;
    var mh = menu.offsetHeight || 200;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    S.menu = { el: menu, trigger: trigger };
    trigger.setAttribute('aria-expanded', 'true');
    setTimeout(function () { document.addEventListener('mousedown', onDocMouseDown, true); }, 0);
  }

  function onDocMouseDown(e) {
    if (!S.menu) return;
    if (S.menu.el.contains(e.target) || S.menu.trigger.contains(e.target)) return;
    closeMenus();
  }

  function closeMenus() {
    if (S.menu) {
      try { S.menu.trigger.setAttribute('aria-expanded', 'false'); } catch (err) { /* ignore */ }
      if (S.menu.el.parentNode) S.menu.el.parentNode.removeChild(S.menu.el);
      S.menu = null;
    }
    document.removeEventListener('mousedown', onDocMouseDown, true);
  }

  /** 模型选择：左列 provider 分组 + 模型，右列 efforts（二级菜单） */
  function openModelMenu(trigger) {
    openMenu(trigger, function (menu) {
      menu.classList.add('dsx-menu-models');
      var catalog = S.catalog;
      if (!catalog || !Array.isArray(catalog.groups) || !catalog.groups.length) {
        menu.appendChild(mk('div', 'dsx-menu-empty', '模型目录尚未就绪'));
        return;
      }
      var wrap = mk('div', 'dsx-models');
      var left = mk('div', 'dsx-models-left');
      var right = mk('div', 'dsx-models-right');
      var sel = S.selection || {};
      var currentRow = null;

      function showEfforts(groupId, model) {
        clearChildren(right);
        right.appendChild(mk('div', 'dsx-menu-group', str(model.name, str(model.id, '')) + ' 的推理档'));
        var efforts = Array.isArray(model.efforts) ? model.efforts : [];
        if (!efforts.length) {
          var only = mk('button', 'dsx-menu-item', '使用默认档');
          only.type = 'button';
          only.addEventListener('click', function () { chooseModel(groupId, model.id, model.defaultEffort); });
          right.appendChild(only);
          return;
        }
        for (var i = 0; i < efforts.length; i++) {
          (function (eff) {
            if (!eff) return;
            var row = mk('button', 'dsx-menu-item');
            row.type = 'button';
            row.appendChild(mk('span', 'dsx-menu-item-label', str(eff.name, str(eff.id, ''))));
            var isCur = sel.provider === groupId && sel.model === model.id &&
              (sel.reasoningEffort || '') === (eff.id || '');
            if (isCur) row.appendChild(mk('span', 'dsx-menu-check', '✓'));
            row.title = str(eff.description, '');
            row.addEventListener('click', function () {
              var eid = eff.id;
              chooseModel(groupId, model.id, eid);
            });
            right.appendChild(row);
          })(efforts[i]);
        }
        if (model.description && !efforts.length) {
          right.appendChild(mk('div', 'dsx-menu-note', str(model.description)));
        }
      }

      for (var i = 0; i < catalog.groups.length; i++) {
        var g = catalog.groups[i];
        if (!g || !Array.isArray(g.models)) continue;
        left.appendChild(mk('div', 'dsx-menu-group', str(g.name, str(g.id, 'provider'))));
        for (var j = 0; j < g.models.length; j++) {
          (function (group, model) {
            if (!model) return;
            var row = mk('button', 'dsx-menu-item dsx-model-row');
            row.type = 'button';
            row.appendChild(mk('span', 'dsx-menu-item-label', str(model.name, str(model.id, '?'))));
            var isCur = sel.provider === group.id && sel.model === model.id;
            if (isCur) {
              row.appendChild(mk('span', 'dsx-menu-check', '✓'));
              currentRow = { group: group, model: model };
            }
            if (Array.isArray(model.efforts) && model.efforts.length) row.appendChild(mk('span', 'dsx-menu-caret', '›'));
            row.addEventListener('mouseenter', function () { showEfforts(group.id, model); });
            row.addEventListener('focus', function () { showEfforts(group.id, model); });
            row.addEventListener('click', function () {
              if (!Array.isArray(model.efforts) || !model.efforts.length) {
                chooseModel(group.id, model.id, model.defaultEffort);
                return;
              }
              showEfforts(group.id, model);
            });
            left.appendChild(row);
          })(g, g.models[j]);
        }
      }

      wrap.appendChild(left);
      wrap.appendChild(right);
      menu.appendChild(wrap);

      if (catalog.failures && catalog.failures.length) {
        for (var f = 0; f < catalog.failures.length; f++) {
          var fail = catalog.failures[f];
          if (!fail) continue;
          menu.appendChild(mk('div', 'dsx-menu-note dsx-menu-warn',
            '加载失败 · ' + str(fail.name, '?') + '：' + firstLine(str(fail.message), 80)));
        }
      }

      // 初始右列 = 当前模型
      if (currentRow) showEfforts(currentRow.group.id, currentRow.model);
      else if (catalog.default) showEfforts(catalog.default.provider, findModel(catalog.default) || { id: catalog.default.model, efforts: [] });
    });
  }

  function findModel(selection) {
    var catalog = S.catalog;
    if (!catalog || !Array.isArray(catalog.groups)) return null;
    for (var i = 0; i < catalog.groups.length; i++) {
      var g = catalog.groups[i];
      if (!g || g.id !== selection.provider || !Array.isArray(g.models)) continue;
      for (var j = 0; j < g.models.length; j++) {
        if (g.models[j] && g.models[j].id === selection.model) return g.models[j];
      }
    }
    return null;
  }

  function chooseModel(provider, model, effort) {
    var selection = { provider: provider, model: model };
    if (effort) selection.reasoningEffort = effort;
    S.selection = selection;
    post({ type: 'select-model', selection: selection });
    closeMenus();
    renderHeader();
  }

  function openPermissionMenu(trigger) {
    openMenu(trigger, function (menu) {
      menu.classList.add('dsx-menu-perms');
      menu.appendChild(mk('div', 'dsx-menu-group', '权限档'));
      var presets = S.permissions.presets || [];
      if (!presets.length) {
        menu.appendChild(mk('div', 'dsx-menu-empty', '权限档目录尚未就绪'));
        return;
      }
      for (var i = 0; i < presets.length; i++) {
        (function (p) {
          if (!p) return;
          var row = mk('button', 'dsx-menu-item');
          row.type = 'button';
          row.appendChild(mk('span', 'dsx-menu-item-label', str(p.name, str(p.id, ''))));
          if (p.id === S.permissions.current) row.appendChild(mk('span', 'dsx-menu-check', '✓'));
          if (p.description) row.title = str(p.description);
          row.addEventListener('click', function () {
            post({ type: 'set-permission', preset: p.id });
            closeMenus();
          });
          if (p.description) menu.appendChild(row), row.appendChild(mk('div', 'dsx-menu-desc', str(p.description)));
          else menu.appendChild(row);
        })(presets[i]);
      }
    });
  }

  function openSessionsMenu(trigger) {
    openMenu(trigger, function (menu) {
      menu.classList.add('dsx-menu-sessions');
      menu.appendChild(mk('div', 'dsx-menu-group', '会话'));
      if (!S.sessions.length) {
        menu.appendChild(mk('div', 'dsx-menu-empty', '暂无会话'));
      }
      for (var i = 0; i < S.sessions.length; i++) {
        (function (row) {
          if (!row) return;
          var item = mk('button', 'dsx-menu-item dsx-session-row');
          item.type = 'button';
          item.appendChild(mk('span', 'dsx-dot ' + (row.running ? 'dsx-dot-run' : 'dsx-dot-idle')));
          item.appendChild(mk('span', 'dsx-menu-item-label', str(row.title, row.sessionId || '未命名会话')));
          if (row.sessionId === S.sessionId || row.active) item.appendChild(mk('span', 'dsx-menu-check', '✓'));
          if (row.updatedAt) item.title = '更新于 ' + formatClock(row.updatedAt);
          item.addEventListener('click', function () {
            post({ type: 'open-session', sessionId: row.sessionId });
            closeMenus();
          });
          menu.appendChild(item);
        })(S.sessions[i]);
      }
      var sep = mk('div', 'dsx-menu-sep');
      menu.appendChild(sep);
      var add = mk('button', 'dsx-menu-item dsx-menu-action', '＋ 新建会话');
      add.type = 'button';
      add.addEventListener('click', function () {
        post({ type: 'new-session' });
        closeMenus();
      });
      menu.appendChild(add);
    });
  }

  // ═══════════════════════════ 8. 消息流基础 ═══════════════════════════

  function nearBottom() {
    var t = U.transcript;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 48;
  }

  function stickToBottom(force) {
    if (force || S.follow) {
      U.transcript.scrollTop = U.transcript.scrollHeight;
      S.follow = true;
      U.jump.hidden = true;
    }
  }

  /** 取当前轮容器；turnNo 变化时新建轮次分组 */
  function getTurn(turnNo, time) {
    var key = typeof turnNo === 'number' ? String(turnNo) : 'cur';
    if (S.curTurn && (turnNo === null || turnNo === undefined || S.curTurn.key === key)) return S.curTurn.el;
    return newTurn(turnNo, time);
  }

  function newTurn(turnNo, time) {
    var sec = mk('section', 'dsx-turn');
    var head = mk('div', 'dsx-turn-hd');
    var label = mk('span', 'dsx-turn-label',
      (typeof turnNo === 'number' && turnNo > 0) ? '第 ' + turnNo + ' 轮' : '会话开始');
    head.appendChild(label);
    if (time) head.appendChild(mk('span', 'dsx-turn-time', formatClock(time)));
    sec.appendChild(head);
    U.inner.appendChild(sec);
    S.curTurn = { key: typeof turnNo === 'number' ? String(turnNo) : 'cur', el: sec, head: head };
    return sec;
  }

  /** 往当前轮里追加节点，并处理贴底滚动与空态 */
  function appendToTurn(node, turnNo, time, opts) {
    if (!node) return null;
    var turn = getTurn(turnNo, time);
    turn.appendChild(node);
    onContentAdded(opts);
    return node;
  }

  function onContentAdded(opts) {
    S.msgCount += 1;
    updateEmpty();
    if (!opts || !opts.noScroll) stickToBottom();
  }

  function updateEmpty() {
    var show = S.msgCount === 0;
    U.empty.hidden = !show;
    if (!show) return;
    renderEmptyState();
  }

  // ═══════════════════════════ 9. 事件渲染 ═══════════════════════════

  function applyEvent(ev) {
    if (!isObj(ev)) return;
    var seq = num(ev.seq);
    if (seq !== null) {
      if (S.lastSeq && seq <= S.lastSeq) return; // 去重
      S.lastSeq = seq;
    }
    var type = str(ev.type);
    var d = isObj(ev.data) ? ev.data : {};

    switch (type) {
      case 'user/message': return renderUserMessage(ev, d);
      case 'assistant/message': return renderAssistantMessage(ev, d);
      case 'assistant/attempt': return renderAssistantAttempt(ev, d);
      case 'system/message': return renderSystemMessage(ev, d);
      case 'tool/call': return renderToolCall(ev, d);
      case 'tool/result': return renderToolResult(ev, d);
      case 'turn/start': return renderTurnStart(ev, d);
      case 'turn/end': return renderTurnEnd(ev, d);
      case 'step/start':
      case 'step/end': return renderStep(ev, d, type === 'step/end');
      case 'session/title': {
        S.sessionTitle = str(d.title, S.sessionTitle);
        renderHeader();
        return null;
      }
      case 'command/run': return renderCommandRun(ev, d);
      case 'command/done': return renderCommandDone(ev, d);
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end': return renderCompaction(ev, d, type);
      case 'deliverables/presented': return renderDeliverables(ev, d);
      case 'plan/mode': {
        var plan = isObj(S.projections.plan) ? S.projections.plan : null;
        S.projections.plan = { active: !!d.active, pending: plan ? !!plan.pending : false };
        renderCards();
        return null;
      }
      case 'todo/write': {
        S.projections.todos = Array.isArray(d.todos) ? d.todos : null;
        renderCards();
        return null;
      }
      default:
        if (SILENT_EVENTS[type]) return null;
        return renderGenericEvent(ev, d, type);
    }
  }

  function msgBase(extraCls) {
    return mk('div', 'dsx-msg ' + (extraCls || ''));
  }

  // ── user/message ──
  function renderUserMessage(ev, d) {
    var info = sourceInfo(d.source);
    var text = blockTexts(d.content);
    if (!text.trim()) return null;

    if (!info.human) {
      var det = mk('details', 'dsx-inject');
      var sum = mk('summary', 'dsx-inject-hd');
      sum.appendChild(mk('span', 'dsx-inject-tag', info.label));
      var preview = info.summary || firstLine(text, 80);
      sum.appendChild(mk('span', 'dsx-inject-preview', preview));
      det.appendChild(sum);
      var body = mk('div', 'dsx-inject-body');
      body.innerHTML = renderMarkdown(text);
      det.appendChild(body);
      return appendToTurn(det, num(d.turn), ev.time);
    }

    var node = msgBase('dsx-user');
    var meta = mk('div', 'dsx-user-meta');
    meta.appendChild(mk('span', 'dsx-user-time', formatClock(ev.time)));
    var bubble = mk('div', 'dsx-user-bubble');
    var md = mk('div', 'dsx-md');
    md.innerHTML = renderMarkdown(text);
    bubble.appendChild(md);
    node.appendChild(meta);
    node.appendChild(bubble);
    return appendToTurn(node, num(d.turn), ev.time);
  }

  // ── assistant/message ──
  function renderAssistantMessage(ev, d) {
    // 权威消息到达：移除同一条流式占位，避免重复
    dropStreamNode();
    var msg = isObj(d.message) ? d.message : {};
    var content = Array.isArray(msg.content) ? msg.content : [];
    var node = msgBase('dsx-assistant');
    var any = false;

    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (!isObj(b)) continue;
      if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()) {
        node.appendChild(reasoningBlock(b.text, '', false));
        any = true;
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        var body = mk('div', 'dsx-md');
        body.innerHTML = renderMarkdown(b.text);
        node.appendChild(body);
        any = true;
      } else if (b.type === 'image') {
        node.appendChild(mk('div', 'dsx-block-note', '[图片输出]'));
        any = true;
      }
    }

    if (d.interrupted) {
      var tag = mk('span', 'dsx-tag dsx-tag-warn', '已中断');
      node.insertBefore(tag, node.firstChild);
    }
    if (!any) {
      node.appendChild(mk('div', 'dsx-block-note', d.interrupted ? '（回合中断，无可见输出）' : '（空回复）'));
    }
    return appendToTurn(node, num(d.turn), ev.time);
  }

  function reasoningBlock(text, meta, openByDefault) {
    var det = mk('details', 'dsx-think');
    if (openByDefault) det.open = true;
    var sum = mk('summary', 'dsx-think-hd');
    sum.appendChild(mk('span', 'dsx-think-label', '思考过程'));
    if (meta) sum.appendChild(mk('span', 'dsx-think-meta', meta));
    else sum.appendChild(mk('span', 'dsx-think-meta', text.length + ' 字'));
    det.appendChild(sum);
    var body = mk('div', 'dsx-think-body dsx-md');
    body.innerHTML = renderMarkdown(text);
    det.appendChild(body);
    return det;
  }

  // ── assistant/attempt（未采用的尝试）──
  function renderAssistantAttempt(ev, d) {
    var stream = Array.isArray(d.stream) ? d.stream : [];
    var text = '';
    for (var i = 0; i < stream.length; i++) {
      var rec = stream[i];
      if (isObj(rec) && typeof rec.text === 'string') text += rec.text;
    }
    var det = mk('details', 'dsx-attempt');
    var sum = mk('summary', 'dsx-attempt-hd');
    sum.appendChild(mk('span', 'dsx-attempt-label', '一次未采用的尝试'));
    sum.appendChild(mk('span', 'dsx-attempt-meta', stream.length + ' 段流'));
    det.appendChild(sum);
    var body = mk('div', 'dsx-attempt-body');
    body.innerHTML = renderMarkdown(text || '（无文本输出）');
    det.appendChild(body);
    return appendToTurn(det, num(d.turn), ev.time);
  }

  // ── system/message ──
  function renderSystemMessage(ev, d) {
    var msg = isObj(d.message) ? d.message : {};
    var text = blockTexts(msg.content);
    if (!text.trim()) return null;
    var det = mk('details', 'dsx-system');
    var sum = mk('summary', 'dsx-system-hd');
    sum.appendChild(mk('span', 'dsx-system-tag', '系统提示'));
    sum.appendChild(mk('span', 'dsx-system-meta', text.length + ' 字'));
    det.appendChild(sum);
    var body = mk('div', 'dsx-system-body');
    var pre = mk('pre', 'dsx-pre dsx-system-pre', text);
    body.appendChild(pre);
    det.appendChild(body);
    return appendToTurn(det, num(d.turn), ev.time);
  }

  // ── tool/call ──
  function renderToolCall(ev, d) {
    var name = str(d.name, 'tool');
    var callId = str(d.callId, 'call-' + (S.lastSeq || 0));
    var rawArgs = typeof d.arguments === 'string' ? d.arguments : prettyJsonText(d.arguments);
    var card = buildToolCard(name, callId, rawArgs, ev.time);
    S.tools[callId] = { el: card.root, time: num(ev.time) || Date.now(), name: name, filled: false, outPre: card.outPre, outSec: card.outSec, errSec: card.errSec, errPre: card.errPre, stateEl: card.stateEl, root: card.root };
    return appendToTurn(card.root, num(d.turn), ev.time);
  }

  function buildToolCard(name, callId, rawArgs, time) {
    var root = mk('div', 'dsx-tool dsx-tool-running');
    root.setAttribute('data-call-id', callId);
    var det = mk('details', 'dsx-tool-details');
    var sum = mk('summary', 'dsx-tool-hd');
    sum.appendChild(mk('span', 'dsx-tool-glyph', '▣'));
    sum.appendChild(mk('span', 'dsx-tool-name', name));
    sum.appendChild(mk('span', 'dsx-tool-sum', summarizeToolCall(name, rawArgs)));
    var stateEl = mk('span', 'dsx-tool-state', '运行中…');
    sum.appendChild(stateEl);
    det.appendChild(sum);

    var body = mk('div', 'dsx-tool-body');
    var argsSec = mk('div', 'dsx-tool-sec');
    argsSec.appendChild(mk('div', 'dsx-sec-hd', '参数'));
    argsSec.appendChild(mk('pre', 'dsx-pre', prettyJsonText(rawArgs)));
    body.appendChild(argsSec);

    var outSec = mk('div', 'dsx-tool-sec');
    outSec.appendChild(mk('div', 'dsx-sec-hd', '输出'));
    var outPre = mk('pre', 'dsx-pre dsx-out');
    outSec.appendChild(outPre);
    outSec.hidden = true;
    body.appendChild(outSec);

    var errSec = mk('div', 'dsx-tool-sec dsx-tool-err');
    var errHd = mk('div', 'dsx-sec-hd', '错误');
    errSec.appendChild(errHd);
    var errPre = mk('pre', 'dsx-pre');
    errSec.appendChild(errPre);
    errSec.hidden = true;
    body.appendChild(errSec);

    det.appendChild(body);
    root.appendChild(det);
    return { root: root, stateEl: stateEl, outSec: outSec, outPre: outPre, errSec: errSec, errPre: errPre };
  }

  // ── tool/result ──
  function renderToolResult(ev, d) {
    var msg = isObj(d.message) ? d.message : {};
    var callId = str(msg.toolCallId, '');
    var rec = callId ? S.tools[callId] : null;
    var text = blockTexts(msg.content);
    var isError = msg.isError === true;

    if (!rec) {
      // 历史被裁剪：单独补一张结果卡，避免丢信息
      rec = buildToolCard('tool result', callId || 'result-' + (S.lastSeq || 0), '{}', ev.time);
      rec.stateEl.textContent = '';
      appendToTurn(rec.root, num(d.turn), ev.time);
      S.tools[callId || 'result-loose'] = rec;
    }

    var dur = '';
    if (rec.time) dur = formatDuration((num(ev.time) || Date.now()) - rec.time);
    rec.outPre.textContent = text || '（无输出）';
    rec.outSec.hidden = false;

    var exitCode = isObj(d.meta) ? num(d.meta.exitCode) : null;
    var reason = isObj(d.error) ? str(d.error.reason) : '';

    if (isError) {
      rec.root.classList.remove('dsx-tool-running');
      rec.root.classList.add('dsx-tool-error');
      rec.stateEl.textContent = '失败' + (dur ? ' · ' + dur : '');
      var detail = reason || (isObj(d.error) ? str(d.error.name) : '') || text.slice(0, 400);
      rec.errPre.textContent = detail || '（未提供错误详情）';
      rec.errSec.hidden = false;
    } else {
      rec.root.classList.remove('dsx-tool-running');
      rec.root.classList.add('dsx-tool-ok');
      var st = '成功' + (dur ? ' · ' + dur : '');
      if (exitCode !== null) st += (exitCode === 0 ? ' · exit 0' : ' · exit ' + exitCode);
      rec.stateEl.textContent = st;
    }
    if (exitCode !== null && exitCode !== 0) {
      rec.stateEl.classList.add('dsx-exit-bad');
    }
    rec.filled = true;
    return null;
  }

  // ── 轮次 / 步骤边界 ──
  function renderTurnStart(ev, d) {
    var turnNo = num(d.turn);
    if (turnNo !== null && S.curTurn && S.curTurn.key === String(turnNo)) return null;
    var sec = newTurn(turnNo, ev.time);
    S.turns[turnNo === null ? '?' : turnNo] = { time: num(ev.time) || Date.now() };
    S.curTurn.el = sec;
    S.msgCount += 1;
    updateEmpty();
    stickToBottom();
    return null;
  }

  function renderTurnEnd(ev, d) {
    var turnNo = num(d.turn);
    var rec = S.turns[turnNo === null ? '?' : turnNo];
    var dur = rec && rec.time ? formatDuration((num(ev.time) || Date.now()) - rec.time) : '';
    var reason = isObj(d.reason) ? d.reason : {};
    var kind = str(reason.kind, '');
    var label = TURN_END_LABELS[kind] || kind || '结束';
    var row = mk('div', 'dsx-turn-ft');
    row.appendChild(mk('span', 'dsx-turn-ft-label', '本轮' + label));
    if (dur) row.appendChild(mk('span', 'dsx-turn-ft-meta', dur));
    if (typeof reason.error === 'string' && reason.error) {
      row.appendChild(mk('span', 'dsx-turn-ft-meta dsx-warn-text', firstLine(reason.error, 120)));
    }
    // 改动卡要求排在本轮最末：若卡片先到，脚注插到它前面
    var turnEl = getTurn(turnNo, ev.time);
    var firstChg = turnEl.querySelector('.dsx-changes');
    if (firstChg) turnEl.insertBefore(row, firstChg);
    else turnEl.appendChild(row);
    onContentAdded();
    return null;
  }

  function renderStep(ev, d, isEnd) {
    var step = num(d.step);
    var turnNo = num(d.turn);
    var key = (turnNo === null ? '?' : turnNo) + ':' + (step === null ? '?' : step);
    if (!isEnd) {
      var row = mk('div', 'dsx-step dsx-step-start');
      row.appendChild(mk('span', 'dsx-step-label', '步骤 ' + (step === null ? '?' : step)));
      if (ev.time) row.appendChild(mk('span', 'dsx-step-meta', formatClock(ev.time)));
      var turn = getTurn(turnNo, ev.time);
      turn.appendChild(row);
      S.stepStart = { key: key, time: num(ev.time) || Date.now() };
      S.msgCount += 1;
      updateEmpty();
      return null;
    }
    if (S.stepStart && S.stepStart.key === key) {
      var dur = formatDuration((num(ev.time) || Date.now()) - S.stepStart.time);
      var last = U.inner.querySelector('.dsx-turn:last-child .dsx-step-start:last-of-type');
      if (last && dur) {
        var meta = mk('span', 'dsx-step-meta', dur);
        last.appendChild(meta);
        last.classList.add('dsx-step-done');
      }
    }
    return null;
  }

  // ── 命令 ──
  function renderCommandRun(ev, d) {
    var name = str(d.name, '');
    var args = str(d.args, '');
    if (!name) return null;
    var node = msgBase('dsx-cmd');
    var meta = mk('div', 'dsx-user-meta');
    meta.appendChild(mk('span', 'dsx-cmd-tag', '命令输入'));
    if (ev.time) meta.appendChild(mk('span', 'dsx-user-time', formatClock(ev.time)));
    var bubble = mk('div', 'dsx-user-bubble dsx-cmd-bubble');
    var md = mk('div', 'dsx-md');
    md.innerHTML = renderMarkdown('/' + name + (args ? ' ' + args : ''));
    bubble.appendChild(md);
    var result = mk('div', 'dsx-cmd-result');
    result.hidden = true;
    bubble.appendChild(result);
    node.appendChild(meta);
    node.appendChild(bubble);
    var id = str(d.commandId, '');
    if (id) S.commands[id] = result;
    return appendToTurn(node, null, ev.time);
  }

  function renderCommandDone(ev, d) {
    var id = str(d.commandId, '');
    var box = id ? S.commands[id] : null;
    var text = str(d.text, '');
    if (!box) return null;
    box.hidden = false;
    box.textContent = text || (d.kind === 'error' ? '命令失败' : '命令完成');
    box.className = 'dsx-cmd-result ' + (d.kind === 'error' ? 'dsx-cmd-error' : 'dsx-cmd-ok');
    return null;
  }

  // ── 上下文压缩 ──
  function renderCompaction(ev, d, type) {
    if (type === 'compaction/start') {
      var line = mk('div', 'dsx-compaction dsx-compaction-open');
      line.appendChild(mk('span', 'dsx-compaction-tag', '上下文压缩'));
      line.appendChild(mk('span', 'dsx-compaction-meta', '进行中…'));
      S.compactionEl = appendToTurn(line, num(d.turn), ev.time);
      return null;
    }
    if (type === 'compaction/summary') {
      var det = mk('details', 'dsx-compaction dsx-compaction-done');
      var sum = mk('summary', 'dsx-compaction-hd');
      sum.appendChild(mk('span', 'dsx-compaction-tag', '上下文已压缩'));
      var tokens = num(d.shadowedTokenCount);
      if (tokens !== null) sum.appendChild(mk('span', 'dsx-compaction-meta', formatTokens(tokens) + ' tokens 被摘要'));
      det.appendChild(sum);
      var body = mk('div', 'dsx-compaction-body dsx-md');
      body.innerHTML = renderMarkdown(blockTexts(d.summary) || '（无摘要文本）');
      det.appendChild(body);
      return appendToTurn(det, num(d.turn), ev.time);
    }
    // compaction/end
    if (S.compactionEl && S.compactionEl.parentNode) {
      S.compactionEl.classList.remove('dsx-compaction-open');
      var meta = S.compactionEl.querySelector('.dsx-compaction-meta');
      if (meta) meta.textContent = d.error ? '失败：' + firstLine(str(d.error), 100) : '完成';
    }
    return null;
  }

  // ── 交付文件 ──
  function renderDeliverables(ev, d) {
    var files = Array.isArray(d.files) ? d.files : [];
    if (!files.length) return null;
    var det = mk('details', 'dsx-deliver dsx-deliver-card');
    var sum = mk('summary', 'dsx-deliver-hd');
    sum.appendChild(mk('span', 'dsx-deliver-tag', '交付文件'));
    sum.appendChild(mk('span', 'dsx-deliver-meta', files.length + ' 个'));
    det.appendChild(sum);
    var list = mk('div', 'dsx-deliver-list');
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!isObj(f)) continue;
      var path = str(f.path, str(f.name, ''));
      var row = mk('div', 'dsx-deliver-row');
      row.appendChild(mk('span', 'dsx-deliver-path', path));
      var bytes = num(f.bytes);
      if (bytes !== null) row.appendChild(mk('span', 'dsx-deliver-size', formatBytes(bytes)));
      list.appendChild(row);
    }
    det.appendChild(list);
    return appendToTurn(det, num(d.turn), ev.time);
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return trimNum(n / 1024) + ' KB';
    return trimNum(n / (1024 * 1024)) + ' MB';
  }

  // ── 未知事件兜底 ──
  function renderGenericEvent(ev, d, type) {
    var det = mk('details', 'dsx-generic');
    var sum = mk('summary', 'dsx-generic-hd');
    sum.appendChild(mk('span', 'dsx-generic-tag', '事件'));
    sum.appendChild(mk('span', 'dsx-generic-name', type || 'unknown'));
    var preview = '';
    try { preview = firstLine(JSON.stringify(d), 80); } catch (e) { preview = ''; }
    if (preview) sum.appendChild(mk('span', 'dsx-generic-preview', preview));
    det.appendChild(sum);
    var body = mk('div', 'dsx-generic-body');
    var json = '';
    try { json = JSON.stringify(d, null, 2) || '{}'; } catch (e2) { json = String(d); }
    var pre = mk('pre', 'dsx-pre', json.length > 20000 ? json.slice(0, 20000) + '\n…（已截断）' : json);
    body.appendChild(pre);
    det.appendChild(body);
    return appendToTurn(det, null, ev.time);
  }

  // ═══════════════════════════ 9b. 改动可视化（changes / diff）═══════════════════════════
  // 卡片完全由 {type:'changes'} 消息驱动；session 事件 workspace/changes 是静默的，
  // 不会渲染成裸事件行（见 SILENT_EVENTS）。

  function chKeyOf(o) {
    return str(o.sessionId) + '|' + (num(o.seq) === null ? '' : String(num(o.seq)));
  }

  function diffKeyOf(d) {
    return chKeyOf(d) + '|' + (num(d.index) === null ? '' : String(num(d.index)));
  }

  /** 处理 {type:'changes'}：在该轮末尾（turn/end 之后）插一张改动卡 */
  function renderChanges(ch) {
    if (!isObj(ch)) return null;
    if (ch.sessionId && S.sessionId && ch.sessionId !== S.sessionId) return null; // 别的会话的残留
    var files = Array.isArray(ch.files) ? ch.files : [];
    if (!files.length) return null; // 空改动不渲染

    var key = chKeyOf(ch);
    var built = buildChangesCard(ch, key);
    var prev = S.changes[key];

    if (prev && prev.el && prev.el.parentNode) {
      // 同一条 changes 又来：覆盖旧卡片，不叠两张
      prev.el.parentNode.replaceChild(built.root, prev.el);
    } else {
      var turn = getTurn(num(ch.turn), Date.now());
      turn.appendChild(built.root);
    }

    S.changes[key] = { changes: ch, el: built.root, items: built.items };
    onContentAdded();
    return built.root;
  }

  function buildChangesCard(ch, key) {
    var root = mk('div', 'dsx-changes');
    root.setAttribute('data-chg-key', key);

    var hd = mk('div', 'dsx-chg-hd');
    var n = ch.files.length;
    var total = num(ch.total);
    hd.appendChild(mk('span', 'dsx-chg-title',
      '改动 ' + n + ' 个文件' + (total !== null && total !== n ? '（共 ' + total + '）' : '')));
    hd.appendChild(mk('span', 'dsx-chg-stat dsx-chg-add', '+' + (num(ch.added) || 0)));
    hd.appendChild(mk('span', 'dsx-chg-stat dsx-chg-del', '−' + (num(ch.deleted) || 0)));
    root.appendChild(hd);

    var list = mk('div', 'dsx-chg-files');
    var items = {};

    for (var i = 0; i < ch.files.length; i++) {
      var f = ch.files[i];
      if (!isObj(f)) continue;
      var index = num(f.index);
      if (index === null) index = i;

      var item = mk('div', 'dsx-chg-item');
      var row = mk('button', 'dsx-chg-file');
      row.type = 'button';
      row.setAttribute('aria-expanded', 'false');

      var nameEl = mk('span', 'dsx-chg-name', str(f.display, str(f.path, '(未知文件)')));
      nameEl.title = str(f.path);
      row.appendChild(nameEl);

      if (f.binary === true) {
        row.appendChild(mk('span', 'dsx-chg-badge', '二进制'));
      } else if (f.oversized === true) {
        row.appendChild(mk('span', 'dsx-chg-badge', '文件过大'));
      } else {
        var stat = mk('span', 'dsx-chg-stat');
        stat.appendChild(mk('span', 'dsx-chg-add', '+' + (num(f.added) || 0)));
        stat.appendChild(mk('span', 'dsx-chg-del', '−' + (num(f.deleted) || 0)));
        row.appendChild(stat);
      }

      // 「用编辑器打开」：展开后才出现，避免每行都挂一个按钮
      var openBtn = mk('button', 'dsx-chg-open', '用编辑器打开');
      openBtn.type = 'button';
      openBtn.hidden = true;
      openBtn.title = '在 VS Code 编辑器中打开 ' + str(f.path, '');
      openBtn.addEventListener('click', function (ev2) {
        ev2.stopPropagation();
        if (f.path) post({ type: 'open-file', path: str(f.path) });
      });
      row.appendChild(openBtn);

      // 「并排对比」：交给 VS Code 原生 diff 视图，比内联 hunk 更适合逐行看
      var sideBtn = mk('button', 'dsx-chg-open', '并排对比');
      sideBtn.type = 'button';
      sideBtn.hidden = true;
      sideBtn.title = '用 VS Code 原生 diff 打开 ' + str(f.path, '');
      sideBtn.addEventListener('click', function (ev2) {
        ev2.stopPropagation();
        if (!f.path) return;
        post({
          type: 'open-native-diff',
          sessionId: str(ch.sessionId),
          seq: num(ch.seq) || 0,
          index: num(index)
        });
      });
      row.appendChild(sideBtn);

      var slot = mk('div', 'dsx-chg-slot');
      slot.hidden = true;

      var rec = { index: index, file: f, row: row, slot: slot, openBtn: openBtn, sideBtn: sideBtn, open: false, diffEl: null };
      items[index] = rec;
      bindChangeRow(key, rec);
      item.appendChild(row);
      item.appendChild(slot);
      list.appendChild(item);
    }

    root.appendChild(list);
    return { root: root, items: items };
  }

  function bindChangeRow(key, rec) {
    rec.row.addEventListener('click', function () { toggleChangeFile(key, rec); });
  }

  /** 文件行开关：懒加载 diff，已加载过直接展开 */
  function toggleChangeFile(key, rec) {
    var entry = S.changes[key];
    if (!entry) return;
    if (rec.open) {
      rec.open = false;
      rec.slot.hidden = true;
      rec.row.setAttribute('aria-expanded', 'false');
      return;
    }
    rec.open = true;
    rec.slot.hidden = false;
    rec.row.setAttribute('aria-expanded', 'true');
    rec.openBtn.hidden = false;
    if (rec.sideBtn) rec.sideBtn.hidden = false;
    if (rec.diffEl) return; // 已加载，直接露出

    var cached = S.diffs[key + '|' + rec.index];
    if (cached) { fillDiffSlot(rec, cached); return; }

    rec.slot.textContent = '';
    rec.slot.appendChild(mk('div', 'dsx-chg-loading', '加载中…'));
    post({
      type: 'load-diff',
      sessionId: str(entry.changes.sessionId),
      seq: num(entry.changes.seq) || 0,
      index: rec.index
    });
  }

  /** 处理 {type:'diff'}：把结果填进对应文件行（行可能还没展开，先缓存） */
  function applyDiff(d) {
    if (!isObj(d)) return null;
    if (d.sessionId && S.sessionId && d.sessionId !== S.sessionId) return null;
    var key = diffKeyOf(d);
    S.diffs[key] = d;
    var entry = S.changes[chKeyOf(d)];
    if (!entry) return null;
    var idx = num(d.index);
    var rec = idx === null ? null : entry.items[idx];
    if (!rec) return null;
    if (rec.open) fillDiffSlot(rec, d);
    return rec;
  }

  function fillDiffSlot(rec, d) {
    rec.slot.textContent = '';
    rec.diffEl = buildDiff(d);
    rec.slot.appendChild(rec.diffEl);
    rec.slot.hidden = !rec.open;
  }

  /** diff 主体：hunk 头 + 逐行着色（+ 绿、- 红、空格透明） */
  function buildDiff(d) {
    var box = mk('div', 'dsx-diff');
    var kind = str(d.kind, 'text');

    if (kind === 'binary') {
      box.appendChild(mk('div', 'dsx-chg-note', '二进制文件，无法预览'));
      return box;
    }
    if (kind === 'oversized') {
      box.appendChild(mk('div', 'dsx-chg-note', '文件过大，无法预览'));
      return box;
    }
    if (d.coarse === true) {
      box.appendChild(mk('div', 'dsx-chg-note', '行级对比不可用，显示整体替换'));
    }

    var hunks = Array.isArray(d.hunks) ? d.hunks : [];
    if (!hunks.length) {
      box.appendChild(mk('div', 'dsx-chg-note', '无行级差异'));
      return box;
    }

    for (var i = 0; i < hunks.length; i++) {
      var h = hunks[i];
      if (!isObj(h)) continue;
      var hk = mk('div', 'dsx-hunk');
      hk.appendChild(mk('div', 'dsx-hunk-hd',
        '@@ -' + (num(h.oldStart) || 0) + ',' + (num(h.oldLines) || 0) +
        ' +' + (num(h.newStart) || 0) + ',' + (num(h.newLines) || 0) + ' @@'));

      var body = mk('div', 'dsx-hunk-body');
      var lines = Array.isArray(h.lines) ? h.lines : [];
      for (var j = 0; j < lines.length; j++) {
        var line = typeof lines[j] === 'string' ? lines[j] : String(lines[j] == null ? '' : lines[j]);
        var sign = line.charAt(0);
        var cls = sign === '+' ? 'dsx-dl-add' : (sign === '-' ? 'dsx-dl-del' : 'dsx-dl-ctx');
        var rowEl = mk('div', 'dsx-dl ' + cls);
        rowEl.appendChild(mk('span', 'dsx-dl-sign', sign === '+' || sign === '-' ? sign : ' '));
        rowEl.appendChild(mk('span', 'dsx-dl-text', line.slice(1)));
        body.appendChild(rowEl);
      }
      hk.appendChild(body);
      box.appendChild(hk);
    }
    return box;
  }

  /** records 里可能是 event，也可能是 changes/diff 卡片；统一走这里 */
  function applyRecord(rec) {
    if (!isObj(rec)) return;
    if (rec.type === 'event' && isObj(rec.event)) { applyEvent(rec.event); return; }
    if (rec.type === 'changes') { renderChanges(rec.changes); return; }
    if (rec.type === 'diff') { applyDiff(rec.diff); }
  }

  // ═══════════════════════════ 10. 流式渲染 ═══════════════════════════

  function ensureStream(frame) {
    if (S.stream && S.stream.attemptId === frame.attemptId && S.stream.node && S.stream.node.parentNode) return S.stream;
    dropStreamNode();
    var node = mk('div', 'dsx-msg dsx-assistant dsx-live');
    var hd = mk('div', 'dsx-live-hd');
    hd.appendChild(mk('span', 'dsx-live-pulse'));
    hd.appendChild(mk('span', 'dsx-live-text', '正在输出'));
    node.appendChild(hd);
    var blocks = mk('div', 'dsx-blocks');
    node.appendChild(blocks);
    appendToTurn(node, num(frame.turn), Date.now(), { noScroll: true });
    S.stream = {
      attemptId: frame.attemptId,
      revision: num(frame.revision) || 0,
      node: node, blocks: blocks, hd: hd,
      startTime: Date.now(), blockMap: {}, committed: false
    };
    stickToBottom();
    return S.stream;
  }

  function dropStreamNode() {
    if (S.stream && S.stream.node && S.stream.node.parentNode) {
      S.stream.node.parentNode.removeChild(S.stream.node);
    }
    S.stream = null;
  }

  function applyStream(frame) {
    if (!isObj(frame)) return;
    var rev = num(frame.revision) || 0;
    if (S.stream && rev && S.stream.revision && rev < S.stream.revision) return; // 旧 revision 丢弃
    switch (frame.type) {
      case 'start': {
        ensureStream(frame);
        return;
      }
      case 'chunk': {
        var st = ensureStream(frame);
        st.revision = rev || st.revision;
        applyChunk(st, frame);
        return;
      }
      case 'end': {
        if (!S.stream || S.stream.attemptId !== frame.attemptId) return;
        var outcome = isObj(frame.outcome) ? frame.outcome : {};
        if (outcome.kind === 'abandoned') {
          dropStreamNode();
          var line = mk('div', 'dsx-live-abort', '本次尝试被放弃');
          appendToTurn(line, null, Date.now());
        } else {
          S.stream.committed = true;
          var hd = S.stream.hd;
          if (hd) {
            clearChildren(hd);
            hd.appendChild(mk('span', 'dsx-live-done', '已输出'));
          }
          // 等权威 assistant/message 到达后替换；先停止光标动画
          var cur = S.stream.node.querySelectorAll('.dsx-typing');
          for (var i = 0; i < cur.length; i++) cur[i].classList.remove('dsx-typing');
        }
        return;
      }
      default: return;
    }
  }

  function applyChunk(st, frame) {
    var chunk = isObj(frame.chunk) ? frame.chunk : {};
    var index = num(chunk.index);
    if (index === null) index = 0;
    switch (chunk.type) {
      case 'block-start': {
        var blockType = chunk.blockType === 'reasoning' ? 'reasoning' : 'text';
        var box = mk('div', blockType === 'reasoning' ? 'dsx-think dsx-think-live' : 'dsx-md dsx-text-live');
        var body = mk('div', blockType === 'reasoning' ? 'dsx-think-body dsx-md' : 'dsx-text-body');
        if (blockType === 'reasoning') {
          var sum = mk('summary', 'dsx-think-hd');
          sum.appendChild(mk('span', 'dsx-think-label', '思考过程'));
          var metaEl = mk('span', 'dsx-think-meta', '写入中…');
          sum.appendChild(metaEl);
          box.appendChild(sum);
          box.appendChild(body);
          box.open = true;
        } else {
          box.appendChild(body);
        }
        st.blocks.appendChild(box);
        st.blockMap[index] = { type: blockType, el: box, body: body, raw: '', metaEl: metaEl || null, lastRender: 0, timer: null, touched: false };
        if (blockType === 'reasoning' && metaEl) {
          var sumEl = box.querySelector('summary');
          sumEl.addEventListener('click', function () { st.blockMap[index].touched = true; });
        }
        break;
      }
      case 'text-delta': {
        var rec = st.blockMap[index];
        if (!rec) {
          // 容错：没收到 block-start 也能渲染
          var fake = { type: 'text', index: index, blockType: 'text' };
          applyChunk(st, { chunk: { type: 'block-start', index: index, blockType: 'text' } });
          rec = st.blockMap[index];
          if (!rec) return;
        }
        var delta = typeof chunk.text === 'string' ? chunk.text : '';
        if (!delta) return;
        rec.raw += delta;
        // 先追加纯文本节点（即刻可见），markdown 按 150ms 节流重排
        if (rec.body) {
          var tail = rec.body.lastChild;
          if (tail && tail.nodeType === 3) tail.nodeValue += delta;
          else rec.body.appendChild(document.createTextNode(delta));
        }
        if (!rec.body.classList.contains('dsx-typing')) rec.body.classList.add('dsx-typing');
        scheduleRender(st, index, rec);
        if (st.hd) {
          var wrapNode = st.node;
          if (S.follow && wrapNode) stickToBottom();
        }
        break;
      }
      case 'block-end': {
        var rec2 = st.blockMap[index];
        var block = isObj(chunk.block) ? chunk.block : {};
        var full = typeof block.text === 'string' ? block.text : '';
        if (!rec2) {
          applyChunk(st, { chunk: { type: 'block-start', index: index, blockType: block.type === 'reasoning' ? 'reasoning' : 'text' } });
          rec2 = st.blockMap[index];
        }
        if (!rec2) return;
        if (rec2.timer) { clearTimeout(rec2.timer); rec2.timer = null; }
        rec2.raw = full || rec2.raw;
        if (rec2.body) {
          rec2.body.classList.remove('dsx-typing');
          rec2.body.innerHTML = renderMarkdown(rec2.raw);
        }
        if (rec2.type === 'reasoning') {
          var dur = formatDuration(Date.now() - st.startTime);
          if (rec2.metaEl) rec2.metaEl.textContent = rec2.raw.length + ' 字' + (dur ? ' · ' + dur : '');
          if (rec2.el && !rec2.touched) rec2.el.open = false;
        }
        break;
      }
      case 'usage': {
        var usage = isObj(chunk.usage) ? chunk.usage : {};
        mergeUsage(usage);
        renderMeter();
        break;
      }
      default: break;
    }
  }

  function scheduleRender(st, index, rec) {
    if (rec.timer) return;
    var now = Date.now();
    var wait = Math.max(0, 150 - (now - rec.lastRender));
    rec.timer = setTimeout(function () {
      rec.timer = null;
      if (!rec.body) return;
      rec.lastRender = Date.now();
      rec.body.innerHTML = renderMarkdown(rec.raw);
    }, wait);
  }

  // ═══════════════════════════ 11. 契约消息处理 ═══════════════════════════

  function applyInit(state) {
    if (!isObj(state)) state = {};
    S.connected = !!state.connected;
    S.authority = str(state.authority);
    S.cwd = str(state.cwd);
    S.sessionId = str(state.sessionId);
    S.sessionTitle = str(state.sessionTitle);
    S.sessions = Array.isArray(state.sessions) ? state.sessions : [];
    S.catalog = isObj(state.catalog) ? state.catalog : null;
    S.selection = isObj(state.selection) ? state.selection : (S.catalog ? S.catalog.default : null);
    S.permissions = {
      current: str((state.permissions || {}).current),
      presets: Array.isArray((state.permissions || {}).presets) ? state.permissions.presets : []
    };
    S.defaultPermission = str(state.defaultPermission);
    if (!S.permissions.current) S.permissions.current = S.defaultPermission;
    S.running = !!state.running;
    S.version = str(state.version);
    S.asks = [];
    renderDock(Array.isArray(state.asks) ? state.asks : []);
    renderHeader();
    updateComposerState();
    renderMeter();
    updateEmpty();
    if (!S.sessionId) S.msgCount = 0;
    updateEmpty();
  }

  function applyOpen(msg) {
    S.sessionId = str(msg.sessionId, S.sessionId);
    S.sessionTitle = str(msg.title, '');
    S.header = isObj(msg.header) ? msg.header : null;
    if (S.header && S.header.cwd && !S.cwd) S.cwd = str(S.header.cwd);
    S.usage = {};
    S.projections = isObj(msg.projections) && isObj(msg.projections.values) ? msg.projections.values : {};
    S.projectionsAsOf = num(msg.projections && msg.projections.asOfSeq) || 0;
    S.tools = {};
    S.commands = {};
    S.turns = {};
    S.changes = {};
    S.diffs = {};
    S.lastSeq = 0;
    S.curTurn = null;
    S.msgCount = 0;
    S.stepStart = null;
    S.compactionEl = null;
    dropStreamNode();
    clearChildren(U.inner);
    U.inner.appendChild(U.empty);
    U.inner.appendChild(U.loadOlder);
    U.loadOlder.hidden = !msg.hasMore;

    var records = Array.isArray(msg.records) ? msg.records : [];
    for (var i = 0; i < records.length; i++) {
      applyRecord(records[i]);
    }

    // 进行中的流式基线
    var baseline = isObj(msg.assistantStream) ? msg.assistantStream : null;
    if (baseline && isObj(baseline.activeAttempt)) {
      var att = baseline.activeAttempt;
      ensureStream({ attemptId: str(att.attemptId), revision: num(baseline.revision) || 0, turn: num(att.turn) });
      var chunks = Array.isArray(att.stream) ? att.stream : [];
      for (var c = 0; c < chunks.length; c++) applyChunk(S.stream, { chunk: chunks[c] });
    }

    renderHeader();
    renderCards();
    renderMeter();
    updateComposerState();
    updateEmpty();
    S.follow = true;
    // 打开会话默认贴底
    requestAnimationFrame(function () { stickToBottom(true); });
  }

  function applyRecords(records, prepend) {
    if (!Array.isArray(records)) return;
    if (!prepend) {
      for (var i = 0; i < records.length; i++) {
        applyRecord(records[i]);
      }
      stickToBottom();
      return;
    }
    // 向上翻页：先记录高度，插入后补偿滚动，保持阅读位置
    var before = U.transcript.scrollHeight;
    var holder = mk('div', 'dsx-prepend');
    var savedInner = U.inner;
    // 临时把 inner 指到 holder，让渲染落进 holder
    var savedTurn = S.curTurn;
    S.curTurn = null;
    U.inner = holder;
    S.msgCount -= 1; // 抵消 inserted 造成的计数噪声
    for (var j = 0; j < records.length; j++) {
      applyRecord(records[j]);
    }
    U.inner = savedInner;
    S.curTurn = savedTurn;
    var anchor = U.loadOlder;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(holder, anchor.nextSibling);
    else U.inner.appendChild(holder);
    S.msgCount += 1;
    U.transcript.scrollTop = U.transcript.scrollHeight - before;
    updateEmpty();
  }

  function applyReset() {
    // 断线重连：只清进行中的流式渲染，历史保留，等下一帧 open/snapshot
    dropStreamNode();
    var live = U.inner.querySelectorAll('.dsx-live');
    for (var i = 0; i < live.length; i++) {
      if (live[i].parentNode) live[i].parentNode.removeChild(live[i]);
    }
  }

  function applyProjections(values, asOfSeq) {
    if (!isObj(values)) return;
    var keys = Object.keys(values);
    for (var i = 0; i < keys.length; i++) S.projections[keys[i]] = values[keys[i]];
    if (typeof asOfSeq === 'number') S.projectionsAsOf = asOfSeq;
    renderHeader();
    renderCards();
    renderMeter();
  }

  function mergeUsage(usage) {
    if (!isObj(usage)) return;
    var keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'contextWindow', 'pressureTokens'];
    for (var i = 0; i < keys.length; i++) {
      var v = num(usage[keys[i]]);
      if (v !== null) S.usage[keys[i]] = v;
    }
    if (num(usage.totalTokens) === null) {
      var t = (num(usage.inputTokens) || 0) + (num(usage.outputTokens) || 0) +
        (num(usage.cacheReadTokens) || 0) + (num(usage.cacheWriteTokens) || 0);
      if (t) S.usage.totalTokens = t;
    }
  }

  function applyStatus(msg) {
    if (typeof msg.connected === 'boolean') S.connected = msg.connected;
    if (typeof msg.running === 'boolean') S.running = msg.running;
    if (msg.detail) showNotice('info', str(msg.detail));
    if (!S.running && S.stream && S.stream.committed) { /* 等权威消息 */ }
    renderHeader();
    updateComposerState();
    updateEmpty();
  }

  // ═══════════════════════════ 12. 审批 / 提问卡 ═══════════════════════════

  function renderDock(asks) {
    clearChildren(U.dock);
    S.asks = [];
    for (var i = 0; i < asks.length; i++) addAsk(asks[i]);
  }

  function addAsk(ask) {
    if (!isObj(ask) || !ask.id) return;
    for (var i = 0; i < S.asks.length; i++) if (S.asks[i].ask.id === ask.id) return;
    var el = buildAskCard(ask);
    S.asks.push({ ask: ask, el: el });
    S.asks.sort(function (a, b) { return (a.ask.createdAt || 0) - (b.ask.createdAt || 0); });
    renderDockOrder();
  }

  function renderDockOrder() {
    clearChildren(U.dock);
    if (!S.asks.length) return;
    // 一次只让用户处理最早的一张卡：真实宿主基本也只会同时挂一个，
    // 队列里剩下的折叠成一行计数，避免几张卡把消息流挤没。
    U.dock.appendChild(S.asks[0].el);
    if (S.asks.length > 1) {
      var more = mk('div', 'dsx-ask-more');
      more.appendChild(mk('span', 'dsx-ask-more-text', '还有 ' + (S.asks.length - 1) + ' 个待处理'));
      more.appendChild(mk('span', 'dsx-ask-more-hint', '处理完当前这张后依次出现'));
      U.dock.appendChild(more);
    }
  }

  function removeAsk(id) {
    for (var i = 0; i < S.asks.length; i++) {
      if (S.asks[i].ask.id === id) {
        if (S.asks[i].el.parentNode) S.asks[i].el.parentNode.removeChild(S.asks[i].el);
        S.asks.splice(i, 1);
        renderDockOrder();
        return;
      }
    }
  }

  function askOptions(ask) {
    var options = Array.isArray(ask.options) ? ask.options.filter(isObj) : [];
    if (options.length) return options;
    if (ask.kind === 'approval') {
      return [{ id: 'allowed-once', label: '允许一次' }, { id: 'rejected', label: '拒绝', destructive: true }];
    }
    return [];
  }

  function buildAskCard(ask) {
    var card = mk('div', 'dsx-ask ' + (ask.kind === 'approval' ? 'dsx-ask-approval' : 'dsx-ask-question'));
    card.setAttribute('data-ask-id', ask.id);

    var hd = mk('div', 'dsx-ask-hd');
    hd.appendChild(mk('span', 'dsx-ask-kind', ask.kind === 'approval' ? '需要审批' : '需要回答'));
    hd.appendChild(mk('span', 'dsx-ask-title', str(ask.title, '（无标题）')));
    card.appendChild(hd);

    if (ask.body) {
      var body = mk('div', 'dsx-ask-body dsx-md');
      body.innerHTML = renderMarkdown(str(ask.body));
      card.appendChild(body);
    }
    if (ask.detail) {
      card.appendChild(mk('pre', 'dsx-pre dsx-ask-detail', str(ask.detail)));
    }

    var opts = askOptions(ask);
    var optBox = mk('div', 'dsx-ask-opts');
    var foot = mk('div', 'dsx-ask-foot');

    // 点完立即锁住整张卡，避免用户重复提交（真实流程里随后会收到 ask-close）
    function lockAskCard() {
      var els = card.querySelectorAll('button, input');
      for (var n = 0; n < els.length; n++) els[n].disabled = true;
    }

    function skipButton() {
      var skip = mk('button', 'dsx-btn dsx-btn-ghost dsx-ask-skip', '忽略');
      skip.type = 'button';
      skip.title = '不回答，关闭这张卡片';
      skip.addEventListener('click', function () { post({ type: 'cancel-ask', id: ask.id }); });
      return skip;
    }

    if (ask.kind === 'approval') {
      // 审批：value 直接是选项 id 字符串（'allowed-once' / 'rejected'）
      for (var i = 0; i < opts.length; i++) {
        (function (opt) {
          var btn = mk('button', 'dsx-btn ' + (opt.destructive ? 'dsx-btn-danger' : 'dsx-btn-primary'), str(opt.label, opt.id));
          btn.type = 'button';
          if (opt.description) btn.title = str(opt.description);
          btn.setAttribute('data-opt-id', str(opt.id));
          btn.addEventListener('click', function () {
            lockAskCard();
            answerAsk(ask.id, str(opt.id));
          });
          optBox.appendChild(btn);
        })(opts[i]);
      }
      optBox.appendChild(skipButton());
      card.appendChild(optBox);
      return card;
    }

    // 提问：value 是 { selected: [选项 id...], custom?: string }
    var multi = ask.multiSelect === true;
    var selected = {};
    if (!opts.length) {
      optBox.appendChild(mk('div', 'dsx-ask-note', '该提问没有可选项，可以输入自定义回答或忽略。'));
    }
    for (var j = 0; j < opts.length; j++) {
      (function (opt) {
        if (multi) {
          var label = mk('label', 'dsx-ask-opt dsx-ask-check');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = str(opt.id);
          cb.addEventListener('change', function () {
            if (cb.checked) selected[opt.id] = 1; else delete selected[opt.id];
            syncSubmit();
          });
          label.appendChild(cb);
          label.appendChild(mk('span', 'dsx-ask-opt-label', str(opt.label, opt.id)));
          if (opt.description) label.appendChild(mk('span', 'dsx-ask-opt-desc', str(opt.description)));
          optBox.appendChild(label);
        } else {
          var btn2 = mk('button', 'dsx-btn dsx-btn-outline dsx-ask-opt');
          btn2.type = 'button';
          btn2.appendChild(mk('span', 'dsx-ask-opt-label', str(opt.label, opt.id)));
          if (opt.description) btn2.appendChild(mk('span', 'dsx-ask-opt-desc', str(opt.description)));
          btn2.setAttribute('data-opt-id', str(opt.id));
          btn2.addEventListener('click', function () {
            lockAskCard();
            answerAsk(ask.id, { selected: [str(opt.id)] });
          });
          optBox.appendChild(btn2);
        }
      })(opts[j]);
    }
    card.appendChild(optBox);

    // 自由文本回答（可选）
    var custom = mk('input', 'dsx-ask-custom');
    custom.type = 'text';
    custom.placeholder = '或者直接输入自定义回答…';
    custom.setAttribute('aria-label', '自定义回答');
    card.appendChild(custom);

    var submit = mk('button', 'dsx-btn dsx-btn-primary', '提交回答');
    submit.type = 'button';
    submit.disabled = true;
    foot.appendChild(submit);
    foot.appendChild(skipButton());
    card.appendChild(foot);

    function syncSubmit() {
      submit.disabled = !(str(custom.value) || Object.keys(selected).length > 0);
    }
    custom.addEventListener('input', syncSubmit);
    syncSubmit();

    submit.addEventListener('click', function () {
      var value = { selected: Object.keys(selected) };
      var text = str(custom.value);
      if (text) value.custom = text;
      if (!value.selected.length && !value.custom) return;
      lockAskCard();
      answerAsk(ask.id, value);
    });
    return card;
  }
  function answerAsk(id, value) {
    post({ type: 'answer', id: id, value: value });
  }

  // ═══════════════════════════ 13. 顶部卡片（todos / plan / 队列）═══════════════════════════

  function renderCards() {
    clearChildren(U.cards);
    var proj = S.projections;

    // 待办
    var todos = proj.todos;
    if (Array.isArray(todos) && todos.length) {
      var card = mk('details', 'dsx-card dsx-todos');
      var sum = mk('summary', 'dsx-card-hd');
      sum.appendChild(mk('span', 'dsx-card-title', '待办'));
      var done = 0;
      for (var i = 0; i < todos.length; i++) {
        if (isObj(todos[i]) && todos[i].status === 'completed') done += 1;
      }
      sum.appendChild(mk('span', 'dsx-card-count', done + '/' + todos.length));
      card.appendChild(sum);
      card.open = true;
      var ul = mk('ul', 'dsx-todo-list');
      for (var j = 0; j < todos.length; j++) {
        var t = todos[j];
        if (!isObj(t)) continue;
        var li = mk('li', 'dsx-todo dsx-todo-' + str(t.status, 'pending'));
        li.appendChild(mk('span', 'dsx-todo-mark', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'));
        li.appendChild(mk('span', 'dsx-todo-text', str(t.content, '')));
        ul.appendChild(li);
      }
      card.appendChild(ul);
      U.cards.appendChild(card);
    }

    // 计划模式
    var plan = proj.plan;
    if (isObj(plan) && (plan.active || plan.pending)) {
      var chipBar = mk('div', 'dsx-planbar');
      chipBar.appendChild(mk('span', 'dsx-plan-chip-inline', plan.active ? 'Plan 模式' : 'Plan 切换中'));
      chipBar.appendChild(mk('span', 'dsx-plan-note', plan.active ? '已开启；回复将先产出计划' : '等待生效'));
      U.cards.appendChild(chipBar);
    }

    // 排队消息
    var inbox = proj.inbox;
    var queued = 0;
    if (isObj(inbox) && Array.isArray(inbox['next-turn'])) queued = inbox['next-turn'].length;
    if (queued > 0) {
      var q = mk('div', 'dsx-queue');
      q.appendChild(mk('span', 'dsx-queue-tag', '排队中'));
      q.appendChild(mk('span', 'dsx-queue-text', queued + ' 条消息待发送'));
      U.cards.appendChild(q);
    }

    // 计划 chip（composer 工具行）
    var planActive = isObj(plan) && plan.active === true;
    U.planChip.hidden = !planActive;
  }

  // ═══════════════════════════ 14. 用量条 ═══════════════════════════

  function renderMeter() {
    clearChildren(U.meter);
    var proj = S.projections;
    var pressure = isObj(proj.contextPressure) ? proj.contextPressure : {};
    var used = num(pressure.pressureTokens);
    var projected = num(pressure.projectedTokens);
    var windowSize = num(pressure.contextWindow);
    if (used === null && projected !== null) used = projected;
    if (windowSize === null) windowSize = num(S.usage.contextWindow);
    if (used === null) used = num(S.usage.pressureTokens);
    if (used === null && num(S.usage.totalTokens) !== null) used = num(S.usage.totalTokens);

    var bar = mk('div', 'dsx-meter-bar');
    var ratio = (used !== null && windowSize) ? Math.min(1, used / windowSize) : 0;
    var fill = mk('div', 'dsx-meter-fill ' + (ratio >= 0.95 ? 'dsx-meter-bad' : ratio >= 0.8 ? 'dsx-meter-warn' : 'dsx-meter-ok'));
    fill.style.width = Math.round(ratio * 100 * 10) / 10 + '%';
    bar.appendChild(fill);

    // 构成三段（有 contextBreakdown 时叠加在旁边）
    var breakdown = isObj(proj.contextBreakdown) ? proj.contextBreakdown : null;
    var breakdownEl = null;
    if (breakdown) {
      var b = mk('div', 'dsx-meter-breakdown');
      var segs = [
        { key: 'systemTokens', cls: 'dsx-seg-sys', label: '系统' },
        { key: 'toolsTokens', cls: 'dsx-seg-tools', label: '工具' },
        { key: 'messageTokens', cls: 'dsx-seg-msg', label: '消息' }
      ];
      var total = 0;
      for (var i = 0; i < segs.length; i++) total += num(breakdown[segs[i].key]) || 0;
      for (var j = 0; j < segs.length; j++) {
        var v = num(breakdown[segs[j].key]) || 0;
        var seg = mk('span', 'dsx-seg ' + segs[j].cls);
        seg.style.width = total > 0 ? (v / total * 100).toFixed(1) + '%' : '0%';
        seg.title = segs[j].label + ' ' + formatTokens(v) + ' tokens（估算）';
        breakdownEl = breakdownEl || mk('div', 'dsx-meter-stack');
        breakdownEl.appendChild(seg);
      }
      if (breakdownEl) bar.appendChild(breakdownEl);
    }

    var numEl = mk('span', 'dsx-meter-num');
    var text = '';
    if (used !== null && windowSize) {
      text = formatTokens(used) + ' / ' + formatTokens(windowSize) + ' · ' + Math.round(ratio * 100) + '%';
    } else if (used !== null) {
      text = formatTokens(used) + ' tokens';
    } else {
      text = '上下文用量未知';
    }
    numEl.textContent = text;
    if (breakdown) {
      numEl.title = '系统 ' + formatTokens(num(breakdown.systemTokens) || 0) +
        ' · 工具 ' + formatTokens(num(breakdown.toolsTokens) || 0) +
        ' · 消息 ' + formatTokens(num(breakdown.messageTokens) || 0) + '（估算）';
    }

    var usage = isObj(proj.tokenUsage) ? proj.tokenUsage : null;
    var usageEl = mk('span', 'dsx-meter-usage');
    if (usage) {
      var up = (num(usage.uncachedInputTokens) || 0) + (num(usage.cacheReadTokens) || 0) + (num(usage.cacheWriteTokens) || 0);
      usageEl.textContent = '↑' + formatTokens(up) + ' ↓' + formatTokens(num(usage.outputTokens) || 0);
      usageEl.title = '输入 ' + formatTokens(up) + '（含缓存读 ' + formatTokens(num(usage.cacheReadTokens) || 0) + '）· 输出 ' +
        formatTokens(num(usage.outputTokens) || 0);
    } else if (num(S.usage.totalTokens) !== null) {
      usageEl.textContent = '↑' + formatTokens(num(S.usage.inputTokens) || 0) + ' ↓' + formatTokens(num(S.usage.outputTokens) || 0);
    }

    U.meter.appendChild(bar);
    var metaRow = mk('div', 'dsx-meter-meta');
    metaRow.appendChild(numEl);
    if (usageEl.textContent) metaRow.appendChild(usageEl);
    U.meter.appendChild(metaRow);
  }

  // ═══════════════════════════ 15. 空态 / 通知 ═══════════════════════════

  function renderEmptyState() {
    clearChildren(U.empty);
    var box = mk('div', 'dsx-empty-card');

    if (S.authNeeded) {
      var reasonText = S.authNeeded === 'no-token' ? '尚未登录或没有可用的 access token' :
        S.authNeeded === 'token-expired' ? 'access token 已过期' : '与 dsh runtime 断开连接';
      box.appendChild(mk('div', 'dsx-empty-title', '需要登录 dsh'));
      box.appendChild(mk('div', 'dsx-empty-body',
        reasonText + '。' + (S.authority ? '实例：' + S.authority : '')));
      var hints1 = mk('pre', 'dsx-empty-pre',
        '在终端里运行：\n  dsh web --open    # 启动本机 runtime 并在浏览器登录一次\n\n登录完成后点下面「重试连接」。');
      box.appendChild(hints1);
      box.appendChild(emptyButtons());
    } else if (!S.connected) {
      box.appendChild(mk('div', 'dsx-empty-title', '未连接到 dsh runtime'));
      box.appendChild(mk('div', 'dsx-empty-body', '这个面板需要连上一个正在运行的 dsh 实例。'));
      box.appendChild(mk('pre', 'dsx-empty-pre',
        '启动 runtime：\n  dsh web                 # 默认 http://127.0.0.1:3080\n  dsh web --port 3081     # 指定端口\n\n连接已有实例：\n  在 VS Code 设置里填 dsh 的 URL，或点「重试连接」。'));
      box.appendChild(emptyButtons());
    } else if (!S.sessionId) {
      box.appendChild(mk('div', 'dsx-empty-title', '还没有会话'));
      box.appendChild(mk('div', 'dsx-empty-body', '新建一个会话，或在顶栏「会话」里选一个已有的。'));
      var row = mk('div', 'dsx-empty-actions');
      var b = mk('button', 'dsx-btn dsx-btn-primary', '新建会话');
      b.type = 'button';
      b.addEventListener('click', function () { post({ type: 'new-session' }); });
      row.appendChild(b);
      box.appendChild(row);
    } else {
      box.appendChild(mk('div', 'dsx-empty-title', '开始对话'));
      box.appendChild(mk('div', 'dsx-empty-body', '在下面输入消息，Enter 发送、Shift+Enter 换行。'));
    }
    U.empty.appendChild(box);
  }

  function emptyButtons() {
    var row = mk('div', 'dsx-empty-actions');
    var retry = mk('button', 'dsx-btn dsx-btn-primary', '重试连接');
    retry.type = 'button';
    retry.addEventListener('click', function () { post({ type: 'reconnect' }); });
    var full = mk('button', 'dsx-btn', '打开完整 dsh UI');
    full.type = 'button';
    full.addEventListener('click', function () { post({ type: 'open-full-ui' }); });
    row.appendChild(retry);
    row.appendChild(full);
    return row;
  }

  function showNotice(level, text) {
    var msg = str(text);
    if (!msg) return;
    var el = mk('div', 'dsx-notice dsx-notice-' + (level || 'info'));
    el.appendChild(mk('span', 'dsx-notice-text', msg));
    var close = mk('button', 'dsx-notice-x', '×');
    close.type = 'button';
    close.addEventListener('click', function () { if (el.parentNode) el.parentNode.removeChild(el); });
    el.appendChild(close);
    U.notices.appendChild(el);
    if (level !== 'error') {
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
    }
  }

  // ═══════════════════════════ 16. Composer ═══════════════════════════

  // 已选图片：{ id, name, mediaType, dataUrl }；发送后清空
  var attached = [];

  function renderAttach() {
    if (!U.attach) return;
    U.attach.innerHTML = '';
    U.attach.hidden = attached.length === 0;
    attached.forEach(function (img) {
      var box = mk('div', 'dsx-attach-item');
      var thumb = mk('img', 'dsx-attach-thumb');
      thumb.src = img.dataUrl;
      thumb.alt = img.name;
      box.appendChild(thumb);
      var nameEl = mk('span', 'dsx-attach-name', img.name);
      box.appendChild(nameEl);
      var x = mk('button', 'dsx-attach-x', '×');
      x.type = 'button';
      x.title = '移除';
      x.addEventListener('click', function () {
        attached = attached.filter(function (a) { return a.id !== img.id; });
        renderAttach();
        updateComposerState();
      });
      box.appendChild(x);
      U.attach.appendChild(box);
    });
  }

  function addImage(m) {
    if (attached.length >= 6) { showNotice('warn', '一条消息最多带 6 张图片'); return; }
    var idx = m.dataUrl.indexOf(',');
    attached.push({
      id: m.id,
      name: m.name || 'image',
      mediaType: m.mediaType,
      dataUrl: m.dataUrl,
      data: idx >= 0 ? m.dataUrl.slice(idx + 1) : m.dataUrl,
    });
    renderAttach();
    updateComposerState();
  }

  function autoGrow() {
    U.input.style.height = 'auto';
    var h = Math.min(U.input.scrollHeight || 24, 220);
    U.input.style.height = h + 'px';
  }

  function updateComposerState() {
    var text = U.input.value.trim();
    S.draft = text;
    var hasText = !!text;
    var canSend = S.connected && hasText;
    U.btnSend.classList.toggle('dsx-send-stop', S.running && !hasText);
    if (S.running && !hasText) {
      U.btnSend.textContent = '停止';
      U.btnSend.disabled = false;
      U.btnSend.title = '取消当前回合';
    } else if (S.running && hasText) {
      U.btnSend.textContent = '排队发送';
      U.btnSend.disabled = !canSend;
      U.btnSend.title = '回合运行中，发送会排到下一轮';
      U.input.placeholder = '回合运行中，发送会排队…（Enter 排队，Shift+Enter 换行）';
    } else {
      U.btnSend.textContent = '发送';
      U.btnSend.disabled = !canSend;
      U.btnSend.title = canSend ? '发送（Enter）' : (S.connected ? '输入内容后发送' : '未连接 runtime');
      U.input.placeholder = '给 dsh 发消息…（Enter 发送，Shift+Enter 换行）';
    }
    if (hasText) {
      var est = Math.ceil(text.length / 1.7);
      U.hint.textContent = text.length + ' 字 · 约 ' + est + ' tokens';
    } else if (!S.connected) {
      U.hint.textContent = '未连接';
    } else {
      U.hint.textContent = S.running ? '运行中' : '';
    }
  }

  function doSend() {
    var text = U.input.value.trim();
    var imgs = attached;
    if (!text && !imgs.length) {
      if (S.running) { post({ type: 'cancel' }); return; }
      return;
    }
    if (!S.connected) { showNotice('warn', '未连接到 dsh runtime，消息未发送'); return; }
    var payload = { type: 'prompt', text: text, content: [{ type: 'text', text: text }] };
    if (imgs.length) {
      payload.images = imgs.map(function (i) {
        return { mediaType: i.mediaType, data: i.data, name: i.name };
      });
    }
    if (S.running) payload.mode = 'queue';
    post(payload);
    U.input.value = '';
    attached = [];
    renderAttach();
    autoGrow();
    updateComposerState();
    if (S.running) showNotice('info', '已排队，将在下一轮发送');
  }

  function wireComposer() {
    U.input.addEventListener('input', function () { autoGrow(); updateComposerState(); });
    U.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    });
    if (U.btnImage) {
      U.btnImage.addEventListener('click', function () { post({ type: 'pick-image' }); });
    }
    U.btnSend.addEventListener('click', function () {
      if (S.running && !U.input.value.trim()) { post({ type: 'cancel' }); return; }
      doSend();
    });
    U.btnStop.addEventListener('click', function () { post({ type: 'cancel' }); });
    U.btnNew.addEventListener('click', function () { post({ type: 'new-session' }); });
    U.btnFull.addEventListener('click', function () { post({ type: 'open-full-ui' }); });
    U.btnSessions.addEventListener('click', function () { openSessionsMenu(U.btnSessions); });
    U.btnModels.addEventListener('click', function () { openModelMenu(U.btnModels); });
    U.btnPerms.addEventListener('click', function () { openPermissionMenu(U.btnPerms); });
    U.loadOlderBtn.addEventListener('click', function () { post({ type: 'load-older' }); });
    U.jump.addEventListener('click', function () { stickToBottom(true); });
    U.title.addEventListener('click', function () { openSessionsMenu(U.title); });

    U.transcript.addEventListener('scroll', function () {
      S.follow = nearBottom();
      U.jump.hidden = S.follow || S.msgCount === 0;
    });

    // 链接点击 → 交给扩展打开（webview 里不允许直接导航）
    U.inner.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a.dsx-link') : null;
      if (!a) return;
      e.preventDefault();
      var href = a.getAttribute('data-href') || a.getAttribute('href') || '';
      if (href) post({ type: 'open-link', href: href });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.menu) { closeMenus(); }
    });

    // 拖入文件时避免浏览器把 webview 导航走
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  // ═══════════════════════════ 17. 消息分发 ═══════════════════════════

  function onHostMessage(msg) {
    if (!isObj(msg)) return;
    try {
      dispatch(msg);
    } catch (err) {
      // 任何渲染异常都不能让面板白屏
      showNotice('error', '渲染 ' + str(msg.type, '消息') + ' 时出错：' + (err && err.message ? err.message : err));
      if (typeof console !== 'undefined' && console.error) console.error('[dsx] dispatch failed', err);
    }
  }

  function dispatch(msg) {
    switch (msg.type) {
      case 'init': applyInit(msg.state); break;
      case 'sessions': S.sessions = Array.isArray(msg.sessions) ? msg.sessions : []; renderHeader(); break;
      case 'open': applyOpen(msg); break;
      case 'event': applyEvent(msg.event); break;
      case 'records': applyRecords(msg.records, msg.prepend === true); break;
      case 'stream': applyStream(msg.frame); break;
      case 'reset': applyReset(); break;
      case 'title': S.sessionTitle = str(msg.title); renderHeader(); break;
      case 'projections': applyProjections(msg.values, msg.asOfSeq); break;
      case 'models': S.catalog = isObj(msg.catalog) ? msg.catalog : S.catalog; if (isObj(msg.selection)) S.selection = msg.selection; renderHeader(); break;
      case 'permissions':
        S.permissions = { current: str(msg.current), presets: Array.isArray(msg.presets) ? msg.presets : [] };
        renderHeader();
        break;
      case 'status': applyStatus(msg); break;
      case 'ask': addAsk(msg.ask); break;
      case 'ask-close': removeAsk(str(msg.id)); break;
      case 'usage': mergeUsage(msg.usage); renderMeter(); break;
      case 'changes': renderChanges(msg.changes); break;
      case 'diff': applyDiff(msg.diff); break;
      case 'notice': showNotice(msg.level, msg.text); break;
      case 'image-picked': addImage(msg); break;
      case 'image-error': showNotice('warn', msg.text); break;
      case 'auth-needed': {
        S.authNeeded = str(msg.reason, 'disconnected');
        S.connected = false;
        if (msg.authority) S.authority = str(msg.authority);
        S.msgCount = 0;
        renderHeader();
        updateEmpty();
        updateComposerState();
        break;
      }
      default:
        // 不是本协议的宿主消息（浏览器里会有别的扩展往 window 投递消息）→ 只留调试日志，不打扰界面
        if (typeof console !== 'undefined' && console.debug) {
          console.debug('[dsx] 忽略未识别的宿主消息', msg && msg.type);
        }
    }
  }

  // ═══════════════════════════ 18. 启动 ═══════════════════════════

  function boot(root) {
    try {
      vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    } catch (e) {
      vscode = null;
    }
    buildShell(root);
    wireComposer();
    S.follow = true;
    S.msgCount = 0;
    renderHeader();
    renderCards();
    renderMeter();
    updateComposerState();
    updateEmpty();
    autoGrow();

    window.addEventListener('message', function (e) { onHostMessage(e.data); });

    // 把启动期间排队的消息（通常没有）统一发出
    post({ type: 'ready' });
    for (var i = 0; i < postQueue.length; i++) post(postQueue[i]);
    postQueue = [];

    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[dsx] chat webview booted');
    }
  }

  // ── 纯函数导出（node 端自测用；不涉及 DOM 启动）──
  if (typeof module === 'object' && module && module.exports) {
    module.exports = {
      escapeHTML: escapeHTML,
      renderMarkdown: renderMarkdown,
      formatTokens: formatTokens,
      formatDuration: formatDuration,
      formatClock: formatClock,
      prettyJsonText: prettyJsonText,
      summarizeToolCall: summarizeToolCall,
      firstLine: firstLine,
      sourceInfo: sourceInfo
    };
  }

  var bootRoot = (typeof document !== 'undefined')
    ? (document.getElementById('dsx-root') || document.body)
    : null;
  if (bootRoot) boot(bootRoot);

  // 调试出口（preview / 扩展 console 都可用）
  if (typeof window !== 'undefined') {
    window.__DSX__ = {
      state: S,
      feed: onHostMessage,
      escapeHTML: escapeHTML,
      renderMarkdown: renderMarkdown
    };
  }
})();

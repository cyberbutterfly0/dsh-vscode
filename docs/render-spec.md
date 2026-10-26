# 聊天 webview 渲染规格（media/chat.js 对照文档）

本文件是 `E:\dsh结算\vscde\extension\media\` 下聊天面板的实现契约：组件清单、每种消息/事件的渲染规则、CSS 类名、消息流状态机。验收时按本文逐条对照。

- 实现文件：`media/chat.js`（渲染与状态机）、`media/chat.css`（全部样式）、`media/preview.html` + `media/dev-fixtures.js`（浏览器假数据预览）
- 依赖：0。原生 DOM API，无框架、无外链脚本、无内联 script/style（CSP 安全）
- 宿主通信：`acquireVsCodeApi()` 的 `postMessage` / `window.message` 事件；契约以 `extension/src/protocol.ts` 为唯一来源，字段名照抄

---

## 1. 加载与挂载

```
preview.html:  <div id="dsx-root"></div>
               <script src="dev-fixtures.js"></script>   ← 仅预览用，stub acquireVsCodeApi
               <script src="chat.js"></script>
```

`chat.js` 是被 `<script nonce>` 引入的普通脚本，加载即执行 `boot()`：

1. 取 `document.getElementById('dsx-root') || document.body` 作为根；
2. `acquireVsCodeApi()` 存在则用真 API，否则用一个丢弃式 stub（保证在普通浏览器里不抛错）；
3. 构建骨架并 `post({ type: 'ready' })`——扩展侧收到 ready 后才推 `init`；
4. 注册 `window.addEventListener('message', ...)`，只处理 `event.data.type` 属于已知 HostToWeb 变体的消息，其它一律忽略（浏览器扩展的 content-script 也会往 window 投递消息）。

预览环境下 `dev-fixtures.js` 会注入 `:root { --dsx-app-top: 40px }` 给顶部工具栏让位；生产环境没有这个变量，面板占满视口。

---

## 2. 宿主 → webview（`HostToWeb`）处理表

| type | 处理 |
| --- | --- |
| `ready`（webview→宿主） | 骨架构建完成后立即发一次 |
| `init` | 写入连接/授权/cwd/会话列表/模型目录/权限档/运行态/待处理 ask；渲染顶栏、composer、用量条、空态。**不清消息流** |
| `sessions` | 只更新会话列表并重绘顶栏 |
| `open` | 打开会话：清空消息流、`lastSeq=0`、按 `records[]` 顺序重放、应用 `projections`、恢复 `assistantStream` 基线、滚到底 |
| `event` | 单条持久事件，走 `applyEvent()`（见 §4），按 `seq` 单调去重 |
| `records` | `prepend:false` 追加到尾部；`prepend:true` 插到「加载更早的历史」按钮之后并补偿滚动位置。元素可以是 `{type:'event', event}` 或 `{type:'changes', changes}`（改动卡片，见 §4B） |
| `changes` | 某一轮的改动汇总卡片，挂在对应轮次末尾（见 §4B） |
| `diff` | 单个文件的 diff 回包，填进已展开的文件行（懒加载，见 §4B） |
| `stream` | assistant-stream 帧，见 §5 |
| `reset` | 断线重连：只删除进行中的流式节点（`.dsx-live`），历史保留，等下一次 `open` 覆盖 |
| `title` | 顶栏标题 |
| `projections` | 合并 24 个投影值后重绘顶栏/用量条/卡片区 |
| `models` | 替换模型目录与当前选择 |
| `permissions` | 替换当前权限档与 presets |
| `status` | 连接与 running 状态的唯一权威来源 |
| `ask` | 追加审批/提问卡（见 §7） |
| `ask-close` | 按 id 移除卡片 |
| `usage` | 合并 token 用量后重绘用量条 |
| `notice` | 右上角临时通知（`info`/`warn` 6s 自动消失，`error` 常驻可关） |
| `auth-needed` | 记录原因，空态切换成「需要登录 dsh」引导 |

## 3. webview → 宿主（`WebToHost`）发送表

| type | 触发点 |
| --- | --- |
| `ready` | 骨架就绪 |
| `prompt` | composer 发送：`{ type:'prompt', text, content:[{type:'text',text}] }`；running 时附加 `mode:'queue'` |
| `cancel` | 顶栏「停止」、composer 停止态按钮、空输入时 Enter |
| `new-session` | 顶栏「+」/「新建会话」、空态按钮 |
| `open-session` | 会话菜单点某一行 |
| `load-older` | 消息流顶部「加载更早的历史」 |
| `reconnect` | 空态「重试连接」 |
| `open-full-ui` | 顶栏 / 空态「打开完整 dsh UI」 |
| `open-link` | markdown 里点链接（webview 内禁止导航） |
| `load-diff` | 改动卡片里点某个文件行：`{ type:'load-diff', sessionId, seq, index }`，等宿主回 `diff` |
| `open-file` | 改动卡片里「用编辑器打开」：`{ type:'open-file', path }` |
| `answer` | 审批/提问卡选项按钮、提问卡「提交」 |
| `cancel-ask` | 审批/提问卡「忽略」 |
| `select-model` | 模型菜单选模型或推理档 |
| `set-permission` | 权限菜单选档 |

未发送（暂无入口）：`pick-cwd`、`rename-session`、`close-session`、`copy`、`insert-file-reference`。

---

## 4. 持久事件（`{type:'event'}`）渲染规则

`applyEvent(ev)`：先按 `ev.seq` 单调去重（`seq <= S.lastSeq` 直接丢弃），再按 `ev.type` 分派；`ev.data` 为字典。渲染异常只会弹一条 `error` 通知，不会白屏。

| event.type | 渲染 |
| --- | --- |
| `user/message` | `data.content` 文本合并。`data.source.kind === 'user'` 且无 `form/summary` → 右对齐用户气泡（`.dsx-user`）；否则（agent 注入、system-reminder、skill、runtime-context、compaction 摘要…）→ 折叠行「`用户`/`系统提醒`/`技能上下文`… + 首行预览」(`.dsx-inject`) |
| `assistant/message` | 按 `data.message.content` 依次渲染：`reasoning` → 折叠「思考过程 N 字」；`text` → markdown 块；`image` → 「[图片输出]」占位。`data.interrupted` 前插「已中断」标签。空内容给「（空回复）」 |
| `assistant/attempt` | 折叠「一次未采用的尝试 · N 段流」，正文为 `data.stream[].text` 拼接（markdown） |
| `system/message` | 折叠「系统提示 N 字」，正文等宽 `<pre>` 原文（不渲染 markdown） |
| `tool/call` | 工具卡（`.dsx-tool`）：`▣ 名字 参数摘要 … 状态`，展开后「参数」JSON + 「输出」段（结果到达前隐藏）。键：`data.callId` / `data.name` / `data.arguments`（字符串，非字符串则 `JSON.stringify` 美化） |
| `tool/result` | 按 `data.message.toolCallId` 找到对应卡片就地填「输出」，状态改成「成功 · 1.2s」或「失败 · 1.2s」并展开错误段。错误详情优先 `data.error.reason`，其次 `data.error.name`，最后输出前 400 字。`data.meta.exitCode` 非 0 时状态后追加 `· exit N` 并染红。找不到对应 call（历史被裁剪）时补一张独立结果卡 |
| `turn/start` | 轮次分隔：`── 第 N 轮 时刻 ──`（`.dsx-turn-hd`）；后续内容都追加进该轮容器 |
| `turn/end` | 轮次脚注「本轮完成 · 3.4s」，`data.reason.kind` 映射中文（completed/interrupted/error/aborted/cancelled/failed/stopped），`reason.error` 预览附在脚注 |
| `step/start` | 「步骤 N 时刻」分隔行（`.dsx-step`） |
| `step/end` | 给对应步骤行补耗时并加 `.dsx-step-done` |
| `session/title` | 更新顶栏标题（不产生消息节点） |
| `command/run` | 右对齐用户块，内容为 `/<name> <args>`，下方预留结果区；`commandId` 登记 |
| `command/done` | 回填结果区：`kind==='error'` 红色，否则普通；无 `text` 时用「命令失败 / 命令完成」 |
| `compaction/start` | 「上下文压缩 · 进行中…」行 |
| `compaction/summary` | 折叠「上下文已压缩 · N tokens 被摘要」，正文为摘要 markdown |
| `compaction/end` | 把 start 行的状态改成「完成」或「失败：…」 |
| `deliverables/presented` | 折叠「交付文件 · N 个」，列出 `path` 与大小 |
| `plan/mode` | 只更新 `projections.plan` 并重绘卡片区（Plan 模式 chip） |
| `todo/write` | 只更新 `projections.todos` 并重绘待办列表 |
| **未知 type** | 兜底卡片 `.dsx-generic`：`事件 + type + data 首行预览`，展开是 2 空格缩进的 JSON（超 20k 截断）。绝不抛错 |

`SILENT_EVENTS` 白名单（只更新投影/内部状态，不进消息流）：`request/header`、`request/context`、`agent/inbox/spliced`、`session/title-llm-request`、`model/selection`、`permission/preset`、`sandbox/mode`、`approval/policy`、`approval/asked`、`approval/decided`、`image/offload`、`hook/invoked`、`hook/result`、`llm/retry`、`llm/retry-started`、`developer/message`、`session/end-seed`、`working-directory/change`、`workspace/changes`、`feedback/*`、`goal/change`、`schedule/change`、`job/*`、`subagent/*`、`agent-preset/selected`、`web/deepseek-search-llm-request`、`team/*`、`compaction/prune`、`tool-workflow/*`。

### 4B. 改动可视化卡片（`{type:'changes'}` / `{type:'diff'}`）

每次 `workspace/changes` 事件在扩展侧被翻译成一条 `{type:'changes', changes}`；`workspace/changes` 本身留在 `SILENT_EVENTS` 里，**不渲染裸事件行**。

```ts
UiChanges { sessionId, seq, turn, files: UiChangedFile[], total, added, deleted }
UiChangedFile { index, path, display, added, deleted, binary?, oversized? }
UiDiff { sessionId, seq, index, kind:'text'|'binary'|'oversized', path, display,
         before?, after?, hunks?, coarse? }
UiDiffHunk { oldStart, oldLines, newStart, newLines, lines: string[] }  // 行首字符 + / - / 空格
```

渲染（`renderChanges()`，入口有三处：`{type:'changes'}`、`open.records` 里的 `{type:'changes', changes}` 记录、以及 `applyRecord()`）：

| 元素 | 规则 |
| --- | --- |
| 位置 | `getTurn(changes.turn)` 的轮容器末尾，紧跟该轮 `turn/end` 脚注（`insertAfterEl()`）；没有对应轮容器时追加到消息流末尾 |
| 去重 | 按 `"sessionId|seq"` 记在 `S.changes`；同一 key 再来一次 → 移除旧卡、按新数据重建（不叠两张），`S.diffs` 里同 key 的旧缓存一并清掉。`files: []` → 完全不渲染卡片 |
| 标题行 | `±` 图标 + `改动 N 个文件`（`N = files.length`；`total !== files.length` 时写 `N 个文件（共 total）`）+ 右侧 `+added` / `−deleted`（绿 / 红，等宽） |
| 文件行 | `display`（等宽，超长省略） + `+a` / `−d`；`binary: true` → 徽标「二进制」，`oversized: true` →「文件过大」 |
| 点击文件行 | 发 `{type:'load-diff', sessionId, seq, index}`，行下方展开 `.dsx-chg-slot`：先显示「加载中…」；收到 `diff` 后渲染 hunk。再点一次收起（已缓存的 diff 秒开，不重复请求） |
| hunk | `.dsx-hunk`：首行 `@@ -oldStart,oldLines +newStart,newLines @@`（灰、等宽），下面逐行 `<div class="dsx-dl dsx-dl-add|del">`，行首字符单独放 `.dsx-dl-sign`；`+` 绿底、`-` 红底、空格透明；等宽字体、`white-space: pre` + 容器横向滚动，不换行 |
| coarse | `coarse: true` 时 hunk 上方插一行「行级对比不可用，显示整体替换」 |
| 非文本 | `kind === 'binary' \| 'oversized'` → 只显示「二进制文件，无法预览」/「文件过大，无法预览」 |
| 打开文件 | 已展开且 `kind === 'text'` 的文件行右侧出现「用编辑器打开」→ `{type:'open-file', path}` |

CSS：`.dsx-changes` `.dsx-chg-hd` `.dsx-chg-title` `.dsx-chg-stat` `.dsx-chg-add` `.dsx-chg-del` `.dsx-chg-files` `.dsx-chg-item` `.dsx-chg-file` `.dsx-chg-name` `.dsx-chg-badge` `.dsx-chg-open` `.dsx-chg-slot` `.dsx-chg-loading` `.dsx-chg-note` `.dsx-diff` `.dsx-hunk` `.dsx-hunk-hd` `.dsx-hunk-body` `.dsx-dl` `.dsx-dl-add` `.dsx-dl-del` `.dsx-dl-sign` `.dsx-dl-text`。行底色优先用 `--vscode-diffEditor-insertedTextBackground` / `-removedTextBackground`，缺变量时用绿/红 18% 透明兜底。

卡片随消息流滚动，不做 sticky；`reset`（断线）不清除历史卡片，等下一次 `open` 全量覆盖。

---

## 5. 流式渲染（`{type:'stream', frame}`）

帧形如 `{ type:'start'|'chunk'|'end', attemptId, revision, turn?, chunk?, outcome? }`，按 `revision` 单调丢弃旧帧。

- `start`：建流式占位块 `.dsx-live`（头部脉冲点 +「正在输出」），插入到当前轮末尾
- `chunk`：
  - `block-start`：按 `chunk.blockType` 建块（`reasoning` → 默认展开的「思考过程 · 写入中…」，`text` → markdown 块）
  - `text-delta`：**只追加文本节点**（打字机），并在 150ms 节流后用 `renderMarkdown(累计文本)` 重排该块；未收到 block-start 时自动补建（容错）
  - `block-end`：用 `chunk.block.text` 做最终 markdown 渲染；reasoning 块补「N 字 · 耗时」并按用户是否手动展开决定是否折叠
  - `usage`：合并 token 用量并重绘用量条
- `end`：`outcome.kind === 'abandoned'` → 删除占位并留一行「本次尝试被放弃」；否则头部改成「已输出」、停止光标动画，等权威 `assistant/message` 到达（那时整块 `.dsx-live` 被移除，避免重复）

约束：增量只改文本节点/单块 innerHTML，不重建消息流，不整树重排。

---

## 6. 消息流状态机

```
                       ┌──────────── (每次打开/切换会话) ────────────┐
ready ──► init ──► 空态 ──► open ──► 重放 records ──► 贴底跟随
                                     │
                     event / stream ◄┘   (seq 单调，<= lastSeq 丢弃)
                                     │
              断线：reset（只清 .dsx-live）──► 重连后再次 open 覆盖全部
```

- `init` 只更新外壳状态，不动消息流；`open` 是唯一「清空 + 全量重放」的入口（清 `lastSeq`、`S.tools`、`S.commands`、`S.turns`，移除流式占位）。
- 重连时序按「`reset` → `open` → 后续 `event`」处理；由于 `open` 会清空，残留的旧节点不会重复。
- `records` 向上翻页（`prepend:true`）插入到「加载更早的历史」按钮之后，并用 `scrollHeight` 差值补偿滚动，阅读位置不跳。
- 跟随滚动：`scroll` 事件里 `S.follow = nearBottom()`；贴底时新内容自动跟随，用户上翻后停止跟随并显示右下「回到底部」浮钮。

---

## 7. 审批 / 提问卡（`{type:'ask', ask}`）

`ask` 与 `approval/*` 事件无关（审批走全局通道，由扩展翻译成 `ask`）。

- 位置：composer 上方的卡片坞 `.dsx-dock`。同时多张时**只渲染最早一张**，其余折叠成「还有 N 个待处理」。
- 结构：`头（「需要审批」/「需要回答」+ 标题）`、`body`（受控 markdown）、`detail`（等宽命令/文件）、选项按钮行、右下「忽略」。审批卡黄左边框，危险选项红底。
- 回答格式：
  - `kind:'approval'` → `post({ type:'answer', id, value: <选项 id> })`，常见 `allowed-once` / `rejected`（无 options 时用这两个兜底按钮）
  - `kind:'question'` → 选项是勾选（`multiSelect` 时多选），提交发 `post({ type:'answer', id, value:{ selected:[选项 id...], custom?: 自定义文本 } })`；`custom` 仅在用户填了自定义回答时带上
  - 「忽略」→ `post({ type:'cancel-ask', id })`
- `ask-close` 会按 id 移除并回到队列下一张。

---

## 8. 顶栏 / 菜单 / composer / 用量条

### 顶栏（`.dsx-hd`，单行不换行）

| 元素 | 类名 | 行为 |
| --- | --- | --- |
| 连接状态点 | `.dsx-dot`（`-ok` `-run` `-bad`） | 颜色 + tooltip；running 时脉动 |
| 标题 | `.dsx-title` | 优先级 `title` 消息 > `open.title` > `session/title` > `projections.title` > 「新会话」；点击开会话菜单 |
| cwd | `.dsx-hd-sub` | 等宽小字，≤960px 隐藏 |
| 会话 | `.dsx-hd-sessions` | 显示数量副值；菜单列出 `UiSessionRow`（运行点、当前项勾选） |
| 模型 | `.dsx-chip` | 主值=模型名，副值=`· <推理档>`（≤960px 隐藏副值） |
| 权限 | `.dsx-hd-perms` | 显示 presets 里当前档的 `name`（不硬编码） |
| 停止 | `.dsx-btn-stop` | 仅 running 时出现 |
| 新建会话 | `.dsx-btn` | 长文案「新建会话」，≤960px 变「+」 |
| 完整 UI | `.dsx-btn` | 长文案「打开完整 dsh UI」，≤960px 变「完整界面」 |

### 弹层（`.dsx-menu`）

- 模型菜单 `.dsx-models`：左列按 `UiCatalog.groups` 分组（provider 名分组标题），每个模型一行；悬停/点击模型，右列列出 `efforts[]`（二级菜单），选中发 `select-model`；`catalog.failures` 以 `.dsx-menu-warn` 显示。
- 权限菜单 `.dsx-menu-perms`：`permissions.presets[]` 逐个列出（name + description + 当前勾选），选中发 `set-permission`。
- 会话菜单 `.dsx-menu-sessions`：`sessions[]` 行（标题 / cwd / 运行点 / 当前勾选），点行发 `open-session`。

### Composer（`.dsx-composer`）

- `textarea.dsx-input`：自动增高（最高 220px），Enter 发送 / Shift+Enter 换行（输入法组合中不发送）。
- 发送按钮三态：可发送「发送」、running 且有草稿「排队发送」（发 `mode:'queue'`）、running 且空输入「停止」（发 `cancel`）。
- 提示行 `.dsx-hint`：`N 字 · 约 M tokens`（长度/1.7 估算）；未连接显示「未连接」，运行中显示「运行中」。
- 工具栏左端 `.dsx-plan-chip`（「Plan」胶囊，仅 `plan.active` 时显示，纯展示，协议里没有切换 Plan 模式的出站消息）；send 按钮右端。

### 用量条（底部，`.dsx-meter`）

数据优先级：`projections.contextPressure.pressureTokens`（无则 `projectedTokens`）→ `stream usage.pressureTokens` → `usage.totalTokens`；窗口 `contextPressure.contextWindow`（无则 `usage.contextWindow`）。

- 细进度条 `.dsx-meter-fill`：`<80%` 绿、`≥80%` 黄、`≥95%` 红
- 构成三段 `.dsx-meter-breakdown`（`contextBreakdown` 的 `systemTokens/toolsTokens/messageTokens` 归一化宽度，title 里给数字）
- 数字：`65.9K / 128K · 51%`；右侧 `↑输入 ↓输出`（`projection.tokenUsage`，含缓存读）
- 完全无数据时显示「上下文用量未知」

### 卡片区（composer 上方 `.dsx-cards`）

按顺序渲染：待办卡（`projections.todos` → 可折叠 `<details class="dsx-card dsx-todos">`，默认展开，标题「待办 N/M」，列表最多 180px 滚动，标记 `✓` completed / `◐` in_progress / `○` pending）→ Plan 模式行（`projections.plan.active|pending`：`Plan 模式`/`Plan 切换中`）→ 排队提示（`projections.inbox['next-turn'].length` → 「排队中 N 条消息待发送」）。

---

## 9. CSS 类名清单（前缀 `dsx-`）

- 骨架：`dsx-app` `dsx-hd` `dsx-hd-lead` `dsx-hd-sessions` `dsx-hd-perms` `dsx-hd-actions` `dsx-hd-sub` `dsx-transcript` `dsx-bottom` `dsx-cards` `dsx-composer` `dsx-meter` `dsx-dock` `dsx-notices` `dsx-jump` `dsx-load-older` `dsx-empty`
- 消息：`dsx-msg` `dsx-turn` `dsx-turn-hd` `dsx-turn-label` `dsx-turn-time` `dsx-turn-ft` `dsx-step` `dsx-user` `dsx-user-bubble` `dsx-user-meta` `dsx-assistant` `dsx-system` `dsx-think` `dsx-think-hd` `dsx-think-body` `dsx-attempt` `dsx-inject` `dsx-cmd` `dsx-compaction` `dsx-deliver` `dsx-generic` `dsx-blocks` `dsx-text-body` `dsx-typing`
- 工具卡：`dsx-tool` `dsx-tool-hd` `dsx-tool-name` `dsx-tool-sum` `dsx-tool-state` `dsx-tool-body` `dsx-tool-sec` `dsx-tool-err` `dsx-tool-ok` `dsx-tool-error` `dsx-tool-running` `dsx-out`
- 审批/提问：`dsx-ask` `dsx-ask-approval` `dsx-ask-question` `dsx-ask-hd` `dsx-ask-kind` `dsx-ask-title` `dsx-ask-body` `dsx-ask-detail` `dsx-ask-opts` `dsx-ask-opt` `dsx-ask-opt-label` `dsx-ask-opt-desc` `dsx-ask-custom` `dsx-ask-skip` `dsx-ask-more`
- 改动卡片：`dsx-changes` `dsx-chg-hd` `dsx-chg-title` `dsx-chg-stat` `dsx-chg-add` `dsx-chg-del` `dsx-chg-files` `dsx-chg-item` `dsx-chg-file` `dsx-chg-name` `dsx-chg-badge` `dsx-chg-open` `dsx-chg-slot` `dsx-chg-loading` `dsx-chg-note` `dsx-diff` `dsx-hunk` `dsx-hunk-hd` `dsx-hunk-body` `dsx-dl` `dsx-dl-add` `dsx-dl-del` `dsx-dl-sign` `dsx-dl-text`
- 顶栏/菜单：`dsx-title` `dsx-chip` `dsx-chip-text` `dsx-chip-sub` `dsx-caret` `dsx-dot` `dsx-menu` `dsx-models` `dsx-models-left` `dsx-models-right` `dsx-menu-group` `dsx-menu-item` `dsx-menu-check` `dsx-menu-sep` `dsx-menu-warn` `dsx-menu-empty`
- 按钮：`dsx-btn` `dsx-btn-primary` `dsx-btn-ghost` `dsx-btn-outline` `dsx-btn-danger` `dsx-btn-stop` `dsx-btn-long` `dsx-btn-short`
- 待办/计划：`dsx-todos` `dsx-todo` `dsx-todo-list` `dsx-todo-mark` `dsx-todo-text` `dsx-todo-completed` `dsx-planbar` `dsx-plan-chip-inline` `dsx-plan-note` `dsx-queue`
- 用量条：`dsx-meter` `dsx-meter-bar` `dsx-meter-fill` `dsx-meter-stack` `dsx-seg` `dsx-seg-sys` `dsx-seg-tools` `dsx-seg-msg` `dsx-meter-meta` `dsx-meter-num` `dsx-meter-usage` `dsx-meter-ok` `dsx-meter-warn` `dsx-meter-bad`
- markdown：`dsx-md` `dsx-p` `dsx-h1` `dsx-h2` `dsx-h` `dsx-ul` `dsx-ol` `dsx-li` `dsx-li-deep` `dsx-quote` `dsx-hr` `dsx-pre` `dsx-code` `dsx-inline-code` `dsx-link` `dsx-table`

---

## 10. 主题与响应式

- 所有颜色只用 VS Code 变量，带 `color-mix()`/`transparent` 派生兜底：`--vscode-editor-background`、`-foreground`、`-font-family`、`-font-size`、`-panel-background`、`-sidebar-background`、`-editorWidget-background`、`-input-background`、`-input-foreground`、`-input-border`、`-focusBorder`、`-button-background`、`-button-foreground`、`-button-hoverBackground`、`-textLink-foreground`、`-descriptionForeground`、`-errorForeground`、`-editorError-foreground`、`-editorWarning-foreground`、`-charts-green`、`-charts-yellow`、`-charts-red`、`-widget-border`、`-badge-background`、`-scrollbarSlider-*`、`-list-hoverBackground`。
- 内部 token 集中在 `:root` 的 `--dsx-*`（`--dsx-fg` `--dsx-muted` `--dsx-border` `--dsx-bg` `--dsx-bg-soft` `--dsx-bg-raise` `--dsx-hover` `--dsx-accent` `--dsx-ok` `--dsx-warn` `--dsx-danger` `--dsx-focus` `--dsx-input-bg` `--dsx-input-border` `--dsx-btn-bg` `--dsx-btn-fg` `--dsx-code-bg` …），换主题只换映射。
- 预览页用 `html[data-theme="light"]` 覆盖同一批 `--vscode-*` 变量来验证亮色。
- 响应式断点：`≤960px` 隐藏 cwd 与胶囊副值、按钮换短文案；`≤760px` 标题两行、会话入口隐藏；`≤640px` 权限档隐藏。全部为单行/不横向滚动。

---

## 11. 安全模型

1. 任何模型/宿主文本先 `escapeHTML()` **再**做受控 markdown；`renderMarkdown` 内部先转义整段，再逐个替换标签，永远不会把原文当 HTML。
2. markdown 白名单：标题、粗体/斜体/删除线、行内代码、围栏代码（带语言标签）、有序/无序列表（含嵌套）、引用、分隔线、链接、表格。原始 HTML 一律按文本转义显示。
3. 链接协议白名单：`http:` `https:` `mailto:` `file:` `vscode:` 以及 `./` `../` `/` 相对路径；其余（`javascript:` `data:` 等）渲染成「文本 (href)」纯文本，不生成 `<a>`。点击走 `open-link` 交给扩展，webview 内不导航（`e.preventDefault()`）。
4. 属性值统一走 `setAttribute`；不拼 `on*` 处理器；事件统一 `addEventListener`。
5. `innerHTML` 只用于两处：`renderMarkdown()` 的确定性输出、`pre.textContent` 之外无用户内容拼接。
6. 任何渲染异常的兜底：`try/catch` → 通知 + console，不影响其它消息。

---

## 12. 验收路径

1. **浏览器假数据**：`media/preview.html` 直接打开（或任意静态服务器），顶栏 9 个场景按钮：`完整会话`、`流式输出`、`审批/提问`、`空态（未连接）`、`空态（未登录）`、`中断与错误`、`排队/长历史`、`改动卡片`、`改动卡片-展开`；`浅色/深色` 切主题；`发送日志` 看 webview→宿主的真实 postMessage 序列。`改动卡片-展开` 会在 220ms 后自动点开第一个文件、420ms 后回一条含 2 个 hunk（有 `+`/`-`/上下文行）的 diff，用来验证懒加载与配色。
2. **真链路**：`node scripts/e2e-bridge.mjs`（扩展侧已有），浏览器开 `http://127.0.0.1:8902/bridge.html`，发一条消息可看到真实流式、工具卡、思考折叠。宽屏与 880px 窄屏各截一张。
3. **语法**：`node --check media/chat.js`、`node --check media/dev-fixtures.js`。

---

## 13. 待补（契约缺口，未改 protocol.ts）

1. **审批卡缺少关联信息**：`UiAsk` 没有 `toolName` / `callId`，卡片上无法「跳到对应工具调用」。`approval/asked` 事件里有这两个字段，但事件与 ask 之间没有可用的 id 关联。
2. **`UiAsk` 无 `answers`/默认值**：审批选项文案只能靠 `options[].label`，扩展不传时 webview 兜底成「允许一次 / 拒绝」。
3. **composer 附件**：`prompt.content` 支持 `image`/`file` 块，但 WebToHost 没有「选择文件」回包，面板暂无附件入口。
4. **按会话的模型/权限**：`UiSessionRow` 只有标题/运行态/cwd，会话列表里无法显示每个会话的模型与权限档。
5. **打开完整 UI 无法指定会话**：`open-full-ui` 无参数，只能打开默认地址。
6. **排队消息没有正文**：`projections.inbox['next-turn']` 只用来显示条数，无法展示排队内容。
7. **token 估算**：composer 的 token 提示是 `字符数 / 1.7` 的粗估，不是真实分词。
8. **`projections` 部分键未渲染**：`agentTeam`、`subagent*`、`contextTimeline`/`contextHeaders`/`contextActivity`、`userQuestions`、`sessionStats`、`goal`、`imageLimits`、`sessionListMetadata` 目前不产生 UI（需求未覆盖）；若验收要求，可作为下一轮。
9. **无「重命名会话」入口**：`rename-session` 已定义但未接 UI。
10. **`attachSelection`/`pick-cwd`** 这类交互（在 VS Code 里选工作目录）没有入口。
11. **diff 的 `before`/`after` 没被使用**：当宿主只给整文件 `before/after`（`coarse: true` 或没有 `hunks`）时，webview 不会自己算行级 diff，只显示「行级对比不可用」。若要逐行高亮，需要扩展侧补 `hunks`。
12. **`UiChangedFile.index` 与 `UiDiff.index` 的语义**：前端按 `index` 匹配文件行（同一条 `changes` 内），跨 `changes`（不同 seq）没有稳定 id；若同一轮多次推送 changes，旧缓存会随旧卡片一起丢弃。
13. **`changes.seq` 与事件 seq 的关系未定义**：卡片去重只按 `changes.seq` 相等判断；`open.records` 里 changes 记录的 `seq` 被视为同一命名空间。

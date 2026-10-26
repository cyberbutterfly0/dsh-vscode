# 当前状态与验收矩阵

> 最后一次更新：2026-10-26 23:20
> 版本：`local.dsh-vscode-0.1.0`（vsix 110.8 KB，sha256:1487594788eaee4c）

## 一、已真机验证（跑通）

| 能力 | 验证方式 | 结果 |
| --- | --- | --- |
| 鉴权（/connect 换 cookie） | `scripts/check-token.mjs` | 401 → 302 → v1 cookie，`session/list` 返回真实会话 |
| 连接已有实例 / spawn 新实例 | `scripts/smoke.mjs` | 复用凭据 627ms；spawn 10~16s（dsh 自身启动慢） |
| 会话列表 + 标题投影 | e2e bridge + 真 dsh | 标题来自 `title` 投影，缺省回退首条 prompt |
| 历史消息回放 | e2e bridge 刷新页面 | `follow` 快照的 `open.records` 完整重建两轮对话 |
| 流式渲染 | e2e bridge + 真 prompt | `assistant-stream` 四型 chunk 增量渲染，`turn/end` 收尾 |
| 工具卡片 | e2e bridge + 真 pwsh 调用 | `tool/call` + `tool/result` 配对，显示成功/失败/耗时/exit |
| 模型切换 | `session/selectModel` + 真切换 | 胶囊显示 `DeepSeek-V4.1-Flash · High`，投影 `modelSelection` 同步 |
| 权限胶囊 | `permissionPresets/catalog` | 四档 read-only / workspace-write / danger-full-access / auto |
| 用量条 | `tokenUsage` + `contextPressure` | `23.2K / 1M · 2%` 正确 |
| 窄屏布局 | 880 / 700px 截图 | 顶栏单行、按钮短文案、cwd 隐藏 |
| 打包与安装 | `scripts/make-vsix.mjs` + `code --install-extension` | 98.9 KB vsix，装到 `~/.vscode/extensions/local.dsh-vscode-0.1.0` |
| mux 心跳 / 断线重连 | 代码修复 + 压测 | 半死 socket 不再拖垮重连 |
| **审批卡片端到端** | 真机：写工作区外文件 → 审批卡 → 点「允许一次」 | `$events` waterfall 到达 → 卡片渲染 → `$events/result` ok → 工具继续执行 → 文件真的写进 `C:\Windows\Temp` |
| **VS Code 真窗口激活** | 隔离实例 `--user-data-dir/--extensions-dir` + 真文件夹 | exthost 记录 `ExtensionService#_doActivateExtension local.dsh-vscode, activationEvent: 'onStartupFinished'`；`~/.dsh/dsh-vscode/activate.log` 落盘 `{"version":"0.1.0","vscode":"1.134.0"}` |
| **改动可视化（内联 diff）** | e2e bridge 真机：让模型写 `changes-demo.txt` | 卡片「± 改动 1 个文件 +3 −0」；点文件 → `load-diff` → hunk `@@ -1,0 +1,3 @@` + 三行绿底 `+ alpha/beta/gamma` |
| **侧栏聊天视图** | 隔离实例 + `dsh.openViewOnStart` | `view.log` 出现 `cmd-start → container-open → resolve → focus-ok → ready`；真窗口截图里侧栏「DSH」容器正常渲染聊天（工具卡 + 改动卡片 + composer + 用量条）与会话列表 |
| **编辑器右键入口** | 真窗口：选中代码 → 右键 | 菜单出现「把选中的代码发给 DSH」「就当前文件问 DSH」；点前者弹出输入框并正确带出 `文件:1-5` 行号 |

## 二、未验证 / 待补

1. **多窗口共享**：一个 token 只允许一条 mux；已实现 409 时换凭据接管（409 有 60 秒冷却，401 不冷却、连续 3 次失败就停），但两个 VS Code 窗口同时连的真实场景没跑过。
2. 会话重命名 / 切换工作目录 / 附件（图片、文件引用）在 UI 上没有入口（协议里已有端点）。
3. `coarse` diff（只有整文件 before/after、没有 hunks）目前只提示「行级对比不可用」，没在本地算行级差异。
4. 编辑器上下文里的文件路径：没打开工作区文件夹时会退回绝对路径（`e:\dsh结算\vscde\.smoke-tmp\ws\src.ts`），打开文件夹后是相对路径。可优化成始终用文件名。

## 二·附、编辑器侧入口怎么用

- 默认**不**自动带上下文（`dsh.sendWorkspaceContext` 默认 false），因为每轮都带会明显吃 token。
- 想一直带：设置里打开 `dsh.sendWorkspaceContext`，之后每条消息前会自动拼 `<editor-context>`（当前文件、行数、未保存状态、选区或光标行、该文件前 5 条 error/warning）。
- 想按需带：编辑器里选中代码 → 右键「把选中的代码发给 DSH」→ 补一句想问什么 → 自动打开聊天并发送；或右键「就当前文件问 DSH」。
- 想从文件树带：资源管理器里右键文件 →「就当前文件问 DSH」。

## 二·附二、审批链路的坑（重要，别再踩）

`openSession()` 原来调 `closeStreams()`，而它会连带关掉**连接级**的全局流 `session/control`（投影）和 `$events`（审批/提问）—— 换一次会话，之后就再也收不到 `approval/request`，外部表现就是「工具卡一直运行中、没有审批弹窗」。
现在拆成 `closeFollow()`（只关会话级 follow），换会话不动全局流；`openSession` 里若发现全局流缺失还会补开。
排查时靠 `core.onEventsFrame` 的两行日志确认通道活着：`$events 就绪 clientId=…` 和 `$events emit <name>`。

## 三、已知缺陷

- 老会话可能返回 `session/writer-held`：`core.sendPrompt` 会自动重开 follow 重试一次，二次失败现在给的是中文提示（「这条会话被另一个窗口或进程占着写句柄…新建一个会话继续」）。跨进程的写所有权不释放，**换新会话即可**。
- `media/chat.js` 在「会话已选中但记录为空」时显示「开始对话」空态，容易被误认为没打开会话。
- 改动卡片的展开状态不保留：同一轮 `changes` 被覆盖重建时会收起。

## 四、聊天视图（侧栏）

- 除编辑器 tab 外，另注册视图 `dsh.chatView`（`type: webview`，挂在 `dshContainer` 活动栏容器，`visibility: visible`）。
- 两个载体共享同一份 `SessionCore`：`controller.broadcast()` 把 core 的消息同时发给 tab 和视图；`controller.setTitle()` 两边同步标题。
- 视图可以被拖到「辅助侧边栏 / 面板 / 主侧边栏」——用 VS Code 自带的视图拖动，不需要我们改位置。
- 一键定位：命令面板搜 `dsh: 打开侧栏聊天`（`dsh.openChatView`）。
- 排查：`~/.dsh/dsh-vscode/view.log` 记录 `resolve` / `ready`；没有这个文件说明视图压根没被创建（容器没展开，或 `package.json` 的视图声明没生效）。

## 五、开发命令

```bash
npm run build          # esbuild 打包 dist/extension.js
npm run typecheck      # tsc --noEmit
npm run test:editor-context   # 假 vscode 模块跑编辑器上下文逻辑（10 条断言）
node scripts/smoke.mjs # 起真 dsh 跑一遍连接 + 建会话（--prompt 可发消息）
node scripts/e2e-bridge.mjs --verbose   # 浏览器里跑真 core + 真前端（http://127.0.0.1:8902/bridge.html）
node scripts/make-vsix.mjs              # 打 vsix 到 dist/
```

> `smoke.mjs` 的 spawn 模式依赖 `dsh web --port 0` 冷启动，本机装了 22 个第三方插件时会很慢（15s 起，赶上插件抢锁能拖到数分钟）。要快速验证用 `--attach <url>` 复用已有实例，或直接看 e2e bridge。

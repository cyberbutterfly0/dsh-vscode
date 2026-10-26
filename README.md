# dsh for VS Code

把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（下称 dsh）接进 VS Code：在编辑器标签页里聊天，会话列表进侧边栏，需要时一键切换到完整 dsh 界面。

本扩展**不内嵌 runtime**，只通过 dsh 的 HTTP + WebSocket 线上契约通信，因此不依赖任何 `@deepseek-ai/*` 包，dsh 升级不会把扩展弄坏。

## 安装

**前置条件**：本机已安装 dsh。

```powershell
npm i -g @deepseek-ai/dsh
dsh --version
```

装扩展：

```powershell
# 从 Releases 下载 dsh-vscode-0.1.0.vsix 后
code --install-extension dsh-vscode-0.1.0.vsix

# 或自己打一份
npm install
npm run build
node scripts/make-vsix.mjs     # 产物在 dist/
```

要装进别的配置文件（VS Code 的 profile）就加 `--profile`：

```powershell
code --profile stm32 --install-extension dsh-vscode-0.1.0.vsix --force
```

装完后活动栏出现 dsh 图标，命令面板里有 `dsh:` 开头的命令。

## 用法

| 操作 | 入口 |
| --- | --- |
| 打开聊天 | 活动栏 dsh 图标 → `打开聊天`，或命令 `dsh: 打开聊天` |
| 打开侧栏聊天 | 命令 `dsh: 打开侧栏聊天`（视图可拖到辅助侧边栏）；想每次启动自动开就设 `dsh.openViewOnStart` |
| 新建会话 | 聊天右上角 `+`，或命令 `dsh: 新建会话` |
| 切换会话 | 侧边栏会话列表点一下 |
| 完整 dsh 界面 | 聊天右上角 ↗，或命令 `dsh: 打开完整界面` |
| 切模型 | 聊天底部模型下拉（走 `session/modelCatalog`） |
| 切权限档 | 聊天底部权限下拉：read-only / workspace-write / danger-full-access / auto |
| 审批 | 模型要越权时聊天里弹卡片，允许一次 / 拒绝 |
| 看本轮改了哪些文件 | 每轮结束后聊天里出现「± 改动 N 个文件」卡片，点文件名展开红绿 diff，右侧可「用编辑器打开」 |
| 带着当前代码提问 | 编辑器里选中 → 右键 `把选中的代码发给 DSH`；或右键 `就当前文件问 DSH`；或设置里打开 `dsh.sendWorkspaceContext` 让每条消息自动带上下文 |

### 连接方式

`dsh.mode` 三种：

- `auto`（默认）：先复用凭据文件里还能用的实例，没有再 spawn 一个。
- `spawn`：每次自己起 `dsh web --port 0 --no-open`，退出时杀掉。
- `attach`：连已有实例，地址填 `dsh.attachUrl`（形如 `http://127.0.0.1:51713/?token=...`）。

凭据存在 `~/.dsh/dsh-vscode/instances.json`。多人共用一个 dsh 实例时，同一个 cookie 只能开一条连接，所以**同一时间只有一个窗口真正连着**。

## 配置

| 键 | 说明 |
| --- | --- |
| `dsh.mode` | `auto` / `spawn` / `attach` |
| `dsh.cliPath` | dsh 可执行文件路径，留空自动找 |
| `dsh.attachUrl` | attach 模式下的完整启动 URL（含 token） |
| `dsh.autoStart` | 打开 VS Code 就自动连 |
| `dsh.defaultCwd` | 新会话的工作目录，留空用第一个工作区 |
| `dsh.defaultPermission` | 新会话的权限档 |
| `dsh.extraSpawnArgs` | spawn 时追加的参数 |
| `dsh.logLevel` | `error` / `warn` / `info` / `debug` |
| `dsh.sendWorkspaceContext` | 每条消息自动附带编辑器上下文（当前文件、选区或光标行、该文件的 error/warning）。默认关，开了每轮多几百字 |
| `dsh.openViewOnStart` | 打开 VS Code 就自动展开侧栏聊天视图 |
| `dsh.fullUiZoom` | `1` | 完整 dsh UI（iframe）缩放，0.5–1.5 |
| `dsh.startTimeoutMs` | `45000` | 等 dsh 打印地址的超时（毫秒） |
| `dsh.stopOnExit` | `false` | 关 VS Code 时是否杀掉自己启动的 dsh |
| `dsh.env` | `{}` | 追加给 dsh 进程的环境变量 |

## 出问题怎么办

- **找不到 dsh**：命令 `dsh: 显示日志` 看 Output 面板的 `DSH` 频道；确认 `dsh` 在 PATH 里，或直接填 `dsh.cliPath`。
- **连不上 / 401**：token 过期了。重新跑一次 dsh web，把新 URL 填进 `dsh.attachUrl`，或把 `dsh.mode` 改成 `spawn` 让扩展自己起。
- **两个窗口抢连接**：关掉其中一个，或命令 `dsh: 重新连接`。
- **想清掉凭据**：命令 `dsh: 打开状态文件`，删掉 `instances.json` 里对应条目。

## 开发

```powershell
npm install
npm run build      # esbuild 打包到 dist/extension.js
npm run watch      # 开发时热构建
npm run typecheck  # tsc --noEmit
npm run smoke      # 真连一个 dsh 实例跑通连接 + 发消息
npm run vsix       # 打 dist/dsh-vscode-<version>.vsix
```

源码结构：

```
src/
  extension.ts        激活入口、命令注册、会话 TreeView
  config.ts           dsh.* 配置读取
  i18n.ts             文案（当前只有中文）
  protocol.ts         扩展 ↔ webview 的消息契约（冻结）
  dsh/
    types.ts          dsh 线上契约的类型镜像
    auth.ts           token → cookie
    rpc.ts            HTTP 一元调用
    mux.ts            WebSocket 多路复用流
    runtime.ts        找 dsh、spawn、抓 URL
    client.ts         连接生命周期 + 凭据复用
    api.ts            每个端点一个方法
  chat/
    core.ts           会话状态机（唯一有状态的地方）
    controller.ts     webview ↔ core 的翻译层
    panel.ts          编辑器标签页
    full-ui.ts        完整 dsh 界面 iframe
media/
  chat.js, chat.css   自绘聊天界面（零依赖）
  preview.html        浏览器里直接预览 UI
```

打包脚本 `scripts/make-vsix.mjs` 自己写 zip，不依赖 vsce。

## 许可

私有自用，不分发到 Marketplace。

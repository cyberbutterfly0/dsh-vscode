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
code --install-extension dsh-vscode-0.3.0.vsix

# 或自己打一份
npm install
npm run build
node scripts/make-vsix.mjs     # 产物在 dist/
```

要装进别的配置文件（VS Code 的 profile）就加 `--profile`：

```powershell
npm run install:local            # 默认 profile + 所有 profile 一次装完（会清掉旧版本目录）
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
| 发图片 | 直接在输入框里 `Ctrl+V` 粘贴（截图工具复制的图即可），或把图片拖进来；也可以用底部左侧的 `图片` 按钮选文件。缩略图排在输入框上方，随消息一起发出 |
| 会话被别的窗口占用 | 不用管：会自动新建同目录会话继续，聊天里给一条提示 |

### 0.3.0 起：默认连你自己起的 dsh（attach）

以前扩展会自己起一个 dsh，结果浏览器和 VS Code 各跑一个进程，回浏览器打开同一个会话就报「当前会话已被占用」。

0.3.0 把 `dsh.mode` 默认值改成 `attach`：

1. 点一次 **DSH 启动器**（`dsh-launch.bat`）。它会盘点并清掉所有残留的 dsh 进程，起一个新的 3080，再把带 token 的 URL 写进 `~/.dsh/logs/last-launch.url`
2. 在 VS Code 里发消息，扩展读那个文件拿 token 连上去

两边连的是**同一个 dsh 进程**，所以浏览器和 VS Code 看到的是同一份会话，不再互相锁。

- 启动器还会写 `~/.dsh/logs/dsh-instances.json`（当前实例清单），VS Code 扩展只读不杀进程
- 不确定自己开了几个 dsh 就双击 `dsh-status.bat`，它会列出所有实例、端口、内存、token 文件是否有效
- `dsh.launchFile` 可改；`dsh.attachUrl` 一旦填了就优先用它，不再读文件
### 连接方式

`dsh.mode` 三种：

- `auto`（默认）：先复用凭据文件里还能用的实例，没有再 spawn 一个。
- `spawn`：每次自己起 `dsh web --port 0 --no-open`，退出时杀掉。
- `attach`：连已有实例，地址填 `dsh.attachUrl`（形如 `http://127.0.0.1:51713/?token=...`）。

凭据存在 `~/.dsh/dsh-vscode/instances.json`。多人共用一个 dsh 实例时，同一个 cookie 只能开一条连接，所以**同一时间只有一个窗口真正连着**。

### 让位：在 VS Code 和浏览器之间来回切

dsh 的会话写锁是**内核级**的（Windows 命名信号量 / POSIX `flock`），绑在持有它的进程上——进程不死，锁就不放。所以只要扩展自己起的那个 dsh 还活着，你在浏览器里打开同一个会话就会看到：

> 当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。

0.2.3 起有了「让位」：

- **失焦自动让位**：窗口失去焦点 `dsh.yieldDelayMs`（默认 20 秒）后，自动停掉扩展自己起的 dsh，把锁交出去。
- **回到窗口自动接回**：重新聚焦时重启 dsh 并重新订阅当前会话。
- **手动让位**：命令面板执行 `DSH: 让位`。
- **退出即让位**：关 VS Code 时也会停掉自己起的 dsh（`dsh.yieldOnBlur` 开着时）。

三种情况不让位：正在跑回合（免得打断对话）、连的是别人的实例（没进程可杀）、`dsh.yieldOnBlur` 关掉了。

代价是每次让位都会丢掉 dsh 进程内的状态，回来时要重新加载插件（约 2–3 秒）。觉得太频繁就把 `dsh.yieldDelayMs` 调大。

### 0.4.0：一个项目连一个实例

双实例模式（启动器里选 2）时，两个项目各连一个 dsh：

```json
// <项目>/.vscode/settings.json
{ "dsh.attachUrl": "http://127.0.0.1:3081/?token=xxxxx" }
```

**工作区设置优先于全局设置**，全局的 `dsh.attachUrl` 留空即可。启动器起来后会把两个实例的 URL 都打印出来。

0.4.0 同时修掉一个会让进程越攒越多的 bug：扩展退出时**无条件回收自己 spawn 的 runtime**。之前按 `stopOnExit` 决定，而它默认 false，导致每重载一次窗口就留一个孤儿进程（有人攒到过 22 个、1.9 GB）。attach 模式下扩展没有自己 spawn 的进程，这个改动不会误杀启动器起的实例。
## 启动器（可选，但强烈建议）

扩展自己**不会启动 dsh**（0.3.0 起默认 attach）。它必须拿到一个带 token 的 URL 才能连上，而这个 token 只在 dsh 启动时打印一次。

最省事的办法是用一个启动器：起 dsh → 抓 token → 写进 `~/.dsh/logs/last-launch.url` → 扩展开机自动读。

`tools/` 下放了三份 Windows 脚本，**但请先读 [docs/launcher.md](docs/launcher.md)**。那份文档讲清楚了：

- 为什么需要它（token 机制、扩展看不见终端）
- 它和扩展的分工边界（谁清实例、谁负责重连）
- 不用它的最小做法（手动填 `dsh.attachUrl`）
- 为什么必须只有一个 dsh 实例（内核级会话写锁 + 单例插件会整体不激活）
- 双实例怎么配，代价是什么

一句话：启动器只是「把 token 递过来 + 清理多余实例」的自动化，不是运行时依赖，脚本是给你按自己机器改的。
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
| `dsh.yieldOnBlur` | `true` | 失焦一段时间后自动让位，把会话写锁交还给浏览器 |
| `dsh.yieldDelayMs` | `20000` | 失焦多久之后让位（毫秒，最小 5000） |
| `dsh.yieldResumeOnFocus` | `true` | 重新聚焦时自动重启 dsh 并接回当前会话 |
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



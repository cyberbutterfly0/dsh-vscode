# 启动器与扩展的关系

这份文档讲一件事：**这个扩展为什么需要一个外部启动器**，以及不用它的时候怎么办。

仓库 `tools/` 下放了两份 PowerShell 脚本，但请先读完这一节再决定要不要用——它们不是扩展的运行时依赖，只是"把 token 递过来"这个动作的自动化。

---

## 1. 问题的起因：token 只出现一次

`dsh web` 启动时会在本地生成一个一次性 token，只打印在**启动它的那个终端的 stdout** 里：

```
dsh web: http://127.0.0.1:3080/?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

这个 token：

- **不进环境变量**，**不落盘**，每次启动重新随机生成（32 字节 base64url，43 个字符）
- 进程一退出就作废，新进程一定换新的
- `~/.dsh` 下没有任何文件保存它

而扩展跑在 VS Code 的 extension host 里，**看不见那个终端**。所以扩展启动时手里什么都没有，必须有人把 URL 递给它。

顺带提一句：这个 token 不是口令，只是"换 cookie 的凭据"。扩展拿到后会调 `/connect?token=...` 换成一个 30 天有效的 v2 cookie 存进 `~/.dsh/dsh-vscode/instances.json`。**同一次 dsh 进程生命周期内，token 只在第一次连接时用一次**，之后靠 cookie。

---

## 2. 扩展拿 URL 的三条路

按优先级：

| 优先级 | 来源 | 什么时候用 |
| --- | --- | --- |
| 1 | **工作区设置** `dsh.attachUrl`（写在 `.vscode/settings.json`） | 一个项目固定连某个实例（双实例场景） |
| 2 | **全局设置** `dsh.attachUrl` | 就一个实例，所有项目都连它 |
| 3 | **启动器写的文件** `~/.dsh/logs/last-launch.url` | 日常最省事的方式 |
| 4 | `~/.dsh/dsh-vscode/instances.json` 里缓存过的实例（自动探活） | 上次连过且进程还活着 |

前两条准确但不自动，第四条只在 cookie 没过期且进程没重启时有效。第三条是唯一"重启之后还自动连上"的路子——**这就是启动器存在的全部理由**。

没有启动器也能用，只是每次 dsh 重启，你得手动把新 URL 贴进去一次。

---

## 3. 启动器干了四件事

`tools/dsh-launch.ps1`：

1. **盘一次场**：扫全系统 `node.exe` 的命令行，找出所有 `dsh/lib/bin.js` 进程（不只看 3080，这是旧版启动器的盲区）
2. **清干净**：多于一个就全部停掉（它们的会话写锁会互相打架，详见第 5 节）
3. **起一个**：`dsh web --port 3080 --no-open`，从 stdout 抓 `dsh web: <url>`，写入 `~/.dsh/logs/last-launch.url`
4. **开窗口**：用 Edge/Chrome 的 `--app=` 模式打开，得到一个没有地址栏的独立窗口

第 3 步的产物 `last-launch.url` 长这样：

```
http://127.0.0.1:3080/?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# port=3080
# written=2026-10-28 01:20:33
```

扩展只读第一行那个 URL。

---

## 4. 不用启动器的最小做法

```powershell
# 终端里跑，别关这个窗口
dsh web --port 3080 --no-open
# 复制它打印的 dsh web: http://...?token=... 整行
```

然后在 VS Code：

- 命令面板 → `DSH: 连接已有实例` → 粘贴 URL（一次性，存进 cookie）
- 或者把 URL 填进设置 `dsh.attachUrl`（长期）

这样也能用，代价是每次 dsh 重启要重复一遍。

---

## 5. 为什么必须只有一个实例

这不是洁癖，是硬约束：

**会话写锁是内核级的。** dsh 给每个会话的目录挂一把 `session.lock`——POSIX 用 `flock`，Windows 用命名内核信号量。锁跟着进程走，进程死才释放，**没有超时、没有过期**。源码注释原话是「A live but wedged holder keeps the lock until its process exits」。

后果：第二个 dsh 去打开同一个会话，API 直接返回 `session/writer-held`，界面上就是那句「当前会话已被其他 DSH 窗口占用」。web API 里**没有任何释放锁的端点**，所以只能让占用者退出。

**单例插件会整个不激活。** 比如 task-board 的账本是文件锁独占的，第二个实例里它直接不挂载，日志打 `dsh: warning: 1 entry did not activate`。这是功能缺失，不是性能问题。

**内存。** 每个实例 200–560 MB。这台机器上曾经同时跑着 22 个、1.9 GB，全是旧版扩展每次重载窗口漏下来的孤儿进程。

---

## 6. 双实例模式

启动器菜单选「双实例」时起 3080 + 3081 两个，`tools/dsh-launch.ps1` 会额外写 `~/.dsh/logs/last-launch-3081.url`。

这时候要让第二个项目明确连 3081，在**那个项目**的 `.vscode/settings.json` 里写：

```json
{
  "dsh.attachUrl": "http://127.0.0.1:3081/?token=..."
}
```

工作区设置优先于全局设置，这是 0.4.0 加的。

**要接受的代价**：两个实例的会话互不冲突（写锁是按会话算的），但单例插件只有一个能用，内存翻倍。

---

## 7. 文件清单

| 文件 | 作用 | 编码要求 |
| --- | --- | --- |
| `tools/dsh-launch.ps1` | 主启动器，方向键菜单选单/双/关 | UTF-8 **带 BOM**（PS 5.1 才认中文） |
| `tools/dsh-launch.bat` | 双击入口，参数透传给 ps1 | CRLF，**无 BOM** |
| `tools/dsh-status.ps1` | 只读盘点：实例数、端口、内存、token 状态 | UTF-8 带 BOM |

`dsh-launch.ps1` 会自动找 `dsh`（先看 PATH，再看 `npm root -g`）和浏览器（Edge 优先，其次 Chrome）。找不到会红字提示，也可以用 `-DshCmd` / `-Edge` 显式指定。

**这些脚本是给你改的，不是让你直接用的。** 端口、浏览器路径、要不要自动清理，都取决于你的机器。

---

## 8. 已知限制

- 脚本只支持 Windows（用了命名互斥体、`Get-CimInstance Win32_Process`、`netstat`）
- `dsh-status.ps1` 的「健康」判定把 401 也算活着——没有 cookie 时 401 才是正常反应，500 才算挂了
- 启动器重启会打断正在跑的回合。正在干活时别点它，或者用 `-NoRestart`（复用当前实例，仅在 token 还有效时可行）
- 双实例模式下 `last-launch.url` 永远指向 3080，3081 的要单独写进项目设置

---

## 9. 如果不想碰这些

给扩展一个长期有效的连接就行：

1. 找到你平时跑 dsh 的方式，拿一次 URL
2. 填进 `dsh.attachUrl`（全局或工作区）
3. 别让那个 dsh 进程死

扩展会自己用缓存的 cookie 重连，token 过期了才需要你贴新的。启动器只是把"拿新 token"这件事自动化了而已。

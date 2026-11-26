# macOS 连接器：移植清单

状态：只读代码整理出的清单，都还没有在 Mac 上验证。日期：2026-11-26。

连接器和中继都是 Node 程序，大部分代码不分平台；但到目前为止只在 Windows 上验收过（[QUICKSTART.md](../../QUICKSTART.md) 的“已知限制”）。这份清单列出代码里只按 Windows 写的地方，供在 Mac 上逐项确认和修改。每项确认或修好后，在本页记下结果和日期。

打包（托盘、开机自启、安装包）不在本页范围：先让源码版连接器在 Mac 上跑通，再做打包。

## 在 Mac 上从源码运行

需要 Node 24、已登录的 Claude Code 或 Codex。仓库目录里：

```sh
npm ci
npm test                       # 先看哪些测试失败，见 §8
npm run build
npm run setup -- --mode connector --relay https://你的中继地址 --token <中继 Token> --yes
npm run connector
```

- `setup` 在问答模式下只问中继地址、不问 Token，所以 Token 用 `--token` 传入。不想留在 shell 历史里，可以改用 `--settings-stdin`，从标准输入传 JSON：`{"mode":"connector","relayUrl":"…","token":"…"}`。
- 配置写在仓库的 `.local/config.json`。**不要从别的电脑复制 `.local/`**，相同的 `machineId` 会让两台电脑的连接互相顶掉。
- 连接器从终端启动，继承终端的 PATH。以后改成 launchd 自启时，环境里没有终端的 PATH，`codex`、`claude` 要写成完整路径（`codexBin`、`claudeBin` 或 `CODEX_BIN`）。

验收：手机网页的电脑列表里出现这台 Mac；能列出项目和会话；在测试会话里发一条消息并收到回复。

## 1 Antigravity：必然不可用

`src/connector/antigravity-hub.ts:30-57` 的 `defaultFilterAntigravityPids` 和 `defaultOwnsSocket` 用 PowerShell、`Get-Process` 和 `netstat`，核对的进程路径是 `%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe`。每条到 Hub 的 TLS 连接在写入 CSRF Token 之前都要先通过 `ownsSocket`（`:151-155`），所以在 Mac 上所有 Antigravity 请求都会失败。

要做：

- 写 Mac 版的两个函数：用 `ps -o comm= -p <pid>`（或 `lsof -p <pid>` 的 `txt` 行）核对进程路径；用 `lsof -nP -a -p <pid> -iTCP@127.0.0.1:<端口>` 核对这条 TCP 连接的服务端确实属于这个进程。
- 在 Mac 上确认：Antigravity 语言服务程序的实际路径（应在 `/Applications/Antigravity.app/Contents/…` 下，名字可能带平台后缀）；`~/.gemini/antigravity/hub_*.json` 是否同样存在、字段是否相同。
- Antigravity 语音（`src/connector/antigravity-voice.ts`）也走这个 Hub，修好上面两处后一起验。

## 2 只有 Windows 版的脚本

| 脚本 | 用途 | Mac 上 |
| --- | --- | --- |
| `start.cmd`、`stop.cmd`、`configure.cmd`、`connector-only.cmd` | 启动、停止、配置 | 用上面的 `npm run setup` / `npm run connector` 代替 |
| `scripts/windows/*.ps1` | 启动、停止、自启、访客包、更新 | 没有对应版本 |
| `npm run update:deploy`（`scripts/connector-deploy.ts:18-19`） | 等空闲后替换并重启连接器 | 调用 PowerShell，不能用；手动停止后重新 `npm run connector` |
| `npm run package:windows` / `package:guest` | 便携包、访客包 | 不能用 |
| `scripts/windows/tray/` | 托盘（C# + WebView2） | 需要另写（Swift 菜单栏图标 + WKWebView），要在 Mac 上用 Xcode 编译；窗口内容 `desktop/` 是网页，可复用 |

## 3 找 Codex 程序

`src/connector/app-server.ts:14`：不是 Windows 时直接用 PATH 里的 `codex`。只装了 Codex 桌面版、没有命令行版时，`setup` 报“未找到可用的 Codex”。

要做：

- 在 Mac 上找到桌面版自带的 codex 程序（应在 `/Applications/Codex.app/Contents/Resources/` 下），先用 `CODEX_BIN` 指过去验证。
- 确认后，给 `resolveCodex` 加 Mac 的候选位置，和 Windows 的 `resolveWindowsCodex` 对应。
- `scripts/setup.ts` 和 `scripts/setup-config.ts` 的提示文字写的是 `codex.exe`，Mac 上要改说法。

## 4 和 Codex 桌面版的本机通信

`src/connector/desktop.ts:55` 在非 Windows 上依次试两个 Unix socket：`$CODEX_HOME/ipc/ipc.sock`（默认 `~/.codex/ipc/ipc.sock`）和 `<系统临时目录>/codex-ipc/ipc-<uid>.sock`。两个路径都没验证过。

连不上时，桌面版里开的会话在手机上看不到实时状态，也不能接着发。在 Mac 上打开 Codex 桌面版，用 `lsof -U | grep -i codex` 找实际的 socket 路径；路径不同就改这里，临时可以用 `CODEX_IPC_PATH` 指定。

## 5 桌面版正在运行的轮次

`src/connector/paginated-history.ts:44` 的 `indexedTurnHasWriter` 在非 Windows 上直接返回 `false`。它靠 Windows 的独占字节锁判断“桌面版正在写这个会话”，Mac 上的文件锁是建议锁，读文件不会失败，这个办法用不了。

影响：在电脑上直接开始、还在运行的 Codex 轮次，手机上显示为空闲。不影响发送。Mac 上要另找判断方法（例如桌面 IPC 的状态，或数据库里的轮次状态），优先级低。

## 6 Claude Code 和 Claude Artifact

- 找 `claude`：`src/connector/claude-runtime.ts:52-54`，PATH 加 `~/.local/bin/claude`。官方安装脚本装在 `~/.local/bin`；Homebrew 装在 `/opt/homebrew/bin`，从终端启动时在 PATH 里。预计能用。
- Artifact 用的浏览器：`src/connector/claude-artifacts.ts:71` 有 Mac 的 Chrome / Edge 路径；判断浏览器配置是否被占用用 `SingletonLock`（`:89`）；按进程找窗口标题（`:99-101`）和结束浏览器（`:620`）只有 Windows 版（`tasklist`、`taskkill`），Mac 上会跳过或失败，要验证登录 claude.ai 和打开 Artifact 的流程。
- 语音：`src/connector/claude-voice.ts:41` 有 Mac 分支，未验证。

## 7 保护目录

`src/connector/workspace.ts:121` 在非 Windows 上把 `/etc`、`/usr`、`/bin`、`/sbin`、`/var`、`/System`、`/Library` 列为不能当项目的目录。Mac 上 `/etc`、`/var`、`/tmp` 是指向 `/private/…` 的链接，项目路径解析成真实路径后变成 `/private/etc` 等，就不再命中。把 `/private/etc`、`/private/var` 也加进列表，并补测试。

## 8 测试

78 个测试文件里有 24 个用到 Windows 路径（`C:\…`）、`win32` 或 `.exe`。在 Mac 上跑 `npm test`，先分两类：

- 测试自己写死了 Windows（例如用 `path.join` 拼出期望的 Windows 路径）：改成按平台生成期望值，或只在 Windows 上跑并注明原因。
- 真实问题：记到本页对应的一节。

## 建议顺序

1. `npm ci && npm test`，整理失败的测试（§8）。
2. 按“在 Mac 上从源码运行”启动连接器，验证 Claude Code 会话（§6）。这一项最可能直接走通。
3. Codex：命令行版或桌面版的程序（§3）、桌面通信（§4）。
4. Antigravity（§1）、保护目录（§7）、桌面版运行状态（§5）。
5. 都通过后，再做 Mac 的打包：启动 / 停止脚本、launchd 自启，最后是托盘。

## 验证记录

（在 Mac 上确认一项记一行：日期、Mac 型号与系统版本、结果。）

# 本机 Claude Code：设计

目标：手机端像操作 Codex 一样操作电脑上的 Claude Code，会话直接在 Windows 本机运行，项目和 Claude Code 自己的项目一致。

## 方向调整（2026-11-19）

最初的计划（M0–M5）是把 Cowork 接进来：读取本地 Cowork 会话、把 Cowork 会话接力到本机、导入 Cowork 项目，并仿照 Cowork 自建一个项目层（`claude-projects.json`）。后来确认 Cowork 和 Claude Code 是同一套东西，Claude Code 本身就有项目的概念，所以：

- **不再接入 Cowork**。云端 Cowork 的浏览器桥（`src/cowork-extension`、`cowork.ts`）和本地 Cowork 只读（M3 草稿）都已删除，M4、M5 取消。
- **项目就是文件夹**，设置用 Claude Code 自己的文件，不再自建项目表。

M0 中关于桌面 App 数据目录、Cowork 文件格式的记录保留在 `M0-FINDINGS.md`，仅供参考。

## 设计

### 1. 本机 Claude Code 会话（M1）
用 Agent SDK 运行：新建、续聊、排队、停止、审批、提问、计划确认、图片、模型和权限模式。会话存在 `~/.claude/projects`，终端 `claude --resume` 也能接续。`CLAUDE_CODE_ENTRYPOINT` 默认设为 `codex-mobile-web`（终端 `/resume` 列表会隐藏 SDK 默认的 `sdk-*`），可用配置 `claudeEntrypoint` 覆盖；连接器还会去掉从父 Claude Code 会话继承来的会话变量（见 `M1-RESULTS.md`）借用电脑（访客模式）固定用 `sdk-ts`，见 `docs/guest-mode/`。

启动参数只给 `cwd`、模型、权限模式和 `systemPrompt: {type:'preset', preset:'claude_code'}`。

**默认权限模式（2026-11-21）**：自用电脑上，手机没选权限模式时按“跳过权限确认”（`bypassPermissions`）运行，可用配置 `claudePermissionMode` 改成其他模式；借用电脑（访客模式）仍按 Claude Code 自己的默认（按需审批）。默认是跳过时，每个会话都带 `allowDangerouslySkipPermissions` 启动，所以运行中也能在“按需审批”等模式和“跳过权限确认”之间来回切换；会话视图里的 `canBypass` 告诉手机可以这样切。改写消息时会话重启，沿用原来的模式。会话空闲释放后再续聊，回到默认模式。

**桌面 App 的 Code 页看不到手机建的会话**：会话写在本机 `~/.claude/projects`（entrypoint `codex-mobile-web`，不在桌面的隐藏名单里），但桌面 Code 页只列它自己的会话索引（`%LOCALAPPDATA%\Claude-Data\…\claude-code-sessions`），CLI 会话要用桌面里的“Import Claude Code CLI sessions”导入才会出现（桌面日志 `[CCD-SessionRecovery] Probe: N importable CLI transcript(s)` 会数到它们）。连接器不去写桌面 App 的索引文件。`settingSources` 不传，SDK 默认读取全部设置（用户、项目、本地），所以 `CLAUDE.md`、`.claude/settings.json`、`.mcp.json` 和记忆都和终端里一样生效。

### 2. 项目 = 文件夹
- 列表：会话按 `cwd` 分组，每个文件夹就是一个项目。
- 项目设置（手机端“项目设置”）：
  | 内容 | 文件 | 手机端 |
  |---|---|---|
  | 项目说明 | 文件夹里的 `CLAUDE.md`（只有 `.claude/CLAUDE.md` 时用它） | 可编辑；超过 20 万字符时只读 |
  | MCP 服务器 | 文件夹里的 `.mcp.json` 的 `mcpServers` | 可编辑；新加的服务器写进 `.claude/settings.local.json` 的 `enabledMcpjsonServers`，和在终端里批准一样；`disabledMcpjsonServers` 里的不动 |
  | 记忆 | `~/.claude/projects/<文件夹目录>/memory/MEMORY.md` | 只读查看索引和条数 |
- 记忆目录先按这个文件夹已有会话的对话记录位置找；没有会话时按 Claude Code 的规则（非字母数字换成 `-`）推算，路径过长时不推算。
- 保存时比较读取时的版本，电脑上改过就拒绝，提示重新打开。只发改过的 MCP 文本，`.mcp.json` 坏了也不影响改 `CLAUDE.md`。
- 多文件夹：用 Claude Code 自己的 `.claude/settings.json` 里的 `permissions.additionalDirectories`，手机端暂不提供编辑。

### 3. 会话操作（和 Codex 对齐）
用 Agent SDK 自己的会话函数，写出来的会话终端 `claude --resume` 也能接着用：
| 手机操作 | 连接器动作 | SDK |
|---|---|---|
| 某轮回复下的“分叉” | `claude.fork {conversationId, upToMessageId}` | `forkSession`，`upToMessageId` 是这一轮最后一条记录（`TurnView.anchor`），新会话标题加“（分叉）” |
| 长按会话 →“复制会话” | `claude.fork {conversationId}` | 整条复制，标题加“（副本）”；会话运行中时拒绝 |
| 重命名 | `claude.rename {conversationId, title}` | `renameSession`，写入会话记录；连接器记住自己写的版本，不会误判成“电脑上正在运行” |
| 归档 | `claude.archive {conversationId}` | `archiveSession`；运行中或电脑上 20 秒内写过时拒绝。列表不显示已归档会话，在会话里再发消息会自动取消归档 |

置顶和复制会话 ID 只在手机浏览器里，Claude Code 和 Antigravity 都有（按应用和电脑分开存）。Antigravity 的 Hub 目前没有用到复制、重命名或归档的接口，所以它的菜单只有置顶和复制 ID。

### 4. 和 Codex 对齐的会话体验
| Codex 里的功能 | Claude Code 的做法 |
|---|---|
| 改写并重发消息 | `claude.edit {conversationId, turnId, text}`：用 `resume` + `resumeSessionAt` 从上一轮的最后一条记录接着跑，这条消息及之后的内容被丢弃，会话 ID 不变（已用真实 claude.exe 验证）。第一条消息没有“上一轮”，提示改用“复制会话”。不传 `resumeDropsTurn`，因为它只允许丢弃一轮。 |
| 每轮的“N 个文件已更改”卡片和差异查看 | SDK 的消息里没有改动内容，连接器另读原始记录里 Edit/Write 结果的 `toolUseResult.structuredPatch`（新建文件用 `content`），按工具调用拼成 unified diff 放进 `TurnView.diff`。 |
| 标题栏的上下文指示和“会话操作”菜单 | 上下文用量取最后一条回复的 `usage`；会话在手机控制下时再用 `getContextUsage()` 取窗口大小。菜单有复制会话、复制 ID、重命名、归档。Claude Code 不提供账号额度。 |
| 发送后立即显示消息、语音输入 | 复用 Codex 的 `PendingMessage` 和语音输入（Codex 识别或系统键盘）。 |

### 5. claude.ai 上的 Artifact（完全经电脑中转）
Claude Code 用 Artifact 工具发布的页面在 claude.ai 上，账户私有，而且 claude.ai 不允许被嵌入（`frame-ancestors 'self'`）。手机端不访问 claude.ai：
- **入口**：回复里的 `claude.ai/artifact/…` 链接显示为“在应用内查看”；发布或修改过页面的那一轮下面有页面卡片（从 Artifact/ArtifactData 工具调用和结果中取 URL 与标题）。
- **自动打开与记忆**：和 Claude 桌面应用一致，Artifact 工具的发布（不含上传资源）或 `open` 调用会让页面在聊天右侧打开（`TurnView.pages[].shown`）；手机上不自动弹出，仍从卡片进入。每个会话记住右侧开着哪个页面或已被关闭（浏览器 `localStorage`，按电脑和会话），再次进入会话时恢复；没有记录时打开会话最新的页面。页面在打开期间被修改（`pages[].changed`），该轮结束后自动重新生成快照。
- **渲染**：连接器用自己的浏览器档案打开页面。浏览器先找 Chrome，没有再用 Edge，`CLAUDE_ARTIFACT_BROWSER` 可指定；档案按浏览器分开放在数据目录下（Chrome 是 `claude-browser-chrome`，Edge 是 `claude-browser`），因为档案只能由创建它的浏览器使用。默认无头模式加普通 UA；被 Cloudflare 拦下时改用屏幕外窗口，仍被拦下（要人勾选“请验证您是真人”）时返回 `state:'challenge'`，不当作未登录、不改登录记录：DevTools 控制下的浏览器点这个勾选框会一直回到验证页，只能在电脑屏幕上的窗口里由人完成（见下文“在电脑旁”）。连接器通过 CDP 找到 `*.frame.claudeusercontent.com` 框架，等内容稳定后，在隔离环境里把 DOM 序列化成静态 HTML：样式表、`adoptedStyleSheets`、Shadow DOM、canvas（转图片）、输入框的值、子框架（`srcdoc`）都保留；图片和字体用 `Page.getResourceContent` 从浏览器缓存取，不受页面 CSP 限制；所有脚本和事件属性删除，加上只允许内联样式和 data: 资源的 CSP。
- **传输**：快照存在数据目录 `claude-artifacts/<id>/<宽度>-light.html`，按手机宽度（40px 一档）缓存。手机分块下载（复用文件下载），放进不带 `allow-scripts` 的 sandbox iframe 显示。渲染可能超过中继 40 秒超时，所以 `claude.artifact.snapshot` 最多等 25 秒，没好就返回 `rendering`，手机再次请求。
- **登录**：第一次需要登录 claude.ai。首选邮箱登录：网页端输入邮箱，`claude.artifact.login {op:'email'}` 让连接器的浏览器（屏幕外窗口）打开 claude.ai 登录页，按页面自己的标记（`.si-step[data-active]` 的 `data-step`：`email`/`sent`/`code`/`second_factor`，`#email`、`#code`、`#mfa-code`、`[data-testid=continue]`、`role=alert`）填好邮箱并提交，返回 `stage:'sent'`。用户把邮件带来的东西交回 `op:'code'`：邮件链接本身（只允许 claude.ai / anthropic.com，在连接器浏览器里打开即登录），或在其他设备打开链接后页面显示的验证码（claude.ai 的设计：链接不在发起登录的浏览器打开时显示验证码），开了双重验证的账号接着要 `stage:'mfa'` 的验证码。页面报错原样返回 `stage:'error'`；出现人机验证或页面不动时返回 `stage:'blocked'`，网页端可以“改用远程画面”接着同一个标签页手动完成。保底是粘贴 sessionKey：`op:'cookie'` 接受裸值或 `sessionKey=…`，写进连接器档案后打开 claude.ai 调 `/api/organizations`，200 才保留，401/403 删除并报错。其他方式在网页端“其他登录方式”里。在电脑旁：`claude.artifact.login {op:'desktop'}` 先关掉连接器自己的浏览器（一个档案同时只能有一个浏览器），再用同一档案启动一个**不带远程调试的普通浏览器窗口**打开登录页，Cloudflare 验证和登录都在里面由人完成。窗口里的内容读不到，cookie 数据库也被它独占锁定；窗口是否还开着看档案的 `lockfile` 是否被占用（Windows）。完成登录靠窗口标题：`tasklist` 读到的主窗口标题变成 claude.ai 应用的样子（“… - Claude”，登录页是“… | Claude.ai”，验证页是“请稍候…”）时，连接器像人点关闭一样结束窗口（`taskkill` 不带 `/F`，让浏览器先保存 cookie），再读档案 cookie 确认；用户自己关掉窗口也一样确认。网页端每 2 秒用 `op:'status'` 查询。窗口开着时连接器的其他浏览器操作返回 `busy`。连接器不读取电脑上 Chrome/Edge 已有档案里的登录：那些档案在浏览器运行时被占用，Chrome 也不允许对默认档案开启远程调试。电脑上还有两处入口走同一个 `desktop` 流程：托盘菜单“登录 claude.ai…”，以及桌面窗口在服务运行、检测到 Claude Code 且尚未登录时显示的登录卡片（可选“暂不登录”，之后不再提示）。两者都运行 `build/setup.mjs --claude-signin`，由它经中继请求正在运行的连接器弹出窗口并等待结果，不另起浏览器，避免两个进程争用同一个档案。登录状态记在数据目录的 `claude-signin.json`（连接器每次得知登录与否时更新），`op:'check'` 只读这个文件，不启动浏览器；桌面窗口的状态检查用它显示“已登录/未登录 claude.ai”。连接器启动时不会自动弹出登录窗口。不在电脑旁：手机上显示电脑浏览器的截图，点画面、输入文字、按键（回车/退格/Tab）、滚动、粘贴邮件登录链接（只允许 claude.ai / anthropic.com）都由 `claude.artifact.login` 转给电脑。远程画面过不了 Cloudflare 的“请验证您是真人”，遇到时网页端改为引导到电脑屏幕上的窗口。邮箱登录中遇到持续的 Cloudflare 验证返回 `stage:'challenge'`，同样引导到电脑上的窗口。登录状态以 `sessionKey` cookie 判断（也认 `sessionKeyV3` 这类改名），且当前页面不在登录相关路径上。
- **关闭**：Windows 上的 `msedge.exe` 可能只是启动器，交出浏览器后以 0 退出，所以连接器只把非 0 退出当作启动失败，并通过 `SystemInfo.getProcessInfo` 记下真正的浏览器进程；关闭时先发 `Browser.close`，2 秒内没退出就结束这个进程。
- **限制**：快照是静态的，悬停提示、切换标签等交互不可用，需要时点“刷新”重新生成。浏览器空闲 3 分钟后关闭。
- **信任边界**：持有中继 Token 的人可以通过登录窗口操作这台电脑上已登录 claude.ai 的浏览器，这与现有的“可以在电脑上运行 Claude Code”属于同一信任范围。

## 风险

- `~/.claude/projects` 下目录的命名规则没有公开；推算失败只影响“还没有会话的文件夹”的记忆显示。
- claude.ai 账户里的远程连接器（Gmail 等）不会出现在本机会话里；本地 MCP 可以。

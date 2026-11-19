# 借用电脑（访客模式）：实施计划

按 [设计](DESIGN.md) 分阶段交付。每个阶段都能单独合并，且不改变自用模式的行为：没有 `guest: true` 的配置，和现在完全一样。

Windows 测试包先采用登录文件副本。自动化检查使用模拟凭证，验证目录隔离、授权和便携包启停。真实账号的首次启动和双向令牌刷新按 M0 人工验收。

## M0 · 先实测登录副本（不写产品代码）

整个方案成立的前提是“复制登录文件不会把 B 挤下线”。在一台测试电脑上用临时目录验证，结果记录在 `docs/guest-mode/M0-RESULTS.md`。

| 步骤 | Codex | Claude Code |
|---|---|---|
| 1. 准备 | `CODEX_HOME=%TEMP%\g\codex`，复制 `~/.codex/auth.json` | `CLAUDE_CONFIG_DIR=%TEMP%\g\claude`，复制 `~/.claude/.credentials.json` |
| 2. 访客能用 | 用该环境运行 `codex app-server` 并跑一轮，或者运行 `codex exec "say hi"` | 运行 `claude -p "say hi"` |
| 3. 强制刷新 | 把访客那份 `auth.json` 里的 access token 改成过期，再跑一轮，看它是否刷新并写回 | 同样改 `expiresAt`，再跑一轮 |
| 4. B 是否受影响 | 刷新后，用 B 的默认目录再跑一轮 | 同左 |
| 5. 反向 | B 那边强制刷新后，访客再跑一轮 | 同左 |

另外记录：

- Claude Code 在 `CLAUDE_CONFIG_DIR` 下是否还需要 `.claude.json`（首次引导、主题选择等），缺了会不会在 SDK 模式下卡住。
- Codex 在 Windows 上是否把登录存在系统凭据管理器而不是 `auth.json`（`cli_auth_credentials_store` 配置）。如果是，复制文件这条路要改。
- 只装了 Codex 桌面版、没装 CLI 时，`resolveWindowsCodex` 能否在桌面安装目录里找到可执行文件。

**判定**：第 4、5 步都正常，采用“复制”；任何一步被登出，采用“共享同一个登录文件”（设计第 2 节的方案 B），后续步骤里的 `syncLogin` 改为创建符号链接或在启动时指向原文件。

## M1 · 连接器：访客模式

### 配置

`src/shared/config.ts`：读取 `guest`（布尔值）和 `guestRoot`（默认是 `<包>/guest`，即 `resolve('guest')`）。返回值里增加：

```ts
guest: boolean
guestPaths?: {root, codexHome, claudeConfig, workspace}   // 都是绝对路径
```

### 启动顺序 `src/connector/main.ts`

1. 读取配置。如果 `guest` 为真：
   - 创建 `codexHome`、`claudeConfig`、`workspace` 三个目录。
   - 调用新模块 `src/connector/guest.ts` 的 `syncLogin()`，复制 B 的两份登录文件（按 M0 的结论决定是复制还是链接）。
   - 设置 `process.env.CODEX_HOME` 和 `process.env.CLAUDE_CONFIG_DIR`。**必须在**构造 `Control`、`AppServer`、`ClaudeCodeBridge` 之前设置，因为 `claudeConfigDir()`、`nativeProjects`、`indexedSessions`、`readPaginatedHistory` 都是在调用时读环境变量的默认值。
   - 忽略配置里的 `codexHome`：访客模式下固定使用访客目录。
2. 访客模式下 `Control` 改用 `NoDesktop`：一个实现 `Desktop` 现有接口（`connect`、`request`、`follow`、`states`、`clientId`、事件）的空对象，永远离线，`request` 直接抛 `offline`。这样所有 `session.source==='desktop'` 的分支都不会被走到，也不会去连 `\\.\pipe\codex-ipc`。
3. 访客模式下不构造 `AntigravityBridge`，`ServiceRouter` 里也不注册 `antigravity` 前缀。手机如果发来 `antigravity.*`，返回 `unsupported`。
4. `hello` 里增加 `services:['codex','claude'].filter(可用)` 和 `guest:true`。是否可用由 `guest.ts` 的 `preflight()` 判断（见 M4）。自用模式下发 `services:['codex','claude','antigravity']`，`guest` 不发。

### 路径限定

`src/connector/project.ts`：

- `projectDirectory(path)` 和 `readProjectFile`、`downloadProjectFile` 里的 `realpath` 之后，加一个 `assertInsideWorkspace(canonical)`：如果设置了工作区（模块级 `setWorkspace(root)`，由 `main.ts` 在访客模式下调用），检查规范化后的路径等于工作区，或者以 `工作区 + 路径分隔符` 开头（Windows 下忽略大小写）。不满足就抛 `BridgeError('forbidden','借用电脑只能使用访客工作区里的项目')`。
- 附件上传写在 `<cwd>/.codex-mobile-attachments/`，`cwd` 已经过 `projectDirectory` 检查，不需要另外处理。核对 `src/connector/attachments.ts` 里没有绕过 `projectDirectory` 的路径。
- 网页预览（`browser-preview.ts`、`html-preview.ts`）：`html-preview` 读的是本地文件，也要走 `assertInsideWorkspace`；`browser-preview` 转发的是端口，不处理。

### 项目列表和新建项目

- Codex `info` 的 `projects`、Claude 的项目列表：访客模式下合并“工作区一级子文件夹”和“已有会话的 cwd”，并过滤掉工作区以外的路径（理论上不会有，防止旧数据混进来）。
- 新增动作 `project.create {name}`（Codex 和 Claude 共用，挂在 `Control` 上，加入 mutations 列表并走账本）：
  - 只在访客模式下可用，否则返回 `unsupported`。
  - `name` 去掉首尾空格，长度 1–80，不能包含 `\ / : * ? " < > |`，不能是 `.` 或 `..`，也不能是 Windows 保留名（`CON`、`NUL` 等）。
  - 在工作区下 `mkdir`（`recursive:false`）。已存在时返回已有路径，不报错。

### 测试

- `test/guest.test.ts`（新增）：`syncLogin` 在目标不存在时复制、已存在时不覆盖、源不存在时报告“未登录”；`assertInsideWorkspace` 覆盖子目录、工作区本身、`..` 跳出、符号链接跳出、大小写不同的盘符、前缀相同的兄弟目录（`workspace2`）；`project.create` 覆盖非法名称和重名。
- `test/control.test.ts`：用 `NoDesktop` 构造 `Control`，新建、发送、停止都走 runtime，不调用桌面。
- `test/services.test.ts`：访客模式下 `antigravity.list` 返回 `unsupported`。
- `test/claude-code.test.ts`：`CLAUDE_CONFIG_DIR` 指向临时目录时，会话列表只来自这个目录。

## M2 · 中继：连接器专用 Token

`src/server/relay.ts`、`src/server/main.ts`、`src/shared/config.ts`：

- `createRelay(token, staticDir, previewPort, connectorTokens?)`，其中 `connectorTokens: {token:string; machineId:string}[]`，从中继配置的 `connectorTokens` 读取，也支持环境变量 `BRIDGE_CONNECTOR_TOKENS`（JSON）。
- 握手判定（`relay.ts:81` 一带）：
  1. 主 Token 匹配：行为和现在一样。
  2. 否则在 `connectorTokens` 里逐个做 `timingSafeEqual`（先比较长度）。命中时，要求 `role==='connector'` 并且 `machineId` 等于绑定的 ID，否则用 `4401` 关闭。
  3. 都没命中：`4401 invalid_token`。
- `replaced` 规则不变。因为访客 Token 只能注册自己的 `machineId`，不会顶掉你的电脑。
- `machines()` 增加 `services`、`guest` 两个字段（从 `hello` 里取，做类型检查：`services` 只保留已知的三个名字）。
- 测试 `test/relay.test.ts`：访客 Token 当手机被拒；访客 Token 用错误的 `machineId` 被拒；访客 Token 正常注册后，手机能看到 `guest:true` 和 `services`；主 Token 的行为不变。
- 文档：`DEPLOY.md` 增加 `connectorTokens` 的说明和作废方法。`PRIVACY.md` 补一句：访客 Token 只能注册指定的电脑。

## M3 · 网页端

- `web/main.tsx`：`machines` 里的 `services`、`guest` 一路传下去。电脑菜单里给 `guest` 的电脑名加“（借用）”。
- `web/service-switch.tsx`：只显示当前电脑 `services` 里的应用；字段缺失时显示全部。当前应用不在列表里时（比如从自己的电脑切到借用电脑时停在 Antigravity），切到列表里的第一个。
- Codex 新建会话的项目选择（`main.tsx` 里 `sheet==='projects'`）：借用电脑上把“其他项目目录 / 完整路径”换成“新建项目”输入框（只填名字），提交后调用 `project.create`，然后选中返回的路径。Claude 的项目选择（`web/claude-projects.tsx`）做同样处理。
- 借用电脑上隐藏 `desktopOnline` 相关的提示和“在这里继续”。
- 测试：`test/route-state.test.ts` 或新的 `test/service-switch.test.ts` 覆盖“服务不可用时回退”。

## M4 · 访客包和启动脚本

### 生成访客包：`scripts/package-guest.ts`（`npm run package:guest`）

参数：`--name "B 的电脑"`、`--relay https://…`。可选 `--relay-config <路径>`：直接把新 Token 写进本机中继配置。

1. 从当前分支重新构建，复用 Windows 便携包的 Node 运行时和许可证步骤。
2. 生成 `machineId`（`guest-` + 随机 12 位）和 32 字节随机访客 Token（base64url）。
3. 写入包内的 `.local/config.json`：

   ```json
   {"mode":"connector","guest":true,"relayUrl":"…","token":"<访客 Token>","machineId":"guest-…","machineName":"B 的电脑"}
   ```

4. 只放访客需要的脚本：`启动.cmd`、`停止.cmd`、`清除访客数据.cmd`，以及一份面向 B 的简短说明 `说明.txt`。不放 `configure.cmd`、`start.cmd`，避免 B 误改配置。
5. 打成 zip，输出到 `release/<machineId>.zip`。注册记录保存在同名 `.relay.json`，可用 `--token-out` 指定路径。提供 `--relay-config` 时直接追加到该中继配置。

### 启动：`scripts/windows/guest.ps1 -Action Start`

1. 预检（`guest.ts` 的 `preflight()` 也可以用 `node app/connector.js --preflight` 的形式复用）：
   - Codex：能否解析到可执行文件；`~/.codex/auth.json` 或访客副本是否存在。
   - Claude Code：`findClaude()` 是否找到；`~/.claude/.credentials.json` 或访客副本是否存在。
   - 两个都不可用：提示“请先安装并登录 Codex 或 Claude Code”，然后退出。只有一个可用：提示另一个暂不可用，继续启动。
2. 复用 `start.ps1 -Mode connector` 的启动逻辑（进程记录、日志）。
3. 状态窗口显示：连接状态、电脑名、可用的应用。失败时显示日志位置。

`guest.ps1 -Action Stop` 复用 `stop.ps1`。`guest.ps1 -Action Clear` 先确认，再停止连接器，删除 `guest\` 和 `.local\operations.sqlite*`，保留 `config.json`，以便下次还能直接启动。

### 测试

- `test/setup.test.ts` 或新增的 `test/package-guest.test.ts`：生成的 `config.json` 字段完整，Token 长度达标，zip 里不包含 `configure.cmd`。
- `npm run test:guest-package -- release/guest-….zip` 在临时目录解压，使用模拟登录文件运行预检、测试中继连接、会话目录隔离、重启和清除流程。

## M5 · 人工验收

在真实的第二台电脑（或同一台电脑上的另一个 Windows 用户）上完成：

1. 生成访客包，把 Token 加进中继，重启中继。
2. 在 B 的电脑上解压并启动。手机上出现“B 的电脑（借用）”，应用只有 Codex 和 Claude Code。
3. 新建项目“demo”，在 Codex 和 Claude Code 里各跑一轮，内容是创建一个文件。
4. 在 B 的电脑上打开 Codex 桌面应用、运行 `claude --resume`：**都看不到**第 3 步的会话。B 自己跑一轮后，手机上**看不到** B 的会话。
5. 手机预览 `demo` 里的文件可以；手动输入工作区以外的路径（比如 `C:\Windows\win.ini`），提示只能使用访客工作区。
6. 第二天再跑一轮，B 和访客都没有被登出（对应 M0 的结论）。
7. 拿访客 Token 改成手机身份连中继，被拒绝；从中继删掉访客 Token 并重启后，B 的电脑连不上。
8. 停止，再启动，之前的会话还在。运行清除脚本后，会话和项目都消失，可以重新开始。
9. 回归：你自己的电脑上 Codex 桌面接管、Antigravity、Claude Code 都照常可用。

## 涉及文件一览

| 文件 | 阶段 | 变更 |
|---|---|---|
| `src/shared/config.ts` | M1 M2 | `guest`、`guestPaths`、`connectorTokens` |
| `src/connector/guest.ts`（新） | M1 M4 | `syncLogin`、`preflight`、`NoDesktop` |
| `src/connector/main.ts` | M1 | 访客启动顺序、服务注册、`hello` 字段 |
| `src/connector/project.ts` | M1 | `setWorkspace`、`assertInsideWorkspace` |
| `src/connector/control.ts` | M1 | 可注入 `NoDesktop`（构造函数已经支持传入 `desktop`）、`project.create`、项目列表过滤 |
| `src/connector/claude-code.ts` | M1 | 项目列表过滤 |
| `src/connector/html-preview.ts` | M1 | 路径限定 |
| `src/server/relay.ts`、`src/server/main.ts` | M2 | 连接器专用 Token、`machines` 字段 |
| `web/main.tsx`、`web/service-switch.tsx`、`web/claude-projects.tsx` | M3 | 按电脑显示应用、借用标记、新建项目 |
| `scripts/package-guest.ts`（新）、`scripts/windows/guest-*.ps1`（新）、`package.json` | M4 | 访客包 |
| `DEPLOY.md`、`PRIVACY.md`、`README*.md` | M2 M4 | 说明 |

# 借用电脑（访客模式）：设计

目标：借朋友 B 的电脑和账号跑 Codex 和 Claude Code。B 只需要启动一个程序，你就能在手机或网页上使用这台电脑；双方的会话和文件互不混在一起。

## 前提和取舍（2026-11-19 确认）

- **B 是可信的。** 只要求“不混”：B 平时打开 Codex 或 Claude Code 看不到你的会话，你在手机上也看不到 B 的。**不做**加密，也不防 B 有意查看（B 是电脑管理员，技术上始终能看到）。
- **用 B 的账号。** 模型请求走 B 已登录的 Codex（ChatGPT）和 Claude Code 账号，额度两人共用。
- **只支持 Codex 和 Claude Code。** Antigravity 目前是挂在 B 正在运行的桌面端上，会话写在 B 的 `~/.gemini`，没法分开，所以访客模式下不提供。
- **只用访客目录，B 无感。** 你的项目全部放在访客包自己的目录里，B 不需要指定或共享任何文件夹。
- **不自动删除。** 停止访客模式只是断开连接，数据保留，下次启动可以接着用。需要时 B 手动运行清除脚本。

## 使用流程

1. 你运行打包命令，得到一个预填好中继地址、访客 Token 和电脑名的 zip，发给 B。
2. B 解压，双击 `启动.cmd`。
   - 启动前检查：Codex 已安装并登录、Claude Code 已安装并登录。没装或没登录的应用会跳过并提示，另一个照常可用。
   - **不需要** B 打开 Codex 或 Claude 的桌面应用。连接器会自己在后台起 Codex app-server 和 Claude Code 进程。
3. 你的手机和网页的“电脑”菜单里出现“B 的电脑（借用）”，选中后可以使用 Codex 和 Claude Code；没有 Antigravity。
4. B 双击 `停止.cmd` 断开。下次再启动，你的会话都还在。

## 设计

### 1. 独立数据目录

访客包目录结构（以解压位置 `<包>` 为根）：

```
<包>/
  启动.cmd  停止.cmd  清除访客数据.cmd
  runtime/node.exe, app/…              程序本体
  .local/config.json                   中继地址、访客 Token、电脑 ID 和名称、guest: true
  .local/operations.sqlite, *.log      连接器自己的账本和日志
  guest/codex-home/                    你的 CODEX_HOME：会话、设置、auth.json（登录副本）
  guest/claude-config/                 你的 CLAUDE_CONFIG_DIR：会话、.claude.json、.credentials.json（登录副本）
  guest/workspace/<项目>/              你的项目文件夹
```

| 应用 | 自用模式 | 访客模式 |
|---|---|---|
| Codex | `~/.codex`；同时通过 `\\.\pipe\codex-ipc` 接管桌面会话 | `CODEX_HOME=<包>/guest/codex-home`；**不连桌面 IPC**，只用连接器自己起的 app-server |
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR=<包>/guest/claude-config` |
| Antigravity | `~/.gemini/antigravity` + 桌面 Hub | 不注册该服务 |

效果：

- B 的 Codex 桌面应用只读 `~/.codex`，看不到你的会话。B 的 `claude --resume` 和 Claude 桌面应用只读 `~/.claude`，同样看不到。
- 反过来，你的项目和会话列表只来自访客目录，看不到 B 的。
- B 的个人设置也不会带到你这边：Codex 的 `config.toml`、Claude 的用户级 `CLAUDE.md`、记忆、MCP 服务器都不生效。你需要的设置写在访客目录里。

### 2. 登录：复制 B 的登录状态

两个应用都把登录保存在数据目录里的一个文件里：

| 应用 | B 的文件 | 复制到 |
|---|---|---|
| Codex | `~/.codex/auth.json` | `guest/codex-home/auth.json` |
| Claude Code | `~/.claude/.credentials.json` | `guest/claude-config/.credentials.json` |

规则：

- 每次启动时，如果访客目录里没有登录文件，或者访客那份已经失效，就从 B 那里重新复制。平时访客那份自己刷新，不回写 B 的文件。
- **待验证风险（M0）**：两份登录各自刷新令牌，可能会让对方的令牌失效。如果 ChatGPT 或 Claude 的刷新令牌是轮换制，结果就是一方被登出。M0 要实测；如果确实冲突，改为方案 B：不复制，让访客模式直接读写 B 的那一个登录文件（通过符号链接，或者在启动时把路径指过去），只共享登录，不共享会话。
- 语音转写用的是 Codex 的 ChatGPT 登录，跟着 Codex 走，不需要额外处理。

### 3. 项目范围：限定在访客工作区

- 新建会话、续聊、文件预览、文件下载、上传附件，只要涉及路径，都必须在 `guest/workspace` 之内（按 `realpath` 之后判断，防止通过符号链接跳出去）。超出范围就报错“借用电脑只能使用访客工作区里的项目”。
- 项目列表：工作区下的每个一级文件夹算一个项目，再加上会话记录里出现过的 `cwd`（理论上都在工作区内）。
- 新增手机端操作“新建项目”：在工作区下创建文件夹，名字只允许普通文件名。自用模式下这个入口不变（仍然是填写完整路径）。
- 网页预览（转发 localhost）照常可用：它访问的是 B 电脑上的端口，不涉及文件路径。
- 这里只是为了“不混”，不是安全边界：Codex 和 Claude 执行命令时仍然有 B 这个系统用户的全部权限。

### 4. Token：分开手机和连接器

现在中继只有一个 Token，手机和连接器都用它。访客包里如果带着这个 Token，B 的电脑理论上也能以手机身份连上中继，看到你自己电脑上的内容。

改为：

- 中继配置增加 `connectorTokens`：一组只能以 `role: 'connector'` 登录的 Token，每个 Token 绑定一个 `machineId`。
- 原来的 `token` 保持不变，手机和你自己的连接器继续用它，旧配置不用改。
- 访客 Token 只能注册它绑定的那台电脑，不能当手机，也不能冒充你自己的电脑（不会触发 `replaced` 把你的连接器挤掉）。
- 不借了：从中继配置里删掉这个 Token，重启中继即可作废。

### 5. 网页端

- 连接器在 `hello` 里带上 `services: ['codex','claude']` 和 `guest: true`，中继原样放进 `machines` 列表。
- 应用切换器只显示该电脑支持的应用。旧连接器没有 `services` 字段时，按“三个都支持”处理，兼容现有部署。
- 电脑名后面加“（借用）”标记。
- Codex 页面在访客电脑上隐藏“桌面会话”相关提示（比如 `desktopOnline`、“在这里继续”）。在访客模式下，所有会话都由连接器自己管理。

### 6. 打包和启动

- 新增 `npm run package:guest -- --name "B 的电脑" --relay https://…`：
  - 生成新的 `machineId` 和访客 Token，把中继注册记录写到同名 `.relay.json`。可用 `--token-out` 指定路径，或用 `--relay-config` 追加到已有的中继 JSON 配置。
  - 复用 `package:windows` 的产物，写入预填的 `.local/config.json`，只带访客模式需要的三个 cmd 脚本。
- `启动.cmd`：检查 → 准备访客目录和登录副本 → 以 connector 模式启动 → 打开一个状态窗口，显示“已连接 / 正在连接 / 哪个应用不可用及原因”。
- 不创建开机自启和计划任务，B 什么时候启动都由 B 决定。
- `清除访客数据.cmd`：先确认，再停止连接器，删除 `guest/` 和 `.local/operations.sqlite`。

## 不做的事

- 加密、防 B 查看、端到端加密。
- 多人同时借用同一台电脑（一台电脑一个访客包）。
- Antigravity。以后如果要做，方向是另开一个 Antigravity 实例并使用独立数据目录，或者走官方 CLI 的 ACP 接口（见 `docs/antigravity/DESIGN.md`）。
- 自动删除和自动过期。

## 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 刷新令牌互相顶掉 | B 或你被登出 | M0 实测；有冲突就改为共享同一个登录文件 |
| Codex、Claude 升级后改了登录文件位置或格式 | 访客启动失败 | 启动检查给出明确提示；`CODEX_HOME` 和 `CLAUDE_CONFIG_DIR` 是官方支持的环境变量，改动的概率较低 |
| B 电脑上没有 Codex 的 app-server 可执行文件（只装了桌面版） | Codex 不可用 | 现有 `resolveWindowsCodex` 已经会从桌面安装目录里找；找不到就提示 |
| 共用额度 | 你的任务占用 B 的限额 | 界面上的额度显示照常；不额外处理 |
| 访客数据长期留在 B 的电脑上 | 占用磁盘 | 提供清除脚本；README 里写明位置 |

# 本机 Claude Code：设计

目标：手机端像操作 Codex 一样操作电脑上的 Claude Code，会话直接在 Windows 本机运行，项目和 Claude Code 自己的项目一致。

## 方向调整（2026-11-19）

最初的计划（M0–M5）是把 Cowork 接进来：读取本地 Cowork 会话、把 Cowork 会话接力到本机、导入 Cowork 项目，并仿照 Cowork 自建一个项目层（`claude-projects.json`）。后来确认 Cowork 和 Claude Code 是同一套东西，Claude Code 本身就有项目的概念，所以：

- **不再接入 Cowork**。云端 Cowork 的浏览器桥（`src/cowork-extension`、`cowork.ts`）和本地 Cowork 只读（M3 草稿）都已删除，M4、M5 取消。
- **项目就是文件夹**，设置用 Claude Code 自己的文件，不再自建项目表。

M0 中关于桌面 App 数据目录、Cowork 文件格式的记录保留在 `M0-FINDINGS.md`，仅供参考。

## 设计

### 1. 本机 Claude Code 会话（M1）
用 Agent SDK 运行：新建、续聊、排队、停止、审批、提问、计划确认、图片、模型和权限模式。会话存在 `~/.claude/projects`，终端 `claude --resume` 也能接续。`CLAUDE_CODE_ENTRYPOINT` 默认不设置（SDK 的 `sdk-ts`），可用配置 `claudeEntrypoint` 覆盖；桌面 Code 页看不到手机建的会话（见 `M1-RESULTS.md`）。

启动参数只给 `cwd`、模型、权限模式和 `systemPrompt: {type:'preset', preset:'claude_code'}`。`settingSources` 不传，SDK 默认读取全部设置（用户、项目、本地），所以 `CLAUDE.md`、`.claude/settings.json`、`.mcp.json` 和记忆都和终端里一样生效。

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

## 风险

- `~/.claude/projects` 下目录的命名规则没有公开；推算失败只影响“还没有会话的文件夹”的记忆显示。
- claude.ai 账户里的远程连接器（Gmail 等）不会出现在本机会话里；本地 MCP 可以。

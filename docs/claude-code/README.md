# Claude Code 接入说明

手机的 **Claude Code** 入口与 Codex、ChatGPT、Antigravity 共用同一中继、Token 和电脑连接器。

## 工作方式

| 动作 | 实现 |
| --- | --- |
| 列表、读取 | Agent SDK 的 `listSessions` / `getSessionMessages` 读取 `~/.claude/projects`（或 `CLAUDE_CONFIG_DIR`），转换成 Codex 的轮次与运行记录（[claude-transcript.ts](../../src/connector/claude-transcript.ts)） |
| 实时刷新 | `claude.watch` 长轮询，版本号由 transcript 的修改时间、大小和连接器会话状态组成；审批出现或回应后无需等文件写入 |
| 新建、继续 | `query({prompt: 流式输入, options: {cwd, resume, model, permissionMode, canUseTool}})`，一个会话一个 Claude Code 进程（[claude-runtime.ts](../../src/connector/claude-runtime.ts)） |
| 运行中发送 | 默认“完成后发送”（`priority: 'later'`）；“立即追加”使用 `priority: 'next'` |
| 停止 | `interrupt()`，只对连接器运行的会话可用 |
| 审批、提问、计划 | `canUseTool` 回调挂起，手机回应后返回 allow / deny；“允许并记住”带回 Claude Code 给出的权限建议；`AskUserQuestion` 回答写入 `updatedInput.answers` |
| 模型、权限 | 模型列表来自 `supportedModels()`；运行中切换用 `setModel` / `setPermissionMode`；“全部允许”只能在新建或重新接入时选择 |
| 防重发 | 所有写操作带 `opId`，经连接器操作记录；结果不明时手机显示“核实操作结果”，不会自动重发 |

## 边界

- 终端或 IDE 正在运行的会话不能被接管。transcript 20 秒内有写入的会话视为可能在运行，手机继续前需确认；确认后连接器以 `resume` 接入。两个进程同时续写同一会话会损坏历史。
- 连接器运行的会话空闲 5 分钟后释放进程，之后终端可以 `claude --resume` 接着用。
- 旧消息改写、分叉、文件附件（非图片）暂不支持。
- Claude Code 的诊断输出不会转发到中继。

## 配置

连接器按以下顺序找 `claude`：配置 `claudeBin`（或环境变量 `CLAUDE_CODE_BIN`）→ `PATH` 中的 `claude.exe` → `%USERPROFILE%\.local\bin\claude.exe` → SDK 自带程序（仅源码目录可用）。登录、模型默认值、CLAUDE.md、MCP 和权限规则都沿用电脑上的 Claude Code 设置。

## 待人工验收

1. 手机新建会话，桌面 `claude --resume` 能看到同一会话。
2. 一次命令审批分别点“允许”“允许并记住”“拒绝”。
3. 运行中“完成后发送”“立即追加”“停止”。
4. 在终端用过的会话，手机继续时出现确认。
5. 通过新加坡中继测量“发送 → 首段回复”的时延。

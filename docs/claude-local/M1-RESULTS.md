# M1 结果（2026-11-19）

## 完成的部分

- 从 ff65339 之前的提交恢复了 Agent SDK 运行时：`src/connector/claude-code.ts`、`claude-runtime.ts`、`claude-transcript.ts`、`web/claude-code.tsx` 和两个测试文件，并重新接回连接器、中继、手机路由和侧栏的"新聊天"按钮。依赖 `@anthropic-ai/claude-agent-sdk` 装的是 0.3.328。
- 新增可选配置 `claudeEntrypoint`（字符串），用来设置 `CLAUDE_CODE_ENTRYPOINT`。默认值后来改为 `codex-mobile-web`，见文末“终端 `/resume` 列表”。

## 真机实测（claude.exe 2.1.x，`~/.local/bin`）

| 项目 | 结果 |
|---|---|
| 经连接器 `ClaudeCodeBridge` 新建会话 | 通过 |
| 续聊（第二轮记得第一轮的内容） | 通过 |
| 审批：`Write` 弹出权限请求，手机允许后写入文件 | 通过 |
| `claude.list` 列出新会话 | 通过 |
| 终端 `claude -p --resume <id>` 接续 | 通过，历史完整 |
| 桌面 Code 页能看到手机建的会话 | **做不到**，原因见下文 |

## 为什么 `CLAUDE_CODE_ENTRYPOINT=cli` 不行

1. claude.exe 启动时有这样一段逻辑：如果 `CLAUDE_CODE_ENTRYPOINT === "cli"`，并且是非交互模式（SDK 用的 stream-json 就是非交互），就改写成 `"sdk-cli"`。实测 JSONL 里每一行都是 `"entrypoint":"sdk-cli"`。
2. 桌面 App 用 `scanTranscriptHead` 读 JSONL 开头的 `entrypoint`，命中 `isHiddenEntrypoint` 就不列出来。隐藏集合包括 `sdk-cli`、`sdk-ts`、`sdk-py`、`local-agent`、`mcp`、`bench`、`claude-code-github-action`、`remote*`、`claude_in_slack`、`ssh-remote`、`claude-coworker*`，以及 `claude-desktop`、`claude-desktop-3p`。
3. 所以通过 SDK 启动的会话不可能以 `cli` 身份出现。按设计"风险"一节的退路，保留 SDK 默认值：手机建的会话在终端 `claude --resume` 里可以接续，但桌面 Code 页看不到。

可以考虑的其他办法（都没做，也不建议默认开启）：

- 伪装成其他没被隐藏的 entrypoint（例如 `claude-vscode`）：claude.exe 会因此改变行为，副作用不明。
- 会话空闲后改写 JSONL 里的 `entrypoint` 字段：这是在改 Claude Code 自己的数据文件，可能和 claude.exe 或桌面 App 同时写同一个文件。

## 测试

- `npm run check`：205/205 通过，native 和 ownership 检查也通过；`npm run build` 通过。
- 已知偶发失败：完整套件跑了 5 次，有 1 次 `phone drives Claude Code sessions…` 在第一次 `claude.send` 时返回 `failed`。单独跑 3 次、完整套件再跑 3 次都通过。这个测试和代码都是从历史提交原样恢复的，测试里的运行时空闲超时只有 200ms，机器忙的时候会话可能先被释放掉。

## 终端 `/resume` 列表（2026-11-19 补充）

问题：web 建的会话在终端 `claude --resume` / `/resume` 的列表里看不到（按 ID 接续一直可以）。

实测（claude.exe 2.1.328，在空目录里用不同的 `CLAUDE_CODE_ENTRYPOINT` 各建一个会话，再在伪终端里打开选择器）：

| entrypoint | 终端列表 |
|---|---|
| `sdk-ts`（SDK 默认） | 隐藏 |
| `cli`（非交互下被改写成 `sdk-cli`） | 隐藏 |
| `claude-desktop`、`claude-vscode`、`local-agent`、`mcp` | 显示 |
| `codex-mobile-web`（claude.exe 不认识的名字，原样写入） | 显示 |

`CLAUDE_CODE_CHILD_SESSION`、`CLAUDECODE` 不影响列表。

另一个发现：连接器如果是在某个 Claude Code 会话里启动的（例如桌面应用里跑部署脚本），会继承 `CLAUDE_CODE_ENTRYPOINT=claude-desktop`、`CLAUDE_CODE_CHILD_SESSION=1`、`CLAUDE_CODE_HOST_SESSION_ID` 等变量，手机会话就被记成那个会话的子会话。所以列表能不能看到，取决于连接器是怎么启动的。

改法：

- 默认 entrypoint 设为 `codex-mobile-web`。claude.exe 不认识它，不会像借用 `claude-desktop` / `claude-vscode` 那样触发宿主专属行为；审批回调 `canUseTool` 照常触发（与 `sdk-ts` 对照实测）。
- 启动 claude.exe 时去掉父会话写给子进程的变量（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_HOST_SESSION_ID`、`CLAUDE_CODE_MESSAGING_*`、`CLAUDE_PID` 等），其余环境（包括用户自己设的 `CLAUDE_CODE_*`）保留。
- 已经用 `sdk-ts` 写下的旧会话不改写，仍然只能按 ID 接续。

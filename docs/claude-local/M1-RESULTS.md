# M1 结果（2026-11-19）

## 完成的部分

- 从 ff65339 之前的提交恢复了 Agent SDK 运行时：`src/connector/claude-code.ts`、`claude-runtime.ts`、`claude-transcript.ts`、`web/claude-code.tsx` 和两个测试文件，并重新接回连接器、中继、手机路由和侧栏的"新聊天"按钮。依赖 `@anthropic-ai/claude-agent-sdk` 装的是 0.3.328。
- 新增可选配置 `claudeEntrypoint`（字符串），用来设置 `CLAUDE_CODE_ENTRYPOINT`。**默认不设置**，保持 SDK 自己的 `sdk-ts`，原因见下文。

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

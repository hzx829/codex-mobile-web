# M3 结果：去掉 Cowork，项目改为文件夹（2026-11-19）

原计划的 M3（本地 Cowork 只读）没有提交，改为这次调整。原因见 `DESIGN.md` 的“方向调整”。

## 删除

- 云端 Cowork 浏览器桥：`src/cowork-extension/`、`scripts/prepare-cowork-extension.ts`、`src/connector/cowork.ts`、`src/shared/cowork.ts`、`web/cowork.tsx`、`test/cowork.test.ts`、`COWORK.md`，以及手机端的 Cowork 入口。
- 本地 Cowork 只读的草稿（`cowork-local.ts` 等，未提交）。
- 自建项目表：`claude-projects.json`、`ProjectStore`、`claude.project.delete`，以及启动会话时追加的项目说明、记忆索引、额外文件夹和 MCP。

电脑上已有的 `claude-projects.json`（在连接器数据目录）不再读取，可以手动删除；之前登记在项目里的会话会回到各自的文件夹。

## 现在的做法

- `claude.list`：项目就是会话的工作目录（`{id: 路径, path: 路径}`）。
- `claude.project.get {folder}`：读取 `CLAUDE.md`、`.mcp.json`，以及 Claude Code 的记忆目录和 `MEMORY.md`。
- `claude.project.save {folder, instructions, mcpServers, revision, opId}`：写回 `CLAUDE.md` 和 `.mcp.json`，新的 MCP 服务器在 `.claude/settings.local.json` 中启用。
- `claude.create {cwd}`：在文件夹里启动；Claude Code 自己读取该文件夹的设置。
- 手机端：Claude Code 侧栏只有“项目”一组；进入项目后点“项目设置”编辑。新聊天从项目列表或“其他文件夹…”选择。

## 验证

- `npm run check`：202/202 通过，native 检查通过。`test/claude-projects.test.ts` 改为覆盖：输入校验、空设置不建文件、写入 `CLAUDE.md`/`.mcp.json`、启用新 MCP 服务器且保留其他键和已禁用的服务器、CRLF 保持不变、电脑上改过时拒绝、`.mcp.json` 损坏时仍能改说明、`.claude/CLAUDE.md`、按已有会话找记忆目录，以及新会话只带 `cwd` 和预设提示词。

# 本机版 Cowork：设计与实现计划

目标：手机端像操作 Codex 一样读写 Claude，会话直接在 Windows 本机运行（不经过 Cowork 虚拟机），带 Cowork 式的项目，并能导入、接力本地 Cowork 的项目和会话。

## 背景

- 本地 Cowork 的引擎是 Claude Code（会话 entrypoint 为 `local-agent`），但命令在桌面 App 的虚拟机里跑，编译等本机工具链用起来麻烦；也没有外部输入接口。
- 现有 `src/cowork-extension` 浏览器桥只读 claude.ai 页面，无法输入，也看不到本地 Cowork。
- ff65339 之前已有完整的 Agent SDK 实现（`src/connector/claude-runtime.ts`、`claude-transcript.ts`、`claude-code.ts` 及测试，补丁在 `.local/claude-refactor/`），可直接恢复。

## 源码结论（Claude 桌面 App 6.6395.0，MSIX）

源码包已复制到 `.local/cowork-research/claude-app/app.asar`。解包：`npx @electron/asar extract <asar> <目录>`（`.unpacked` 里的原生文件缺失会报错，JS 已解出，可忽略）。主进程代码在 `.vite/build/`。

1. 数据目录：`%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\`（MSIX 版，不是 `%APPDATA%\Claude`）；日志在 `%LOCALAPPDATA%\Claude\logs\`；虚拟机存储在数据目录的 `claude-code-vm\`。Cowork 会话在数据目录的 `local-agent-mode-sessions\<org>\<user>\local_<id>.json` + `local_<id>\.claude\projects\*\<cliSessionId>.jsonl`（需在本机核实）。
2. 桌面 App 的 Code 页会列出 `~/.claude` 里的终端会话：有运行中检测、实时跟随（`openCliTail`）、读取（`readCliTranscript`）、导入续聊（`importCliSession`）。见 `index.chunk-BE4ndFoc.js`。
3. 但它隐藏这些 entrypoint 的会话：`claude-desktop`、`claude-desktop-3p`、`local-agent`、`sdk-cli`、`sdk-ts`、`sdk-py`、`mcp`、`bench`、`remote*` 等（`isHiddenEntrypoint`，`index.chunk-Z4vBNwJC.js`）。`cli` 不在其中。
4. Agent SDK（0.3.328）只在环境变量未设置时把 `CLAUDE_CODE_ENTRYPOINT` 设为 `sdk-ts`。~~连接器启动会话时传 `CLAUDE_CODE_ENTRYPOINT=cli`，手机建的会话就会出现在桌面 Code 页~~。**实测不行**：claude.exe 在非交互模式下会把 `cli` 改写为 `sdk-cli`，而桌面会隐藏它，见 `M1-RESULTS.md`。
5. 深链接 `resume?session=<uuid>`（`Xl.Resume`，`index.chunk-Da1TsO0P.js`）会让桌面导入并打开该终端会话。协议名和完整格式需实测。
6. Cowork 项目：账户目录下 `spaces.json` 为 `{spaces:[{id, name, instructions, ...}]}`；项目记忆在 `spaces/<id>/memory/`，全局记忆在 `memory/memory/`。字段以本机真实文件为准。

## 设计

### 1. 本机 Claude 会话
恢复 Agent SDK 运行时：新建、续聊、排队、停止、审批、提问、计划确认、图片、模型和权限模式。会话存在 `~/.claude/projects`，终端 `claude --resume` 与桌面 Code 页都可接续。`CLAUDE_CODE_ENTRYPOINT` 默认不设置（SDK 的 `sdk-ts`），可用配置 `claudeEntrypoint` 覆盖；桌面 Code 页看不到手机建的会话（M1 实测结论）。

### 2. 项目层
连接器数据目录下 `claude-projects.json`：

```json
{"projects":[{"id":"p_…","name":"…","folders":["C:\\…"],"instructions":"…","memoryDir":"…","mcpServers":{},"sessionIds":["…"],"coworkSpaceId":"…"}]}
```

- 启动会话：`cwd = folders[0]`，`additionalDirectories = folders.slice(1)`，`systemPrompt = {type:'preset', preset:'claude_code', append: 项目说明 + 记忆索引}`，`mcpServers` 按项目配置。
- 新会话登记到项目的 `sessionIds`；不在任何项目里的会话按文件夹归组。
- 手机端复用现有项目侧栏。

### 3. 本地 Cowork 只读
连接器直接读数据目录：列出 `local_*` 会话（按 `spaceId` 归到项目），用 `claude-transcript.ts` 解析 JSONL。浏览器扩展只保留给云端 Cowork（`cse_`），或下线。

### 4. 接力到本机
把某个 Cowork 会话复制成新的本机会话，原文件不动：
1. 读 `local_<id>.json` 的 `cliSessionId`、`vmProcessName`、`userSelectedFolders`、`folderMountNames`，找到 JSONL（M0 核实）。
2. 路径映射：`/sessions/<processName>/mnt/<名>` → `userSelectedFolders` 中对应的 Windows 路径；`mnt/outputs`、`mnt/uploads` → 会话目录下的 `outputs`、`uploads`。映射规则以源码或真实数据为准。
3. 写入 `~/.claude/projects/<按 cwd 规则命名的目录>/<新 uuid>.jsonl`：改写每行的 `sessionId`、`cwd` 和文本中的路径，`entrypoint` 设为 `cli`。
4. 用 SDK `resume` 继续；首条消息说明“已从 Cowork 虚拟机迁到本机 Windows，路径已替换，命令现在在本机执行”。
5. 新会话登记到对应项目。

### 5. 导入 Cowork 项目
`spaces.json`（`{spaces:[{id,name,folders:[{path}],…}]}`，M0 核实）→ `claude-projects.json`（名称、文件夹、说明、记忆目录、`coworkSpaceId`）。只读不写。

## 实现顺序

- M0：在本机核实数据目录结构、`local_*.json` 字段、JSONL 位置、`spaces.json` 字段、`mnt` 命名规则（可改 `.local/cowork-research/probe-cowork.mjs` 的根目录后运行）。
- M1：恢复本机 Claude 会话 + `CLAUDE_CODE_ENTRYPOINT=cli`；实测桌面 Code 页能看到并接续。
- M2：项目层（连接器 + 手机端）。
- M3：本地 Cowork 只读列表与读取。
- M4：接力到本机。
- M5：导入 Cowork 项目。

## 验证

- 单元测试：项目表读写、启动参数组装、路径映射、JSONL 改写（用脱敏样例）。
- 本机：`npm run check`、`npm run build`；真实 claude.exe 新建/续聊/审批；手机建的会话在桌面 Code 页出现并可接续；一个 Cowork 会话接力后能继续且原会话不受影响。

## 风险

- 桌面 App 的数据格式未公开，更新可能改变；读取处做好容错，失败只影响 Cowork 部分。
- `entrypoint=cli` 的副作用需确认；不行就保留 `sdk-ts`，只是桌面 Code 页看不到。
- claude.ai 账户里的远程连接器（Gmail 等）走 claude.ai 授权，搬不过来；本地 MCP 可以。
- 不写回 Cowork，避免和桌面 App 同时写同一会话。

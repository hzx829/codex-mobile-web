# M0 本机核实结果（2026-11-19，Claude 桌面 App 6.6395.0 MSIX）

数据来源：`.local/cowork-research/probe-cowork.mjs` 的输出（只记结构、不复制对话内容），以及解包后的 `app.asar`（`.vite/build/`）。

## 数据目录

- 根目录：`%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\`，与设计一致。`%APPDATA%\Claude` 里只有一个 `.user-data-left.*` 标记；`%LOCALAPPDATA%\Claude\` 里只有 `logs\`。
- 账户层级是 `<org>\<user>`，两层都是 UUID。

## 本地 Cowork 会话（local-agent-mode-sessions）

- **本机目前没有任何 `local_*.json` Cowork 会话**，也没有 `spaces.json`。账户目录里只有：
  - `remote-session-spaces.json`：`{entries:[{sessionId:"session_01…", folders:[string], memoryEnabled:boolean}]}`，记的是云端会话（`session_` 前缀）用到的文件夹。
  - `scheduled-tasks.json`：`{scheduledTasks, recordedSkips, …}`。
- 所以 M3/M4 没法用本机真实的 Cowork 会话测试；要等你在桌面 App 里建一个本地 Cowork 会话，或者先用脱敏样例写测试。

## Code 页会话（claude-code-sessions）

- `claude-code-sessions\<org>\<user>\local_<uuid>.json` 是桌面 **Code 页** 的会话记录（不是 Cowork）。字段有 `sessionId`（`local_…`）、`cliSessionId`、`cwd`、`originCwd`、`model`、`effort`、`permissionMode`、`title`、`isArchived`、`createdAt`、`lastActivityAt`、`remoteMcpServersConfig`、`shellFolders` 等。
- 对应的 JSONL 在 `~/.claude/projects/<cwd 编码>/<cliSessionId>.jsonl`，这一行的 `entrypoint` 是 `claude-desktop`。

## 源码确认的规则

### spaces.json（Cowork 项目）

`<账户目录>\spaces.json` 的读取代码（`index.chunk-B9Aeeptk.js`，导入扫描）：

```
{spaces:[{id, name, folders:[{path}], projects:[…], …}]}
```

- `id` 要通过 id 校验，`name` 必须是字符串。
- `folders` 是 **对象数组 `{path}`**，不是字符串数组；最多取前 16 个。
- 设计里写的 `instructions` 在这段代码里没有用到；等有真实文件时再核实。

### VM 路径映射（`/sessions/<vmProcessName>/mnt/<名>`）

主进程的 `vmPathContextOf` 和映射函数：

- 前缀：`/sessions/${vmProcessName}`，字段名是 **`vmProcessName`**（设计里写的是 `processName`）。
- 固定挂载：`mnt/outputs` 和 `mnt/uploads` 对应 `getSessionStorageDir(sessionId)` 下的 `outputs`、`uploads`；自动记忆目录（`autoMemoryDir`）用一个特殊的挂载名（`String.fromCodePoint(155)`）。
- 用户选的文件夹：挂载名 **存在会话记录的 `folderMountNames` 里**（`{Windows 路径: 挂载名}`），由 `mountNamesFor` 第一次用到时生成并保存。接力时直接读这个映射就行，不需要自己推算命名规则。
- Windows 路径转 VM 路径时，相对部分把 `\` 换成 `/`。

## 对设计的修改

1. 设计 §4 的 `processName` 改为 `vmProcessName`，路径映射用会话记录里的 `folderMountNames`。
2. 设计 §5 的 `spaces.json` 文件夹格式是 `folders:[{path}]`。
3. 本机没有本地 Cowork 会话，M3–M5 先用脱敏样例写测试。

# Antigravity Web 性能优化方案

日期：2026-11-25。对比基线：本仓库 Claude Code 适配（[M0-RESULTS.md](../sync/M0-RESULTS.md) 中 `sync.open` 电脑处理 28–46 ms，重复打开 0.1 ms，消息提交 < 2 ms）。

## 1 问题现象与根因定位

当前 Antigravity Web 在查看会话列表、打开/切换会话、输入与提交消息、运行中同步四个维度都明显卡顿。结合代码逐层核对，核心瓶颈如下：

| 层次 | 现象 | 根因 | 代码位置 |
| --- | --- | --- | --- |
| 底层 Hub 通道 | 所有依赖 Hub 的操作单次多出 400–1000+ ms，并发时达 2–4 s | `callHub()` 无 Keep-Alive（每次新建并销毁 TLS socket），且每次调用都拉起 `powershell.exe` 执行 `Get-Process` + `netstat.exe -ano -p tcp`；`desktopEndpoint()` 无缓存，多 PID 时再拉起一次 PowerShell | [antigravity-hub.ts](../../src/connector/antigravity-hub.ts) |
| 会话列表 | 列表刷新、分页、搜索反应慢 | `antigravity.list` 每次都阻塞等待 `GetPermissionSettings` Hub RPC 并重读全部 `~/.gemini/config/projects/*.json`（即使 `offset > 0` 或 `search` 根本不返回 `projects`） | [antigravity.ts](../../src/connector/antigravity.ts) |
| 打开与查看会话 | 进会话先锁死数秒；运行中持续卡顿 | 1. 一次打开触发 6+ 次 Hub RPC：`snapshot()` 调 `GetAllCascadeTrajectories`（拉取桌面**全部**会话摘要只为读单条权限）+ `GetPermissionSettings` + `GetCascadeTrajectorySteps`（特定条件下回退从 `stepOffset: 0` 全量拉历史）；`<AntigravityModelPicker>` 紧接着又发 `antigravity.models`（3 次 Hub RPC），且每轮 `turn` 变化都重拉。<br>2. `transcript()` 无缓存，每次修订变化都重读并逐行 `JSON.parse` 最多 4 MiB 的 `transcript_full.jsonl`。<br>3. 运行中每 1.3 s 重跑完整 `snapshot()`（3 次 Hub RPC），且无 `fs.watch` 主动推送。<br>4. 缓存态 `cached` 期间禁用全部操作，等慢 `sync.open` 返回才能交互 | [antigravity.ts](../../src/connector/antigravity.ts)、[antigravity.tsx](../../web/antigravity.tsx)、[antigravity-model-picker.tsx](../../web/antigravity-model-picker.tsx) |
| 提交输入与打字 | 点击发送卡在输入框 2–5 s，清空后消息还会短暂消失；打字掉帧 | 1. 前端缺失乐观上屏（`<PendingMessage>`），发送期间输入框锁死，回执后需等桌面刷盘与下一次同步才显示用户消息。<br>2. `sendToHub()` 发送前串行触发多次 Hub RPC（`GetCascadeTrajectorySteps` → `GetTrajectoryTurns` → `GetCascadeModelConfigData` → `UpdateConversationAnnotations` → `SendUserCascadeMessage`）。<br>3. 每次按键同步 `localStorage.setItem` 写草稿，且每次按键重新构造 `senders` 数组触发重渲染 | [antigravity.tsx](../../web/antigravity.tsx)、[antigravity.ts](../../src/connector/antigravity.ts) |

## 2 优化方案

### P0-1 · Hub Keep-Alive 连接池与端点缓存（`src/connector/antigravity-hub.ts`）

- **端点缓存**：按 `daemonDir` 缓存已发现的 `Endpoint`（5 s TTL + 并发去重），每次使用前用零成本的 `process.kill(pid, 0)` 校验进程存活；遇到连接失败、PID 失效或 HTTP 401/403 立即作废并重新发现。
- **已验证 Keep-Alive 连接池**：为每个 `(daemonDir, pid, httpsPort, csrfToken)` 维护一个 `http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 })`：
  - 仅在 `createConnection` **新建 TLS socket** 时执行一次 `ownsSocket(hub, localPort)` 进程归属核验；核验通过后才把 socket 交回 `http.Agent` 发送带 CSRF 的请求。
  - 后续请求复用同一条已建立、已核验的回环 TLS 长连接（TCP 连接不关闭时对端进程不会静默切换，同时每次调用前复核 `process.kill(pid, 0)`），跳过重复 TLS 握手与 `powershell.exe` / `netstat.exe`。
  - 只读方法（`READ_METHODS`）若命中已过期的复用连接（`reusedSocket` 报错），自动销毁旧连接并重试一次；写方法绝不盲目重试，保持原有不确定回执语义。
  - 提供 `closeHubPool()` 在连接器关闭时释放空闲连接。
- **安全边界不变**：任何新建立的 socket 在 `ownsSocket` 通过前绝不发送 `x-codeium-csrf-token`；Hub 重启或端口/PID 变化时自动销毁旧池并重新核验。

### P0-2 · 前端乐观发送、防抖草稿与降重渲染（`web/optimistic.ts`、`web/antigravity.tsx`、`web/antigravity-model-picker.tsx`）

- **乐观上屏**：对齐 Claude Code 与 Codex，在 `web/optimistic.ts` 增加面向 Antigravity 扁平消息列表的 `optimisticAntigravityMessage` / `optimisticAntigravityDelivered`：
  - 发送空闲会话消息时，立即在时间线底部展示 `<PendingMessage>` 并清空输入框；发送失败时无损恢复草稿与附件，状态不明时标记为“结果待核实”；直到同步流出现新的用户消息（或超过 `OPTIMISTIC_ACCEPTED_MS`）自动无缝隐藏，避免重复显示或短暂消失。
  - 新建对话提交时同样即时展示 `<PendingMessage>`。
- **草稿防抖写入**：将 `edit()` 的同步 `localStorage.setItem` 改为复用 `DraftSave`（300 ms 防抖），并在卸载、切页、页面隐藏及发送前立即 `flush()`，既保留切换草稿不丢失特性，又不阻塞每次按键。
- **模型选择器降频**：`<AntigravityModelPicker>` 不再随每次 `turn` 变更重复请求 `antigravity.models`；仅在初次打开、新建页切换项目、打开菜单且缓存已过期（> 15 s）或手动重试时刷新。
- **减少重渲染**：用 `useMemo` 缓存 `SenderScope` 的 `senders` 数组，避免每次打字重建数组。

### P1 · 连接器缓存、增量日志解析与避开全量拉取（`src/connector/antigravity.ts`）

- **元数据 TTL 缓存与并发去重**：
  - `modelCatalog()`（`GetCascadeModelConfigData`）：30 s TTL + 并发去重。
  - `defaultPermissionMode()`（`GetPermissionSettings`）：15 s TTL + 并发去重。
  - `desktopProjects()`（读取 `projects/*.json`）：按目录 `mtimeNs` + 15 s TTL 缓存。
  - `GetAllCascadeTrajectories`：5 s TTL 缓存 + 并发去重，同时维护按会话的 `conversationMeta`（`trajectoryId`、`permissionMode`）；写入 `UpdateConversationAnnotations` 时同步更新内存缓存；找不到新会话兜底时自动绕过缓存直查。
- **精简 `antigravity.list`**：分页（`offset > 0`）或搜索（`search` 非空）时不再读取 `desktopProjects()` 与 `defaultPermissionMode()`；常规列表直接命中上述缓存，不再阻塞于 Hub RPC。
- **精简运行中周期检查与避免反复全量扫步骤**：
  - `FOLLOW_FULL_MS` 定时检查仅刷新 `liveSteps`，复用已有的 `permissionMode` / `defaultPermissionMode`，不再每 1.3 s 调 `GetAllCascadeTrajectories` 和 `GetPermissionSettings`。
  - 当 `notIdle` 且无 `task-*.log` 触发过 `stepOffset: 0` 扫描后，按 `(id, steps)` 记住结果，避免每次版本变动重复拉取整条历史步骤。
- **发送路径并行化**：`sendToHub()` 中需要校验自定义模型时，并行获取 `conversationConfig` 与 `modelCatalog`（且 `modelCatalog` 大概率命中 30 s 缓存）。
- **`transcript_full.jsonl` 缓存与增量尾部解析**：
  - 按 `(path, mtimeNs, size)` 缓存解析结果，文件未变时零磁盘读、零 `JSON.parse`，并保留原有消息对象引用，使 `ThreadHub.revOf` 直接命中 `WeakMap`。
  - 文件仅追加增长且末尾 64 字节签名吻合时，只读取新增字节并合并更新，未变更的旧消息保持原对象引用。

### P2 · `fs.watch` 实时推送（`src/connector/antigravity.ts`）

- 在 `AntigravityBridge` 中接入文件监听：当 `ThreadHub` 关注某条会话时，监听该会话的 `.system_generated/logs` 目录及根目录 `conversation_summaries.db` / `-wal` 变化，立即标记 `followed.stale = true` 并调用 `poke(id)`；发送、创建、审批、停止等本连接器写操作完成后也主动 `poke(id)`。
- 所有 `FSWatcher` 均 `unref()` 并在会话空闲超过 35 s 或 `bridge.close()` 时自动释放，避免 Windows 句柄占用与测试临时目录 `EBUSY`。

## 3 验证计划

1. **单元测试**：
   - `antigravity-hub.ts`：覆盖 Keep-Alive 复用（多次请求仅执行一次 `ownsSocket`）、Hub 重启/换端口自动重建并重新核验、`ownsSocket` 失败时零字节泄露 CSRF、只读请求在断开的复用连接上自动重试一次。
   - `antigravity.ts`：覆盖元数据缓存命中（减少重复 `GetAllCascadeTrajectories` / `GetPermissionSettings` / `GetCascadeModelConfigData` 调用）、`transcript` 缓存与增量追加解析保持旧消息对象引用、`fs.watch` 变化主动推送。
   - `optimistic.ts` 与 `web/antigravity.tsx`：覆盖 Antigravity 乐观消息创建与送达判定。
2. **全量回归**：运行 `npm run check` 与 `npm run build` 确保类型检查、所有单元测试、原生检查与前后端构建全部通过。

# 同步与传输：实施计划

按 [设计](DESIGN.md) 分阶段交付。每个阶段都能单独合并和上线，旧页面、旧连接器、旧中继照常工作。

## 进展

| 阶段 | 状态 |
| --- | --- |
| M0 | 打点已合并；电脑侧结果见 [M0-RESULTS.md](M0-RESULTS.md)，手机侧待部署后测 |
| M1 | 已合并 |
| M2 | Claude Code 部分已合并并上线（见下方“M2 实际做法”）；Codex 仍走原路径 |
| M3 | M3a（下载）已上线；M3c（上传）已合并，未上线，上线前要再改 Nginx（见 DEPLOY.md）；M3b、M3d 未开始 |
| M4、M6、M7 | 未开始 |
| M5 | 已合并（见下方“M5 实际做法”） |

### M2 实际做法（与下文计划的差异）

- 连接器不用 `fs.watch`：只对有手机订阅的会话每 250 ms 查一次版本（Claude Code 是文件状态加运行状态，开销很小），运行端事件和排队变化则立即触发。Windows 上 `fs.watch` 会漏事件，定时检查本来就要保留，单独用它更简单。
- Claude Code 的读取结果按版本缓存（`state()`），旧的 `claude.read` 和订阅共用；同一版本下轮次是同一批对象，`rev` 只算一次。
- 条目差异（`entryDiff`）比较一轮的全部字段，而不只是 Codex `diffTurn` 看的四个；补丁比整条小时才用补丁。
- 网页的会话缓存同时保存各轮的 `rev`（去掉图片的轮次不保存），重新打开时只取变化的轮次。
- 本地 Chromium 端到端（真实中继、只含 Claude Code 的连接器、夹具 transcript）：首次打开不再发 `claude.read`、`claude.watch`；电脑上写入后 155–266 ms 出现在页面上，每帧 400–640 字节；刷新后立即显示缓存，再用 973 字节的回执补齐（首次 11 KB）。
- 本机真实大会话：重新打开时回执从压缩后 255–630 KB 降到约 1 KB；运行中每次更新最多是最后一轮（这几个会话压缩后不超过 27 KB），文字增长时只发增量。

### M5 实际做法

- 会话源沿用原来长轮询里的检查方式：先用上次的运行状态做一次本地快照（会话摘要库加 transcript 大小，本机实测每次 1–4 ms），摘要变了才向桌面 Hub 重读运行状态；一轮在运行或等待时，最多每 1.3 秒重读一次。本地快照最多每 200 ms 一次，跟随 hub 的轮询。排队变化立即触发。
- 一轮结束时立即发出下一条排队消息的逻辑从长轮询移到会话源里；原来的 1.5 秒定时器保留，没人看时也会发。
- 条目是消息，消息很短，窗口设为 2000 条，相当于手机仍拿到 transcript 尾部的全部消息（和原来一样），不需要“加载更早”。
- 本地 Chromium 端到端（夹具会话、模拟的桌面 Hub）：不再发 `antigravity.read`、`antigravity.watch`；写入后约 250 ms 出现在页面上，每帧 300–450 字节；刷新后立即显示缓存，再用 637 字节补齐（首次 6 KB）。

### M3a 实际做法

- 中继只转发下载动作（`file.download`、`claude.file.download`、`antigravity.file.download`）。连接器收到 `blob.pull` 后照常执行这个动作，只是把“读一块”换成“打开文件”（`openProjectDownload`），路径、工作区、访客限制和文件版本检查都不变。
- 手机登录数据通道：`POST /blob/session` 带当前 Token（团队模式下是设备 Token），得到只对 `/blob` 有效的 HttpOnly Cookie；团队模式下每次下载都重新核对设备和电脑权限，移除设备立即失效。
- 网页：视频直接用数据通道地址播放（支持 Range，可拖动），“保存到设备”是浏览器原生下载，PDF 流式接收后交给查看器。中继或连接器任一方没有 `blob` 时退回分块下载；Cookie 失效（中继重启）时本次退回分块、下次重新登录。
- 本地 Chromium 端到端：点开回复里的视频，播放地址是数据通道，3 MB 文件一次取回、`video/mp4`，Range 请求返回 206，整个过程没有分块下载请求。

### M3c 实际做法

- 手机先照常 `uploadStart`（登记文件、取得已写入的位置），之后每段最多 8 MiB，用 `PUT /blob/<电脑>/upload` 发出，进度来自浏览器的上传事件。中继发 `blob.push` 给电脑，电脑从 `/blob-sink/<流>` 读取手机的请求体，写完后用 `blob.done` 回报位置，作为这次 `PUT` 的回答。
- 电脑仍执行原来的分块上传动作，只是数据换成流（`UploadBody`，只有连接器能构造，手机的 JSON 无法触发）。每段必须从文件当前末尾开始；中断后已写入的部分保留，手机再问 `uploadStart` 从那里接着传，最多重试 3 次。
- 写请求另外检查 `Origin`。中继、连接器任一方不支持，或代理拒绝（413）、Cookie 失效（401）时，剩下的部分退回分块上传。
- 本地 Chromium 端到端：在 Claude Code 输入框附加 12 MB 文件并发送，分两段经数据通道上传，没有分块请求，电脑上保存的文件逐字节一致。

## 顺序和依赖

| 阶段 | 内容 | 解决什么 | 改动范围 | 规模 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| M0 | 测量和基线 | 确认瓶颈在哪 | 三端，不改行为 | 小 | 无 |
| M1 | Claude Code、Antigravity 接入现有缓存 | 打开看过的会话不再 loading | 网页 | 小 | 无 |
| M2 | 订阅协议，Claude Code 改为推送 | Claude Code 消息延迟、每次更新的流量 | 三端 | 大 | M0 |
| M3 | 数据通道 | 文件传输、图片、传文件时聊天卡 | 三端 | 大 | M0；M3b 依赖 M2 |
| M4 | Claude Code 逐字输出（增量解析按 M0 结果降级，见下） | 出字慢 | 连接器 | 中 | M2 |
| M5 | Antigravity 接入订阅 | Antigravity 消息延迟 | 连接器、网页 | 中 | M2 |
| M6 | 本地库，Codex 迁入同步引擎 | 缓存范围、为原生 App 定型 | 网页、连接器 | 大 | M2 |
| M7 | 收尾 | 删除过渡代码 | 三端 | 小 | 全部 |

M2 和 M3 互不依赖（M3b 除外），可以并行。只想先看到效果的话，M1 一两天就能上线。

发布顺序：每个阶段先发中继和连接器（它们保留全部旧动作），最后发网页。中继有改动时要用网页加中继的合并发布脚本，见 `DEPLOY.md`。

## M0 · 测量和基线

不改行为，只加打点。结果记在 `docs/sync/M0-RESULTS.md`。

### 请求耗时分段

各段只用本机时钟算耗时，不跨机器比较时间戳。

- 手机：`localStorage['cmw-trace']='1'` 时，`Client.request` 在帧上加 `trace:true`（帧的字段，不放进 `payload`），记录发出到收到回执的总耗时和回执字节数。
- 中继：帧带 `trace` 时转给连接器，记录“转出请求到收到回执”的耗时，写进回执的 `trace.relayMs`，并记下回执帧的字节数。
- 连接器：记录处理耗时，写进 `trace.handleMs`；附上本机时间 `trace.now`，用于估算两端时钟差。
- 手机算出三段：手机到中继的网络 = 总耗时 − `relayMs`；中继到电脑的网络 = `relayMs` − `handleMs`；电脑处理 = `handleMs`。

连接器内部再细分 Claude Code 的读取（`src/connector/claude-code.ts:342-376`）：`getSessionMessages`、读原文、`claudeTurns`、补丁、标题各自的耗时，放进 `trace.steps`。

### 其他打点

- 打开会话：路由切换到内容第一次渲染的耗时（`performance.mark`）。
- 推送延迟：连接器记录“收到运行端事件”到“发出帧”的耗时；手机记录帧到达时间，按 `trace.now` 估出的时钟差换算成端到端延迟。
- 传输：上传、下载循环里记录每个文件的字节数和耗时。

手机端保留最近 500 条记录，`window.cmwTrace()` 按动作输出 p50、p95 表格，并能导出 JSON。

### 要填的基线

分 Wi-Fi 和移动网络各测一遍：

| 场景 | 记录 |
| --- | --- |
| 打开 Codex 会话：有缓存、无缓存 | 到内容显示的耗时、三段分解、字节数 |
| 打开 Claude Code 会话：小（1 MB 以下）、大（10 MB 以上）、带多张图 | 同上，加连接器内部各步耗时 |
| 打开 Antigravity 会话 | 同上 |
| Claude Code 运行中 | 每次更新的间隔和字节数、端到端延迟 |
| 上传 10 MB；下载 10 MB、50 MB | 速度（MB/s） |
| 传输期间的聊天 | 实时帧的额外延迟 |
| 中继持续带宽 | 下载 50 MB 时中继出口的稳定速度 |

### 据此做的决定

- `getSessionMessages` 占 Claude Code 读取耗时一半以上：M4 要自己实现分支解析；否则只做派生数据的增量。
- 中继持续带宽低于手机带宽的一半：M3 之前先升级中继带宽，并重新评估直连。
- 图片占打开会话流量的大头：把 M3b（图片引用）提到 M3a 之前。

### 涉及文件

`web/client.ts`、`web/trace.ts`（新）、`src/server/relay.ts`、`src/connector/main.ts`、`src/connector/claude-code.ts`、`src/shared/types.ts`。

测试：`test/relay.test.ts` 加一条，带 `trace` 的请求在回执里得到 `relayMs`，不带的不受影响。

## M1 · Claude Code、Antigravity 接入现有缓存

只改网页。M6 会把缓存换成本地库，所以这一步只扩展 `web/session-cache.ts` 现有的接口，不改存储结构。

### 改动

- `web/session-cache.ts`：
  - `cachedView`、`rememberView`、`stored` 现在按 `SessionView` 写死。改成接受一个“落库前怎么裁剪”的函数：Codex 用现有逻辑；Claude Code 保留最近 20 轮、去掉图片、清空 `requests`、`queuedMessages`、`running`、`error`、`revision`；Antigravity 保留最近 200 条消息，清空同类字段。
  - 键加应用前缀：`claude:<电脑>:<会话>`、`antigravity:<电脑>:<会话>`。Codex 的键不变。
  - `revision` 必须清空：两个面板靠 `view.revision` 启动长轮询（`web/claude-code.tsx:108`），带着旧值会让第一次轮询直接返回全量，等于多读一次。
- `web/claude-code.tsx`、`web/antigravity.tsx`：`view` 的初始值取缓存；每次读取成功后写缓存。缓存内容带 `cached:true`，此时发送、审批、排队操作不可用，读取完成后放开。顶部的忙碌指示保留，但不再是整屏 loading。
  - 两个面板按 `[电脑, 应用, 会话]` 设了 `key`（`web/main.tsx:654`、`:660`），切换会话时会重建，所以只需要处理初始值。
- `web/antigravity-sidebar.tsx`（Claude Code 的列表也用它）：没有搜索词时，列表初始值取 `cachedList`，加载成功后 `rememberList`。键为 `<listAction>:<电脑>:<项目>`。

### 测试

- 新增 `test/session-cache.test.ts`：三种裁剪函数；缓存内容读出时带 `cached` 且运行状态为空；不同应用的同名会话互不覆盖。
- `test/conversation.test.ts`：`cached` 状态下发送按钮不可用。

### 验收

重新打开看过的 Claude Code、Antigravity 会话，内容立即出现，随后被新内容替换，没有闪烁和滚动跳动。

## M2 · 订阅协议，Claude Code 改为推送

### 共享

- `src/shared/sync.ts`（新）：`ThreadKey`、`Entry`、`SyncOpen`、`SyncSnapshot`、`SyncFrame` 的类型；`revOf(body)`（序列化后取 SHA-256，连接器用）。
- `src/shared/protocol.ts`：`CONNECTOR_FEATURES` 加 `sync`、`sync.claude`。
- `src/shared/types.ts`：`RequestAction` 加 `sync.open`、`sync.page`。

### 连接器

- `src/connector/thread-hub.ts`（新）：
  - `open(source, threadId, window, have)`：读一次，按 `rev` 算出回执，登记订阅，记住已发状态，返回当前 `seq`。读状态、记已发状态、取 `seq` 必须在同一个事件循环节拍里完成，保证回执和后续帧的 `seq` 连续。
  - 会话已有订阅者时，`open` 先对已有订阅者发一帧当前差异，再处理新的订阅。
  - 源报告 `change` 后：`stream` 类只比较正在运行的那一条，用 `diffTurn`（`src/connector/live.ts:118`）出 `ops`；`structure` 类重读，比较条目 `rev` 和头部各字段，出 `entries`、`order`、`head`。
  - 合并发送：40 ms 窗口，安静后的第一帧立即发（把 `src/connector/main.ts:184-195` 的 `scheduleLive` 移进来）。
  - 订阅 30 秒未续期失效，失效时丢弃该会话的已发状态。
- `src/connector/file-watch.ts`（新）：对一个文件 `fs.watch`，同时每 600 ms 查一次修改时间和大小作兜底；只在有订阅者时开启。
- `src/connector/claude-code.ts`：
  - 把 `read()` 拆成“取状态”（头部加全部轮次）和“按窗口裁剪”。取状态的结果按 `revision` 字符串缓存（每个会话一份，最多 8 个会话），同一版本的重复读取不再解析。
  - 实现 `ThreadSource`：`ClaudeRuntime` 的 `change`、排队版本变化、`file-watch` 的变化都转成 `change` 事件。
  - 增量解析要到 M4 才有。在那之前，运行中的 `structure` 重读限制为最多 150 ms 一次。
  - `claude.read`、`claude.watch` 原样保留。
- `src/connector/services.ts`、`src/connector/main.ts`：`sync.*` 按 `payload.service` 分给对应的源；`ThreadHub` 的帧经 `send` 发出。本阶段 Codex 仍走原来的 `live` 路径，两种帧靠有没有 `seq` 区分。

开始前先验证设计 §12 的第 4 条：同一轮在连接器重启前后的序列化是否一致。一致的话，`have.revs` 不再要求 `epoch` 相同。

### 中继

`src/server/relay.ts`：

- `Peer.watch` 加 `service`。`{type:'watch'}` 和 `sync.open` 都能设置它（现在 `session.read` 带 `watch:true` 时设置，见 `:200`）。
- 转发 `live`：帧带 `service` 时按 `(电脑, 应用, 会话)` 匹配；不带时按现在的规则。
- `ready.features` 加 `sync`。
- `src/server/team/actions.ts`：`READ_ACTIONS` 加 `sync.open`；`serviceOf` 对 `sync.*` 读 `payload.service`。

### 网页

- `web/sync/types.ts`、`web/sync/engine.ts`（新）：按设计 §7 的流程实现。本阶段本地库先用一个包着 `session-cache` 的适配器（`web/sync/cache-store.ts`），M6 再换。`web/live.ts` 里“按位置追加、跳过已有文字、保留比快照更长的本地文字”的逻辑搬进引擎，改成按条目通用。
- `web/use-thread.ts`（新）：React 钩子，订阅引擎的会话状态。放在 `web/sync/` 外面，保持引擎不依赖 React。
- `web/client.ts`：实现 `Transport`；`watch` 带 `service`。
- `web/claude-code.tsx`：电脑有 `sync.claude` 时用 `useThread`，把 `{...head, turns: order.map(id => entries[id])}` 交给现有渲染代码，渲染部分不用改；没有时走原来的读取加长轮询，标 `COMPAT(sync)`。

### 测试

- `test/thread-hub.test.ts`（新）：`seq` 逐帧加一；只有文字变长时出追加；条目增减时出 `order`；头部只发变化的字段；第二个订阅者加入时已有订阅者先收到差异；订阅到期后不再发帧、状态已清。
- `test/sync-engine.test.ts`（新）：先给缓存再转 `live`；回执之前到的帧被缓存并正确取舍；跳号和 `epoch` 变化触发重新打开；断线重连后带 `have` 重新打开；页面在后台时不应用帧。
- `test/relay.test.ts`：`live` 帧只发给订阅了同一 `(电脑, 应用, 会话)` 的手机；团队模式下没有权限的设备收不到；旧格式的帧照旧转发。
- `test/claude-code.test.ts`：`sync.open` 带 `have` 时只返回变化的轮次；运行时事件产生帧；同一版本的重复读取不重新解析。

### 验收

对比 M0 的基线：Claude Code 运行中每次更新的字节数、端到端延迟；跟踪记录里不再出现 `claude.watch`。两台手机同时看同一个会话，内容一致。

## M3 · 数据通道

分四步，各自可以上线。

### M3a · 下载

- `src/server/blob.ts`（新），由 `src/server/relay.ts` 的 HTTP 处理把 `/blob` 开头的路径交给它：
  - `POST /blob/session`：校验 `Authorization` 里的 Token（和 WebSocket 握手同一套判断），发 Cookie。
  - `GET /blob/<电脑>/file?service=&thread=&path=&rev=`：校验 Cookie 和电脑权限；生成一次性流 ID；经控制连接向连接器发 `{type:'blob.pull', stream, service, thread, path, rev, range}`；等连接器连上 `/blob-feed/<流 ID>`。
  - `POST /blob-feed/<流 ID>`：连接器把状态放在请求头里（`x-blob-status`、`x-blob-size`、`x-blob-range`、`x-blob-mime`、出错时 `x-blob-error`），请求体是文件内容。中继写好响应头后用 `stream.pipeline` 把请求体接到手机的响应。
  - 响应头按设计 §8：类型白名单、`nosniff`、`sandbox` CSP、非白名单类型强制下载。注意 `relay.ts:32` 现在对所有响应设了 `no-store`，按哈希取的图片要覆盖它。
  - 限制：每台手机同时 4 个流；流 ID 60 秒未使用作废；任何一端断开，另一端立即关闭。
- `src/connector/blob.ts`（新）：处理 `blob.pull`。用现有的 `openProjectFile` 做路径和版本检查（`src/connector/project.ts`），按 `range` 建只读流，用 `undici` 把流作为请求体发给中继。Claude Code 和 Antigravity 的文件、`claude.artifact.download` 走同一处。
- `src/shared/protocol.ts`：加 `blob`。中继 `ready.features` 加 `blob`。
- 网页：
  - `web/blob.ts`（新）：建立 Cookie 会话（连接成功后调一次，401 时重建）；拼地址。
  - `web/file-preview.tsx`：图片、视频、PDF 直接用地址；“保存到设备”用带 `download` 的链接。视频从此可以边下边播。
  - `web/markdown-viewer.tsx:12`：Markdown 里的图片用地址，不再逐张 `file.read`。
  - 没有 `blob` 能力时走原来的分块下载，标 `COMPAT(blob)`。

### M3b · 消息里的图片改为引用（依赖 M2）

- `src/connector/blob-store.ts`（新）：按 SHA-256 存取，按最近使用淘汰，上限 500 MB；从 PNG、JPEG、WebP、GIF 的文件头读宽高。
- `src/connector/normalize.ts:23`（Codex）、`src/connector/claude-transcript.ts:52`（Claude Code）：增加“输出引用”的模式，`sync.*` 用它，旧动作不用。
- 中继加 `GET /blob/<电脑>/sha/<sha256>`，连接器从图片库读。响应带长期缓存头。
- `web/conversation.tsx:19`、`:47`：`images` 里是引用时用地址渲染，带宽高占位，避免加载时跳动。
- `web/session-cache.ts`：引用很小，带引用的轮次不用再去掉图片和版本号。

### M3c · 上传

- 中继：`PUT /blob/<电脑>/upload/<ID>?offset=N`，检查 `Origin`；经控制连接发 `blob.push`；连接器连上 `GET /blob-sink/<流 ID>` 后，把手机的请求体接到它的响应。连接器写完后经控制连接回报新的位置，中继以此作为手机这次 `PUT` 的结果。
- `src/connector/attachments.ts`：`appendUpload` 增加流式版本，沿用位置连续性检查和重复内容校验；仍然经 `uploadStep` 串行。
- `web/file-upload.ts`：`uploadStart` 之后，每次 `PUT` 最多 8 MiB，用 `XMLHttpRequest` 取进度；失败后重新 `uploadStart` 取位置续传，最多重试 3 次。

### M3d · 发送的图片改为引用

- 手机压缩后的图片先上传到图片库（`PUT /blob/<电脑>/image`，返回哈希），发送请求的 `images` 里放引用。
- 连接器在 `turn.send`、`claude.send`、`claude.create`、`antigravity.send`、`antigravity.create` 里把引用还原成内容再交给运行端。账本里的图片指纹（`src/connector/claude-code.ts:105`）改用哈希。
- 中继里“带附件的发送先回 `received`”的特殊处理（`src/server/relay.ts:201`）和手机端的 240 秒超时（`web/client.ts:68`）在这之后只为旧页面保留。

### 测试

- `test/blob.test.ts`（新）：用假的连接器测中继对接。`Range` 请求；手机中途断开后连接器一侧被关闭，反之亦然；没有 Cookie 返回 401；团队成员没有这台电脑的权限返回 403；流 ID 只能用一次、过期作废；非白名单类型被强制下载且带 `sandbox`；`PUT` 的 `Origin` 不符被拒。
- `test/blob-store.test.ts`（新）：按哈希存取、淘汰、四种格式的宽高。
- `test/file-upload.test.ts`：中断后从已写入的位置续传；重复的分段不产生重复内容。
- `test/files.test.ts`、`test/claude-artifacts.test.ts`：下载走数据通道后，路径和版本检查不变。

### 部署

改线上 nginx：`/blob` 开头的路径关闭请求和响应缓冲，放开请求体大小，开启 HTTP/2。验证方法：上传一个 50 MB 的文件，连接器一侧的写入位置应该随上传持续前进，而不是等手机传完才开始。

### 验收

对比 M0：上传、下载速度；传输期间实时帧的额外延迟；带图会话打开时的字节数；第二次打开同一会话时图片请求数为零。

## M4 · Claude Code 增量解析和逐字输出

> M0 结果（[M0-RESULTS.md](M0-RESULTS.md)）：最大的 transcript 热读只要 150 ms，瓶颈是传输量。按 `(修改时间, 大小)` 缓存读取结果、没变的轮次复用对象这两项并进 M2；下面的增量索引暂缓，`getSessionMessages` 的替代不做。逐字输出照常。

### 增量解析

- `src/connector/claude-index.ts`（新）：每个 transcript 一个索引，保存已读到的字节位置、最后一行的未完成部分、已解析的行，以及派生数据。
  - 文件变长：从上次位置读到末尾，只处理完整的行。
  - 文件变短、或上次位置之前的若干字节对不上：整个重建。
  - 最多保留 8 个文件的索引；超过 64 MB 的文件不建索引，走原来的整读。
- `src/connector/claude-transcript.ts`：`claudePatches`、`claudeArtifactTitles`、`claudeRecordedSettings`、`claudeTranscriptCwd` 和时间戳查找，都改成“状态加一行得到新状态”的形式。保留现在接受整段文字的函数，内部改为逐行调用，现有测试不用动。
- `claudeTurns` 对没变的轮次返回同一个对象，`ThreadHub` 按对象缓存 `rev`，不再每次变化都对全部轮次做序列化和哈希。
- M0 表明有必要时，再实现 `getSessionMessages` 的替代（分支解析、压缩边界），用 SDK 的结果做对照测试。

### 逐字输出

先做实测，结果记在 `docs/sync/M4-FINDINGS.md`：SDK 0.3.328 开启流式分片的选项、事件形状、分片里的消息 ID 能否对上 transcript 里的条目 ID、对用量记录（`recordClaudeTurn`）和 `running` 判定有没有影响。

实测通过后：

- `src/connector/claude-runtime.ts`：开启分片；`consume`（`:244`）里把文字分片累加到 `session.streaming`；这类事件只发 `stream` 类变化。
- `src/connector/claude-code.ts`：取状态时把 `session.streaming` 作为临时的一项叠在正在运行的那一轮末尾。完整消息到达后临时项消失，正式项出现。两者 ID 对得上时是文字延长；对不上时是一次整项替换，文字相同，界面上没有变化。
- `src/shared/protocol.ts`：加 `claude.stream`。

### 测试

- `test/claude-index.test.ts`（新）：把每个测试用的 transcript 按随机位置切成多段喂给索引，结果必须和整读一致；多字节字符被切在两段之间；最后一行不完整；文件被改写后重建；压缩边界。
- `test/claude-runtime.test.ts`：分片累加；完整消息到达后临时项被替换；用量记录不变。

### 验收

对比 M0：大会话的读取耗时；连接器运行的会话，首字延迟不超过 200 ms。

## M5 · Antigravity 接入订阅

- `src/connector/antigravity.ts`：实现 `ThreadSource`。条目是消息，`id` 用步骤编号；头部是 `snapshot()` 里消息以外的字段。对 transcript 用 `file-watch`；会话摘要库和后台任务的检查沿用现在 650 ms 的节奏，只在有订阅者且会话在运行或等待时进行。`read()` 里“只补发尾部”的逻辑（`:1160-1167`）和 `recent` 缓存由 `ThreadHub` 取代，旧动作保留到 M7。
- `src/shared/protocol.ts`：加 `sync.antigravity`。
- `web/antigravity.tsx`：有 `sync.antigravity` 时用 `useThread`，把 `{...head, messages: order.map(id => entries[id])}` 交给现有渲染代码。
- 排队消息：现在一轮结束时由长轮询里的 `drainSoon` 立即发出下一条（`:1142`），另有一个 1.5 秒的定时器兜底（`:670`），所以没人看时也会发。改成订阅后，把“一轮结束立即发”挂到会话源检测到运行结束的地方，定时器保留。
- 测试：`test/antigravity.test.ts` 增加订阅用例：消息追加出帧；运行状态和审批请求走 `head`；一轮结束后排队消息立即发出，没有订阅者时由定时器发出。

## M6 · 本地库，Codex 迁入同步引擎

### 本地库

- `web/sync/idb-store.ts`（新）：按设计 §7 的三张表实现 `ThreadStore`。库版本升到 2，升级时删除旧的 `cache` 表。写入按 1.2 秒合并，页面隐藏时立即写（沿用 `web/session-cache.ts:80-83` 和 `web/main.tsx:298-302`）。
- 淘汰：总量超过 50 MB 时，按上次打开时间整个会话删除。
- `web/session-cache.ts` 删除，`web/sync/cache-store.ts` 删除。项目列表、会话列表改用 `ThreadStore` 的列表接口。
- `PRIVACY.md`：更新本机保存的内容和范围。

### Codex

- `src/connector/control.ts`：实现 `ThreadSource`。`stream`、`change` 事件接到 `ThreadHub`；`liveDiff`、`watchers`、`liveFrame` 移除；`generation` 作为 `epoch`。旧的 `session.read` 和不带 `seq` 的 `live` 帧保留到 M7。
- `web/main.tsx`：Codex 会话改用 `useThread`。`refreshSession`、`scheduleRefresh`、`receiveLive` 以及对 `knownSnapshot`、`restoreSnapshot`、`keepLiveText`、`applyLiveFrames` 的调用移除。每 10 秒的兜底刷新改成续订（重新 `sync.open`，没有变化时回执里没有条目）。
- 会话列表仍是普通的请求和回执：先显示本地库里的，再用新结果替换；收到不带会话的 `changed` 时重取。

### 测试

- `test/idb-store.test.ts`（新）：需要在 Node 里有 IndexedDB，加开发依赖 `fake-indexeddb`。覆盖读写、升级时丢弃旧表、淘汰、清空、读超时。
- `test/sync-engine.test.ts`：换成真实的存储实现再跑一遍。
- `test/control.test.ts`、`test/live.test.ts`：Codex 经 `ThreadHub` 出的帧和原来等价。
- 用 `docs/live-sync.md` 里的测量方法重跑一遍，确认 Codex 的各项指标没有退步。

### 验收

三个应用里看过的会话，在断网状态下都能打开并显示上次内容。连续打开 50 个会话后，本地库占用不超过上限。

## M7 · 收尾

- 到期后删除 `COMPAT(sync)`、`COMPAT(blob)` 的分支：`claude.watch`、`antigravity.watch`、分块下载、分块上传、请求里内联的图片、不带 `seq` 的 `live` 帧。删除前在团队页确认所有在用的连接器都已报告对应能力。
- `docs/live-sync.md` 改为指向本目录；根目录 `DESIGN.md`、`IMPLEMENTATION.md` 里的传输部分同步更新。
- 把各阶段的验收数据汇总进 `docs/sync/RESULTS.md`，和 M0 的基线并排。

## 人工验收

每个阶段上线后，在真实手机上过一遍：

1. 三个应用各打开一个看过的会话和一个没看过的会话。
2. Claude Code：连接器运行的会话发一条消息，看出字；在电脑的终端里运行同一会话，看手机跟随。
3. 两台手机同时看同一个会话，一台发消息，另一台跟随。
4. 运行中切到后台 1 分钟再回来；运行中开关一次飞行模式。内容补齐，没有重复和缺失。
5. 上传一个 50 MB 的文件，中途切一次网络，能续传；上传期间另一个会话的出字不受影响。
6. 下载一个视频并播放，拖动进度条。
7. 带图的会话：第一次打开图片逐张出现，第二次打开立即出现。
8. 团队模式：没有某台电脑权限的成员，直接访问那台电脑的 `/blob` 地址被拒。
9. 访客电脑：工作区以外的路径经数据通道同样被拒。
10. 回归：旧连接器配新页面、新连接器配旧页面都能正常使用，新页面提示更新。

## 涉及文件一览

| 文件 | 阶段 | 变更 |
| --- | --- | --- |
| `src/shared/sync.ts`（新） | M2 | 同步协议的类型、`revOf` |
| `src/shared/protocol.ts` | M2–M5 | `sync`、`sync.claude`、`blob`、`claude.stream`、`sync.antigravity` |
| `src/shared/types.ts` | M0 M2 | `trace`、`sync.*` 动作 |
| `src/connector/thread-hub.ts`（新） | M2 | 订阅、算差异、编号、合并发送 |
| `src/connector/file-watch.ts`（新） | M2 | 文件变化通知加定时兜底 |
| `src/connector/claude-code.ts` | M0 M2 M4 | 打点；会话源；按版本缓存；叠加流式文字 |
| `src/connector/claude-index.ts`（新） | M4 | transcript 增量索引 |
| `src/connector/claude-transcript.ts` | M3b M4 | 图片引用；派生数据改为逐行 |
| `src/connector/claude-runtime.ts` | M4 | 流式分片 |
| `src/connector/antigravity.ts` | M5 | 会话源 |
| `src/connector/control.ts`、`src/connector/live.ts` | M6 | Codex 作为会话源；`LiveDiff` 并入 `ThreadHub` |
| `src/connector/blob.ts`、`src/connector/blob-store.ts`（新） | M3 | 数据通道的连接器一侧；图片库 |
| `src/connector/attachments.ts`、`src/connector/project.ts`、`src/connector/normalize.ts` | M3 | 流式上传；按范围读；图片引用 |
| `src/connector/main.ts`、`src/connector/services.ts` | M0 M2 M3 | 打点；`sync.*` 和 `blob.*` 的分发 |
| `src/server/relay.ts`、`src/server/team/actions.ts` | M0 M2 | 打点；按应用转发 `live`；团队记录认 `sync.open` |
| `src/server/blob.ts`（新） | M3 | 数据通道的中继一侧 |
| `web/trace.ts`（新）、`web/client.ts` | M0 M2 | 打点；实现 `Transport` |
| `web/session-cache.ts` | M1 M6 | 先扩展到三个应用，M6 删除 |
| `web/sync/engine.ts`、`web/sync/types.ts`（新）、`web/use-thread.ts`（新） | M2 | 同步引擎 |
| `web/sync/idb-store.ts`（新） | M6 | 本地库 |
| `web/claude-code.tsx`、`web/antigravity.tsx`、`web/antigravity-sidebar.tsx` | M1 M2 M5 | 缓存；改用同步引擎 |
| `web/main.tsx`、`web/live.ts`、`web/session-snapshot.ts` | M6 | Codex 改用同步引擎，旧的拼装逻辑移除 |
| `web/blob.ts`（新）、`web/file-upload.ts`、`web/file-download.ts`、`web/file-preview.tsx`、`web/markdown-viewer.tsx`、`web/conversation.tsx` | M3 | 数据通道的网页一侧 |
| `DEPLOY.md`、`PRIVACY.md`、`docs/live-sync.md` | M3 M6 M7 | nginx 配置；本机存储说明；文档归并 |

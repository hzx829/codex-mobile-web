# 同步与传输：设计

日期：2026-11-24。实施步骤见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## 1 要解决的问题

手机上三处明显的卡顿：打开会话有 loading，消息出现得慢，文件传得慢。原生 App 没有这些问题，因为它们本地有库、增量同步、文件走独立通道。本项目接下来也要做原生 App，所以这三件事要在**协议和连接器**这一层解决，网页和原生共用。

[live-sync.md](../live-sync.md) 已经为 Codex 做了缓存和实时推送。本文把同样的做法推广到 Claude Code 和 Antigravity，并把文件、图片从聊天连接里拆出去。

## 2 现状

下面每一条都读过代码确认。

| 现象 | 原因 | 位置 |
| --- | --- | --- |
| 打开 Claude Code、Antigravity 会话必有 loading | 两个面板从 `view=null` 开始，等一次读取才有内容，没有接会话缓存；会话列表也没有缓存 | `web/claude-code.tsx:76`、`web/antigravity.tsx:112`、`web/antigravity-sidebar.tsx:32` |
| Codex 缓存命中率有限 | 内存 24 个、IndexedDB 10 个会话，每个 20 轮，不存图片 | `web/session-cache.ts:12` |
| Claude Code 读取慢 | 一次读取对整个 transcript 做多遍完整处理：SDK 读消息、原文再读一遍、补丁、页面标题、时间戳、设置各扫一遍 | `src/connector/claude-code.ts:346-376` |
| Claude Code 消息延迟 | 长轮询：连接器每 600 ms 查一次文件状态，有变化就重新解析并返回最近最多 60 轮的完整内容；手机收到后再发下一次轮询 | `src/connector/claude-code.ts:29`、`:328-341`、`web/claude-code.tsx:107-127` |
| Claude Code 没有逐字输出 | 连接器自己运行的会话每条 SDK 消息都会触发 `change` 事件，但没人把它推给手机；也没有开启 SDK 的流式分片 | `src/connector/claude-runtime.ts:180-187`、`:262` |
| Antigravity 消息延迟 | 长轮询，650 ms 一次；有变化时只补发尾部消息 | `src/connector/antigravity.ts:1119-1168` |
| 文件上传、下载慢 | 512 KB 一块，base64 放进 JSON（体积多三分之一），收到回执才发下一块，速度受往返延迟限制 | `web/file-upload.ts:20-28`、`web/file-download.ts:6-20`、`src/connector/project.ts:116-126` |
| 传文件时聊天也卡 | 文件块、会话快照、实时帧共用一条 WebSocket；中继对每一帧解析后再序列化 | `src/server/relay.ts:63-68`、`:135` |
| 带图的会话更慢 | 图片是 data URL，内联在会话 JSON 里（Claude Code 每张最大 2 MiB）。Claude Code 每次有变化都随快照重发；缓存里存不下 | `src/connector/claude-transcript.ts:12`、`:52`、`web/session-cache.ts:38` |
| 发图片慢 | 发送的图片（整批最多 8 MiB）以 data URL 放在发送请求的 JSON 里 | `src/shared/images.ts:3-7` |

已测量（2026-11-24，从运行连接器的电脑直连线上中继）：建连单程约 50–60 ms；HTTP/1.1，前面是 nginx 1.20.1。

没有测量：手机到中继的延迟、中继的持续带宽、各环节实际耗时、连接器解析大 transcript 的耗时。实施的第一步就是补这些数（M0）。

## 3 目标

以下数值是提议，M0 拿到基线后修订。

| 场景 | 目标 |
| --- | --- |
| 打开看过的会话（三个应用） | 不等网络，100 ms 内显示上次内容 |
| 打开没看过的会话 | 一次往返；只传最近一页，图片不随消息传 |
| Claude Code（连接器运行的会话）出字 | 比 SDK 给出晚不超过 200 ms |
| Claude Code（电脑上其他程序运行的会话） | 比写入 transcript 晚不超过 300 ms |
| 运行中每次更新的流量 | 只传变化的部分，不传整轮、不传图片 |
| 文件上传、下载 | 达到链路可用带宽的八成以上；传输期间聊天帧的额外延迟不超过 100 ms |
| 看过的图片 | 不重复下载 |

不在本文范围：
- 端到端加密。方案见 [竞品研究 §1](../research/paseo-openchamber.md)，第 7 节说明它和本文的关系。
- 推送通知、界面渲染优化（长列表只挂载一部分等）。
- 改变三个应用各自的会话语义（审批、排队、接管桌面等）。

## 4 总体结构

```
手机（网页 / 原生）                中继                     电脑（连接器）
┌──────────────────────┐                              ┌──────────────────────┐
│ 界面                  │                              │ 会话源                │
│   ↑ 订阅              │                              │  Codex / Claude /     │
│ 同步引擎 ── 本地库     │ ←─ 控制连接（WebSocket）──→  │  Antigravity          │
│   · 先读本地          │    请求、回执、增量帧         │   ↓ 变化              │
│   · 按版本补差异      │                              │ 会话推送（ThreadHub）  │
│   · 应用增量帧        │                              │   · 算差异、编序号     │
│                      │                              │                      │
│ 文件、图片            │ ←─ 数据通道（HTTP 流）────→   │ 文件、图片库           │
└──────────────────────┘    二进制、可续传、可缓存     └──────────────────────┘
```

四个部分，彼此独立：

1. **统一的订阅协议**（§5）：三个应用用同一种“快照 + 增量帧”，取代两种长轮询。
2. **连接器的会话推送**（§6）：每个应用实现一个会话源，公共部分负责算差异、编号、合并发送。
3. **手机的同步引擎和本地库**（§7）：打开会话先读本地，再补差异。不依赖浏览器接口，原生 App 复用。
4. **数据通道**（§8）：文件和图片走中继的 HTTP 流，不再占用聊天连接。

## 5 订阅协议

### 模型

同步层不关心内容，只认三样东西：

- **会话**：`(电脑, 应用, 会话 ID)`。
- **头部**：会话里除条目以外的字段（标题、是否运行、审批请求、排队消息、上下文用量等）。
- **条目**：有序列表，每条有 `id` 和 `rev`（内容的 SHA-256）。Codex 和 Claude Code 的条目是一轮（`TurnView`），Antigravity 的条目是一条消息。

这样三个应用共用同一套同步代码，界面仍然各自解释条目内容。

### 打开会话：`sync.open`

手机发：

```jsonc
{"action":"sync.open","payload":{
  "service":"claude","threadId":"…",
  "limit":20,                       // 最近多少条
  "have":{"epoch":"…","revs":{"<条目 id>":"<rev>"}}   // 本地已有的，可省略
}}
```

连接器回：

```jsonc
{"epoch":"…","seq":41,
 "head":{…},                         // 完整头部
 "order":["id1","id2",…],            // 这一页的条目顺序
 "entries":[{"id":"id2","rev":"…","body":{…}}],   // 只含手机没有或已变化的
 "hasMore":true,"before":"id1"}
```

这次请求同时把手机登记为该会话的订阅者，取代现在的 `watch`。更早的历史用 `sync.page {before, limit}` 取，是普通的请求和回执，不订阅。

`rev` 是内容哈希，与连接器是否重启无关，所以手机隔天再打开，没变的条目也不用重传。（现在 Codex 的 `known` 只在 `generation` 相同时才生效，见 `src/connector/session-snapshot.ts:7`；M2 要先确认这个限制的原因，再决定能否放开。）

### 增量帧：`live`

连接器对有订阅者的会话推送：

```jsonc
{"type":"live","service":"claude","threadId":"…","epoch":"…","seq":42,
 "ops":[{"e":"<条目>","i":"<条目内的项>","o":120,"t":"追加的文字"},   // 文字追加
        {"e":"<条目>","item":{…}}],                                  // 新增或替换一项
 "entries":[{"id":"…","rev":"…","body":{…}}],   // 整条新增或替换
 "order":["…"],                                 // 条目顺序变了才带
 "head":{"running":false,"requests":[]}}        // 只含变化的头部字段，null 表示清除
```

规则：

- `seq` 在同一个 `epoch` 内每帧加一。手机收到的 `seq` 不是“已有的加一”，或者 `epoch` 变了，就带着 `have` 重新 `sync.open`。连接器按 `rev` 算差异，**不保存历史帧，也不做重放**。
- `epoch` 在连接器重启、会话换了运行来源（如桌面接管）时变化，对应现在 Codex 的 `generation`。
- 文字追加带起始位置 `o`，手机已有的部分跳过，所以帧和快照先后到达都不会出错（沿用 `web/live.ts` 现在的做法）。
- 合并窗口 40 ms，安静之后的第一帧立即发（沿用 `src/connector/main.ts:187-195`）。
- 第二台手机打开同一会话时，连接器先把当前差异作为一帧发给已有订阅者，再给新手机算快照。现在的 `LiveDiff.prime` 是直接覆盖，已有订阅者会漏掉一段，靠位置对不上触发重读来补。

有订阅者的会话不再发 `changed`。`changed` 只用于通知会话列表变化和没人订阅的会话。

### 中继

- `watch` 的键加上 `service`，`live` 帧按 `(电脑, 应用, 会话)` 转给订阅的手机（`src/server/relay.ts:192-223`）。
- 团队模式下，中继在 `sync.open` 的回执里照旧补 `owner`、`lastSender`。

## 6 连接器

### 会话源

每个应用实现同一个接口：

```ts
interface ThreadSource {
  /** 当前状态。同一状态下重复调用要便宜（内部缓存）。 */
  read(threadId: string, window: {limit: number; before?: string}): Promise<{epoch: string; head: Json; entries: {id: string; body: Json}[]; hasMore: boolean}>;
  /** 会话可能变了。'stream'：只有正在运行的那一条的内容变了。 */
  on(event: 'change', listener: (threadId: string, kind: 'stream' | 'structure') => void): this;
}
```

公共的 `ThreadHub`（由 `control.ts` 里的订阅、`LiveDiff` 和 `main.ts` 里的 `scheduleLive` 提出来）负责：

- 记录每个会话的订阅和到期时间（沿用 30 秒续期）。
- 记住上次发出的状态：每条的 `rev`、头部各字段的哈希、正在运行的那一条的完整内容。
- 源报告变化后读一次，算出帧，编 `seq`，按 40 ms 合并发送。

它只为有订阅者的会话保存状态，而且除了正在运行的那一条，只存哈希。竞品研究里“不在内存里维护全量时间线”的结论仍然成立。

### Claude Code

分三步，每步都能单独上线：

1. **推送代替轮询**。连接器运行的会话：`ClaudeRuntime` 的 `change` 事件直接通知 `ThreadHub`。电脑上其他程序运行的会话：用 `fs.watch` 监视 transcript，保留 600 ms 的状态检查作兜底（Windows 上 `fs.watch` 可能漏事件）。只发变化的轮次，而不是 60 轮。
2. **增量解析**。transcript 只追加，所以每个文件保留一个索引：已读到的字节位置、已解析的行、以及从原文派生的数据（补丁、页面标题、时间戳、设置、目录）。文件变长时只读新增部分；文件变短或开头变了（压缩、分叉、改写）就重建。SDK 的 `getSessionMessages` 负责解析分支和压缩边界，这一步先保留它，只按 `(修改时间, 大小)` 缓存结果；M0 的数据表明它是瓶颈时再自己实现。
3. **逐字输出**。连接器运行的会话开启 SDK 的流式分片，把分片累加到正在运行的那一轮，走 `ops` 追加。需要先在当前 SDK 版本（0.3.328）上实测选项名、事件形状和开销。

电脑上其他程序运行的会话做不到逐字，只能做到“写入 transcript 后尽快出现”。

### Antigravity

条目是消息。transcript 已经是按尾部读取（4 MiB），把 650 ms 的轮询换成对 transcript 的 `fs.watch`，变化后通知 `ThreadHub`；会话摘要库的变化仍需定时检查，保留为兜底。现有的“只补发尾部”由按 `rev` 算差异取代。

### Codex

已有推送。改动只是把 `Control` 接成一个会话源，帧里加 `seq` 和 `service`，头部变化从“发 `changed` 再整读”改为 `head` 补丁。

## 7 手机：同步引擎和本地库

### 模块边界

新目录 `web/sync/`，不引用 DOM、React、`localStorage`、`indexedDB`，只依赖两个注入的接口：

```ts
interface Transport {            // 现在的 Client 实现它
  request(action: string, payload: Json, machineId: string): Promise<Json>;
  onFrame(listener: (frame: Json) => void): () => void;
  onStatus(listener: (online: boolean) => void): () => void;
}
interface ThreadStore {          // 网页：IndexedDB；原生：SQLite
  loadThread(key: ThreadKey): Promise<StoredThread | null>;
  saveThread(key: ThreadKey, patch: {epoch?: string; head?: Json; order?: string[]; entries?: Entry[]; remove?: string[]}): Promise<void>;
  loadList(key: string): Promise<Json[] | null>;
  saveList(key: string, items: Json[]): Promise<void>;
  evict(budgetBytes: number): Promise<void>;
  clear(): Promise<void>;
}
```

引擎对界面只暴露一件事：`open(key)` 返回一个可订阅的会话状态，带 `phase: 'cached' | 'syncing' | 'live' | 'offline'`。

引擎的流程：

1. 内存里有就立即给出；否则读本地库，给出并标为 `cached`。
2. 发 `sync.open`，带上本地的 `epoch` 和各条的 `rev`。
3. 回执到达：合并，写本地库，转为 `live`。回执之前到达的帧先缓存；`seq` 不大于回执里的丢弃。
4. 之后按帧更新。跳号、`epoch` 变化、重连，都回到第 2 步。
5. 页面在后台时不应用帧，回到前台时回到第 2 步（沿用现在的做法）。

### 本地库（网页）

IndexedDB，版本升到 2，旧的 `cache` 表丢弃：

| 表 | 键 | 内容 |
| --- | --- | --- |
| `threads` | `[电脑, 应用, 会话]` | `epoch`、头部、条目顺序、上次打开时间、占用字节 |
| `entries` | `[电脑, 应用, 会话, 条目]` | `rev`、内容 |
| `lists` | `[电脑, 应用, 列表键]` | 会话列表的一页 |

- 条目里不含图片内容（§8 之后图片是引用），所以不再需要“去掉图片并丢弃版本号”的处理。
- 上限 50 MB，超出时按上次打开时间整个会话淘汰。申请 `navigator.storage.persist()`，被拒绝也照常工作。
- 读本地库超过 200 ms 就不等了（沿用 `loadCache` 的做法），避免库被锁时卡住界面。
- 运行状态不落库：`running`、审批请求、排队消息在读出时清空，同步完成前不显示为运行中。

### 缓存内容能不能操作

沿用现在的规则：`cached` 阶段可以看、可以滚动、可以打字，发送等同步完成（`live`）后放开。发送需要当前的运行状态和轮次，用旧状态发出去会被连接器拒绝或落到错误的轮次上。

### 隐私

会话文字现在已经存在 IndexedDB 里（最近 10 个）。本文把范围扩大到三个应用、更多会话。“断开连接”时清空的行为不变。实施时同步更新 `PRIVACY.md`。

## 8 数据通道

### 做法

文件和图片不再经过控制连接。手机和连接器各自向中继发起一个 HTTP 请求，中继把两头接起来：

```
下载：手机  GET /blob/<电脑>/…            ─┐
                                          ├─ 中继把连接器的请求体接到手机的响应体
      连接器 POST /blob-feed/<流 ID>      ─┘   （中继先经控制连接通知连接器：blob.pull）

上传：手机  PUT /blob/<电脑>/upload/<ID>  ─┐
                                          ├─ 中继把手机的请求体接到连接器的响应体
      连接器 GET /blob-sink/<流 ID>       ─┘   （中继先经控制连接通知连接器：blob.push）
```

相比现在：

- 二进制直传，没有 base64，没有 JSON 解析。
- 每次传输是独立的连接，不堵聊天。
- 中继用流对接，自带背压，不在内存里攒整个文件。
- 下载支持 `Range`，视频可以边下边播，PDF 可以按需取页。
- 浏览器可以直接用作 `<img>`、`<video>` 的地址，并按 HTTP 缓存规则缓存。

没有选“在 WebSocket 里发二进制帧”，是因为那样仍要自己做分帧、背压和续传，而且不解决队头阻塞。预览隧道（`src/server/preview-tunnel.ts`）已经证明经中继做 HTTP 流是可行的，但它把数据放在控制连接上，这里不沿用这一点。

### 鉴权

- 手机：`<img>` 带不了请求头，所以用 Cookie。手机用 Token 调一次 `POST /blob/session`（`Authorization` 头），中继发一个 `HttpOnly; Secure; SameSite=Strict` 的 Cookie，映射到这台设备的身份，12 小时过期，断开连接时作废。团队模式下中继照旧检查这台设备能否使用目标电脑。原生 App 直接带请求头。
- 连接器：`/blob-feed`、`/blob-sink` 的流 ID 是中继生成的一次性随机数，只经控制连接发给目标连接器，60 秒内未使用即作废。
- 路径检查仍在连接器做，规则不变（项目目录内、访客工作区内、文件版本一致）。

### 不能让文件在应用的源下运行

现在下载一律当作二进制 Blob，就是为了避免 HTML、SVG 在应用的源下执行（`web/file-download.ts:22`）。数据通道必须保持这一点：

- 只对白名单类型给出真实的 `Content-Type`：位图图片、视频、PDF。
- 其余一律 `application/octet-stream` 加 `Content-Disposition: attachment`。
- 所有响应带 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox; default-src 'none'`。

### 消息里的图片改为引用

- 连接器在整理条目时，把内联图片换成引用 `{blob:"<sha256>", mime, bytes, width?, height?}`，图片内容存进连接器数据目录下的图片库（按哈希命名，按最近使用淘汰，上限 500 MB）。宽高从文件头解析，不引入图片处理库。
- 手机用 `/blob/<电脑>/sha/<sha256>` 加载。内容由哈希决定，响应带 `Cache-Control: private, max-age=31536000, immutable`，看过的图片不再下载。
- 只有 `sync.*` 返回引用。旧的 `session.read`、`claude.read` 仍返回内联图片，供旧页面使用。
- 缩略图暂不做：需要在连接器引入图片处理库，会影响便携包。先靠懒加载和缓存，M0 数据显示有必要再做。

### 上传

- `file.uploadStart` 保留，用来登记文件并取得已写入的位置。
- 之后用 `PUT /blob/<电脑>/upload/<ID>?offset=N` 传剩余部分，每个请求最多 8 MiB，按顺序发。中断后重新 `uploadStart` 取位置再续传。连接器沿用现有的位置连续性检查和重复内容校验（`src/connector/attachments.ts:49-69`）。
- 进度：网页用 `XMLHttpRequest` 的上传进度事件（`fetch` 没有）。
- 发送的图片：先按同样方式上传为图片库里的内容，发送请求里只带引用。

### 部署

线上中继前面是 nginx。数据通道需要它不缓冲请求和响应：对 `/blob` 开头的路径设置 `proxy_request_buffering off`、`proxy_buffering off`，并放开 `client_max_body_size`。同时开启 HTTP/2，否则浏览器对同一个源最多 6 条连接，一屏图片会排队。仓库自带的 Caddy 配置默认流式转发，默认开启 HTTP/2。

## 9 兼容

按 `src/shared/protocol.ts` 的规则：消息只增不减，新能力登记名字，缺能力时提示更新，不做降级实现。

| 能力 | 登记在 | 含义 |
| --- | --- | --- |
| `sync` | 连接器、中继 | 支持 `sync.open`、`sync.page`，`live` 帧带 `service`、`seq` |
| `sync.claude`、`sync.antigravity` | 连接器 | 对应的应用已接入订阅 |
| `claude.stream` | 连接器 | Claude Code 逐字输出 |
| `blob` | 连接器、中继 | 数据通道：下载、上传、图片引用 |

过渡期两个方向都能用：

- 新页面遇到旧连接器：没有 `sync` 就继续用 `session.read`、`claude.read` 加 `claude.watch`、`antigravity.watch`，并显示“请更新连接器”。这些分支标 `COMPAT(sync)`，定一个删除日期。
- 旧页面遇到新连接器：旧动作全部保留。

## 10 和原生 App 的关系

| 部分 | 原生 App 复用程度 |
| --- | --- |
| 订阅协议、连接器、中继 | 原样复用 |
| 同步引擎（`web/sync/`） | 原样复用（React Native 直接用；其他技术栈按同一协议重写） |
| 本地库 | 接口相同，实现换成 SQLite，上限可以放大 |
| 数据通道 | 协议相同；上传改用系统的后台传输，切到后台也能传完；请求带头不用 Cookie |

原生独有、网页做不到的三项，记在 [原生 App 待办](../native-app/BACKLOG.md)：后台同步和推送、局域网直连、后台上传。

## 11 取舍

- **不做帧重放。** 跳号后按 `rev` 补差异，多传的最多是正在运行的那一条。换来连接器不用保存历史帧。
- **不在同步层统一三个应用的内容格式。** 同步层只认“头部 + 条目”，Antigravity 的消息不用硬套成“轮”。
- **中继暂不改成“只转发不解析”。** 之前的建议里它排第四。重新评估后：订阅协议让帧变小，数据通道把大块数据移走，之后中继解析的开销可以忽略。它真正的价值是给端到端加密铺路，所以留到做加密时一起做。
- **直连（WebRTC 或局域网）暂不做。** 成本最高，国内网络下打洞成功率不确定。M0 的数据表明中继带宽是瓶颈时再评估；带宽不够时先升级带宽更便宜。

## 12 风险和未决问题

1. **`fs.watch` 在 Windows 上的可靠性。** 所以保留定时检查兜底，M2 里实测漏事件的比例。
2. **Claude Code SDK 的流式分片。** 选项、事件形状、对用量统计和 `running` 判定的影响都要实测；不行的话 Claude Code 只能做到按消息块出现。
3. **`getSessionMessages` 的耗时。** 如果它占了读取时间的大头，M4 要自己实现分支解析，工作量和出错面都更大。
4. **`rev` 跨 `generation` 是否可信。** 取决于同一轮的内容在连接器重启前后序列化是否一致，M2 里验证。
5. **nginx 配置。** 线上的配置不在仓库里，数据通道上线前要先改并验证不缓冲。
6. **iOS Safari 的存储回收。** 没有添加到主屏的页面，七天不用可能被清空。本地库只是加速，清空后退回到“一次往返”，不影响正确性。
7. **Cookie 鉴权是新增的攻击面。** 现在中继的 HTTP 只发静态文件，没有任何带身份的请求。加了 Cookie 之后，`/blob` 下的写操作（上传）要检查 `Origin`，并且只接受 `PUT`，不接受表单能发出的请求。现有 CSP 不用改：`img-src 'self'` 和 `default-src 'self'` 已经允许同源的图片和视频。

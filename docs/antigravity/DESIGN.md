# 通过自部署中继操作本机 Antigravity

2026-11-17，Windows Antigravity App 2.32.1，codex-mobile-web `364d47e`。用户在现有网络里使用 Google 官方远控时，手机与电脑两边经过代理，操作反馈慢。目标是让手机打开自己的域名，选中电脑上的 Antigravity 对话，看进度、发消息、停止或回应审批，回电脑后还能接着操作同一条对话。

**架构决定：复用已部署的 codex-mobile-web 中继。** 手机到中继、电脑到中继各保持一条连接，任务仍在电脑执行。优先验证桌面 App 自己正在使用的本机 Hub。官方 Remote Control 只作调研对照，整个自建流程应能在关闭其开关时使用。以下是设计与静态证据；当前网络的实际耗时和桌面接口的运行语义待验收。[实施与验收](IMPLEMENTATION.md)

## 手机入口

同一个网页顶部提供 **Codex / ChatGPT / Antigravity**。在首页或对话页点应用名即可切换，保持电脑和中继连接，并恢复目标应用上次打开的会话。Antigravity 的首版实现范围与待验收部分见[实施状态](IMPLEMENTATION.md)。

## 控制流量走哪条路

```text
手机浏览器  ── HTTPS / WSS ──►  自部署中继  ◄── 出站 WSS ──  Windows 连接器
                                                               │
                                                        回环接口 · Hub
                                                               │
                                                     桌面对话、本地工具和文件
                                                               │
                                                  电脑原有代理 → 模型服务
```

- 手机从中继加载页面、查看对话及收发操作。电脑从内网主动连接同一中继。中继通过已有的 `machineId` 转发消息，家庭网络无需开放入站端口。对话同步不依赖手机访问 Google，也不依赖电脑连入 Google 的远控服务。
- Antigravity 从电脑访问模型时仍沿用电脑原有账号和网络。选项目、看已有历史、提交停止或审批的反馈可以独立测量；模型排队、推理和工具执行各有自己的耗时。若手机的 VPN 或电脑的系统代理也代理自有域名，自部署仍可能绕路。上线时分别核对两端到中继的实际路径，只在需要时为中继域名配置直连。
- 中继属于信任边界，能读取路由的内容。沿用现有 Token、HTTPS/WSS 与本机操作账本；中继不落盘聊天。Hub 的 CSRF、本机端口、Google 凭据及工作区绝对路径以最小必要范围留在电脑。中继只认有限的业务动作，不能转发任意 Hub 方法、主机或端口。[中继实现](../../src/server/relay.ts) · [现有隐私说明](../../PRIVACY.md)

## 同一条桌面对话如何接入

桌面 Hub 已经在运行，连接器按用户点开的项目或会话读它的本机接口。手机选会话时保存电脑 ID 和 Hub 返回的原生 `cascade_id`。项目名、标题和目录仅用于展示。同一目录有两条同名对话，也必须各自独立路由。手机关闭时，桌面仍拥有任务。

| 首版动作 | 本机 2.32.1 证据 | 对用户的语义 |
| --- | --- | --- |
| 查项目、列会话 | 项目文件有 ID、名称和文件夹 URI。`GetAllCascadeTrajectories` 返回摘要映射；`ListProjects` 返回项目 ID。 | 展示本机项目和最近会话，多根项目保留各目录；摘要无法确定项目时保留未归类。 |
| 看历史和活动 | `GetConversationMetadata` 返回 `num_steps` 和 `trajectory_id`；`GetCascadeTrajectorySteps` 接受 `cascade_id`、`step_offset`。`StreamCascadeReactiveUpdates` 是服务端流。 | 打开时先显示最近一页；新增步骤以及同一步内更新的文字、工具状态都能出现。断线后从对应会话补齐。 |
| 发送、新建 | `SendUserCascadeMessage` 有 `cascade_id`、`items`、`client_message_id`、`delivery_strategy`；`StartCascade` 有 `project_env_config`、`workspace_uris`，响应含 `cascade_id`。 | 优先交付向现有空闲对话发送文字。新建取得新 ID 后再发首条。运行中“追加”或“完成后发送”的行为需分别验证，再显示对应操作。 |
| 处理审批 | `HandleCascadeUserInteraction` 按 `cascade_id` 接收交互；内部有 `trajectory_id`、`step_index`、权限、命令、提问等分支。 | 只显示已能复原目标、选项和原生处理结果的交互。电脑已回答后，手机的旧卡片要失效。 |
| 停止 | `CancelCascadeInvocation` 的目标是 `cascade_id`，还有 `kill_background_tasks` 等选项，描述符里没有预期轮次参数。 | 只显示已验证作用范围的停止能力；操作结果由原生状态更新确认。不能声称手机携带的轮次号就能消除与桌面同时操作的竞态。 |

这些方法和字段来自安装包中 `exa.language_server_pb.LanguageServerService` 的 protobuf 描述符。它们证明接口形状；路由是否可用、哪些参数必须随桌面上下文传入、如何解释状态变化，都需用临时对话核对。尤其是 `SendUserCascadeMessageResponse` 没有业务字段，`client_message_id` 的存在也不能证明服务端会去重。

## 本机现场与仓库可复用部分

| 已核实 | 实施用途 |
| --- | --- |
| 桌面程序在 `%LOCALAPPDATA%\Programs\antigravity`。Electron 的 `app.asar/dist/lsDefaults.js` 指定 standalone Hub，`dist/main.js` 会在端口变化后重新加载本机页面。 | 探测当前桌面进程和监听端点。安装包更新、Hub 重启或 PID 变化后丢弃旧连接。此次固定的 App 版本也可对照官方发布记录。[版本记录](https://antigravity.google/docs/changelog/) |
| `~/.gemini/antigravity/daemon/hub_*.json` 提供 PID、HTTP/HTTPS 端口、版本和 CSRF。本次有 10 份记录，仅一份 PID 对应正在运行的 Language Server。 | 不能按最新文件或端口大小猜 Hub。电脑端核对进程路径、启动身份与实际监听者后，才在回环连接上使用短期凭据。 |
| `~/.gemini/config/projects/*.json` 同时存在空资源和 `projectResources.resources[].folderUri`。`conversation_summaries.db` 有 `conversation_id`、`project_id`、`workspace_uris`、`status` 等列。单会话 `conversations/*.db` 有 `steps` 表、二进制载荷和 WAL。 | 在 Hub 项目信息不足时只读补充展示信息。磁盘状态可能滞后，写入、审批和停止都回到同一个活动 Hub。 |
| 当前 PATH 与 Windows 常规目录未找到独立 CLI `agy`。桌面自带 `agentapi.bat` 调用 `language_server.exe agentapi`，帮助列出新建、发送和取元数据。 | 桌面路线无需另装 CLI。单靠这三个命令仍缺进度订阅、停止和审批。 |
| 现有连接器已有 `machineId`、出站 WSS、手机草稿和 SQLite 操作账本。Codex 另有自己的 IPC、app-server 和审批格式。 | 复用传输、鉴权、去重和现有网页。增加独立的 Antigravity 适配器，保留应用各自的会话与审批语义。[连接器入口](../../src/connector/main.ts) · [账本](../../src/connector/ledger.ts) · [现有能力](../../README.zh-CN.md) |

## 其他接入方式与适用范围

| 路径 | 取舍 |
| --- | --- |
| 桌面本机 Hub + 自有中继 | 最接近“手机操作桌面原任务”。社区已有直接 RPC 和流式实现。2.6.0 示例发送 `{cascadeId}` 订阅，而本机 2.32.1 描述符给出 `protocol_version`、`id`、`subscriber_id`，响应为 `version`、`diff`。实现按本机版本取证，避免照抄旧载荷。[社区后端](https://github.com/figaro-develop/antigravity-remote-backend) · [固定版本订阅源码](https://github.com/figaro-develop/antigravity-remote-backend/blob/fdc990eec61c878f30fe598027e1e4c13cac29b5/src/agentapi/cascadeStream.ts) · [Porta](https://github.com/L1M80/porta) |
| 官方 CLI ACP + 自有中继 | 适合在自己的网页新建本机任务，有公开的列表、回放、流式更新、取消和审批协议。恢复历史与接管桌面正在运行的一轮需分别验证。只有需要连接器自管会话时才增加该执行端；不能在 Hub 发消息超时后改用 ACP 补发。[Google ACP](https://antigravity.google/docs/ide/extensions/acp) · [ACP 会话协议](https://agentclientprotocol.com/protocol/session-setup) |
| 本地界面转发或 CDP | 社区有代理整个 Hub 网页和通过 CDP 驱动桌面的做法。前者要处理桌面专用接口、认证与来源，后者依赖界面结构。现有“预览 localhost”会代理一个完整站点；直接指向 Hub 会扩大可操作面。首版只转发需要的聊天操作。[网页代理实现](https://github.com/TheEmeryverse/antigravity-bridge) · [CDP 移动端](https://github.com/AvenalJ/AntigravityMobile) · [预览适配](../../src/connector/browser-preview.ts) |
| Sidecar、headless、SDK | Sidecar 可投递到桌面对话，公开命令不足以完成本次控制闭环。Headless 适合脚本，流式输入不接受审批控制帧。SDK 适合创建自有 agent。引入任一项都不能直接证明可操控桌面当前待审请求。[Sidecars](https://antigravity.google/docs/sidecars/) · [Headless](https://antigravity.google/docs/cli/headless/) · [SDK](https://antigravity.google/docs/sdk-overview) |
| Google Remote Control / Remote Agents | Remote Control 支持原会话，但要求手机访问 Google 的远控入口；所查官方文档未提供替换为自有中继的配置。Remote Agents 在云端执行。两者均不进入本方案的数据流和交付验收。[Remote Control](https://antigravity.google/docs/remote-control/) · [Remote Agents](https://antigravity.google/docs/remote-agents/) |

**账号适用性。** 本机 Hub 是私有接口。Google 对个人服务的条款第 6 条和 FAQ 限制第三方软件借 Antigravity 登录访问服务；自部署只改变网络路径。本文不把个人订阅列为私有适配器已经支持的认证方式，企业使用按其实际条款判断。若所用账号无法采用私有接口、且必须操作桌面原任务，可经自管远程桌面网关连接同一个 Windows 控制台，由原版 App 处理操作；这种方式传输画面，手机体验和时延需单独衡量。若只需自建页面发起新任务，则可选 ACP 文档列出的 API key 等适用认证。两种情况都能保留自有入口。[服务条款](https://antigravity.google/terms) · [FAQ](https://antigravity.google/docs/faq/) · [ACP 认证](https://antigravity.google/docs/ide/extensions/acp) · [自部署远程桌面网关示例](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)

## 第一版的边界

先交付“找到桌面同一条会话 → 读历史 → 看到新的内容 → 发一条消息 → 在原会话核对一次”。再交付已验证的审批、新建和停止。已有软件的项目发现、草稿恢复、按会话去重和断线重连直接沿用；队列、历史改写、模型切换、语音识别、文件上传、产物卡片、本机网页预览与额度等留到有明确使用需求时。关闭手机不会停止桌面任务，连接器退出也只释放自己建立的订阅。

若版本变化使某项不可用，手机显示具体失效动作及最后一次同步时间。保留原操作回执与会话 ID，用户可以回到电脑核对。桌面模式始终指向用户选中的那个 Hub 和原生对话。

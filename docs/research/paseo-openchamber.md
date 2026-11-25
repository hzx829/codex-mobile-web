# 竞品源码研究：Paseo 与 OpenChamber

日期：2026-11-22。源码浅克隆在 `C:\Users\NINGMEI\Documents\delegate\refs\`（paseo `02e7b10`、paseo-relay `5f4b763`、openchamber v2.8.0 `30c7049`），只读，未安装依赖、未运行。下文 `paseo/…`、`openchamber/…` 指该目录下的路径。**[码]** 为读代码确认，**[文]** 仅据其仓库文档。

许可：Paseo 为 Apache-2.0（移植代码需保留版权和 LICENSE/NOTICE），OpenChamber 为 MIT。Paseo Hub 的服务端闭源，只能参考文档。

## 一句话结论

- Paseo 的工程质量很高，`docs/` 把每个难点的“为什么”都写下来了，最值得抄的是**协议与可靠性的约定、流式渲染、Claude/Codex 接入细节、Noise 端到端加密、额度读取**。
- OpenChamber 值得抄的是**纯 Web 下的做法**：Web Push、事件重放、终端快照重连、Changes Walkthrough、Session Goals。它的多运行端靠 OpenCode，不必跟。
- 我们独有、应该保留的：**自建中继、纯 H5、按人用量和操作记录、接管 Codex 桌面会话、Antigravity 桌面对话、访客模式**。幂等与“待核实”（[ledger.ts](../../src/connector/ledger.ts)）已经和 Paseo 的 CreationService 同一水平。

## 1 中继与端到端加密

**Paseo [码]**
- `Noise_NK_25519_ChaChaPoly_SHA256`，自己实现状态机，原语用 @noble（不用 WebCrypto）：`paseo/packages/relay/src/noise/index.ts`、`cipher-state.ts`、`symmetric-state.ts`、`protected-records.ts`、`secure-channel.ts`。
- 电脑常驻 X25519 密钥（`$PASEO_HOME/daemon-keypair.json`，0600）；手机每次连接临时生成密钥。
- 配对链接 `https://app.paseo.sh/#offer=base64url({serverId, daemonPublicKeyB64, relay})`：公钥在 `#` 片段里，不发给服务器。
- 中继**不鉴权**，只按 `serverId/connectionId` 路由；能看到 IP、时间、大小、serverId。官方中继 paseo-relay（Elixir）可用 Docker 自建。
- 成功走过一次加密握手后，手机固定要求加密，防止被降级（`minimumSecurityMode`，关闭码 4002/4003）。
- 每次 HTTP/WS 校验 Host 白名单与 Origin，防 DNS rebinding（`packages/server/src/server/websocket-server.ts:1007-1023`）。
- `docs/permissions.md` 里的 principal/邀请模型在 daemon 代码中**尚未实现**，目前只有密码（bcrypt），通过后即全部权限。

**OpenChamber [码]**
- WebCrypto：ECDH P-256 + HKDF + AES-GCM，每方向计数器严格连续（`openchamber/packages/ui/src/lib/relay/crypto.ts`）。
- 弱点：HKDF salt 只来自客户端，主机不贡献随机数，录下的会话可能被重放。
- 隧道“只送达不授权”：在隧道内用一次性秘密换 `oc_client_…` token，服务端只存哈希。
- 直连优先：先探测直连地址的 `/health`，核对 serverId 后才发 token，中继延迟启动竞速（`ui/src/apps/mobileConnections.ts:774-850`）。
- 两家都确认：iframe 预览这类浏览器自己加载的地址**无法**端到端加密。

**对我们的结论**
- 页面 JS 由中继下发，所以纯 H5 加端到端加密只能防**被动**方（日志、TLS 终结点、内存快照），防不了主动作恶的中继。要防后者，前端得从独立静态源加载（GitHub Pages + SRI），这是长期方向。
- 最小方案（两端约 600–1000 行加测试）：
  1. 连接器常驻 X25519 密钥；二维码带 `#k=<公钥>&m=<machineId>&t=<token/邀请>`，手机首次固定公钥，变化即告警。**不能**用中继下发的公钥。
  2. 只加密 `payload/result/live`，`type/id/machineId/action` 留明文，中继路由、权限判断、用量统计照旧；[relay.ts](../../src/server/relay.ts) 里读 payload 的几处改读信封字段。
  3. 每个（手机连接，电脑）一条 Noise NK 会话，直接移植 Paseo 的 noise 目录。
  4. 预览隧道保持明文，界面标“中继可见”。
  5. 团队模式不变：actor 仍由中继认定。

## 2 协议、可靠性、流式渲染

**Paseo [码]**
- 断线补齐：每个时间线有随机 `epoch` 和递增 `seq`。重订阅时带游标，daemon 回 `current` 或 `behind` 并分页补齐；epoch 变化或游标过旧就回快照（`packages/server/src/server/agent/agent-timeline-store.ts:101-145`，`docs/timeline-sync.md`）。
- 版本漂移：`hello` 带 `protocolVersion`，daemon 回约 60 个 `features` 布尔开关，每个带 `// COMPAT(name): added in vX, remove after <日期>`（`packages/protocol/src/messages.ts:3965-4060`）。规则：schema 只增 optional；缺能力就提示“请更新主机”，不做降级实现（`docs/protocol-compatibility.md`）。
- 合并窗口 60ms，**前沿+后沿**：空闲后第一个 delta 立即发（`agent-stream-coalescer.ts:115-131`）。
- 节奏化显示：每帧显示 `ceil(积压×帧间隔/150ms)` 个字，store 存全文（`packages/app/src/agent-stream/text-reveal.ts:21-61`）。按文档实测，可见更新间隔 p50 从 317ms 降到 17ms。
- 长时间线只挂载最近 20 条，扩到整轮边界（`history-window.ts`）。
- 通知策略（`agent-attention-policy.ts:42-79`）：180s 内有可见且盯着该 agent 的客户端就不通知；否则对最近活跃客户端做应用内提示；都不在场才推送；error 不推。

**OpenChamber [码]**
- 环形重放缓冲（2048 条 / 8 MiB），重连带 `lastEventId`，回 `replayed` 或 `replayReset`（`web/server/lib/event-stream/global-hub.ts`）。
- Web Push：VAPID + `web-push`，410/404 清订阅；Service Worker 有可见窗口时不弹，用 `tag` 合并，点击先 focus 再 navigate。处理过的通知不单独推“清除”（浏览器会吊销订阅），而是捎带在下一条推送里（`web/src/sw.ts:41-153`）。

**我们的现状（已核对）**
- [main.ts:160-168](../../src/connector/main.ts:160)：只有后沿合并，`LIVE_DELAY=40`，首个 token 固定晚 40ms。
- live 帧没有序号，靠 generation 和文本 offset 对不上来触发重读。
- 中继 `ready` 已有 `features:['live','team']`（[relay.ts:168](../../src/server/relay.ts:168)），是协商雏形；手机与连接器之间没有协商。
- `web/public/sw.js` 没有 push 处理；`web/style.css` 没有 `prefers-color-scheme`（没有深色模式）。

## 3 运行端接入

**Paseo provider 抽象 [码]**：`AgentClient`（创建/恢复/目录/导入/安装检查）+ `AgentSession`（`startTurn`、`steerActiveTurn?`、`subscribe`、`streamHistory`、`setMode/setModel/setThinkingOption?`、`getPendingPermissions`、`respondToPermission`、`interrupt`），能力用标志加“可选方法是否存在”声明（`packages/server/src/server/agent/agent-sdk-types.ts:179-192, 725, 879`）。统一的权限请求是 `{kind: tool|plan|question|mode, actions[]}`，用量是 `{input, cached, output, cost, contextWindowMax/Used}`。同一 agent 的操作串行，空闲 1 小时回收进程。

**Codex**（`providers/codex-app-server-agent.ts`）
- 只走 `codex app-server`，不碰桌面 IPC，也看不到桌面 App 实时运行的状态。
- 按版本号开关功能，配合 `COMPAT` 标注（`:222-258`）。
- 导入：分页 `thread/list`，`sortKey: updated_at`，去重，“游标卡住即停”（`:1067-1110`）。
- 用保留客户端名 `codex_app_server_daemon`，避免在 OpenAI 侧被记成第三方（`:196-203`）。
- 审批只映射到 accept/decline/cancel，**我们的 [approvals.ts](../../src/connector/approvals.ts) 更完整**。

**Claude Code**（`providers/claude/agent.ts`，SDK 0.3.326）
- 关键选项（`:4003-4080`）：`perTaskStopAffordance: true`（中断不杀后台子 agent）、`forwardSubagentText`、`enableFileCheckpointing`、`allowDangerouslySkipPermissions`（保留随时切 bypass 的能力）。
- bypass 模式只自动放行 Claude 自身的检查（`decisionReason` 为 safetyCheck、workingDir 等）；用户的 ask 规则、hook、提问类工具仍交给人（`claude/bypass-approval.ts`）。
- 计划审批按钮：拒绝 / 实施 / 以 auto 或 bypass 模式实施（`:1220-1250`）。
- 上下文用量用流式 `message_start/message_delta` 实时计算，不额外调用（`:2291-2420`）。
- 模型目录：人工清单优先，`supportedModels()` 只作可见性筛选，5 秒超时回退。

**Antigravity**：走 `agy acp` CLI，不读桌面对话。CLI 数据目录是 `~/.gemini/antigravity-cli`，推断与桌面对话不互通。

**ACP**：一套适配器配置即可接 Gemini、Qwen、Kimi、Cursor、Copilot 等；但 Codex 和 Claude 的深度功能 Paseo 自己也没走 ACP。

**OpenChamber**：只是 OpenCode 的界面，Claude 支持来自 OpenCode 内置的 `claude-agent` provider，参考价值低。

## 4 手机端界面

两家都有、我们没有、适合 H5 的：

| 功能 | 对方要点 | 参考 |
| --- | --- | --- |
| 推送通知 | 见 §2 | `openchamber/packages/web/src/sw.ts` |
| Git Changes 面板 | 按文件 diff，暂存/还原/提交/推送，AI 写提交信息 | `openchamber/packages/ui/src/apps/MobileChangesSurface.tsx` |
| 终端 | xterm + 虚拟按键栏（Esc/Tab/粘滞修饰键/方向/粘贴），按宽度排 1–3 行；重连回放 512KB 快照 | `paseo/packages/app/src/terminal/runtime/terminal-virtual-keyboard.ts`，`openchamber/packages/web/server/lib/terminal/DOCUMENTATION.md` |
| Changes Walkthrough | diff 切 hunk 编号 → 模型出结构化 JSON（章节 → 停靠点 → 重要性/观察），机械改动归 routine | `openchamber/packages/web/server/lib/walkthrough/prompt.ts`、`schema.ts` |
| 选中代码评论 | 评论作为上下文进输入框草稿，不直接发送 | `openchamber/packages/ui/src/components/comments/` |
| 已完成 turn 折叠成一行摘要 | 展开时被点按钮保持原屏幕位置 | `paseo/docs/agent-stream-disclosure.md` |
| 对话内搜索、提问导航 | | `paseo/packages/app/src/agent-stream/chat-find/`、`chat-outline/` |
| 额度卡片 | ≥80% 红、≥50% 黄，重置时间，已用/剩余切换 | `openchamber/packages/ui/src/components/usage/UsageProviderCards.tsx` |

可抄的细节：
- 窄屏菜单统一用底部 sheet，子菜单原地翻页（`paseo/docs/menus.md`）。
- 只在屏幕边缘 32px 响应滑动（`paseo/docs/mobile-panels.md`）。
- 会话行左滑出操作（`openchamber/packages/ui/src/apps/MobileSessionSwipe.tsx`）。
- 首帧前同步设好主题，避免白闪（`openchamber/packages/web/mobile.html:8-30`）。
- history 里只压一个“返回守卫”，统一关闭最上层弹层。

不照搬：Reanimated 手势、原生终端渲染、expo-notifications、Capacitor 扫码、桌面小组件。本地语音识别（Paseo 在电脑端用 sherpa-onnx）可做，但要下几百 MB 模型，暂不优先。

## 5 团队、用量、编排

**Paseo Hub [文]**（服务端闭源）
- 连上 Hub 只给身份和在线状态，**执行权 `hub.execute` 必须在电脑本地授予**，Hub 不能自己扩权；4403 即吊销并删本地凭证（daemon 侧 `packages/server/src/server/hub/relationship-controller.ts` [码]）。
- 存的是展开后的语义权限，不存角色名（`authorization/operation-permissions.ts` [码]）。
- 触发器（GitHub/Slack/Linear/webhook/定时）：外部内容用 `<user-prompt>` 包起来、声明为数据；`from_users` 白名单；用 executionId 幂等；Activity 页列出“未执行”的事件和原因。
- **没有任何 token/费用/按人统计**——这一块我们更强。

**额度读取 [码]**
- Claude：读 `~/.claude/.credentials.json`，调 `api.anthropic.com/api/oauth/usage`，得到 `five_hour/seven_day/seven_day_opus` 窗口（`paseo/plugins/claude-usage-source/server/usage.ts:352,544`）。
- Codex：读 `~/.codex/auth.json`，调 `chatgpt.com/backend-api/wham/usage`（`paseo/plugins/codex-usage-source/server/usage.ts:90,212`）。
- 统一格式 `{usedPct, resetsAt, durationSeconds, runsOutAt}`；预计用完时间按窗口内平均速度推算（`paseo/packages/app/src/usage/pace.ts`）。
- 两个接口都无公开文档，需要容错；凭证不离开电脑。

**编排 [码]**
- Paseo worktree：路径 `$PASEO_HOME/worktrees/<仓库hash>/<slug>`；第一轮后由 agent 起名再改分支；`paseo.json` 里配 setup/teardown；归档最后一个引用时才删（`packages/server/src/utils/worktree.ts`）。
- Paseo 定时任务：1s tick，抢占本次运行并推进下次时间，错过不补跑，上次没完则跳过（`schedule/service.ts:630-887`）。
- OpenChamber Session Goals：会话安静 3s 后用小模型审核 `all_done/remaining/needs_user`，未完成就续跑；最多 20 轮，可设 token 预算，出错即停（`openchamber/packages/web/server/lib/session-goal/`）。
- OpenChamber 定时任务：全局 4 个、单项目 2 个并发，单次最长 30 分钟，可每次用新 worktree。
- Multi-run：每个模型一个 worktree，可 Keep（未保留的先快照到 ref）或 Fusion（裁判会话合并）。

## 6 建议路线（价值 / 成本排序）

**第一批：低成本、马上见效**
1. 流式文本节奏化显示：移植 `text-reveal.ts` 的纯函数；`scheduleLive` 改前沿+后沿。
2. Claude 接入细节：bypass 按 `decisionReason` 白名单；计划审批加“以某模式实施”；开启 `perTaskStopAffordance`、`forwardSubagentText`（需在 0.3.328 上实测）。
3. 深色模式：颜色变量 + `prefers-color-scheme` + 首帧前设主题。
4. 正式的能力协商：连接器在 hello 报 `protocolVersion` 和 `features`，中继透传，手机只在一处检测，缺能力提示“请更新电脑端”，兼容代码打 `COMPAT(名, 版本, 删除日期)` 标记。Codex IPC 和 app-server 同样按版本号开关功能。

> 第一批进展（2026-11-22，未提交）：1、3、4 已做；2 只做了“以某模式实施”。没做的三项及原因：
> - bypass 按 `decisionReason` 自动放行：我们本来就不在连接器上替用户放行，Claude Code 在 bypass 下仍要问的（安全检查、工作目录外）照旧交给人，比 Paseo 更保守，不改。
> - `perTaskStopAffordance`：声明后停止只结束当前轮，后台任务要靠逐个停止。手机上还没有“停止后台任务”的入口，开了会让后台任务停不下来。等做了这个入口再开。
> - `forwardSubagentText`：会把子 agent 的文字作为普通消息转出来，我们还没有嵌套显示，开了只会把子任务内容混进主对话。
> - Codex 按版本号开关功能和 `COMPAT` 标注只定了规则（`src/shared/protocol.ts`），没有回头给现有兼容代码补标注。

**第二批：中等成本、价值高**
5. Web Push 加在场判定：中继存 VAPID 订阅，手机上报可见性和当前会话；完成、审批、提问时推送，tag 合并，点击跳到会话。iOS 需添加到主屏。
6. 订阅额度卡片：Codex 已有 `accountLimits`，补上 Claude oauth/usage、重置倒计时、预计用完时间；团队页按电脑展示全员共用的额度。
7. live 帧加 `seq` 和重订阅游标，跳号即补，省掉一次全量重读。
8. 团队执行权在电脑本地确认：电脑访问分“只看 / 可操作 / 可自动化”，连接器本地开关，中继不能单方面扩权；未执行的操作也写进记录并注明原因。

**第三批：较大功能**
9. 端到端加密（§1 最小方案），先改写 PRIVACY 里的威胁模型说明。
10. Git Changes 面板 → Walkthrough 导读 → 终端。
11. 连接器端定时任务 → 目标循环（先用检查命令的退出码，再可选模型审核）→ worktree 会话 → Multi-run（只做 Keep）。
12. 精简 provider 接口重构；ACP 作为第四路运行端，用来接 Gemini、Qwen 等。

**不建议跟进**
- zod-aot 生成校验器：那是为 Hermes 性能做的，手机浏览器不需要。
- 在内存里维护全量时间线投影：我们读运行端原生存储已经够用。
- OpenChamber 全部依赖 OpenCode 的路线。
- 用 ACP 接 Antigravity 替代桌面对话：会丢掉桌面对话。

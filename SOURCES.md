# 来源与版本基线

2026-11-13 桌面侧栏发现：核对本机桌面 `26.1106.6628.0` 的 `app.asar → .vite/build/early-bootstrap.js` 与 `early-bootstrap-620-1eb87a1b3aa240b6.js`。IPC 没有新建会话广播；`thread-unarchived` v1 的 `handleThreadUnarchived` 会读取已保存的摘要并加入最近会话，不调用 `thread/resume`。连接器在确认新轮次后、空闲 writer 释放后发送此发现通知，后一次同步最终标题和分叉；未保存的空会话不通知。桌面断开不改变发送回执。隔离原生夹具验证活动 writer 的摘要可由另一 app-server 读取，接管仍受原生锁保护；侧栏显示由人类验收。

2026-10-30 桌面发送超时：核对本机桌面 `26.1021.3705.0` 的 `app.asar → .vite/build/src-Dl21kCYQ.js`，转发层 `UM` 使用 5 秒超时，超时不会取消已经交给桌面的启动请求。10 月 28 日的连接器失败回执与桌面 rollout 的 `user_message.client_id` 完全一致，确认存在“手机报失败、桌面已执行”的情况。连接器现在将此类超时记为结果待核实，并短暂等待实时快照；仅在原消息 ID 与真实轮次 ID 同时匹配时确认成功，不重新发送。回归覆盖延迟快照、已完成轮次、其他消息干扰、明确拒绝及回执重放；手机交互仍由人类验收。

2026-10-18 语音输入：本机 CLI `0.162.0-alpha.17.2` 生成协议仍提供 `getAuthStatus(includeToken, refreshToken)`，没有独立听写 RPC。本地桌面研究副本的 `QTs` 以 multipart `file` 调用 `/transcribe`，默认 WebM；Remodex 固定副本的 `voice-handler.js` 提供 ChatGPT `/backend-api/transcribe`、登录刷新及上传 User-Agent 的参考。实现独立写在 `src/connector/voice.ts`，仅返回文字，不转发凭据或原始服务错误。此路径是桌面私有服务；[公开 app-server 文档](https://learn.chatgpt.com/docs/app-server)未承诺转写接口，[Sign in with ChatGPT 的公开 API 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)也不包含转写支持。浏览器录音按 [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)选择支持的格式。自动夹具覆盖音频转发、登录刷新、取消和迟到结果；真实账号及手机效果待人工验收。

2026-10-17 历史翻页：对照本地桌面研究副本的 `handleThreadStreamFollowingChanged`，订阅本身会发布快照，首次打开不再调用 `thread-follower-load-complete-history`。手机每次读取 20 轮，向上滚动后按轮次锚点请求前一页；分页历史使用本地索引或运行端游标。旧版运行端只提供整段 `thread/read` 时仍需兼容读取，但连接器只向手机返回所请求的一页。自动回归覆盖跨 100 轮翻页、实时更新合并、局部桌面快照及旧轮次编辑/分叉；滚动位置与触摸体验由人类实测。

2026-10-15 对照本机桌面 26.1007.9446.0 的 `app.asar`：`thread-follower-steer-turn` 的处理函数直接读取 `restoreMessage.cwd` 与 `restoreMessage.context`，旧连接器遗漏该对象；`thread-follower-update-thread-settings` 的 IPC 版本为 2。已补齐追加消息上下文和版本，并识别桌面的 `steeringUserMessage`。运行端模型目录提供极速档位，`turn/start.serviceTier` 控制开启或显式清除。CLI 0.162.0-alpha.17.2 的隔离 Responses 夹具验证极速参数到达 HTTP、关闭恢复普通速度，以及 Web 追加和排队在当前轮结束后只发送一次；真实账号调用和界面操作仍由人类验收。

核对日期：2026-09-06。项目代码独立实现；未整体 fork 候选项目，也没有把它们的账号、配对、E2EE 或浏览器控制组件带入本项目。

| 来源 | 固定版本 | 本项目用途 |
| --- | --- | --- |
| [Codex Anywhere](https://github.com/gaotong132/codex-anywhere) | `ecf13dd15f1519cbd41daf20165021137cc361a0`，MIT | 检查 Web、中继和桌面工具调用方式；原始许可证已读取 |
| [Remodex](https://github.com/Emanuele-web04/remodex) | `a08a6dd4bbe324fd96be1b00de189cc5d771367f`，Apache-2.0 | 研究桌面 IPC 帧、订阅和控制方法；原始许可证已读取 |
| 本机 Codex CLI | `0.146.0`，Windows 原生 npm 安装 | 生成协议类型，实际 app-server 配置、线程、输入、补充和中断测试 |
| 本机官方桌面 | `26.901.6511.0` | 对照已安装程序的 IPC 方法版本；只读握手、活动会话快照及 canonical 历史结构验证 |
| Node | `24.11.1`，Windows x64 | 本机开发与便携包运行时；便携包附同版本 Node 许可证 |

Codex Anywhere 的连接、设备身份、浏览器控制与主要执行路径耦合较深；桌面调用以 `codex-browser-use` 工具为主，不能直接补齐本项目要求的原生审批闭环。因此按原设计的回退条件选择小型 TypeScript 项目，不维护第二套 fork。

Remodex 的协议思路可参考，但其被检查版本仍主要从 `conversationState.turns` 读取历史。本机桌面已经使用 `turnHistory.history.entitiesByKey` 和有序 islands，直接复用会遗漏当前会话。权限审批方法也以本机实际接口为准。桌面适配集中在 `src/connector/desktop.ts`、`normalize.ts` 与 `approvals.ts`；私有接口升级需重新检查，不宣称跨版本兼容。

官方接口与模型配置依据：

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)：公开运行协议。
- [Codex 高级配置](https://learn.chatgpt.com/docs/config-file/config-advanced)：自定义 provider 与 profiles。
- [DeepSeek Codex 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)：已有配置用户的接入方向。
- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)：协议兼容范围；本项目不代理或转换模型协议。
- [Node 24.11.1 许可证](https://github.com/nodejs/node/blob/v24.11.1/LICENSE)：便携包运行时分发说明。

`.research/` 保存本地研究副本与生成协议，不参与构建或分发。构建依赖由 `package-lock.json` 固定，便携包附依赖许可证。真实桌面写操作与 DeepSeek 实际服务仍待人工验证；第三方协议夹具通过不等于真实服务通过。

2026-10-19 核对本机桌面 `26.1013.4894.0` 的 `app/resources/app.asar → webview/assets/zh-CN-7ba80cbb133d.js`：模型显示 `GPT-6 Astra`，思考程度使用 `轻度 / 中 / 高 / 极高 / Max / Ultra`。运行端 `model/list` 实查返回 `GPT-6-Astra` 及 `priority` 极速档位；只格式化已知模型系列的显示名称，不修改发送 ID 或推测支持能力。CLI `0.162.0-alpha.17.2` 的隔离双 app-server 夹具验证活动 writer 互斥、`thread/unsubscribe` 后等待 `thread/closed` 释放、只读不重占及按需恢复；连接器子进程设置 `thread_unload_delay_secs=0`，不改用户全局配置。

2026-10-04 核对桌面 26.930.3748.0 的安装包与附带 CLI 0.160.0 的生成协议，并运行隔离 Responses 夹具：模型目录与推理请求使用同一执行端；编辑重发的模型、推理档位到达 HTTP 请求。新版 `thread/revert` 仅支持分页历史，旧历史通过单独的 0.146.0 进程回退后由新版重新接入并发送；夹具验证原会话 ID、早期轮次编辑、分叉保留、补充与中断。桌面编辑先通过 owner 的 `thread-follower-update-thread-settings` 确认设置，再调用编辑接口；真实 ChatGPT 模型调用与页面操作由人类复验。

本次更新回归的记录核对：2026-09-26 聊天 `01a0d77f-6b60-7d52-9b22-40782c707b99` 实现启动时选择最新版，并明确需空闲后重启；未实现常驻适配触发器。2026-10-03 聊天 `01a0f20b-e6e6-7bc1-8dd0-d0cdc97ea20a` 为旧历史编辑把执行端重新固定到 0.146.0，其部署回执只验证在线和会话恢复。之后目录与执行端分离，产生本次 400；编辑路径另外漏传所选参数。当前 `check` 包含原生夹具，并从 Web 的发送/编辑动作检查最终 HTTP 参数；`check:deployed` 读取实际执行端握手版本，拒绝版本偏差或缺失证据。夹具、部署版本检查、人工真实账号/页面验收分别记录，不能互相替代。

2026-10-05 补上更新检测与聊天定时适配：检测 WindowsApps 中桌面安装包及 `app.asar` 内容、附带 CLI 路径/版本/内容和当前适配代码。CLI 仍为 0.160.0，但桌面已从 26.930.3748.0 更新至 26.930.4958.0，此变化不能按 CLI 版本相同跳过。检查失败不推进通过基线，部署构建通过握手中的启动时文件摘要核对；运行端切换在连接器内部阻止新操作、核查所有已接入会话并恢复，失败尝试回退。原生夹具验证重新接入后保留原会话及分叉历史，未使用真实账号或浏览器页面。

同日按用户要求停用聊天定时自动化，改为桌面脚本按需检查与切换；保留原生检查、部署身份核对及空闲保护。

2026-09-27 核对本地生成的 `ThreadTokenUsage`、`ThreadTokenUsageUpdatedNotification`、`GetAccountRateLimitsResponse`、`RateLimitWindow`，以及桌面研究副本中的 `latestTokenUsageInfo` 映射。上下文取最近一次用量；额度优先 `rateLimitsByLimitId`，`resetsAt` 为 Unix 秒。本机 `account/rateLimits/read` 只读调用实际返回 7 天额度窗口；未请求额度重置或购买操作。

额外兼容边界：CLI 0.146.0 的 `--profile` 仅支持其列出的运行命令，不支持 app-server，旧式 `-c profile=...` 同样拒绝。第一版明确拒绝连接器命名 profile 配置；不自行合并 TOML 或降级到不同模型。

2026-09-17 补充核对官方桌面 `26.908.9136.0`：IPC 方法版本仍与上述基线一致，但文本输入必须显式带 `text_elements: []`。当日手机继续桌面会话时，`turn/start` 已成功，桌面保留的原始 `params.input` 缺少该字段，渲染触发 `Cannot read properties of undefined (reading 'length')`；app-server 返回的用户消息虽已补默认值，并未修复桌面的原始输入。连接器已统一补齐新一轮与运行中补充的文本字段；自动回归覆盖两条发送路径，修复后的真实页面由人类复验。

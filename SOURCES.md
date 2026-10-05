# 来源与版本基线

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

2026-10-04 核对桌面 26.930.3748.0 的安装包与附带 CLI 0.160.0 的生成协议，并运行隔离 Responses 夹具：模型目录与推理请求使用同一执行端；编辑重发的模型、推理档位到达 HTTP 请求。新版 `thread/revert` 仅支持分页历史，旧历史通过单独的 0.146.0 进程回退后由新版重新接入并发送；夹具验证原会话 ID、早期轮次编辑、分叉保留、补充与中断。桌面编辑先通过 owner 的 `thread-follower-update-thread-settings` 确认设置，再调用编辑接口；真实 ChatGPT 模型调用与页面操作由人类复验。

本次更新回归的记录核对：2026-09-26 聊天 `01a0d77f-6b60-7d52-9b22-40782c707b99` 实现启动时选择最新版，并明确需空闲后重启；未实现常驻适配触发器。2026-10-03 聊天 `01a0f20b-e6e6-7bc1-8dd0-d0cdc97ea20a` 为旧历史编辑把执行端重新固定到 0.146.0，其部署回执只验证在线和会话恢复。之后目录与执行端分离，产生本次 400；编辑路径另外漏传所选参数。当前 `check` 包含原生夹具，并从 Web 的发送/编辑动作检查最终 HTTP 参数；`check:deployed` 读取实际执行端握手版本，拒绝版本偏差或缺失证据。夹具、部署版本检查、人工真实账号/页面验收分别记录，不能互相替代。

2026-10-05 补上更新检测与聊天定时适配：检测 WindowsApps 中桌面安装包及 `app.asar` 内容、附带 CLI 路径/版本/内容和当前适配代码。CLI 仍为 0.160.0，但桌面已从 26.930.3748.0 更新至 26.930.4958.0，此变化不能按 CLI 版本相同跳过。检查失败不推进通过基线，部署构建通过握手中的启动时文件摘要核对；运行端切换在连接器内部阻止新操作、核查所有已接入会话并恢复，失败尝试回退。原生夹具验证重新接入后保留原会话及分叉历史，未使用真实账号或浏览器页面。

同日按用户要求停用聊天定时自动化，改为桌面脚本按需检查与切换；保留原生检查、部署身份核对及空闲保护。

2026-09-27 核对本地生成的 `ThreadTokenUsage`、`ThreadTokenUsageUpdatedNotification`、`GetAccountRateLimitsResponse`、`RateLimitWindow`，以及桌面研究副本中的 `latestTokenUsageInfo` 映射。上下文取最近一次用量；额度优先 `rateLimitsByLimitId`，`resetsAt` 为 Unix 秒。本机 `account/rateLimits/read` 只读调用实际返回 7 天额度窗口；未请求额度重置或购买操作。

额外兼容边界：CLI 0.146.0 的 `--profile` 仅支持其列出的运行命令，不支持 app-server，旧式 `-c profile=...` 同样拒绝。第一版明确拒绝连接器命名 profile 配置；不自行合并 TOML 或降级到不同模型。

2026-09-17 补充核对官方桌面 `26.908.9136.0`：IPC 方法版本仍与上述基线一致，但文本输入必须显式带 `text_elements: []`。当日手机继续桌面会话时，`turn/start` 已成功，桌面保留的原始 `params.input` 缺少该字段，渲染触发 `Cannot read properties of undefined (reading 'length')`；app-server 返回的用户消息虽已补默认值，并未修复桌面的原始输入。连接器已统一补齐新一轮与运行中补充的文本字段；自动回归覆盖两条发送路径，修复后的真实页面由人类复验。

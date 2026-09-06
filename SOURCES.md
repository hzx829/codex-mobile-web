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

额外兼容边界：CLI 0.146.0 的 `--profile` 仅支持其列出的运行命令，不支持 app-server，旧式 `-c profile=...` 同样拒绝。第一版明确拒绝连接器命名 profile 配置；不自行合并 TOML 或降级到不同模型。

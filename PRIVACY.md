# Privacy & trust boundaries / 隐私与信任边界

[English](#english) | [简体中文](#简体中文) · [README](README.md) · [中文首页](README.zh-CN.md)

<a id="english"></a>

## English

Reviewed against version 0.1.3 on 2026-09-17. This describes the bridge implementation, not the privacy practices of your model provider, hosting provider, browser, or configured tools. It is not an independent security audit.

### Who you trust

This is a single-user remote-control application. Trust the devices holding the shared Token, the OS account running the connector, and the operators of your relay and HTTPS proxy.

There is **no end-to-end encryption**. The phone and connector authenticate with the same Token. The relay parses messages and serves the browser application; its operator can read or alter forwarded content and the delivered page. HTTPS protects traffic up to the TLS endpoint, not from its operator. A third-party TLS-terminating proxy adds another trusted operator.

The bridge has no required developer-operated backend or built-in analytics/telemetry collection. Software dependencies and your chosen infrastructure remain part of the trust boundary.

### Network data

| Connection | Data |
| --- | --- |
| Phone ↔ relay ↔ connector | Token during WebSocket authentication; computer names/IDs, project paths, conversation metadata and displayed history; instructions, image attachments, task output, approvals/questions and replies, requested file previews and diffs; online status and change notifications |
| Computer → configured providers/tools | Native Codex model requests and network activity performed by tasks/tools; the relay is not a model gateway |
| Installation/build | npm dependencies, container images, and the Node license during Windows packaging if not cached; certificate setup contacts the configured certificate authority |

The connector returns selected model/provider metadata for display, not the full Codex configuration or a dedicated copy of API keys. But credentials typed into a conversation, emitted by tools, or read through file preview travel as ordinary content. There is no automatic secret-redaction guarantee. Existing Codex settings continue to determine model/tool behavior.

The web app connects to its own site's WebSocket endpoint. Markdown images become placeholders rather than automatic external image requests; clicking an external link opens that site. Voice input uses the system keyboard, whose privacy behavior depends on its provider. This app does not record or upload microphone audio.

### Storage and retention

| Location | Stored data | Retention |
| --- | --- | --- |
| Browser `localStorage` | Token (`connection`), text drafts (`draft:*`), pending operations (`operation:*`) that may include submitted text | No time-based expiry. Success clears related pending data/drafts where applicable. Disconnect clears the Token, not all drafts or pending records |
| Browser memory | Loaded conversations, file previews, image attachments and UI state | No app-managed persistent conversation cache; reload requires reselecting attachments. This does not guarantee secure erasure from browser/OS memory |
| Connector `.local/config.json` | Relay address, Token, machine identity, selected local paths | Until changed/deleted; the app does not encrypt this file |
| Connector `.local/connect.html`, `connect-qr.png` | Connection page and QR code containing the Token | Until regenerated/deleted; protect like the Token itself |
| Connector `.local/operations.sqlite` | Operation IDs, payload hashes, states, result/error receipts, managed-session IDs | Operation rows older than seven days are removed when the ledger opens, not by a continuous timer. Managed-session IDs do not expire automatically. Receipts may contain sensitive error details; this is not a full transcript or an audit log |
| Runtime logs | Startup, connection and error diagnostics | Windows `.local/*.log` has no app-defined rotation. Supplied Compose rotates each service's local logs at 5 MB × 3 files. Other deployments follow their own settings |
| Relay process | Peers, routes and forwarded content in memory | No application database or deliberate disk storage of conversation/file payloads. This excludes host swap, crash dumps, infrastructure logging and operator modifications |
| Relay deployment | Token in environment/configuration; Caddy certificate/configuration volumes when used | Until changed/removed by the operator |
| Native Codex and workspace | History, credentials, task results and project files | Governed by Codex and your retention/backups; uninstalling the bridge does not delete them |

Default relay/connector status logging does not deliberately record message bodies or Tokens; the supplied Caddyfile does not enable access logging. Not all error messages are guaranteed to be sanitized. Custom proxies, cloud platforms and debugging settings may record metadata or additional content.

### Access granted by the Token

The Token authenticates both phone and connector roles. There are no separate read-only credentials, device approvals, project allowlists, or per-device revocation. Authenticated clients can discover connected machines and issue supported requests. Treat the Token as a remote-control credential.

**File preview is not confined to a project and does not pass through Codex's sandbox or approval flow.** It reads as the connector's OS user, accepts absolute paths and cross-directory references, and can expose readable text/image files, including sensitive files, up to 2 MiB. Format and size limits are not an authorization boundary. Use a dedicated OS account if you need to restrict readable files.

Task execution follows the applicable Codex session's permissions. The bridge adds no extra confirmation layer, and a Token holder can answer supported native approvals. The web page, static assets and `/health` are public; machine/conversation requests require WebSocket authentication. Use an unguessable random Token and HTTPS for public access. The app also accepts plain HTTP/WS and does not enforce HTTPS for you.

### Connect, revoke and remove

- **Connect:** the QR link contains the Token in its URL fragment. The page saves it, removes the fragment from the address bar, then sends it in a WebSocket authentication message. The fragment avoids the normal HTTP request URL, but the QR image, original link, extensions and local connection files can still expose it.
- **Disconnect one browser:** “断开连接” closes the socket and clears its saved Token. It does not revoke the server Token or erase all drafts/pending text. Clear the site's browser data to remove those, and close its tabs to discard active views.
- **Revoke a lost device or leaked Token:** generate a new Token, update relay configuration, and restart/recreate the relay to close existing connections. With supplied Compose, apply the changed `.env` using `up -d`, not just `restart`. Update trusted connectors using `configure.cmd` and reconnect trusted browsers. Deleting a Token on one phone does not revoke other copies. Finish connector-managed tasks before restarting their connector.
- **Remove local bridge data:** stop this installation and disable optional startup, then remove its `.local/` directory and unwanted copies/backups of configuration and QR files. Keep any records still needed to resolve uncertain operations. Native Codex history and project files are separate.
- **Remove server data:** stop the relay, remove its credential configuration and unwanted logs/backups, and remove Caddy volumes if retiring the deployment. Hosting storage retention also applies. File deletion is not a guarantee of secure erasure from disks or backups.

Do not post Tokens, QR codes, private keys, raw `.local` directories or unreviewed logs in public issues/screenshots. A version, sanitized error and minimal reproduction are usually sufficient.

### Verify in source

[Relay](src/server/relay.ts) · [Browser storage/disconnect](web/main.tsx) · [Browser transport](web/client.ts) · [File access](src/connector/project.ts) · [Operation storage](src/connector/ledger.ts) · [Model process](src/connector/app-server.ts) · [Markdown](web/content.tsx) · [Connection page](scripts/connection-page.ts) · [Setup files](scripts/setup.ts) · [Container logs](compose.yaml) · [HTTPS proxy](Caddyfile)

<a id="简体中文"></a>

## 简体中文

核对日期：2026-09-17，依据 0.1.3 实现。本说明描述中继与连接器，不代替模型服务商、云主机、浏览器或已配置工具的隐私说明，也不是独立安全审计。

### 需要信任谁

这是单用户远程控制程序。需要信任持有共享 Token 的设备、运行连接器的系统账户，以及中继和 HTTPS 代理的管理者。

目前**没有端到端加密**。手机与电脑用同一个 Token 认证。中继会解析消息并提供手机网页，其管理者能够读取或改变转发内容和网页。HTTPS 保护到 TLS 终点之间的传输，不能防止终点管理者读取内容。使用第三方服务终止 TLS 时，也需要信任该服务。

项目不依赖开发者运营的后台，也没有内置统计或遥测收集。软件依赖和自选基础设施仍属于信任边界。

### 网络数据

| 连接 | 内容 |
| --- | --- |
| 手机 ↔ 中继 ↔ 连接器 | WebSocket 认证时的 Token；电脑名称/标识、项目路径、会话信息和展示的历史；指令、图片附件、任务输出、审批/问题及回应、主动请求的文件预览和差异；在线状态和变更通知 |
| 电脑 → 配置的模型服务/工具 | Codex 原生模型请求及任务/工具的网络活动；本中继不充当模型网关 |
| 安装/构建 | npm 依赖、容器镜像；Windows 打包时未缓存的 Node 许可证；证书配置还会联系配置的证书签发机构 |

连接器只返回展示所需的模型/provider 等信息，不发送完整 Codex 配置，也不专门上传 API Key。但输入会话、出现在工具输出、或经文件预览读取的凭据仍会随普通内容转发。程序不保证自动识别并去除敏感信息；模型和工具行为继续由原有 Codex 设置决定。

网页连接本站的 WebSocket。Markdown 图片显示为占位文本，不主动请求外部图片；点击外部链接会打开对应网站。语音输入使用系统键盘，其隐私行为取决于键盘服务商；本项目不录制或上传麦克风音频。

### 保存位置与保留时间

| 位置 | 保存内容 | 保留方式 |
| --- | --- | --- |
| 浏览器 `localStorage` | Token（`connection`）、文字草稿（`draft:*`）、可能含已提交文字的待核实记录（`operation:*`） | 无定时过期；成功后按情况清理对应记录/草稿。“断开连接”清除 Token，不清除全部草稿和待核实记录 |
| 浏览器内存 | 已加载会话、文件预览、图片附件与界面状态 | 应用没有持久化会话缓存，刷新后图片需重选；不保证浏览器/系统内存被安全擦除 |
| 连接器 `.local/config.json` | 中继地址、Token、电脑标识和选定的本地路径 | 修改/删除前保留，应用不加密此文件 |
| 连接器 `.local/connect.html`、`connect-qr.png` | 含 Token 的连接页和二维码 | 重新生成/删除前保留，按 Token 同等保管 |
| 连接器 `.local/operations.sqlite` | 操作 ID、载荷摘要、状态、结果/错误回执、托管会话 ID | 打开数据库时删除超过七天的操作记录，不做持续定时清理；托管会话 ID 无自动过期。回执可能含敏感错误详情，不是完整聊天库或审计日志 |
| 运行日志 | 启动、连接和错误诊断 | Windows `.local/*.log` 无应用层轮换；附带 Compose 对各服务按 5 MB × 3 文件轮换；其他部署依自身设置 |
| 中继进程 | 内存中的连接、路由和转发内容 | 无应用数据库，不主动把聊天/文件正文持久化到磁盘；不涵盖系统交换空间、崩溃转储、基础设施日志或管理者修改 |
| 中继部署 | 环境/配置中的 Token；使用 Caddy 时的证书和配置卷 | 管理者修改/删除前保留 |
| 原生 Codex 与工作区 | 历史、认证材料、任务结果、项目文件 | 由 Codex 和使用者的保留/备份设置管理；卸载连接器不会删除这些数据 |

默认中继/连接器状态日志不主动记录消息正文或 Token，附带 Caddyfile 未启用访问日志。但不能保证所有错误信息都已脱敏；自定义代理、云平台或调试设置可能另行记录连接信息或内容。

### Token 的权限

Token 同时认证手机和连接器，没有独立只读凭据、设备批准、项目白名单或逐设备撤销。认证后的客户端可以发现已连接电脑并发送受支持的请求。应把它视为远程控制凭据。

**文件预览不限制在项目目录，也不经过 Codex 的沙箱或审批流程。** 它按连接器的系统账户读取，支持绝对路径和跨目录引用，可返回该账户能读取的文本/图片文件，包括敏感文件，上限为 2 MiB。格式和大小限制不构成权限隔离。如需限制可读范围，应使用专门的系统账户运行连接器。

任务执行沿用对应 Codex 会话的权限。连接器不增加额外确认层，Token 持有者也能回应支持的原生审批。网页、静态资源与 `/health` 公开可访问，电脑/会话请求需先完成 WebSocket 认证。公网使用需要难以猜测的随机 Token 和 HTTPS；程序也接受 HTTP/WS，不会替使用者强制 HTTPS。

### 连接、撤销与清理

- **连接：** 二维码链接把 Token 放在 URL fragment 中。网页保存 Token、清除地址栏 fragment，再通过 WebSocket 认证消息发送。fragment 不进入普通 HTTP 请求 URL，但二维码、原始链接、浏览器扩展和本地连接文件仍可能暴露它。
- **手机断开：** “断开连接”关闭连接并清除保存的 Token，不让服务器 Token 失效，也不删除全部草稿和待核实文字。要清理这些数据，应清除浏览器中该站点的数据，并关闭相关页面。
- **设备丢失或 Token 泄露：** 生成新 Token，更新中继配置，并重启/重建中继以断开原连接。附带 Compose 修改 `.env` 后用 `up -d` 应用，不能只用 `restart`。随后用 `configure.cmd` 更新可信电脑，重新连接可信手机。只在一部手机删除 Token 不能撤销其他副本；重启连接器前先完成它管理的任务。
- **清理电脑桥接数据：** 停止本安装、取消可选自启后，删除其 `.local/` 及不再需要的配置/二维码副本和备份。仍需核实操作结果时先保留相关记录。原生 Codex 历史和项目文件独立保存。
- **清理服务器数据：** 停止中继，移除凭据配置和不再需要的日志/备份；不再使用整个部署时再移除 Caddy 卷。云主机另有保留规则；文件删除不等于安全擦除磁盘或备份。

公开反馈和截图不要包含 Token、二维码、私钥、原始 `.local` 目录或未经检查的日志。通常提供版本、脱敏错误和最少复现步骤即可。

### 对照源码

[中继](src/server/relay.ts) · [浏览器保存与断开](web/main.tsx) · [浏览器连接](web/client.ts) · [文件读取](src/connector/project.ts) · [操作数据库](src/connector/ledger.ts) · [模型进程](src/connector/app-server.ts) · [Markdown](web/content.tsx) · [连接页面](scripts/connection-page.ts) · [配置文件](scripts/setup.ts) · [容器日志](compose.yaml) · [HTTPS 代理](Caddyfile)

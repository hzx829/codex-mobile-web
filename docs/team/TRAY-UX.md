# Windows 托盘的团队模式适配与 UX 设计

日期：2026-11-25。配套主设计见 [DESIGN.md](DESIGN.md)，使用说明见 [GUIDE.md](GUIDE.md)。

## 1 背景与问题

在个人模式下，Windows 托盘程序（`Codex Mobile Web.exe`、`desktop/`、`scripts/setup-status.ts`、`scripts/bridge-client.ts`、`scripts/connection-page.ts`）围绕“单 Token + 手机扫码配对”设计。启用团队模式后，出现三类直接影响可用性的问题：

1. **健康检查假红（误报 Token 不匹配）**：`setup-status.ts` 与 `connect.html` 使用 `.local/config.json` 中的连接器 Token 伪装成 `role: 'phone'` 连接中继。启用团队模式后，共享 Token 与电脑专用 Token（`cnt_…`）均不允许手机登录，中继直接返回 `4401`，导致托盘明明在线却显示红灯“Token 不匹配”，Codex / Claude Code / Antigravity 状态全部丢失。
2. **本机控制链路断裂**：托盘的“登录 claude.ai…”（`--claude-signin`）和自动部署检查通过 `bridge-client.ts` 走同一条 `role: 'phone'` 链路，团队模式下全部失效。
3. **二维码与连接链接失效且存在凭证暴露风险**：托盘主界面与右键菜单拼接的 `https://中继/#token=<连接器Token>` 既无法登录团队网页，还会把电脑连接器凭证（尤其是管理员颁发的 `cnt_…` 专用 Token）放进二维码和剪贴板。

## 2 产品定位与安全边界

- **定位转变**：个人模式下托盘是“手机扫码配对入口”；团队模式下电脑是团队的运行节点，成员登录依赖管理员在网页端颁发的邀请链接，托盘的核心职责转为 **“节点连接状态 + 协作防打断 + 本机运维”**。
- **边界保持不变**：托盘与连接器始终**不接触、不保存任何成员个人设备令牌（`dev_…`）**，也不在托盘里做成员管理、发邀请或查看全员用量，延续 [DESIGN.md §3](DESIGN.md#3-总体结构) 的安全边界。

## 3 分级功能设计（P0 / P1 / P2）

### P0：可用性与凭证安全（必选）

1. **中继向连接器下发团队节点元信息**
   - 连接器握手成功时，中继在 `ready` 帧中附带 `teamMode: boolean`（中继是否已初始化团队）与 `ownToken: boolean`（该电脑是否使用了专用 Token `cnt_…`）。
   - 当电脑设置了专用 Token 但连接器仍用旧/共享 Token 握手被拒时，中继以 `4401` + `machine_token_mismatch` 关闭，便于托盘给出精准指引。
2. **连接器本机回环控制端点（取代 `role: 'phone'` 绕中继探测）**
   - 连接器启动后在 `127.0.0.1:0`（系统分配随机端口）监听本机控制服务，仅接受携带 256 位随机密钥的 `Authorization: Bearer <secret>` 请求；进程将 `{pid, port, secret, startedAt}` 以 `0600` 权限写入 `<dataDir>/local-control.json`，退出时清理。
   - `GET /status`：直接返回连接器的真实中继连接状态、`teamMode`、`ownToken`、`authReason`、`machineName`、`services`、`codexVersion`、`desktopOnline`、`claudeSignIn`、`activeTasks`、`pendingUsage`。
   - `POST /request`：受理本机运维动作（如 `claude.artifact.login`、`info`、`runtime.reload`），使 `setup-status.ts` 和 `bridge-client.ts` 在个人模式与团队模式下都能本机直连工作；仅在未发现本机控制文件（旧版连接器）时回退到旧 WebSocket 路径。
3. **团队模式下的主卡片与右键菜单切换**
   - 当 `health.teamMode === true` 或本地 Token 以 `cnt_` 开头时：
     - **隐藏 `#token=` 二维码**，改为展示 **团队节点卡片**：电脑名称、凭据类型徽章（`专用 Token` 绿标 / `共享 Token · 建议在网页端更换` 提示）、引导文案（“团队成员请通过管理员发送的邀请链接登录”）。
     - 主按钮切换为 `打开团队网页`（打开不带 `#token=` 的纯净中继地址）与 `复制网页地址`。
     - 托盘右键菜单同步将 `复制连接链接` 切换为 `复制网页地址`，且绝不将连接器 Token 写入剪贴板。
     - 降级连接页 `.local/connect.html` 同样识别团队/专用 Token 配置，隐藏 `#token=` 二维码并展示纯净入口与团队说明。

### P1：团队协作防撞车与节点设置

4. **“当前谁正在用这台电脑”与停止/重启防误杀保护**
   - 连接器汇总当前受管运行中的任务（Codex 正在进行的轮次、Claude Code 活跃会话、Antigravity 正在写入/排队的任务），通过 `ledger.actor(opId)` 关联发起人姓名，在 `GET /status` 中返回 `activeTasks: {service, threadId, actorName?, queued?}[]`。
   - 托盘状态页新增 **当前活动** 行：空闲时显示 `空闲`，有任务时显示运行数量及发起人（如 `2 个任务运行中 · 张三（Codex）、李四（Claude Code）`）。
   - 点击 **停止服务**、**停止服务并退出**、或 **保存并重新启动** 时，若存在运行中任务，确认弹窗与设置页警示条明确列出正在运行的任务数与发起人名单，避免误杀同事正在执行的任务。
5. **设置页适配“电脑名称”、“专用 Token”与“项目根目录”**
   - 设置页支持编辑这台电脑在团队里展示的 **电脑名称（`machineName`）**，留空默认沿用本机主机名。
   - Token 输入框提示同时覆盖共享 Token 与团队「电脑」页生成的专用 Token（`cnt_…`），并实时识别前缀提示“已识别为电脑专用 Token（仅用于本机连接）”。
   - 设置页提供 **项目根目录（`projectRoots`）** 管理：通过系统文件夹选择框添加一个或多个允许团队成员新建与关联项目的根目录，支持设置默认目录（首项）和移除；保存时由 `setup-config.ts` 校验路径存在且不在系统/敏感目录黑名单内。留空时团队普通成员仅可在默认目录（`~/Documents/Projects`）内新建与关联项目，禁止浏览电脑其他磁盘位置。

### P2：运维透明度与精准异常提醒

6. **团队用量待同步状态（`usage_outbox`）**
   - `Ledger.pendingUsageCount()` 统计待中继确认的用量轮次。当 `pendingUsage > 0` 时，在托盘状态卡片展示 `N 条用量待同步，恢复连接后自动补报`，方便排查统计延迟。
7. **精准托盘气泡通知（支持开关）**
   - 托盘窗口提供“团队活动与异常提醒”开关（默认开启，存在托盘配置/本地偏好中）：
     - 当连接器收到 `4401`（尤其是 `machine_token_mismatch`）时，弹出精准气泡：“这台电脑的专用 Token 已更换或失效，点击打开连接设置更新”，点击气泡直接进入设置页；
     - 团队模式下有新任务接入运行（空闲 → 有成员任务开始）时，弹出轻提示气泡（如 `张三 正在这台电脑上运行 Codex`），让坐在电脑前的主人有非打扰式感知。

## 4 代码落点

- 中继：[src/server/relay.ts](../../src/server/relay.ts)
- 连接器：[src/connector/local-control.ts](../../src/connector/local-control.ts)、[src/connector/main.ts](../../src/connector/main.ts)、[src/connector/control.ts](../../src/connector/control.ts)、[src/connector/claude-code.ts](../../src/connector/claude-code.ts)、[src/connector/antigravity.ts](../../src/connector/antigravity.ts)、[src/connector/ledger.ts](../../src/connector/ledger.ts)
- 脚本与探测：[scripts/setup-status.ts](../../scripts/setup-status.ts)、[scripts/bridge-client.ts](../../scripts/bridge-client.ts)、[scripts/setup-config.ts](../../scripts/setup-config.ts)、[scripts/setup.ts](../../scripts/setup.ts)、[scripts/connection-page.ts](../../scripts/connection-page.ts)
- 托盘与桌面窗口：[desktop/index.html](../../desktop/index.html)、[desktop/style.css](../../desktop/style.css)、[desktop/main.ts](../../desktop/main.ts)、[scripts/windows/tray/Tray.cs](../../scripts/windows/tray/Tray.cs)
- 测试：[test/tray-team.test.ts](../../test/tray-team.test.ts)

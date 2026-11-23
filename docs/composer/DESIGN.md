# 输入框统一：现状调研与方案

2026-11-20，`feat/claude-code` 分支 `af655d3`。范围是 Codex 随行网页里 Codex、Claude Code、Antigravity 三个会话页底部的输入框：文字输入、图片和文件（选择、拖入、粘贴）、语音、许可、模型，以及运行中的发送和输入框上方的审批卡。本文只做调研和方案，不改代码。

## 结论

- 三个输入框已经共用外观和一部分底层：`.composer` 样式、`useComposerHeight`、`submitOnDesktop`、`SendMessageButton`、`useFileDrop`、`readAttachmentFiles`、`uploadAttachments`、`useVoiceInput`、`QueuedMessages`。但工具栏、附件状态、语音按钮、许可和模型控件是三个面板各写一份，已经分叉。
- Codex 最完整。Claude Code 复制了 Codex 的一部分，许可和模型换成了原生下拉框。Antigravity 最少：没有语音、没有许可、运行中不能发送。
- 有几处不只是不一致，而是缺陷：Claude Code 录音时麦克风不变红；Claude Code 和 Antigravity 处理附件时没有“处理中”状态和并发保护；粘贴大的 Base64 图片时不压缩、直接报错。见第 2 节。
- 建议抽出一个共用的 `Composer` 组件和 `useComposerAttachments`，各运行端只传入“能力描述”：支持的就显示，不支持的隐藏，或禁用并说明原因。分三步做：先修缺陷和补齐纯前端能力，再统一组件，最后做需要连接器配合的部分（Claude Code 思考程度和极速、Antigravity 许可和审批）。

## 1 现状对照

代码位置：Codex 在 [main.tsx](../../web/main.tsx#L635) 里内联；Claude Code 在 [claude-code.tsx](../../web/claude-code.tsx#L262)；Antigravity 在 [antigravity.tsx](../../web/antigravity.tsx#L218)。

### 1.1 外壳与文字

| | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 外壳、自动高度、电脑上回车发送 | 共用 | 共用 | 共用 |
| 新会话占位文字 | 接下来我们该写什么代码？ | 想让 Claude Code 做什么？ | 想让 Antigravity 做什么？ |
| 续聊 / 排队时占位文字 | 在 {电脑} 上继续… / 当前任务完成后发送… | 同 Codex | 在 {电脑} 上继续…（没有排队） |
| 字数上限 | 无 | 100,000 | 50,000（连接器同样限制） |
| 只读条件 | 正在发送 | 有待核实操作 | 有待核实操作 |
| 草稿保存 | `draft:{电脑}:{会话}` | `claude:{电脑}:{会话}:draft` | `antigravity:{电脑}:{会话}:draft` |
| 新会话选项目 | 欢迎区按钮，或“＋”面板 → 选择项目 | 欢迎区原生下拉框 | 欢迎区原生下拉框 |

### 1.2 图片与文件

| | Codex | Claude Code | Antigravity |
|---|---|---|---|
| “＋”按钮 | 打开“添加与选项”面板：语音方式、打开本机网页、添加图片、添加文件、附件计数、查看项目文件、刷新会话、选择项目 | 直接打开文件选择器 | 直接打开文件选择器 |
| 选择器 | 图片和文件分两个：图片只收 PNG/JPEG/WebP；文件只给文档类型，注释说明这样手机不会弹出拍照 | 一个选择器同时收图片和文档（`ATTACHMENT_ACCEPT`） | 同 Claude Code |
| 查看项目文件 | 在“＋”面板里 | 工具栏单独的文件图标 | 工具栏单独的文件图标 |
| 拖入 | 拖到输入框，虚线高亮；发送中或附件处理中不接收 | 同样的高亮；不能写入时不接收 | 同样的高亮；发送中或待核实时不接收 |
| 粘贴文件、截图 | `clipboardFiles` → `attach` | `clipboardFiles` → `addFiles` | 同 Claude Code |
| 粘贴 Base64 图片文字 | 转成文件后走同一条压缩流程 | `appendImages` 直接校验，不压缩，超过 2 MiB 报错 | 同 Claude Code |
| 图片能力检查 | 按模型的 `inputModalities`，添加和发送时都检查 | 不检查 | 按连接器的 `supportsImages`，发送时检查 |
| 处理中状态 | “正在处理附件，大图会自动压缩…”；用序号防止并发，处理中禁用发送、语音和切换 | 无 | 无 |
| 上传进度 | 内联写法 | `UploadStatus` 组件 | `UploadStatus` 组件 |
| 只发图片 | 可以 | 可以 | 不可以：网页要求有文字或文件，连接器 `messageText` 也只在有文件时允许空文字 |
| 上限 | 共用：合计 10 个；整批图片 8 MiB；每个文件 100 MiB | 同左 | 同左 |

### 1.3 语音

| | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 按钮 | 右侧动作区，紧挨发送 | 左侧，紧挨“＋” | 无 |
| 录音中样式 | 红色圆形停止按钮 | 不变色（原因见第 2 节） | — |
| 按钮说明 | “语音输入：Codex 识别 / 系统键盘” | “语音输入” | — |
| 切换识别方式 | 首页“选项”和“＋”面板 | 没有入口，沿用在 Codex 页选的方式 | — |

识别方式存在浏览器的 `voice-provider` 里，三个页面共用。“Codex 识别”走 `voice.transcribe`，由连接器的 [control.ts](../../src/connector/control.ts#L137) 统一处理，不分运行端，但依赖电脑上 Codex 的 ChatGPT 登录。所以在 Claude Code 和 Antigravity 页面上也能用，只是“Codex 识别”这个名字在那里容易让人困惑。

### 1.4 许可与审批

| | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 入口 | 盾牌按钮 → 底部面板里的下拉框 | 工具栏原生下拉框 | 无 |
| 选项 | 沿用当前设置 · {当前} / 按需审批 / 不提示审批 | 默认审批（即沿用）/ 按规则审批 / 自动接受编辑 / 只做计划 / 全部允许（慎用） | — |
| 发给运行端 | `approvalPolicy`（`on-request`、`never`），不改沙箱 | `permissionMode` | — |
| 高风险档 | 橙色文字 | 运行中的会话不提供“全部允许”；用过一次后恢复默认 | — |
| 记多久 | 到切换会话为止 | 不记，只在当前页面 | — |
| 审批卡 | `RequestCard`：命令、文件修改、额外权限、补充信息、MCP 表单 | `ClaudeRequestCard`：权限、提问、计划确认 | 无，原生交互还没接入 |
| 卡片按钮 | 允许一次 / 本会话允许 / 拒绝 / 取消 | 允许 / 允许并记住 / 拒绝；计划卡是“开始执行 / 继续规划”；提问卡是“提交回答 / 跳过” | — |

Codex 自身的文字也不一致：工具栏显示“默认权限 / 按需审批 / 完全访问”，无障碍标签是“电脑配置 / 按需审批 / 不提示”，面板里是“不提示审批”。而且只发了 `approvalPolicy=never`，沙箱没变，叫“完全访问”言过其实。

### 1.5 模型

| | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 控件 | 按钮 → 浮层 [ModelPicker](../../web/model-picker.tsx)：模型列表、思考程度滑杆、极速开关、恢复默认 | 工具栏原生下拉框，只能选模型 | 按钮 → 浮层 [AntigravityModelPicker](../../web/antigravity-model-picker.tsx)：“沿用对话设置”加模型列表 |
| 按钮文字 | 模型名 · 思考程度 · 极速 | 当前模型或“默认模型” | 所选模型，或“上轮 · {模型}” |
| 列表何时读取 | 随电脑信息一起到 | 下拉框第一次获得焦点或被按下时 | 每次打开浮层 |
| 记多久 | 到切换会话为止（覆盖只用于下一轮，发送后会话自己记住） | 按电脑记住，每次发送都带上 | 按会话记住，每次发送都带上 |

### 1.6 运行中发送与停止

| | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 没有草稿 | 停止 | 停止 | 停止（替代发送按钮） |
| 有草稿 | 停止 + 完成后发送（排队） | 立即发送（打断）+ 追加 + 完成后发送，停止按钮消失 | 只能停止，不能发送 |
| 排队列表 | 每条可追加、撤回、删除 | 同 Codex | 无 |

## 2 发现的问题

按影响从大到小排列。注明“推断”的是读代码得出的，还没在真机上复现。

1. **Claude Code 录音时麦克风不变红。** 红色样式是 `.composer-actions .recording`（[style.css](../../web/style.css#L245)），Claude Code 的麦克风放在工具栏左侧，不在 `.composer-actions` 里（[claude-code.tsx](../../web/claude-code.tsx#L285)），所以录音中和空闲时看起来一样。
2. **Claude Code 和 Antigravity 处理附件时没有并发保护（推断）。** `addFiles` 读取开始时的 `images`/`files`，压缩完成后整体写回（[claude-code.tsx](../../web/claude-code.tsx#L193)、[antigravity.tsx](../../web/antigravity.tsx#L51)）。大图压缩要几秒，期间可以点发送，也可以再拖入一批：发送后清空的附件会被写回来，两批几乎同时拖入时先到的一批会丢。Codex 用 `imageLoad` 序号挡住了这种情况（[main.tsx](../../web/main.tsx#L448)）。
3. **粘贴大的 Base64 图片直接报错。** Claude Code 和 Antigravity 用 `appendImages` 校验，单张超过 2 MiB 就报错；Codex 先转成文件，再走压缩流程。
4. **Antigravity 缺语音，也缺运行中发送。** 语音的后端本来就不分运行端，缺的只是网页按钮；运行中发送需要连接器排队（Claude Code 在 `dd06fdb` 已经做过一遍）。
5. **在 Claude Code 和 Antigravity 页面换不了识别方式。** 它们侧栏的“选项”只有切换电脑、刷新、断开连接。
6. **许可文字不统一。** 包括 Codex 的“完全访问”、Claude Code 的第一项“默认审批”（其实是沿用当前）、两处审批卡按钮的说法。
7. **Claude Code 模型下拉框第一次点开可能是空的（推断）。** 列表在 `onFocus`/`onPointerDown` 时才开始读取，手机原生选择器打开时选项还没回来。
8. **运行中的按钮三处不同。** Claude Code 有草稿时同时出现三个圆按钮，停止按钮反而不见了，手机窄屏上很挤。
9. **“＋”的含义不同。** Codex 打开面板，另外两个直接选文件。用户在三个页面之间切换时，同一个按钮做不同的事。

## 3 统一方案

### 3.1 布局

```
┌──────────────────────────────────────────────────────┐
│ [图片缩略图…] [文件卡片…]                              │ 附件区（有附件时出现）
│ 处理中 / 上传进度 / 录音中 · 取消                       │ 状态行（同一位置，一次只显示一条）
│ 想让 Claude Code 做什么？                              │ 文字
│ (＋) (🛡 按需审批)      Opus 5.5 · 高 · 极速 ▾  (🎤) (■)(↑) │ 工具栏
└──────────────────────────────────────────────────────┘
```

- 左侧：“＋”和许可按钮。运行端没有许可概念时不显示许可按钮。
- 中间：模型按钮，靠右对齐，放不下时截断模型名。窄屏下沿用现有的 `@container` 规则（许可只留图标，模型换到第一行）。
- 右侧：麦克风、停止、发送。发送是唯一的黑色主按钮。
- 查看项目文件、打开本机网页、刷新会话这类次要操作放进“＋”面板，不再占工具栏。

### 3.2 运行中发送

统一成 Codex 的规则：

- 没有草稿：只显示停止。
- 有草稿：停止 + “完成后发送”。消息进入排队列表，“追加到当前任务”放在每条排队消息上（Claude Code 已有 `claude.steerQueued`）。
- Claude Code 独有的“立即发送（打断）”也放到排队消息上，作为第四个图标；运行端不支持时不显示。
- 运行端不支持排队时（目前是 Antigravity），有草稿也只显示停止，并在占位文字里说明“当前任务结束后可发送”，不要让输入框看起来坏了。

### 3.3 “＋”面板

三个页面都打开同一个面板，按能力列出：

| 项 | Codex | Claude Code | Antigravity |
|---|---|---|---|
| 添加图片（模型不支持图片时禁用并说明） | ✓ | ✓ | ✓ |
| 添加文件（PDF、Word 等，每个最多 100 MiB） | ✓ | ✓ | ✓ |
| 附件计数 n/10 | ✓ | ✓ | ✓ |
| 语音输入方式 | ✓ | ✓ | ✓ |
| 查看项目文件 | ✓ | ✓ | ✓ |
| 打开本机网页 | ✓ | 以后（预览目前挂在 Codex 会话上） | 以后 |
| 刷新会话 | ✓ | ✓ | ✓ |
| 选择项目（新会话） | ✓ | ✓（欢迎区的下拉框保留） | ✓（同左） |

图片和文件保留两个入口，沿用 Codex 的理由：图片入口能按模型能力禁用，文件入口不会让手机弹出拍照。代价是添加附件多点一下；拖入和粘贴不受影响。

### 3.4 附件

把 Codex 的 `attach` 和 `paste` 移到共用的 `useComposerAttachments`：

```ts
useComposerAttachments({canImage, disabled}) → {
  images, files, loading,          // loading 时显示“正在处理附件…”，并禁用发送、语音和切换
  add(files), paste(event), drop,   // drop 直接交给 <form>
  remove(kind, index), clear(), restore(message),  // restore 用于撤回排队消息
}
```

- 并发保护、Base64 粘贴压缩、图片能力检查、上限提示都用 Codex 现有的写法。
- 拖入在“不能编辑草稿”时禁用：发送中、待核实、附件处理中。
- Antigravity 要支持只发图片，需要连接器放宽 `messageText`，并先在测试对话里确认 Hub 接受只有图片的消息。

### 3.5 语音

- 三个页面同一个按钮、同一个位置（右侧动作区），录音中都是红色 ✓ 按钮，上面是“正在听 · 边说边出字，可随时修改，说完点 ✓ / 取消”。2026-11-22 起默认 Claude 识别，流式边说边出字，录音期间草稿可编辑，点 ✓ 才结束；Codex 识别改回整段录音、整段识别。
- Antigravity 接上 `useVoiceInput`，不需要改连接器。
- 识别方式在每个页面的“＋”面板和“选项”里都能改，存在 `voice-engine`。
- 选项名改成“电脑识别（Codex）/ 系统键盘”，说明写清“使用电脑上 Codex 的 ChatGPT 登录”。电脑上没装或没登录 Codex 时，给出明确提示，而不是笼统的失败。

### 3.6 许可

统一的是控件和交互，档位由运行端提供：

```ts
type PermissionOption = {id: string; label: string; description: string; elevated?: boolean};
// 第一项固定是 {id: '', label: `沿用当前 · ${当前档位}`}
```

- 工具栏：盾牌图标加当前档位名；`elevated` 档用橙色。
- 点开后是和模型一样的浮层，每项带一行说明。不再用原生下拉框，也不再进底部面板。
- 说法统一：

| 统一说法 | Codex | Claude Code | Antigravity（待验证） |
|---|---|---|---|
| 沿用当前 | `''` | `''` | `''` |
| 按需审批 | `on-request` | `default` | 见下 |
| 自动接受编辑 | — | `acceptEdits` | 见下 |
| 只做计划 | — | `plan` | 见下 |
| 不提示审批（高风险） | `never` | — | 见下 |
| 全部允许（高风险） | — | `bypassPermissions` | 见下 |

Codex 把“完全访问”改成“不提示审批”，除非以后同时修改沙箱；没有覆盖时显示“电脑配置”。

2026-11-22 起，Claude Code 的权限模式改用其桌面 App 的叫法、说明和顺序：自动（`auto`）/ 手动（`default`）/ 接受编辑（`acceptEdits`）/ 计划（`plan`）/ 跳过权限确认（`bypassPermissions`）。上表 Claude Code 一列的说法以此为准；Codex 的说法不变。许可浮层也照原生精简：去掉“沿用当前”一行和“从下一条消息开始生效”的说明，只列各档并勾选正在用的；再点正在用的一档即取消选择。Codex 没有覆盖时的“电脑配置”仍列在最前，可以选回。

**Antigravity。** 本机 2.32.1 的 `language_server.exe` 里有这些枚举：`CASCADE_COMMANDS_AUTO_EXECUTION_{OFF, AUTO, EAGER, PROCEED_IN_SANDBOX}`、`ARTIFACT_REVIEW_MODE_{ALWAYS, AUTO, TURBO}`、`PLANNING_MODE_{ON, OFF}`、`CONVERSATIONAL_PLANNER_MODE_{DEFAULT, READ_ONLY}`，还有 `SetCascadeAutoExecutionPolicy`、`GetArtifactReviewPolicy` 等方法名。它们和模型一样可能放在 `cascadeConfig` 里随消息发送，但这只说明接口长什么样，按 [Antigravity 实施计划](../antigravity/IMPLEMENTATION.md) 的做法，要先在测试对话里核实。核实前 Antigravity 不显示许可按钮。

### 3.7 审批卡

继续放在输入框上方的 `request-stack`，外观合成一套：

- 按钮说法统一成“允许一次 / 本会话允许 / 拒绝”。Claude Code 的“记住”不一定只管本会话：连接器把 SDK 给的建议规则原样交回，规则可能写进会话、项目的 `.claude/settings.local.json` 或用户设置。所以它按连接器报告的位置显示“本会话允许 / 本项目始终允许 / 始终允许”，旧连接器不报告时仍显示“允许并记住”。计划卡保留“开始执行 / 继续规划”。
- 提问卡都用“提交回答”作主按钮；能跳过的显示“跳过”。
- 各运行端的连接器或适配层把原始请求整理成同一种结构（标题、详情、选项、问题），网页只用一个 `ApprovalCard` 渲染。Codex 的 MCP 表单这类特有内容保留为卡片里的扩展区域。
- Antigravity 接入 `HandleCascadeUserInteraction` 后直接用这套卡片。

### 3.8 模型

三个页面都用 Codex 的 `ModelPicker` 浮层。思考程度和极速按模型能力显示：

```ts
type ModelOption = {id: string; label: string; description?: string;
  efforts?: string[]; defaultEffort?: string; fast?: boolean; images?: boolean};
```

- Claude Code：SDK 0.3.328 的 `ModelInfo` 已经有 `supportsEffort`、`supportedEffortLevels`、`supportsFastMode`；`Options.effort` 可以在启动时指定，运行中的会话可以用 `applyFlagSettings({effortLevel, fastMode})` 修改。连接器目前只映射了 id、名称和说明（[claude-runtime.ts](../../src/connector/claude-runtime.ts#L340)），网页先只显示模型，连接器补上后再显示思考程度和极速。
- Antigravity：只有模型列表，浮层里不显示思考程度那一行。
- 覆盖记多久：建议统一成 Codex 的语义——选择只是这条草稿的设置，切换会话就清掉，撤回排队消息时恢复；发送后由运行端记住，“沿用当前”显示的就是会话实际在用的模型。Claude Code 目前按电脑记住、Antigravity 按会话记住，改的时候要确认会话数据里能读到当前模型（Claude Code 读 `view.model`，Antigravity 读 `current`）。

### 3.9 其他小项

- 占位文字：新会话统一为“想让 {应用} 做什么？”，续聊和排队沿用现有说法。
- 字数上限：共用一个常量，网页和连接器一起校验。Antigravity 若受桌面限制，就显示它自己的上限。
- 提示和错误：都放在输入框上方的同一位置；普通提示 4 秒后消失，错误手动关闭。

## 4 实施步骤

**第一步：修缺陷，补齐纯前端能力。** 已完成（2026-11-20）。

1. Claude Code 的麦克风移到右侧动作区，录音中变红。三个页面共用 [VoiceButton、VoiceStatus](../../web/voice-controls.tsx)。
2. Antigravity 加了语音按钮。
3. 三个页面共用 [useComposerAttachments](../../web/composer-attachments.ts)，就是原来 Codex 的附件逻辑：一次读一批，处理中显示状态并禁用发送和“＋”，切换会话时丢弃迟到的结果，Base64 粘贴走压缩。缩略图、处理中提示和上传进度也改用 [attachment-list.tsx](../../web/attachment-list.tsx) 里的共用组件。
4. Claude Code 和 Antigravity 的“选项”里加了“语音输入”，和 Codex 共用一个选择。
5. Codex 许可显示“电脑配置 / 按需审批 / 不提示审批”；Claude Code 权限下拉的“默认审批”改为“权限：{当前}”，`default` 叫“按需审批”；Claude Code 审批卡改为“允许一次”，记住按钮按保存位置命名（连接器新增 `rememberScope`）；Codex 提问卡的“提交回答”改为主按钮样式。

验证：`tsc` 和全部测试通过，新增 [composer-attachments.test.ts](../../test/composer-attachments.test.ts)。用假的连接器和麦克风在浏览器里挂载 Claude Code 和 Antigravity 面板，核对了工具栏布局、录音变红、识别结果填入草稿、9.8 MiB 图片以 Base64 文字粘贴后被压缩、压缩期间发送和“＋”禁用、第二次粘贴被拒。还没有在真手机和真实连接器上验收。

**第二步：抽共用组件。** 已完成（2026-11-20）。待定事项 1、2、5 按本文建议实现，3、4 保持原样，仍待定。

1. [composer.tsx](../../web/composer.tsx) 里的 `Composer` 是三个页面共用的输入框：附件、状态行、文字，工具栏左边“＋”和许可，中间模型，右边麦克风、停止、发送。运行中的按钮统一成 3.2 的规则：没有草稿只显示停止；有草稿时，支持排队的运行端显示停止和“完成后发送”，Antigravity 只显示停止，占位文字是“当前任务结束后可发送”。
2. 三个页面的“＋”都打开“添加与选项”（`AddOptions`）：添加图片、添加文件、附件计数、语音输入，以及运行端支持的打开本机网页（Codex）、查看项目文件、刷新会话、选择项目（Codex 新会话）。图片和文件是两个选择器（`useAttachmentPickers`），文件选择器不会让手机弹出拍照。Claude Code 和 Antigravity 工具栏上的文件图标移进了这个面板。
3. `ModelPicker` 增加 `tuning`：Codex 照旧显示思考程度和极速；Claude Code 和 Antigravity 是一张列表，第一项“沿用当前 · {当前模型}”，读取中、失败（可重试）、为空都有提示。Claude Code 的原生下拉框和原来的 Antigravity 浮层都换成了它，第一次打开时不再是空的（问题 7）。覆盖记多久没改：Codex 到切换会话为止，Claude Code 按电脑，Antigravity 按会话。
4. [permission-picker.tsx](../../web/permission-picker.tsx) 是共用的许可按钮和浮层：第一项“沿用当前 · {当前档位}”，每档一行说明，高风险档橙色。Codex 的许可底部面板和 Claude Code 的原生下拉框都换成了它；Antigravity 没有许可按钮。Claude Code 的“全部允许”仍只在手机还没接管的会话里出现，用过一次后恢复。
5. Claude Code 的“立即发送（打断）”和“追加”从输入框移到了排队消息上：运行中有草稿时点“完成后发送”进入队列，再在那条消息上点“立即发送”或“追加”。为此连接器的 `claude.steerQueued` 增加了 `mode: 'now'`，回执是 `sent_now`。旧连接器忽略这个参数，按追加处理，手机上提示“已追加到当前任务”，不会误报。
6. Antigravity 的连接器说不能发图片时，添加图片就会被拦下并说明原因，不再等到发送时才报错。
7. `SheetPanel`、`MenuItem` 移到 [sheet.tsx](../../web/sheet.tsx)，底部面板渲染到 `body`，Claude Code 和 Antigravity 面板里也能用。`model-picker.css` 改由 `main.tsx` 引入，组件可以在测试里直接加载。

和原计划不同的地方：能力没有做成一个 `ComposerCapabilities` 对象，而是用可选的属性表达，没传就不显示：`permission` 和 `model` 两个位置、`running.queue`、`AddOptions` 的各个回调、`QueuedMessages` 的 `onNow`。3.7 的统一审批卡和 3.9 的字数上限常量没有在这一步做。

验证：`tsc` 和全部 225 个测试通过，新增 [composer.test.ts](../../test/composer.test.ts)（运行中按钮、许可按钮、“＋”面板、两个浮层、排队消息的“立即发送”），`claude-runtime.test.ts` 增加了排队消息立即发送。用假的中继和麦克风在浏览器里打开完整的网页，三个页面都看过：工具栏、运行中有无草稿时的按钮、许可浮层和橙色高风险档、三个“＋”面板、从“＋”打开语音设置、Claude Code 模型列表的读取中状态和选择、排队消息“立即发送”发出 `mode: 'now'`、Antigravity 录音变红并填入草稿、电脑宽度下浮层贴着按钮。还没有在真手机和真实连接器上验收。

**第三步：需要连接器配合的部分。** 每项先用真实运行端在测试会话里核实，再开放给用户。

- Claude Code：模型列表带思考程度和极速；发送时带 `effort`；运行中用 `applyFlagSettings` 修改。
- Antigravity：运行中排队；只发图片；许可档位；审批卡（`HandleCascadeUserInteraction`）。

## 5 待定事项

第二步按建议实现了 1、2、5；不同意的话可以再改。3、4 仍待定。

1. ~~“＋”统一成打开面板（本文建议），还是统一成直接选文件？~~ 已统一成打开面板。
2. ~~图片和文件保留两个入口（本文建议），还是合成一个？~~ 已保留两个入口。
3. 模型和许可的覆盖记多久：只到这条草稿（本文建议），还是按电脑记住？Claude Code 若改成只到这条草稿，要先核实连接器重启后恢复的会话还用不用原来的模型；不用的话，要让连接器记住会话的模型。
4. 高风险许可（不提示审批、全部允许）发送一次后要不要自动恢复？Claude Code 现在会恢复，Codex 不会。
5. ~~Claude Code 的“立即发送（打断）”放到排队消息上（本文建议），还是做成发送按钮长按？~~ 已放到排队消息上。

## 6 验收

三个运行端分别在 iOS Safari、Android Chrome 和电脑浏览器上逐项检查：

- 拖入图片和文档；粘贴截图；粘贴 Base64 图片文字（包括大于 2 MiB 的）；大图压缩中点发送不会把附件带回草稿。
- 两种识别方式下的语音：开始、结束、取消，以及录音中切到后台。
- 修改许可后，下一轮按新档位审批；高风险档的颜色和说明。
- 修改模型（和思考程度、极速）后，下一轮在电脑上确实使用了新设置。
- 运行中：没有草稿时停止；有草稿时排队，以及排队消息的追加、撤回、删除；不支持排队的运行端有明确说明。
- 窄屏（320 px）下工具栏不换行错位，所有按钮可以点到。

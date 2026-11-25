# Codex 项目接口实测（2026-11-20）

测试环境：Codex 桌面端 26.1111.9664.0（自带 codex 0.169.1）；连接器实际使用 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，版本 0.167.0-alpha.3.2；codex-mobile-web `e643c86`。Antigravity 的对应记录见 [Antigravity 项目接口实测](../antigravity/PROJECT-API.md)。

结论：Codex 有官方的项目接口，即 app-server 的 `project/*` 方法。它目前属于实验接口，客户端初始化时要声明 `capabilities.experimentalApi: true`，连接器已经这样做了（[app-server.ts](../../src/connector/app-server.ts)）。0.130 还没有这组方法，0.167 和 0.169.1 的定义一致。

桌面端在 2026-07 已把项目迁进 `~/.codex/state_5.sqlite` 的 `projects`、`project_roots`、`project_idempotency_keys` 三张表。`.codex-global-state.json` 里的 `local-projects` 是迁移前的旧数据，而手机端目前读的正是它（[projects.ts](../../src/connector/projects.ts)）。

## 方法

| 方法 | 参数 | 返回 | 实测 |
|---|---|---|---|
| `project/list` | `{cursor?, limit?, sortKey?: "position" \| "recencyAt", sortDirection?}` | `{data: Project[], nextCursor}` | 正常；本机 17 个项目，位置 0–16 |
| `project/read` | `{projectId}` | `{project}` | ID 不存在时报 `-32602 project not found` |
| `project/create` | `{name, roots: [{path}], metadata?, idempotencyKey}` | `{project}` | 见下文 |
| `project/update` | `{projectId, name?, roots?, metadata?}` | `{project}` | 见下文 |
| `project/delete` | `{projectId}` | `{}` | 见下文 |
| `project/move` | `{projectId, beforeProjectId?}` | `{}` | 未测 |
| `project/import` | `{name, roots, metadata?, threads?, idempotencyKey}` | `{project}` | 未测；看参数是建项目时顺带把已有会话归进去 |

通知：`project/changed {projectId, changeType: "created" | "updated" | "deleted"}`，以及 `thread/project/updated {threadId, projectId}`。

会话和项目的关系：`thread/start` 可以带 `projectId`；`thread/list` 可以按 `projectId` 过滤（传 `null` 表示只要未归类的会话）；`thread/metadata/update` 能改会话所属项目（未测）；会话对象上有 `projectId`，数据库里对应 `threads.project_id`。

```
Project { id, name, roots: [{path}], metadata: {string: string}, position, createdAt, updatedAt, recencyAt }
```

`id` 是服务端生成的 UUIDv7；`recencyAt` 是项目里最新一条未归档会话的时间，没有会话时为 `null`。

## 实测结论

1. **新建由服务端生成 ID**，返回完整的项目对象。新项目排在最后（位置是原来的最大值加一），其他项目的位置不变。
2. **`idempotencyKey` 真正防重复。** 用同一个 key 再建一次，返回的是同一个项目，第二次传的名字会被忽略。项目删除后再用这个 key 会报错 `idempotency key refers to deleted project`。key 的记录在项目删除后仍留在 `project_idempotency_keys` 表里。
3. **校验很宽松。** 同一个文件夹可以同时属于多个项目；文件夹不存在也能建，接口不会帮你建文件夹；`roots` 可以为空。名字不能为空（`-32602 project name must not be empty`）。
4. **更新是局部的。** 只传 `name` 时 `roots` 保留；传 `roots` 时整个列表被替换（支持多个文件夹）；`metadata` 可以写。
5. **删项目不删会话，也不删文件夹。** 项目里的会话 `project_id` 变成 `null`，即变成"未归类"，不归档也不删除；同时推送 `thread/project/updated {projectId: null}`。文件夹原样保留。同一个项目再删一次报 `project not found`。
6. **会话有内容后才落盘。** 只调 `thread/start` 不发消息时，会话不会写进数据库。用 `thread/inject_items` 写入一条消息后（不调用模型），`threads.project_id` 才写入，项目的 `recencyAt` 也随之更新。
7. **变更通知不跨进程。** 通知只发给执行改动的那个 app-server 的客户端。测试时另起了一个 app-server（用桌面端自带的 0.169.1 模拟桌面端）旁听：它重新 `list` / `read` 能看到变化，但没有收到任何 `project/changed`。桌面端通过标准输入输出使用自己的 app-server，没有开控制 socket，`codex app-server proxy` 连不上它。所以连接器做的改动，桌面侧栏多半要等桌面端自己重新读取才会出现。这一点没有在桌面界面上核实。

## 接入时要遵守的规则

- 项目列表改用 `project/list`（按 `position` 排序）。版本太旧、没有这个方法时，退回读 `.codex-global-state.json`，并隐藏管理按钮。
- 新建时用手机的操作 ID 作 `idempotencyKey`。结果不明时，用同一个 key 再调一次，就能拿回同一个项目（前提是项目没被删）。
- 文件夹要自己检查：是否存在、是不是目录、是否已被别的项目使用。接口都不拦。
- 改名只传 `name`；改文件夹要传完整的列表。
- 在 Codex 里，删除项目就相当于"移除"：会话和文件夹都保留，会话变成未归类。
- 改动后桌面侧栏不一定马上刷新，手机上要提示这一点。

## 没有验证的

- 桌面侧栏什么时候显示连接器做的改动：是重启后，切换窗口后，还是要手动刷新。
- `project/move`、`project/import`，以及用 `thread/metadata/update` 改会话归属。
- 有真实对话轮次的会话在项目删除后的表现。实测用的是 `thread/inject_items` 写入的会话，推测结果相同。

## 测试过程与清理

测试分两轮，只建名字以"codex随行测试"开头的项目，文件夹放在临时目录里，会话没有调用模型。结束后已删除：测试项目、测试会话（用 `thread/delete`，数据库记录和记录文件都已不在）、临时文件夹。项目列表和排序与测试前完全一致。

`project_idempotency_keys` 里留下 5 条键名以 `codex-mobile-web-test` 开头的记录，指向已删除的项目。这是 Codex 的正常行为（测试前就有 19 条记录对应 17 个项目），没有手动删除。

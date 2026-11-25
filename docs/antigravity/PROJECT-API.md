# Antigravity 项目接口实测（2026-11-20）

测试环境：Windows Antigravity App 2.33.0.0，`language_server.exe` 的 SHA-256 以 `EB6D986DFC5A859C` 开头，codex-mobile-web `81295f9`。这些接口没有公开文档，Antigravity 升级后要重新核对。

目的：确认手机端能不能新建、查看、改名、删除 Antigravity 项目。结论是可以，桌面 Hub 自己就有一套项目接口，不需要直接改 `~/.gemini/config/projects/*.json`。目前手机端已接入新建/关联项目与列表合并（过滤已归档项目），改名与移除/归档入口留待后续版本。Codex 的对应记录见 [Codex 项目接口实测](../codex/PROJECT-API.md)。

## 调用方式

和连接器现有的 [callHub](../../src/connector/antigravity-hub.ts) 一样：读取 `~/.gemini/antigravity/daemon/hub_*.json` 里的 `httpsPort` 和 `csrfToken`，向 `https://127.0.0.1:<httpsPort>/exa.language_server_pb.LanguageServerService/<方法名>` 发 POST，请求头带 `content-type: application/json` 和 `x-codeium-csrf-token`。

流式方法（如 `ProjectUpdatesStream`）用 Connect 流式格式：`content-type: application/connect+json`、`connect-protocol-version: 1`。请求和返回都按帧封装，每帧是 1 字节标志加 4 字节大端长度，后面跟 JSON。

## 结构定义从哪来

`language_server.exe` 是 Go 程序，里面嵌着 protobuf 的结构描述（FileDescriptorProto）。Hub 服务在 `third_party/jetski/language_server_pb/language_server.proto`，包名 `exa.language_server_pb`，共 377 个方法；项目相关的类型在 `exa.project_pb`。

提取方法：在程序文件里找 `0x0a <长度> <路径>.proto 0x12` 这样的字节序列（结构描述的开头），从那里按 FileDescriptorProto 的格式解析。多份描述是首尾相连的，读到第二个文件名字段就要停下，否则会把下一个文件的内容算进来。

## 方法

| 方法 | 请求 | 返回 | 实测 |
|---|---|---|---|
| `ListProjects` | `{backend?: "BACKEND_TYPE_LOCAL"}` | `{projectIds}` | 返回全部项目 ID，外加一个特殊的 `outside-of-project`（"不属于任何项目"） |
| `ReadProject` | `{id}` | `{project, notFoundOnDisk, errorMessage}` | 找不到时返回 `{notFoundOnDisk: true}`；`id` 为空时报 `400 id is required` |
| `ReadProjects` | `{ids}` | `{projects, notFoundIds, failedIds, errorMessages}` | 正常 |
| `CreateProject` | `{project, backend, files?}` | `{}` | 见下文"实测结论" |
| `UpdateProject` | `{project, files?, rename}` | `{}` | 见下文 |
| `DeleteProject` | `{id}` | `{}` | 见下文；ID 不存在时返回 `404 not_found` |
| `GetDefaultProjectDir` | `{}` | `{defaultProjectDirUri}` | 本机返回 `file:///C:/Users/<用户>/Documents` |
| `CreateScratchProjectFolder` | `{name}` | `{folderUri, isGitRepo, errorMessage}` | 在 `Documents\antigravity\<name>` 建文件夹并 `git init`；不会建项目；`Documents\antigravity` 不存在时会一起建出来 |
| `ResolveFolder` | `{folderUri}` | `{resourceType, vcsType}` | 能区分普通文件夹、Git 文件夹（`FOLDER_TYPE_GIT_FOLDER` + `VCS_TYPE_GIT`）和不存在的路径（`FOLDER_TYPE_NON_EXISTENT`） |
| `ProjectUpdatesStream` | `{backend}` | 流：`{projectList}` 或 `{projectUpdatedId}` | 一连上先推送完整的项目 ID 列表；之后每次新建、修改、删除都推送 `{projectUpdatedId}`，删除也是这个格式 |

其他相关方法（没测）：`AddEnvironmentToProject`、`GetProjectTrustStatus`（需要 `project_id`）、`SetWorkspaceTrust`、`ImportProjectFromUrl`、`CreateMagicProject`、`ValidateProject`（GCP 项目授权，跟本地项目无关）。`AddTrackedWorkspace` / `RemoveTrackedWorkspace` 管文件监听，跟项目列表无关。

## Project 结构

```
Project {
  id                    string      // UUID，由调用方生成
  name                  string
  projectResources      { resources: [ {folderUri} | {gitFolder: {folderUri, defaultBranch, allowWrite}} | {google3} | {remoteResource} ] }
  environments          { environments: [ {id, name, resources} ] }
  projectConversations  { conversations: [ {conversationId, environmentId} ] }
  permissionGrants      { permissionGrants: {allow, deny, ask}, v2Migrated }
  settings              ProjectSettings   // fileAccessPolicy、internetPolicy、sandboxMode、autoExecutionPolicy、artifactReviewMode、permissionPreset 等
  updatedAt             Timestamp
  isWorkspaceOnly       bool?
  archived              bool?
  backendType           BACKEND_TYPE_LOCAL | REMOTE_AICODE | REMOTE_ENTERPRISE
  coordinator, sidecar  …
}
```

桌面端存的文件夹地址形如 `file:///c%3A/Users/...`：盘符小写，冒号写成 `%3A`，各级目录名做 URI 编码。通过接口新建项目时用的也是这个写法，读回来原样保留。

## 实测结论

1. **项目 ID 必须由调用方生成。** 带 UUID 建项目返回 `{}`，项目立刻写入 `~/.gemini/config/projects/<id>.json`，`ListProjects` 里也能看到。用同一个 ID 再建，返回 `409 already_exists`。
2. **不带 ID 建项目会留下孤儿。** 照样返回成功，但实际建了一个 ID 为空的项目，文件名是 `.json`。`ListProjects` 看不到它，`ReadProject` / `DeleteProject` 又因为 `id is required` 拒绝处理，只能直接删文件。
3. **改项目是局部更新。** 只传 `{id, name}` 时名字改了，`projectResources` 原样保留。`rename: false` 时名字也照样会改，`rename` 不控制改名，它的实际作用还不清楚。
4. **删项目不删文件夹，但会删对话。** 删除后项目文件和列表项消失，磁盘上的文件夹和文件都还在。删除前用 `StartCascade`（带 `projectEnvConfig.projectId`）在项目里开了一条空对话，项目删除后，这条对话的 `conversations/<id>.db`、`brain/<id>/` 和摘要索引里的记录全部消失。
5. **新建项目时自动补的字段。** 只传 `id`、`name`、`projectResources`，服务端会补上 `permissionGrants: {v2Migrated: true}`。桌面端自己建的项目还会带 `isWorkspaceOnly: false` 和 `settings: {}`。
6. **对话不记在项目里。** 新开的对话没有写进 `projectConversations`，归属靠对话自己的 `workspace_uris` 和 `projectEnvConfig`。
7. **`archived: true` 软归档实测（2026-11-25 补充，Hub `language_server.exe` SHA-256 `73CE9A24...`）**：
   - 调用 `UpdateProject({project: {id, archived: true}, rename: false})` 返回 `200 {}`，仅更新 `archived: true` 与 `updatedAt`，其余字段（`name`、`projectResources`、`permissionGrants`、`settings`、`isWorkspaceOnly`）均原样保留。
   - 项目内已有对话**不会被删除**（`GetAllCascadeTrajectories` 仍保留，`conversations/<id>.db` 未受影响）。
   - `ListProjects` 仍会返回已归档项目的 ID；`ReadProject` / `ReadProjects` 与磁盘 JSON 会携带 `"archived": true`，连接器列表据此过滤隐藏。
   - 可通过 `UpdateProject({project: {id, archived: false}, rename: false})` 完整恢复，磁盘 JSON 的 `archived` 字段被移除；同 UUID 重复 `CreateProject` 返回 `409 already_exists`。

## 接入时要遵守的规则

- 新建时一定生成 UUID 放进 `project.id`，任何情况下都不要省略（推荐使用确定性 UUIDv5 配合 `opId` 实现幂等重试）。
- 文件夹地址按桌面端的写法生成（`file:///c%3A/...`），新建前用 `ResolveFolder` 确认文件夹存在、看是不是 Git 仓库。
- 改名只传 `{id, name}` 就够了。
- 删除会连带删除项目里的对话历史，手机上必须明确提示；软移除优先使用 `UpdateProject({project: {id, archived: true}, rename: false})` 并过滤 `archived === true` 的项目。
- 写入后可以靠 `ProjectUpdatesStream` 或 `ReadProject` 确认结果，不要因为返回 `{}` 就判定成功或失败。

## 没有验证的

- 桌面侧栏是否随推送立即刷新：推送事件确认发出了，但侧栏的画面没看到。
- 有内容的对话会不会随 `DeleteProject` 一起删：实测只用了没发过消息的空对话，按现象推测也会删。
- `rename` 开关的实际作用。
- 删掉孤儿文件 `.json` 之后，Hub 内存里是否还留着那个空 ID 项目；`ListProjects` 看不到它，重启 Antigravity 应该能清掉。

## 测试过程与清理

测试只建了名字以"codex随行测试"开头的项目，文件夹放在临时目录里，对话没发过消息，不消耗模型额度。测试结束后已删除：测试项目、测试对话（`DeleteCascadeTrajectory`）、不带 ID 时留下的 `.json`（直接删文件）、`CreateScratchProjectFolder` 建的文件夹和新建出来的空 `Documents\antigravity`、临时测试文件夹。删完后 `ListProjects` 和 `~/.gemini/config/projects/` 都和测试前一致。

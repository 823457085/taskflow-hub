# TaskFlow 本地业务服务

Node.js 24+ / SQLite，无第三方运行依赖。单组织、多项目；首次启动为空库，不含默认密码或外部凭据。

```sh
cd platform-server
npm test
npm start
```

默认 `http://127.0.0.1:5187`。监听配置读取 `TASKFLOW_HOST`、`TASKFLOW_PORT`、`TASKFLOW_DB_PATH`；忽略工作台继承的通用 HOST/PORT。`GET /health` 的 READ_ONLY_CONNECTORS 仅表示具备连接器代码，不表示外部平台已经认证；逐项目状态以 `/api/connectors` 为准。

## 身份与隔离

首次 `POST /api/setup {username,password}` 创建 ADMIN，再通过 `/api/login` 登录。用户名 3–64 字符，仅字母数字及 `_.-`；密码 8–256 字符。口令加盐 scrypt 存储，会话8小时有效，令牌只存哈希。浏览器使用 HttpOnly / SameSite=Strict cookie；CLI 可使用 Bearer 令牌。不要把秘密放入命令参数或日志。

首次和旧库迁移建立 `default` 项目；旧用户/任务无损归入该项目。新增用户不指定项目时加入 default，指定其他项目时仅加入指定项目。后续重启不会再次把所有用户加入 default。

ADMIN 是全局管理员。其他账号按 `project_members.role` 授权，不能依靠用户全局角色、请求体或 Header 越权。任务、资产、评审、进度、设备和审计均按项目检查。项目角色 DEV / QA / LEAD / SRE / PM。角色只改变被授权的本地功能，不授予外部平台权限。

## 任务与本地协同

| 方法/路径 | 内容 |
| --- | --- |
| GET/POST `/api/projects` | 项目列表 / ADMIN创建 `{key,name}` |
| GET/POST `/api/projects/:id/members` | 项目成员 / ADMIN或项目LEAD维护 `{userId,role}` |
| GET/POST `/api/users` | ADMIN读取/创建成员，创建可传projectId |
| GET `/api/agents?projectId=` | 服务器模式：项目内已接入的本机 Bridge（成员、在线、是否允许团队派发、当前用户能否派发）；仅网页会话 |
| PATCH `/api/local-devices/:id` | `{teamDispatch}` 设备主人开关团队派发 |
| POST `/api/me/password` | 本人改密码 `{currentPassword,newPassword}`；保留当前会话与已配对设备，其他登录失效；每用户每分钟最多5次 |
| POST `/api/users/:id/password` | ADMIN重置他人密码 `{password}`；该成员全部会话与已配对设备失效；不可重置自己 |
| GET/POST `/api/tasks` | 可见任务列表（支持projectId）/ 创建任务 |
| GET/PATCH `/api/tasks/:id` | 详情 / `{expectedVersion,title?,assigneeId?,status?}` |
| POST `/api/tasks/:id/claim` | `{expectedVersion}` 认领未指派或自己的任务 |
| POST `/api/tasks/:id/progress` | `{tool,deviceId,progress,summary,branch?}` 自报进度 |
| POST `/api/tasks/:id/heartbeat` | `{deviceId,tool,status}` 设备心跳 |
| GET `/api/tasks/:id/context` | `{task,assets,progressEvents,devices,integrationStatus}` |
| GET/POST `/api/todos` | `scope=mine\|project&projectId=` 列表 / 创建 `{projectId?,title,details?,dueDate?,priority?,status?,assigneeId?,taskId?}`；无 projectId 为仅本人可见的个人待办 |
| PATCH/DELETE `/api/todos/:id` | `{expectedVersion,...}` / `?expectedVersion=`；创建人、负责人和 ADMIN/LEAD/PM 可改，创建人或项目 LEAD 可删 |
| POST `/api/todos/import` | `{items}` 导入 Delivery `workspace-todos.json` 的条目到个人待办，按原 id 去重，最多500条 |
| POST `/api/agent-sessions/sync` | `{source:'delivery',items}` 本人或已配对设备同步 Agent 会话（最多100条），按来源 id 去重，仅在更新时间更新时覆盖；服务端遮盖密钥与家目录路径 |
| GET `/api/agent-sessions` | `scope=mine\|project&projectId=&q=`；项目范围只返回成员主动共享的会话；仅网页会话 |
| GET/PATCH/DELETE `/api/agent-sessions/:id` | 详情（含评论）/ 所有人改 `{projectId,shared,taskId}` / 所有人删除平台副本 |
| POST `/api/agent-sessions/:id/comments`、`/api/agent-sessions/share` | 可见者评论 `{body}`；所有人批量共享 `{ids,projectId,shared}` |
| GET/POST `/api/deployments` | `projectId,environment?,status?` 列表（含各环境最新一次）/ 手动登记 `{projectId,environment,service,version?,status?,url?,notes?}` |
| PATCH/DELETE `/api/deployments/:id` | 记录人或 ADMIN/LEAD/PM 修改；流水线同步的记录只能改备注；手动记录由记录人或项目 LEAD 删除 |
| POST `/api/deployments/sync` | `{projectId,items}` 本人或已配对设备同步云效/Jenkins 运行（最多200条），按 provider+externalId 幂等 |
| GET/POST `/api/knowledge` | `projectId,q?,tag?,limit?` 列表（摘要与项目全部标签，设备可读）/ 新建 `{projectId,title,body?,tags?}`，正文最多30000字 |
| POST `/api/knowledge/import` | `{projectId,docs:[{sourceRef,title,body?,tags?}]}` 最多50条，按 sourceRef 幂等，变化时留历史版本 |
| GET/PATCH/DELETE `/api/knowledge/:id` | 全文（设备可读）/ 成员按 `expectedVersion` 编辑（冲突409）/ 作者或项目 LEAD 删除；`GET /:id/revisions` 查看历史 |
| GET/POST `/api/skills` | `projectId,include=content?` 团队 Skill 列表（设备只拿到启用的）/ ADMIN/LEAD 发布 `{projectId,name,description,content,enabled?}` |
| GET/PATCH/DELETE `/api/skills/:id` | 详情 / ADMIN/LEAD 按 `expectedVersion` 修改描述、正文或启停 / 删除；`GET /:id/revisions` 查看历史 |
| GET `/api/work-reports` | `projectId,date?,tzOffset?,memberId?,scope=team?` 按天汇总任务、待办、本机 AI 执行和进度回报；查看他人或全员需 ADMIN/LEAD/PM，个人待办只出现在本人报告 |

任务创建输入 `{projectId?,jiraKey,title,type?,parentId?,assigneeId?}`，type为 STORY/TASK/BUG/RELEASE。任务号按当前单 Jira 实例全局唯一，手动登记的关联为 `unverified`，由连接器读取并导入原事项后为 `verified`。父子须同项目。默认受理人为自己，ADMIN/LEAD/PM可改派到本项目成员或取消指派。受理人及上述管理角色可修改任务；进度和心跳仅受理人、ADMIN或LEAD可写。

Jira 任务接入优先读取后选择，无需重复输入标题：

| 方法/路径 | 输入与返回 |
| --- | --- |
| POST `/api/jira/tasks/lookup` | `{reference,projectId?}`，reference 为普通 Jira 事项链接或任务号；返回 `{project,issue,existingTask}` |
| POST `/api/jira/tasks/search` | `{projectId,query?}`，query 为普通文本而非 JQL；返回 `{project,items,total}`，固定最多30项 |
| POST `/api/jira/tasks/import` | `{reference,projectId?}`，重新读取确认后返回 `{project,task,existing,imported,externalUrl}` |

这些接入接口允许本项目成员使用已配置的 Jira 连接读取该绑定项目内的事项，不放开连接管理或任意资源读取。链接来源必须与可见项目绑定一致；项目提示仅用于消歧，DEFAULT 不会成为真实 Jira 事项的错误归属。未配置连接、未绑定项目、不可见项目、不同来源或多实例歧义会在请求外部接口前拒绝。任务级本地设备不得访问此类共享账号接口。

外部仅 GET。每次等待后重新校验登录、项目成员关系、连接版本和 Jira 绑定。新任务保存原始 Jira 元数据和 `verified` 关联，默认受理人为当前项目成员；全局 ADMIN 不是该项目成员时不自动指派自己。已有同项目、同来源的任务直接返回，不覆盖标题、状态、受理人或冻结记录；同号异项目/来源冲突不自动移动。父任务已在本地且为相同来源时自动关联，冻结父任务拒绝新建子任务。首次接入不批量补写其他子任务，其他分配操作仍在任务详情按现有权限完成。

`version` 用于任务 PATCH/claim 乐观并发，冲突409。`contextVersion` 单调记录标题、受理人、Jira评审输入和父子关系实质变化及 DONE→重开新周期；新建或补导子任务也提升父任务上下文。普通进度和状态切换不改变评审上下文版本。恢复旧内容或移除测试子任务不会复活旧审批。

设备仅接收成员主动上报，不读取本机进程、聊天或认证信息。`lastSeen` 以服务端收到时间为准，超过90秒显示 OFFLINE。`tool` 为 codex/codex-cli/claude-code/cursor，heartbeat状态为 IDLE/WORKING/WAITING/OFFLINE。进度来源 `self_reported`，不等于测试或验收通过。

## 资产、报告与审批

- GET/POST `/api/tasks/:id/assets`：写入 `{kind,logicalKey?,title,content,sourceUrl?}`。kind为 PRD/TECH_SPEC/CODE/TEST_CASE/RELEASE_PLAN。每次生成不可变 revision、sha256、作者和时间，原文保存。sourceUrl只登记不抓取，拒绝携带用户名/密码的链接。资产写权限分别为 PM、DEV、DEV、QA、SRE；ADMIN/LEAD也可写。
- POST `/api/reviews {taskId,stage,executionMode?}`：stage为 PRD/TECH_SPEC/CODE_REVIEW/TEST_CASE/RELEASE。HUMAN_REVIEW→AWAITING_REVIEW；LOCAL_REPORT→AWAITING_REPORT；默认 CLOUD_AI→AWAITING_CONFIGURATION。
- GET `/api/jobs?taskId=&projectId=`、GET `/api/jobs/:id`：读取输入快照、报告、发现项和审批。
- POST `/api/jobs/:id/report`：`{summary,source,tool?,evidence?,findings}`。MANUAL只用于 HUMAN_REVIEW；LOCAL_TOOL只用于 LOCAL_REPORT并需声明tool。仅阶段允许发起角色提交。报告不可覆盖；客户端 actor/decision 等字段不作为身份或审批依据。
- POST `/api/jobs/:id/decision {decision,reason}`：APPROVE / REQUEST_CHANGES。不可审批自己的报告或自己受理的工作。每个申请只记录一次结论。
- POST `/api/jobs/:id/findings/:findingId/waiver {reason}`：仅 TECH_SPEC/CODE_REVIEW 允许独立 LEAD/ADMIN 豁免，其他阶段需修正材料并重评；原问题保持不变。
- GET `/api/tasks/:id/gates`：MISSING_INPUT/PENDING/BLOCKED/CHANGES_REQUESTED/STALE/PASS，全部通过才 overall PASS。

报告 summary≤8000字符，findings≤50项；每项 `{severity:CRITICAL|WARN|INFO,title,detail,location?}`，title≤200、detail≤4000、location≤500，evidence≤8000。请求体上限128KiB，资产content上限65536字符。错误 `{error:{code,message}}`，客户端应原样显示 message。

审批角色：PRD PM/LEAD/ADMIN；TECH_SPEC和CODE_REVIEW LEAD/ADMIN；TEST_CASE QA/LEAD/ADMIN；RELEASE SRE/ADMIN。未豁免 CRITICAL 阻止通过；RELEASE还要求前四项门禁 PASS。

PRD只取PRD输入；后续阶段依次累加方案、代码、用例、发布计划的最新逻辑版本。代码变化只失效代码/用例/发布，不失效需求/方案。`inputHash` 绑定任务contextVersion、相关资产ID/版本/hash；RELEASE额外冻结上游评审与审批ID。历史快照不随数据更新。`policyHash` 另行冻结persona/skills/plugin版本，用于申请幂等与追溯；登记新策略不追溯使历史DONE失效，新一轮重开则全部旧审批STALE。

DONE任务禁止新增资产、评审、报告、认领或进度；先显式重开。DONE父任务下禁止新增/修改后代，需先重开祖先。任务完成需要五项门禁全部PASS，且每个子任务状态DONE、当前门禁仍PASS。整体通过或完成仅改变本地记录，不触发生产发布、不更新 Jira。

## 插件、审计与未接入范围

设备配对、明确项目授权、受限会话及撤销接口见[本地桥接说明](../local-bridge/README.md)。设备令牌执行固定LOCAL_BRIDGE白名单，不能调用本节管理/审批接口；浏览器会话权限保持不变。

GET/POST `/api/plugins` 支持项目范围，写入仅ADMIN/LEAD。当前只登记 `{id,name,version,stages,projectId?}`，状态 `REGISTERED_NOT_EXECUTABLE`；不会保存或执行任意command。GET `/api/audit?projectId=` 仅ADMIN/对应项目LEAD，最近200条，不含口令或令牌。

云端 AI 申请不能提交报告、审批或放行；缺材料的 CLOUD_AI 申请为旧CLI兼容可登记，但不会通过门禁。persona/skills元数据不代表AI已加载；LOCAL_TOOL是提交者声明，不代表平台执行过该工具。

SSO、外部写回/Webhook、云端沙箱、AI账号授权预算、执行插件及生产发布尚未实现。本地标准MCP见`../local-bridge/README.md`。当前为单机本地HTTP，生产还需TLS/Secure cookie、组织隔离、共享限流、备份和服务化部署。

## 真实只读连接器

Jira、Confluence、GitLab、Jenkins、云效按项目独立配置。连接器的读取和导入使用 GET，导入仅写本地 SQLite。普通成员可看本项目连接状态和已导入材料；配置、共享连接的认证/查询/导入仅限 ADMIN 或本项目 LEAD。host 上已有凭据复用另限全局 ADMIN，不能指定任意文件路径。

| 方法/路径 | 请求与返回 |
| --- | --- |
| GET `/api/connectors?projectId=` | `{connectors:[{provider,name,status,baseUrl,authMode,organizationId,hasCredential,lastCheckedAt,lastError,capabilities,readOnly,localProfileAvailable}]}` |
| POST `/api/connectors/:provider/config` | `{projectId,baseUrl,authMode,username?,token?,organizationId?}` → `{connector}` |
| POST `/api/connectors/:provider/reuse-local` | `{projectId}` → `{connector}`，读取服务器预先允许的凭据引用 |
| POST `/api/connectors/:provider/test` | `{projectId}` → `{connector,identity?}`；云效为 `verifiedResource` |
| POST `/api/connectors/:provider/read` | `{projectId,resource,...定位字段}` → `{resource,items?,title?,content?,externalUrl,version?}` |
| POST `/api/connectors/:provider/import` | 同 read，加 `taskId/kind` → `{task?或asset?,imported,externalUrl}` |
| POST `/api/connectors/jira/sync-projects` | ADMIN `{projectId:源连接项目,projectIds:[远端ID]}` → `{projects,created,updated,unchanged}` |
| GET `/api/tasks/:id/merge-requests` | 回读任务已关联的 Codeup/GitLab MR 状态和合并提交 |
| POST `/api/tasks/:id/merge-requests/:assetId/merge` | 用户在任务评审页确认后提交 `{expectedReviewId}`，回读平台合并结果 |

合并使用操作者在当前项目选择的个人平台账号。服务端检查任务范围、当前代码审批、冻结的 MR 源提交与目标分支，再调用平台合并接口。GitLab 请求携带源提交 SHA；Codeup 在调用前核对源分支提交，合并后用平台返回的合并提交核对源版本。状态同步不创建新材料版本。

provider 为 jira/confluence/gitlab/jenkins/yunxiao；authMode 为 BEARER/BASIC/PRIVATE_TOKEN/NONE。token 省略保留原密钥；跨来源或改认证方式时必须重新输入密钥，NONE 清除旧密钥且测试不会判定成功。只有真实身份接口校验通过才 CONNECTED；200 匿名 Jenkins 不算成功。云效通过受保护流水线列表验证令牌，不捏造当前用户身份。远端返回的正确展示字段原文保留（含 L 码），仅精确移除反射的当前认证秘密。

| resource | 定位字段 | 读取/导入 |
| --- | --- | --- |
| jira_projects | 无其他字段 | 原始项目目录，items含id/key/name/projectTypeKey/category/baseUrl；完整目录仅ADMIN，绑定项目LEAD仅本项目；不能作为事项导入 |
| jira_issues | jql，limit 可选1–50，默认20 | 查询列表，不能批量导入 |
| jira_issue | issueKey | 创建/验证本地任务；可选taskId限定已有同号任务 |
| confluence_page | pageId，taskId，kind为PRD/TECH_SPEC | 读取原始 storage HTML，保存不可变资产 |
| gitlab_mr | repositoryId，mrIid，taskId，kind为CODE | 读取MR与Diff，分页/折叠/过大Diff禁止作为完整资产导入 |
| jenkins_jobs | 无其他字段 | 顶级任务列表，`items`为id/name/jobName/isFolder，原样名称，不递归读取，不可直接导入 |
| jenkins_build | jobName，buildNumber可选正整数/lastBuild/lastSuccessfulBuild，taskId，kind为RELEASE_PLAN | 只读构建结果；默认lastSuccessfulBuild |
| yunxiao_pipelines | 无其他字段 | 首页最多30条流水线，原始pipelineId/pipelineName映射为id/name，不能批量导入 |
| yunxiao_run | pipelineId，runId，taskId，kind为RELEASE_PLAN | 只读运行证据 |

Jira 原始标题、正文、项目、事项类型、优先级、组件、修复版本、标签、受理人、父任务号、状态和版本单独保存于 `task.externalRef`；同步不会覆盖手工标题、受理人或本地状态，也不会自动完成任务。评审输入变化提升 contextVersion，并将来源需求字段加入下一份不可变评审快照。资产按来源、远端版本与内容哈希幂等；新版本追加 revision，相关门禁随输入变化失效。DONE/已完成祖先下不能追加材料，先显式重开。原版本重复导入返回 imported=false；若此次补充父子关系则仍算实际导入变化。

项目目录同步只写本地：按明确选择的远端ID原子创建/更新`jira_project_bindings`，原始`projectCategory`为空就保留null，不编造业务分类。`GET /api/projects`附`jira:{id,key,name,baseUrl,category,projectTypeKey}`供界面分组。新项目仅为同步操作者添加LEAD成员，并初始化该Jira连接；不复制源项目其他成员或其他平台连接。再次同步保留已有成员和独立配置的Jira凭据，不因目录名称变化覆盖令牌。同key其他本地项目/其他实例绑定冲突则全部回滚。

绑定项目不能更换Jira实例；服务端将JQL条件与绑定项目ID合并，保留顶层ORDER BY，并验证每个返回事项的实际project.id。单事项读取/导入同样核对来源与project.id。DEFAULT源连接可查询目录，但真实事项需在已同步的对应项目导入；错项目返回`PROJECT_MAPPING_REQUIRED`，有权限时`error.details`含targetProjectId/key。不按可见Jira项目自动授予本地成员权限。

父后导入会补联同项目、同实例、明确记录该父号的子任务；子任务和旧/新父任务上下文同时失效。已完成子任务或祖先冻结时不补写，响应`skippedChildren`；重开后重复导入可再次补联。不会把其他实例同号任务作为父任务，也不允许形成循环。

密钥通过 AES-256-GCM 加密落库，不从 API 回传。首次保存时在 SQLite 同目录生成32字节 `connectors.key`，权限0600。备份必须同时保留数据库及此 key；丢失 key 后旧凭据无法解密。服务不记录认证头或远端响应体。远程地址只接受无用户名/密码/query/hash的 HTTPS；HTTP仅供工厂显式开启的 loopback 测试使用，运行入口没有该开关。请求15秒超时、JSON上限2MiB、不跟随重定向（尤其不向新来源转发凭据）。错误上限2000字符并移除当前秘密，身份结果不含邮箱字段。

本机复用只读取启动环境配置的引用：`TASKFLOW_JIRA_PROFILE`（env格式）与 `TASKFLOW_JIRA_BASE_URL`；`TASKFLOW_CONFLUENCE_PROFILE` 与 `TASKFLOW_CONFLUENCE_BASE_URL`；`TASKFLOW_JENKINS_PROFILE`（JSON baseUrl/username/token）；`TASKFLOW_YUNXIAO_PROFILE`（JSON token）与 `TASKFLOW_YUNXIAO_ORGANIZATION_ID`。Jira/Confluence也支持当前进程已有 `JIRA_AUTH_HEADER`/`CONFLUENCE_AUTH_HEADER`，或 `TASKFLOW_*_KEYCHAIN_SERVICE`、`TASKFLOW_*_KEYCHAIN_ACCOUNT`。不自动扫描用户目录，不把秘密写入启动plist。配置路径不可供普通客户端覆盖。

认证接口与读取协议依据官方文档：[Confluence](https://developer.atlassian.com/server/confluence/rest/v901/api-group-user/)、[GitLab users](https://docs.gitlab.com/api/users/)、[GitLab MR](https://docs.gitlab.com/api/merge_requests/)、[Jenkins](https://www.jenkins.io/doc/book/using/remote-access-api/)、[云效](https://help.aliyun.com/zh/yunxiao/developer-reference/listpipelines-get-a-list-of-pipelines)。本地HTTP集成测试覆盖鉴权/项目隔离、AES密文/key权限、匿名200拒绝、跨域redirect拒绝、2xx/错误反射秘密脱敏、原文保留、导入幂等与门禁失效；fixture通过不代表当前线上账号已联通。

## Docker

```sh
docker build -t taskflow-api .
docker run --rm -p 127.0.0.1:5187:5187 -v taskflow-data:/data taskflow-api
```

本轮未运行Docker；源码与本地HTTP测试通过不代表已云部署。macOS后台预览镜像和持久库的路径由根目录 preview-service 脚本维护，勿用空开发库覆盖正在使用的运行库。

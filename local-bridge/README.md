# 本地任务进度桥接

需要 Node.js 24。提供终端 CLI 和标准 MCP stdio 服务：登录平台、查询任务与资产版本、认领任务、上报指定进度和设备心跳、读取评审快照、提交指定 JSON 报告。不会自动调用 AI、安装 Git Hook、自动上报心跳或下发 Skills。仅显式运行 `install-mcp` 时合并指定项目的 MCP 配置。

安装精确锁定的官方 MCP SDK v1 与 Zod 依赖：

```sh
cd local-bridge
npm install --include=dev
```

以下 `node local-bridge/...` 命令从项目根目录执行。

先启动同级 `platform-server` 并登录网页。在终端发起设备配对，再在网页「本地 AI 接入」填写短码，检查设备名称与软件，明确选择可访问项目并批准：

```sh
node local-bridge/rd.mjs pair --url http://127.0.0.1:5187 --web-url http://127.0.0.1:5186 --name '我的开发机' --tool codex-cli
node local-bridge/rd.mjs install-mcp --client codex --project /明确的项目目录
node local-bridge/rd.mjs doctor --project /明确的项目目录
```

`pair` 不要求在终端输入平台密码；仅展示网页入口、短码和到期时间，设备密钥仅留在进程内存中。申请10分钟有效；批准并兑换后设备会话8小时有效。它按服务返回的间隔轮询（当前 3 秒），拒绝、过期、消费冲突、限流或网络失败时退出；不会自动批准。网页入口不包含短码或令牌。默认 API 为 5187、网页为 5186；自定义 API 时网页默认同源，可通过 `--web-url` 单独指定，远程地址必须 HTTPS。

配对成功后存储服务端分配的设备 ID、有限项目范围令牌和期限。该设备只能读授权项目并认领任务、上报进度/心跳、提交报告，不能审批、豁免、发布或管理平台。已有本地登录文件时拒绝覆盖，请先 `logout`。用户可从网页撤销单个设备；CLI 注销设备不会注销浏览器登录。设备身份与软件来源仍不证明 AI 已实际运行。

旧的密码登录命令保留兼容；需要先通过首次初始化创建管理员及成员：

```sh
node local-bridge/rd.mjs login --url http://127.0.0.1:5187 --username developer
node local-bridge/rd.mjs tasks
node local-bridge/rd.mjs context --task <任务UUID>
# 从 context 返回的 task.version 获取当前版本
node local-bridge/rd.mjs claim --task <任务UUID> --version <当前任务版本>
node local-bridge/rd.mjs assets --task <任务UUID>
node local-bridge/rd.mjs sync --task <任务UUID> --tool codex-cli --progress 60 --summary '接口字段已核对，等待联调' --branch feature/DEMO-1
node local-bridge/rd.mjs heartbeat --task <任务UUID> --tool codex-cli --status WORKING
node local-bridge/rd.mjs reviews --task <任务UUID>
node local-bridge/rd.mjs review-context --job <评审UUID>
node local-bridge/rd.mjs submit-report --job <评审UUID> --file ./review-report.json
node local-bridge/rd.mjs heartbeat --task <任务UUID> --tool codex-cli --status OFFLINE
node local-bridge/rd.mjs logout
```

登录时密码隐藏输入。非交互场景可经 stdin 提供密码；不要把密码放入参数、命令历史或输出。远程服务只允许 HTTPS，本机回环支持 HTTP。

`--tool` 支持 `codex`、`codex-cli`、`claude-code`、`cursor`、`custom`；它是此次上报来源标记，不代表平台已连接或控制对应软件。软件可通过终端调用 CLI，也可按下面的配置使用 MCP 工具。

`claim` 使用当前任务版本做并发检查，不能抢占已指派他人的任务。`heartbeat` 每次仅上报一条状态，可为 `IDLE`、`WORKING`、`WAITING`、`OFFLINE`；设备 ID 与该次 CLI 登录会话一致。在线状态和过期由服务端接收时间计算，不会启动后台轮询。

## 本地评审报告

先在平台为任务登记所需资产并申请 `LOCAL_REPORT` 模式评审，再读取 `review-context`。在本地 AI 软件会话中根据该输入生成 JSON 文件，明确审核文件内容后提交，例如：

```json
{
  "summary": "核对接口字段类型，仍有一项需人工确认。",
  "source": "LOCAL_TOOL",
  "tool": "codex-cli",
  "evidence": "本地检查说明与可复核位置；不要包含口令或认证数据。",
  "findings": [
    {
      "severity": "WARN",
      "title": "状态字段的空值约定待补充",
      "detail": "请确认空状态是否允许，并在接口契约中说明。",
      "location": "src/contracts/task.ts:12"
    }
  ]
}
```

报告文件须为普通 JSON 文件，最大 64 KiB；CLI 仅读取明确传入的这个文件。`source` 支持 `MANUAL`（对应人工评审）或 `LOCAL_TOOL`（对应本地报告），不接受 `CLOUD_AI` 执行声明。`LOCAL_TOOL` 是成员自报来源，不能证明平台或对应软件实际执行过审核；服务端会记录真实提交成员、输入快照和审批记录。CLI 不自动运行 AI、不自动批准报告，也不执行发现项建议。存在新资产版本、角色不允许或报告已提交时，以服务端拒绝结果为准。

只上传明确指定的任务 ID、工具来源、进度、摘要、分支及随机设备 ID。进度百分比是成员自报，不是测试通过或真实联调证据。CLI 不读取仓库 Diff、进程列表、IDE 对话、认证文件或环境密钥。Jira 关联与资产状态以服务返回为准，不会写入外部 Jira。

接口失败时原样显示服务返回的 `error.message`（包括 L 码）；仅缺失该字符串时使用 HTTP 状态反馈，不输出整个错误响应。

令牌保存在 `local-bridge/.local/session.json`（目录 0700、文件 0600，已忽略），不会打印。注销调用服务撤销令牌并清除这一会话文件；若网络失败，结果中的 `serverRevoked: false` 表示只清除了本地副本。`RD_HUB_STATE_DIR` 可指定独立状态目录。

## Codex、Claude Code、Cursor 的 MCP 接入

先用 `pair` 完成设备连接。推荐通过 `install-mcp --client codex|claude|cursor --project /明确目录` 安装项目配置；也可生成配置片段手动合并：

```sh
node local-bridge/mcp.mjs --print-config
```

命令输出当前 Node 可执行文件和 MCP 脚本的绝对路径，可直接合并到 Codex CLI 的 `config.toml`、Claude Code 项目 `.mcp.json`、Cursor 项目 `.cursor/mcp.json`。配置中没有令牌或密码，也不会自动写入这些文件。已有 MCP 配置应保留其他服务，仅合并 `taskflow` 节点。


`install-mcp` 仅修改明确项目中的 `.codex/config.toml`、`.mcp.json` 或 `.cursor/mcp.json`，不修改全局配置。它拒绝项目/配置目录/配置文件的符号链接；仅新增 `taskflow`，同名绑定相同则幂等、不同则拒绝。已有配置先保存 0600 备份，再原子写入并检查并发变化；保留其他节点。Codex 合并使用已安装原生 CLI 在临时 0700 `CODEX_HOME` 里解析/修改副本，不调用用户真实全局配置，不运行模型。配置里只有 Node/脚本绝对路径和 `RD_HUB_STATE_DIR` 目录，不写令牌。

配置写入后，需对应软件重新加载 MCP；Claude/Cursor 可能要求批准项目 MCP，Codex 项目配置需要项目受信任。安装成功不代表软件已经加载。`doctor` 通过官方 SDK 直接完成 MCP `initialize`、工具发现及认证 `task_list`，仅输出软件版本、配置状态、工具数、任务数和项目数，不显示任务正文或令牌。它验证的是桥接服务连通性，不代替 IDE 内的加载状态检查，也不会运行 AI。

### 自定义客户端适配器

支持标准 MCP stdio、JSON 根对象服务表的客户端可通过一个声明文件接入。网页「自定义客户端」可导入、编辑、导出此文件；文件仅描述配置格式，不含账号或可执行插件。CLI 也可生成模板：

```sh
node local-bridge/rd.mjs adapter-template > /明确位置/my-workbench.json
```

模板内容（六个字段全部必填，禁止额外字段）：

```json
{
  "schemaVersion": 1,
  "id": "generic-workbench",
  "name": "我的工作台",
  "configPath": ".mcp.json",
  "serversKey": "mcpServers",
  "includeType": true
}
```

`configPath` 是项目内最多四层的相对 JSON 路径；`serversKey` 是单个根对象键，不能使用嵌套表达式或原型键；`includeType` 控制是否写入 `type: "stdio"`。不支持 JSONC、数组配置、脚本、依赖安装、任意命令、环境凭据、URL、钩子或后台进程。描述文件上限 8 KiB；路径越界、保留凭据文件/目录和未知字段会拒绝。插件只选择配置结构，生成的服务始终是本平台固定的 Node + `mcp.mjs` + 私有状态目录引用。

```sh
node local-bridge/rd.mjs pair --name '我的工作台' --tool custom
node local-bridge/rd.mjs install-mcp --adapter /明确位置/my-workbench.json --project /明确项目目录
node local-bridge/rd.mjs doctor --adapter /明确位置/my-workbench.json --project /明确项目目录
# 需要手动合并时，仅输出标准 MCP JSON，不写文件
node local-bridge/rd.mjs export-mcp --adapter /明确位置/my-workbench.json
```

`--adapter` 与 `--client` 互斥。安装器沿用冲突拒绝、0600 备份、原子写入和并发检查，并逐层拒绝配置目录的符号链接。导出只含本机路径，不读取会话内容。`doctor` 在原三种检查外追加此适配器配置检查，仍直接用固定桥接服务验证九个工具与认证；不会执行适配器指定的软件。成功后需在对应客户端重载并实际调用 `task_list`，配置匹配不等于客户端已加载或 AI 已执行。

当前 Delivery Workspace 的原生自定义插件协议只支持声明式记录/Jira/会话引用，不支持注册 MCP。不能把此描述文件当成已安装的工作台原生插件。Codex 引擎可通过其 MCP 配置继续对接；Claude 等引擎是否加载配置需单独验证。原生插件菜单、工作台后台同步或新增宿主 MCP 注册 API 需要单独升级宿主扩展能力，本安装器不会修改或重启宿主工作台。

三种内置配置结构如下，路径以 `--print-config` 实际输出为准：

```toml
[mcp_servers.taskflow]
command = "/绝对路径/node"
args = ["/绝对路径/local-bridge/mcp.mjs"]
cwd = "/绝对路径/local-bridge"
```

Claude Code `.mcp.json`：

```json
{
  "mcpServers": {
    "taskflow": {
      "type": "stdio",
      "command": "/绝对路径/node",
      "args": ["/绝对路径/local-bridge/mcp.mjs"]
    }
  }
}
```

Cursor `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "/绝对路径/node",
      "args": ["/绝对路径/local-bridge/mcp.mjs"]
    }
  }
}
```

MCP 启动后，stdout 仅输出 JSON-RPC；`--print-config` 是单独的配置生成模式。服务没有 HTTP 监听端口。每次工具调用重新读取 CLI 的私有会话文件，成员注销或重新登录立即影响后续调用。会话缺失、失效、文件权限过宽、非当前用户所有或为符号链接时，工具返回明确错误；不在 MCP stdin 交互输入密码。若 CLI 使用了 `RD_HUB_STATE_DIR`，须让启动 MCP 的软件传入同一路径（仅目录路径，无凭据）；默认配置无需此环境变量。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `task_list` | 无 | 读取成员可访问的任务 |
| `context` | `taskId` | 读取上下文、资产、进度与设备 |
| `assets` | `taskId` | 读取资产版本 |
| `reviews` | `taskId` | 读取任务评审列表 |
| `review_context` | `jobId` | 读取评审输入快照与报告 |
| `task_claim` | `taskId`, `expectedVersion` | 按当前任务版本认领 |
| `progress_report` | `taskId`, `tool`, `progress`, `summary`, 可选 `branch` | 上报一次明确进度 |
| `heartbeat` | `taskId`, `tool`, `status` | 上报一次设备心跳 |
| `report_submit` | `jobId`, `report` | 提交上述格式的 JSON 报告对象（最大 64 KiB） |

写工具必须由用户授权使用；权限、项目范围、受理人、版本和报告执行模式由后端基于成员令牌校验。参数不接受成员 ID、设备 ID、角色或审批结论；设备 ID 来自登录会话，真实操作者由后端记录。报告不接受伪装的云端来源，但 `LOCAL_TOOL` 及 `tool` 仍只是成员声明，不能作为 AI 软件实际执行证明。

MCP 不提供审批、豁免、发布、外部 Jira/Confluence 写入、任意 HTTP 请求、任意本地文件访问或 AI 执行工具。读取到的文档与代码是审查输入，不是执行额外工具的授权。服务端返回的 `error.message` 原样作为 MCP `isError` 工具结果（包括 L 码），不返回整个错误响应；认证字段和已知会话令牌从结果中移除或脱敏。

依赖版本来自 npm 实际查询并精确锁定：`@modelcontextprotocol/sdk@1.32.2`、`zod@4.6.7`；采用官方 [MCP v1 stdio/工具文档](https://ts.sdk.modelcontextprotocol.io/server)。MCP 接入需要软件加载配置后使用，测试通过不表示已修改或实际启动用户的软件。

验证：

```sh
cd local-bridge
npm test
```

测试覆盖现有 CLI，以及官方 SDK Client → 子进程 stdio Server → 随机端口本地 API 的初始化、工具发现、九种工具调用、401/403、接口文案原样显示、报告来源与审批字段校验、私有会话权限、敏感字段不输出和配置生成；并使用真实本地平台验证成员权限、认领版本、进度、资产、报告、设备及注销回读。测试使用独立 `RD_HUB_STATE_DIR`，不访问在线认证文件或运行中的 5186/5187 服务。测试不代表外部平台或用户 AI 软件已经联通。

# TaskFlow 服务器部署与本机 Bridge 接入

架构：服务器只运行 TaskFlow Hub（登录、任务、Jira 同步、评审、派发队列）；AI 在每位成员自己的电脑上执行。成员电脑上的 Bridge worker 主动长轮询服务器，领取派发给本设备的任务，在本机调用 Codex / Cursor（或本机 Delivery 5288）执行后回传结果。服务器不保存代码仓库、不持有 AI 账号，也不会主动连入成员电脑。

```
浏览器 ──HTTPS──▶ Nginx(443) ──▶ TaskFlow API(127.0.0.1:5187, 服务器模式)
                                        ▲
成员电脑：rd.mjs worker ──HTTPS 长轮询──┘ ──▶ 本机 codex / cursor-agent / Delivery(127.0.0.1:5288)
```

## 一、服务器（管理员）

示例地址：`https://taskflow.example.com`，部署时替换为实际服务器地址（自签名证书，systemd + Nginx）。

| 内容 | 位置 |
| --- | --- |
| API 代码 | `/opt/taskflow/platform-server`（`taskflow-api.service`，用户 `taskflow`） |
| 网页静态文件 | `/opt/taskflow/web` |
| 配置 | `/etc/taskflow/taskflow.env`（root:taskflow 0640，模板见 `taskflow.env.example`） |
| 数据库 | `/var/lib/taskflow/platform.sqlite` |
| 备份 | `/var/backups/taskflow`（`taskflow-backup.timer` 每日 03:15，保留轮转） |
| 证书 | `/etc/ssl/taskflow/{fullchain,privkey}.pem`，公开证书另存于 `/opt/taskflow/web/taskflow-ca.pem` |

### 首次初始化管理员

初始化口令只保存在服务器配置中，请管理员自行查看（不要贴到聊天或工单里）：

```bash
ssh root@taskflow.example.com 'grep ^TASKFLOW_SETUP_TOKEN= /etc/taskflow/taskflow.env'
```

打开 `https://taskflow.example.com`，在登录页填写管理员用户名、密码和「初始化口令」完成创建。创建后可以把该行从配置中删除并 `systemctl restart taskflow-api`。之后在「成员」页添加成员并分配项目角色。

### 更新部署

```bash
# 本地仓库根目录
npm --prefix preview-app run build && npm run pack:bridge   # 网页 + 成员一键安装用的客户端包与脚本
tar czf /tmp/tf.tgz --exclude='*.test.mjs' platform-server/*.mjs platform-server/*.d.mts platform-server/package.json deploy -C preview-app dist
scp /tmp/tf.tgz root@taskflow.example.com:/tmp/
ssh root@taskflow.example.com 'set -e; systemctl start taskflow-backup.service
  rm -rf /tmp/tf && mkdir /tmp/tf && tar xzf /tmp/tf.tgz -C /tmp/tf
  cp /tmp/tf/platform-server/* /opt/taskflow/platform-server/ && cp -r /tmp/tf/deploy/. /opt/taskflow/deploy/
  rm -rf /opt/taskflow/web.new && cp -r /tmp/tf/dist /opt/taskflow/web.new && cp /etc/ssl/taskflow/fullchain.pem /opt/taskflow/web.new/taskflow-ca.pem
  rm -rf /opt/taskflow/web.old && mv /opt/taskflow/web /opt/taskflow/web.old && mv /opt/taskflow/web.new /opt/taskflow/web
  systemctl restart taskflow-api && curl -s http://127.0.0.1:5187/health'
```

数据库结构变更由服务启动时自动迁移；更新前的备份会写入 `/var/backups/taskflow`。

### 服务器模式的安全边界

- `TASKFLOW_DEPLOYMENT=server` 会关闭所有「本机」能力：本机 AI 执行、本机 Git 扫描/打开应用、host-bridge、5288 工作台交接。只保留经 Bridge 派发的执行。
- `/api/setup` 必须携带初始化口令；登录限流按 Nginx 传入的真实客户端 IP 计数（仅信任回环来源的 `X-Real-IP`）。
- Cookie 默认带 `Secure`；设备令牌有效期由 `TASKFLOW_DEVICE_SESSION_HOURS` 控制（默认 168 小时）。
- `TASKFLOW_BRIDGE_MODES` 控制允许派发的处理方式。当前实例为 `read,review,develop`；开发类派发还需成员本机显式开启并逐次确认。
- 每人同时最多 2 个进行中的派发；排队超过 30 分钟未领取、或领取后 60 秒无心跳，会标记为中断。

## 二、成员电脑接入 Bridge

前提：Node.js 24+，以及本机已登录的 `codex` 或 `cursor-agent`（或本机运行中的 Delivery 5288）。不需要 TaskFlow 源码。

### 一键安装（推荐）

```bash
curl -fsSk https://taskflow.example.com/install-bridge.sh -o /tmp/taskflow-install.sh && sh /tmp/taskflow-install.sh https://taskflow.example.com '张三的MacBook'
```

脚本会：下载服务器证书并请你核对指纹（也可预先设置 `TASKFLOW_CA_SHA256`），用该证书校验并下载客户端到 `~/.taskflow/app`，发起配对（在网页「本机接入」确认并勾选项目），生成 `~/.taskflow/state/worker.json`。重复运行即升级，配对与配置保留。

之后编辑 `worker.json`（字段见下文第 3 步），再执行：

```bash
~/.taskflow/bin/taskflow-bridge worker                      # 前台试运行
~/.taskflow/bin/taskflow-bridge service --action install    # macOS：登录后自动后台运行（launchd）
~/.taskflow/bin/taskflow-bridge service --action status     # 状态；日志在 ~/.taskflow/state/worker.log
```

### 团队派发

- 「本机接入 → 团队 Agent」列出项目内所有已接入的设备、在线状态和是否允许团队派发。
- 成员在「我的设备」打开「允许团队派发」后，项目负责人、PM 和管理员可在任务的本地 AI 执行里选择该成员的设备。默认关闭，随时可关。
- 派给他人的开发任务必须先指派给该成员，执行前仍在他本机弹窗确认（会显示派发人）。派发人和设备主人都能查看和停止这次执行。
- 每台设备同时最多 4 个排队或执行中的派发。

### 手动安装（源码目录）

前提：本仓库的 `local-bridge` 目录（无需安装依赖）。

### 1. 信任自签名证书（使用正式域名证书后可省略）

```bash
mkdir -p ~/.taskflow && curl -sk https://taskflow.example.com/taskflow-ca.pem -o ~/.taskflow/taskflow-ca.pem
openssl x509 -in ~/.taskflow/taskflow-ca.pem -noout -fingerprint -sha256
export NODE_EXTRA_CA_CERTS=~/.taskflow/taskflow-ca.pem   # 建议写入 ~/.zshrc
```

请把指纹与管理员公布的值核对一致后再继续（当前证书 SHA-256 指纹：`6F:FE:96:35:41:F0:D3:2C:FF:B7:9B:A0:1C:DE:FD:BD:20:14:E6:04:FB:C6:C9:23:8E:D1:DB:53:24:52:75:5B`）。

### 2. 配对设备

```bash
node local-bridge/rd.mjs pair --url https://taskflow.example.com --web-url https://taskflow.example.com --name "张三的MacBook" --tool codex-cli
```

终端会显示配对码。用自己的账号登录网页 →「本机接入」→ 设备授权，输入配对码并勾选允许该设备处理的项目。

### 3. 配置项目仓库映射

```bash
node local-bridge/rd.mjs worker-init          # 生成 local-bridge/.local/worker.json（0600，不会覆盖已有文件）
```

```json
{
  "projects": { "default": "/Users/zhangsan/code/business-repo" },
  "executor": "cli",
  "allowDevelop": false,
  "maxMinutes": 60
}
```

- `projects`：平台项目 ID → 本机仓库绝对路径。仓库路径只以本机配置为准，服务器下发的路径一律不使用。
- `executor`：`cli` 直接调用本机 `codex` / `cursor-agent`；`delivery` 交给本机 Delivery 5288 执行（见下文）。
- `engines`（可选）：`{"codex": "/绝对路径/codex", "cursor": "/绝对路径/cursor-agent"}`，找不到命令时使用。
- `allowDevelop`：是否接收开发类任务。即使为 `true`，每次执行前也会在本机弹窗（或终端）确认，2 分钟内未确认视为拒绝。
- `maxMinutes`：单个任务最长执行时间，超时自动停止并回传失败。

执行方式：分析和评审任务以只读方式运行在临时目录中（Codex 使用 `-s read-only`，可读取映射仓库）；开发任务在映射仓库中以 `workspace-write` 运行，不会自动 push。任务上下文写入本机临时目录（0600），执行结束后删除。

### 4. 启动 worker

```bash
node local-bridge/rd.mjs worker
```

保持终端运行即可接收任务；`Ctrl+C` 停止。网页上「执行位置」会显示「我的本机 Bridge · 设备名 · 在线」，派发后状态依次为排队、本机已领取、本机执行中；网页上点击停止会在 3 秒内终止本机进程。

### 使用本机 Delivery 5288 执行（可选）

Delivery 更新到包含 `server/taskflow-bridge.ts` 的版本并重启后，会在其数据目录生成 `taskflow-bridge/token`（0600）。worker.json 中设置：

```json
{
  "executor": "delivery",
  "delivery": { "url": "http://127.0.0.1:5288", "tokenFile": "/Delivery数据目录绝对路径/taskflow-bridge/token" }
}
```

任务会在 Delivery 中以 TaskFlow 会话运行（可在 5288 的 Agent 页面查看过程），结果仍回传到服务器。Delivery 的该入口只接受本机回环请求并要求携带令牌，浏览器页面无法调用。

### 同步 Delivery 的 Agent 会话与部署记录（可选）

一次性同步（`--project/--match` 可省略，省略时只同步 Agent 会话）：

```bash
taskflow-bridge sync-delivery --data-dir "/Delivery目录/.local/data" --project <平台项目ID> --match <Delivery部署项目名,名>
```

由后台 worker 定时同步：在 worker.json 加入

```json
{
  "deliverySync": { "dataDir": "/Delivery目录/.local/data", "deployments": { "<平台项目ID>": ["example-web"] }, "intervalMinutes": 10 }
}
```

- Agent 会话按 Delivery 的会话聚合，只上传标题、目标、最近一轮结果摘要、状态和用量；服务端会遮盖常见密钥并把 `/Users/<名>`、`/home/<名>` 改写为 `~`。同步后默认仅自己可见，在网页「Agent 记录」里勾选共享到项目后，项目成员才能查看和评论。
- 部署记录读取 Delivery 的云效、Jenkins 运行记录，按 `--match`/`deployments` 中的部署项目名（`*` 表示全部）写入对应平台项目，重复同步只更新状态。网页「部署记录」也可以手动登记。
- 同步进度保存在 `~/.taskflow/state/delivery-sync.json`，之后只推送有变化的会话。

### 同步团队 Skill 与使用知识库（可选）

项目负责人在网页「团队 Skill」发布或上传 SKILL.md 后，成员本机执行一次即可写入：

```bash
taskflow-bridge skills-sync --target ~/.codex/skills
```

或在 worker.json 加入定时同步（`targets` 可写多个，如 Codex 与 Cursor 的 Skill 目录，目录的上级必须已存在）：

```json
{
  "skillSync": { "targets": ["/Users/<名>/.codex/skills", "/Users/<名>/.cursor/skills"], "intervalMinutes": 30 }
}
```

- 每个 Skill 写到 `taskflow-<项目KEY小写>-<名称>/SKILL.md`，并放置 `.taskflow-skill.json` 标记；本机已有的同名目录不会被覆盖（记为冲突跳过），停用或删除的团队 Skill 只会移除带标记的目录。
- 只下发设备已授权项目中启用的 Skill；frontmatter 的 `name`、`description` 由平台生成。
- 网页「知识库」维护项目文档，可导入 Markdown 文件或 Delivery 的 `.local/data/system-catalog/catalog.json`（导入时丢弃账号密码）。重新安装 Bridge 后，本地 AI 可通过 MCP 工具 `knowledge_search`、`knowledge_doc` 检索与读取。

## 三、排障

| 现象 | 处理 |
| --- | --- |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | 未设置 `NODE_EXTRA_CA_CERTS`，见第二节第 1 步 |
| 网页提示没有可接收该项目任务的 Bridge | 设备授权时未勾选该项目，或设备已过期；重新 pair |
| 一直「排队等待本机领取」 | 本机未运行 `rd.mjs worker`，或 worker 连接失败（查看终端日志） |
| worker 提示设备会话失效 | `node local-bridge/rd.mjs logout` 后重新 pair |
| 开发任务直接失败「未开启开发类任务」 | worker.json 中 `allowDevelop` 为 false，或未映射该项目仓库 |
| Delivery 执行器连接失败 | 5288 未运行或尚未更新到包含 Bridge 入口的版本 |

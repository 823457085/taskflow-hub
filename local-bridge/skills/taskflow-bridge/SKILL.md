---
name: taskflow-bridge
description: 在 TaskFlow AI Hub 与本地工作台（Codex / Gemini / Antigravity）、Codex CLI、Antigravity CLI 之间读取任务和材料、加载开发上下文，并按用户明确要求认领任务、回传进度或提交评审报告；不用于直接修改外部 Jira 或触发发布。
---

# TaskFlow 本地协同

平台网页：http://127.0.0.1:5186/ 。已配置的 MCP 服务名为 `taskflow`，以当前成员的受限设备身份访问明确批准的项目。

- 查看任务先调用 `task_list`，它返回可访问项目的任务，不等于仅本人未完成待办；按实际受理人和原状态说明范围。用户给出 Jira 号时，在返回列表中按原号定位，再使用返回的本地任务 ID 调用 `context`；不要把 Jira 号当作本地 ID，也不要猜测不存在的任务。
- `context` 返回中的 `workspace.repoPath`（若已配置）表示该成员为所属项目绑定的本地代码目录，开发或代码评审前应与当前会话工作目录核对一致。
- 开发前按需要读取 `assets`、`reviews`，评审任务用 `review_context` 获取输入快照。平台原始状态和字段原样保留。
- 用户明确要求认领时，用当前版本调用 `task_claim`；明确给出或认可的进度/摘要可调用 `progress_report`；完成评审并获提交授权后使用 `report_submit`。这几项权限互不替代，不自动改派、审批或推进外部 Jira。
- 进度和本地工具来源是成员上报；不要凭进程存在、构建成功或配置存在就报告模型已运行、评审通过或已上线。只在用户要求时发送相应状态的 `heartbeat`，或按用户要求运行 `taskflow-hub start --task <任务ID或Jira号> --tool custom [--repo <仓库目录>]` 开启伴随心跳与 Git 新提交进度上报。
- 401/登录失效时保留当前开发工作，停止重复调用，引导用户在已登录的平台网页 `http://127.0.0.1:5186/#view=local` 点击「一键授权接通本机 AI」（无需临时终端端口或配对码），或使用下面的诊断命令核实授权。不读取浏览器认证、本地 AI 的 auth.json，也不修改数据库延长授权。授权恢复后每次 MCP 调用会自动读取最新本机会话，无需重复安装配置。

无 MCP 工具或需要定位连接时，当前本机桥接命令为：

```sh
taskflow-hub doctor
taskflow-hub tasks
taskflow-hub start --task SAMPLE-562 --tool custom --mode once
taskflow-hub connect --name 我的开发电脑 --tool custom
```

命令输出与 MCP 执行分别核对；不要将服务可启动或发现工具等同于授权已生效。工作台使用 Codex 或 Gemini/Antigravity 引擎时均可读取已注册的 `taskflow` MCP 与本 Skill；新会话启动后生效。

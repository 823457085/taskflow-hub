import type { AssetKind, ExecutionMode, Finding, FindingCategory, RiskLevel, Role, Stage, TaskStatus, WorkTask } from './workspaceApi.ts';

const TASK_STATUS_MAP: Record<TaskStatus, string> = {
  OPEN: '待开始',
  IN_PROGRESS: '进行中',
  IN_REVIEW: '评审中',
  DONE: '已完成',
};

const TASK_TYPE_MAP: Record<WorkTask['type'], string> = {
  STORY: '需求故事',
  TASK: '研发任务',
  BUG: '缺陷修复',
  RELEASE: '版本发布',
};

const STAGE_MAP: Record<Stage, string> = {
  PRD: '需求评审',
  TASK_BREAKDOWN: '任务拆分审核',
  TECH_SPEC: '技术方案审核',
  CODE_REVIEW: '代码审核',
  TEST_CASE: '测试用例评审',
  RELEASE: '上线审核',
};

const ASSET_KIND_MAP: Record<AssetKind, string> = {
  PRD: '需求文档',
  TECH_SPEC: '技术方案',
  CODE: '代码改动',
  TEST_CASE: '测试用例',
  RELEASE_PLAN: '上线计划',
};

const REVIEW_STATUS_MAP: Record<string, string> = {
  PENDING: '待提交报告',
  AWAITING_CONFIGURATION: '待配置执行器',
  AWAITING_REVIEW: '待人工评审',
  AWAITING_REPORT: '待提交报告',
  REPORT_SUBMITTED: '待审批',
  APPROVED: '已通过',
  CHANGES_REQUESTED: '需修改',
  REJECTED: '已退回',
  STALE: '材料已更新·需重审',
};

const DECISION_MAP: Record<string, string> = {
  APPROVE: '已批准放行',
  APPROVED: '已批准放行',
  REQUEST_CHANGES: '退回修改',
  CHANGES_REQUESTED: '退回修改',
};

const EXECUTION_MODE_MAP: Record<ExecutionMode, string> = {
  LOCAL_REPORT: '本地 AI / 工具评审',
  HUMAN_REVIEW: '人工评审',
  CLOUD_AI: '云端 AI（未启用）',
};

const REPORT_SOURCE_MAP: Record<string, string> = {
  LOCAL_TOOL: '本地 AI 工具',
  MANUAL: '人工填写',
  CLOUD_AI: '云端 AI',
};

const SEVERITY_MAP: Record<Finding['severity'], string> = {
  CRITICAL: '阻断问题',
  WARN: '风险提醒',
  INFO: '改进建议',
};

const GATE_STATUS_MAP: Record<string, string> = {
  PASS: '已通过',
  BLOCKED: '存在阻断项',
  CHANGES_REQUESTED: '需修改后重审',
  MISSING_INPUT: '缺少材料',
  MISSING_ASSET: '缺少材料',
  PENDING: '待发起评审',
  AWAITING_REVIEW: '待发起评审',
  AWAITING_REPORT: '待提交报告',
  REPORT_SUBMITTED: '待审批',
  AWAITING_DECISION: '待审批',
  STALE: '材料已更新·需重审',
  STALE_REVIEW: '材料已更新·需重审',
  UPSTREAM_INCOMPLETE: '待前置门禁通过',
};

const ROLE_MAP: Record<string, string> = {
  ADMIN: '系统管理员',
  LEAD: '项目负责人',
  PM: '产品经理',
  DEV: '研发工程师',
  QA: '测试工程师',
  SRE: '运维发布',
  VIEWER: '只读成员',
};

const CONNECTOR_STATUS_MAP: Record<string, string> = {
  CONNECTED: '已连通',
  CONFIGURED: '已保存凭据',
  UNCONFIGURED: '未配置',
  ERROR: '连接异常',
  AUTH_FAILED: '认证失败',
  UNREACHABLE: '无法访问',
  ACCOUNT_UNAVAILABLE: '所选账号不可用',
  DISABLED: '已停用',
};

const AUTH_MODE_MAP: Record<string, string> = {
  BEARER: '访问令牌（Bearer）',
  BASIC: '账号密码 / API 令牌',
  PRIVATE_TOKEN: '私有令牌（Token）',
  NONE: '免认证',
};

const DEVICE_STATUS_MAP: Record<string, string> = {
  ACTIVE: '生效中',
  EXPIRED: '已过期',
  REVOKED: '已撤销',
};

const PAIRING_STATUS_MAP: Record<string, string> = {
  PENDING: '待确认',
  APPROVED: '已批准',
  DENIED: '已拒绝',
  CONSUMED: '已完成配对',
};

const HEARTBEAT_STATUS_MAP: Record<string, string> = {
  WORKING: '处理中',
  IDLE: '在线空闲',
  WAITING: '等待确认',
  OFFLINE: '已离线',
};

const AI_RUN_STATUS_MAP: Record<string, string> = {
  RUNNING: '正在执行',
  SUCCEEDED: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '已手动停止',
  INTERRUPTED: '已中断',
};

const AI_RUN_MODE_MAP: Record<string, string> = {
  read: '任务分析',
  develop: '开发协作',
  review: '本地评审',
};

const MR_STATE_MAP: Record<string, string> = {
  OPENED: '待合并',
  OPEN: '待合并',
  open: '待合并',
  opened: '待合并',
  MERGED: '已合并',
  merged: '已合并',
  CLOSED: '已关闭',
  closed: '已关闭',
};

const PERSONA_MAP: Record<string, string> = {
  'ai-pm': 'AI 产品经理',
  'ai-delivery-lead': 'AI 交付负责人',
  'ai-architect': 'AI 架构师',
  'ai-reviewer': 'AI 代码审查员',
  'ai-qa': 'AI 测试工程师',
  'ai-sre': 'AI 运维发布',
  'legacy-unrecorded': '历史未记录视角',
};

const SKILL_MAP: Record<string, string> = {
  'prd-completeness-audit': '需求完整性核查',
  'state-machine-validator': '状态机流转校验',
  'requirement-coverage-map': '需求点覆盖映射',
  'subtask-granularity-check': '子任务粒度与依赖核查',
  'prd-techspec-align': '需求与技术方案对齐',
  'golden-contract-extractor': '核心接口契约提取',
  'cross-repo-contract-diff': '跨仓契约与改动比对',
  'fe-security-and-perf': '安全与性能扫描',
  'ac-blackbox-coverage': '验收标准黑盒覆盖',
  'whitebox-branch-scanner': '白盒异常分支扫描',
  'release-rbom-audit': '上线物料清单核查',
  'release-dependency-check': '发布依赖项检查',
};

const TOOL_MAP: Record<string, string> = {
  codex: 'Codex',
  'codex-cli': 'Codex CLI',
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  cursor: 'Cursor Agent',
  antigravity: 'Gemini / Antigravity',
  custom: 'Gemini / 自定义客户端',
};

const MCP_TOOL_MAP: Record<string, string> = {
  task_list: '任务列表检索',
  context: '读取任务与仓库上下文',
  assets: '读取材料版本',
  reviews: '读取评审记录',
  review_context: '读取冻结评审快照',
  knowledge_search: '检索团队知识库',
  knowledge_doc: '读取知识库文档',
  task_claim: '认领任务',
  progress_report: '上报开发进度',
  heartbeat: '记录会话心跳',
  report_submit: '提交评审报告',
};

export const DEFAULT_APPROVE_REASON = '已完成对照核验，无阻断项，准予放行';

export const APPROVAL_REASON_PRESETS: readonly string[] = [
  '已完成对照核验，无阻断项，准予放行',
  '边界条件与异常分支已核对，符合交付要求',
  '单账号核验无误，同意进入下一阶段',
];

export const REJECTION_REASON_PRESETS: readonly string[] = [
  '需补充异常分支与幂等性处理说明',
  '实现逻辑与需求文档存在偏差，请对齐后重审',
  '缺少关键验证用例或回滚预案，请补齐',
];

export const REPORT_SUMMARY_PRESETS: Record<Stage, readonly string[]> = {
  TASK_BREAKDOWN: [
    '研发任务承接需求范围，子任务覆盖全部需求点，粒度与依赖合理。',
    '子任务拆分基本完整，建议补充联调 / 自测子任务并明确计划。',
  ],
  PRD: [
    '已核对业务目标、状态机流转与验收标准，边界清晰，无阻断问题。',
    '需求主流程完整，建议补充极端异常提示文案说明。',
  ],
  TECH_SPEC: [
    '技术方案与需求对齐，接口契约、幂等性与降级回滚策略明确，无阻断项。',
    '核心数据模型与调用链路合理，已核查上下游兼容性。',
  ],
  CODE_REVIEW: [
    '代码改动与技术方案一致，异常分支、权限校验与并发安全已核查通过。',
    '改动范围收敛，无敏感凭据硬编码或跨仓契约破坏问题。',
  ],
  TEST_CASE: [
    '正向主链路、边界条件与异常分支用例覆盖充分，准予进入上线审核。',
    '核心验收标准均已映射可执行的黑盒与回归验证用例。',
  ],
  RELEASE: [
    '前置门禁、变更配置清单、监控告警与回滚预案均已核验就绪。',
    '发布顺序与依赖项检查无误，满足上线放行条件。',
  ],
};

export const WAIVER_REASON_PRESETS: readonly string[] = [
  '已由上游网关与幂等锁兜底，本轮上线风险可控，后续迭代专项收敛',
  '属存量兼容逻辑限制，已补充监控告警并登记跟进任务',
  '仅影响内部低频管理路径，已确认应急回滚步骤，同意本轮豁免',
];

const FINDING_CATEGORY_MAP: Record<FindingCategory, string> = {
  CORRECTNESS: '逻辑正确性',
  SECURITY: '安全合规',
  SPEC_ALIGN: '需求对齐',
  CONTRACT: '接口契约',
  TESTS: '测试覆盖',
  MAINTAINABILITY: '可维护性',
};

const RISK_LEVEL_MAP: Record<RiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

export const findingCategoryLabel = (category?: string | null): string =>
  category ? FINDING_CATEGORY_MAP[category as FindingCategory] || category : '';

export const riskLevelLabel = (risk?: string | null): string =>
  risk ? RISK_LEVEL_MAP[risk as RiskLevel] || risk : '';

export const taskStatusLabel = (status?: string | null): string =>
  status ? TASK_STATUS_MAP[status as TaskStatus] || status : '—';

export const taskTypeLabel = (type?: string | null): string =>
  type ? TASK_TYPE_MAP[type as WorkTask['type']] || type : '—';

export const stageLabel = (stage?: string | null): string =>
  stage ? STAGE_MAP[stage as Stage] || stage : '—';

export const assetKindLabel = (kind?: string | null): string =>
  kind ? ASSET_KIND_MAP[kind as AssetKind] || kind : '—';

export const reviewStatusLabel = (status?: string | null): string =>
  status ? REVIEW_STATUS_MAP[status] || status : '—';

export const decisionLabel = (decision?: string | null): string =>
  decision ? DECISION_MAP[decision] || decision : '—';

export const executionModeLabel = (mode?: string | null): string =>
  mode ? EXECUTION_MODE_MAP[mode as ExecutionMode] || mode : '—';

export const reportSourceLabel = (source?: string | null): string =>
  source ? REPORT_SOURCE_MAP[source] || source : '—';

export const severityLabel = (severity?: string | null): string =>
  severity ? SEVERITY_MAP[severity as Finding['severity']] || severity : '—';

export const gateStatusLabel = (status?: string | null): string =>
  status ? GATE_STATUS_MAP[status] || status : '—';

export const roleLabel = (role?: string | null): string =>
  role ? ROLE_MAP[role] || role : '—';

export const connectorStatusLabel = (status?: string | null): string =>
  status ? CONNECTOR_STATUS_MAP[status] || status : '未配置';

export const authModeLabel = (mode?: string | null): string =>
  mode ? AUTH_MODE_MAP[mode] || mode : '—';

export const deviceStatusLabel = (status?: string | null): string =>
  status ? DEVICE_STATUS_MAP[status] || status : '—';

export const deviceScopeLabel = (scope?: string | null): string =>
  scope === 'LOCAL_BRIDGE' ? '本机桥接' : scope || '—';

export const pairingStatusLabel = (status?: string | null): string =>
  status ? PAIRING_STATUS_MAP[status] || status : '—';

export const heartbeatStatusLabel = (status?: string | null): string =>
  status ? HEARTBEAT_STATUS_MAP[status] || status : '—';

export const aiRunStatusLabel = (status?: string | null): string =>
  status ? AI_RUN_STATUS_MAP[status] || status : '—';

const BRIDGE_PHASE_MAP: Record<string, string> = { QUEUED: '排队等待本机领取', CLAIMED: '本机已领取', EXECUTING: '本机执行中' };

export const runLocationLabel = (run: { runner?: string; status: string; bridgePhase?: string | null; cancelRequested?: boolean }): string => {
  if (run.runner === 'workbench') return '5288 工作台 · ';
  if (run.runner !== 'bridge') return '';
  if (run.status !== 'RUNNING') return '本机 Bridge · ';
  if (run.cancelRequested) return '本机 Bridge · 停止中 · ';
  return `本机 Bridge · ${BRIDGE_PHASE_MAP[run.bridgePhase || ''] || '处理中'} · `;
};

export const aiRunModeLabel = (mode?: string | null): string =>
  mode ? AI_RUN_MODE_MAP[mode] || mode : '—';

export const mrStateLabel = (state?: string | null): string =>
  state ? MR_STATE_MAP[state] || state : '—';

export const personaLabel = (persona?: string | null): string =>
  persona ? PERSONA_MAP[persona] || persona : '—';

export const skillLabel = (skill?: string | null): string =>
  skill ? SKILL_MAP[skill] || skill : '—';

export const skillsLabel = (skills?: readonly string[] | null): string => {
  if (!skills || !skills.length) return '—';
  return skills.map(item => skillLabel(item)).join('、');
};

export const toolLabel = (tool?: string | null): string =>
  tool ? TOOL_MAP[tool] || tool : '—';

export const mcpToolLabel = (tool?: string | null): string =>
  tool ? MCP_TOOL_MAP[tool] || tool : '—';

export const REPORT_TOOL_OPTIONS: { value: string; label: string }[] = (
  ['codex-cli', 'codex', 'antigravity', 'cursor', 'claude-code', 'custom'] as const
).map(value => ({ value, label: TOOL_MAP[value] }));

export const gitBranchLabel = (branch?: string | null): string => {
  const trimmed = typeof branch === 'string' ? branch.trim() : '';
  if (!trimmed || trimmed === 'HEAD') return '直接指向提交（未切分支）';
  return trimmed;
};

export const TASK_STATUS_OPTIONS: { value: TaskStatus; label: string }[] = (
  ['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const
).map(value => ({ value, label: TASK_STATUS_MAP[value] }));

export const TASK_TYPE_OPTIONS: { value: WorkTask['type']; label: string }[] = (
  ['STORY', 'TASK', 'BUG', 'RELEASE'] as const
).map(value => ({ value, label: TASK_TYPE_MAP[value] }));

export const ASSET_KIND_OPTIONS: { value: AssetKind; label: string }[] = (
  ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN'] as const
).map(value => ({ value, label: ASSET_KIND_MAP[value] }));

export const SEVERITY_OPTIONS: { value: Finding['severity']; label: string }[] = (
  ['CRITICAL', 'WARN', 'INFO'] as const
).map(value => ({ value, label: SEVERITY_MAP[value] }));

export const progressSourceLabel = (tool?: string | null, deviceId?: string | null): string =>
  deviceId === 'web-workbench' ? '网页工作台' : toolLabel(tool);

export const assetMetaCodeLabel = (kind?: string | null, logicalKey?: string | null, revision?: number | null): string => {
  const kindText = assetKindLabel(kind);
  const cleanKey = typeof logicalKey === 'string' ? logicalKey.trim() : '';
  const showKey = !!cleanKey && cleanKey !== kind;
  const revText = typeof revision === 'number' ? ` · r${revision}` : '';
  return showKey ? `${kindText} · ${cleanKey}${revText}` : `${kindText}${revText}`;
};

export const formatSubmittedReportMarkdown = (
  stage: Stage,
  report: { summary: string; evidence?: string | null },
  findings: readonly Pick<Finding, 'severity' | 'title' | 'detail' | 'location' | 'waiver'>[],
): string => {
  const lines = [
    `## ${stageLabel(stage)}报告`,
    '',
    report.summary.trim(),
  ];
  if (report.evidence?.trim()) {
    lines.push('', '### 验证依据', report.evidence.trim());
  }
  if (findings.length) {
    lines.push('', `### 发现项（${findings.length}）`);
    for (const item of findings) {
      const loc = item.location ? ` \`${item.location}\`` : '';
      const waived = item.waiver ? `（已豁免：${item.waiver.reason}）` : '';
      lines.push(`- **[${severityLabel(item.severity)}]** ${item.title}${loc}${waived}：${item.detail}`);
    }
  }
  return lines.join('\n');
};

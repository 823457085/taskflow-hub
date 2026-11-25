export interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  targetId: string | null;
  createdAt: string;
  projectId: string | null;
}

export type AuditCategory = 'all' | 'task' | 'asset' | 'review' | 'access' | 'integration';

export interface AuditActionMeta {
  label: string;
  category: Exclude<AuditCategory, 'all'>;
  badgeVariant: 'blue' | 'green' | 'warn' | 'neutral';
}

export const AUDIT_CATEGORY_OPTIONS: { value: AuditCategory; label: string }[] = [
  { value: 'all', label: '全部事件' },
  { value: 'review', label: '门禁与评审' },
  { value: 'task', label: '任务流转' },
  { value: 'asset', label: '材料与仓库' },
  { value: 'access', label: '成员与安全' },
  { value: 'integration', label: '连接与配置' },
];

const AUDIT_ACTION_MAP: Record<string, AuditActionMeta> = {
  // 任务流转
  TASK_CREATE: { label: '手动登记任务', category: 'task', badgeVariant: 'blue' },
  TASK_UPDATE: { label: '更新任务状态或信息', category: 'task', badgeVariant: 'neutral' },
  TASK_CLAIM: { label: '认领开发任务', category: 'task', badgeVariant: 'blue' },
  TASK_DELETE: { label: '移出本地任务', category: 'task', badgeVariant: 'warn' },
  PROGRESS_REPORT: { label: '上报开发进度', category: 'task', badgeVariant: 'neutral' },
  JIRA_IMPORT: { label: '接入 Jira 任务', category: 'task', badgeVariant: 'blue' },
  JIRA_SYNC_UPDATE: { label: '同步更新 Jira 任务', category: 'task', badgeVariant: 'neutral' },
  JIRA_SYNC_PRUNE: { label: '清理非本人/已结项任务', category: 'task', badgeVariant: 'warn' },
  JIRA_PARENT_LINK: { label: '关联 Jira 父任务', category: 'task', badgeVariant: 'neutral' },
  TODO_CREATE: { label: '新建待办', category: 'task', badgeVariant: 'blue' },
  TODO_UPDATE: { label: '更新待办', category: 'task', badgeVariant: 'neutral' },
  TODO_DELETE: { label: '删除待办', category: 'task', badgeVariant: 'warn' },
  TODO_IMPORT: { label: '从 Delivery 导入待办', category: 'task', badgeVariant: 'blue' },
  AGENT_SESSION_SYNC: { label: '同步 Agent 会话记录', category: 'task', badgeVariant: 'neutral' },
  AGENT_SESSION_SHARE: { label: '共享 Agent 会话到项目', category: 'task', badgeVariant: 'blue' },
  AGENT_SESSION_UNSHARE: { label: '取消共享 Agent 会话', category: 'task', badgeVariant: 'warn' },
  AGENT_SESSION_COMMENT: { label: '评论 Agent 会话', category: 'task', badgeVariant: 'neutral' },
  AGENT_SESSION_DELETE: { label: '删除 Agent 会话记录', category: 'task', badgeVariant: 'warn' },
  DEPLOYMENT_RECORD: { label: '登记部署', category: 'task', badgeVariant: 'blue' },
  DEPLOYMENT_UPDATE: { label: '更新部署记录', category: 'task', badgeVariant: 'neutral' },
  DEPLOYMENT_DELETE: { label: '删除部署记录', category: 'task', badgeVariant: 'warn' },
  DEPLOYMENT_SYNC: { label: '同步流水线部署记录', category: 'task', badgeVariant: 'neutral' },
  KNOWLEDGE_CREATE: { label: '新建知识文档', category: 'asset', badgeVariant: 'blue' },
  KNOWLEDGE_UPDATE: { label: '编辑知识文档', category: 'asset', badgeVariant: 'neutral' },
  KNOWLEDGE_IMPORT: { label: '导入知识文档', category: 'asset', badgeVariant: 'neutral' },
  KNOWLEDGE_DELETE: { label: '删除知识文档', category: 'asset', badgeVariant: 'warn' },
  SKILL_PUBLISH: { label: '发布团队 Skill', category: 'integration', badgeVariant: 'blue' },
  SKILL_UPDATE: { label: '更新团队 Skill', category: 'integration', badgeVariant: 'neutral' },
  SKILL_ENABLE: { label: '启用团队 Skill', category: 'integration', badgeVariant: 'neutral' },
  SKILL_DISABLE: { label: '停用团队 Skill', category: 'integration', badgeVariant: 'warn' },
  SKILL_DELETE: { label: '删除团队 Skill', category: 'integration', badgeVariant: 'warn' },

  // 材料与仓库
  ASSET_VERSION_CREATE: { label: '登记材料新版本', category: 'asset', badgeVariant: 'blue' },
  ASSET_GIT_CAPTURE: { label: '提取本地 Git 代码改动', category: 'asset', badgeVariant: 'blue' },
  API_SPEC_IMPORT: { label: '导入 OpenAPI / Apifox 接口契约', category: 'asset', badgeVariant: 'blue' },
  WEBHOOK_ASSET_SYNC: { label: 'Webhook 自动同步材料', category: 'asset', badgeVariant: 'blue' },
  CONNECTOR_ASSET_IMPORT: { label: '从外部平台导入材料', category: 'asset', badgeVariant: 'blue' },
  PROJECT_WORKSPACE_SET: { label: '绑定项目本地代码库', category: 'asset', badgeVariant: 'green' },
  PROJECT_WORKSPACE_CLEAR: { label: '解绑项目本地代码库', category: 'asset', badgeVariant: 'warn' },
  LOCAL_REPO_OPEN: { label: '在本机工具打开仓库', category: 'asset', badgeVariant: 'neutral' },

  // 门禁与评审
  REVIEW_REQUEST: { label: '发起阶段评审', category: 'review', badgeVariant: 'blue' },
  REVIEW_REPORT: { label: '提交评审报告', category: 'review', badgeVariant: 'blue' },
  CLOUD_AI_REPORT: { label: '云端 AI 提交评审报告', category: 'review', badgeVariant: 'green' },
  MR_REVIEW_WRITEBACK: { label: '回写评审意见到 MR', category: 'review', badgeVariant: 'blue' },
  REVIEW_DECISION: { label: '提交门禁审批结论', category: 'review', badgeVariant: 'green' },
  FINDING_WAIVER: { label: '豁免阻断发现项', category: 'review', badgeVariant: 'warn' },
  LOCAL_AI_RUN_START: { label: '启动本机 AI 执行', category: 'review', badgeVariant: 'blue' },
  LOCAL_AI_RUN_STOP: { label: '停止本机 AI 执行', category: 'review', badgeVariant: 'warn' },
  CLOUD_AI_CONFIG: { label: '配置云端 AI 执行器', category: 'integration', badgeVariant: 'blue' },
  CLOUD_AI_TEST: { label: '验证云端 AI 连通性', category: 'integration', badgeVariant: 'green' },
  WEBHOOK_CREATE: { label: '创建自动触发 Webhook', category: 'integration', badgeVariant: 'blue' },
  WEBHOOK_UPDATE: { label: '更新 Webhook 配置', category: 'integration', badgeVariant: 'neutral' },
  WEBHOOK_DELETE: { label: '删除 Webhook 配置', category: 'integration', badgeVariant: 'warn' },
  IM_WEBHOOK_CREATE: { label: '创建 IM 群通知机器人', category: 'integration', badgeVariant: 'blue' },
  IM_WEBHOOK_UPDATE: { label: '更新 IM 群通知机器人', category: 'integration', badgeVariant: 'neutral' },
  IM_WEBHOOK_DELETE: { label: '删除 IM 群通知机器人', category: 'integration', badgeVariant: 'warn' },
  IM_WEBHOOK_TEST: { label: '测试 IM 通知推送', category: 'integration', badgeVariant: 'green' },
  PLUGIN_DELETE: { label: '移出项目策略插件', category: 'integration', badgeVariant: 'warn' },
  PLUGIN_REMOVE: { label: '移出项目策略插件', category: 'integration', badgeVariant: 'warn' },

  // 成员与安全
  USER_SETUP: { label: '创建初始管理员', category: 'access', badgeVariant: 'green' },
  USER_CREATE: { label: '创建平台成员', category: 'access', badgeVariant: 'blue' },
  LOGIN: { label: '登录工作台', category: 'access', badgeVariant: 'neutral' },
  LOGOUT: { label: '退出登录', category: 'access', badgeVariant: 'neutral' },
  PASSWORD_CHANGE: { label: '修改本人密码', category: 'access', badgeVariant: 'neutral' },
  LOCAL_DEVICE_TEAM_DISPATCH_ON: { label: '开启设备团队派发', category: 'access', badgeVariant: 'warn' },
  LOCAL_DEVICE_TEAM_DISPATCH_OFF: { label: '关闭设备团队派发', category: 'access', badgeVariant: 'neutral' },
  PASSWORD_RESET: { label: '重置成员密码', category: 'access', badgeVariant: 'warn' },
  PROJECT_CREATE: { label: '新建本地项目', category: 'access', badgeVariant: 'green' },
  PROJECT_RENAME: { label: '修改项目名称', category: 'access', badgeVariant: 'neutral' },
  PROJECT_DELETE: { label: '删除项目', category: 'access', badgeVariant: 'warn' },
  PROJECT_MEMBER_SET: { label: '变更项目成员角色', category: 'access', badgeVariant: 'warn' },
  LOCAL_DEVICE_CONNECTED: { label: '连接本机桥接设备', category: 'access', badgeVariant: 'green' },
  LOCAL_DEVICE_HOST_CONNECTED: { label: '自动接入宿主桥接', category: 'access', badgeVariant: 'green' },
  LOCAL_DEVICE_APPROVE: { label: '批准设备配对', category: 'access', badgeVariant: 'green' },
  LOCAL_DEVICE_DENY: { label: '拒绝设备配对', category: 'access', badgeVariant: 'warn' },
  LOCAL_DEVICE_REVOKE: { label: '吊销设备授权', category: 'access', badgeVariant: 'warn' },

  // 连接与配置
  CONNECTOR_CONFIGURE: { label: '配置平台连接器', category: 'integration', badgeVariant: 'blue' },
  CONNECTOR_TEST: { label: '验证平台连接器', category: 'integration', badgeVariant: 'neutral' },
  CONNECTOR_REUSE_LOCAL: { label: '复用本机连接器配置', category: 'integration', badgeVariant: 'blue' },
  JIRA_PROJECT_SYNC: { label: '同步 Jira 项目目录', category: 'integration', badgeVariant: 'blue' },
  ACCOUNT_CREATE: { label: '新增外部凭据账号', category: 'integration', badgeVariant: 'blue' },
  ACCOUNT_UPDATE: { label: '更新外部凭据账号', category: 'integration', badgeVariant: 'neutral' },
  ACCOUNT_DELETE: { label: '移除外部凭据账号', category: 'integration', badgeVariant: 'warn' },
  ACCOUNT_SELECT: { label: '切换默认使用账号', category: 'integration', badgeVariant: 'neutral' },
  ACCOUNT_TEST: { label: '验证外部凭据账号', category: 'integration', badgeVariant: 'neutral' },
  PLUGIN_REGISTER: { label: '登记项目门禁插件', category: 'integration', badgeVariant: 'green' },
};

export function describeAuditAction(action: string): AuditActionMeta {
  return (
    AUDIT_ACTION_MAP[action] || {
      label: action,
      category: 'integration',
      badgeVariant: 'neutral',
    }
  );
}

export interface ParsedAuditQuery {
  actorFilter: string;
  actionFilter: string;
  terms: string[];
}

export function parseAuditSearchQuery(rawQuery: string): ParsedAuditQuery {
  let actorFilter = '';
  let actionFilter = '';
  const terms: string[] = [];

  for (const token of (rawQuery || '').trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower.startsWith('actor:') && token.length > 6) {
      actorFilter = lower.slice(6);
    } else if (lower.startsWith('action:') && token.length > 7) {
      actionFilter = lower.slice(7);
    } else {
      terms.push(lower);
    }
  }

  return { actorFilter, actionFilter, terms };
}

export function filterAuditRecords(
  records: readonly AuditRecord[],
  options: {
    category?: AuditCategory;
    query?: string;
    resolveActorName?: (actorId: string) => string;
    resolveTargetLabel?: (record: AuditRecord) => string;
  } = {},
): AuditRecord[] {
  const {
    category = 'all',
    query = '',
    resolveActorName = id => id,
    resolveTargetLabel = rec => rec.targetId || '',
  } = options;
  const parsed = parseAuditSearchQuery(query);

  return records.filter(rec => {
    const meta = describeAuditAction(rec.action);
    if (category !== 'all' && meta.category !== category) return false;

    const actorName = resolveActorName(rec.actorId);
    if (parsed.actorFilter) {
      const actorHay = `${rec.actorId} ${actorName}`.toLowerCase();
      if (!actorHay.includes(parsed.actorFilter)) return false;
    }

    if (parsed.actionFilter) {
      const actionHay = `${rec.action} ${meta.label}`.toLowerCase();
      if (!actionHay.includes(parsed.actionFilter)) return false;
    }

    if (parsed.terms.length > 0) {
      const targetText = resolveTargetLabel(rec);
      const haystack = `${rec.action} ${meta.label} ${actorName} ${rec.actorId} ${targetText} ${rec.targetId || ''}`.toLowerCase();
      if (!parsed.terms.every(term => haystack.includes(term))) return false;
    }

    return true;
  });
}

const CSV_FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

export function sanitizeCsvCell(raw: unknown): string {
  const str = raw == null ? '' : String(raw);
  const safe = CSV_FORMULA_PREFIX_RE.test(str) ? `'${str}` : str;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function exportAuditRecordsCsv(
  records: readonly AuditRecord[],
  resolvers: {
    resolveActorName?: (actorId: string) => string;
    resolveTargetLabel?: (record: AuditRecord) => string;
  } = {},
): string {
  const { resolveActorName = id => id, resolveTargetLabel = rec => rec.targetId || '' } = resolvers;
  const header = ['时间(ISO)', '操作人', '动作标识', '事件说明', '分类', '目标对象', '项目ID'].map(sanitizeCsvCell).join(',');
  const rows = records.map(rec => {
    const meta = describeAuditAction(rec.action);
    return [
      rec.createdAt,
      resolveActorName(rec.actorId),
      rec.action,
      meta.label,
      meta.category,
      resolveTargetLabel(rec),
      rec.projectId || '',
    ]
      .map(sanitizeCsvCell)
      .join(',');
  });
  return `\uFEFF${[header, ...rows].join('\n')}`;
}

export function exportAuditRecordsJsonl(
  records: readonly AuditRecord[],
  resolvers: {
    resolveActorName?: (actorId: string) => string;
    resolveTargetLabel?: (record: AuditRecord) => string;
  } = {},
): string {
  const { resolveActorName = id => id, resolveTargetLabel = rec => rec.targetId || '' } = resolvers;
  return records
    .map(rec => {
      const meta = describeAuditAction(rec.action);
      return JSON.stringify({
        id: rec.id,
        createdAt: rec.createdAt,
        actorId: rec.actorId,
        actorName: resolveActorName(rec.actorId),
        action: rec.action,
        actionLabel: meta.label,
        category: meta.category,
        targetId: rec.targetId,
        targetLabel: resolveTargetLabel(rec),
        projectId: rec.projectId,
      });
    })
    .join('\n');
}

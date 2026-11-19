import type { RuleEnforcement, Stage } from './workspaceApi.ts';

export interface PolicyPlugin {
  id: string;
  name: string;
  version: string;
  stages: Stage[];
  rule?: string;
  enforcement?: RuleEnforcement;
  status?: string;
  projectId?: string;
}

export interface PolicyPluginPreset {
  baseId: string;
  name: string;
  version: string;
  stages: Stage[];
  enforcement: RuleEnforcement;
  description: string;
}

export const POLICY_PLUGIN_PRESETS: readonly PolicyPluginPreset[] = [
  {
    baseId: 'idempotency-contract-guard',
    name: '接口幂等与向下兼容契约核验',
    version: '1.0.0',
    stages: ['TECH_SPEC', 'CODE_REVIEW'],
    enforcement: 'WARN',
    description: '核查写接口幂等键、重试安全与新旧协议字段向下兼容。',
  },
  {
    baseId: 'sql-migration-safety',
    name: 'SQL 变更与索引回滚安全门禁',
    version: '1.0.0',
    stages: ['TECH_SPEC', 'CODE_REVIEW', 'RELEASE'],
    enforcement: 'BLOCK',
    description: '核查 DDL 锁表风险、慢查询索引覆盖及回滚订正脚本；高风险无回滚预案必须阻断。',
  },
  {
    baseId: 'sensitive-log-redaction',
    name: '敏感凭据与日志脱敏合规审查',
    version: '1.0.0',
    stages: ['CODE_REVIEW', 'TEST_CASE'],
    enforcement: 'BLOCK',
    description: '拦截硬编码密钥及日志打印手机号、卡号、Token 等敏感字段（PII/支付数据违规不可放行）。',
  },
  {
    baseId: 'canary-rollback-gate',
    name: '灰度放量监控与五分钟回滚门禁',
    version: '1.0.0',
    stages: ['TEST_CASE', 'RELEASE'],
    enforcement: 'WARN',
    description: '核查灰度比例阶梯、核心告警指标与 5 分钟内可执行的回滚预案。',
  },
];

export function buildScopedPluginId(baseId: string, projectId: string, projectKey?: string): string {
  const cleanBase = baseId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'policy-plugin';

  if (!projectId || projectId === 'default') {
    return cleanBase.slice(0, 64).replace(/-+$/g, '');
  }

  const rawScope = (projectKey || projectId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/g, '');

  if (!rawScope || rawScope === 'default') {
    return cleanBase.slice(0, 64).replace(/-+$/g, '');
  }

  const maxBaseLen = Math.max(8, 63 - rawScope.length);
  const trimmedBase = cleanBase.slice(0, maxBaseLen).replace(/-+$/g, '');
  return `${trimmedBase}-${rawScope}`;
}

export function isPresetInstalled(
  presetBaseId: string,
  plugins: readonly PolicyPlugin[],
  projectId: string,
  projectKey?: string,
): boolean {
  const scopedId = buildScopedPluginId(presetBaseId, projectId, projectKey);
  return plugins.some(p => p.id === presetBaseId || p.id === scopedId);
}

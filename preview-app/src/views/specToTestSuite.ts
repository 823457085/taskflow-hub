import type { Asset, WorkTask } from './workspaceApi.ts';
import { analyzeAssetRiskSignals } from './assetDiff.ts';
import { assetKindLabel } from './displayLabels.ts';

export type TestSuiteFormat = 'checklist' | 'gherkin';

export interface SynthesizedTestSuite {
  title: string;
  content: string;
  scenarioCount: number;
  tracedSources: string[];
}

const SKIP_SECTION_RE = /(?:背景|历史|非目标|不在本次|参考资料|附录)|\b(?:background|non-goals?|out\s+of\s+scope|references?|appendix)\b/i;

function cleanRequirementLine(raw: string): string {
  return raw
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^\d+[.)、]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSpecRequirementPoints(
  assets: readonly Asset[],
  fallbackTitle: string,
  maxPoints = 8,
): { points: string[]; tracedSources: string[]; riskCategories: string[] } {
  const latestByKind = new Map<string, Asset>();
  for (const a of assets) {
    const prev = latestByKind.get(a.kind);
    if (!prev || a.revision > prev.revision) latestByKind.set(a.kind, a);
  }

  const prd = latestByKind.get('PRD');
  const spec = latestByKind.get('TECH_SPEC');
  const code = latestByKind.get('CODE');

  const tracedSources: string[] = [];
  if (prd) tracedSources.push(`${assetKindLabel('PRD')} r${prd.revision} (${prd.sha256.slice(0, 8)})`);
  if (spec) tracedSources.push(`${assetKindLabel('TECH_SPEC')} r${spec.revision} (${spec.sha256.slice(0, 8)})`);
  if (code) tracedSources.push(`${assetKindLabel('CODE')} r${code.revision} (${code.sha256.slice(0, 8)})`);

  const points: string[] = [];
  const seen = new Set<string>();

  for (const doc of [prd, spec]) {
    if (!doc) continue;
    let skipSection = false;
    let inCodeFence = false;
    for (const rawLine of doc.content.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (/^```/.test(trimmed)) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence || !trimmed) continue;
      const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        skipSection = SKIP_SECTION_RE.test(heading[1]);
        continue;
      }
      if (skipSection) continue;
      if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)、]\s+/.test(trimmed)) {
        const cleaned = cleanRequirementLine(trimmed);
        if (cleaned.length < 4 || cleaned.length > 140) continue;
        const norm = cleaned.toLowerCase();
        if (seen.has(norm)) continue;
        seen.add(norm);
        points.push(cleaned);
        if (points.length >= maxPoints) break;
      }
    }
    if (points.length >= maxPoints) break;
  }

  if (points.length === 0 && fallbackTitle.trim()) {
    points.push(`${fallbackTitle.trim()} 核心主流程处理与状态流转`);
  }

  const risks = [
    ...(spec ? analyzeAssetRiskSignals(spec.content).signals : []),
    ...(code ? analyzeAssetRiskSignals(code.content).signals : []),
  ];
  const riskCategories = [...new Set<string>(risks.map(r => r.code))];
  const combinedSpecCode = `${spec?.content || ''}\n${code?.content || ''}`;
  if (/\b(?:FOR\s+UPDATE|setNx|idempoten|mutex|semaphore)\b|幂等|分布式锁|并发控制/i.test(combinedSpecCode)) {
    if (!riskCategories.includes('CONCURRENCY_LOCK')) riskCategories.push('CONCURRENCY_LOCK');
  }

  return { points, tracedSources, riskCategories };
}

export function synthesizeTestSuiteFromSpecs(params: {
  task: Pick<WorkTask, 'jiraKey' | 'title' | 'type'>;
  assets: readonly Asset[];
  format: TestSuiteFormat;
}): SynthesizedTestSuite {
  const { task, assets, format } = params;
  const { points, tracedSources, riskCategories } = extractSpecRequirementPoints(assets, task.title);
  const traceHeader = tracedSources.length > 0 ? tracedSources.join(' · ') : `任务标题《${task.title}》`;

  const riskEdgeCases: string[] = [];
  if (riskCategories.includes('CONCURRENCY_LOCK') || riskCategories.includes('PAYMENT_CORE')) {
    riskEdgeCases.push('并发重复提交相同幂等键或流水号时，仅首次请求生效且无重复扣款/脏写');
  }
  if (riskCategories.includes('SCHEMA_MIGRATION')) {
    riskEdgeCases.push('新旧表结构双写/灰度兼容：历史存量记录读取与回滚不报错');
  }
  if (riskCategories.includes('AUTH_SECURITY') || riskCategories.includes('SECRET_PATTERN')) {
    riskEdgeCases.push('未登录、越权项目角色及跨租户参数篡改请求均被 401/403 拒绝且无敏感信息回显');
  }
  if (riskEdgeCases.length === 0) {
    riskEdgeCases.push('高频连续点击或网络超时重试场景下，业务状态保持幂等一致');
    riskEdgeCases.push('空值、超长字符、非法枚举及越权访问被前置拦截并返回明确错误码');
  }

  if (format === 'checklist') {
    let idx = 1;
    const nextId = () => `TC-${String(idx++).padStart(2, '0')}`;
    const lines: string[] = [
      `# ${task.jiraKey} 验收与边界测试用例集`,
      '',
      `> 自动推导依据：${traceHeader}`,
      '',
      '## 1. 核心需求正向验收 (Happy Path)',
      '',
    ];
    for (const pt of points) {
      lines.push(`- [ ] **[${nextId()}]** 验证「${pt}」正向输入执行成功 — 预期结果：状态持久化正确、响应契约符合规范且审计留痕完整`);
    }

    lines.push(
      '',
      '## 2. 参数校验与权限负向用例 (Negative & Security)',
      '',
      `- [ ] **[${nextId()}]** 必填字段缺失、格式非法或超出长度上限 — 预期结果：返回 400 明确提示，不产生半成品脏数据`,
      `- [ ] **[${nextId()}]** 非授权角色或非项目成员发起操作 — 预期结果：服务端返回 403 拦截，外部系统与数据库无副作用`,
      '',
      '## 3. 边界条件、并发幂等与回归核验 (Edge & Regression)',
      '',
    );
    for (const edge of riskEdgeCases) {
      lines.push(`- [ ] **[${nextId()}]** ${edge}`);
    }
    lines.push(`- [ ] **[${nextId()}]** 关闭功能开关或执行回滚预案后，上下游存量核心链路回归正常`);

    return {
      title: `${task.jiraKey} 规格驱动测试用例集`,
      content: lines.join('\n'),
      scenarioCount: idx - 1,
      tracedSources,
    };
  }

  // format === 'gherkin'
  let scenarioCount = 0;
  const gherkinLines: string[] = [
    `# language: zh-CN`,
    `功能: ${task.jiraKey} ${task.title}`,
    `  基于规格说明书 (${traceHeader}) 自动生成的声明式 BDD 验收场景`,
    '',
    '  背景:',
    '    假如 当前业务服务与测试基准数据已就绪',
    '    并且 操作人具备合法的项目成员身份与对应角色权限',
    '',
  ];

  for (const pt of points.slice(0, 5)) {
    scenarioCount += 1;
    gherkinLines.push(
      `  @happy_path`,
      `  场景: [正向-${scenarioCount}] ${pt}`,
      `    当 用户按业务规则提交「${pt}」的有效请求`,
      `    那么 系统应成功完成处理并返回预期业务状态`,
      `    并且 关键变更数据与审计记录保持一致`,
      '',
    );
  }

  scenarioCount += 1;
  gherkinLines.push(
    `  @negative @security`,
    `  场景: [负向-${scenarioCount}] 非法参数与越权请求安全拦截`,
    `    当 调用方提交缺失必填项、超界参数或不具备当前项目角色权限的请求`,
    `    那么 系统应拒绝执行并返回明确的校验或权限错误提示`,
    `    并且 不产生任何未授权的数据写入或外部副作用`,
    '',
  );

  for (const edge of riskEdgeCases.slice(0, 2)) {
    scenarioCount += 1;
    gherkinLines.push(
      `  @boundary @idempotency`,
      `  场景: [边界-${scenarioCount}] ${edge.slice(0, 60)}`,
      `    当 触发重复并发请求或边界临界输入条件`,
      `    那么 应满足：${edge}`,
      '',
    );
  }

  const content = [
    `# ${task.jiraKey} BDD Gherkin 验收场景 (.feature)`,
    '',
    `> 自动推导依据：${traceHeader}`,
    '',
    '```gherkin',
    ...gherkinLines,
    '```',
  ].join('\n');

  return {
    title: `${task.jiraKey} BDD Gherkin 验收场景`,
    content,
    scenarioCount,
    tracedSources,
  };
}

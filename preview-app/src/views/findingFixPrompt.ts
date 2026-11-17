import type { Finding, Stage, WorkTask } from './workspaceApi.ts';
import { severityLabel, stageLabel } from './displayLabels.ts';

export interface SingleFindingFixOptions {
  task: Pick<WorkTask, 'jiraKey' | 'title'>;
  stage: Stage;
  finding: Finding;
  repoPath?: string | null;
  constitutionFiles?: readonly string[];
}

export interface BatchFindingsFixOptions {
  task: Pick<WorkTask, 'jiraKey' | 'title'>;
  stage: Stage;
  findings: readonly Finding[];
  summary?: string | null;
  repoPath?: string | null;
  constitutionFiles?: readonly string[];
}

const SEVERITY_RANK: Record<Finding['severity'], number> = {
  CRITICAL: 0,
  WARN: 1,
  INFO: 2,
};

export function sortActionableFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .filter(item => !item.waiver)
    .slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

export function buildSingleFindingFixPrompt(options: SingleFindingFixOptions): string {
  const { task, stage, finding, repoPath = null, constitutionFiles = [] } = options;
  const lines: string[] = [
    `请针对任务 ${task.jiraKey}（${task.title}）在【${stageLabel(stage)}】阶段发现的以下问题执行最小侵入式定向修复：`,
    '',
    '### 待修复问题',
    `- **严重程度**：${severityLabel(finding.severity)} (${finding.severity})`,
    `- **问题标题**：${finding.title}`,
    ...(finding.location ? [`- **定位锚点**：\`${finding.location}\``] : []),
    `- **问题详情**：`,
    finding.detail.trim(),
  ];

  if (repoPath || constitutionFiles.length > 0) {
    lines.push('', '### 仓库与工程规范约束');
    if (repoPath) lines.push(`- **工作目录**：\`${repoPath}\``);
    if (constitutionFiles.length > 0) {
      lines.push(`- **必读工程规范**：修复前请先阅读并严格遵守仓库根目录下的 ${constitutionFiles.map(f => `\`${f}\``).join('、')}`);
    }
  }

  lines.push(
    '',
    '### 修复与验证要求',
    '1. 仅针对上述问题做最小必要改动（Surgical Fix），不要重构无关代码或引入计划外依赖。',
    finding.location
      ? `2. 优先检查并定位 \`${finding.location}\` 及其上下游调用边界。`
      : '2. 先在代码库/文档中检索相关模块与调用链，再实施修改。',
    '3. 补充或更新覆盖该问题场景的单元测试 / 回归用例，运行测试套件确保零回归。',
    '4. 完成后输出：根因简述、修改文件清单与验证结果摘要。',
  );

  return lines.join('\n');
}

export function buildBatchFindingsFixPrompt(options: BatchFindingsFixOptions): string {
  const { task, stage, findings, summary = null, repoPath = null, constitutionFiles = [] } = options;
  const actionable = sortActionableFindings(findings);
  if (actionable.length === 0) return '';
  if (actionable.length === 1 && !summary) {
    return buildSingleFindingFixPrompt({
      task,
      stage,
      finding: actionable[0],
      repoPath,
      constitutionFiles,
    });
  }

  const criticalCount = actionable.filter(f => f.severity === 'CRITICAL').length;
  const warnCount = actionable.filter(f => f.severity === 'WARN').length;
  const infoCount = actionable.length - criticalCount - warnCount;

  const lines: string[] = [
    `请针对任务 ${task.jiraKey}（${task.title}）在【${stageLabel(stage)}】阶段的 ${actionable.length} 项未豁免评审发现项（阻断 ${criticalCount} / 风险 ${warnCount} / 建议 ${infoCount}）依次完成修复与回归验证：`,
  ];

  if (repoPath || constitutionFiles.length > 0) {
    lines.push('', '## 1. 仓库与规范上下文');
    if (repoPath) lines.push(`- **本地仓库路径**：\`${repoPath}\``);
    if (constitutionFiles.length > 0) {
      lines.push(`- **仓库工程规范**：请严格遵循 ${constitutionFiles.map(f => `\`${f}\``).join('、')}`);
    }
  }

  if (summary?.trim()) {
    lines.push('', '## 2. 评审总体结论', summary.trim());
  }

  lines.push('', `## ${summary?.trim() ? '3' : '2'}. 待修复发现项清单（按优先级排序）`);
  actionable.forEach((f, idx) => {
    lines.push(
      '',
      `### [${idx + 1}/${actionable.length}] [${severityLabel(f.severity)}] ${f.title}${f.location ? ` (\`${f.location}\`)` : ''}`,
      f.detail.trim(),
    );
  });

  lines.push(
    '',
    `## ${summary?.trim() ? '4' : '3'}. 逐项修复与验收要求`,
    ...actionable.map((f, idx) => `- [ ] 修复 #${idx + 1}：${f.title}${f.location ? ` (\`${f.location}\`)` : ''}`),
    '- [ ] 运行相关构建与自动化测试，确保所有阻断与风险问题闭环且无回归',
    '- [ ] 输出各项问题的修复说明与测试验证证据，便于更新材料并重新发起门禁评审',
  );

  return lines.join('\n');
}

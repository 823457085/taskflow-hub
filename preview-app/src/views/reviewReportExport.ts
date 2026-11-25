import type { ChecklistItem, Finding, FindingCategory, ReportMeta, ReportVerdict, Stage } from './workspaceApi.ts';
import { findingCategoryLabel, riskLevelLabel, roleLabel, stageLabel, toolLabel } from './displayLabels.ts';
import { plainReviewText, reviewDetailSections, sortReviewFindings } from './reviewFindingPresentation.ts';

export interface ReviewExportFinding {
  severity: Finding['severity'];
  title: string;
  detail: string;
  location?: string | null;
  category?: FindingCategory;
  confidence?: number;
  ruleId?: string;
  suggestedPatch?: { before: string; after: string };
  waiver?: { reason: string } | null;
  waived?: boolean;
}

export interface ReviewExportInput {
  task: {
    jiraKey: string;
    title: string;
    url?: string | null;
  };
  stage: Stage;
  isDraft?: boolean;
  stale?: boolean;
  report: {
    summary: string;
    evidence?: string | null;
    verdict?: ReportVerdict | null;
    score?: number | null;
    checklist?: readonly ChecklistItem[] | null;
    meta?: ReportMeta | null;
    tool?: string | null;
    createdAt?: string | null;
    actorName?: string | null;
  };
  findings: readonly ReviewExportFinding[];
}

interface PriorityGroupMeta {
  severity: Finding['severity'];
  heading: string;
  shortLabel: string;
  hint: string;
  tone: 'p0' | 'p1' | 'p2';
}

const PRIORITY_GROUPS: readonly PriorityGroupMeta[] = [
  {
    severity: 'CRITICAL',
    heading: '必须先改（P0 阻断问题）',
    shortLabel: 'P0 必须先改',
    hint: '以下问题不解决会影响正常上线或存在严重风险，请优先处理。',
    tone: 'p0',
  },
  {
    severity: 'WARN',
    heading: '建议尽快处理（P1 需跟进）',
    shortLabel: 'P1 建议尽快处理',
    hint: '以下问题建议在本轮研发或测试中尽快补齐，避免上线后出问题。',
    tone: 'p1',
  },
  {
    severity: 'INFO',
    heading: '可顺手优化（P2 改进建议）',
    shortLabel: 'P2 可顺手优化',
    hint: '以下为体验或细节优化建议，可结合排期顺手完善。',
    tone: 'p2',
  },
];

const VERDICT_DETAILS: Record<ReportVerdict, { short: string; detail: string; tone: 'pass' | 'warn' | 'fail' }> = {
  PASS: {
    short: '通过',
    detail: '通过（无阻断问题，可进入下一阶段）',
    tone: 'pass',
  },
  CONDITIONAL: {
    short: '有条件通过',
    detail: '有条件通过（主流程基本可用，处理完待跟进项后再放行）',
    tone: 'warn',
  },
  FAIL: {
    short: '暂不通过',
    detail: '暂不通过（存在必须先解决的阻断问题，修复后复审）',
    tone: 'fail',
  },
};

const CHECKLIST_RESULT_META: Record<ChecklistItem['result'], { label: string; tone: 'pass' | 'warn' | 'fail' | 'na' }> = {
  PASS: { label: '满足', tone: 'pass' },
  WARN: { label: '待完善', tone: 'warn' },
  FAIL: { label: '不满足', tone: 'fail' },
  NA: { label: '不适用', tone: 'na' },
};

const CHECKLIST_ORDER: Record<ChecklistItem['result'], number> = {
  FAIL: 0,
  WARN: 1,
  PASS: 2,
  NA: 3,
};

export function humanizeReviewText(text: string): string {
  if (!text) return '';
  return plainReviewText(text)
    .replace(/(?<![\w./\-])WARN(?![\w./\-])/g, 'P1 需跟进')
    .replace(/(?<![\w./\-])INFO(?![\w./\-])/g, 'P2 改进建议')
    .replace(/(?<![\w./\-])CODE_REVIEW(?![\w./\-])/g, '代码审核')
    .replace(/(?<![\w./\-])TECH_SPEC(?![\w./\-])/g, '技术方案审核')
    .replace(/(?<![\w./\-])TEST_CASE(?![\w./\-])/g, '测试用例评审')
    .replace(/(?<![\w./\-])TASK_BREAKDOWN(?![\w./\-])/g, '任务拆分审核')
    .replace(/(?<![\w./\-])meta\.compliance(?![\w./\-])/g, '验收达标核对')
    .replace(/(?<![\w./\-])reviewSnapshot\.assets(?![\w./\-])/g, '评审材料快照')
    .replace(/(?<![\w./\-])reviewSnapshot(?![\w./\-])/g, '冻结评审快照')
    .replace(/(?<![\w./\-])reviewJob(?![\w./\-])/g, '本次评审任务')
    .trim();
}

export function cleanEvidenceForHumans(evidence?: string | null): string {
  if (!evidence?.trim()) return '';
  let text = humanizeReviewText(evidence);
  // Strip verbose internal UUIDs and 64-char SHA-256 hashes while preserving readable document/MR/commit facts.
  text = text
    .replace(/(?:代码审核|需求评审|技术方案审核|测试用例评审|任务拆分审核|上线审核|PRD|RELEASE)?\s*Job\s+[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '本次评审')
    .replace(/指定资产\s+[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\s*为\s*/g, '审核材料为 ')
    .replace(/[，,]?\s*ID\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '')
    .replace(/[，,]?\s*(?:冻结输入哈希|冻结内容重算\s*SHA-256\s*为|内容\s*SHA-256\s*(?:实算|重算)?为?|快照\s*SHA-256|SHA-256)\s*[0-9a-fA-F]{16,64}/g, '')
    .replace(/本次评审任务\s*与\s*冻结评审快照\s*的输入哈希均为\s*[0-9a-fA-F]{16,64}[。.]?/g, '')
    .replace(/[，,]?\s*与指定指纹一致/g, '')
    .replace(/\b([0-9a-f]{8})[0-9a-f]{32}\b/g, '$1')
    .replace(/^本次评审[，,。.\s]*/g, '')
    .replace(/[，,]{2,}/g, '，')
    .replace(/[。]{2,}/g, '。')
    .replace(/[，,]\s*[。]/g, '。')
    .replace(/^[，,。.\s]+/g, '')
    .trim();
  return text;
}

function splitLocations(location?: string | null): string[] {
  if (!location?.trim()) return [];
  return location
    .split(/[；;]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function formatDateTime(value?: string | null): string {
  if (!value?.trim()) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeWebUrl(url?: string | null): string | null {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    return null;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>').trim();
}

function ownerLabel(owner?: string | null): string {
  if (!owner?.trim()) return '';
  return roleLabel(owner.trim().toUpperCase()) === owner.trim().toUpperCase()
    ? owner.trim()
    : roleLabel(owner.trim().toUpperCase());
}

interface NormalizedFinding {
  severity: Finding['severity'];
  title: string;
  sections: { label: string; text: string }[];
  locations: string[];
  categoryLabel: string;
  waiverText: string;
  suggestedPatch?: { before: string; after: string };
}

interface NormalizedReport {
  docTitle: string;
  stageText: string;
  taskKey: string;
  taskTitle: string;
  taskUrl: string | null;
  statusText: string;
  staleNote: string;
  verdict: { short: string; detail: string; tone: 'pass' | 'warn' | 'fail' } | null;
  scoreText: string;
  riskText: string;
  riskTone: 'pass' | 'warn' | 'fail' | 'neutral';
  toolText: string;
  actorName: string;
  timeText: string;
  summary: string;
  counts: { total: number; p0: number; p0Waived: number; p0Open: number; p1: number; p2: number };
  countSummaryText: string;
  nextSteps: string[];
  groups: { meta: PriorityGroupMeta; items: NormalizedFinding[] }[];
  clarifyQuestions: {
    id: string;
    question: string;
    impact: string;
    owner: string;
    resolved: boolean;
  }[];
  compliance: {
    compliant: string[];
    missing: string[];
    manualCheck: string[];
  } | null;
  walkthrough: {
    file: string;
    summary: string;
    riskLabel: string;
    riskTone: 'pass' | 'warn' | 'fail' | 'neutral';
  }[];
  checklist: {
    item: string;
    result: ChecklistItem['result'];
    resultLabel: string;
    resultTone: 'pass' | 'warn' | 'fail' | 'na';
    note: string;
    ref: string;
  }[];
  checklistSummaryText: string;
  evidence: string;
}

function normalizeReviewExport(input: ReviewExportInput): NormalizedReport {
  const stageText = stageLabel(input.stage);
  const taskKey = (input.task.jiraKey || '').trim();
  const taskTitle = (input.task.title || '').trim();
  const docTitle = `${taskKey ? `${taskKey} ` : ''}${stageText}报告`;
  const statusText = input.isDraft ? 'AI 评审草稿（尚未正式提交）' : '正式评审报告';
  const staleNote = input.stale ? '材料在本次评审后已有更新，建议核对后重新评审。' : '';

  const verdict = input.report.verdict ? VERDICT_DETAILS[input.report.verdict] || null : null;
  const scoreText = typeof input.report.score === 'number' ? `${input.report.score} / 100 分` : '';
  const risk = input.report.meta?.riskLevel || null;
  const riskText = risk ? riskLevelLabel(risk) : '';
  const riskTone: 'pass' | 'warn' | 'fail' | 'neutral' = risk === 'high' ? 'fail' : risk === 'medium' ? 'warn' : risk === 'low' ? 'pass' : 'neutral';

  const sortedFindings = sortReviewFindings(input.findings || []);
  const normalizedFindings: NormalizedFinding[] = sortedFindings.map(item => {
    const sections = reviewDetailSections(item.detail || '').map(sec => ({
      label: sec.label,
      text: humanizeReviewText(sec.text),
    }));
    const waiverText = item.waiver?.reason
      ? `已豁免：${humanizeReviewText(item.waiver.reason)}`
      : item.waived
        ? '已豁免'
        : '';
    return {
      severity: item.severity,
      title: humanizeReviewText(item.title || ''),
      sections,
      locations: splitLocations(item.location),
      categoryLabel: item.category ? findingCategoryLabel(item.category) : '',
      waiverText,
      suggestedPatch: item.suggestedPatch && (item.suggestedPatch.before || item.suggestedPatch.after)
        ? item.suggestedPatch
        : undefined,
    };
  });

  const p0Items = normalizedFindings.filter(f => f.severity === 'CRITICAL');
  const p0Waived = p0Items.filter(f => !!f.waiverText).length;
  const p0Open = p0Items.length - p0Waived;
  const p1Items = normalizedFindings.filter(f => f.severity === 'WARN');
  const p2Items = normalizedFindings.filter(f => f.severity === 'INFO');
  const counts = {
    total: normalizedFindings.length,
    p0: p0Items.length,
    p0Waived,
    p0Open,
    p1: p1Items.length,
    p2: p2Items.length,
  };

  const countSummaryText = counts.total === 0
    ? '未发现问题（0 项）'
    : `共 ${counts.total} 项：必须先改（P0）${counts.p0} 项${counts.p0Waived ? `（其中 ${counts.p0Waived} 项已豁免）` : ''}、建议尽快处理（P1）${counts.p1} 项、可顺手优化（P2）${counts.p2} 项`;

  const groups = PRIORITY_GROUPS
    .map(meta => ({
      meta,
      items: normalizedFindings.filter(item => item.severity === meta.severity),
    }))
    .filter(group => group.items.length > 0);

  const clarifyQuestions = (input.report.meta?.clarifyQuestions || []).map(q => ({
    id: q.id || '',
    question: humanizeReviewText(q.question || ''),
    impact: humanizeReviewText(q.impact || ''),
    owner: ownerLabel(q.owner),
    resolved: !!q.resolved,
  }));

  const rawCompliance = input.report.meta?.compliance;
  const compliance = rawCompliance && (
    rawCompliance.compliant?.length || rawCompliance.missing?.length || rawCompliance.manualCheck?.length
  )
    ? {
        compliant: (rawCompliance.compliant || []).map(humanizeReviewText).filter(Boolean),
        missing: (rawCompliance.missing || []).map(humanizeReviewText).filter(Boolean),
        manualCheck: (rawCompliance.manualCheck || []).map(humanizeReviewText).filter(Boolean),
      }
    : null;

  const walkthrough = (input.report.meta?.walkthrough || []).map(w => ({
    file: w.file || '',
    summary: humanizeReviewText(w.summary || ''),
    riskLabel: w.risk ? riskLevelLabel(w.risk) : '',
    riskTone: (w.risk === 'high' ? 'fail' : w.risk === 'medium' ? 'warn' : w.risk === 'low' ? 'pass' : 'neutral') as 'pass' | 'warn' | 'fail' | 'neutral',
  }));

  const checklist = [...(input.report.checklist || [])]
    .sort((a, b) => (CHECKLIST_ORDER[a.result] ?? 9) - (CHECKLIST_ORDER[b.result] ?? 9))
    .map(c => {
      const meta = CHECKLIST_RESULT_META[c.result] || { label: c.result, tone: 'na' as const };
      return {
        item: humanizeReviewText(c.item || ''),
        result: c.result,
        resultLabel: meta.label,
        resultTone: meta.tone,
        note: humanizeReviewText(c.note || ''),
        ref: humanizeReviewText(c.ref || ''),
      };
    });

  const checklistFail = checklist.filter(c => c.result === 'FAIL').length;
  const checklistWarn = checklist.filter(c => c.result === 'WARN').length;
  const checklistPass = checklist.filter(c => c.result === 'PASS').length;
  const checklistNa = checklist.filter(c => c.result === 'NA').length;
  const checklistSummaryParts = [
    checklistFail ? `${checklistFail} 项不满足` : '',
    checklistWarn ? `${checklistWarn} 项待完善` : '',
    checklistPass ? `${checklistPass} 项满足` : '',
    checklistNa ? `${checklistNa} 项不适用` : '',
  ].filter(Boolean);
  const checklistSummaryText = checklist.length
    ? `共 ${checklist.length} 项：${checklistSummaryParts.join('、')}`
    : '';

  const openClarifyCount = clarifyQuestions.filter(q => !q.resolved).length;
  const manualCheckCount = compliance?.manualCheck.length || 0;

  const nextSteps: string[] = [];
  if (counts.p0Open > 0) {
    nextSteps.push(`优先修复 ${counts.p0Open} 项「P0 必须先改」问题，修改完成后重新发起评审。`);
  }
  if (counts.p1 > 0) {
    nextSteps.push(`尽快处理 ${counts.p1} 项「P1 建议尽快处理」问题，避免带入线上环境。`);
  }
  if (openClarifyCount > 0) {
    nextSteps.push(`找对应同学对齐 ${openClarifyCount} 项待确认事项，明确验收口径。`);
  }
  if (manualCheckCount > 0) {
    nextSteps.push(`发布或验收前完成 ${manualCheckCount} 项人工 / 真机实测核验。`);
  }
  if (counts.p2 > 0) {
    nextSteps.push(`如有余力，可顺手完善 ${counts.p2} 项「P2 可顺手优化」建议。`);
  }
  if (input.stale) {
    nextSteps.push('关联材料在本次评审后已有更新，建议基于最新版材料重新评审确认。');
  }
  if (!nextSteps.length) {
    nextSteps.push('本次未发现需整改问题，可按计划推进下一环节。');
  }

  return {
    docTitle,
    stageText,
    taskKey,
    taskTitle,
    taskUrl: safeWebUrl(input.task.url),
    statusText,
    staleNote,
    verdict,
    scoreText,
    riskText,
    riskTone,
    toolText: input.report.tool ? toolLabel(input.report.tool) : '',
    actorName: (input.report.actorName || '').trim(),
    timeText: formatDateTime(input.report.createdAt),
    summary: humanizeReviewText(input.report.summary || ''),
    counts,
    countSummaryText,
    nextSteps,
    groups,
    clarifyQuestions,
    compliance,
    walkthrough,
    checklist,
    checklistSummaryText,
    evidence: cleanEvidenceForHumans(input.report.evidence),
  };
}

/**
 * Plain Chinese report without Markdown symbols — ideal for pasting into WeCom / Feishu / DingTalk / Jira / email.
 */
export function formatReviewReportPlainText(input: ReviewExportInput): string {
  const m = normalizeReviewExport(input);
  const lines: string[] = [];

  lines.push(`【${m.stageText}报告】${m.taskKey ? `${m.taskKey} ` : ''}${m.taskTitle}`.trim());
  lines.push('========================================');
  lines.push(`报告状态：${m.statusText}`);
  if (m.staleNote) lines.push(`变更提醒：${m.staleNote}`);
  if (m.verdict) lines.push(`评审结论：${m.verdict.detail}`);

  const scoreAndRisk = [
    m.scoreText ? `综合评分：${m.scoreText}` : '',
    m.riskText ? `风险等级：${m.riskText}` : '',
  ].filter(Boolean);
  if (scoreAndRisk.length) lines.push(scoreAndRisk.join(' ｜ '));

  lines.push(`问题统计：${m.countSummaryText}`);

  const metaBits = [
    m.actorName ? `提交人：${m.actorName}` : '',
    m.toolText ? `评审工具：${m.toolText}` : '',
    m.timeText ? `生成时间：${m.timeText}` : '',
  ].filter(Boolean);
  if (metaBits.length) lines.push(metaBits.join(' ｜ '));
  if (m.taskUrl) lines.push(`任务链接：${m.taskUrl}`);

  if (m.summary) {
    lines.push('', '【一句话结论】', m.summary);
  }

  if (m.nextSteps.length) {
    lines.push('', '【接下来建议怎么处理】');
    m.nextSteps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  }

  lines.push('', '【问题清单】');
  if (!m.groups.length) {
    lines.push('本次评审未发现需要整改的问题。');
  } else {
    for (const group of m.groups) {
      lines.push('', `■ ${group.meta.heading.replace(/）$/, ` · ${group.items.length} 项）`)}`);
      group.items.forEach((finding, idx) => {
        const suffixBits = [finding.categoryLabel, finding.waiverText].filter(Boolean);
        const suffix = suffixBits.length ? `（${suffixBits.join(' · ')}）` : '';
        lines.push(`${idx + 1}. ${finding.title}${suffix}`);
        for (const sec of finding.sections) {
          lines.push(`   · ${sec.label}：${sec.text.replace(/\r?\n+/g, '\n     ')}`);
        }
        if (finding.locations.length) {
          lines.push(`   · 涉及位置：${finding.locations.join('；')}`);
        }
        if (finding.suggestedPatch) {
          if (finding.suggestedPatch.before) lines.push(`   · 原写法：${finding.suggestedPatch.before}`);
          if (finding.suggestedPatch.after) lines.push(`   · 建议改为：${finding.suggestedPatch.after}`);
        }
      });
    }
  }

  if (m.clarifyQuestions.length) {
    lines.push('', `【待确认事项（${m.clarifyQuestions.length} 项）】`);
    m.clarifyQuestions.forEach((q, idx) => {
      const tags = [q.resolved ? '已确认' : '待确认', q.owner].filter(Boolean).join(' · ');
      lines.push(`${idx + 1}. [${tags}] ${q.question}`);
      if (q.impact) lines.push(`   · 影响说明：${q.impact}`);
    });
  }

  if (m.compliance) {
    lines.push('', '【验收达标情况】');
    if (m.compliance.compliant.length) {
      lines.push(`· 已满足（${m.compliance.compliant.length} 项）：`);
      m.compliance.compliant.forEach(item => lines.push(`  - ${item}`));
    }
    if (m.compliance.missing.length) {
      lines.push(`· 尚未满足 / 存在缺口（${m.compliance.missing.length} 项）：`);
      m.compliance.missing.forEach(item => lines.push(`  - ${item}`));
    }
    if (m.compliance.manualCheck.length) {
      lines.push(`· 需人工 / 真机实测确认（${m.compliance.manualCheck.length} 项）：`);
      m.compliance.manualCheck.forEach(item => lines.push(`  - ${item}`));
    }
  }

  if (m.walkthrough.length) {
    lines.push('', `【本次审查范围概览（${m.walkthrough.length} 项）】`);
    m.walkthrough.forEach((w, idx) => {
      lines.push(`${idx + 1}. ${w.file}${w.riskLabel ? `（${w.riskLabel}）` : ''}`);
      if (w.summary) lines.push(`   · ${w.summary}`);
    });
  }

  if (m.checklist.length) {
    lines.push('', `【逐项检查清单（${m.checklistSummaryText}）】`);
    m.checklist.forEach((c, idx) => {
      const cleanTitle = c.item.replace(/^\d+[.、]\s*/, '');
      lines.push(`${idx + 1}. [${c.resultLabel}] ${cleanTitle}`);
      if (c.note) lines.push(`   · 说明：${c.note}`);
      if (c.ref) lines.push(`   · 参考：${c.ref}`);
    });
  }

  if (m.evidence) {
    lines.push('', '【附：核查依据】', m.evidence);
  }

  return lines.join('\n');
}

/**
 * Structured plain-Chinese Markdown report — ideal for Confluence / Notion / Yuque / Git.
 */
export function formatReviewReportMarkdown(input: ReviewExportInput): string {
  const m = normalizeReviewExport(input);
  const lines: string[] = [];

  lines.push(`# ${m.stageText}报告：${m.taskKey ? `${m.taskKey} ` : ''}${m.taskTitle}`.trim(), '');

  lines.push('| 项目 | 内容 |');
  lines.push('| --- | --- |');
  lines.push(`| 报告状态 | ${escapeMarkdownTableCell(m.statusText)} |`);
  if (m.verdict) lines.push(`| 评审结论 | **${escapeMarkdownTableCell(m.verdict.detail)}** |`);
  if (m.scoreText) lines.push(`| 综合评分 | ${escapeMarkdownTableCell(m.scoreText)} |`);
  if (m.riskText) lines.push(`| 风险等级 | ${escapeMarkdownTableCell(m.riskText)} |`);
  lines.push(`| 问题统计 | ${escapeMarkdownTableCell(m.countSummaryText)} |`);
  if (m.actorName) lines.push(`| 提交人 | ${escapeMarkdownTableCell(m.actorName)} |`);
  if (m.toolText) lines.push(`| 评审工具 | ${escapeMarkdownTableCell(m.toolText)} |`);
  if (m.timeText) lines.push(`| 生成时间 | ${escapeMarkdownTableCell(m.timeText)} |`);
  if (m.taskUrl) lines.push(`| 任务链接 | [${escapeMarkdownTableCell(m.taskKey || '查看任务')}](${m.taskUrl}) |`);

  if (m.staleNote) {
    lines.push('', `> **提醒**：${m.staleNote}`);
  }

  if (m.summary) {
    lines.push('', '## 一句话结论', '', m.summary);
  }

  if (m.nextSteps.length) {
    lines.push('', '## 接下来建议怎么处理', '');
    m.nextSteps.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  }

  lines.push('', '## 问题清单');
  if (!m.groups.length) {
    lines.push('', '本次评审未发现需要整改的问题。');
  } else {
    for (const group of m.groups) {
      lines.push('', `### ${group.meta.heading.replace(/）$/, ` · ${group.items.length} 项）`)}`, '', `> ${group.meta.hint}`);
      group.items.forEach((finding, idx) => {
        const badges = [finding.categoryLabel, finding.waiverText].filter(Boolean);
        lines.push('', `#### ${idx + 1}. ${finding.title}${badges.length ? `（${badges.join(' · ')}）` : ''}`, '');
        for (const sec of finding.sections) {
          lines.push(`- **${sec.label}**：${sec.text.replace(/\r?\n+/g, '\n  ')}`);
        }
        if (finding.locations.length) {
          lines.push(`- **涉及位置**：${finding.locations.map(loc => `\`${loc}\``).join('；')}`);
        }
        if (finding.suggestedPatch) {
          lines.push('- **参考修改**：');
          lines.push('```diff');
          if (finding.suggestedPatch.before) {
            finding.suggestedPatch.before.split(/\r?\n/).forEach(l => lines.push(`- ${l}`));
          }
          if (finding.suggestedPatch.after) {
            finding.suggestedPatch.after.split(/\r?\n/).forEach(l => lines.push(`+ ${l}`));
          }
          lines.push('```');
        }
      });
    }
  }

  if (m.clarifyQuestions.length) {
    lines.push('', `## 待确认事项（${m.clarifyQuestions.length} 项）`, '');
    m.clarifyQuestions.forEach((q, idx) => {
      const tags = [q.resolved ? '已确认' : '待确认', q.owner].filter(Boolean).join(' · ');
      lines.push(`${idx + 1}. **[${tags}]** ${q.question}`);
      if (q.impact) lines.push(`   - 影响说明：${q.impact}`);
    });
  }

  if (m.compliance) {
    lines.push('', '## 验收达标情况');
    if (m.compliance.compliant.length) {
      lines.push('', `### 已满足（${m.compliance.compliant.length} 项）`, '');
      m.compliance.compliant.forEach(item => lines.push(`- ${item}`));
    }
    if (m.compliance.missing.length) {
      lines.push('', `### 尚未满足 / 存在缺口（${m.compliance.missing.length} 项）`, '');
      m.compliance.missing.forEach(item => lines.push(`- ${item}`));
    }
    if (m.compliance.manualCheck.length) {
      lines.push('', `### 需人工 / 真机实测确认（${m.compliance.manualCheck.length} 项）`, '');
      m.compliance.manualCheck.forEach(item => lines.push(`- ${item}`));
    }
  }

  if (m.walkthrough.length) {
    lines.push('', `## 本次审查范围概览（${m.walkthrough.length} 项）`, '');
    lines.push('| 文件 / 模块 | 审查说明 | 风险等级 |');
    lines.push('| --- | --- | --- |');
    for (const w of m.walkthrough) {
      lines.push(`| \`${escapeMarkdownTableCell(w.file)}\` | ${escapeMarkdownTableCell(w.summary)} | ${escapeMarkdownTableCell(w.riskLabel || '—')} |`);
    }
  }

  if (m.checklist.length) {
    lines.push('', `## 逐项检查清单（${m.checklistSummaryText}）`, '');
    lines.push('| 状态 | 检查项 | 说明与依据 |');
    lines.push('| --- | --- | --- |');
    for (const c of m.checklist) {
      const noteWithRef = [c.note, c.ref ? `参考：${c.ref}` : ''].filter(Boolean).join(' ');
      lines.push(`| ${escapeMarkdownTableCell(c.resultLabel)} | ${escapeMarkdownTableCell(c.item)} | ${escapeMarkdownTableCell(noteWithRef || '—')} |`);
    }
  }

  if (m.evidence) {
    lines.push('', '## 附：核查依据', '', m.evidence);
  }

  return lines.join('\n');
}

const TONE_STYLES = {
  pass: { bg: '#ecfdf3', text: '#067647', border: '#abefc6' },
  warn: { bg: '#fffaeb', text: '#b54708', border: '#fedf89' },
  fail: { bg: '#fef3f2', text: '#b42318', border: '#fecdca' },
  na: { bg: '#f2f4f7', text: '#475467', border: '#d0d5dd' },
  neutral: { bg: '#f2f4f7', text: '#344054', border: '#d0d5dd' },
  p0: { bg: '#fef3f2', text: '#b42318', border: '#f04438' },
  p1: { bg: '#fffaeb', text: '#b54708', border: '#f79009' },
  p2: { bg: '#f0f9ff', text: '#026aa2', border: '#0ba5ec' },
} as const;

function badgeHtml(text: string, tone: keyof typeof TONE_STYLES): string {
  const s = TONE_STYLES[tone];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;background:${s.bg};color:${s.text};border:1px solid ${s.border};line-height:1.5;">${escapeHtml(text)}</span>`;
}

function paragraphsHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br/>');
}

/**
 * Self-contained HTML document suitable for both browser viewing/PDF printing (`forWord: false`)
 * and Microsoft Word / WPS / Pages editing (`forWord: true`).
 */
export function formatReviewReportHtml(input: ReviewExportInput, options: { forWord?: boolean } = {}): string {
  const { forWord = false } = options;
  const m = normalizeReviewExport(input);
  const fullHeading = `${m.taskKey ? `${m.taskKey} ` : ''}${m.taskTitle}`.trim();

  const metaRows: [string, string][] = [
    ['评审环节', escapeHtml(m.stageText)],
    ['报告状态', escapeHtml(m.statusText)],
    ...(m.verdict ? [['评审结论', `${badgeHtml(m.verdict.short, m.verdict.tone)} <span style="margin-left:6px;color:#344054;">${escapeHtml(m.verdict.detail)}</span>`] as [string, string]] : []),
    ...(m.scoreText || m.riskText ? [['评分与风险', [
      m.scoreText ? `<strong>${escapeHtml(m.scoreText)}</strong>` : '',
      m.riskText ? badgeHtml(m.riskText, m.riskTone) : '',
    ].filter(Boolean).join(' &nbsp; ')] as [string, string]] : []),
    ['问题统计', escapeHtml(m.countSummaryText)],
    ...(m.actorName ? [['提交人', escapeHtml(m.actorName)] as [string, string]] : []),
    ...(m.toolText ? [['评审工具', escapeHtml(m.toolText)] as [string, string]] : []),
    ...(m.timeText ? [['生成时间', escapeHtml(m.timeText)] as [string, string]] : []),
    ...(m.taskUrl ? [['任务链接', `<a href="${escapeHtml(m.taskUrl)}" target="_blank" rel="noreferrer noopener" style="color:#1570ef;text-decoration:none;">${escapeHtml(m.taskUrl)}</a>`] as [string, string]] : []),
  ];

  const metaTableHtml = `<table class="meta-table" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13.5px;">
    ${metaRows.map(([k, v]) => `<tr>
      <td style="width:110px;padding:7px 12px;background:#f8fafc;border:1px solid #e4e7ec;color:#475467;font-weight:600;vertical-align:top;">${escapeHtml(k)}</td>
      <td style="padding:7px 12px;background:#ffffff;border:1px solid #e4e7ec;color:#101828;vertical-align:top;word-break:break-word;">${v}</td>
    </tr>`).join('')}
  </table>`;

  const staleBannerHtml = m.staleNote
    ? `<div style="margin-top:14px;padding:10px 14px;border-radius:8px;background:#fffaeb;border:1px solid #fedf89;color:#b54708;font-size:13.5px;"><strong>提醒：</strong>${escapeHtml(m.staleNote)}</div>`
    : '';

  const summaryHtml = m.summary
    ? `<div class="section">
        <h2 class="section-title">一句话结论</h2>
        <div style="padding:14px 16px;border-radius:8px;background:#f8fafc;border-left:4px solid #1570ef;color:#101828;font-size:14.5px;line-height:1.75;">${paragraphsHtml(m.summary)}</div>
      </div>`
    : '';

  const nextStepsHtml = m.nextSteps.length
    ? `<div class="section">
        <h2 class="section-title">接下来建议怎么处理</h2>
        <ol style="margin:8px 0 0;padding-left:22px;color:#1d2939;line-height:1.8;">
          ${m.nextSteps.map(step => `<li style="margin-bottom:4px;">${escapeHtml(step)}</li>`).join('')}
        </ol>
      </div>`
    : '';

  const findingsHtml = `<div class="section">
    <h2 class="section-title">问题清单</h2>
    ${!m.groups.length
      ? `<div style="padding:14px 16px;border-radius:8px;background:#ecfdf3;border:1px solid #abefc6;color:#067647;">本次评审未发现需要整改的问题。</div>`
      : m.groups.map(group => {
          const style = TONE_STYLES[group.meta.tone];
          return `<div style="margin-top:16px;">
            <h3 style="margin:0 0 4px;font-size:15.5px;color:${style.text};">${escapeHtml(group.meta.heading.replace(/）$/, ` · ${group.items.length} 项）`))}</h3>
            <p style="margin:0 0 10px;font-size:13px;color:#667085;">${escapeHtml(group.meta.hint)}</p>
            ${group.items.map((finding, idx) => `<div class="finding-card" style="margin-bottom:12px;padding:13px 15px;border:1px solid #e4e7ec;border-left:4px solid ${style.border};border-radius:8px;background:#ffffff;page-break-inside:avoid;">
              <div style="margin-bottom:8px;font-size:14.5px;font-weight:600;color:#101828;">
                ${badgeHtml(group.meta.shortLabel, group.meta.tone)}
                <span style="margin-left:6px;">${idx + 1}. ${escapeHtml(finding.title)}</span>
                ${finding.categoryLabel ? ` <span style="margin-left:4px;">${badgeHtml(finding.categoryLabel, 'neutral')}</span>` : ''}
                ${finding.waiverText ? ` <span style="margin-left:4px;">${badgeHtml(finding.waiverText, 'na')}</span>` : ''}
              </div>
              <table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13.5px;">
                ${finding.sections.map(sec => `<tr>
                  <td style="width:92px;padding:4px 8px 4px 0;color:#475467;font-weight:600;vertical-align:top;white-space:nowrap;">${escapeHtml(sec.label)}</td>
                  <td style="padding:4px 0;color:#1d2939;line-height:1.7;word-break:break-word;">${paragraphsHtml(sec.text)}</td>
                </tr>`).join('')}
                ${finding.locations.length ? `<tr>
                  <td style="width:92px;padding:4px 8px 4px 0;color:#475467;font-weight:600;vertical-align:top;white-space:nowrap;">涉及位置</td>
                  <td style="padding:4px 0;color:#475467;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all;">${finding.locations.map(escapeHtml).join('<br/>')}</td>
                </tr>` : ''}
              </table>
              ${finding.suggestedPatch ? `<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:#f8fafc;border:1px solid #e4e7ec;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;">${
                finding.suggestedPatch.before ? `<div style="color:#b42318;">- ${escapeHtml(finding.suggestedPatch.before)}</div>` : ''
              }${
                finding.suggestedPatch.after ? `<div style="color:#067647;">+ ${escapeHtml(finding.suggestedPatch.after)}</div>` : ''
              }</div>` : ''}
            </div>`).join('')}
          </div>`;
        }).join('')}
  </div>`;

  const clarifyHtml = m.clarifyQuestions.length
    ? `<div class="section">
        <h2 class="section-title">待确认事项（${m.clarifyQuestions.length} 项）</h2>
        <table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;width:96px;">状态 / 角色</th>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;">需要确认的问题与影响</th>
            </tr>
          </thead>
          <tbody>
            ${m.clarifyQuestions.map(q => `<tr>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;">
                ${badgeHtml(q.resolved ? '已确认' : '待确认', q.resolved ? 'pass' : 'warn')}
                ${q.owner ? `<div style="margin-top:4px;font-size:12px;color:#475467;">${escapeHtml(q.owner)}</div>` : ''}
              </td>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;line-height:1.65;">
                <div style="font-weight:600;color:#101828;">${escapeHtml(q.question)}</div>
                ${q.impact ? `<div style="margin-top:4px;color:#475467;font-size:13px;">影响说明：${escapeHtml(q.impact)}</div>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const complianceHtml = m.compliance
    ? `<div class="section">
        <h2 class="section-title">验收达标情况</h2>
        ${m.compliance.compliant.length ? `<div style="margin-bottom:10px;">
          <div style="margin-bottom:4px;">${badgeHtml(`已满足（${m.compliance.compliant.length} 项）`, 'pass')}</div>
          <ul style="margin:4px 0 0;padding-left:20px;line-height:1.7;">${m.compliance.compliant.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>` : ''}
        ${m.compliance.missing.length ? `<div style="margin-bottom:10px;">
          <div style="margin-bottom:4px;">${badgeHtml(`尚未满足 / 存在缺口（${m.compliance.missing.length} 项）`, 'fail')}</div>
          <ul style="margin:4px 0 0;padding-left:20px;line-height:1.7;">${m.compliance.missing.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>` : ''}
        ${m.compliance.manualCheck.length ? `<div style="margin-bottom:4px;">
          <div style="margin-bottom:4px;">${badgeHtml(`需人工 / 真机实测确认（${m.compliance.manualCheck.length} 项）`, 'warn')}</div>
          <ul style="margin:4px 0 0;padding-left:20px;line-height:1.7;">${m.compliance.manualCheck.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>` : ''}
      </div>`
    : '';

  const walkthroughHtml = m.walkthrough.length
    ? `<div class="section">
        <h2 class="section-title">本次审查范围概览（${m.walkthrough.length} 项）</h2>
        <table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;width:30%;">文件 / 模块</th>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;">审查说明</th>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;width:82px;">风险</th>
            </tr>
          </thead>
          <tbody>
            ${m.walkthrough.map(w => `<tr>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;">${escapeHtml(w.file)}</td>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;line-height:1.65;">${escapeHtml(w.summary)}</td>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;white-space:nowrap;">${w.riskLabel ? badgeHtml(w.riskLabel, w.riskTone) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const checklistHtml = m.checklist.length
    ? `<div class="section">
        <h2 class="section-title">逐项检查清单（${escapeHtml(m.checklistSummaryText)}）</h2>
        <table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;width:78px;">状态</th>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;width:28%;">检查项</th>
              <th style="text-align:left;padding:8px 10px;background:#f8fafc;border:1px solid #e4e7ec;">说明与参考</th>
            </tr>
          </thead>
          <tbody>
            ${m.checklist.map(c => `<tr>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;white-space:nowrap;">${badgeHtml(c.resultLabel, c.resultTone)}</td>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;font-weight:600;color:#101828;">${escapeHtml(c.item)}</td>
              <td style="padding:8px 10px;border:1px solid #e4e7ec;vertical-align:top;line-height:1.65;word-break:break-word;">
                ${c.note ? `<div>${escapeHtml(c.note)}</div>` : ''}
                ${c.ref ? `<div style="margin-top:4px;font-size:12px;color:#667085;">参考：${escapeHtml(c.ref)}</div>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const evidenceHtml = m.evidence
    ? `<div class="section">
        <h2 class="section-title">附：核查依据</h2>
        <div style="padding:12px 14px;border-radius:8px;background:#f8fafc;border:1px solid #e4e7ec;color:#475467;font-size:13px;line-height:1.75;word-break:break-word;">${paragraphsHtml(m.evidence)}</div>
      </div>`
    : '';

  const htmlOpen = forWord
    ? '<html lang="zh-CN" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    : '<html lang="zh-CN">';

  const wordHeadXml = forWord
    ? '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->'
    : '';

  const printBarHtml = forWord
    ? ''
    : `<div class="no-print" style="max-width:880px;margin:0 auto 14px;display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" onclick="window.print()" style="padding:7px 14px;border-radius:6px;border:1px solid #1570ef;background:#1570ef;color:#fff;font-size:13px;font-weight:500;cursor:pointer;">打印 / 另存为 PDF</button>
      </div>`;

  return `<!DOCTYPE html>
${htmlOpen}
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(m.docTitle)}</title>
  ${wordHeadXml}
  <style>
    body {
      margin: 0;
      padding: ${forWord ? '16px' : '24px 16px 40px'};
      background: ${forWord ? '#ffffff' : '#f4f6f9'};
      color: #1d2939;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.7;
    }
    .page {
      max-width: 880px;
      margin: 0 auto;
      background: #ffffff;
      ${forWord ? '' : 'border: 1px solid #e4e7ec; border-radius: 12px; padding: 28px 32px; box-shadow: 0 2px 12px rgba(16, 24, 40, 0.04);'}
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.35;
      color: #101828;
    }
    .subtitle {
      margin: 6px 0 0;
      font-size: 14px;
      color: #475467;
    }
    .section {
      margin-top: 24px;
    }
    .section-title {
      margin: 0 0 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid #eaecf0;
      font-size: 16.5px;
      color: #101828;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .page { border: 0; border-radius: 0; box-shadow: none; padding: 0; max-width: none; }
      .no-print { display: none !important; }
      .finding-card { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${printBarHtml}
  <main class="page">
    <header>
      <h1>${escapeHtml(m.stageText)}报告</h1>
      <p class="subtitle">${escapeHtml(fullHeading)}</p>
    </header>
    ${metaTableHtml}
    ${staleBannerHtml}
    ${summaryHtml}
    ${nextStepsHtml}
    ${findingsHtml}
    ${clarifyHtml}
    ${complianceHtml}
    ${walkthroughHtml}
    ${checklistHtml}
    ${evidenceHtml}
  </main>
</body>
</html>`;
}

export function reviewExportFilename(
  task: Pick<ReviewExportInput['task'], 'jiraKey' | 'title'>,
  stage: Stage,
  ext: 'doc' | 'md' | 'html',
): string {
  const cleanPart = (value: string) =>
    value
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^-+|-+$/g, '');
  const key = cleanPart(task.jiraKey || '') || cleanPart(task.title || '').slice(0, 24) || '评审任务';
  const stageName = cleanPart(stageLabel(stage)) || '评审';
  return `${key}-${stageName}报告.${ext}`;
}

export function downloadReviewDocument(content: string, filename: string, mimeType: string, withBom = false): void {
  const payload = withBom ? `\uFEFF${content}` : content;
  const blob = new Blob([payload], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function printReviewReportHtml(html: string): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';

  const cleanup = () => {
    if (iframe.parentNode) iframe.remove();
  };

  iframe.onload = () => {
    try {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      win.addEventListener('afterprint', cleanup, { once: true });
      win.focus();
      win.print();
      setTimeout(cleanup, 60_000);
    } catch {
      cleanup();
    }
  };

  iframe.srcdoc = html;
  document.body.appendChild(iframe);
  return true;
}

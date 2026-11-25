import { memberName, STAGES, type Asset, type AssetKind, type Gates, type GateStage, type ReviewJob, type Stage, type User, type WorkTask } from './workspaceApi.ts';
import { assetKindLabel, gateStatusLabel, stageLabel, taskStatusLabel } from './displayLabels.ts';
import { analyzeAssetRiskSignals } from './assetDiff.ts';
import { selectLatestAssets } from './taskContextPack.ts';
import { acceptanceCoverage, compareJenkinsCommits } from './releaseEvidence.ts';

export type ReadinessGrade = 'READY' | 'ALMOST' | 'IN_PROGRESS' | 'EARLY';

export interface ReadinessCheckItem {
  id: 'assets' | 'gates' | 'blockers' | 'traceability' | 'buildCommit' | 'rollback';
  label: string;
  status: 'pass' | 'warn' | 'fail';
  points: number;
  maxPoints: number;
  detail: string;
  evidence?: string[];
  targetStage?: Stage;
  targetAssetKind?: AssetKind;
}

export interface StageTraceabilityRow {
  stage: Stage;
  stageLabel: string;
  assetKind: AssetKind;
  latestAsset: Asset | null;
  gateStatus: string;
  jobId: string | null;
  approverId: string | null;
  approvedAt: string | null;
  waivedCount: number;
}

export interface ReleaseReadinessEvaluation {
  score: number;
  grade: ReadinessGrade;
  checks: ReadinessCheckItem[];
  traceabilityChain: StageTraceabilityRow[];
  highRiskRequiresRollback: boolean;
  highRiskLabels: string[];
  unwaivedCriticalCount: number;
  waivedCriticalCount: number;
}

const STAGE_TO_ASSET: Record<GateStage, AssetKind> = {
  PRD: 'PRD',
  TECH_SPEC: 'TECH_SPEC',
  CODE_REVIEW: 'CODE',
  TEST_CASE: 'TEST_CASE',
  RELEASE: 'RELEASE_PLAN',
};

const ROLLBACK_KEYWORDS_RE = /(?:回滚|回退|降级|熔断|开关关闭|兜底|恢复步骤|rollback|revert|feature\s*flag|canary)/i;
const TEST_ITEM_LINE_RE = /^\s*(?:[-*]\s+\[[ xX]\]|\d+\.\s+|###?\s+.*(?:用例|场景|测试|Case|Scenario)|[-*]\s+.*(?:验证|断言|输入|预期|异常|边界))/gm;

export function countStructuredTestItems(content: string): number {
  if (!content) return 0;
  const matches = content.match(TEST_ITEM_LINE_RE);
  return matches ? matches.length : 0;
}

export function evaluateReleaseReadiness(params: {
  task: WorkTask;
  assets: readonly Asset[];
  jobs: readonly ReviewJob[];
  gates: Gates | null;
}): ReleaseReadinessEvaluation {
  const { assets, jobs, gates } = params;
  const latestAssets = selectLatestAssets(assets);

  const latestByKind = new Map<AssetKind, Asset>();
  for (const asset of latestAssets) {
    const prev = latestByKind.get(asset.kind);
    if (!prev || asset.revision > prev.revision) {
      latestByKind.set(asset.kind, asset);
    }
  }

  // Latest active job per stage
  const latestJobByStage = new Map<Stage, ReviewJob>();
  for (const job of jobs) {
    if (!latestJobByStage.has(job.stage)) {
      latestJobByStage.set(job.stage, job);
    }
  }

  const traceabilityChain: StageTraceabilityRow[] = STAGES.map(s => {
    const assetKind = STAGE_TO_ASSET[s.value];
    const latestAsset = latestByKind.get(assetKind) || null;
    const gate = gates?.gates.find(g => g.stage === s.value);
    const stageJob = (gate?.jobId ? jobs.find(j => j.id === gate.jobId) : undefined) || latestJobByStage.get(s.value);
    const approved = stageJob && !stageJob.stale && stageJob.decision?.decision === 'APPROVE' ? stageJob.decision : null;
    const waivedCount = stageJob ? stageJob.findings.filter(f => f.severity === 'CRITICAL' && !!f.waiver).length : 0;
    return {
      stage: s.value,
      stageLabel: s.label,
      assetKind,
      latestAsset,
      gateStatus: gate?.status || 'PENDING',
      jobId: stageJob?.id || null,
      approverId: approved?.actorId || null,
      approvedAt: approved?.createdAt || null,
      waivedCount,
    };
  });

  // 1. Five-stage required asset coverage (25 pts)
  const presentKindsCount = traceabilityChain.filter(row => !!row.latestAsset).length;
  const missingKinds = traceabilityChain.filter(row => !row.latestAsset).map(row => assetKindLabel(row.assetKind));
  const assetsPoints = presentKindsCount * 5;
  const firstMissingRow = traceabilityChain.find(row => !row.latestAsset);

  // 2. Five-stage quality gate sign-offs (35 pts)
  const passedGatesCount = traceabilityChain.filter(row => row.gateStatus === 'PASS').length;
  const gatesPoints = passedGatesCount * 7;
  const firstUnpassedGate = traceabilityChain.find(row => row.gateStatus !== 'PASS');

  // 3. Unwaived CRITICAL findings across latest active stage jobs (20 pts)
  let unwaivedCriticalCount = 0;
  let waivedCriticalCount = 0;
  let firstBlockerStage: Stage | undefined;
  for (const row of traceabilityChain) {
    const stageJob = latestJobByStage.get(row.stage);
    if (!stageJob || stageJob.stale) continue;
    for (const f of stageJob.findings) {
      if (f.severity === 'CRITICAL') {
        if (f.waiver) {
          waivedCriticalCount += 1;
        } else {
          unwaivedCriticalCount += 1;
          if (!firstBlockerStage) firstBlockerStage = row.stage;
        }
      }
    }
  }
  const blockersPoints = unwaivedCriticalCount === 0 ? 20 : 0;

  // 4. PRD <-> TEST_CASE traceability check (10 pts)
  const criteria = acceptanceCoverage(latestAssets, params.task.externalRef?.description);
  const covered = criteria.filter(item => item.testCases.length).length;
  const uncoveredIds = [...new Set(criteria.filter(item => !item.testCases.length).map(item => item.id).filter(Boolean))];
  const traceabilityStatus = !criteria.length ? 'warn' : covered === criteria.length ? 'pass' : 'fail';
  const traceabilityDetail = criteria.length
    ? `${covered}/${criteria.length} 条验收项关联了用例${uncoveredIds.length ? '，待核对 ' + uncoveredIds.slice(0, 5).join('、') + (uncoveredIds.length > 5 ? ' 等' : '') : ''}`
    : '没有识别到验收项，请核对需求材料中的验收标准';
  const buildCommit = compareJenkinsCommits(latestAssets, jobs, gates);
  const buildCommitStatus = buildCommit.details.some(item => item.status === 'fail') ? 'fail'
    : !buildCommit.hasBuilds || buildCommit.details.some(item => item.status === 'warn') ? 'warn' : 'pass';

  // 5. High-risk change & rollback runbook verification (10 pts)
  const riskLabelSet = new Set<string>();
  for (const asset of latestAssets) {
    if (['CODE', 'TECH_SPEC'].includes(asset.kind)) {
      const risk = analyzeAssetRiskSignals(asset.content);
      for (const sig of risk.signals) {
        if (sig.level === 'HIGH' || sig.level === 'MEDIUM') {
          riskLabelSet.add(sig.label);
        }
      }
    }
  }
  const highRiskLabels = [...riskLabelSet];
  const releasePlan = latestByKind.get('RELEASE_PLAN');
  const hasRollbackPlan = !!releasePlan && ROLLBACK_KEYWORDS_RE.test(releasePlan.content);
  const highRiskRequiresRollback = highRiskLabels.length > 0 && !hasRollbackPlan;

  let rollbackPoints = 0;
  let rollbackStatus: 'pass' | 'warn' | 'fail' = 'warn';
  let rollbackDetail = '待登记上线方案与回滚预案';
  if (releasePlan && hasRollbackPlan) {
    rollbackPoints = 10;
    rollbackStatus = 'pass';
    rollbackDetail = highRiskLabels.length > 0
      ? `已针对高敏变更（${highRiskLabels.join('、')}）明确回滚/兜底预案`
      : `上线方案 r${releasePlan.revision} 已包含回滚与应急兜底策略`;
  } else if (releasePlan && !hasRollbackPlan) {
    rollbackPoints = highRiskLabels.length > 0 ? 2 : 5;
    rollbackStatus = highRiskLabels.length > 0 ? 'fail' : 'warn';
    rollbackDetail = highRiskLabels.length > 0
      ? `检测到【${highRiskLabels.join('、')}】，上线方案必须补充明确回滚步骤！`
      : '已登记上线方案，建议补充回滚触发阈值与回退步骤';
  } else if (highRiskLabels.length > 0) {
    rollbackPoints = 0;
    rollbackStatus = 'fail';
    rollbackDetail = `检测到【${highRiskLabels.join('、')}】，尚未登记上线与回滚方案`;
  }

  const checks: ReadinessCheckItem[] = [
    {
      id: 'assets',
      label: '五阶段交付材料齐备度',
      status: presentKindsCount === 5 ? 'pass' : presentKindsCount >= 3 ? 'warn' : 'fail',
      points: assetsPoints,
      maxPoints: 25,
      detail: presentKindsCount === 5 ? '5 类核心材料均已归档最新修订与 SHA-256 指纹' : `已齐备 ${presentKindsCount}/5 类，缺：${missingKinds.join('、')}`,
      targetAssetKind: firstMissingRow?.assetKind,
    },
    {
      id: 'gates',
      label: '五阶段门禁审批签字',
      status: passedGatesCount === 5 ? 'pass' : passedGatesCount >= 3 ? 'warn' : 'fail',
      points: gatesPoints,
      maxPoints: 35,
      detail: passedGatesCount === 5 ? '全部 5 道质量门禁均已审批放行' : `已通过 ${passedGatesCount}/5 道门禁${firstUnpassedGate ? `（卡点：${firstUnpassedGate.stageLabel}）` : ''}`,
      targetStage: firstUnpassedGate?.stage,
    },
    {
      id: 'blockers',
      label: '未豁免阻断问题清零',
      status: unwaivedCriticalCount === 0 ? 'pass' : 'fail',
      points: blockersPoints,
      maxPoints: 20,
      detail: unwaivedCriticalCount === 0
        ? (waivedCriticalCount > 0 ? `无未豁免阻断项（含 ${waivedCriticalCount} 项已留痕豁免）` : '当前有效评审零阻断问题')
        : `存在 ${unwaivedCriticalCount} 项未豁免阻断问题待修复或独立豁免`,
      targetStage: firstBlockerStage,
    },
    {
      id: 'traceability',
      label: '需求-测试用例追溯覆盖',
      status: traceabilityStatus,
      points: criteria.length ? Math.floor(covered * 10 / criteria.length) : 0,
      maxPoints: 10,
      detail: traceabilityDetail,
      evidence: criteria.map(item => `${item.text}（${item.source}） → ${item.testCases.length ? item.testCases.join('、') : item.reason}`),
      targetAssetKind: !criteria.length ? 'PRD' : covered < criteria.length ? 'TEST_CASE' : undefined,
    },
    {
      id: 'buildCommit',
      label: 'Jenkins 构建提交核验',
      status: buildCommitStatus,
      points: 0,
      maxPoints: 0,
      detail: !buildCommit.hasBuilds ? '暂无 Jenkins 构建材料，请关联本次上线的具体构建'
        : buildCommitStatus === 'pass' ? 'Jenkins 构建提交与代码审核快照一致'
          : buildCommitStatus === 'fail' ? 'Jenkins 构建提交与代码审核快照不一致'
            : '构建或代码审核快照缺少可比较的提交证据',
      evidence: buildCommit.details.map(item => item.text),
    },
    {
      id: 'rollback',
      label: '变更风险与回滚预案核查',
      status: rollbackStatus,
      points: rollbackPoints,
      maxPoints: 10,
      detail: rollbackDetail,
      targetAssetKind: !releasePlan || !hasRollbackPlan ? 'RELEASE_PLAN' : undefined,
    },
  ];

  const score = Math.min(100, Math.max(0, checks.reduce((sum, c) => sum + c.points, 0)));
  const allGatesPassed = gates?.overall === 'PASS' && passedGatesCount === 5;
  const grade: ReadinessGrade =
    score >= 95 && allGatesPassed && traceabilityStatus === 'pass' && (!buildCommit.hasBuilds || buildCommitStatus === 'pass') ? 'READY'
      : score >= 75 ? 'ALMOST'
        : score >= 40 ? 'IN_PROGRESS'
          : 'EARLY';

  return {
    score,
    grade,
    checks,
    traceabilityChain,
    highRiskRequiresRollback,
    highRiskLabels,
    unwaivedCriticalCount,
    waivedCriticalCount,
  };
}

export function buildReleaseDossierMarkdown(params: {
  task: WorkTask;
  assets: readonly Asset[];
  jobs: readonly ReviewJob[];
  gates: Gates | null;
  members: readonly User[];
  repoPath?: string | null;
}): string {
  const { task, assets, jobs, gates, members, repoPath = null } = params;
  const readiness = evaluateReleaseReadiness({ task, assets, jobs, gates });
  const memberList = members as User[];

  const lines: string[] = [
    `# 变更发布就绪度与全链路追溯档案 · ${task.jiraKey}`,
    '',
    `- **任务标题**：${task.title}`,
    `- **本地状态**：${taskStatusLabel(task.status)}（自报进度 ${task.progress}%）`,
    `- **受理研发**：${memberName(memberList, task.assigneeId)}`,
    ...(repoPath ? [`- **关联仓库**：\`${repoPath}\``] : []),
    ...(task.externalRef?.url ? [`- **Jira 链接**：${task.externalRef.url}`] : []),
    `- **发布就绪度评分**：**${readiness.score} / 100**（门禁总状态：${gates ? gateStatusLabel(gates.overall) : '未计算'}）`,
    '',
    '## 1. 五阶段全链路追溯与签字矩阵（Traceability & Sign-off）',
    '',
    '| 阶段 | 绑定材料修订 | SHA-256 指纹 | 门禁状态 | 审批签字 |',
    '| --- | --- | --- | --- | --- |',
    ...readiness.traceabilityChain.map(row => {
      const assetCell = row.latestAsset
        ? `${row.latestAsset.title.replace(/\|/g, '\\|')} (\`r${row.latestAsset.revision}\`)`
        : '_未登记_';
      const shaCell = row.latestAsset ? `\`${row.latestAsset.sha256.slice(0, 12)}\`` : '—';
      const signoffCell = row.approverId
        ? `${memberName(memberList, row.approverId)}${row.waivedCount ? `（含 ${row.waivedCount} 项豁免）` : ''}`
        : '—';
      return `| ${row.stageLabel} | ${assetCell} | ${shaCell} | ${gateStatusLabel(row.gateStatus)} | ${signoffCell} |`;
    }),
    '',
    '## 2. 发布前就绪度核查清单（Shipit Readiness Checklist）',
    '',
    ...readiness.checks.flatMap(check => [
      `- [${check.status === 'pass' ? 'x' : ' '}] **${check.label}**${check.maxPoints ? `（${check.points}/${check.maxPoints} 分）` : ''}：${check.detail}`,
      ...(check.evidence ?? []).map(item => '  - ' + item),
    ]),
  ];

  if (readiness.highRiskLabels.length > 0) {
    lines.push(
      '',
      '## 3. 静态高敏变更信号提示',
      '',
      `- 识别到的敏感变更特征：${readiness.highRiskLabels.map(l => `**${l}**`).join('、')}`,
      `- 回滚预案核验：${readiness.highRiskRequiresRollback ? '⚠️ 尚未在上线方案中检测到明确回滚步骤，请补齐后再发布' : '✅ 已在上线方案中包含回滚/兜底策略'}`,
    );
  }

  const waivedEntries: { stage: Stage; title: string; reason: string; actorId: string }[] = [];
  for (const job of jobs) {
    if (job.stale) continue;
    for (const f of job.findings) {
      if (f.waiver) {
        waivedEntries.push({
          stage: job.stage,
          title: f.title,
          reason: f.waiver.reason,
          actorId: f.waiver.actorId,
        });
      }
    }
  }

  if (waivedEntries.length > 0) {
    lines.push(
      '',
      `## ${readiness.highRiskLabels.length > 0 ? '4' : '3'}. 阻断问题豁免留痕台账`,
      '',
      ...waivedEntries.map(
        w => `- **[${stageLabel(w.stage)}]** ${w.title} — 豁免人：${memberName(memberList, w.actorId)}；理由：${w.reason}`,
      ),
    );
  }

  return lines.join('\n');
}

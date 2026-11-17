import { STAGES, type OverviewStageStat, type OverviewSummaryJob, type Project, type ProjectWorkspace, type Stage, type User, type WorkTask } from './workspaceApi.ts';
import { stageLabel, taskStatusLabel, taskTypeLabel } from './displayLabels.ts';
import { isSafeHttpUrl } from './markdownLite.ts';

function formatTaskRef(task: WorkTask): string {
  const url = task.externalRef?.url;
  if (typeof url === 'string' && isSafeHttpUrl(url)) {
    return `[${task.jiraKey}](${url})`;
  }
  return `\`${task.jiraKey}\``;
}

function repoBasename(repoPath?: string | null): string {
  if (!repoPath) return '';
  const parts = repoPath.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

export interface PersonalStandupParams {
  user: User;
  projects: readonly Project[];
  tasks: readonly WorkTask[];
  pendingJobs: readonly OverviewSummaryJob[];
  workspaces?: readonly ProjectWorkspace[];
  openBlockersCount?: number;
  now?: Date;
}

export function buildPersonalStandupDigest(params: PersonalStandupParams): string {
  const {
    user,
    projects,
    tasks,
    pendingJobs,
    workspaces = [],
    openBlockersCount = 0,
    now = new Date(),
  } = params;

  const dateStr = now.toISOString().slice(0, 10);
  const visibleProjectIds = new Set(projects.map(p => p.id));
  const projectMap = new Map(projects.map(p => [p.id, p]));
  const wsByProject = new Map(workspaces.map(ws => [ws.projectId, ws]));
  const scopedTasks = tasks.filter(t => visibleProjectIds.has(t.projectId));
  const taskById = new Map(scopedTasks.map(t => [t.id, t]));

  const myDone = scopedTasks
    .filter(t => t.assigneeId === user.id && t.status === 'DONE')
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, 8);

  const myActive = scopedTasks
    .filter(t => t.assigneeId === user.id && t.status !== 'DONE')
    .sort((a, b) => {
      const rank = (s: WorkTask['status']) => (s === 'IN_REVIEW' ? 0 : s === 'IN_PROGRESS' ? 1 : 2);
      const diff = rank(a.status) - rank(b.status);
      if (diff !== 0) return diff;
      return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    });

  const actionablePending = pendingJobs.filter(j => !j.stale && !j.decision && !!j.report && taskById.has(j.taskId));
  const blockedPending = actionablePending.filter(j => j.hasBlockingFindings || j.prerequisitesBlocked);

  const lines: string[] = [
    `# 研发晨会简报 · ${dateStr}`,
    '',
    `> 汇报人：**${user.username}** ｜ 进行中待办：**${myActive.length}** 项 ｜ 已完成核验：**${myDone.length}** 项`,
    '',
    '## 已完成核验 (Done)',
  ];

  if (myDone.length === 0) {
    lines.push('- 暂无近期已结项任务');
  } else {
    for (const t of myDone) {
      const proj = projectMap.get(t.projectId);
      lines.push(`- ${formatTaskRef(t)} **${t.title}**${proj ? `（${proj.name}）` : ''}`);
    }
  }

  lines.push('', '## 今日推进与评审中 (Today)');
  if (myActive.length === 0) {
    lines.push('- 当前名下无未完成任务，可前往任务中心认领新事项');
  } else {
    for (const t of myActive) {
      const ws = wsByProject.get(t.projectId);
      const repoName = repoBasename(ws?.repoPath);
      const metaParts = [
        taskStatusLabel(t.status),
        t.progress > 0 ? `进度 ${t.progress}%` : '',
        repoName ? `仓库 \`${repoName}\`` : '',
      ].filter(Boolean);
      const summarySuffix = t.lastSummary?.trim() ? ` — ${t.lastSummary.trim().replace(/\s+/g, ' ').slice(0, 90)}` : '';
      lines.push(`- [ ] ${formatTaskRef(t)} **${t.title}**（${metaParts.join(' · ')}）${summarySuffix}`);
    }
  }

  lines.push('', '## 待跟进的阶段评审 (Reviews)');
  if (actionablePending.length === 0) {
    lines.push('- 当前无积压待审批报告');
  } else {
    for (const job of actionablePending.slice(0, 8)) {
      const t = taskById.get(job.taskId);
      const ref = t ? `${formatTaskRef(t)} ${t.title}` : `\`${job.taskId}\``;
      const flag = job.hasBlockingFindings ? '（含未豁免阻断项）' : job.prerequisitesBlocked ? '（前置门禁未全通）' : '';
      lines.push(`- ${ref} — **${stageLabel(job.stage)}** 待审批${flag}`);
    }
  }

  lines.push('', '## 风险与阻断卡点 (Blockers)');
  if (openBlockersCount === 0 && blockedPending.length === 0) {
    lines.push('- 暂无未豁免 CRITICAL 阻断项，链路流转正常');
  } else {
    if (openBlockersCount > 0) {
      lines.push(`- 当前可见项目共有 **${openBlockersCount}** 项未豁免的 CRITICAL 阻断发现项待修复或豁免`);
    }
    for (const b of blockedPending.slice(0, 5)) {
      const t = taskById.get(b.taskId);
      lines.push(
        `- ${t ? formatTaskRef(t) : `\`${b.taskId}\``} 【${stageLabel(b.stage)}】${
          b.hasBlockingFindings ? '存在 CRITICAL 阻断问题' : '等待前序四阶段门禁放行'
        }`,
      );
    }
  }

  return lines.join('\n');
}

export interface ProjectSprintDigestParams {
  projects: readonly Project[];
  tasks: readonly WorkTask[];
  stageBreakdown?: Partial<Record<Stage, OverviewStageStat>>;
  openBlockersCount?: number;
  reviewCount?: number;
  assetCount?: number;
  now?: Date;
}

export function buildProjectSprintDigest(params: ProjectSprintDigestParams): string {
  const {
    projects,
    tasks,
    stageBreakdown,
    openBlockersCount,
    reviewCount,
    assetCount,
    now = new Date(),
  } = params;

  const dateStr = now.toISOString().slice(0, 10);
  const visibleProjectIds = new Set(projects.map(p => p.id));
  const scopedTasks = tasks.filter(t => visibleProjectIds.has(t.projectId));

  const total = scopedTasks.length;
  const done = scopedTasks.filter(t => t.status === 'DONE').length;
  const inReview = scopedTasks.filter(t => t.status === 'IN_REVIEW').length;
  const inProgress = scopedTasks.filter(t => t.status === 'IN_PROGRESS').length;
  const unclaimed = scopedTasks.filter(t => !t.assigneeId && t.status !== 'DONE').length;
  const rate = total > 0 ? Math.round((done / total) * 100) : 0;

  const scopeTitle = projects.length === 1 ? `${projects[0].key} · ${projects[0].name}` : `${projects.length} 个可见项目汇总`;

  const summaryParts = [
    `完成率：**${rate}%**（${done}/${total}）`,
    `评审中：**${inReview}**`,
    `进行中：**${inProgress}**`,
    `待认领：**${unclaimed}**`,
    ...(typeof openBlockersCount === 'number' ? [`活跃阻断：**${openBlockersCount}**`] : []),
  ];

  const lines: string[] = [
    `# 项目迭代交付简报 · ${scopeTitle} (${dateStr})`,
    '',
    `> ${summaryParts.join(' ｜ ')}`,
  ];

  if (typeof assetCount === 'number' && typeof reviewCount === 'number') {
    lines.push(`> 累计沉淀版本化材料：**${assetCount}** 份 ｜ 阶段评审记录：**${reviewCount}** 次`);
  }

  if (stageBreakdown) {
    lines.push(
      '',
      '## 五阶段质量门禁漏斗',
      '',
      '| 门禁阶段 | 已批准放行 | 待独立审批 | 待提交报告 | 退回修改 |',
      '| --- | --- | --- | --- | --- |',
    );

    for (const s of STAGES) {
      const st = stageBreakdown[s.value] || { approved: 0, pendingApproval: 0, awaitingReport: 0, changesRequested: 0 };
      lines.push(`| ${s.label} | ${st.approved} | ${st.pendingApproval} | ${st.awaitingReport} | ${st.changesRequested} |`);
    }
  }

  const typesOrder: WorkTask['type'][] = ['STORY', 'TASK', 'BUG', 'RELEASE'];
  lines.push('', '## 事项分类进展明细');

  if (scopedTasks.length === 0) {
    lines.push('', '- 当前范围暂无登记任务');
  } else {
    for (const tp of typesOrder) {
      const group = scopedTasks.filter(t => t.type === tp);
      if (!group.length) continue;
      const groupDone = group.filter(t => t.status === 'DONE').length;
      lines.push('', `### ${taskTypeLabel(tp)}（已完成 ${groupDone} / ${group.length}）`);
      for (const t of group.slice(0, 15)) {
        const check = t.status === 'DONE' ? 'x' : ' ';
        lines.push(`- [${check}] ${formatTaskRef(t)} **${t.title}** — ${taskStatusLabel(t.status)}${!t.assigneeId && t.status !== 'DONE' ? '（待认领）' : ''}`);
      }
      if (group.length > 15) {
        lines.push(`- ... 其余 ${group.length - 15} 项已省略`);
      }
    }
  }

  return lines.join('\n');
}

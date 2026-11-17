import { APPROVE_ROLES, REVIEW_ROLES, type OverviewSummaryJob, type ReviewJob, type Role, type User, type WorkTask } from './workspaceApi.ts';
import { isTaskFrozen } from './taskAvailability.ts';

export type ReviewHeatTier = 'DONE' | 'STALE' | 'FRESH' | 'WARM' | 'OVERDUE' | 'BURNING';

export interface ReviewSlaInfo {
  tier: ReviewHeatTier;
  elapsedMs: number;
  label: string;
  tagColor: 'default' | 'processing' | 'warning' | 'error' | 'success';
  isOverdue: boolean;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function formatCompactDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const minutes = Math.floor(safeMs / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = safeMs / HOUR_MS;
  if (hours < 24) {
    const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
    return `${rounded}h`;
  }
  const days = safeMs / DAY_MS;
  const roundedDays = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
  return `${roundedDays}d`;
}

type SlaJobInput = Pick<ReviewJob, 'status' | 'createdAt' | 'stale'> & {
  report?: { createdAt: string } | null;
  decision?: { decision?: string; createdAt: string } | null;
};

export function evaluateReviewSla(job: SlaJobInput, nowMs = Date.now()): ReviewSlaInfo {
  if (job.status === 'APPROVED') {
    const start = Date.parse(job.createdAt) || nowMs;
    const end = (job.decision?.createdAt ? Date.parse(job.decision.createdAt) : 0) || nowMs;
    const turnaround = Math.max(0, end - start);
    return {
      tier: 'DONE',
      elapsedMs: turnaround,
      label: `耗时 ${formatCompactDuration(turnaround)}`,
      tagColor: 'success',
      isOverdue: false,
    };
  }

  if (job.stale) {
    return {
      tier: 'STALE',
      elapsedMs: 0,
      label: '快照已过期',
      tagColor: 'default',
      isOverdue: false,
    };
  }

  const anchorIso =
    job.status === 'REPORT_SUBMITTED' && job.report?.createdAt
      ? job.report.createdAt
      : job.decision?.createdAt && job.status === 'CHANGES_REQUESTED'
        ? job.decision.createdAt
        : job.createdAt;

  const anchorMs = Date.parse(anchorIso) || nowMs;
  const elapsedMs = Math.max(0, nowMs - anchorMs);
  const compact = formatCompactDuration(elapsedMs);

  if (elapsedMs >= 72 * HOUR_MS) {
    return {
      tier: 'BURNING',
      elapsedMs,
      label: `严重滞留 ${compact}`,
      tagColor: 'error',
      isOverdue: true,
    };
  }
  if (elapsedMs >= 24 * HOUR_MS) {
    return {
      tier: 'OVERDUE',
      elapsedMs,
      label: `超 SLA ${compact}`,
      tagColor: 'warning',
      isOverdue: true,
    };
  }
  if (elapsedMs >= 4 * HOUR_MS) {
    return {
      tier: 'WARM',
      elapsedMs,
      label: `等待 ${compact}`,
      tagColor: 'processing',
      isOverdue: false,
    };
  }
  return {
    tier: 'FRESH',
    elapsedMs,
    label: `等待 ${compact}`,
    tagColor: 'default',
    isOverdue: false,
  };
}

export function isReviewActionableByUser(
  job: ReviewJob | OverviewSummaryJob,
  task: WorkTask | undefined,
  allTasks: readonly WorkTask[],
  user?: User | null,
  role?: Role,
): boolean {
  if (!user || !role || !task) return false;
  if (job.stale || job.decision || isTaskFrozen(task, [...allTasks])) return false;

  if (job.status === 'REPORT_SUBMITTED' && job.report) {
    const isIndependent = job.report.actorId !== user.id && task.assigneeId !== user.id;
    return (isIndependent || !!job.soloMode) && APPROVE_ROLES[job.stage].includes(role);
  }

  if (job.status === 'AWAITING_REPORT' || job.status === 'AWAITING_REVIEW') {
    return REVIEW_ROLES[job.stage].includes(role);
  }

  return false;
}

export function sortReviewsByQueuePriority<T extends SlaJobInput>(
  jobs: readonly T[],
  mode: 'newest' | 'oldest_waiting',
  nowMs = Date.now(),
): T[] {
  const copy = [...jobs];
  if (mode === 'newest') {
    return copy.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  }
  return copy.sort((a, b) => {
    const slaA = evaluateReviewSla(a, nowMs);
    const slaB = evaluateReviewSla(b, nowMs);
    const activeRank = (tier: ReviewHeatTier) =>
      tier === 'BURNING' ? 0 : tier === 'OVERDUE' ? 1 : tier === 'WARM' ? 2 : tier === 'FRESH' ? 3 : tier === 'STALE' ? 4 : 5;
    const rankDiff = activeRank(slaA.tier) - activeRank(slaB.tier);
    if (rankDiff !== 0) return rankDiff;
    return slaB.elapsedMs - slaA.elapsedMs;
  });
}

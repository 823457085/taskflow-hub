export type DoraPerformanceTier = 'ELITE' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA';

export interface OverviewFlowTelemetry {
  completedTasksTotal: number;
  medianLeadTimeHours: number | null;
  p90LeadTimeHours: number | null;
  decidedReviewsCount: number;
  approvedReviewsCount: number;
  reworkReviewsCount: number;
  firstTimePassRate: number | null;
  medianReviewTurnaroundHours: number | null;
  p90ReviewTurnaroundHours: number | null;
  throughput7d: {
    tasksDone: number;
    gatesApproved: number;
    assetsVersioned: number;
  };
}

export interface DoraGradeBadge {
  tier: DoraPerformanceTier;
  label: string;
  tagColor: 'success' | 'processing' | 'warning' | 'error' | 'default';
}

export function formatFlowHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  const safe = Math.max(0, hours);
  if (safe < 1) {
    const mins = Math.max(1, Math.round(safe * 60));
    return `${mins}m`;
  }
  if (safe < 48) {
    const rounded = safe >= 10 ? Math.round(safe) : Math.round(safe * 10) / 10;
    return `${rounded}h`;
  }
  const days = safe / 24;
  const roundedDays = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
  return `${roundedDays}d`;
}

export function gradeDoraLeadTime(medianHours: number | null | undefined): DoraGradeBadge {
  if (medianHours === null || medianHours === undefined || !Number.isFinite(medianHours)) {
    return { tier: 'NO_DATA', label: '待积累结项样本', tagColor: 'default' };
  }
  if (medianHours <= 24) return { tier: 'ELITE', label: '卓越 (<1d)', tagColor: 'success' };
  if (medianHours <= 168) return { tier: 'HIGH', label: '高效 (<7d)', tagColor: 'processing' };
  if (medianHours <= 720) return { tier: 'MEDIUM', label: '稳健 (<30d)', tagColor: 'warning' };
  return { tier: 'LOW', label: '长周期 (>30d)', tagColor: 'error' };
}

export function gradeReviewTurnaround(medianHours: number | null | undefined): DoraGradeBadge {
  if (medianHours === null || medianHours === undefined || !Number.isFinite(medianHours)) {
    return { tier: 'NO_DATA', label: '待积累审批样本', tagColor: 'default' };
  }
  if (medianHours <= 4) return { tier: 'ELITE', label: '极速 (≤4h)', tagColor: 'success' };
  if (medianHours <= 24) return { tier: 'HIGH', label: '当日闭环 (≤24h)', tagColor: 'processing' };
  if (medianHours <= 72) return { tier: 'MEDIUM', label: '常规 (≤3d)', tagColor: 'warning' };
  return { tier: 'LOW', label: '存在积压 (>3d)', tagColor: 'error' };
}

export function gradeFirstTimePassRate(ratePercent: number | null | undefined): DoraGradeBadge {
  if (ratePercent === null || ratePercent === undefined || !Number.isFinite(ratePercent)) {
    return { tier: 'NO_DATA', label: '暂无门禁决议', tagColor: 'default' };
  }
  if (ratePercent >= 85) return { tier: 'ELITE', label: '高稳定 (≥85%)', tagColor: 'success' };
  if (ratePercent >= 70) return { tier: 'HIGH', label: '良好 (≥70%)', tagColor: 'processing' };
  if (ratePercent >= 50) return { tier: 'MEDIUM', label: '返工偏高', tagColor: 'warning' };
  return { tier: 'LOW', label: '高频退回 (<50%)', tagColor: 'error' };
}

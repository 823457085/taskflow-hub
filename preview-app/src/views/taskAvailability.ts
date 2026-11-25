import { APPROVE_ROLES, isChildTask, type ReviewJob, type Role, type Stage, type User, type WorkTask } from './workspaceApi.ts';

export interface TaskAvailabilityNode {
  id: string;
  status: string;
  parentId: string | null;
}

// UI availability only; the service still checks task state and permissions.
export function isTaskFrozen(task: TaskAvailabilityNode | undefined, tasks: readonly TaskAvailabilityNode[]): boolean {
  if (!task) return true;
  const byId = new Map(tasks.map(item => [item.id, item]));
  const visited = new Set<string>();
  let current = task;
  while (true) {
    if (current.status === 'DONE' || visited.has(current.id)) return true;
    visited.add(current.id);
    if (current.parentId === null) return false;
    const parent = byId.get(current.parentId);
    if (!parent) return true;
    current = parent;
  }
}

export function hasDoneAncestor(task: TaskAvailabilityNode | undefined, tasks: readonly TaskAvailabilityNode[]): boolean {
  if (!task || task.parentId === null) return false;
  const byId = new Map(tasks.map(item => [item.id, item]));
  const visited = new Set<string>([task.id]);
  let currentId: string | null = task.parentId;
  while (currentId !== null) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);
    const parent = byId.get(currentId);
    if (!parent) return true;
    if (parent.status === 'DONE') return true;
    currentId = parent.parentId;
  }
  return false;
}

export function requiresTaskReview(task: Pick<WorkTask, 'parentId' | 'externalRef'>, stage: Stage): boolean {
  return !isChildTask(task) && (stage !== 'TASK_BREAKDOWN' || task.externalRef?.provider !== 'jira');
}

export function canQuickApproveReview(
  job: Pick<ReviewJob, 'reviewRequired' | 'stage' | 'stale' | 'report' | 'decision' | 'soloMode' | 'findings' | 'snapshot'>,
  task: (TaskAvailabilityNode & Pick<WorkTask, 'assigneeId' | 'externalRef'>) | undefined,
  tasks: readonly TaskAvailabilityNode[],
  user: Pick<User, 'id'> | null | undefined,
  role: Role | undefined,
): boolean {
  if (!user || !role || !task || isTaskFrozen(task, tasks)) return false;
  if (job.reviewRequired === false || !requiresTaskReview(task, job.stage)) return false;
  if (job.stale || !job.report || job.decision) return false;
  const independent = job.report.actorId !== user.id && task.assigneeId !== user.id;
  if (!(independent || !!job.soloMode) || !APPROVE_ROLES[job.stage].includes(role)) return false;
  if (job.findings.some(finding => finding.severity === 'CRITICAL' && !finding.waiver)) return false;
  if (
    job.stage === 'RELEASE' &&
    Array.isArray(job.snapshot?.upstreamApprovals) &&
    (job.snapshot.upstreamApprovals as { status?: string }[]).some(item => item.status !== 'PASS')
  ) {
    return false;
  }
  return true;
}

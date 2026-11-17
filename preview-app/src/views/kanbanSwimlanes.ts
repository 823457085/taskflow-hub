import type { ProjectMember, TaskStatus, WorkTask } from './workspaceApi.ts';
import { taskTypeLabel } from './displayLabels.ts';

export type KanbanGroupBy = 'none' | 'assignee' | 'type';

export interface KanbanSwimlane {
  key: string;
  title: string;
  subtitle?: string;
  tasks: WorkTask[];
  activeWip: number;
  doneCount: number;
  isUnassigned?: boolean;
  isCurrentUser?: boolean;
}

export interface ColumnWipEvaluation {
  limit: number;
  count: number;
  isGovernedColumn: boolean;
  isOverloaded: boolean;
  isNearLimit: boolean;
}

export function evaluateColumnWip(
  status: TaskStatus,
  count: number,
  wipLimit: number,
): ColumnWipEvaluation {
  const isGovernedColumn = status === 'IN_PROGRESS' || status === 'IN_REVIEW';
  if (!isGovernedColumn || wipLimit <= 0) {
    return {
      limit: wipLimit,
      count,
      isGovernedColumn,
      isOverloaded: false,
      isNearLimit: false,
    };
  }
  return {
    limit: wipLimit,
    count,
    isGovernedColumn: true,
    isOverloaded: count > wipLimit,
    isNearLimit: count === wipLimit,
  };
}

export function buildKanbanSwimlanes(
  tasks: readonly WorkTask[],
  members: readonly ProjectMember[],
  currentUserId: string,
  groupBy: KanbanGroupBy,
): KanbanSwimlane[] {
  const calcStats = (items: WorkTask[]) => ({
    activeWip: items.filter(t => t.status === 'IN_PROGRESS' || t.status === 'IN_REVIEW').length,
    doneCount: items.filter(t => t.status === 'DONE').length,
  });

  if (groupBy === 'none') {
    const stats = calcStats([...tasks]);
    return [
      {
        key: 'all',
        title: '全部任务',
        tasks: [...tasks],
        ...stats,
      },
    ];
  }

  if (groupBy === 'type') {
    const order: WorkTask['type'][] = ['STORY', 'TASK', 'BUG', 'RELEASE'];
    const lanes: KanbanSwimlane[] = [];
    for (const tp of order) {
      const items = tasks.filter(t => t.type === tp);
      if (!items.length) continue;
      lanes.push({
        key: `type:${tp}`,
        title: taskTypeLabel(tp),
        subtitle: `${items.length} 项`,
        tasks: items,
        ...calcStats(items),
      });
    }
    return lanes;
  }

  // groupBy === 'assignee'
  const memberDirectory = new Map<string, string>();
  for (const m of members) memberDirectory.set(m.id, m.username);

  const byAssignee = new Map<string, WorkTask[]>();
  const unassigned: WorkTask[] = [];

  for (const t of tasks) {
    if (!t.assigneeId) {
      unassigned.push(t);
    } else {
      const list = byAssignee.get(t.assigneeId) || [];
      list.push(t);
      byAssignee.set(t.assigneeId, list);
    }
  }

  const lanes: KanbanSwimlane[] = [];

  // 1. Current user first (if they have tasks)
  const myTasks = byAssignee.get(currentUserId);
  if (myTasks && myTasks.length > 0) {
    const myName = memberDirectory.get(currentUserId) || '我';
    lanes.push({
      key: `user:${currentUserId}`,
      title: `${myName}（我负责的）`,
      tasks: myTasks,
      isCurrentUser: true,
      ...calcStats(myTasks),
    });
    byAssignee.delete(currentUserId);
  }

  // 2. Other assignees sorted by active WIP desc, then total desc
  const otherEntries = [...byAssignee.entries()].map(([uid, items]) => ({
    uid,
    name: memberDirectory.get(uid) || uid,
    items,
    ...calcStats(items),
  }));
  otherEntries.sort((a, b) => {
    if (b.activeWip !== a.activeWip) return b.activeWip - a.activeWip;
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return a.name.localeCompare(b.name);
  });

  for (const entry of otherEntries) {
    lanes.push({
      key: `user:${entry.uid}`,
      title: entry.name,
      tasks: entry.items,
      activeWip: entry.activeWip,
      doneCount: entry.doneCount,
    });
  }

  // 3. Unassigned tasks lane
  if (unassigned.length > 0) {
    lanes.push({
      key: 'unassigned',
      title: '未指派 · 待认领',
      tasks: unassigned,
      isUnassigned: true,
      ...calcStats(unassigned),
    });
  }

  return lanes;
}

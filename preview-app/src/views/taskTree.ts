import type { WorkTask } from './workspaceApi.ts';

export type TreeTaskRow = WorkTask & { subtasks?: TreeTaskRow[] };

/** Groups filtered tasks into parent-child trees without dropping orphans or looping on cycles. */
export function buildTaskTree(tasks: readonly WorkTask[]): TreeTaskRow[] {
  const byId = new Map<string, TreeTaskRow>(tasks.map(task => [task.id, { ...task }]));
  const roots: TreeTaskRow[] = [];
  for (const task of tasks) {
    const node = byId.get(task.id)!;
    const parent = task.parentId && task.parentId !== task.id ? byId.get(task.parentId) : undefined;
    if (parent) {
      let cursor: TreeTaskRow | undefined = parent;
      let cycle = false;
      const seen = new Set<string>([node.id]);
      while (cursor) {
        if (seen.has(cursor.id)) { cycle = true; break; }
        seen.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      if (!cycle) {
        parent.subtasks = parent.subtasks || [];
        parent.subtasks.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  return roots;
}

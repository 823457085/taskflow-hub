import type { WorkTask } from './workspaceApi.ts';

interface TaskMaterial {
  taskId: string;
  projectId: string;
  taskKey: string;
  taskTitle: string;
}

interface TaskMaterialGroup<T> {
  id: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  assets: T[];
  rootTaskIds: Map<string, string>;
}

function jiraSource(task: WorkTask): string | undefined {
  const ref = task.externalRef;
  if (ref?.provider !== 'jira') return undefined;
  try {
    const url = new URL(ref.url);
    return /^https?:$/.test(url.protocol) && /\/browse\/[^/]+$/.test(url.pathname)
      ? url.origin + url.pathname.replace(/\/browse\/[^/]+$/, '') : undefined;
  } catch { return undefined; }
}

function declaredRequirementKey(task: WorkTask): string | undefined {
  const description = task.externalRef?.description;
  if (typeof description !== 'string') return undefined;
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*(?:\*{1,2}需求来源\*{1,2}|#{1,6}\s+需求来源)\s*$/.test(line));
  if (start < 0) return undefined;
  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:\*{1,2}[^*]+\*{1,2}|#{1,6}\s+\S.*)\s*$/.test(line)) break;
    if (/^\s*[-*]?\s*父任务[：:]/.test(line)) continue;
    for (const key of line.match(/\b[A-Z][A-Z0-9]*-[1-9]\d*\b/g) || []) if (key !== task.jiraKey) keys.add(key);
  }
  return keys.size === 1 ? keys.values().next().value : undefined;
}

/** Groups related work for display while retaining each material's owner. */
export function groupTaskMaterials<T extends TaskMaterial>(assets: readonly T[], tasks: readonly WorkTask[]): TaskMaterialGroup<T>[] {
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const tasksByKey = new Map(tasks.map(task => [`${task.projectId}:${task.jiraKey}`, task]));
  const groups = new Map<string, TaskMaterialGroup<T>>();

  const resolveRoot = (task: WorkTask): WorkTask => {
    const visited = new Set([task.id]);
    let current = task;
    while (true) {
      const jira = current.externalRef;
      const jiraParentKey = jira?.provider === 'jira' && jira.issueType?.subtask ? jira.parentKey : null;
      const parent = current.parentId
        ? tasksById.get(current.parentId)
        : jiraParentKey ? tasksByKey.get(`${current.projectId}:${jiraParentKey}`) : undefined;
      if (!parent || parent.projectId !== task.projectId) return current;
      if (visited.has(parent.id)) return task;
      visited.add(parent.id);
      current = parent;
    }
  };

  const findRequirement = (root: WorkTask): WorkTask | undefined => {
    if (root.parentId || root.externalRef?.issueType?.subtask) return undefined;
    const key = declaredRequirementKey(root);
    const target = key && tasksByKey.get(root.projectId + ':' + key);
    if (!target || target.parentId || target.externalRef?.issueType?.subtask || declaredRequirementKey(target)) return undefined;
    const source = jiraSource(root);
    return source && source === jiraSource(target) ? target : undefined;
  };

  for (const asset of assets) {
    const task = tasksById.get(asset.taskId);
    const root = task?.projectId === asset.projectId ? resolveRoot(task) : undefined;
    const requirement = root && (findRequirement(root) || root);
    const taskId = requirement?.id ?? asset.taskId;
    const id = `${asset.projectId}:${taskId}`;
    const existing = groups.get(id);
    if (existing) {
      existing.assets.push(asset);
      existing.rootTaskIds.set(asset.taskId, root?.id ?? asset.taskId);
      continue;
    }
    groups.set(id, {
      id,
      taskId,
      taskKey: requirement?.jiraKey ?? asset.taskKey,
      taskTitle: requirement?.title ?? asset.taskTitle,
      assets: [asset],
      rootTaskIds: new Map([[asset.taskId, root?.id ?? asset.taskId]]),
    });
  }

  return [...groups.values()];
}

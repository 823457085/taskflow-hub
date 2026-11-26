import type { AssetKind, Stage } from './workspaceApi';

export type WorkspaceSection = 'overview' | 'projects' | 'tasks' | 'todos' | 'reports'
  | 'reviews' | 'tech-review' | 'test-review' | 'code-review'
  | 'assets' | 'sessions' | 'deployments' | 'knowledge' | 'skills' | 'members' | 'accounts' | 'connections' | 'local';
export const SECTION_LABELS: Record<WorkspaceSection, string> = {
  overview: '工作台', projects: '项目空间', tasks: '需求中心', todos: '团队待办', reports: '工作报告', reviews: '评审待办',
  'tech-review': '技术方案评审', 'test-review': '用例评审', 'code-review': '代码评审',
  assets: '材料中心', sessions: 'Agent 记录', deployments: '部署记录', knowledge: '知识库', skills: 'Skills 库', members: '成员与权限', accounts: '账号管理', connections: '平台连接', local: '本地 AI 接入',
};
export function requirementReviewStageForSection(section: WorkspaceSection) {
  switch (section) {
    case 'tech-review': return 'TECH_SPEC';
    case 'test-review': return 'TEST_CASE';
    case 'code-review': return 'CODE_REVIEW';
  }
}

function takesRequirement(section: WorkspaceSection) {
  return section === 'tasks' || Boolean(requirementReviewStageForSection(section));
}

function parseWorkspaceSection(value: string | null): WorkspaceSection | undefined {
  if (value === 'prd-review') return 'tasks';
  if (value && Object.prototype.hasOwnProperty.call(SECTION_LABELS, value)) return value as WorkspaceSection;
}

export const TASK_PANELS = ['chain', 'overview', 'assets', 'reviews', 'release', 'activity'] as const;
export type TaskPanel = typeof TASK_PANELS[number];
export interface TaskDestination { tab?: TaskPanel; jobId?: string; from?: WorkspaceSection; requirementId?: string }
export function currentWorkspaceSection(): WorkspaceSection {
  const route = new URLSearchParams(location.hash.slice(1));
  if (route.has('task')) return 'tasks';
  return parseWorkspaceSection(route.get('view')) ?? 'overview';
}
export function displayWorkspaceSection(hash = location.hash): WorkspaceSection {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (route.has('task')) return parseWorkspaceSection(route.get('from')) ?? 'tasks';
  return parseWorkspaceSection(route.get('view')) ?? 'overview';
}
const REVIEW_STAGE_VALUES: readonly Stage[] = ['PRD', 'TASK_BREAKDOWN', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE'];
export type MaterialCategory = AssetKind | 'JIRA_ISSUE' | 'DESIGN_REFERENCE';
const ASSET_KIND_VALUES: readonly MaterialCategory[] = ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN', 'JIRA_ISSUE', 'DESIGN_REFERENCE'];
function routeFilter<T extends string>(hash: string, view: WorkspaceSection, name: string, values: readonly T[]): T | undefined {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  const value = route.get(name);
  return route.get('view') === view && values.includes(value as T) ? value as T : undefined;
}
export const reviewStageFromRoute = (hash = location.hash) => routeFilter(hash, 'reviews', 'stage', REVIEW_STAGE_VALUES);
export const assetKindFromRoute = (hash = location.hash) => routeFilter(hash, 'assets', 'kind', ASSET_KIND_VALUES);
type WorkspaceFilters = { stage?: Stage; kind?: MaterialCategory; requirementId?: string; bridgeProjectId?: string };

export function requirementIdFromRoute(hash = location.hash): string | undefined {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (!takesRequirement(displayWorkspaceSection(hash))) return undefined;
  return route.get(route.has('task') ? 'fromRequirement' : 'requirement') || undefined;
}

export function taskReturnFilters(hash = location.hash): WorkspaceFilters {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (!route.has('task')) return {};
  const stage = route.get('fromStage') as Stage;
  const kind = route.get('fromKind') as MaterialCategory;
  if (route.get('from') === 'reviews' && REVIEW_STAGE_VALUES.includes(stage)) return { stage };
  if (route.get('from') === 'assets' && ASSET_KIND_VALUES.includes(kind)) return { kind };
  const requirementId = requirementIdFromRoute(hash);
  if (requirementId) return { requirementId };
  return {};
}
function workspaceRoute(section: WorkspaceSection, filters: WorkspaceFilters) {
  const route = new URLSearchParams({ view: section });
  if (section === 'reviews' && filters.stage && REVIEW_STAGE_VALUES.includes(filters.stage)) route.set('stage', filters.stage);
  if (section === 'assets' && filters.kind && ASSET_KIND_VALUES.includes(filters.kind)) route.set('kind', filters.kind);
  if (takesRequirement(section) && filters.requirementId) route.set('requirement', filters.requirementId);
  if (section === 'local' && filters.bridgeProjectId) route.set('bridgeProject', filters.bridgeProjectId);
  return route.toString();
}
export function navigateWorkspace(section: WorkspaceSection, filters: WorkspaceFilters = {}) {
  location.hash = workspaceRoute(section, filters);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
export function clearTaskRoute() {
  const route = new URLSearchParams(location.hash.slice(1));
  if (!route.has('task')) return;
  for (const name of ['task', 'tab', 'job', 'from', 'fromStage', 'fromKind', 'fromRequirement']) route.delete(name);
  route.set('view', 'tasks');
  history.replaceState(history.state, '', location.pathname + location.search + '#' + route.toString());
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
export function closeTaskRoute() {
  const route = new URLSearchParams(location.hash.slice(1));
  if (!route.has('task')) return;
  const target = parseWorkspaceSection(route.get('from')) ?? 'tasks';
  const next = workspaceRoute(target, taskReturnFilters());
  history.replaceState(history.state, '', location.pathname + location.search + '#' + next);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
export function openTaskRoute(taskId: string, { tab = 'chain', jobId, from = 'tasks', requirementId = requirementIdFromRoute() }: TaskDestination = {}) {
  const route = new URLSearchParams({ view: 'tasks', task: taskId, tab, from });
  const inherited = taskReturnFilters();
  const stage = reviewStageFromRoute() || inherited.stage;
  const kind = assetKindFromRoute() || inherited.kind;
  if (from === 'reviews' && stage) route.set('fromStage', stage);
  if (from === 'assets' && kind) route.set('fromKind', kind);
  if (takesRequirement(from) && requirementId) route.set('fromRequirement', requirementId);
  if (jobId) route.set('job', jobId);
  location.hash = route.toString();
}

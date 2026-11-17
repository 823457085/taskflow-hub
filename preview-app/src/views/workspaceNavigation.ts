import type { AssetKind, Stage } from './workspaceApi';

export type WorkspaceSection = 'overview' | 'projects' | 'tasks' | 'todos' | 'reports' | 'reviews' | 'assets' | 'sessions' | 'deployments' | 'knowledge' | 'skills' | 'members' | 'accounts' | 'connections' | 'local';
export const SECTION_LABELS: Record<WorkspaceSection, string> = {
  overview: '工作台', projects: '项目空间', tasks: '任务中心', todos: '团队待办', reports: '工作报告', reviews: '评审中心',
  assets: '材料中心', sessions: 'Agent 记录', deployments: '部署记录', knowledge: '知识库', skills: '团队 Skill', members: '成员与权限', accounts: '账号管理', connections: '平台连接', local: '本地 AI 接入',
};
export const TASK_PANELS = ['overview', 'assets', 'reviews', 'release', 'activity'] as const;
export type TaskPanel = typeof TASK_PANELS[number];
export interface TaskDestination { tab?: TaskPanel; jobId?: string; from?: WorkspaceSection }
export function currentWorkspaceSection(): WorkspaceSection {
  const route = new URLSearchParams(location.hash.slice(1));
  if (route.has('task')) return 'tasks';
  const view = route.get('view');
  return view && Object.prototype.hasOwnProperty.call(SECTION_LABELS, view) ? view as WorkspaceSection : 'overview';
}
const REVIEW_STAGE_VALUES: readonly Stage[] = ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE'];
const ASSET_KIND_VALUES: readonly AssetKind[] = ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN'];
function routeFilter<T extends string>(hash: string, view: WorkspaceSection, name: string, values: readonly T[]): T | undefined {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  const value = route.get(name);
  return route.get('view') === view && values.includes(value as T) ? value as T : undefined;
}
export const reviewStageFromRoute = (hash = location.hash) => routeFilter(hash, 'reviews', 'stage', REVIEW_STAGE_VALUES);
export const assetKindFromRoute = (hash = location.hash) => routeFilter(hash, 'assets', 'kind', ASSET_KIND_VALUES);
export function taskReturnFilters(hash = location.hash): { stage?: Stage; kind?: AssetKind } {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (!route.has('task')) return {};
  const stage = route.get('fromStage') as Stage;
  const kind = route.get('fromKind') as AssetKind;
  if (route.get('from') === 'reviews' && REVIEW_STAGE_VALUES.includes(stage)) return { stage };
  if (route.get('from') === 'assets' && ASSET_KIND_VALUES.includes(kind)) return { kind };
  return {};
}
export function navigateWorkspace(section: WorkspaceSection, filters: { stage?: Stage; kind?: AssetKind } = {}) {
  const route = new URLSearchParams({ view: section });
  if (section === 'reviews' && filters.stage && REVIEW_STAGE_VALUES.includes(filters.stage)) route.set('stage', filters.stage);
  if (section === 'assets' && filters.kind && ASSET_KIND_VALUES.includes(filters.kind)) route.set('kind', filters.kind);
  location.hash = route.toString();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
export function clearTaskRoute() {
  const route = new URLSearchParams(location.hash.slice(1));
  if (!route.has('task')) return;
  for (const name of ['task', 'tab', 'job', 'from', 'fromStage', 'fromKind']) route.delete(name);
  route.set('view', 'tasks');
  history.replaceState(history.state, '', location.pathname + location.search + '#' + route.toString());
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
export function openTaskRoute(taskId: string, { tab = 'overview', jobId, from = 'tasks' }: TaskDestination = {}) {
  const route = new URLSearchParams({ view: 'tasks', task: taskId, tab, from });
  const inherited = taskReturnFilters();
  const stage = reviewStageFromRoute() || inherited.stage;
  const kind = assetKindFromRoute() || inherited.kind;
  if (from === 'reviews' && stage) route.set('fromStage', stage);
  if (from === 'assets' && kind) route.set('fromKind', kind);
  if (jobId) route.set('job', jobId);
  location.hash = route.toString();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

import type { Project, WorkTask } from './workspaceApi.ts';
import type { WorkspaceSection } from './workspaceNavigation.ts';
import { taskStatusLabel, taskTypeLabel } from './displayLabels.ts';

export type QuickCommandKind = 'action' | 'task' | 'project' | 'section';

export interface QuickCommandItem {
  id: string;
  kind: QuickCommandKind;
  groupLabel: string;
  title: string;
  subtitle: string;
  badge?: string;
  badgeVariant?: 'blue' | 'green' | 'neutral';
  taskId?: string;
  projectId?: string;
  section?: WorkspaceSection;
  actionId?: 'intake' | 'sync-jira' | 'standup-digest';
}

const SECTION_DESCRIPTIONS: { section: WorkspaceSection; title: string; subtitle: string; keywords: string }[] = [
  { section: 'overview', title: '工作台', subtitle: '待办、待审门禁与全流程交付概览', keywords: 'overview home 工作台 首页 待办' },
  { section: 'projects', title: '项目空间', subtitle: '按现有项目组织工作范围与协作', keywords: 'projects 项目 目录' },
  { section: 'tasks', title: '任务中心', subtitle: '查看、筛选并推进当前项目任务', keywords: 'tasks jira 任务 列表' },
  { section: 'reviews', title: '评审中心', subtitle: '集中跟踪需求、方案、代码、测试与上线审核', keywords: 'reviews 评审 门禁 批准 审核' },
  { section: 'assets', title: '材料中心', subtitle: '统一查找需求、方案、代码改动与测试材料', keywords: 'assets 材料 文档 代码 版本' },
  { section: 'local', title: '本地 AI 接入', subtitle: '连接 Codex / Gemini / Cursor / Claude 与代码库', keywords: 'local ai mcp 本地 仓库 终端' },
  { section: 'connections', title: '平台连接', subtitle: '读取 Jira / Confluence / GitLab / 云效 / Jenkins', keywords: 'connections jira confluence gitlab jenkins yunxiao 连接' },
  { section: 'accounts', title: '账号管理', subtitle: '管理个人与项目共享凭据身份', keywords: 'accounts 账号 凭据' },
  { section: 'members', title: '成员与权限', subtitle: '查看或管理项目成员、角色分工与合规审计记录', keywords: 'members audit 成员 角色 权限 审计 合规 日志' },
];

export function buildQuickCommandItems(params: {
  query: string;
  tasks: readonly WorkTask[];
  projects: readonly Project[];
  currentProjectId?: string;
  currentUserId?: string;
  canIntake?: boolean;
  canSyncJira?: boolean;
  canStandupDigest?: boolean;
  maxTasks?: number;
}): QuickCommandItem[] {
  const {
    query,
    tasks,
    projects,
    currentProjectId = '',
    currentUserId = '',
    canIntake = false,
    canSyncJira = false,
    canStandupDigest = false,
    maxTasks = 12,
  } = params;

  const q = query.trim().toLowerCase();
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const items: QuickCommandItem[] = [];

  const matches = (haystack: string): boolean => {
    if (!q) return true;
    const lower = haystack.toLowerCase();
    return q.split(/\s+/).every(token => lower.includes(token));
  };

  // 1. Tasks (ranked: exact key prefix -> my active -> current project -> recent updatedAt)
  const matchingTasks = tasks
    .filter(task => {
      const proj = projectMap.get(task.projectId);
      const text = [
        task.jiraKey,
        task.title,
        proj?.key || '',
        proj?.name || '',
        taskStatusLabel(task.status),
        task.externalRef?.type || taskTypeLabel(task.type),
      ].join(' ');
      return matches(text);
    })
    .sort((a, b) => {
      if (q) {
        const aKeyExact = a.jiraKey.toLowerCase() === q ? 1 : 0;
        const bKeyExact = b.jiraKey.toLowerCase() === q ? 1 : 0;
        if (aKeyExact !== bKeyExact) return bKeyExact - aKeyExact;
        const aKeyStart = a.jiraKey.toLowerCase().startsWith(q) ? 1 : 0;
        const bKeyStart = b.jiraKey.toLowerCase().startsWith(q) ? 1 : 0;
        if (aKeyStart !== bKeyStart) return bKeyStart - aKeyStart;
      }
      const aMine = currentUserId && a.assigneeId === currentUserId && a.status !== 'DONE' ? 1 : 0;
      const bMine = currentUserId && b.assigneeId === currentUserId && b.status !== 'DONE' ? 1 : 0;
      if (aMine !== bMine) return bMine - aMine;
      const aCurrProj = a.projectId === currentProjectId ? 1 : 0;
      const bCurrProj = b.projectId === currentProjectId ? 1 : 0;
      if (aCurrProj !== bCurrProj) return bCurrProj - aCurrProj;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, maxTasks);

  for (const task of matchingTasks) {
    const proj = projectMap.get(task.projectId);
    items.push({
      id: `task:${task.id}`,
      kind: 'task',
      groupLabel: '任务快速直达',
      title: `${task.jiraKey} · ${task.title}`,
      subtitle: proj ? `${proj.key} · ${proj.name}` : taskTypeLabel(task.type),
      badge: taskStatusLabel(task.status),
      badgeVariant: task.status === 'DONE' ? 'green' : task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW' ? 'blue' : 'neutral',
      taskId: task.id,
      projectId: task.projectId,
    });
  }

  // 2. Quick actions
  const actionCandidates: { id: 'intake' | 'sync-jira' | 'standup-digest'; enabled: boolean; title: string; subtitle: string; keywords: string }[] = [
    {
      id: 'intake',
      enabled: canIntake,
      title: '接入 Jira 任务',
      subtitle: '粘贴链接、任务号或从我的待办一键拉入当前项目',
      keywords: 'intake import jira create 接入 导入 新建 任务',
    },
    {
      id: 'sync-jira',
      enabled: canSyncJira,
      title: '同步我的最新 Jira 待办',
      subtitle: '拉取本人最新 Jira 事项并自动更新状态',
      keywords: 'sync jira refresh 同步 刷新 待办',
    },
    {
      id: 'standup-digest',
      enabled: canStandupDigest,
      title: '生成晨会日报 / 项目迭代简报',
      subtitle: '一键汇总真实任务进展、阶段门禁与阻断项为 Markdown 报告',
      keywords: 'standup sprint digest report 晨会 日报 周报 迭代 简报 汇报',
    },
  ];
  for (const act of actionCandidates) {
    if (!act.enabled) continue;
    if (!matches(`${act.title} ${act.subtitle} ${act.keywords}`)) continue;
    items.push({
      id: `action:${act.id}`,
      kind: 'action',
      groupLabel: '快捷操作',
      title: act.title,
      subtitle: act.subtitle,
      badge: '立即执行',
      badgeVariant: 'blue',
      actionId: act.id,
    });
  }

  // 3. Projects
  const matchingProjects = projects
    .filter(proj => matches(`${proj.key} ${proj.name} ${proj.jira?.key || ''} ${proj.jira?.name || ''} 项目 切换`))
    .slice(0, q ? 8 : 5);
  for (const proj of matchingProjects) {
    items.push({
      id: `project:${proj.id}`,
      kind: 'project',
      groupLabel: '切换项目',
      title: `${proj.key} · ${proj.name}`,
      subtitle: proj.jira ? `关联 Jira：${proj.jira.key}` : '本地项目',
      badge: proj.id === currentProjectId ? '当前项目' : undefined,
      badgeVariant: 'green',
      projectId: proj.id,
    });
  }

  // 4. Workspace Sections
  for (const sec of SECTION_DESCRIPTIONS) {
    if (!matches(`${sec.title} ${sec.subtitle} ${sec.keywords}`)) continue;
    items.push({
      id: `section:${sec.section}`,
      kind: 'section',
      groupLabel: '页面导航',
      title: sec.title,
      subtitle: sec.subtitle,
      section: sec.section,
    });
  }

  return items;
}

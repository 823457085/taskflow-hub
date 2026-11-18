import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { readTogether } from './readTogether';
import { App, Button, Card, Collapse, Drawer, Empty, Flex, Form, Input, Segmented, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import { ArrowLeft, Bookmark, ChevronLeft, ChevronRight, KeyRound, Keyboard, LayoutGrid, List, LogOut, MonitorSmartphone, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { api, ApiError, memberName, MemberCandidate, NO_PLATFORM_PERMISSIONS, NO_PROJECT_PERMISSIONS, normalizePlatformPermissions, normalizeProjectPermissions, PlatformPermissions, Project, ProjectMember, projectGroup, Role, TaskStatus, User, WorkTask } from './workspaceApi';
import { ProjectDirectory, WorkspaceOverview } from './WorkspaceOverview';
import { clearTaskRoute, navigateWorkspace, openTaskRoute, SECTION_LABELS, taskReturnFilters, WorkspaceSection } from './workspaceNavigation';
import { ChangePasswordDrawer } from './PasswordDrawers';
import { roleLabel, TASK_STATUS_OPTIONS, TASK_TYPE_OPTIONS, taskStatusLabel } from './displayLabels';
import { TaskListTable } from './TaskListTable';
import {
  clearSearchOnEscape,
  deleteSavedTaskView,
  isEditableTarget,
  isSavedViewActive,
  isSubmitShortcut,
  readSavedTaskViews,
  readStoredBool,
  readStoredChoice,
  saveTaskFilterView,
  writeStoredBool,
  writeStoredString,
  type SavedTaskFilterView,
} from './uiPreferences';
import './PlatformServiceView.css';

const WorkTaskDetail = lazy(() => import('./WorkTaskDetail').then(mod => ({ default: mod.WorkTaskDetail })));
const ConnectionsView = lazy(() => import('./ConnectionsView').then(mod => ({ default: mod.ConnectionsView })));
const TeamTodosView = lazy(() => import('./TeamTodosView').then(mod => ({ default: mod.TeamTodosView })));
const WorkReportsView = lazy(() => import('./WorkReportsView').then(mod => ({ default: mod.WorkReportsView })));
const AgentSessionsView = lazy(() => import('./AgentSessionsView').then(mod => ({ default: mod.AgentSessionsView })));
const DeploymentsView = lazy(() => import('./DeploymentsView').then(mod => ({ default: mod.DeploymentsView })));
const KnowledgeView = lazy(() => import('./KnowledgeView').then(mod => ({ default: mod.KnowledgeView })));
const TeamSkillsView = lazy(() => import('./TeamSkillsView').then(mod => ({ default: mod.TeamSkillsView })));
const LocalIntegrationView = lazy(() => import('./LocalIntegrationView').then(mod => ({ default: mod.LocalIntegrationView })));
const JiraTaskIntake = lazy(() => import('./JiraTaskIntake').then(mod => ({ default: mod.JiraTaskIntake })));
const AccountsView = lazy(() => import('./AccountsView').then(mod => ({ default: mod.AccountsView })));
const MembersAccessView = lazy(() => import('./MembersAccessView').then(mod => ({ default: mod.MembersAccessView })));
const ProjectCreateDrawer = lazy(() => import('./MembersAccessView').then(mod => ({ default: mod.ProjectCreateDrawer })));
const ReviewCenter = lazy(() => import('./WorkflowCenters').then(mod => ({ default: mod.ReviewCenter })));
const AssetCenter = lazy(() => import('./WorkflowCenters').then(mod => ({ default: mod.AssetCenter })));
const QuickCommandModal = lazy(() => import('./QuickCommandModal').then(mod => ({ default: mod.QuickCommandModal })));
const TaskKanbanBoard = lazy(() => import('./TaskKanbanBoard').then(mod => ({ default: mod.TaskKanbanBoard })));
const KeyboardShortcutsModal = lazy(() => import('./KeyboardShortcutsModal').then(mod => ({ default: mod.KeyboardShortcutsModal })));

const { Text, Title, Paragraph } = Typography;
const FILTERS_OPEN_KEY = 'taskflow.tasks.filtersOpen';
const TASK_SCOPE_KEY = 'taskflow.tasks.quickScope';
const TASK_VIEW_MODE_KEY = 'taskflow.tasks.viewMode';
const QUICK_SCOPES = ['all', 'mine', 'unclaimed', 'active', 'done'] as const;
type QuickTaskScope = typeof QUICK_SCOPES[number];
const VIEW_MODES = ['list', 'board'] as const;
type TaskViewMode = typeof VIEW_MODES[number];
const taskFromHash = () => new URLSearchParams(location.hash.slice(1)).get('task') || '';
const options = (values: string[]) => values.map(value => ({ value, label: value }));
type LoginValues = { username: string; password: string; setupToken?: string };
type NewTaskValues = { jiraKey: string; title: string; type: WorkTask['type']; parentId?: string; assigneeId?: string };

const routeFallback = <Card><Skeleton active paragraph={{ rows: 5 }} /></Card>;

export const PlatformServiceView: React.FC<{ section?: WorkspaceSection; onSessionChange?: (authenticated: boolean) => void; onAccessChange?: (access: { manageMembers: boolean; manageConnections: boolean }) => void }> = ({ section = 'overview', onSessionChange, onAccessChange }) => {
  const { message, modal } = App.useApp();
  const [loginForm] = Form.useForm<LoginValues>();
  const [taskForm] = Form.useForm<NewTaskValues>();
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [allTasks, setAllTasks] = useState<WorkTask[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [platformPermissions, setPlatformPermissions] = useState<PlatformPermissions>(NO_PLATFORM_PERMISSIONS);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(taskFromHash);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [quickScope, setQuickScope] = useState<QuickTaskScope>(() => readStoredChoice(TASK_SCOPE_KEY, QUICK_SCOPES, 'all'));
  const [statusFilter, setStatusFilter] = useState<string>();
  const [jiraTypeFilter, setJiraTypeFilter] = useState<string>();
  const [jiraStatusFilter, setJiraStatusFilter] = useState<string>();
  const [jiraVersionFilter, setJiraVersionFilter] = useState<string>();
  const [filtersOpen, setFiltersOpen] = useState(() => readStoredBool(FILTERS_OPEN_KEY, false));
  const [createOpen, setCreateOpen] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeEverOpened, setIntakeEverOpened] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectEverOpened, setNewProjectEverOpened] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickEverOpened, setQuickEverOpened] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [shortcutsEverOpened, setShortcutsEverOpened] = useState(false);
  const [digestTick, setDigestTick] = useState(0);
  const [viewMode, setViewMode] = useState<TaskViewMode>(() => readStoredChoice(TASK_VIEW_MODE_KEY, VIEW_MODES, 'list'));
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [savedViews, setSavedViews] = useState<SavedTaskFilterView[]>([]);
  const [savingViewOpen, setSavingViewOpen] = useState(false);
  const [savingViewName, setSavingViewName] = useState('');
  const [taskPage, setTaskPage] = useState(1);
  const [updatingTaskId, setUpdatingTaskId] = useState('');
  const taskSearchRef = useRef<InputRef>(null);
  const shortcutNavRef = useRef<{ prevTaskId?: string; nextTaskId?: string; openTask: (id: string) => void; busy: boolean }>({ openTask: () => {}, busy: false });
  const lastRoutedTaskId = useRef(taskFromHash());
  const projectIdRef = useRef('');
  const refreshSequence = useRef(0);
  const pendingOperations = useRef(0);
  const taskCreateSequence = useRef(0);
  const mounted = useRef(true);
  const currentContext = useRef({ userId: '', projectId: '', section });
  currentContext.current = { userId: user?.id || '', projectId, section };
  const renderedRoute = location.hash;
  const project = projects.find(item => item.id === projectId);
  const role = project?.role;
  const permissions = project?.permissions || NO_PROJECT_PERMISSIONS;
  const canAssign = permissions.assignTasks;
  const groups = [...new Map(projects.map(item => { const group = projectGroup(item); return [group.id, group] as const; })).values()];
  const heading = section === 'members' && !permissions.manageMembers ? '项目成员' : section === 'connections' && !permissions.manageConnections ? '平台读取' : SECTION_LABELS[section];
  const descriptions: Record<WorkspaceSection, string> = {
    overview: '先看交付流程，再从待办、评审和材料进入工作。', projects: '按现有项目组织工作范围和协作。',
    tasks: '查看和处理当前项目的任务。', todos: '个人待办只有自己可见；项目待办由成员共享，可指派和关联任务。', reports: '按天汇总完成、进行中和卡住的事项，可复制到群里。', sessions: '本机 Agent 会话同步到平台，共享给项目成员查看和讨论。', deployments: '各环境的部署历史，可从 Delivery 同步云效、Jenkins 记录或手动登记。', reviews: '集中跟踪需求、方案、代码、测试与上线审核。',
    knowledge: '项目共享的排障手册、系统说明和规范，成员的本地 AI 可直接检索。', skills: '项目负责人统一维护 AI Skill，成员本机 Bridge 自动同步。',
    assets: '统一查找需求、方案、代码和测试材料。', members: permissions.manageMembers ? '管理本项目成员与角色，权限以当前项目为准。' : '查看本项目成员与角色。',
    accounts: '管理个人与项目共享账号，选择当前项目使用的身份。', connections: permissions.manageConnections ? '选择账号读取平台资料，管理项目默认连接。' : '使用个人或项目共享账号读取资料，配置权限由项目负责人管理。', local: '连接本地 AI 工具，管理设备授权。',
  };
  const taskReturnSection = () => {
    const from = new URLSearchParams(location.hash.slice(1)).get('from');
    return from && Object.prototype.hasOwnProperty.call(SECTION_LABELS, from) ? from as WorkspaceSection : 'tasks';
  };
  const openTask = (id: string) => {
    if (!id) { lastRoutedTaskId.current = ''; navigateWorkspace(taskReturnSection(), taskReturnFilters()); return; }
    const sameProject = tasks.some(item => item.id === id);
    if (sameProject) lastRoutedTaskId.current = id;
    openTaskRoute(id, { from: selectedTaskId ? taskReturnSection() : section });
    setSelectedTaskId(id);
  };
  const openQuickCommand = () => { setQuickEverOpened(true); setQuickOpen(true); };
  const jumpToTaskFromCommand = (targetTaskId: string, targetProjectId: string) => {
    if (targetProjectId && targetProjectId !== projectIdRef.current) {
      closeCreateTask();
      resetFilters();
      projectIdRef.current = targetProjectId;
      setProjectId(targetProjectId);
      setTasks(allTasks.filter(item => item.projectId === targetProjectId));
      setMembers([]);
      setCandidates([]);
      lastRoutedTaskId.current = targetTaskId;
      openTaskRoute(targetTaskId, { from: selectedTaskId ? taskReturnSection() : section });
      setSelectedTaskId(targetTaskId);
      void perform(() => refresh(targetProjectId));
      return;
    }
    openTask(targetTaskId);
  };
  const resetFilters = () => {
    setQuery('');
    setQuickScope('all');
    writeStoredString(TASK_SCOPE_KEY, 'all');
    setStatusFilter(undefined);
    setJiraTypeFilter(undefined);
    setJiraStatusFilter(undefined);
    setJiraVersionFilter(undefined);
  };
  const closeCreateTask = () => { taskCreateSequence.current += 1; setCreateOpen(false); if (createOpen) taskForm.resetFields(); };
  const clearTaskSelection = () => {
    setSelectedTaskId(''); lastRoutedTaskId.current = '';
    clearTaskRoute();
  };
  const clearProjectAccess = () => {
    taskCreateSequence.current += 1;
    refreshSequence.current += 1; projectIdRef.current = '';
    setProjectId(''); setProjects([]); setTasks([]); setAllTasks([]); setMembers([]); setCandidates([]); setUsers([]); setPlatformPermissions(NO_PLATFORM_PERMISSIONS);
    setCreateOpen(false); setIntakeOpen(false); setNewProjectOpen(false); setQuickOpen(false); setShortcutsOpen(false); taskForm.resetFields(); resetFilters(); clearTaskSelection();
  };
  const clearSession = () => {
    taskCreateSequence.current += 1;
    refreshSequence.current += 1; projectIdRef.current = '';
    setUser(null); setTasks([]); setAllTasks([]); setProjects([]); setMembers([]); setCandidates([]); setUsers([]); setPlatformPermissions(NO_PLATFORM_PERMISSIONS); setCreateOpen(false); setIntakeOpen(false); setQuickOpen(false); setShortcutsOpen(false); setPasswordOpen(false);
    clearTaskSelection(); setNewProjectOpen(false); resetFilters();
    if (!user) loginForm.resetFields();
    if (user) taskForm.resetFields();
  };
  const handleError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) clearSession();
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const perform = async (action: () => Promise<void>) => {
    pendingOperations.current += 1; setBusy(true);
    try { await action(); } catch (error) { handleError(error); }
    finally { pendingOperations.current -= 1; setBusy(pendingOperations.current > 0); }
  };
  const refresh = async (preferredProjectId = projectIdRef.current, isCurrent = () => true) => {
    if (!isCurrent()) return;
    const sequence = ++refreshSequence.current;
    try {
      const me = await api<{ user: User; permissions?: PlatformPermissions }>('me');
      if (!isCurrent()) return;
      const platformAccess = normalizePlatformPermissions(me.permissions);
      const requestedTaskId = taskFromHash();
      const speculativeProjectId = !requestedTaskId && preferredProjectId ? preferredProjectId : '';
      const [projectData, taskData, userData, speculativeMembers] = await readTogether([
        api<{ projects: Project[] }>('projects'),
        api<{ tasks: WorkTask[] }>('tasks'),
        platformAccess.manageUsers ? api<{ users: User[] }>('users') : Promise.resolve({ users: [] }),
        speculativeProjectId
          ? api<{ members: ProjectMember[]; candidates?: MemberCandidate[]; permissions?: unknown; role?: Role }>('projects/' + encodeURIComponent(speculativeProjectId) + '/members').catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!isCurrent()) return;
      const visibleProjects = projectData.projects.map(item => ({ ...item, permissions: normalizeProjectPermissions(item.permissions) }));
      let savedProjectId = '';
      try { savedProjectId = sessionStorage.getItem('taskflow.project.' + me.user.id) || ''; } catch { /* UI preference storage is optional. */ }
      const linkedTask = taskData.tasks.find(task => task.id === requestedTaskId);
      const savedProject = visibleProjects.find(item => item.id === savedProjectId);
      const firstActiveJiraProject = visibleProjects.find(item => item.jira && taskData.tasks.some(task => task.projectId === item.id));
      const selectedProject = visibleProjects.find(item => item.id === linkedTask?.projectId) ||
        visibleProjects.find(item => item.id === preferredProjectId) ||
        (savedProject && (!firstActiveJiraProject || taskData.tasks.some(task => task.projectId === savedProject.id)) ? savedProject : undefined) ||
        firstActiveJiraProject ||
        visibleProjects.find(item => item.jira) || visibleProjects[0];
      const projectMembers = selectedProject
        ? (selectedProject.id === speculativeProjectId && speculativeMembers
          ? speculativeMembers
          : await api<{ members: ProjectMember[]; candidates?: MemberCandidate[]; permissions?: unknown; role?: Role }>('projects/' + selectedProject.id + '/members'))
        : { members: [], candidates: [] };
      if (sequence !== refreshSequence.current || !isCurrent()) return;
      if (taskFromHash() === requestedTaskId) {
        if (requestedTaskId && !linkedTask) clearTaskSelection();
        else setSelectedTaskId(linkedTask?.id || '');
      }
      projectIdRef.current = selectedProject?.id || '';
      try { if (selectedProject) sessionStorage.setItem('taskflow.project.' + me.user.id, selectedProject.id); } catch { /* No auth data is stored here. */ }
      const currentProjects = visibleProjects.map(item => item.id === selectedProject?.id ? { ...item, role: projectMembers.role || item.role, permissions: normalizeProjectPermissions(projectMembers.permissions) } : item);
      setUser(me.user); setPlatformPermissions(platformAccess); setProjects(currentProjects); setProjectId(selectedProject?.id || '');
      setAllTasks(taskData.tasks); setTasks(taskData.tasks.filter(task => task.projectId === selectedProject?.id));
      setMembers(projectMembers.members.map(member => ({ ...member, canEditRole: member.canEditRole === true }))); setCandidates(projectMembers.candidates || []); setUsers(userData.users);
    } catch (error) {
      if (sequence !== refreshSequence.current || !isCurrent()) return;
      if (error instanceof ApiError && error.status === 403) clearProjectAccess();
      throw error;
    }
  };
  const refreshTasksOnly = async () => {
    const activeProjectId = projectIdRef.current;
    if (!activeProjectId || !user) {
      await refresh(activeProjectId);
      return;
    }
    const sequence = ++refreshSequence.current;
    try {
      const taskData = await api<{ tasks: WorkTask[] }>('tasks');
      if (!mounted.current || sequence !== refreshSequence.current) return;
      setAllTasks(taskData.tasks);
      setTasks(taskData.tasks.filter(task => task.projectId === projectIdRef.current));
    } catch (error) {
      if (!mounted.current || sequence !== refreshSequence.current) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        if (error.status === 401) clearSession();
        else clearProjectAccess();
      }
      throw error;
    }
  };
  const reloadAccess = () => { clearProjectAccess(); void perform(() => refresh('')); };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    pendingOperations.current += 1; setBusy(true);
    void refresh().catch(error => {
      if (!(error instanceof ApiError && error.status === 401)) handleError(error);
    }).finally(() => {
      pendingOperations.current -= 1;
      if (active) { setBusy(pendingOperations.current > 0); setInitializing(false); }
    });
    return () => { active = false; mounted.current = false; refreshSequence.current += 1; taskCreateSequence.current += 1; };
  }, []);
  useEffect(() => { onSessionChange?.(!!user); }, [user?.id, onSessionChange]);
  const [workbenchMode, setWorkbenchMode] = useState<'server' | 'relay' | null>(null);
  const workbenchAvailable = !!workbenchMode;
  useEffect(() => {
    if (!user) { setWorkbenchMode(null); return; }
    let active = true;
    void api<{ url: string; online: boolean; mode?: 'server' | 'relay' }>('workbench/status').then(result => { if (active) setWorkbenchMode(result.mode === 'server' ? 'server' : 'relay'); }).catch(() => { if (active) setWorkbenchMode(null); });
    const params = new URLSearchParams(window.location.search);
    if (params.get('workbench') === '1') {
      const returnTo = params.get('return') || '/';
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      void api<{ url: string }>('workbench/codes', { return: returnTo }).then(result => { if (active) window.location.replace(result.url); }).catch(handleError);
    }
    return () => { active = false; };
  }, [user?.id]);
  const openWorkbench = () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    void api<{ url: string }>('workbench/codes', { return: '/' }).then(result => { if (tab) tab.location.replace(result.url); else window.location.assign(result.url); }).catch(error => { tab?.close(); handleError(error); });
  };
  useEffect(() => { closeCreateTask(); setIntakeOpen(false); setNewProjectOpen(false); }, [section]);
  useEffect(() => { closeCreateTask(); setIntakeOpen(false); setSelectedTaskIds([]); setSavedViews(readSavedTaskViews(projectId)); setSavingViewOpen(false); setSavingViewName(''); }, [projectId, user?.id]);
  useEffect(() => { setTaskPage(1); }, [projectId, query, quickScope, statusFilter, jiraTypeFilter, jiraStatusFilter, jiraVersionFilter]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!user) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuickEverOpened(true);
        setQuickOpen(prev => !prev);
        return;
      }
      if (((event.metaKey || event.ctrlKey) && !event.altKey && event.key === '/') || (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target))) {
        event.preventDefault();
        setShortcutsEverOpened(true);
        setShortcutsOpen(prev => !prev);
        return;
      }
      if (isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (section === 'tasks' && selectedTaskId) {
        if (!shortcutNavRef.current.busy) {
          if (event.key === '[' && shortcutNavRef.current.prevTaskId) {
            event.preventDefault();
            shortcutNavRef.current.openTask(shortcutNavRef.current.prevTaskId);
          } else if (event.key === ']' && shortcutNavRef.current.nextTaskId) {
            event.preventDefault();
            shortcutNavRef.current.openTask(shortcutNavRef.current.nextTaskId);
          }
        }
        return;
      }
      if (section !== 'tasks') return;
      if (event.key === '/') {
        event.preventDefault();
        taskSearchRef.current?.focus();
      } else if (event.key.toLowerCase() === 'v' && !event.shiftKey) {
        event.preventDefault();
        setViewMode(prev => {
          const next = prev === 'list' ? 'board' : 'list';
          writeStoredString(TASK_VIEW_MODE_KEY, next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user, section, selectedTaskId]);
  useEffect(() => { onAccessChange?.({ manageMembers: permissions.manageMembers, manageConnections: permissions.manageConnections }); }, [user?.id, permissions.manageMembers, permissions.manageConnections, onAccessChange]);
  useEffect(() => {
    const update = () => {
      const id = taskFromHash();
      if (id === lastRoutedTaskId.current) return;
      lastRoutedTaskId.current = id; setSelectedTaskId(id);
      if (id) void perform(() => refresh(''));
    };
    window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update);
  }, []);
  const authenticate = ({ setupToken, ...values }: LoginValues, setup: boolean) => perform(async () => {
    if (setup) await api('setup', { ...values, ...(setupToken ? { setupToken } : {}) });
    await api('login', values); loginForm.setFieldsValue({ password: '', setupToken: '' }); await refresh('');
  });
  const switchProject = (id: string, destination?: WorkspaceSection) => {
    if (selectedTaskId) clearTaskSelection();
    closeCreateTask(); resetFilters();
    projectIdRef.current = id; setProjectId(id); setTasks(allTasks.filter(task => task.projectId === id)); setMembers([]); setCandidates([]);
    void perform(() => refresh(id));
    if (destination) navigateWorkspace(destination);
  };
  const openCreateTask = () => { setIntakeEverOpened(true); setIntakeOpen(true); };
  const openNewProject = () => { setNewProjectEverOpened(true); setNewProjectOpen(true); };
  const openManualTask = () => { setIntakeOpen(false); taskCreateSequence.current += 1; taskForm.resetFields(); taskForm.setFieldsValue({ type: 'TASK', assigneeId: members.some(member => member.id === user?.id) ? user?.id : undefined }); setCreateOpen(true); };
  const createTask = (values: NewTaskValues) => {
    if (!createOpen || busy || pendingOperations.current > 0 || !projectId || !user) return;
    const request = ++taskCreateSequence.current;
    const requestRoute = location.hash;
    const isCurrent = () => mounted.current && request === taskCreateSequence.current && currentContext.current.userId === user.id && currentContext.current.projectId === projectId && currentContext.current.section === section && location.hash === requestRoute;
    return perform(async () => {
      try {
        const result = await api<{ task: WorkTask }>('tasks', { projectId, ...values, parentId: values.parentId || null, ...(canAssign ? { assigneeId: values.assigneeId || null } : { assigneeId: user.id }) });
        if (!isCurrent()) return;
        taskForm.resetFields(); setCreateOpen(false); void message.success('任务已登记。');
        await refresh(projectId, isCurrent);
        if (!isCurrent()) return;
        openTask(result.task.id);
      } catch (error) { if (isCurrent()) throw error; }
    });
  };
  const claimTaskQuick = (task: WorkTask) => perform(async () => {
    await api<{ task: WorkTask }>(`tasks/${encodeURIComponent(task.id)}/claim`, { expectedVersion: task.version });
    void message.success(`已认领任务 ${task.jiraKey}。`);
    await refreshTasksOnly();
  });
  const batchClaimSelected = (targets: WorkTask[]) => perform(async () => {
    let count = 0;
    for (const item of targets) {
      await api<{ task: WorkTask }>(`tasks/${encodeURIComponent(item.id)}/claim`, { expectedVersion: item.version });
      count += 1;
    }
    setSelectedTaskIds([]);
    void message.success(`已批量认领 ${count} 项任务。`);
    await refreshTasksOnly();
  });
  const batchSwitchStatus = (targets: WorkTask[], nextStatus: TaskStatus) => perform(async () => {
    let count = 0;
    for (const item of targets) {
      await api<{ task: WorkTask }>(`tasks/${encodeURIComponent(item.id)}`, {
        expectedVersion: item.version,
        status: nextStatus,
      }, 'PATCH');
      count += 1;
    }
    setSelectedTaskIds([]);
    void message.success(`已将 ${count} 项任务状态更新为「${taskStatusLabel(nextStatus)}」。`);
    await refreshTasksOnly();
  });
  const batchAssignSelected = (targets: WorkTask[], nextAssigneeId: string) => perform(async () => {
    const normalized = nextAssigneeId || null;
    let count = 0;
    for (const item of targets) {
      if (item.assigneeId === normalized) continue;
      await api<{ task: WorkTask }>(`tasks/${encodeURIComponent(item.id)}`, {
        expectedVersion: item.version,
        assigneeId: normalized,
      }, 'PATCH');
      count += 1;
    }
    setSelectedTaskIds([]);
    if (count > 0) void message.success(`已将 ${count} 项任务指派给「${memberName(members, normalized)}」。`);
    await refreshTasksOnly();
  });
  const switchTaskStatusInline = async (task: WorkTask, nextStatus: TaskStatus) => {
    if (nextStatus === task.status || updatingTaskId) return;
    setUpdatingTaskId(task.id);
    try {
      const res = await api<{ task: WorkTask }>(`tasks/${encodeURIComponent(task.id)}`, {
        expectedVersion: task.version,
        status: nextStatus,
      }, 'PATCH');
      if (!mounted.current) return;
      setAllTasks(prev => prev.map(item => item.id === res.task.id ? res.task : item));
      setTasks(prev => prev.map(item => item.id === res.task.id ? res.task : item));
      void message.success(`${task.jiraKey} 状态已更新为「${taskStatusLabel(nextStatus)}」。`);
    } catch (error) {
      if (mounted.current) handleError(error);
    } finally {
      if (mounted.current) setUpdatingTaskId('');
    }
  };
  const switchTaskAssigneeInline = async (task: WorkTask, nextAssigneeId: string) => {
    const normalized = nextAssigneeId || null;
    if (normalized === task.assigneeId || updatingTaskId) return;
    setUpdatingTaskId(task.id);
    try {
      const res = await api<{ task: WorkTask }>(`tasks/${encodeURIComponent(task.id)}`, {
        expectedVersion: task.version,
        assigneeId: normalized,
      }, 'PATCH');
      if (!mounted.current) return;
      setAllTasks(prev => prev.map(item => item.id === res.task.id ? res.task : item));
      setTasks(prev => prev.map(item => item.id === res.task.id ? res.task : item));
      void message.success(`${task.jiraKey} 本地受理人已更新为「${memberName(members, normalized)}」。`);
    } catch (error) {
      if (mounted.current) handleError(error);
    } finally {
      if (mounted.current) setUpdatingTaskId('');
    }
  };
  const projectCreated = async (created: Project) => {
    const scopeMatches = () => mounted.current && currentContext.current.userId === user?.id && currentContext.current.section === section && location.hash === renderedRoute;
    const isCurrent = () => scopeMatches() && projectIdRef.current === projectId;
    if (!isCurrent()) return;
    resetFilters();
    const refreshRequest = refreshSequence.current + 1;
    await perform(async () => {
      await refresh(created.id, isCurrent);
      if (scopeMatches() && refreshSequence.current === refreshRequest && projectIdRef.current === created.id) navigateWorkspace('tasks');
    });
  };
  const taskImported = async (task: WorkTask, targetProjectId: string) => {
    const scopeMatches = () => mounted.current && currentContext.current.userId === user?.id && currentContext.current.section === section && location.hash === renderedRoute;
    const isCurrent = () => scopeMatches() && projectIdRef.current === projectId;
    if (!isCurrent()) return;
    resetFilters();
    const refreshRequest = refreshSequence.current + 1;
    await perform(async () => {
      await refresh(targetProjectId, isCurrent);
      if (scopeMatches() && refreshSequence.current === refreshRequest && projectIdRef.current === targetProjectId) {
        openTaskRoute(task.id, { from: section });
        setSelectedTaskId(task.id);
      }
    });
  };
  const jiraTypes = [...new Set(tasks.map(task => task.externalRef?.type).filter((value): value is string => !!value))];
  const jiraStatuses = [...new Set(tasks.map(task => task.externalRef?.status).filter((value): value is string => !!value))];
  const jiraVersions = [...new Set(tasks.flatMap(task => task.externalRef?.fixVersions?.map(version => version.name) || []))];
  const filterCount = [statusFilter, jiraTypeFilter, jiraVersionFilter].filter(Boolean).length;
  const hasFilters = !!query || quickScope !== 'all' || !!jiraStatusFilter || filterCount > 0;
  const myTaskCount = tasks.filter(task => task.assigneeId === user?.id && task.status !== 'DONE').length;
  const unclaimedCount = tasks.filter(task => !task.assigneeId && task.status !== 'DONE').length;
  const activeCount = tasks.filter(task => task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW').length;
  const doneCount = tasks.filter(task => task.status === 'DONE').length;
  const matchesQuickScope = (task: WorkTask): boolean => {
    if (quickScope === 'mine') return task.assigneeId === user?.id && task.status !== 'DONE';
    if (quickScope === 'unclaimed') return !task.assigneeId && task.status !== 'DONE';
    if (quickScope === 'active') return task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW';
    if (quickScope === 'done') return task.status === 'DONE';
    return true;
  };
  const visibleTasks = tasks.filter(task => matchesQuickScope(task) &&
    (!query.trim() || (task.jiraKey + ' ' + task.title).toLowerCase().includes(query.trim().toLowerCase())) &&
    (!statusFilter || task.status === statusFilter) && (!jiraTypeFilter || task.externalRef?.type === jiraTypeFilter) &&
    (!jiraStatusFilter || task.externalRef?.status === jiraStatusFilter) && (!jiraVersionFilter || task.externalRef?.fixVersions?.some(version => version.name === jiraVersionFilter)));
  const currentTaskPage = Math.min(taskPage, Math.max(1, Math.ceil(visibleTasks.length / 10)));
  useEffect(() => { if (currentTaskPage !== taskPage) setTaskPage(currentTaskPage); }, [currentTaskPage, taskPage]);
  const projectOptions = groups.map(group => ({
    label: group.name,
    options: projects.filter(item => projectGroup(item).id === group.id).map(item => ({ value: item.id, label: item.key + ' · ' + item.name + ' · ' + allTasks.filter(task => task.projectId === item.id).length + ' 项' })),
  }));
  const isProjectMember = !!user && (user.role === 'ADMIN' || members.some(member => member.id === user.id));
  const confirmRemoveTask = (task: WorkTask) => {
    const descendants: WorkTask[] = [];
    const seen = new Set([task.id]);
    const queue = [task.id];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const item of allTasks) {
        if (item.parentId === pid && !seen.has(item.id)) {
          seen.add(item.id); descendants.push(item); queue.push(item.id);
        }
      }
    }
    modal.confirm({
      title: descendants.length ? `移出 ${task.jiraKey} 及其 ${descendants.length} 个子任务？` : `移出任务 ${task.jiraKey}？`,
      content: '仅从当前本地工作台移除任务及关联的本地材料/评审记录，不会修改或删除外部 Jira 事项。',
      okText: '移出工作台',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => perform(async () => {
        const res = await api<{ deletedCount: number; deletedIds: string[] }>('tasks/' + task.id + (descendants.length ? '?cascade=1' : ''), undefined, 'DELETE');
        if (selectedTaskId && res.deletedIds.includes(selectedTaskId)) clearTaskSelection();
        void message.success(`已从工作台移出 ${res.deletedCount} 项任务。`);
        await refreshTasksOnly();
      }),
    });
  };

  if (initializing) return <div className="workspace-content tf-workbench"><Card><Skeleton active title={{ width: '36%' }} paragraph={{ rows: 5 }} /></Card></div>;

  if (!user) return <div className="workspace-content workspace-content-login tf-workbench tf-login">
    <Card className="tf-login-card">
      <Flex vertical gap={24}>
        <div><span className="tf-login-icon"><ShieldCheck size={24} /></span><Title level={2}>登录平台</Title><Paragraph type="secondary">任务、版本化资产、评审记录与质量门禁集中跟踪。</Paragraph></div>
        <Form name="platform-login" form={loginForm} layout="vertical" requiredMark={false} disabled={busy} onFinish={values => void authenticate(values, false)}>
          <Form.Item htmlFor="service-username" label="用户名" name="username" rules={[{ required: true, message: '请输入用户名。' }, { min: 3, max: 64, message: '用户名需为 3–64 个字符。' }, { pattern: /^[a-zA-Z0-9_.-]+$/, message: '用户名仅支持字母、数字和_.-。' }]}><Input id="service-username" autoComplete="username" maxLength={64} /></Form.Item>
          <Form.Item htmlFor="service-password" label="密码（8–256 字符）" name="password" rules={[{ required: true, message: '请输入密码。' }, { min: 8, max: 256, message: '密码需为 8–256 个字符。' }]}><Input.Password id="service-password" autoComplete="current-password" maxLength={256} /></Form.Item>
          <Form.Item htmlFor="service-setup-token" label="初始化口令（仅服务器部署首次创建管理员时填写）" name="setupToken"><Input.Password id="service-setup-token" autoComplete="off" maxLength={256} /></Form.Item>
          <Flex vertical gap={12}>
            <Button type="primary" htmlType="submit" block loading={busy}>登录</Button>
            <Button block disabled={busy} onClick={() => void loginForm.validateFields().then(values => authenticate(values, true)).catch(() => {})}>创建初始管理员并登录</Button>
          </Flex>
        </Form>
        <Text type="secondary" className="tf-form-note">首次使用可创建初始管理员；已有账号请直接登录。</Text>
      </Flex>
    </Card>
  </div>;

  const hasBoundJira = projects.some(item => !!item.jira);
  const syncMyJiraTasks = (scopedToProject = false) => perform(async () => {
    const res = await api<{
      identity: { displayName?: string; name?: string } | null;
      importedCount: number; updatedCount: number; removedCount: number; unassignedCount: number;
    }>('jira/tasks/sync-mine', scopedToProject && projectId ? { projectId } : {});
    const parts = [
      res.importedCount ? `新接入 ${res.importedCount} 项` : '',
      res.updatedCount ? `更新 ${res.updatedCount} 项` : '',
      res.removedCount ? `清理非本人/已结项 ${res.removedCount} 项` : '',
      res.unassignedCount ? `解绑已转交任务 ${res.unassignedCount} 项` : '',
    ].filter(Boolean);
    const who = res.identity?.displayName || res.identity?.name || '';
    void message.success(parts.length ? `已按${who ? `「${who}」` : ''}最新 Jira 同步：${parts.join('，')}。` : `已按${who ? `「${who}」` : ''}最新 Jira 校验，当前待办已是最新。`);
    await refresh(scopedToProject ? projectId : '');
  });
  const isTaskDetail = section === 'tasks' && !!selectedTaskId;
  const scoped = ['tasks', 'todos', 'reports', 'reviews', 'assets', 'sessions', 'deployments', 'knowledge', 'skills', 'members', 'accounts', 'connections'].includes(section) && !isTaskDetail;
  const navTaskPool = visibleTasks.some(item => item.id === selectedTaskId) ? visibleTasks : tasks;
  const currentNavIndex = isTaskDetail ? navTaskPool.findIndex(item => item.id === selectedTaskId) : -1;
  const prevNavTask = currentNavIndex > 0 ? navTaskPool[currentNavIndex - 1] : undefined;
  const nextNavTask = currentNavIndex >= 0 && currentNavIndex < navTaskPool.length - 1 ? navTaskPool[currentNavIndex + 1] : undefined;
  shortcutNavRef.current = { prevTaskId: prevNavTask?.id, nextTaskId: nextNavTask?.id, openTask, busy };
  const applySavedView = (view: SavedTaskFilterView) => {
    setQuickScope(view.quickScope);
    writeStoredString(TASK_SCOPE_KEY, view.quickScope);
    setQuery(view.query || '');
    setStatusFilter(view.statusFilter);
    setJiraTypeFilter(view.jiraTypeFilter);
    setJiraStatusFilter(view.jiraStatusFilter);
    setJiraVersionFilter(view.jiraVersionFilter);
    if (view.viewMode) {
      setViewMode(view.viewMode);
      writeStoredString(TASK_VIEW_MODE_KEY, view.viewMode);
    }
  };
  const openSaveCurrentView = () => {
    const scopeNames: Record<QuickTaskScope, string> = {
      all: '',
      mine: '我负责的',
      unclaimed: '待认领',
      active: '推进中',
      done: '已完成',
    };
    const suggested = [
      scopeNames[quickScope],
      statusFilter ? taskStatusLabel(statusFilter) : '',
      jiraStatusFilter || '',
      jiraVersionFilter || '',
      jiraTypeFilter || '',
      query.trim(),
    ].filter(Boolean).join(' · ').slice(0, 36) || '常用筛选';
    setSavingViewName(suggested);
    setSavingViewOpen(true);
  };
  const confirmSaveCurrentView = () => {
    const name = savingViewName.trim();
    if (!name || !projectId) return;
    const next = saveTaskFilterView(projectId, {
      name,
      quickScope,
      query: query.trim() || undefined,
      statusFilter,
      jiraTypeFilter,
      jiraStatusFilter,
      jiraVersionFilter,
      viewMode,
    });
    setSavedViews(next);
    setSavingViewOpen(false);
    setSavingViewName('');
    void message.success(`已保存当前筛选视图「${name}」。`);
  };
  const removeSavedView = (view: SavedTaskFilterView) => {
    if (!projectId) return;
    const next = deleteSavedTaskView(projectId, view.id);
    setSavedViews(next);
    void message.info(`已移除视图「${view.name}」。`);
  };
  const accountActions = <Space wrap size={8} className="tf-page-actions"><StatusBadge variant="blue">{user.username} · {roleLabel(scoped || isTaskDetail ? role || user.role : user.role)}</StatusBadge><Tooltip title="全局搜索任务、项目与模块（Cmd/Ctrl + K）"><Button icon={<Search size={15} />} onClick={openQuickCommand}>跳转 ⌘K</Button></Tooltip><Tooltip title="键盘快捷键指南（按 ? 查看）"><Button icon={<Keyboard size={15} />} aria-label="快捷键指南" onClick={() => { setShortcutsEverOpened(true); setShortcutsOpen(true); }} /></Tooltip><Button icon={<RefreshCw size={16} />} loading={busy} onClick={() => void perform(() => refresh())}>刷新</Button>{workbenchAvailable && <Tooltip title={workbenchMode === 'server' ? '打开服务器上的工作台（AI 与 git 在你电脑上执行，需 Bridge 在运行）' : '在浏览器中打开你电脑上的工作台（需本机工作台与 Bridge 在运行）'}><Button icon={<MonitorSmartphone size={16} />} onClick={openWorkbench}>我的工作台</Button></Tooltip>}<Button type="text" icon={<KeyRound size={16} />} disabled={busy} onClick={() => setPasswordOpen(true)}>修改密码</Button><Button type="text" icon={<LogOut size={16} />} disabled={busy} onClick={() => void perform(async () => { await api('logout', {}); clearSession(); })}>退出</Button></Space>;
  const taskList = <>
      <Card title={<Space size={8}><h2 className="tf-section-heading">任务列表</h2><Text type="secondary" className="tf-table-secondary">{visibleTasks.length} / {tasks.length}</Text></Space>} extra={<Space wrap size={8}><Segmented<TaskViewMode> aria-label="任务视图切换" value={viewMode} onChange={val => { setViewMode(val); writeStoredString(TASK_VIEW_MODE_KEY, val); }} options={[{ value: 'list', label: <Space size={4}><List size={14} /><span>列表</span></Space> }, { value: 'board', label: <Space size={4}><LayoutGrid size={14} /><span>看板</span></Space> }]} />{hasBoundJira && <Button icon={<RefreshCw size={15} />} disabled={busy} loading={busy} onClick={() => void syncMyJiraTasks(false)}>同步我的最新 Jira</Button>}<Button type="primary" icon={<Plus size={16} />} disabled={!projectId || busy} onClick={openCreateTask}>接入 Jira 任务</Button></Space>} className="tf-task-list-card">
        <div className="tf-task-quick-scopes">
          <Segmented<QuickTaskScope>
            aria-label="任务范围快捷筛选"
            value={quickScope}
            onChange={val => { setQuickScope(val); writeStoredString(TASK_SCOPE_KEY, val); }}
            options={[
              { value: 'all', label: `全部 (${tasks.length})` },
              { value: 'mine', label: `我负责的 (${myTaskCount})` },
              { value: 'unclaimed', label: `待认领 (${unclaimedCount})` },
              { value: 'active', label: `推进中 (${activeCount})` },
              { value: 'done', label: `已完成 (${doneCount})` },
            ]}
          />
        </div>
        <div className="tf-task-toolbar">
          <Input ref={taskSearchRef} aria-label="搜索任务" prefix={<Search size={16} />} placeholder="搜索任务号或标题（按 / 聚焦，Esc 清空）" value={query} allowClear onChange={event => setQuery(event.target.value)} onKeyDown={clearSearchOnEscape(query, () => setQuery(''))} />
          <Select aria-label="Jira 状态" placeholder="Jira 状态：全部" allowClear value={jiraStatusFilter} options={options(jiraStatuses)} onChange={setJiraStatusFilter} disabled={!jiraStatuses.length} />
          {hasFilters && !savingViewOpen && (
            <Button size="small" icon={<Bookmark size={13} />} onClick={openSaveCurrentView}>
              保存视图
            </Button>
          )}
          {hasFilters && <Button type="text" onClick={resetFilters}>重置筛选</Button>}
        </div>
        {savingViewOpen && (
          <Flex gap={8} align="center" wrap style={{ marginTop: 8 }}>
            <Input
              size="small"
              aria-label="保存筛选视图名称"
              placeholder="输入常用筛选视图名称"
              value={savingViewName}
              maxLength={40}
              style={{ width: 240 }}
              onChange={e => setSavingViewName(e.target.value)}
              onPressEnter={confirmSaveCurrentView}
            />
            <Button size="small" type="primary" disabled={!savingViewName.trim()} onClick={confirmSaveCurrentView}>
              保存
            </Button>
            <Button size="small" type="text" onClick={() => { setSavingViewOpen(false); setSavingViewName(''); }}>
              取消
            </Button>
          </Flex>
        )}
        {savedViews.length > 0 && (
          <Flex gap={6} align="center" wrap style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>常用视图：</Text>
            {savedViews.map(v => {
              const active = isSavedViewActive(v, {
                quickScope,
                query,
                statusFilter,
                jiraTypeFilter,
                jiraStatusFilter,
                jiraVersionFilter,
              });
              return (
                <Tag
                  key={v.id}
                  color={active ? 'processing' : 'default'}
                  closable
                  style={{ cursor: 'pointer', marginInlineEnd: 0, userSelect: 'none' }}
                  onClick={() => applySavedView(v)}
                  onClose={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    removeSavedView(v);
                  }}
                >
                  {v.name}
                </Tag>
              );
            })}
          </Flex>
        )}
        <Collapse
          ghost
          className="tf-task-filter-collapse"
          activeKey={filtersOpen ? ['filters'] : []}
          onChange={keys => {
            const next = keys.includes('filters');
            setFiltersOpen(next);
            writeStoredBool(FILTERS_OPEN_KEY, next);
          }}
          items={[{ key: 'filters', label: <Space size={8}><SlidersHorizontal size={15} />更多筛选{filterCount > 0 && <Text type="secondary">({filterCount})</Text>}</Space>, children: <div className="tf-task-advanced-filters">
            <Form.Item layout="vertical" label="Jira 类型"><Select aria-label="Jira 类型" placeholder="全部类型" allowClear value={jiraTypeFilter} options={options(jiraTypes)} onChange={setJiraTypeFilter} disabled={!jiraTypes.length} /></Form.Item>
            <Form.Item layout="vertical" label="Jira 修复版本"><Select aria-label="Jira 修复版本" placeholder="全部版本" showSearch={{ optionFilterProp: 'label' }} allowClear value={jiraVersionFilter} options={options(jiraVersions)} onChange={setJiraVersionFilter} disabled={!jiraVersions.length} /></Form.Item>
            <Form.Item layout="vertical" label="本地状态"><Select aria-label="本地状态" placeholder="全部状态" allowClear value={statusFilter} options={TASK_STATUS_OPTIONS} onChange={setStatusFilter} /></Form.Item>
          </div> }]}
        />
        {viewMode === 'board' ? (
          <Suspense fallback={<Skeleton active paragraph={{ rows: 4 }} />}>
            <TaskKanbanBoard
              tasks={visibleTasks}
              allTasks={allTasks}
              members={members}
              userId={user.id}
              canAssign={canAssign}
              isProjectMember={isProjectMember}
              busy={busy}
              updatingTaskId={updatingTaskId}
              onOpenTask={openTask}
              onMoveStatus={(target, nextStatus) => void switchTaskStatusInline(target, nextStatus)}
              onClaimTask={target => void claimTaskQuick(target)}
            />
          </Suspense>
        ) : (
          <TaskListTable
            tasks={visibleTasks}
            projectTasks={tasks}
            allTasks={allTasks}
            members={members}
            userId={user.id}
            canAssign={canAssign}
            isProjectMember={isProjectMember}
            busy={busy}
            updatingTaskId={updatingTaskId}
            page={currentTaskPage}
            onPageChange={setTaskPage}
            selectedIds={selectedTaskIds}
            onSelectionChange={setSelectedTaskIds}
            onOpenTask={openTask}
            onSwitchStatus={(target, nextStatus) => void switchTaskStatusInline(target, nextStatus)}
            onSwitchAssignee={(target, assigneeId) => void switchTaskAssigneeInline(target, assigneeId)}
            onClaim={target => void claimTaskQuick(target)}
            onRemove={confirmRemoveTask}
            onBatchClaim={targets => void batchClaimSelected(targets)}
            onBatchStatus={(targets, nextStatus) => void batchSwitchStatus(targets, nextStatus)}
            onBatchAssign={(targets, assigneeId) => void batchAssignSelected(targets, assigneeId)}
          />
        )}
      </Card>

  </>;
  let content: React.ReactNode;
  if (section === 'overview') content = <WorkspaceOverview projects={projects} tasks={allTasks} user={user} onUnauthorized={clearSession} onSyncJira={hasBoundJira ? () => void syncMyJiraTasks(false) : undefined} syncingJira={busy} onApproved={() => void refreshTasksOnly()} openDigestTick={digestTick} />;
  else if (section === 'projects') content = <ProjectDirectory projects={projects} tasks={allTasks} onOpen={switchProject} onCreate={platformPermissions.createProjects ? openNewProject : undefined} onProjectRenamed={updated => setProjects(prev => prev.map(item => item.id === updated.id ? { ...item, name: updated.name } : item))} />;
  else if (section === 'reviews') content = <Suspense fallback={routeFallback}><ReviewCenter projectId={projectId} tasks={tasks} user={user} role={role || 'DEV'} onChanged={() => refreshTasksOnly()} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'assets') content = <Suspense fallback={routeFallback}><AssetCenter projectId={projectId} tasks={tasks} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'members') content = project ? <Suspense fallback={routeFallback}><MembersAccessView key={projectId} projectId={projectId} projectKey={project.key} user={user} role={role || 'DEV'} members={members} users={users} tasks={tasks} candidates={candidates} permissions={permissions} canManageUsers={platformPermissions.manageUsers} onChanged={() => refresh()} onUnauthorized={clearSession} onForbidden={reloadAccess} /></Suspense> : <Card><Empty description="尚无可访问的项目" /></Card>;
  else if (section === 'connections') content = <Suspense fallback={routeFallback}><ConnectionsView projectId={projectId} project={project} projects={projects} role={role || 'DEV'} user={user} platformPermissions={platformPermissions} onUnauthorized={clearSession} onForbidden={reloadAccess} onProjectsChanged={async id => { await refresh(id); }} /></Suspense>;
  else if (section === 'todos') content = <Suspense fallback={routeFallback}><TeamTodosView key={user.id} user={user} projects={projects} projectId={projectId} members={members} tasks={tasks} canAssign={permissions.assignTasks} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'reports') content = <Suspense fallback={routeFallback}><WorkReportsView key={user.id} user={user} projects={projects} projectId={projectId} members={members} canViewOthers={permissions.assignTasks} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'sessions') content = <Suspense fallback={routeFallback}><AgentSessionsView key={user.id} user={user} projects={projects} projectId={projectId} tasks={tasks} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'deployments') content = <Suspense fallback={routeFallback}><DeploymentsView key={user.id} user={user} projectId={projectId} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'knowledge') content = <Suspense fallback={routeFallback}><KnowledgeView key={user.id} user={user} projectId={projectId} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'skills') content = <Suspense fallback={routeFallback}><TeamSkillsView key={user.id} user={user} projectId={projectId} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'local') content = <Suspense fallback={routeFallback}><LocalIntegrationView user={user} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'accounts') content = <Suspense fallback={routeFallback}><AccountsView user={user} project={project} projects={projects} onUnauthorized={clearSession} onForbidden={reloadAccess} onChanged={() => refresh()} /></Suspense>;
  else if (isTaskDetail) content = tasks.some(task => task.id === selectedTaskId) ? <Suspense fallback={routeFallback}><WorkTaskDetail key={selectedTaskId} taskId={selectedTaskId} user={user} role={role || 'DEV'} permissions={permissions} members={members} tasks={tasks} allTasks={allTasks} onOpenTask={openTask} onChanged={() => refreshTasksOnly()} onUnauthorized={clearSession} onForbidden={reloadAccess} /></Suspense> : routeFallback;
  else content = taskList;

  return <div className="workspace-content tf-workbench">
    {isTaskDetail ? <div className="tf-task-backbar"><Space size={10} wrap><Button type="text" icon={<ArrowLeft size={16} />} onClick={() => navigateWorkspace(taskReturnSection(), taskReturnFilters())}>返回{SECTION_LABELS[taskReturnSection()]}</Button><Text type="secondary">{project?.key} · {project?.name}</Text>{navTaskPool.length > 1 && currentNavIndex >= 0 && <Space size={2}><Tooltip title={prevNavTask ? `上一项：${prevNavTask.jiraKey} ${prevNavTask.title}` : '已是第一项'}><Button type="text" size="small" icon={<ChevronLeft size={15} />} aria-label="上一项任务" disabled={busy || !prevNavTask} onClick={() => prevNavTask && openTask(prevNavTask.id)} /></Tooltip><Text type="secondary" style={{ fontSize: 12 }}>{currentNavIndex + 1} / {navTaskPool.length}</Text><Tooltip title={nextNavTask ? `下一项：${nextNavTask.jiraKey} ${nextNavTask.title}` : '已是最后一项'}><Button type="text" size="small" icon={<ChevronRight size={15} />} aria-label="下一项任务" disabled={busy || !nextNavTask} onClick={() => nextNavTask && openTask(nextNavTask.id)} /></Tooltip></Space>}</Space>{accountActions}</div> : <>
      <div className="tf-page-heading tf-module-heading"><div><Title level={1}>{heading}</Title><Paragraph type="secondary">{descriptions[section]}</Paragraph></div>{accountActions}</div>
      {scoped && <div className="tf-module-scope"><Text type="secondary">项目</Text><Select aria-label="当前项目" showSearch={{ optionFilterProp: 'label' }} value={projectId || undefined} disabled={busy || !projects.length} options={projectOptions} onChange={id => switchProject(id)} placeholder="选择项目" /></div>}
    </>}
    {content}
    <ChangePasswordDrawer open={passwordOpen} username={user.username} onClose={() => setPasswordOpen(false)} onUnauthorized={clearSession} />
    {(shortcutsOpen || shortcutsEverOpened) && (
      <Suspense fallback={null}>
        <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </Suspense>
    )}
    {(quickOpen || quickEverOpened) && (
      <Suspense fallback={null}>
        <QuickCommandModal
          open={quickOpen}
          tasks={allTasks}
          projects={projects}
          currentProjectId={projectId}
          currentUserId={user.id}
          canIntake={!!projectId && !busy}
          canSyncJira={hasBoundJira && !busy}
          onClose={() => setQuickOpen(false)}
          onSelectTask={jumpToTaskFromCommand}
          onSelectProject={id => switchProject(id, scoped ? undefined : 'tasks')}
          onSelectSection={nextSection => navigateWorkspace(nextSection)}
          onTriggerAction={act => {
            if (act === 'intake') openCreateTask();
            else if (act === 'sync-jira') void syncMyJiraTasks(false);
            else if (act === 'standup-digest') {
              if (section !== 'overview') navigateWorkspace('overview');
              setDigestTick(tick => tick + 1);
            }
          }}
        />
      </Suspense>
    )}
    {platformPermissions.createProjects && (newProjectOpen || newProjectEverOpened) && (
      <Suspense fallback={null}>
        <ProjectCreateDrawer open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onUnauthorized={clearSession} onForbidden={reloadAccess} onCreated={projectCreated} />
      </Suspense>
    )}
    {(intakeOpen || intakeEverOpened) && (
      <Suspense fallback={null}>
        <JiraTaskIntake open={intakeOpen} user={user} projects={projects} existingTasks={allTasks} initialProjectId={projectId} onClose={() => setIntakeOpen(false)} onManual={openManualTask} onImported={taskImported} onUnauthorized={clearSession} onForbidden={reloadAccess} />
      </Suspense>
    )}
    <Drawer forceRender title="手动登记任务" open={createOpen} onClose={closeCreateTask} closable={!busy} maskClosable={!busy} keyboard={!busy} size={640} className="tf-task-drawer" footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeCreateTask}>取消</Button><Button type="primary" loading={busy} disabled={!projectId} onClick={() => taskForm.submit()}>手动登记</Button></Flex>}>
      <Form name="new-local-task" form={taskForm} layout="vertical" initialValues={{ type: 'TASK', assigneeId: members.some(member => member.id === user.id) ? user.id : undefined }} disabled={busy} onFinish={values => void createTask(values)} onKeyDown={event => { if (isSubmitShortcut(event) && !busy && projectId) { event.preventDefault(); taskForm.submit(); } }}>
        <div className="tf-form-two-columns"><Form.Item htmlFor="service-jira-key" label="Jira 任务号" name="jiraKey" rules={[{ required: true, message: '请输入 Jira 任务号。' }, { pattern: /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/, message: '请输入有效的 Jira 任务号。' }]}><Input id="service-jira-key" maxLength={48} placeholder={(project?.jira?.key || 'PROJ') + '-100'} /></Form.Item><Form.Item label="本地任务类型" name="type" rules={[{ required: true }]}><Select options={TASK_TYPE_OPTIONS} /></Form.Item></div>
        <Form.Item htmlFor="service-task-title" label="任务标题" name="title" rules={[{ required: true, whitespace: true, message: '请输入任务标题。' }]}><Input id="service-task-title" maxLength={200} /></Form.Item>
        <Form.Item label="父任务（可选）" name="parentId"><Select placeholder="无父任务" allowClear showSearch={{ optionFilterProp: 'label' }} options={tasks.map(task => ({ value: task.id, label: task.jiraKey + ' · ' + task.title + (task.status === 'DONE' ? ' · 已完成（需先重开）' : ''), disabled: task.status === 'DONE' }))} /></Form.Item>
        <Form.Item label="受理人" name="assigneeId"><Select placeholder="未指派" allowClear disabled={busy || !canAssign} options={members.map(member => ({ value: member.id, label: member.username }))} /></Form.Item>
        <Text type="secondary" className="tf-form-note">{project?.jira ? '任务号需属于当前 Jira 项目 ' + project.jira.key + '。登记至本地任务空间，Jira 关联尚未验证；不会创建或修改外部 Jira 事项。' : '登记至本地任务空间，Jira 关联尚未验证；不会创建或修改外部 Jira 事项。'}</Text>
      </Form>
    </Drawer>
  </div>;
};

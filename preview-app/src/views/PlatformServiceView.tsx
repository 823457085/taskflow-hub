import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { readTogether } from './readTogether';
import { Alert, App, Button, Card, Drawer, Dropdown, Empty, Flex, Form, Input, Segmented, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import { ArrowLeft, Bookmark, ChevronDown, ChevronLeft, ChevronRight, KeyRound, Keyboard, LayoutGrid, Link2, List, LogOut, MonitorSmartphone, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, ApiError, isChildTask, memberName, MemberCandidate, NO_PLATFORM_PERMISSIONS, NO_PROJECT_PERMISSIONS, normalizePlatformPermissions, normalizeProjectPermissions, PlatformPermissions, Project, ProjectMember, projectGroup, Role, TaskStatus, User, WorkTask } from './workspaceApi';
import { ProjectDirectory, WorkspaceOverview } from './WorkspaceOverview';
import { listAccounts, syncPersonalJiraProjects } from './accountApi';
import { clearTaskRoute, closeTaskRoute, navigateWorkspace, openTaskRoute, requirementIdFromRoute, requirementReviewStageForSection, SECTION_LABELS, type TaskDestination, WorkspaceSection } from './workspaceNavigation';
import { ChangePasswordDrawer } from './PasswordDrawers';
import { roleLabel, TASK_STATUS_OPTIONS, TASK_TYPE_OPTIONS, taskStatusLabel } from './displayLabels';
import { TASK_PAGE_SIZE, TaskListTable } from './TaskListTable';
import { buildTaskTree, type TreeTaskRow } from './taskTree';
import {
  clearSearchOnEscape,
  deleteSavedTaskView,
  isEditableTarget,
  isSavedViewActive,
  isSubmitShortcut,
  readSavedTaskViews,
  readStoredChoice,
  readStoredStringList,
  saveTaskFilterView,
  writeStoredString,
  writeStoredStringList,
  type SavedTaskFilterView,
} from './uiPreferences';
import './PlatformServiceView.css';

const WorkTaskDetail = lazy(() => import('./WorkTaskDetail').then(mod => ({ default: mod.WorkTaskDetail })));
const RequirementsCenter = lazy(() => import('./RequirementsCenter').then(mod => ({ default: mod.RequirementsCenter })));
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
const ProjectSettingsOverview = lazy(() => import('./ProjectSettingsOverview').then(mod => ({ default: mod.ProjectSettingsOverview })));
const ReviewCenter = lazy(() => import('./WorkflowCenters').then(mod => ({ default: mod.ReviewCenter })));
const AssetCenter = lazy(() => import('./WorkflowCenters').then(mod => ({ default: mod.AssetCenter })));
const QuickCommandModal = lazy(() => import('./QuickCommandModal').then(mod => ({ default: mod.QuickCommandModal })));
const TaskKanbanBoard = lazy(() => import('./TaskKanbanBoard').then(mod => ({ default: mod.TaskKanbanBoard })));
const KeyboardShortcutsModal = lazy(() => import('./KeyboardShortcutsModal').then(mod => ({ default: mod.KeyboardShortcutsModal })));

const { Text, Title, Paragraph } = Typography;
const PROJECT_FILTER_SECTIONS = new Set<WorkspaceSection>([
  'tasks', 'tech-review', 'test-review', 'code-review', 'reviews', 'assets', 'todos', 'reports',
  'sessions', 'deployments', 'knowledge', 'members', 'accounts', 'connections',
]);
const TASK_SCOPE_KEY = 'taskflow.tasks.quickScope';
const TASK_VIEW_MODE_KEY = 'taskflow.tasks.viewMode.v3';
const QUICK_SCOPES = ['all', 'mine', 'unclaimed', 'active', 'done'] as const;
type QuickTaskScope = typeof QUICK_SCOPES[number];
const VIEW_MODES = ['list', 'board'] as const;
type TaskViewMode = typeof VIEW_MODES[number];
const taskFromHash = () => new URLSearchParams(location.hash.slice(1)).get('task') || '';
const options = (values: string[]) => values.map(value => ({ value, label: value }));
type PreviewBuildMeta = { revision?: string; commit?: string };
async function readPreviewBuildMeta(): Promise<PreviewBuildMeta | null> {
  try {
    const res = await fetch('/__taskflow/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.revision === 'string' ? data : null;
  } catch {
    return null;
  }
}
type LoginValues = { username: string; password: string; setupToken?: string };
type NewTaskValues = { jiraKey?: string; title: string; type: WorkTask['type']; parentId?: string; assigneeId?: string };

const routeFallback = <Card><Skeleton active paragraph={{ rows: 5 }} /></Card>;

export const PlatformServiceView: React.FC<{ headerActions?: HTMLElement | null; section?: WorkspaceSection; onSessionChange?: (authenticated: boolean) => void; onAccessChange?: (access: { manageMembers: boolean; manageConnections: boolean }) => void }> = ({ headerActions, section = 'overview', onSessionChange, onAccessChange }) => {
  const { message, modal } = App.useApp();
  const [loginForm] = Form.useForm<LoginValues>();
  const [taskForm] = Form.useForm<NewTaskValues>();
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [allTasks, setAllTasks] = useState<WorkTask[]>([]);
  const [hiddenTaskPreference, setHiddenTaskPreference] = useState<{ key: string; ids: string[] }>();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [platformPermissions, setPlatformPermissions] = useState<PlatformPermissions>(NO_PLATFORM_PERMISSIONS);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(taskFromHash);
  const [previewTaskId, setPreviewTaskId] = useState('');
  const [requirementTaskId, setRequirementTaskId] = useState(() => requirementIdFromRoute() || '');
  const [activeRequirementId, setActiveRequirementId] = useState('');
  const [projectFilters, setProjectFilters] = useState<Partial<Record<WorkspaceSection, string>>>({});
  const [legacyTaskList, setLegacyTaskList] = useState(false);
  const [taskTrail, setTaskTrail] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [quickScope, setQuickScope] = useState<QuickTaskScope>(() => readStoredChoice(TASK_SCOPE_KEY, QUICK_SCOPES, 'all'));
  const [statusFilter, setStatusFilter] = useState<string>();
  const [jiraTypeFilter, setJiraTypeFilter] = useState<string>();
  const [jiraStatusFilter, setJiraStatusFilter] = useState<string>();
  const [jiraVersionFilter, setJiraVersionFilter] = useState<string>();
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
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);
  const [viewMode, setViewMode] = useState<TaskViewMode>(() => readStoredChoice(TASK_VIEW_MODE_KEY, VIEW_MODES, 'list'));
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [savedViews, setSavedViews] = useState<SavedTaskFilterView[]>([]);
  const [savingViewOpen, setSavingViewOpen] = useState(false);
  const [savingViewName, setSavingViewName] = useState('');
  const [taskPage, setTaskPage] = useState(1);
  const [updatingTaskId, setUpdatingTaskId] = useState('');
  const [syncingJira, setSyncingJira] = useState(false);
  const [syncingJiraChildren, setSyncingJiraChildren] = useState('');
  const childrenSyncInFlight = useRef(false);
  const childrenSyncAttempted = useRef(new Set<string>());
  const [syncingPersonalJiraProjects, setSyncingPersonalJiraProjects] = useState(false);
  const [buildUpdate, setBuildUpdate] = useState<{ revision: string; commit?: string } | null>(null);
  const loadedBuildRevision = useRef('');
  const lastVersionCheckAt = useRef(0);
  const checkBuildUpdate = async (reloadIfChanged = false): Promise<boolean> => {
    const latest = await readPreviewBuildMeta();
    if (!latest?.revision) return false;
    if (!loadedBuildRevision.current) {
      loadedBuildRevision.current = latest.revision;
      return false;
    }
    if (latest.revision === loadedBuildRevision.current) return false;
    if (reloadIfChanged) {
      window.location.reload();
      return true;
    }
    setBuildUpdate({ revision: latest.revision, commit: latest.commit });
    return false;
  };
  const taskSearchRef = useRef<InputRef>(null);
  const shortcutNavRef = useRef<{ prevTaskId?: string; nextTaskId?: string; openTask: (id: string) => void; busy: boolean }>({ openTask: () => {}, busy: false });
  const lastRoutedTaskId = useRef(taskFromHash());
  const lastRoutedRequirementId = useRef(requirementTaskId);
  const projectIdRef = useRef('');
  const refreshSequence = useRef(0);
  const pendingOperations = useRef(0);
  const jiraSyncInFlight = useRef(false);
  const jiraTasksRefreshPending = useRef(false);
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
  const requirementsActive = section === 'tasks' && !legacyTaskList;
  const reviewStage = requirementsActive ? 'PRD' : requirementReviewStageForSection(section);
  const requirementWorkspace = !!reviewStage;
  const scoped = PROJECT_FILTER_SECTIONS.has(section);
  const savedFilter = projectFilters[section];
  const linkedRequirement = requirementWorkspace && savedFilter && requirementTaskId
    ? allTasks.find(task => task.id === requirementTaskId && !isChildTask(task))
    : undefined;
  const pageProject = projects.find(item => item.id === (linkedRequirement?.projectId || savedFilter));
  const pageProjectId = pageProject?.id || '';
  const canManageAnyMembers = projects.some(item => item.permissions?.manageMembers);
  const canManageAnyConnections = projects.some(item => item.permissions?.manageConnections);
  const showMemberSettings = pageProject ? pageProject.permissions?.manageMembers : canManageAnyMembers;
  const showConnectionSettings = pageProject ? pageProject.permissions?.manageConnections : canManageAnyConnections;
  const scopeRef = useRef({ section, projectId: pageProjectId, userId: user?.id });
  scopeRef.current = { section, projectId: pageProjectId, userId: user?.id };
  const heading = section === 'tasks' && legacyTaskList ? '任务管理'
    : section === 'members' && !showMemberSettings ? '项目成员'
    : section === 'connections' && !showConnectionSettings ? '平台读取' : SECTION_LABELS[section];
  const taskReturnSection = () => {
    const from = new URLSearchParams(location.hash.slice(1)).get('from');
    return from && Object.prototype.hasOwnProperty.call(SECTION_LABELS, from) ? from as WorkspaceSection : 'tasks';
  };
  const closeTaskDrawer = () => {
    setTaskTrail([]);
    setSelectedTaskId('');
    lastRoutedTaskId.current = '';
    closeTaskRoute();
  };
  const openTask = (id: string, destination?: Pick<TaskDestination, 'tab' | 'jobId'>, options?: { pushTrail?: boolean }) => {
    if (!id) { closeTaskDrawer(); return; }
    if (options?.pushTrail && selectedTaskId && selectedTaskId !== id) {
      setTaskTrail(prev => prev[prev.length - 1] === selectedTaskId ? prev : [...prev.slice(-9), selectedTaskId]);
    } else if (!selectedTaskId) {
      setTaskTrail([]);
    }
    const sameProject = tasks.some(item => item.id === id);
    if (sameProject) lastRoutedTaskId.current = id;
    openTaskRoute(id, { ...destination, from: selectedTaskId ? taskReturnSection() : section });
    setSelectedTaskId(id);
  };
  const goBackTaskTrail = () => {
    if (!taskTrail.length) return;
    const prevId = taskTrail[taskTrail.length - 1];
    setTaskTrail(prev => prev.slice(0, -1));
    openTask(prevId);
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
    setTaskTrail([]);
    setSelectedTaskId(''); lastRoutedTaskId.current = '';
    clearTaskRoute();
  };
  const clearProjectAccess = () => {
    taskCreateSequence.current += 1;
    refreshSequence.current += 1; projectIdRef.current = '';
    setProjectId(''); setProjectFilters({}); setProjects([]); setTasks([]); setAllTasks([]); setMembers([]); setCandidates([]); setUsers([]); setPlatformPermissions(NO_PLATFORM_PERMISSIONS);
    setCreateOpen(false); setIntakeOpen(false); setNewProjectOpen(false); setQuickOpen(false); setShortcutsOpen(false); taskForm.resetFields(); resetFilters(); clearTaskSelection();
  };
  const clearSession = () => {
    jiraTasksRefreshPending.current = false;
    childrenSyncAttempted.current.clear();
    taskCreateSequence.current += 1;
    refreshSequence.current += 1; projectIdRef.current = '';
    setUser(null); setProjectFilters({}); setWorkbenchSupported(null); setWorkbenchMode(null); setTasks([]); setAllTasks([]); setProjects([]); setMembers([]); setCandidates([]); setUsers([]); setPlatformPermissions(NO_PLATFORM_PERMISSIONS); setCreateOpen(false); setIntakeOpen(false); setQuickOpen(false); setShortcutsOpen(false); setPasswordOpen(false);
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
      const me = await api<{ user: User; permissions?: PlatformPermissions; workbench?: { enabled: boolean; mode?: 'server' | 'relay' | null } }>('me');
      if (!isCurrent()) return;
      const platformAccess = normalizePlatformPermissions(me.permissions);
      const requestedTaskId = taskFromHash();
      const requestedRequirementId = requirementIdFromRoute();
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
      const linkedRequirement = taskData.tasks.find(task => task.id === requestedRequirementId && !isChildTask(task));
      const savedProject = visibleProjects.find(item => item.id === savedProjectId);
      const firstActiveJiraProject = visibleProjects.find(item => item.jira && taskData.tasks.some(task => task.projectId === item.id));
      const selectedProject = visibleProjects.find(item => item.id === linkedTask?.projectId) ||
        visibleProjects.find(item => item.id === preferredProjectId) ||
        visibleProjects.find(item => item.id === linkedRequirement?.projectId) ||
        savedProject ||
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
      setUser(me.user); setWorkbenchSupported(typeof me.workbench?.enabled === 'boolean' ? me.workbench.enabled : null); setPlatformPermissions(platformAccess); setProjects(currentProjects); setProjectId(selectedProject?.id || '');
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
    if (!user || !pageProjectId || pageProjectId === projectId || selectedTaskId) return;
    const owner = scopeRef.current;
    const isCurrent = () => mounted.current && scopeRef.current.section === owner.section &&
      scopeRef.current.projectId === owner.projectId && scopeRef.current.userId === owner.userId && !taskFromHash();
    void perform(() => refresh(pageProjectId, isCurrent));
  }, [section, user?.id, pageProjectId, projectId, selectedTaskId]);
  useEffect(() => {
    if (busy || syncingJira || syncingJiraChildren || !jiraTasksRefreshPending.current || !user) return;
    jiraTasksRefreshPending.current = false;
    void refreshTasksOnly().catch(handleError);
  }, [busy, syncingJira, syncingJiraChildren, user?.id]);
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
  useEffect(() => {
    void checkBuildUpdate(false);
    const checkOnReturn = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastVersionCheckAt.current < 5000) return;
      lastVersionCheckAt.current = now;
      void checkBuildUpdate(false);
    };
    window.addEventListener('focus', checkOnReturn);
    document.addEventListener('visibilitychange', checkOnReturn);
    return () => {
      window.removeEventListener('focus', checkOnReturn);
      document.removeEventListener('visibilitychange', checkOnReturn);
    };
  }, []);
  useEffect(() => { onSessionChange?.(!!user); }, [user?.id, onSessionChange]);
  const [workbenchSupported, setWorkbenchSupported] = useState<boolean | null>(null);
  const [workbenchMode, setWorkbenchMode] = useState<'server' | 'relay' | null>(null);
  const workbenchAvailable = !!workbenchMode;
  useEffect(() => {
    if (!user || workbenchSupported === false) { setWorkbenchMode(null); return; }
    let active = true;
    void api<{ url: string; online: boolean; mode?: 'server' | 'relay' }>('workbench/status').then(result => { if (active) setWorkbenchMode(result.mode === 'server' ? 'server' : 'relay'); }).catch(() => { if (active) setWorkbenchMode(null); });
    const params = new URLSearchParams(window.location.search);
    if (params.get('workbench') === '1') {
      const returnTo = params.get('return') || '/';
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      void api<{ url: string }>('workbench/codes', { return: returnTo }).then(result => { if (active) window.location.replace(result.url); }).catch(handleError);
    }
    return () => { active = false; };
  }, [user?.id, workbenchSupported]);
  const openWorkbench = () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    void api<{ url: string }>('workbench/codes', { return: '/' }).then(result => { if (tab) tab.location.replace(result.url); else window.location.assign(result.url); }).catch(error => { tab?.close(); handleError(error); });
  };
  useEffect(() => { closeCreateTask(); setIntakeOpen(false); setNewProjectOpen(false); }, [section]);
  useEffect(() => { closeCreateTask(); setIntakeOpen(false); setSelectedTaskIds([]); setSavedViews(readSavedTaskViews(projectId)); setSavingViewOpen(false); setSavingViewName(''); }, [projectId, user?.id]);
  useEffect(() => { setPreviewTaskId(''); }, [section, projectId, user?.id]);
  useEffect(() => { if (section !== 'tasks') setLegacyTaskList(false); }, [section]);
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
      if (selectedTaskId) {
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
      if (section !== 'tasks' && !reviewStage) return;
      if (event.key === '/') {
        event.preventDefault();
        taskSearchRef.current?.focus();
      } else if (legacyTaskList && event.key.toLowerCase() === 'v' && !event.shiftKey) {
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
  }, [user, section, selectedTaskId, legacyTaskList, reviewStage]);
  useEffect(() => { onAccessChange?.({ manageMembers: canManageAnyMembers, manageConnections: canManageAnyConnections }); }, [user?.id, canManageAnyMembers, canManageAnyConnections, onAccessChange]);
  useEffect(() => {
    const update = () => {
      const id = taskFromHash();
      const requirementId = requirementIdFromRoute() || '';
      if (requirementId !== lastRoutedRequirementId.current) {
        lastRoutedRequirementId.current = requirementId;
        setRequirementTaskId(requirementId);
        if (requirementId && !id) void perform(() => refresh(''));
      }
      if (!id) setTaskTrail([]);
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
    if (selectedTaskId) closeTaskDrawer();
    closeCreateTask(); resetFilters();
    if (requirementWorkspace && !destination && requirementIdFromRoute()) navigateWorkspace(section, { requirementId: '' });
    if (destination && PROJECT_FILTER_SECTIONS.has(destination)) setProjectFilters(filters => ({ ...filters, [destination]: id }));
    projectIdRef.current = id; setProjectId(id); setTasks(allTasks.filter(task => task.projectId === id)); setMembers([]); setCandidates([]);
    void perform(() => refresh(id));
    if (destination) navigateWorkspace(destination);
  };
  const selectPageProject = (id: string) => {
    setProjectFilters(filters => ({ ...filters, [section]: id }));
    setSelectedTaskIds([]);
    setTaskPage(1);
    setPreviewTaskId('');
    if (!id) { closeCreateTask(); setIntakeOpen(false); resetFilters(); return; }
    if (requirementWorkspace) {
      setRequirementTaskId('');
      setActiveRequirementId('');
    }
    switchProject(id);
  };
  const openCreateTask = () => { setIntakeEverOpened(true); setIntakeOpen(true); };
  const chooseRequirement = (task: WorkTask) => {
    lastRoutedRequirementId.current = task.id;
    setRequirementTaskId(task.id);
    navigateWorkspace(section, { requirementId: task.id });
  };
  const openNewProject = () => { setNewProjectEverOpened(true); setNewProjectOpen(true); };
  const openManualTask = () => {
    if (!pageProjectId || pageProjectId !== projectId) return;
    setIntakeOpen(false); taskCreateSequence.current += 1; taskForm.resetFields();
    taskForm.setFieldsValue({ type: 'TASK', assigneeId: members.some(member => member.id === user?.id) ? user?.id : undefined });
    setCreateOpen(true);
  };
  const createTask = (values: NewTaskValues) => {
    if (!createOpen || busy || pendingOperations.current > 0 || !pageProjectId || pageProjectId !== projectId || !user) return;
    if (values.parentId && !parentTaskOptions.some(option => option.value === values.parentId && !option.disabled)) {
      void message.error('请选择可用的主任务作为父任务。');
      return;
    }
    const request = ++taskCreateSequence.current;
    const requestRoute = location.hash;
    const isCurrent = () => mounted.current && request === taskCreateSequence.current && currentContext.current.userId === user.id && currentContext.current.projectId === projectId && currentContext.current.section === section && location.hash === requestRoute;
    return perform(async () => {
      try {
        const result = await api<{ task: WorkTask }>('tasks', { projectId, ...values, jiraKey: values.jiraKey?.trim() || undefined, parentId: values.parentId || null, ...(canAssign ? { assigneeId: values.assigneeId || null } : { assigneeId: user.id }) });
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
  const syncMyPersonalJiraProjects = async () => {
    if (!user || syncingPersonalJiraProjects) return;
    setSyncingPersonalJiraProjects(true);
    try {
      const listed = await listAccounts();
      if (!mounted.current) return;
      const personalJiras = listed.accounts.filter(item => item.scope === 'PERSONAL' && item.provider === 'jira' && item.enabled);
      if (!personalJiras.length) {
        void message.info('请先在「账号管理」绑定你的个人 Jira 账号，保存后会自动按你的 Jira 权限同步可见项目。');
        navigateWorkspace('accounts');
        return;
      }
      let joinedTotal = 0;
      let matchedTotal = 0;
      let unmatchedTotal = 0;
      let firstJoinedProjectId = '';
      for (const acc of personalJiras) {
        const res = await syncPersonalJiraProjects(acc.id, acc.version, true);
        joinedTotal += res.joinedCount;
        matchedTotal += res.matchedCount;
        unmatchedTotal += res.unmatchedRemoteCount;
        if (!firstJoinedProjectId && res.joinedProjects[0]?.id) firstJoinedProjectId = res.joinedProjects[0].id;
      }
      if (!mounted.current) return;
      const extra = unmatchedTotal > 0 ? `；另有 ${unmatchedTotal} 个远端 Jira 项目尚未由管理员同步到平台` : '';
      void message.success(joinedTotal > 0
        ? `已按你的 Jira 权限同步可见项目：新增 ${joinedTotal} 个，共匹配 ${matchedTotal} 个${extra}。`
        : `已按你的 Jira 权限校验：当前共匹配 ${matchedTotal} 个平台项目，无需新增${extra}。`);
      await refresh(firstJoinedProjectId || projectIdRef.current);
    } catch (error) {
      if (mounted.current) handleError(error);
    } finally {
      if (mounted.current) setSyncingPersonalJiraProjects(false);
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
        if (requirementsActive && !hiddenTaskIds.has(task.id)) {
          if (pageProjectId) setProjectFilters(filters => ({ ...filters, [section]: targetProjectId }));
          chooseRequirement(task);
        }
        else {
          openTaskRoute(task.id, { from: section });
          setSelectedTaskId(task.id);
        }
      }
    });
  };
  const hiddenTaskKey = user ? `taskflow.tasks.hidden.${user.id}` : '';
  const hiddenRoots = useMemo(() => {
    if (!hiddenTaskKey) return [];
    return hiddenTaskPreference?.key === hiddenTaskKey ? hiddenTaskPreference.ids : readStoredStringList(hiddenTaskKey);
  }, [hiddenTaskKey, hiddenTaskPreference]);
  const hiddenTaskIds = useMemo(() => {
    const ids = new Set(hiddenRoots);
    if (!ids.size) return ids;
    const childrenByParent = new Map<string, string[]>();
    for (const task of allTasks) {
      if (!task.parentId) continue;
      const siblings = childrenByParent.get(task.parentId) || [];
      siblings.push(task.id);
      childrenByParent.set(task.parentId, siblings);
    }
    // A Set iterator also visits IDs added during iteration.
    for (const parentId of ids) {
      for (const childId of childrenByParent.get(parentId) || []) ids.add(childId);
    }
    return ids;
  }, [hiddenRoots, allTasks]);
  const workspaceTasks = useMemo(() => allTasks.filter(task => !hiddenTaskIds.has(task.id)), [allTasks, hiddenTaskIds]);
  const workspaceMainTasks = useMemo(() => workspaceTasks.filter(task => !isChildTask(task)), [workspaceTasks]);
  const pageTaskRecords = useMemo(() => pageProjectId ? allTasks.filter(task => task.projectId === pageProjectId) : allTasks, [allTasks, pageProjectId]);
  const visibleProjectTasks = useMemo(() => pageTaskRecords.filter(task => !hiddenTaskIds.has(task.id)), [pageTaskRecords, hiddenTaskIds]);
  const hiddenProjectTasks = pageTaskRecords.filter(task => hiddenRoots.includes(task.id));
  const pageProjectReady = !!pageProjectId && pageProjectId === projectId;
  const allTaskProjects = !pageProjectId;
  const saveHiddenTasks = (ids: string[]) => {
    if (!hiddenTaskKey) return;
    writeStoredStringList(hiddenTaskKey, ids);
    setHiddenTaskPreference({ key: hiddenTaskKey, ids });
  };
  const hideTask = (task: WorkTask) => {
    saveHiddenTasks([task.id, ...hiddenRoots.filter(id => id !== task.id)].slice(0, 200));
    setSelectedTaskIds(ids => ids.filter(id => id !== task.id));
    if (selectedTaskId === task.id) closeTaskDrawer();
  };
  const mainTasks = visibleProjectTasks.filter(task => !isChildTask(task));
  const parentTaskOptions = mainTasks.filter(task => task.projectId === projectId).map(task => ({
    value: task.id,
    label: task.jiraKey + ' · ' + task.title + (task.status === 'DONE' ? ' · 已完成（需先重开）' : ''),
    disabled: task.status === 'DONE',
  }));
  const jiraTypes = [...new Set(mainTasks.map(task => task.externalRef?.type).filter((value): value is string => !!value))];
  const jiraStatuses = [...new Set(mainTasks.map(task => task.externalRef?.status).filter((value): value is string => !!value))];
  const jiraVersions = [...new Set(mainTasks.flatMap(task => task.externalRef?.fixVersions?.map(version => version.name) || []))];
  const filterCount = [statusFilter, jiraTypeFilter, jiraVersionFilter, jiraStatusFilter].filter(Boolean).length;
  const hasFilters = !!query || quickScope !== 'all' || filterCount > 0;
  const queryText = query.trim().toLowerCase();
  const matchesSearch = (task: TreeTaskRow): boolean => (
    (task.jiraKey + ' ' + task.title).toLowerCase().includes(queryText) || task.subtasks?.some(matchesSearch) === true
  );
  const searchedIds = queryText ? new Set(buildTaskTree(visibleProjectTasks).filter(matchesSearch).map(task => task.id)) : null;
  const myTaskCount = mainTasks.filter(task => task.assigneeId === user?.id && task.status !== 'DONE').length;
  const unclaimedCount = mainTasks.filter(task => !task.assigneeId && task.status !== 'DONE').length;
  const activeCount = mainTasks.filter(task => task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW').length;
  const doneCount = mainTasks.filter(task => task.status === 'DONE').length;
  const matchesQuickScope = (task: WorkTask): boolean => {
    if (quickScope === 'mine') return task.assigneeId === user?.id && task.status !== 'DONE';
    if (quickScope === 'unclaimed') return !task.assigneeId && task.status !== 'DONE';
    if (quickScope === 'active') return task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW';
    if (quickScope === 'done') return task.status === 'DONE';
    return true;
  };
  const visibleTasks = mainTasks.filter(task => matchesQuickScope(task) &&
    (!searchedIds || searchedIds.has(task.id)) &&
    (!statusFilter || task.status === statusFilter) && (!jiraTypeFilter || task.externalRef?.type === jiraTypeFilter) &&
    (!jiraStatusFilter || task.externalRef?.status === jiraStatusFilter) && (!jiraVersionFilter || task.externalRef?.fixVersions?.some(version => version.name === jiraVersionFilter)));
  const currentTaskPage = Math.min(taskPage, Math.max(1, Math.ceil(visibleTasks.length / TASK_PAGE_SIZE)));
  useEffect(() => { if (currentTaskPage !== taskPage) setTaskPage(currentTaskPage); }, [currentTaskPage, taskPage]);
  const firstTaskIndex = viewMode === 'list' ? (currentTaskPage - 1) * TASK_PAGE_SIZE : 0;
  const pageRows = viewMode === 'list' ? visibleTasks.slice(firstTaskIndex, firstTaskIndex + TASK_PAGE_SIZE) : visibleTasks;
  const pageTaskIds = new Set(pageRows.map(task => task.id));
  const previewTask = section === 'tasks' && pageProjectReady
    ? (pageTaskIds.has(previewTaskId) ? pageRows.find(task => task.id === previewTaskId) : pageRows[0])
    : undefined;
  const activeDrawerTask = selectedTaskId ? allTasks.find(item => item.id === selectedTaskId) : undefined;
  const requirementTask = requirementWorkspace
    ? mainTasks.find(task => task.id === activeRequirementId)
      || mainTasks.find(task => task.id === requirementTaskId)
      || mainTasks[0]
    : undefined;
  const activeTask = selectedTaskId ? activeDrawerTask : requirementWorkspace ? requirementTask : previewTask;
  const jiraParent = activeTask?.externalRef?.provider === 'jira' && !isChildTask(activeTask)
    ? activeTask
    : undefined;
  const parentJiraBinding = projects.find(item => item.id === jiraParent?.projectId)?.jira;
  const syncJiraChildren = async (task: WorkTask, notify = true) => {
    if (!user || childrenSyncInFlight.current || task.externalRef?.provider !== 'jira' || isChildTask(task)) return;
    childrenSyncInFlight.current = true;
    childrenSyncAttempted.current.add(user.id + ':' + task.id);
    setSyncingJiraChildren(task.id);
    const isCurrent = () => mounted.current && currentContext.current.userId === user.id;
    try {
      const result = await api<{ children: WorkTask[]; linkedCount: number; updatedCount: number; skippedChildren: { jiraKey: string; reason: string }[] }>('jira/tasks/sync-children', { taskId: task.id });
      if (!isCurrent()) return;
      if (result.linkedCount || result.updatedCount) {
        jiraTasksRefreshPending.current = true;
        setDetailRefreshTick(tick => tick + 1);
      }
      if (notify && result.skippedChildren.length) {
        const keys = result.skippedChildren.map(item => item.jiraKey).join('、');
        void message.warning(`已读取 ${result.children.length} 个关联子任务，未能关联 ${keys}。`);
      } else if (notify) {
        void message.success(`已读取 ${result.children.length} 个关联子任务。`);
      }
    } catch (error) {
      if (isCurrent() && (notify || error instanceof ApiError && error.status === 401)) handleError(error);
    } finally {
      childrenSyncInFlight.current = false;
      if (mounted.current) setSyncingJiraChildren('');
    }
  };
  useEffect(() => {
    if (!user || !jiraParent || !parentJiraBinding || busy || syncingJira || syncingJiraChildren ||
      childrenSyncAttempted.current.has(user.id + ':' + jiraParent.id)) return;
    void syncJiraChildren(jiraParent, false);
  }, [user?.id, jiraParent?.id, parentJiraBinding?.id, busy, syncingJira, syncingJiraChildren]);
  const mainTasksByProject = new Map<string, number>();
  for (const task of workspaceMainTasks) {
    mainTasksByProject.set(task.projectId, (mainTasksByProject.get(task.projectId) || 0) + 1);
  }
  const projectOptions = groups.map(group => ({
    label: group.name,
    options: projects.filter(item => projectGroup(item).id === group.id).map(item => ({ value: item.id, label: item.key + ' · ' + item.name + ' · ' + (mainTasksByProject.get(item.id) || 0) + ' 个主任务' })),
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
        if (selectedTaskId && res.deletedIds.includes(selectedTaskId)) closeTaskDrawer();
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
  const syncMyJiraTasks = async () => {
    if (jiraSyncInFlight.current) return;
    jiraSyncInFlight.current = true;
    setSyncingJira(true);
    const isCurrentUser = () => mounted.current && currentContext.current.userId === user.id;
    try {
      const res = await api<{
        identity: { displayName?: string; name?: string } | null;
        importedCount: number; updatedCount: number; removedCount: number; unassignedCount: number;
      }>('jira/tasks/sync-mine', {});
      if (!isCurrentUser()) return;
      jiraTasksRefreshPending.current = true;
      const parts = [
        res.importedCount ? `新接入 ${res.importedCount} 项` : '',
        res.updatedCount ? `更新 ${res.updatedCount} 项` : '',
        res.removedCount ? `清理非本人/已结项 ${res.removedCount} 项` : '',
        res.unassignedCount ? `解绑已转交任务 ${res.unassignedCount} 项` : '',
      ].filter(Boolean);
      const who = res.identity?.displayName || res.identity?.name || '';
      void message.success(parts.length ? `已按${who ? `「${who}」` : ''}最新 Jira 同步：${parts.join('，')}。` : `已按${who ? `「${who}」` : ''}最新 Jira 校验，当前待办已是最新。`);
    } catch (error) {
      if (isCurrentUser()) handleError(error);
    } finally {
      jiraSyncInFlight.current = false;
      if (mounted.current) setSyncingJira(false);
    }
  };
  const detailProps = {
    user, role: role ?? ('DEV' as const), permissions, members, tasks, allTasks, refreshTick: detailRefreshTick,
    onChanged: refreshTasksOnly, onUnauthorized: clearSession, onForbidden: reloadAccess,
    onSyncJiraChildren: project?.jira ? syncJiraChildren : undefined,
    syncingJiraChildren: !!syncingJiraChildren && syncingJiraChildren === activeTask?.id,
  };
  const pageMembers = pageProjectReady ? members : [];
  const projectKeys = new Map(projects.map(item => [item.id, item.key]));
  const openTaskInList = (id: string) => pageProjectReady ? setPreviewTaskId(id) : openTask(id);
  const taskPreview = previewTask && (
    <section key={previewTask.id} className="tf-task-preview" aria-label="任务详情">
      <Suspense fallback={<Skeleton active paragraph={{ rows: 4 }} />}>
        <WorkTaskDetail
          {...detailProps}
          embedded
          taskId={previewTask.id}
          onHideTask={() => hideTask(previewTask)}
          onOpenTask={id => {
            if (!id || pageTaskIds.has(id)) setPreviewTaskId(id);
            else openTask(id);
          }}
          onOpenFullScreen={(tab, jobId) => openTask(previewTask.id, { tab, jobId })}
        />
      </Suspense>
    </section>
  );
  const navTaskPool = visibleTasks.some(item => item.id === selectedTaskId) ? visibleTasks : mainTasks;
  const currentNavIndex = selectedTaskId ? navTaskPool.findIndex(item => item.id === selectedTaskId) : -1;
  const prevNavTask = currentNavIndex > 0 ? navTaskPool[currentNavIndex - 1] : undefined;
  const nextNavTask = currentNavIndex >= 0 && currentNavIndex < navTaskPool.length - 1 ? navTaskPool[currentNavIndex + 1] : undefined;
  const activeDrawerProject = activeDrawerTask ? projects.find(item => item.id === activeDrawerTask.projectId) : project;
  const prevTrailTask = taskTrail.length > 0 ? allTasks.find(item => item.id === taskTrail[taskTrail.length - 1]) : undefined;
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
      const nextMode: TaskViewMode = view.viewMode === 'board' ? 'board' : 'list';
      setViewMode(nextMode);
      writeStoredString(TASK_VIEW_MODE_KEY, nextMode);
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
    if (!name || !pageProjectReady) return;
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
    if (!pageProjectReady) return;
    const next = deleteSavedTaskView(projectId, view.id);
    setSavedViews(next);
    void message.info(`已移除视图「${view.name}」。`);
  };
  const refreshCurrentPage = () => void perform(async () => {
    if (await checkBuildUpdate(true)) return;
    if (selectedTaskId || previewTask) setDetailRefreshTick(tick => tick + 1);
    await refresh();
  });
  const logout = () => void perform(async () => { await api('logout', {}); clearSession(); });
  const accountActions = (
    <div className="tf-global-actions">
      <Button className="tf-global-search" icon={<Search size={15} />} aria-label="全局跳转" onClick={openQuickCommand}>
        <span className="tf-global-search-label">搜索任务或跳转</span><kbd>⌘ K</kbd>
      </Button>
      <Tooltip title="刷新"><Button type="text" icon={<RefreshCw size={16} />} aria-label="刷新" loading={busy} onClick={refreshCurrentPage} /></Tooltip>
      <Dropdown trigger={['click']} menu={{ items: [
        { key: 'shortcuts', label: '快捷键', icon: <Keyboard size={14} />, onClick: () => { setShortcutsEverOpened(true); setShortcutsOpen(true); } },
        ...(workbenchAvailable ? [{ key: 'workbench', label: '我的工作台', icon: <MonitorSmartphone size={14} />, onClick: openWorkbench }] : []),
        { key: 'password', label: '修改密码', icon: <KeyRound size={14} />, disabled: busy, onClick: () => setPasswordOpen(true) },
        { key: 'logout', label: '退出', icon: <LogOut size={14} />, disabled: busy, onClick: logout },
      ] }}>
        <Button type="text" className="tf-account-trigger" aria-label={`${user.username} · ${roleLabel(pageProject?.role || user.role)} · 账号操作`}>
          <span className="tf-account-avatar" aria-hidden="true">{Array.from(user.username)[0]?.toUpperCase()}</span>
          <span className="tf-global-account-name">{user.username}</span><ChevronDown size={13} aria-hidden="true" />
        </Button>
      </Dropdown>
    </div>
  );
  const taskList = <div className="tf-tasks-workspace">
    <div className="tf-task-controls">
    <div className="tf-tasks-topbar">
      <div className="tf-tasks-topbar-left">
        <Button type="text" icon={<ArrowLeft size={14} />} onClick={() => setLegacyTaskList(false)}>返回需求中心</Button>
        <Input
          ref={taskSearchRef}
          aria-label="搜索任务"
          prefix={<Search size={14} />}
          placeholder="搜索主任务或子任务 (/)"
          value={query}
          allowClear
          className="tf-tasks-search"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={clearSearchOnEscape(query, () => setQuery(''))}
        />
        <Select<QuickTaskScope>
          aria-label="任务范围筛选"
          value={quickScope}
          popupMatchSelectWidth={false}
          className="tf-tasks-scope-select"
          onChange={val => { setQuickScope(val); writeStoredString(TASK_SCOPE_KEY, val); }}
          options={[
            { value: 'all', label: `全部 (${mainTasks.length})` },
            { value: 'mine', label: `我负责 (${myTaskCount})` },
            { value: 'unclaimed', label: `待认领 (${unclaimedCount})` },
            { value: 'active', label: `推进中 (${activeCount})` },
            { value: 'done', label: `已完成 (${doneCount})` },
          ]}
        />
        {hasFilters && <Button type="text" size="small" onClick={resetFilters}>重置</Button>}
        {hiddenProjectTasks.length > 0 && (
          <Dropdown trigger={['click']} menu={{
            items: hiddenProjectTasks.map(task => ({
              key: task.id,
              label: `恢复显示 ${task.jiraKey} · ${task.title}`,
            })),
            onClick: ({ key }) => saveHiddenTasks(hiddenRoots.filter(id => id !== key)),
          }}>
            <Button>已隐藏 ({hiddenProjectTasks.length}) <ChevronDown size={13} /></Button>
          </Dropdown>
        )}
      </div>
      <div className="tf-tasks-topbar-right">
        <Segmented<TaskViewMode>
          aria-label="任务视图切换"
          value={viewMode}
          onChange={val => { setViewMode(val); writeStoredString(TASK_VIEW_MODE_KEY, val); }}
          options={[
            { value: 'list', label: <Space size={4}><List size={14} /><span>列表</span></Space> },
            { value: 'board', label: <Space size={4}><LayoutGrid size={14} /><span>看板</span></Space> },
          ]}
        />
        {hasBoundJira && <Button className="tf-task-jira-command" title="同步 Jira" aria-label="同步 Jira" icon={<RefreshCw size={14} />} loading={syncingJira} disabled={busy || syncingJira} onClick={() => void syncMyJiraTasks()}><span className="tf-task-jira-label">同步 Jira</span></Button>}
        {hasBoundJira && <Button className="tf-task-jira-command" title="接入 Jira" aria-label="接入 Jira" icon={<Link2 size={14} />} disabled={busy || !projectId} onClick={openCreateTask}><span className="tf-task-jira-label">接入 Jira</span></Button>}
        <Tooltip title={allTaskProjects ? '选择项目后新建任务' : undefined}><span>
          <Button type="primary" icon={<Plus size={15} />} disabled={!pageProjectReady || busy} onClick={openManualTask}>新建任务</Button>
        </span></Tooltip>
      </div>
    </div>

    <div className="tf-task-filters" role="group" aria-label="任务筛选">
      <Select aria-label="本地状态" placeholder="本地状态" allowClear value={statusFilter} options={TASK_STATUS_OPTIONS} onChange={setStatusFilter} />
      {jiraStatuses.length > 0 && <Select aria-label="Jira 状态" placeholder="Jira 状态" allowClear value={jiraStatusFilter} options={options(jiraStatuses)} onChange={setJiraStatusFilter} />}
      {jiraTypes.length > 0 && <Select aria-label="Jira 类型" placeholder="Jira 类型" allowClear value={jiraTypeFilter} options={options(jiraTypes)} onChange={setJiraTypeFilter} />}
      {jiraVersions.length > 0 && <Select aria-label="Jira 修复版本" placeholder="Jira 修复版本" showSearch={{ optionFilterProp: 'label' }} allowClear value={jiraVersionFilter} options={options(jiraVersions)} onChange={setJiraVersionFilter} />}
    </div>
    {pageProjectReady && (hasFilters || savingViewOpen || savedViews.length > 0) && (
      <div className="tf-task-saved-views">
        <Flex gap={8} align="center" wrap>
          {hasFilters && !savingViewOpen && (
            <Button size="small" icon={<Bookmark size={13} />} onClick={openSaveCurrentView}>
              保存当前筛选视图
            </Button>
          )}
          {savingViewOpen && (
            <>
              <Input
                size="small"
                aria-label="保存筛选视图名称"
                placeholder="输入视图名称"
                value={savingViewName}
                maxLength={40}
                style={{ width: 200 }}
                onChange={e => setSavingViewName(e.target.value)}
                onPressEnter={confirmSaveCurrentView}
              />
              <Button size="small" type="primary" disabled={!savingViewName.trim()} onClick={confirmSaveCurrentView}>保存</Button>
              <Button size="small" type="text" onClick={() => { setSavingViewOpen(false); setSavingViewName(''); }}>取消</Button>
            </>
          )}
          {savedViews.length > 0 && (
            <>
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
            </>
          )}
        </Flex>
      </div>
    )}

    </div>

    {viewMode === 'board' ? (
      <div className="tf-task-work-area tf-task-board-layout">
        <div className="tf-tasks-surface tf-task-board-surface">
          <Suspense fallback={<Skeleton active paragraph={{ rows: 4 }} />}>
            <TaskKanbanBoard
              tasks={visibleTasks}
              allTasks={allTasks}
              members={pageMembers}
              userId={user.id}
              canAssign={canAssign}
              isProjectMember={isProjectMember}
              readOnly={!pageProjectReady}
              projectKeys={allTaskProjects ? projectKeys : undefined}
              busy={busy}
              updatingTaskId={updatingTaskId}
              onOpenTask={openTaskInList}
              activeTaskId={previewTask?.id}
              onMoveStatus={(target, nextStatus) => void switchTaskStatusInline(target, nextStatus)}
              onClaimTask={target => void claimTaskQuick(target)}
            />
          </Suspense>
        </div>
        {taskPreview}
      </div>
    ) : (
      <div className={`tf-task-work-area${previewTask ? ' tf-tasks-with-preview' : ''}`}>
        <div className="tf-tasks-surface tf-task-list-surface" role="region" aria-label="任务列表">
          <TaskListTable
            tasks={visibleTasks}
            projectTasks={pageTaskRecords}
            allTasks={allTasks}
            members={pageMembers}
            userId={user.id}
            canAssign={canAssign}
            isProjectMember={isProjectMember}
            readOnly={!pageProjectReady}
            projectKeys={allTaskProjects ? projectKeys : undefined}
            busy={busy}
            updatingTaskId={updatingTaskId}
            page={currentTaskPage}
            onPageChange={setTaskPage}
            selectedIds={selectedTaskIds}
            onSelectionChange={setSelectedTaskIds}
            onOpenTask={openTaskInList}
            activeTaskId={previewTask?.id}
            compact={!!previewTask}
            onSwitchStatus={(target, nextStatus) => void switchTaskStatusInline(target, nextStatus)}
            onSwitchAssignee={(target, assigneeId) => void switchTaskAssigneeInline(target, assigneeId)}
            onClaim={target => void claimTaskQuick(target)}
            onRemove={confirmRemoveTask}
            onBatchClaim={targets => void batchClaimSelected(targets)}
            onBatchStatus={(targets, nextStatus) => void batchSwitchStatus(targets, nextStatus)}
            onBatchAssign={(targets, assigneeId) => void batchAssignSelected(targets, assigneeId)}
          />
        </div>
        {taskPreview}
      </div>
    )}
  </div>;
  let content: React.ReactNode;
  if (section === 'overview') content = <WorkspaceOverview projects={projects} tasks={workspaceMainTasks} user={user} onUnauthorized={clearSession} onSyncJira={hasBoundJira ? () => void syncMyJiraTasks() : undefined} syncingJira={syncingJira} onApproved={() => void refreshTasksOnly()} openDigestTick={digestTick} />;
  else if (section === 'projects') content = <ProjectDirectory projects={projects} tasks={workspaceMainTasks} onOpen={switchProject} onUnauthorized={clearSession} onCreate={platformPermissions.createProjects ? openNewProject : undefined} onSyncJiraProjects={() => void syncMyPersonalJiraProjects()} syncingJiraProjects={syncingPersonalJiraProjects} onProjectRenamed={updated => setProjects(prev => prev.map(item => item.id === updated.id ? { ...item, name: updated.name } : item))} onProjectDeleted={async deletedId => {
    if (user) {
      try {
        if (sessionStorage.getItem('taskflow.project.' + user.id) === deletedId) sessionStorage.removeItem('taskflow.project.' + user.id);
      } catch { /* UI preference storage is optional. */ }
    }
    const nextPreferred = projectIdRef.current === deletedId ? '' : projectIdRef.current;
    await refresh(nextPreferred);
  }} />;
  else if (section === 'reviews') content = <Suspense fallback={routeFallback}><ReviewCenter projectId={pageProjectId} projects={projects} tasks={pageTaskRecords} user={user} onChanged={refreshTasksOnly} onBeforeRefresh={() => checkBuildUpdate(true)} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'assets') content = <Suspense fallback={routeFallback}><AssetCenter projectId={pageProjectId} projects={projects} tasks={pageTaskRecords} onChanged={refreshTasksOnly} onBeforeRefresh={() => checkBuildUpdate(true)} onUnauthorized={clearSession} /></Suspense>;
  else if (!pageProject && (section === 'members' || section === 'connections')) content = <Suspense fallback={routeFallback}>
    <ProjectSettingsOverview key={section + ':' + user.id} section={section} userId={user.id} projects={projects} onPickProject={selectPageProject} onUnauthorized={clearSession} />
  </Suspense>;
  else if (section === 'members') content = pageProject && pageProjectReady ? <Suspense fallback={routeFallback}>
    <MembersAccessView key={pageProjectId} projectId={pageProjectId} projectKey={pageProject.key} user={user} role={pageProject.role} members={members} users={users} tasks={pageTaskRecords} candidates={candidates} permissions={permissions} canManageUsers={platformPermissions.manageUsers} onChanged={() => refresh(pageProjectId)} onUnauthorized={clearSession} onForbidden={reloadAccess} />
  </Suspense> : routeFallback;
  else if (section === 'connections') content = pageProject ? <Suspense fallback={routeFallback}>
    <ConnectionsView projectId={pageProjectId} project={pageProject} projects={projects} role={pageProject.role} user={user} platformPermissions={platformPermissions} onUnauthorized={clearSession} onForbidden={reloadAccess} onProjectsChanged={async id => {
      if (id) setProjectFilters(filters => ({ ...filters, connections: id }));
      await refresh(id || pageProjectId);
    }} />
  </Suspense> : routeFallback;
  else if (section === 'todos') content = <Suspense fallback={routeFallback}><TeamTodosView key={user.id} user={user} projects={projects} projectId={pageProjectId} members={pageMembers} tasks={pageTaskRecords} canAssign={pageProject?.permissions?.assignTasks === true} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'reports') content = <Suspense fallback={routeFallback}><WorkReportsView key={user.id} user={user} projects={projects} projectId={pageProjectId} members={pageMembers} canViewOthers={pageProject?.permissions?.assignTasks === true} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'sessions') content = <Suspense fallback={routeFallback}><AgentSessionsView key={user.id} user={user} projects={projects} projectId={pageProjectId} tasks={pageTaskRecords} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'deployments') content = <Suspense fallback={routeFallback}><DeploymentsView key={user.id} user={user} projectId={pageProjectId} projects={projects} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'knowledge') content = <Suspense fallback={routeFallback}><KnowledgeView key={user.id} user={user} projectId={pageProjectId} projects={projects} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'skills') content = <Suspense fallback={routeFallback}><TeamSkillsView key={user.id} user={user} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'local') content = <Suspense fallback={routeFallback}><LocalIntegrationView user={user} onUnauthorized={clearSession} /></Suspense>;
  else if (section === 'accounts') content = <Suspense fallback={routeFallback}><AccountsView user={user} project={pageProject} projects={projects} onPickProject={selectPageProject} onUnauthorized={clearSession} onForbidden={reloadAccess} onChanged={() => refresh()} /></Suspense>;
  else if (reviewStage) content = <Suspense fallback={routeFallback}>
    <RequirementsCenter
      section={section}
      reviewStage={reviewStage}
      projectId={pageProjectId}
      tasks={visibleProjectTasks}
      projects={projects}
      user={user}
      preferredTaskId={requirementTaskId}
      searchInputRef={taskSearchRef}
      onSelectTask={task => setActiveRequirementId(task.id)}
      onChooseTask={chooseRequirement}
      onIntake={requirementsActive && (project?.jira || hasBoundJira) ? openCreateTask : undefined}
      onShowTaskList={requirementsActive ? () => setLegacyTaskList(true) : undefined}
      onChanged={refreshTasksOnly}
      onUnauthorized={clearSession}
      onForbidden={reloadAccess}
    />
  </Suspense>;
  else content = taskList;

  return <div className={`workspace-content tf-workbench${section === 'tasks' || reviewStage ? ' tf-workbench--tasks' : section === 'assets' ? ' tf-workbench--reader' : ''}`}>
    <div className="tf-page-heading tf-module-heading">
      <Title level={1}>{heading}</Title>
      {scoped && <div className="tf-page-project">
        <span aria-hidden="true">项目</span>
          <Select
            aria-label="当前项目"
            showSearch={{ optionFilterProp: 'label' }}
            value={pageProjectId || 'all'}
            disabled={busy || !projects.length}
            options={[{ value: 'all', label: '全部项目' }, ...projectOptions]}
            onChange={id => selectPageProject(id === 'all' ? '' : id)}
            placeholder="选择项目"
            className="tf-inline-project-select"
          />
      </div>}
      {headerActions ? createPortal(accountActions, headerActions) : accountActions}
    </div>
    {buildUpdate && (
      <Alert
        type="info"
        showIcon
        closable
        onClose={() => setBuildUpdate(null)}
        style={{ marginBottom: 12 }}
        title={`检测到本地工作台已更新${buildUpdate.commit ? `（${buildUpdate.commit.slice(0, 7)}）` : ''}，当前页签仍在运行旧版界面，请点击立即刷新。`}
        action={<Button size="small" type="primary" onClick={() => window.location.reload()}>立即刷新页面</Button>}
      />
    )}
    {content}
    <Drawer
      open={!!selectedTaskId}
      placement="right"
      size="min(1120px, 94vw)"
      push={false}
      destroyOnHidden
      className="tf-global-task-drawer"
      onClose={closeTaskDrawer}
      styles={{
        header: { padding: '10px 18px' },
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
      title={
        <Space size={8} wrap align="center" className="tf-task-drawer-titlebar">
          {prevTrailTask && (
            <Button size="small" type="text" icon={<ArrowLeft size={14} />} onClick={goBackTaskTrail}>
              返回 {prevTrailTask.jiraKey}
            </Button>
          )}
          {activeDrawerTask && <Text code style={{ margin: 0 }}>{activeDrawerTask.jiraKey}</Text>}
          {activeDrawerProject && <Text type="secondary" style={{ fontSize: 12.5 }}>{activeDrawerProject.key} · {activeDrawerProject.name}</Text>}
          {navTaskPool.length > 1 && currentNavIndex >= 0 && (
            <Space size={2}>
              <Tooltip title={prevNavTask ? `上一项：${prevNavTask.jiraKey} ${prevNavTask.title} ([)` : '已是第一项'}>
                <Button type="text" size="small" icon={<ChevronLeft size={15} />} aria-label="上一项任务" disabled={busy || !prevNavTask} onClick={() => prevNavTask && openTask(prevNavTask.id)} />
              </Tooltip>
              <Text type="secondary" style={{ fontSize: 12 }}>{currentNavIndex + 1} / {navTaskPool.length}</Text>
              <Tooltip title={nextNavTask ? `下一项：${nextNavTask.jiraKey} ${nextNavTask.title} (])` : '已是最后一项'}>
                <Button type="text" size="small" icon={<ChevronRight size={15} />} aria-label="下一项任务" disabled={busy || !nextNavTask} onClick={() => nextNavTask && openTask(nextNavTask.id)} />
              </Tooltip>
            </Space>
          )}
        </Space>
      }
      extra={
        <Tooltip title="刷新当前任务详情">
          <Button
            size="small"
            type="text"
            icon={<RefreshCw size={14} />}
            loading={busy}
            onClick={() => void perform(async () => {
              if (await checkBuildUpdate(true)) return;
              setDetailRefreshTick(tick => tick + 1);
              await refresh();
            })}
          >
            刷新
          </Button>
        </Tooltip>
      }
    >
      {selectedTaskId && (tasks.some(task => task.id === selectedTaskId) ? (
        <Suspense fallback={<div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 8 }} /></div>}>
          <WorkTaskDetail
            {...detailProps}
            inDrawer
            key={selectedTaskId}
            taskId={selectedTaskId}
            onHideTask={activeDrawerTask && !isChildTask(activeDrawerTask) && !hiddenTaskIds.has(activeDrawerTask.id) ? () => hideTask(activeDrawerTask) : undefined}
            onOpenTask={id => openTask(id, undefined, { pushTrail: true })}
          />
        </Suspense>
      ) : (
        <div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 8 }} /></div>
      ))}
    </Drawer>
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
          tasks={workspaceTasks}
          projects={projects}
          currentProjectId={pageProjectId}
          currentUserId={user.id}
          canIntake={!!projectId && !busy}
          canSyncJira={hasBoundJira && !busy && !syncingJira}
          onClose={() => setQuickOpen(false)}
          onSelectTask={jumpToTaskFromCommand}
          onSelectProject={id => scoped ? selectPageProject(id) : switchProject(id, 'tasks')}
          onSelectSection={nextSection => navigateWorkspace(nextSection, { requirementId: requirementIdFromRoute() })}
          onTriggerAction={act => {
            if (act === 'intake') openCreateTask();
            else if (act === 'sync-jira') void syncMyJiraTasks();
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
        <JiraTaskIntake open={intakeOpen} user={user} projects={projects} existingTasks={allTasks} initialProjectId={pageProjectId || requirementTask?.projectId || projectId} requirementOnly={requirementsActive} onClose={() => setIntakeOpen(false)} onManual={pageProjectReady ? openManualTask : undefined} onImported={taskImported} onUnauthorized={clearSession} onForbidden={reloadAccess} />
      </Suspense>
    )}
    <Drawer forceRender title="新建本地任务" open={createOpen} onClose={closeCreateTask} closable={!busy} maskClosable={!busy} keyboard={!busy} size={640} className="tf-task-drawer" footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeCreateTask}>取消</Button><Button type="primary" loading={busy} disabled={!projectId} onClick={() => taskForm.submit()}>创建任务</Button></Flex>}>
      <Form name="new-local-task" form={taskForm} layout="vertical" initialValues={{ type: 'TASK', assigneeId: members.some(member => member.id === user.id) ? user.id : undefined }} disabled={busy} onFinish={values => void createTask(values)} onKeyDown={event => { if (isSubmitShortcut(event) && !busy && projectId) { event.preventDefault(); taskForm.submit(); } }}>
        <div className="tf-form-two-columns"><Form.Item label="任务类型" name="type" rules={[{ required: true }]}><Select options={TASK_TYPE_OPTIONS} /></Form.Item><Form.Item htmlFor="service-jira-key" label="Jira 任务号（可选）" name="jiraKey" rules={[{ pattern: /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/, message: '请输入有效的 Jira 任务号。' }]}><Input id="service-jira-key" maxLength={48} placeholder={(project?.jira?.key || 'PROJ') + '-100'} /></Form.Item></div>
        <Form.Item htmlFor="service-task-title" label="任务标题" name="title" rules={[{ required: true, whitespace: true, message: '请输入任务标题。' }]}><Input id="service-task-title" maxLength={200} /></Form.Item>
        <Form.Item label="父任务（可选）" name="parentId"><Select placeholder="选择主任务" allowClear showSearch={{ optionFilterProp: 'label' }} options={parentTaskOptions} /></Form.Item>
        <Form.Item label="受理人" name="assigneeId"><Select placeholder="未指派" allowClear disabled={busy || !canAssign} options={members.map(member => ({ value: member.id, label: member.username }))} /></Form.Item>
      </Form>
    </Drawer>
  </div>;
};

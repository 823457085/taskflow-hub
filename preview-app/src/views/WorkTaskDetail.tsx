import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Collapse, Descriptions, Drawer, Dropdown, Flex, Form, Grid, Input, Progress, Segmented, Select, Skeleton, Space, Spin, Steps, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { DescriptionsProps, MenuProps, TableColumnsType } from 'antd';
import { Check, CheckCircle2, ChevronDown, ClipboardPaste, Copy, ExternalLink, FileCheck2, FileText, FolderGit2, FolderOpen, GitBranch, Laptop, Link2, MoreHorizontal, Package, Pencil, RefreshCw, Sparkles, Terminal, Trash2, X } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import {
  api, ApiError, APPROVE_ROLES, ASSET_ROLES, Asset, AssetKind, CodeupMrItem, ConnectorSummary, ExecutionMode,
  Gates, LocalAiRun, LocalGitRepo, memberName, ProgressEvent, ProjectGitStatus, ProjectPermissions, ProjectWorkspace,
  REVIEW_ROLES, REVIEW_STAGE_OPTIONS, ReviewJob, Role, Stage, GateStage, STAGES, TaskContext, TaskDetailBundle, TaskStatus, timeText, User, WorkTask,
} from './workspaceApi';
import { Empty } from './WorkspaceFields';
import { TaskMergeRequests } from './TaskMergeRequests';
import type { LocalTaskMode } from './localTaskWorkflowPrompt';
import { parseSourceReference, type SourceProvider } from './sourceReference';
import {
  buildAssetTemplate, buildClipboardGitCommand, detectPastedReference,
  extractTaskSmartHints, formatJiraTaskAsMarkdown,
} from './taskSmartLinks';
import { TASK_PANELS, type TaskPanel } from './workspaceNavigation';
import { canQuickApproveReview } from './taskAvailability';
import {
  assetKindLabel, DEFAULT_APPROVE_REASON, executionModeLabel, gateStatusLabel,
  gitBranchLabel, mrStateLabel, reviewStatusLabel,
  stageLabel, TASK_STATUS_OPTIONS, taskStatusLabel, taskTypeLabel,
} from './displayLabels';
import { isEditableTarget, isSubmitShortcut } from './uiPreferences';
import { synthesizeTestSuiteFromSpecs } from './specToTestSuite';
import { TaskActivityPanel } from './TaskActivityPanel';
import { TaskAssetList } from './TaskAssetList';
import { TaskReleasePanel } from './TaskReleasePanel';
import { TaskSmartLinksCard } from './TaskSmartLinksCard';
import { TaskChainPanel } from './TaskChainPanel';
import type { ChainLink, ChainNextAction } from './workspaceApi';
import './WorkTaskDetail.css';

const ReviewDetail = lazy(() => import('./ReviewDetail').then(mod => ({ default: mod.ReviewDetail })));
const LocalTaskWorkflow = lazy(() => import('./LocalTaskWorkflow').then(mod => ({ default: mod.LocalTaskWorkflow })));
const TaskContextPackModal = lazy(() => import('./TaskContextPackModal').then(mod => ({ default: mod.TaskContextPackModal })));
const SubtaskDecomposeModal = lazy(() => import('./SubtaskDecomposeModal').then(mod => ({ default: mod.SubtaskDecomposeModal })));
const GitHandoffModal = lazy(() => import('./GitHandoffModal').then(mod => ({ default: mod.GitHandoffModal })));

interface TaskDraft { title: string; status: TaskStatus; assigneeId: string }
interface AssetDraft { kind: AssetKind; logicalKey?: string; title: string; content: string; sourceUrl?: string }
interface ReviewDraft { stage: Stage; executionMode: ExecutionMode }
type AssetInputMode = 'link' | 'git' | 'manual';

const STAGE_ASSET: Record<GateStage, AssetKind> = {
  PRD: 'PRD',
  TECH_SPEC: 'TECH_SPEC',
  CODE_REVIEW: 'CODE',
  TEST_CASE: 'TEST_CASE',
  RELEASE: 'RELEASE_PLAN',
};

export const WorkTaskDetail: React.FC<{
  taskId: string; user: User; role: Role; permissions: ProjectPermissions; members: User[]; tasks: WorkTask[]; allTasks?: WorkTask[];
  onOpenTask: (id: string) => void; onChanged: () => Promise<void>; onUnauthorized: () => void; onForbidden?: () => void;
}> = ({ taskId, user, role, permissions, members, tasks, allTasks, onOpenTask, onChanged, onUnauthorized, onForbidden }) => {
  const { message, modal } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [task, setTask] = useState<WorkTask | null>(null);
  const [context, setContext] = useState<TaskContext | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetBasisId, setAssetBasisId] = useState('');
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [gates, setGates] = useState<Gates | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [repositories, setRepositories] = useState<LocalGitRepo[]>([]);
  const [gitStatus, setGitStatus] = useState<ProjectGitStatus | null>(null);
  const [aiRuns, setAiRuns] = useState<LocalAiRun[]>([]);

  const [assetInputMode, setAssetInputMode] = useState<AssetInputMode>('manual');
  const [linkInput, setLinkInput] = useState('');
  const [linkKind, setLinkKind] = useState<AssetKind>('PRD');
  const [gitSourceMode, setGitSourceMode] = useState<'auto' | 'working' | 'head' | 'commit'>('auto');
  const [gitCommitSha, setGitCommitSha] = useState('');
  const [gitTitle, setGitTitle] = useState('');
  const [codeupMrs, setCodeupMrs] = useState<CodeupMrItem[]>([]);
  const [loadingCodeupMrs, setLoadingCodeupMrs] = useState(false);

  const readRoute = () => {
    const route = new URLSearchParams(location.hash.slice(1));
    if (route.get('task') !== taskId) return { tab: 'chain' as TaskPanel, job: '' };
    const requestedTab = route.get('tab');
    return {
      tab: ((TASK_PANELS as readonly string[]).includes(requestedTab || '') ? requestedTab : route.has('job') ? 'reviews' : 'chain') as TaskPanel,
      job: route.get('job') || '',
    };
  };
  const [tab, setTab] = useState<TaskPanel>(() => readRoute().tab);
  const [busy, setBusy] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState(() => readRoute().job);
  const [drawer, setDrawer] = useState<'task' | 'asset' | 'review' | null>(null);
  const [localWorkflowOpen, setLocalWorkflowOpen] = useState(false);
  const [localWorkflowEverOpened, setLocalWorkflowEverOpened] = useState(false);
  const [contextPackOpen, setContextPackOpen] = useState(false);
  const [contextPackEverOpened, setContextPackEverOpened] = useState(false);
  const [decomposeOpen, setDecomposeOpen] = useState(false);
  const [decomposeEverOpened, setDecomposeEverOpened] = useState(false);
  const [gitHandoffOpen, setGitHandoffOpen] = useState(false);
  const [gitHandoffEverOpened, setGitHandoffEverOpened] = useState(false);
  const [workflowInit, setWorkflowInit] = useState<{ mode?: LocalTaskMode; stage?: Stage; jobId?: string; runner?: 'local' | 'workbench' }>({});
  const [accessDenied, setAccessDenied] = useState(false);
  const [chainReviewJobId, setChainReviewJobId] = useState('');

  const [taskForm] = Form.useForm<TaskDraft>();
  const [assetForm] = Form.useForm<AssetDraft>();
  const [reviewForm] = Form.useForm<ReviewDraft>();
  const panelRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const accessLost = useRef(false);
  const refreshSequence = useRef(0);
  const actionSequence = useRef(0);
  const actionInFlight = useRef(false);
  const taskEditVersion = useRef(0);
  const stopActivity = useRef<(() => void) | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<'panel' | 'review' | null>(null);

  const clearSensitiveState = () => {
    accessLost.current = true; refreshSequence.current += 1; stopActivity.current?.();
    setAccessDenied(true); setTask(null); setContext(null); setAssets([]); setJobs([]); setGates(null);
    setConnectors([]); setRepositories([]); setGitStatus(null); setAiRuns([]); setCodeupMrs([]);
    setSelectedJobId(''); setDrawer(null); setLocalWorkflowOpen(false); setContextPackOpen(false); setGitHandoffOpen(false); setAssetBasisId(''); setNavigationTarget(null); setBusy(false);
    taskForm.resetFields(); assetForm.resetFields(); reviewForm.resetFields();
  };
  const handleForbidden = () => {
    if (accessLost.current || !mounted.current) return;
    clearSensitiveState();
    if (onForbidden) onForbidden();
    else {
      location.hash = 'view=tasks';
      void onChanged().catch(error => {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        void message.error(error instanceof Error ? error.message : '请求失败。');
      });
    }
  };
  const updateRoute = (next: TaskPanel, jobId?: string) => {
    if (accessLost.current || !mounted.current) return;
    const route = new URLSearchParams(location.hash.slice(1));
    if (route.get('task') !== taskId) return;
    if (!route.has('view')) route.set('view', 'tasks');
    route.set('task', taskId); route.set('tab', next);
    if (jobId !== undefined) { if (jobId) route.set('job', jobId); else route.delete('job'); }
    if (route.toString() !== location.hash.slice(1)) location.hash = route.toString();
  };
  const changeTab = (next: string) => { setTab(next as TaskPanel); updateRoute(next as TaskPanel); setNavigationTarget('panel'); };
  const openReview = (id: string) => { setSelectedJobId(id); setTab('reviews'); updateRoute('reviews', id); setNavigationTarget('review'); };

  const openLocalWorkflow = (init: { mode?: LocalTaskMode; stage?: Stage; jobId?: string; runner?: 'local' | 'workbench' } = {}) => {
    setWorkflowInit(init);
    setLocalWorkflowEverOpened(true);
    setLocalWorkflowOpen(true);
  };

  useEffect(() => {
    const update = () => { const route = readRoute(); setTab(route.tab); setSelectedJobId(route.job); };
    update(); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [taskId]);

  useEffect(() => {
    if (!navigationTarget) return;
    const target = navigationTarget === 'review' ? document.getElementById('workspace-review-detail') : panelRef.current;
    target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    setNavigationTarget(null);
  }, [navigationTarget, tab, selectedJobId]);

  const children = tasks.filter(item => item.parentId === taskId);
  const doneAncestor = (() => {
    const seen = new Set<string>(); let parent = tasks.find(item => item.id === task?.parentId);
    while (parent && !seen.has(parent.id)) {
      if (parent.status === 'DONE') return parent;
      seen.add(parent.id); parent = tasks.find(item => item.id === parent?.parentId);
    }
    return undefined;
  })();

  const canAssign = permissions.assignTasks;
  const canEdit = canAssign || task?.assigneeId === user.id;
  const canClaim = !!task && task.status !== 'DONE' && !task.assigneeId && !doneAncestor;
  const allowedKinds = (Object.keys(ASSET_ROLES) as AssetKind[]).filter(value => ASSET_ROLES[value].includes(role));
  const latestAssets = assets.filter(asset => allowedKinds.includes(asset.kind) && !assets.some(other => other.kind === asset.kind && other.logicalKey === asset.logicalKey && other.revision > asset.revision));
  const assetBasis = assets.find(asset => asset.id === assetBasisId && allowedKinds.includes(asset.kind));
  const assetChoices = assetBasis && !latestAssets.some(asset => asset.id === assetBasis.id) ? [assetBasis, ...latestAssets] : latestAssets;
  const allowedStages = STAGES.filter(value => REVIEW_ROLES[value.value].includes(role));
  const allowedReviewStages = REVIEW_STAGE_OPTIONS.filter(value => REVIEW_ROLES[value.value].includes(role));
  const canComplete = gates?.overall === 'PASS' && children.every(item => item.status === 'DONE');
  const inputsFrozen = task?.status === 'DONE' || !!doneAncestor;

  useEffect(() => { setLocalWorkflowOpen(false); setEditingTitle(false); }, [taskId, user.id, role, canEdit, inputsFrozen]);
  const selectedJob = jobs.find(job => job.id === selectedJobId && job.taskId === taskId && job.projectId === task?.projectId);

  const loadSupplementary = (projectId: string, currentTaskId: string, seq: number) => {
    void Promise.allSettled([
      api<{ connectors: ConnectorSummary[] }>(`connectors?projectId=${encodeURIComponent(projectId)}`),
      api<{ repositories: LocalGitRepo[] }>('local-git/repositories'),
      api<ProjectGitStatus>(`projects/${encodeURIComponent(projectId)}/git-status`),
      api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(currentTaskId)}/ai-runs`),
    ]).then(([connRes, repoRes, gitRes, runRes]) => {
      if (accessLost.current || !mounted.current || seq !== refreshSequence.current) return;
      if (connRes.status === 'fulfilled') setConnectors(connRes.value.connectors || []);
      if (repoRes.status === 'fulfilled') setRepositories(repoRes.value.repositories || []);
      if (gitRes.status === 'fulfilled') setGitStatus(gitRes.value);
      if (runRes.status === 'fulfilled') setAiRuns(runRes.value.runs || []);
    });
  };

  const refresh = async () => {
    if (accessLost.current || !mounted.current) return;
    setGates(null);
    const sequence = ++refreshSequence.current;
    const bundle = await api<TaskDetailBundle>('tasks/' + encodeURIComponent(taskId) + '/bundle');
    if (accessLost.current || !mounted.current || sequence !== refreshSequence.current) return;
    setTask(bundle.task); setContext(bundle.context); setAssets(bundle.assets); setGates(bundle.gates); setJobs(bundle.jobs);
    loadSupplementary(bundle.task.projectId, taskId, sequence);
  };

  const run = async (action: () => Promise<void>, mutation = false) => {
    if (accessLost.current || !mounted.current || actionInFlight.current) return;
    if (mutation) actionInFlight.current = true;
    const sequence = ++actionSequence.current;
    setBusy(true);
    try { await action(); }
    catch (error) {
      if (accessLost.current || !mounted.current || sequence !== actionSequence.current) return;
      void message.error(error instanceof Error ? error.message : '请求失败。');
      if (error instanceof ApiError && error.status === 403) handleForbidden();
      else if (error instanceof ApiError && error.status === 401) { clearSensitiveState(); onUnauthorized(); }
    } finally { if (mutation) actionInFlight.current = false; if (mounted.current && !accessLost.current && sequence === actionSequence.current) setBusy(false); }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshSequence.current += 1; actionSequence.current += 1; stopActivity.current?.(); };
  }, []);

  useEffect(() => { void run(refresh); }, [taskId]);

  useEffect(() => {
    if (task && drawer !== 'task') taskForm.setFieldsValue({ title: task.title, status: task.status, assigneeId: task.assigneeId || '' });
  }, [task?.version, drawer]);

  useEffect(() => {
    if (tab !== 'activity' || accessDenied) return;
    let active = true; let sequence = 0; let lastError = '';
    const refreshActivity = async () => {
      if (document.visibilityState !== 'visible' || accessLost.current || !mounted.current) return;
      const request = ++sequence;
      try {
        const [next, runRes] = await Promise.all([
          api<TaskContext>('tasks/' + taskId + '/context'),
          api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(taskId)}/ai-runs`).catch(() => ({ runs: [] as LocalAiRun[] })),
        ]);
        if (!active || accessLost.current || !mounted.current || request !== sequence) return;
        setContext(next);
        setAiRuns(runRes.runs);
        setTask(current => current?.id === next.task.id ? { ...current, progress: next.task.progress, lastSummary: next.task.lastSummary, updatedAt: next.task.updatedAt } : current);
        lastError = '';
      } catch (error) {
        if (!active || accessLost.current || !mounted.current || request !== sequence) return;
        const text = error instanceof Error ? error.message : '请求失败。';
        if (text !== lastError) void message.error(text);
        lastError = text;
        if (error instanceof ApiError && error.status === 403) handleForbidden();
        else if (error instanceof ApiError && error.status === 401) { clearSensitiveState(); onUnauthorized(); }
      }
    };
    const update = () => { void refreshActivity(); };
    update(); const interval = window.setInterval(update, 10_000);
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    const stop = () => { active = false; sequence++; window.clearInterval(interval); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
    stopActivity.current = stop;
    return () => { stop(); if (stopActivity.current === stop) stopActivity.current = null; };
  }, [tab, taskId, onUnauthorized, accessDenied]);

  const changed = async () => {
    setGates(null);
    await refresh();
    if (accessLost.current || !mounted.current) throw new DOMException('', 'AbortError');
    await onChanged();
    if (accessLost.current || !mounted.current) throw new DOMException('', 'AbortError');
  };

  const closeDrawer = () => {
    if (drawer === 'task') taskForm.resetFields();
    if (drawer === 'asset') {
      assetForm.resetFields();
      setAssetBasisId('');
      setLinkInput('');
      setGitTitle('');
      setGitCommitSha('');
    }
    if (drawer === 'review') reviewForm.resetFields();
    setDrawer(null);
  };

  const openAssetDrawer = (options?: { mode?: AssetInputMode; kind?: AssetKind; template?: boolean }) => {
    if (busy || !task || !allowedKinds.length) return;
    const defaultMissingKind = allowedKinds.find(k => !assets.some(a => a.kind === k)) || allowedKinds[0];
    const chosenKind = options?.kind && allowedKinds.includes(options.kind) ? options.kind : defaultMissingKind;
    setAssetBasisId('');
    setLinkInput('');
    setLinkKind(chosenKind);
    setGitSourceMode('auto');
    setGitCommitSha('');
    setGitTitle('');
    assetForm.resetFields();
    if (options?.template) {
      const tpl = buildAssetTemplate(chosenKind, task, context?.workspace?.repoPath);
      assetForm.setFieldsValue({ kind: chosenKind, title: tpl.title, content: tpl.content });
      setAssetInputMode('manual');
    } else {
      assetForm.setFieldValue('kind', chosenKind);
      const nextMode = options?.mode || 'manual';
      setAssetInputMode(nextMode);
      if (nextMode === 'git') void loadCodeupMrs();
    }
    setDrawer('asset');
  };

  const openDrawer = (next: 'task' | 'asset' | 'review', preferredStage?: Stage) => {
    if (busy || !task) return;
    if (next === 'task') {
      taskEditVersion.current = task.version;
      taskForm.resetFields();
      taskForm.setFieldsValue({ title: task.title, status: task.status, assigneeId: task.assigneeId || '' });
      setDrawer('task');
      return;
    }
    if (next === 'asset') {
      openAssetDrawer({ mode: 'manual' });
      return;
    }
    const defaultStage =
      (preferredStage && allowedReviewStages.some(item => item.value === preferredStage) ? preferredStage : undefined) ||
      allowedStages.find(item => gates?.gates.find(g => g.stage === item.value)?.status !== 'PASS' && assets.some(a => a.kind === STAGE_ASSET[item.value]))?.value ||
      allowedStages.find(item => gates?.gates.find(g => g.stage === item.value)?.status !== 'PASS')?.value ||
      allowedStages[0]?.value;
    reviewForm.resetFields();
    reviewForm.setFieldsValue({ stage: defaultStage, executionMode: 'LOCAL_REPORT' });
    setDrawer('review');
  };

  useEffect(() => {
    if (drawer === 'task' && (!canEdit || doneAncestor) ||
        drawer === 'asset' && (inputsFrozen || !allowedKinds.length) ||
        drawer === 'review' && (inputsFrozen || !allowedReviewStages.some(item => item.value === reviewForm.getFieldValue('stage')))) closeDrawer();
  }, [drawer, role, permissions.assignTasks, task?.assigneeId, inputsFrozen]);

  const claimTaskNow = () => {
    if (!task || !canClaim) return;
    void run(async () => {
      const result = await api<{ task: WorkTask }>('tasks/' + taskId + '/claim', { expectedVersion: task.version });
      if (accessLost.current || !mounted.current) return;
      setTask(result.task); setGates(null); void message.success('任务已认领。');
      await changed();
    }, true);
  };

  useEffect(() => {
    if (!canClaim || busy || drawer || localWorkflowOpen || editingTitle) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'i' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
        event.preventDefault();
        claimTaskNow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canClaim, busy, drawer, localWorkflowOpen, editingTitle, task?.version]);

  const completeTaskNow = () => {
    if (!task || !canComplete || task.status === 'DONE' || !canEdit || doneAncestor) return;
    void run(async () => {
      const result = await api<{ task: WorkTask }>('tasks/' + taskId, { expectedVersion: task.version, status: 'DONE' }, 'PATCH');
      if (accessLost.current || !mounted.current) return;
      setTask(result.task); setGates(null); void message.success('核验完成，任务已标记为已完成！');
      await changed();
    }, true);
  };

  const saveInlineTitle = () => {
    if (!task || !canEdit || inputsFrozen || busy) return;
    const trimmed = titleDraft.trim();
    if (!trimmed) { void message.warning('请填写任务标题。'); return; }
    if (trimmed === task.title) { setEditingTitle(false); return; }
    void run(async () => {
      const result = await api<{ task: WorkTask }>('tasks/' + taskId, { expectedVersion: task.version, title: trimmed }, 'PATCH');
      if (accessLost.current || !mounted.current) return;
      setTask(result.task); setGates(null); setEditingTitle(false); void message.success('任务标题已更新。');
      await changed();
    }, true);
  };

  const quickSwitchStatus = (nextStatus: TaskStatus) => {
    if (!task || !canEdit || doneAncestor || busy || nextStatus === task.status) return;
    void run(async () => {
      const result = await api<{ task: WorkTask }>('tasks/' + taskId, { expectedVersion: task.version, status: nextStatus }, 'PATCH');
      if (accessLost.current || !mounted.current) return;
      setTask(result.task); setGates(null); void message.success(`本地状态已切换为「${taskStatusLabel(nextStatus)}」。`);
      await changed();
    }, true);
  };

  const quickSwitchAssignee = (nextAssigneeId: string) => {
    const normalized = nextAssigneeId || null;
    if (!task || !canAssign || inputsFrozen || busy || normalized === task.assigneeId) return;
    void run(async () => {
      const result = await api<{ task: WorkTask }>('tasks/' + taskId, { expectedVersion: task.version, assigneeId: normalized }, 'PATCH');
      if (accessLost.current || !mounted.current) return;
      setTask(result.task); setGates(null); void message.success(`本地受理人已切换为「${memberName(members, normalized)}」。`);
      await changed();
    }, true);
  };

  const openAssetFromBasis = (asset: Asset) => {
    if (busy || !task || inputsFrozen || !allowedKinds.includes(asset.kind)) return;
    setAssetBasisId(asset.id);
    setAssetInputMode('manual');
    assetForm.resetFields();
    assetForm.setFieldsValue({
      kind: asset.kind,
      logicalKey: asset.logicalKey,
      title: asset.title,
      content: asset.content,
      sourceUrl: asset.sourceUrl || '',
    });
    setDrawer('asset');
  };

  const pasteClipboardLink = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        void message.warning('当前剪贴板为空，请先复制链接或 Jira 事项号。');
        return;
      }
      setLinkInput(text);
      const info = detectPastedReference(text);
      const validSuggested = info.suggestedKinds.find(k => allowedKinds.includes(k));
      if (validSuggested) setLinkKind(validSuggested);
      if (info.provider) void message.success(`已从剪贴板识别：${info.label}，按回车或点击右下角即可拉取保存。`);
    } catch {
      void message.warning('浏览器未能直接读取剪贴板，请在输入框按 Cmd/Ctrl + V 粘贴。');
    }
  };

  const bindRepoQuick = (repoPath: string) => {
    if (!task) return;
    void run(async () => {
      await api<{ workspace: ProjectWorkspace | null }>(`projects/${encodeURIComponent(task.projectId)}/workspace`, {
        repoPath,
        defaultTarget: context?.workspace?.defaultTarget || 'workbench',
      }, 'PUT');
      if (accessLost.current || !mounted.current) return;
      void message.success(`已一键绑定本机仓库：${repoPath}`);
      await changed();
    }, true);
  };

  const openRepoInApp = async (app: 'cursor' | 'terminal' | 'finder', repoPath?: string | null) => {
    if (!task) return;
    try {
      await api('local-git/open', { projectId: task.projectId, app, ...(repoPath ? { repoPath } : {}) });
      if (mounted.current) {
        void message.success(app === 'finder' ? '已在 Finder 中打开仓库文件夹。' : app === 'cursor' ? '已在 Cursor 中打开仓库。' : '已在终端中打开仓库。');
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '打开本地应用失败。');
    }
  };

  const loadCodeupMrs = async () => {
    if (!task || loadingCodeupMrs) return;
    const yunxiaoConn = connectors.find(item => item.provider === 'yunxiao');
    if (yunxiaoConn && yunxiaoConn.status === 'UNCONFIGURED' && !yunxiaoConn.localProfileAvailable) return;
    setLoadingCodeupMrs(true);
    try {
      if (yunxiaoConn?.status === 'UNCONFIGURED' && yunxiaoConn.localProfileAvailable && user.role === 'ADMIN' && permissions.manageConnections) {
        await api(`connectors/yunxiao/reuse-local`, { projectId: task.projectId });
      }
      const res = await api<{ items?: CodeupMrItem[] }>('connectors/yunxiao/read', {
        projectId: task.projectId,
        accountId: yunxiaoConn?.accountId ?? null,
        resource: 'yunxiao_mrs',
      });
      if (mounted.current && !accessLost.current) setCodeupMrs(res.items || []);
    } catch { /* optional helper */ }
    finally { if (mounted.current) setLoadingCodeupMrs(false); }
  };

  const importCodeupMrAsCode = (mr: CodeupMrItem) => {
    if (!task || inputsFrozen || !allowedKinds.includes('CODE')) return;
    const yunxiaoConn = connectors.find(item => item.provider === 'yunxiao');
    void run(async () => {
      const res = await api<{ imported: boolean; asset: Asset }>('connectors/yunxiao/import', {
        projectId: task.projectId,
        accountId: yunxiaoConn?.accountId ?? null,
        resource: 'yunxiao_mr',
        repositoryId: mr.repositoryId,
        mrLocalId: mr.localId,
        taskId: task.id,
        kind: 'CODE',
      });
      if (accessLost.current || !mounted.current) return;
      if (drawer === 'asset') closeDrawer();
      void message.success(res.imported ? `已从云效 Codeup 拉取 MR #${mr.localId} 并保存为${assetKindLabel('CODE')} r${res.asset.revision}！` : `远端 MR 未变化，已复用${assetKindLabel('CODE')} r${res.asset.revision}。`);
      await changed();
    }, true);
  };

  const importReferenceAsAsset = (params: {
    provider: 'confluence' | 'gitlab' | 'jenkins' | 'jira' | 'yunxiao';
    url?: string;
    issueKey?: string;
    kind: AssetKind;
  }) => {
    if (!task || inputsFrozen || !allowedKinds.includes(params.kind)) return;
    void run(async () => {
      let connector = connectors.find(item => item.provider === params.provider);
      if ((!connector || connector.status === 'UNCONFIGURED') && connector?.localProfileAvailable && user.role === 'ADMIN' && permissions.manageConnections) {
        const reused = await api<{ connector: ConnectorSummary }>(`connectors/${params.provider}/reuse-local`, { projectId: task.projectId });
        connector = reused.connector;
      }
      let payload: Record<string, unknown>;
      if (params.provider === 'jira') {
        const key = params.issueKey || (params.url ? detectPastedReference(params.url).issueKey : '');
        if (!key) throw new Error('请输入有效的 Jira 事项号或链接。');
        payload = {
          projectId: task.projectId,
          accountId: connector?.accountId ?? null,
          resource: 'jira_issue',
          issueKey: key,
          taskId: task.id,
          asAsset: true,
          kind: params.kind,
        };
      } else {
        if (!params.url) throw new Error('请输入有效的平台文档、MR 或构建链接。');
        const baseUrl = connector?.baseUrl || (params.provider === 'yunxiao' ? 'https://openapi-rdc.aliyuncs.com' : new URL(params.url).origin);
        const parsed = parseSourceReference(params.provider as SourceProvider, params.url, baseUrl);
        payload = {
          projectId: task.projectId,
          accountId: connector?.accountId ?? null,
          taskId: task.id,
          kind: params.kind,
          ...parsed,
        };
      }
      const res = await api<{ imported: boolean; asset: Asset }>(`connectors/${params.provider}/import`, payload);
      if (accessLost.current || !mounted.current) return;
      if (drawer === 'asset') closeDrawer();
      void message.success(res.imported ? `已自动拉取并保存为${assetKindLabel(params.kind)} r${res.asset.revision}！` : `远端内容未变化，已复用${assetKindLabel(params.kind)} r${res.asset.revision}。`);
      await changed();
    }, true);
  };

  const saveSelfJiraAsPrd = () => {
    if (!task || inputsFrozen || !allowedKinds.includes('PRD')) return;
    void run(async () => {
      const content = formatJiraTaskAsMarkdown(task);
      const res = await api<{ asset: Asset }>(`tasks/${taskId}/assets`, {
        kind: 'PRD',
        title: `${task.jiraKey} · ${task.title}`.slice(0, 200),
        content,
        ...(task.externalRef?.url ? { sourceUrl: task.externalRef.url } : {}),
      });
      if (accessLost.current || !mounted.current) return;
      void message.success(`已将 Jira 任务描述存为${assetKindLabel('PRD')} r${res.asset.revision}。`);
      await changed();
    }, true);
  };

  const captureGitCodeAsset = () => {
    if (!task || inputsFrozen || !allowedKinds.includes('CODE')) return;
    void run(async () => {
      const res = await api<{ asset: Asset; branch: string | null; usedMode: string; truncated: boolean }>(`tasks/${encodeURIComponent(taskId)}/assets/from-git`, {
        source: gitSourceMode,
        ...(gitSourceMode === 'commit' && gitCommitSha.trim() ? { commit: gitCommitSha.trim() } : {}),
        ...(gitTitle.trim() ? { title: gitTitle.trim() } : {}),
      });
      if (accessLost.current || !mounted.current) return;
      if (drawer === 'asset') closeDrawer();
      void message.success(`已提取本地 Git 改动并保存为${assetKindLabel('CODE')} r${res.asset.revision}！`);
      await changed();
    }, true);
  };

  const saveClipboardDiffAsCode = async () => {
    if (!task || inputsFrozen || !allowedKinds.includes('CODE')) return;
    let clipText = '';
    try {
      clipText = await navigator.clipboard.readText();
    } catch {
      void message.warning('浏览器未能直接读取剪贴板，请切换到「手动录入」粘贴保存。');
      return;
    }
    if (!clipText.trim()) {
      void message.warning('当前剪贴板为空，请先运行提取命令复制 Git Diff。');
      return;
    }
    const repoName = (context?.workspace?.repoPath || '').split('/').filter(Boolean).pop() || task.jiraKey;
    void run(async () => {
      const res = await api<{ asset: Asset }>(`tasks/${taskId}/assets`, {
        kind: 'CODE',
        title: (gitTitle.trim() || `${repoName} · 本地 Git Diff 快照`).slice(0, 200),
        content: clipText.slice(0, 65_536),
      });
      if (accessLost.current || !mounted.current) return;
      if (drawer === 'asset') closeDrawer();
      void message.success(`已从剪贴板一键保存${assetKindLabel('CODE')} r${res.asset.revision}！`);
      await changed();
    }, true);
  };

  const saveTask = (values: TaskDraft) => {
    if (!task || !canEdit || doneAncestor) return;
    void run(async () => {
      const result = await api<{ task: WorkTask }>('tasks/' + taskId, { expectedVersion: taskEditVersion.current, title: values.title, status: values.status, ...(canAssign ? { assigneeId: values.assigneeId || null } : {}) }, 'PATCH');
      if (accessLost.current || !mounted.current) return;
      setTask(result.task); setGates(null); closeDrawer(); void message.success('任务已保存。');
      await changed();
    }, true);
  };
  const saveAsset = (values: AssetDraft) => {
    if (!task || inputsFrozen || !ASSET_ROLES[values.kind]?.includes(role)) return;
    void run(async () => {
      const result = await api<{ asset: Asset }>('tasks/' + taskId + '/assets', { kind: values.kind, title: values.title, content: values.content, ...(values.logicalKey?.trim() ? { logicalKey: values.logicalKey } : {}), ...(values.sourceUrl?.trim() ? { sourceUrl: values.sourceUrl } : {}) });
      if (accessLost.current || !mounted.current) return;
      setAssets(current => [result.asset, ...current.filter(asset => asset.id !== result.asset.id)]); setGates(null);
      closeDrawer(); void message.success('新资产版本已保存。');
      await changed();
    }, true);
  };
  const createReview = (values: ReviewDraft) => {
    if (!task || inputsFrozen || !REVIEW_ROLES[values.stage]?.includes(role)) return;
    void run(async () => {
      const result = await api<{ job: ReviewJob }>('reviews', { taskId, ...values });
      if (accessLost.current || !mounted.current) return;
      setJobs(current => [result.job, ...current.filter(job => job.id !== result.job.id)]); setGates(null);
      closeDrawer(); openReview(result.job.id); void message.success('评审申请已创建，等待提交报告。');
      await changed();
    }, true);
  };
  const quickApproveJob = (targetJob: ReviewJob) => {
    if (!task || inputsFrozen) return;
    void run(async () => {
      const result = await api<{ job: ReviewJob }>(`jobs/${encodeURIComponent(targetJob.id)}/decision`, {
        decision: 'APPROVE',
        reason: DEFAULT_APPROVE_REASON,
      });
      if (accessLost.current || !mounted.current) return;
      setJobs(current => current.map(item => item.id === result.job.id ? result.job : item));
      setGates(null);
      void message.success(`已一键批准【${stageLabel(targetJob.stage)}】并推进下一阶段。`);
      await changed();
    }, true);
  };

  const approvableTaskJobs = !task || inputsFrozen
    ? []
    : [...jobs]
        .filter(item => canQuickApproveReview(item, task, tasks, user, role))
        .sort((a, b) => STAGES.findIndex(s => s.value === a.stage) - STAGES.findIndex(s => s.value === b.stage));

  const quickApproveAllTaskJobs = () => {
    if (!task || inputsFrozen || !approvableTaskJobs.length) return;
    void run(async () => {
      let approvedCount = 0;
      for (const item of approvableTaskJobs) {
        try {
          await api<{ job: ReviewJob }>(`jobs/${encodeURIComponent(item.id)}/decision`, {
            decision: 'APPROVE',
            reason: DEFAULT_APPROVE_REASON,
          });
          approvedCount += 1;
        } catch (err) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
        }
      }
      if (accessLost.current || !mounted.current) return;
      setGates(null);
      if (approvedCount > 0) void message.success(`已批量批准 ${approvedCount} 项待审门禁。`);
      await changed();
    }, true);
  };

  const canReportProgress = !!task && !inputsFrozen && (task.assigneeId === user.id || role === 'ADMIN' || role === 'LEAD');

  const reportProgress = async (progress: number, summary: string): Promise<boolean> => {
    if (!task || !canReportProgress || busy) return false;
    const activeBranch = gitStatus?.branch && gitStatus.branch !== 'HEAD' ? gitStatus.branch : undefined;
    const fail = (error: unknown) => {
      if (accessLost.current || !mounted.current) return;
      void message.error(error instanceof Error ? error.message : '记录进度失败。');
      if (error instanceof ApiError && error.status === 403) handleForbidden();
      else if (error instanceof ApiError && error.status === 401) { clearSensitiveState(); onUnauthorized(); }
    };
    try {
      const res = await api<{ task: WorkTask; progress: ProgressEvent }>(`tasks/${encodeURIComponent(task.id)}/progress`, {
        progress: Math.max(0, Math.min(100, Math.round(progress))),
        tool: 'custom',
        deviceId: 'web-workbench',
        summary,
        ...(activeBranch ? { branch: activeBranch } : {}),
      });
      if (accessLost.current || !mounted.current) return false;
      setTask(res.task);
      setContext(prev => prev ? { ...prev, task: res.task, progressEvents: [res.progress, ...prev.progressEvents] } : prev);
      void message.success(`已记录开发进度（${res.progress.progress}%）。`);
    } catch (error) { fail(error); return false; }
    await onChanged().catch(fail);
    return true;
  };

  const childColumns: TableColumnsType<WorkTask> = [
    { title: '子任务', key: 'title', render: (_, item) => <div className="tf-table-title"><Button type="link" size="small" onClick={() => onOpenTask(item.id)}>{item.jiraKey}</Button><Typography.Text className="tf-break">{item.title}</Typography.Text></div> },
    { title: '本地受理人', width: 140, render: (_, item) => memberName(members, item.assigneeId) },
    { title: '本地状态', width: 140, render: (_, item) => <StatusBadge variant={item.status === 'DONE' ? 'green' : 'neutral'}>{taskStatusLabel(item.status)}</StatusBadge> },
  ];
  if (accessDenied) return null;
  if (!task) return <Card title="任务详情"><Skeleton active loading={busy} />{!busy && <Empty><Space orientation="vertical"><span>任务尚未加载，请返回列表或重试。</span><Button onClick={() => void run(refresh)}>重试</Button></Space></Empty>}</Card>;

  const jira = task.externalRef;
  const boundRepoPath = context?.workspace?.repoPath || gitStatus?.repoPath || null;
  const smartHints = extractTaskSmartHints(task, repositories);
  const hasAssetKind = (k: AssetKind) => assets.some(a => a.kind === k);
  const gateFor = (s: Stage) => gates?.gates.find(g => g.stage === s);

  // Compute recommended 1-click next action(s) across the 7-step delivery flow

  const hasSmartSuggestions = !inputsFrozen && (
    smartHints.detectedLinks.length > 0 ||
    smartHints.relatedJira.length > 0 ||
    (!boundRepoPath && smartHints.matchedRepos.length > 0) ||
    (!!jira && !hasAssetKind('PRD') && allowedKinds.includes('PRD'))
  );

  const smartLinksCard = hasSmartSuggestions ? (
    <TaskSmartLinksCard
      hints={smartHints}
      tasks={tasks}
      allowedKinds={allowedKinds}
      busy={busy}
      showRepos={!boundRepoPath}
      showSelfPrd={!!jira && !hasAssetKind('PRD') && allowedKinds.includes('PRD')}
      hasAssetKind={hasAssetKind}
      onBindRepo={bindRepoQuick}
      onOpenRepo={(app, path) => void openRepoInApp(app, path)}
      onImport={importReferenceAsAsset}
      onSaveSelfPrd={saveSelfJiraAsPrd}
      onOpenTask={onOpenTask}
    />
  ) : null;

  const sourceItems: DescriptionsProps['items'] = jira ? [
    { key: 'status', label: '远端状态', children: jira.status },
    { key: 'version', label: '来源版本', children: jira.version },
    ...(jira.project ? [{ key: 'project', label: 'Jira 项目', children: jira.project.key + ' · ' + jira.project.name }] : []),
    ...(jira.type ? [{ key: 'type', label: 'Jira 类型', children: jira.type }] : []),
    ...(jira.priority ? [{ key: 'priority', label: '优先级', children: jira.priority.name }] : []),
    ...(jira.assignee ? [{ key: 'assignee', label: 'Jira 经办人', children: jira.assignee.displayName }] : []),
    ...(jira.components?.length ? [{ key: 'components', label: '组件', children: jira.components.map(item => item.name).join(' · ') }] : []),
    ...(jira.fixVersions?.length ? [{ key: 'versions', label: '修复版本', children: jira.fixVersions.map(item => item.name).join(' · ') }] : []),
    ...(jira.labels?.length ? [{ key: 'labels', label: '标签', span: 2, children: jira.labels.join(' · ') }] : []),
  ] : [];

  const detectedPaste = detectPastedReference(linkInput);

  const taskEditor = <Form form={taskForm} layout="vertical" onFinish={saveTask} className="tf-form-width" disabled={busy} scrollToFirstError>
    <Form.Item name="title" label="任务标题" htmlFor="task-edit-title" rules={[{ required: true, whitespace: true, message: '请填写任务标题' }]}><Input id="task-edit-title" maxLength={200} disabled={!canEdit || busy || inputsFrozen} /></Form.Item>
    <div className="tf-form-grid">
      <Form.Item name="assigneeId" label="本地受理人" htmlFor="task-edit-assignee"><Select id="task-edit-assignee" disabled={!canAssign || busy || inputsFrozen} options={[{ value: '', label: '未指派' }, ...members.map(member => ({ value: member.id, label: member.username }))]} /></Form.Item>
      <Form.Item name="status" label="本地状态" htmlFor="task-edit-status" rules={[{ required: true }]}><Select id="task-edit-status" disabled={!canEdit || busy || !!doneAncestor} options={TASK_STATUS_OPTIONS.map(opt => ({ ...opt, disabled: opt.value === 'DONE' && task.status !== 'DONE' && !canComplete }))} /></Form.Item>
    </div>
    {doneAncestor && <Typography.Paragraph type="secondary">请先重开祖先任务 <Button type="link" size="small" onClick={() => onOpenTask(doneAncestor.id)}>{doneAncestor.jiraKey}</Button>，再重开此任务。</Typography.Paragraph>}
    <Typography.Paragraph type="secondary">更新按打开表单时的版本 v{taskEditVersion.current || task.version} 校验。标记「已完成」需要五阶段门禁通过，且全部子任务完成；不会修改 Jira 状态。</Typography.Paragraph>
  </Form>;

  const assetEditor = <Flex vertical gap={16}>
    {!allowedKinds.length ? <Empty>当前项目角色无资产写入权限，可查看版本历史。</Empty> : <>
      <Segmented
        block
        value={assetInputMode}
        options={[
          { value: 'link', label: '粘贴链接一键导入' },
          ...(allowedKinds.includes('CODE') ? [{ value: 'git' as const, label: '云效 Codeup / 本地 Git 代码' }] : []),
          { value: 'manual', label: '结构模板 / 手动录入' },
        ]}
        onChange={val => {
          const nextMode = val as AssetInputMode;
          setAssetInputMode(nextMode);
          if (nextMode === 'git' && !codeupMrs.length) void loadCodeupMrs();
        }}
      />

      {assetInputMode === 'link' && (
        <Flex vertical gap={12} className="tf-form-width">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            直接粘贴 Confluence 文档链接（含 <code>/x/短链</code> 或 <code>pageId</code>）、阿里云效 Codeup MR / 提交链接、GitLab MR 链接、Jenkins 构建链接，或同项目 Jira 事项号（如 <code>DEMO-778</code>），自动只读拉取正文存为版本化材料。
          </Typography.Paragraph>
          <div>
            <Typography.Text style={{ display: 'block', marginBottom: 6 }}>文档 / Codeup MR / 构建链接或 Jira 事项号（支持按回车直接导入）</Typography.Text>
            <Flex gap={8} wrap={false}>
              <Input
                placeholder="例如 https://confluence.example.invalid/x/0gQ 、 https://codeup.aliyun.com/.../change/42 或 DEMO-778"
                allowClear
                value={linkInput}
                onChange={e => {
                  const next = e.target.value;
                  setLinkInput(next);
                  const info = detectPastedReference(next);
                  const validSuggested = info.suggestedKinds.find(k => allowedKinds.includes(k));
                  if (validSuggested) setLinkKind(validSuggested);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && detectedPaste.provider && !busy) {
                    e.preventDefault();
                    assetDrawerPrimaryAction();
                  }
                }}
              />
              <Button icon={<ClipboardPaste size={14} />} disabled={busy} onClick={() => void pasteClipboardLink()}>
                读取剪贴板
              </Button>
            </Flex>
          </div>
          <div>
            <Typography.Text style={{ display: 'block', marginBottom: 6 }}>导入为材料类型</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={linkKind}
              options={allowedKinds.map(k => ({ value: k, label: assetKindLabel(k) }))}
              onChange={setLinkKind}
            />
          </div>
          {detectedPaste.provider && (
            <Alert
              type="success"
              showIcon
              title={`已识别来源：${detectedPaste.label}（${detectedPaste.provider.toUpperCase()}）`}
              description="按回车或点击右下角「一键拉取并保存」即可直接导入，无需跳转平台连接页面。"
            />
          )}
          {(smartHints.detectedLinks.length > 0 || smartHints.relatedJira.some(r => r.sameProject)) && (
            <Card size="small" title="从任务描述中识别到的快捷来源（点击直接拉取保存）">
              <Space wrap size={[8, 8]}>
                {smartHints.detectedLinks.filter(l => l.provider !== 'external').map(l => {
                  const targetKind = l.suggestedKinds.find(x => allowedKinds.includes(x)) || linkKind;
                  return (
                    <Button
                      key={l.url}
                      size="small"
                      disabled={busy}
                      onClick={() => importReferenceAsAsset({
                        provider: l.provider as 'confluence' | 'gitlab' | 'jenkins' | 'jira' | 'yunxiao',
                        url: l.url,
                        kind: targetKind,
                      })}
                    >
                      直接导入 {l.label}（{assetKindLabel(targetKind)}）
                    </Button>
                  );
                })}
                {smartHints.relatedJira.filter(r => r.sameProject).map(r => {
                  const targetKind: AssetKind = allowedKinds.includes('PRD') ? 'PRD' : linkKind;
                  return (
                    <Button
                      key={r.key}
                      size="small"
                      disabled={busy}
                      onClick={() => importReferenceAsAsset({ provider: 'jira', issueKey: r.key, kind: targetKind })}
                    >
                      直接导入 Jira {r.key}（{assetKindLabel(targetKind)}）
                    </Button>
                  );
                })}
              </Space>
            </Card>
          )}
        </Flex>
      )}

      {assetInputMode === 'git' && (
        <Flex vertical gap={12} className="tf-form-width">
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            支持直接用你的云效账号一键拉取 Codeup 合并请求 Diff，或从本机 Git 仓库提取工作区改动作为代码改动评审材料。
          </Typography.Paragraph>
          <Card
            size="small"
            title={<Space size={6}><GitBranch size={15} /><span>方式 A：从云效 Codeup 选择合并请求一键导入（免终端、免桌面权限）</span></Space>}
            extra={<Button size="small" loading={loadingCodeupMrs} onClick={() => void loadCodeupMrs()}>刷新 MR</Button>}
          >
            {codeupMrs.length > 0 ? (() => {
              const boundName = (boundRepoPath || '').split('/').filter(Boolean).pop()?.toLowerCase() || '';
              const keyUpper = task.jiraKey.toUpperCase();
              const parentUpper = (jira?.parentKey || '').toUpperCase();
              const sorted = [...codeupMrs].sort((a, b) => {
                const score = (item: CodeupMrItem) => {
                  const hay = `${item.title} ${item.sourceBranch} ${item.repositoryName}`.toUpperCase();
                  let s = 0;
                  if (hay.includes(keyUpper)) s += 4;
                  if (parentUpper && hay.includes(parentUpper)) s += 3;
                  if (boundName && item.repositoryName.toLowerCase() === boundName) s += 2;
                  return s;
                };
                return score(b) - score(a);
              });
              return (
                <Flex vertical gap={8} style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {sorted.slice(0, 12).map(mr => {
                    const hay = `${mr.title} ${mr.sourceBranch}`.toUpperCase();
                    const matched = hay.includes(keyUpper) || (!!parentUpper && hay.includes(parentUpper));
                    return (
                      <Flex key={mr.id} justify="space-between" align="center" gap={8} wrap className="tf-smart-hint-row">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <Space size={6} wrap>
                            {matched && <Tag color="success">匹配本任务</Tag>}
                            <Tag>{mr.repositoryName}</Tag>
                            <Typography.Text strong>{mr.name}</Typography.Text>
                          </Space>
                          <div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              <code>{mr.sourceBranch} → {mr.targetBranch}</code> · {mrStateLabel(mr.state)}{mr.authorName ? ` · ${mr.authorName}` : ''}
                            </Typography.Text>
                          </div>
                        </div>
                        <Button size="small" type={matched ? 'primary' : 'default'} disabled={busy} onClick={() => importCodeupMrAsCode(mr)}>
                          一键导入为代码改动
                        </Button>
                      </Flex>
                    );
                  })}
                </Flex>
              );
            })() : (
              <Typography.Text type="secondary">
                {loadingCodeupMrs ? '正在读取云效 Codeup 最近合并请求…' : '点击右上角「刷新 MR」读取云效 Codeup 合并请求，或切到「粘贴链接一键导入」直接粘贴 Codeup MR/Commit 链接。'}
              </Typography.Text>
            )}
          </Card>
          {repositories.length > 0 && (
            <div>
              <Typography.Text style={{ display: 'block', marginBottom: 6 }}>绑定 / 切换项目本地 Git 仓库</Typography.Text>
              <Select
                style={{ width: '100%' }}
                showSearch={{ optionFilterProp: 'label' }}
                placeholder="选择本机业务代码仓库"
                value={boundRepoPath || undefined}
                options={repositories.map(r => ({ value: r.path, label: `${r.name}${r.group ? ` (${r.group})` : ''} · ${r.path}` }))}
                onChange={val => bindRepoQuick(val)}
              />
            </div>
          )}

          {!boundRepoPath ? (
            <Alert type="info" showIcon title="请先在上方选择本项目对应的本地 Git 仓库目录。" />
          ) : gitStatus?.tccProtected ? (
            <Card size="small" style={{ background: 'var(--tf-warning-bg)', borderColor: 'color-mix(in srgb, var(--tf-warning) 35%, var(--tf-border))' }}>
              <Flex vertical gap={10}>
                <Typography.Text strong>检测到该仓库位于 macOS 桌面隐私保护目录（{boundRepoPath}）</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  后台守护服务不越权读取桌面目录。你只需点「1. 复制提取命令」在终端回车，再点「2. 从剪贴板一键保存为代码改动」即可免粘贴完成登记：
                </Typography.Text>
                <Flex gap={8} wrap>
                  <Button
                    icon={<Copy size={14} />}
                    onClick={() => {
                      const cmd = buildClipboardGitCommand(boundRepoPath, gitSourceMode === 'head' ? 'head' : 'working');
                      void navigator.clipboard.writeText(cmd).then(() => message.success('提取命令已复制，请在终端运行后点击右侧按钮保存。'));
                    }}
                  >
                    1. 复制终端提取命令
                  </Button>
                  <Button icon={<Terminal size={14} />} onClick={() => void openRepoInApp('terminal', boundRepoPath)}>打开终端</Button>
                  <Button type="primary" icon={<ClipboardPaste size={14} />} onClick={() => void saveClipboardDiffAsCode()}>
                    2. 从剪贴板一键保存为代码改动
                  </Button>
                </Flex>
              </Flex>
            </Card>
          ) : (
            <>
              {gitStatus?.accessible && (
                <Descriptions bordered size="small" column={2} items={[
                  { key: 'branch', label: '当前分支', children: <code>{gitBranchLabel(gitStatus.branch)}</code> },
                  { key: 'dirty', label: '未提交改动文件', children: `${gitStatus.dirtyCount || 0} 个` },
                  { key: 'head', label: '最新提交', span: 2, children: <code>{gitStatus.shortHead} {gitStatus.subject}</code> },
                  ...(gitStatus.constitutionFiles?.length ? [{ key: 'constitution', label: '仓库工程规范', span: 2, children: <Space size={4} wrap>{gitStatus.constitutionFiles.map(file => <Tag key={file} color="cyan">{file}</Tag>)}</Space> }] : []),
                ]} />
              )}
              <div>
                <Typography.Text style={{ display: 'block', marginBottom: 6 }}>提取范围</Typography.Text>
                <Select
                  style={{ width: '100%' }}
                  value={gitSourceMode}
                  options={[
                    { value: 'auto', label: '智能选择（优先未提交改动，无改动则取最新 Commit）' },
                    { value: 'working', label: '仅提取当前工作区未提交改动 (git diff HEAD)' },
                    { value: 'head', label: '提取最新一次提交 Patch (git show HEAD)' },
                    { value: 'commit', label: '提取指定历史 Commit Patch' },
                  ]}
                  onChange={setGitSourceMode}
                />
              </div>
              {gitSourceMode === 'commit' && (
                <div>
                  <Typography.Text style={{ display: 'block', marginBottom: 6 }}>选择或输入 Commit SHA</Typography.Text>
                  <Select
                    style={{ width: '100%' }}
                    showSearch
                    placeholder="选择最近提交或输入 Commit SHA"
                    value={gitCommitSha || undefined}
                    options={(gitStatus?.recentCommits || []).map(c => ({ value: c.hash, label: `${c.hash} · ${c.subject}` }))}
                    onChange={setGitCommitSha}
                  />
                </div>
              )}
              <div>
                <Typography.Text style={{ display: 'block', marginBottom: 6 }}>自定义材料标题（可选，留空自动生成）</Typography.Text>
                <Input placeholder="留空自动带入仓库名、分支与提交摘要" value={gitTitle} onChange={e => setGitTitle(e.target.value)} maxLength={200} />
              </div>
            </>
          )}
        </Flex>
      )}

      {assetInputMode === 'manual' && (
        <>
          <Flex justify="space-between" align="center" gap={8} wrap>
            <Typography.Text type="secondary">相同类型与标识会保存为新版本，历史内容保留。</Typography.Text>
            <Space size={6} wrap>
              {allowedKinds.includes('TEST_CASE') && (!assetBasis || assetBasis.kind === 'TEST_CASE') && (
                <>
                  <Tooltip title="从已登记的 PRD / 技术方案及代码敏感特征自动推导结构化验收清单">
                    <Button size="small" icon={<FileCheck2 size={14} />} onClick={() => {
                      const suite = synthesizeTestSuiteFromSpecs({ task, assets, format: 'checklist' });
                      assetForm.setFieldsValue({ kind: 'TEST_CASE', title: assetBasis ? assetBasis.title : suite.title, content: suite.content });
                      void message.success(`已从规格材料自动推导 ${suite.scenarioCount} 条验收与边界测试用例。`);
                    }}>
                      从规格推导测试清单
                    </Button>
                  </Tooltip>
                  <Tooltip title="生成声明式 BDD Gherkin (假如/当/那么) .feature 验收场景">
                    <Button size="small" onClick={() => {
                      const suite = synthesizeTestSuiteFromSpecs({ task, assets, format: 'gherkin' });
                      assetForm.setFieldsValue({ kind: 'TEST_CASE', title: assetBasis ? assetBasis.title : suite.title, content: suite.content });
                      void message.success(`已生成 ${suite.scenarioCount} 个 BDD Gherkin 验收场景。`);
                    }}>
                      生成 BDD Gherkin 场景
                    </Button>
                  </Tooltip>
                </>
              )}
              <Button size="small" icon={<Sparkles size={14} />} onClick={() => {
                const currentKind = (assetForm.getFieldValue('kind') as AssetKind) || allowedKinds[0];
                const tpl = buildAssetTemplate(currentKind, task, boundRepoPath);
                assetForm.setFieldsValue({ kind: currentKind, title: tpl.title, content: tpl.content });
                void message.success(`已填入${assetKindLabel(currentKind)}标准结构模板。`);
              }}>
                填入当前类型标准模板
              </Button>
            </Space>
          </Flex>
          <Form form={assetForm} layout="vertical" onFinish={saveAsset} className="tf-form-width" initialValues={{ kind: allowedKinds[0] }} disabled={busy || inputsFrozen} scrollToFirstError>
            {!!assetChoices.length && <Form.Item label="填写方式" extra={assetBasis ? `已带入保存的 r${assetBasis.revision} 内容；保存将新增版本。` : '新材料填写一次，后续可选择已有材料继续更新。'}><Select value={assetBasisId} showSearch={{ optionFilterProp: 'label' }} options={[{ value: '', label: '登记新材料' }, ...assetChoices.map(asset => ({ value: asset.id, label: `${asset.title} · ${assetKindLabel(asset.kind)} · ${asset.logicalKey} · r${asset.revision}` }))]} onChange={id => {
              const selected = assetChoices.find(asset => asset.id === id); setAssetBasisId(selected?.id || ''); assetForm.resetFields();
              assetForm.setFieldsValue(selected ? { kind: selected.kind, logicalKey: selected.logicalKey, title: selected.title, content: selected.content, sourceUrl: selected.sourceUrl || '' } : { kind: allowedKinds[0] });
            }} /></Form.Item>}
            <Form.Item label="资产类型" name="kind" htmlFor="asset-kind" rules={[{ required: true }]}><Select id="asset-kind" disabled={busy || inputsFrozen || !!assetBasis} options={allowedKinds.map(value => ({ value, label: assetKindLabel(value) }))} /></Form.Item>
            <Form.Item label="资产标题" name="title" htmlFor="asset-title" rules={[{ required: true, whitespace: true, message: '请填写资产标题' }]}><Input id="asset-title" maxLength={200} /></Form.Item>
            <Form.Item label="资产正文 / 代码 Diff / 用例内容（支持 Cmd/Ctrl + Enter 保存）" name="content" htmlFor="asset-content" rules={[{ required: true, whitespace: true, message: '请填写资产正文' }]}><Input.TextArea id="asset-content" rows={10} maxLength={65536} className="tf-code-input" onKeyDown={event => { if (isSubmitShortcut(event)) { event.preventDefault(); assetForm.submit(); } }} /></Form.Item>
            <Form.Item label="来源链接（可选）" name="sourceUrl" rules={[{ type: 'url', message: '请输入有效的来源链接' }]}><Input /></Form.Item>
            <Collapse size="small" items={[{ key: 'identity', label: '高级：材料版本标识', forceRender: true, children: <Form.Item label="逻辑资产标识（可选）" name="logicalKey" extra="留空采用资产类型；仅需区分同类多份材料时填写。基于已有材料时沿用原标识。"><Input maxLength={100} disabled={busy || inputsFrozen || !!assetBasis} /></Form.Item> }]} />
          </Form>
        </>
      )}
    </>}
  </Flex>;

  const reviewEditor = <>
    <Form form={reviewForm} layout="vertical" onFinish={createReview} className="tf-form-width" initialValues={{ stage: allowedStages[0]?.value, executionMode: 'LOCAL_REPORT' }} disabled={busy || inputsFrozen}>
      <div className="tf-form-grid">
        <Form.Item name="stage" label="评审阶段" htmlFor="review-stage" rules={[{ required: true, message: '请选择评审阶段' }]}><Select id="review-stage" options={REVIEW_STAGE_OPTIONS.map(item => ({ value: item.value, label: item.label, disabled: !REVIEW_ROLES[item.value].includes(role) }))} disabled={!allowedStages.length || busy || inputsFrozen} /></Form.Item>
        <Form.Item name="executionMode" label="执行方式" htmlFor="review-mode" rules={[{ required: true }]}><Select id="review-mode" options={[{ value: 'LOCAL_REPORT', label: executionModeLabel('LOCAL_REPORT') }, { value: 'HUMAN_REVIEW', label: executionModeLabel('HUMAN_REVIEW') }, { value: 'CLOUD_AI', label: executionModeLabel('CLOUD_AI') + '（暂未开放）', disabled: true }]} /></Form.Item>
      </div>
      <Typography.Paragraph type="secondary">申请会冻结当前资产版本、角色与 Skills 声明。也可直接在任务顶部点击「一键 AI 评审」自动创建申请并生成结构化草稿。</Typography.Paragraph>
    </Form>
  </>;

  const fixAssetFromRelease = (kind: AssetKind) => {
    changeTab('assets');
    openAssetDrawer({ mode: kind === 'CODE' ? 'git' : 'manual', kind, template: kind !== 'CODE' });
  };
  const passedGateCount = gates?.gates.filter(gate => gate.status === 'PASS').length || 0;

  const openDecompose = () => { setDecomposeEverOpened(true); setDecomposeOpen(true); };
  const jiraDescription = jira ? (typeof jira.description === 'string' ? jira.description.trim() : jira.description ? JSON.stringify(jira.description, null, 2) : '') : '';
  const doneChildren = children.filter(item => item.status === 'DONE').length;

  const overview = <div className="tf-detail-stack">
    {doneAncestor && <Alert type="info" showIcon title={<>上级任务 <Button type="link" size="small" style={{ paddingInline: 2 }} onClick={() => onOpenTask(doneAncestor.id)}>{doneAncestor.jiraKey}</Button> 已完成并冻结，需先重开上级任务才能修改此任务。</>} />}
    {task.status === 'DONE' && <Alert type="info" showIcon title="任务已完成，可查看历史；需先重开才能新增材料、评审或重新认领。" />}
    {jira && <Card
      title={<Space size={8} wrap><span>需求描述</span><Typography.Text type="secondary" className="tf-card-subtitle">来自 Jira {jira.key} · {jira.status}</Typography.Text></Space>}
      extra={<Typography.Link href={jira.url} target="_blank" rel="noreferrer"><Space size={4}><ExternalLink size={13} />Jira 原单</Space></Typography.Link>}
    >
      <div className="tf-detail-stack tf-detail-stack-small">
        {jira.title !== task.title && <Typography.Text strong>{jira.title}</Typography.Text>}
        {jiraDescription ? <pre className="tf-code-panel tf-jira-description">{jiraDescription}</pre> : <Typography.Text type="secondary">Jira 正文为空。</Typography.Text>}
        <Collapse ghost size="small" className="tf-jira-source" items={[{ key: 'meta', label: 'Jira 字段（优先级、组件、版本等）', children: <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={sourceItems} /> }]} />
      </div>
    </Card>}
    <Card title="基本信息" extra={<Button size="small" disabled={!canEdit || busy || !!doneAncestor} onClick={() => openDrawer('task')}>编辑任务</Button>}>
      <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
        { key: 'progress', label: '自报进度', children: <Progress percent={task.progress} size="small" style={{ width: 160, margin: 0 }} /> },
        { key: 'updated', label: '最近更新', children: timeText(task.updatedAt) },
        { key: 'repo', label: '本地仓库', span: 2, children: boundRepoPath ? <Space size={8} wrap><Typography.Text code>{boundRepoPath}</Typography.Text>{!!gitStatus?.branch && gitStatus.branch !== 'HEAD' && <Tag icon={<GitBranch size={11} />}>{gitStatus.branch}</Tag>}{!!gitStatus?.constitutionFiles?.length && <Tag color="cyan">工程规范：{gitStatus.constitutionFiles.join(' · ')}</Tag>}</Space> : <Typography.Text type="secondary">未绑定（启动「本地 AI 一键处理」时可选择）</Typography.Text> },
        ...(task.parentId ? [{ key: 'parent', label: '本地父任务', children: <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => onOpenTask(task.parentId!)}>{tasks.find(item => item.id === task.parentId)?.jiraKey || task.parentId}</Button> }] : []),
        ...(jira?.parentKey ? [{ key: 'jiraParent', label: 'Jira 父任务', children: <Typography.Link href={new URL(encodeURIComponent(jira.parentKey), jira.url).href} target="_blank" rel="noreferrer">{jira.parentKey}</Typography.Link> }] : []),
        ...(task.lastSummary ? [{ key: 'summary', label: '最新进展', span: 2, children: <span className="tf-preserve">{task.lastSummary}</span> }] : []),
      ]} />
    </Card>
    <Card
      title={<Space size={8}><span>子任务</span>{children.length > 0 && <Typography.Text type="secondary" className="tf-card-subtitle">{doneChildren} / {children.length} 已完成</Typography.Text>}</Space>}
      extra={children.length > 0 && !inputsFrozen && <Button size="small" icon={<Sparkles size={14} />} disabled={busy} onClick={openDecompose}>智能拆解 / 批量建子任务</Button>}
    >
      {children.length ? <Flex vertical gap={12}>
        <Progress percent={Math.round(doneChildren / children.length * 100)} size="small" showInfo={false} />
        <Table<WorkTask> rowKey="id" dataSource={children} columns={childColumns} size="middle" pagination={false} scroll={{ x: 580 }} />
      </Flex> : <Empty>
        <Space orientation="vertical" size={8}>
          <span>暂无子任务。可从需求文档 / 技术方案一键拆解，或套用四步标准研发模板。</span>
          {!inputsFrozen && <Button size="small" type="primary" ghost icon={<Sparkles size={14} />} disabled={busy} onClick={openDecompose}>智能拆解并创建子任务</Button>}
        </Space>
      </Empty>}
    </Card>
  </div>;

  const assetPanel = <div className="tf-detail-stack">
    {smartLinksCard}
    <Card
      title="任务材料"
      extra={<Space size={8} wrap>
        {allowedKinds.includes('CODE') && <Button icon={<GitBranch size={15} />} disabled={busy || inputsFrozen} onClick={() => openAssetDrawer({ mode: 'git', kind: 'CODE' })}>提取本地 Git 代码</Button>}
        <Button icon={<Link2 size={15} />} disabled={busy || inputsFrozen || !allowedKinds.length} onClick={() => openAssetDrawer({ mode: 'link' })}>粘贴链接导入</Button>
        <Button type="primary" icon={<FileText size={16} />} disabled={busy || inputsFrozen || !allowedKinds.length} onClick={() => openAssetDrawer({ mode: 'manual' })}>添加材料</Button>
      </Space>}
    >
      <TaskAssetList assets={assets} members={members} allowedKinds={allowedKinds} frozen={inputsFrozen} busy={busy} onUpdateFromBasis={openAssetFromBasis} />
    </Card>
  </div>;

  const reviewPanel = <div className="tf-detail-stack">
    <Card
      title="评审记录"
      extra={<Space size={8} wrap>
        {approvableTaskJobs.length >= 2 && (
          <Button type="primary" icon={<CheckCircle2 size={15} />} disabled={busy} onClick={quickApproveAllTaskJobs}>
            一键全部批准 ({approvableTaskJobs.length})
          </Button>
        )}
        <Button icon={<Sparkles size={15} />} disabled={busy || inputsFrozen || !allowedStages.length} onClick={() => openLocalWorkflow({ mode: 'review' })}>一键 AI 评审</Button>
        <Button type={approvableTaskJobs.length >= 2 ? 'default' : 'primary'} disabled={busy || inputsFrozen || !allowedStages.length} onClick={() => openDrawer('review')}>发起评审</Button>
      </Space>}
    >
      <Table<ReviewJob>
        rowKey="id"
        dataSource={jobs}
        size="middle"
        pagination={false}
        scroll={{ x: 660 }}
        rowClassName={item => selectedJob?.id === item.id ? 'tf-selected-row' : ''}
        onRow={item => ({
          style: { cursor: 'pointer' },
          onClick: event => {
            if (!(event.target as HTMLElement).closest('button,a')) openReview(item.id);
          },
        })}
        columns={[
        { title: '阶段', dataIndex: 'stage', render: (value, item) => <div className="tf-table-title"><Button type="link" size="small" onClick={() => openReview(item.id)}>{stageLabel(value)}</Button><Typography.Text type="secondary" className="tf-table-secondary">{executionModeLabel(item.executionMode)} · {timeText(item.createdAt)}</Typography.Text></div> },
        { title: '状态', render: (_, item) => <Space size={8} wrap><StatusBadge variant={item.status === 'APPROVED' ? 'green' : item.status === 'REPORT_SUBMITTED' ? 'blue' : 'neutral'}>{reviewStatusLabel(item.status)}</StatusBadge>{item.stale && <StatusBadge variant="warn">材料已更新</StatusBadge>}</Space> },
        { title: '快捷操作', width: 220, render: (_, item) => {
          const canApproveRow = canQuickApproveReview(item, task, tasks, user, role);
          return <Space size={4} wrap>
            {canApproveRow && (
              <Button type="primary" size="small" icon={<CheckCircle2 size={13} />} disabled={busy} onClick={() => quickApproveJob(item)}>
                一键批准
              </Button>
            )}
            <Button type="link" size="small" onClick={() => openReview(item.id)}>查看</Button>
            {!inputsFrozen && !item.stale && !item.report && item.executionMode === 'LOCAL_REPORT' && REVIEW_ROLES[item.stage].includes(role) && (
              <Button type="link" size="small" onClick={() => openLocalWorkflow({ mode: 'review', jobId: item.id, stage: item.stage })}>AI 生成草稿</Button>
            )}
          </Space>;
        } },
      ]} locale={{ emptyText: <Empty><Space orientation="vertical" size={8}><span>尚无评审记录。材料就绪后可发起评审，或让本机 AI 直接生成评审报告草稿。</span>{!inputsFrozen && !!allowedStages.length && <Button size="small" type="primary" ghost icon={<Sparkles size={14} />} disabled={busy} onClick={() => openLocalWorkflow({ mode: 'review' })}>一键 AI 评审</Button>}</Space></Empty> }} />
      {jobs.length > 0 && !selectedJob && <Typography.Text type="secondary" className="tf-table-hint">点击任意一条评审查看报告、发现项与审批。</Typography.Text>}
    </Card>
    {selectedJob && <div id="workspace-review-detail" className="tf-review-panel"><Suspense fallback={<Card><Skeleton active paragraph={{ rows: 4 }} /></Card>}><ReviewDetail key={selectedJob.id} jobId={selectedJob.id} task={task} user={user} role={role} members={members} repoPath={boundRepoPath} constitutionFiles={gitStatus?.constitutionFiles || []} onChanged={changed} onUnauthorized={onUnauthorized} onForbidden={handleForbidden} onOpenJob={id => openReview(id)} readOnly={inputsFrozen} onReady={() => { if (tab === 'reviews') document.getElementById('workspace-review-detail')?.scrollIntoView({ block: 'start', behavior: 'instant' }); }} /></Suspense></div>}
    {hasAssetKind('CODE') && <TaskMergeRequests key={`${user.id}:${task.id}`} taskId={task.id} taskVersion={task.version}
      approvedJobId={gates?.gates.find(gate => gate.stage === 'CODE_REVIEW' && gate.status === 'PASS')?.jobId}
      active={tab === 'reviews'} readOnly={inputsFrozen} onUnauthorized={onUnauthorized}
      onImport={!inputsFrozen && allowedKinds.includes('CODE') ? () => openAssetDrawer({ mode: 'link', kind: 'CODE' }) : undefined} />}
  </div>;

  const releasePanel = <TaskReleasePanel
    task={task}
    assets={assets}
    jobs={jobs}
    gates={gates}
    members={members}
    repoPath={boundRepoPath}
    frozen={inputsFrozen}
    allowedKinds={allowedKinds}
    onOpenReview={openReview}
    onFixAsset={fixAssetFromRelease}
    onFixStage={stage => {
      const g = gateFor(stage);
      if (g?.jobId) { openReview(g.jobId); return; }
      const reqKind = STAGE_ASSET[stage as GateStage];
      if (reqKind && !hasAssetKind(reqKind)) { fixAssetFromRelease(reqKind); return; }
      const latest = jobs.find(j => j.stage === stage);
      if (latest) openReview(latest.id);
      else if (!inputsFrozen && REVIEW_ROLES[stage].includes(role)) openLocalWorkflow({ mode: 'review', stage });
    }}
  />;

  const activityPanel = <TaskActivityPanel
    taskProgress={task.progress}
    members={members}
    progressEvents={context?.progressEvents || []}
    devices={context?.devices || []}
    aiRuns={aiRuns}
    branch={gitStatus?.branch}
    canReport={canReportProgress}
    busy={busy}
    onReport={reportProgress}
    onStartLocalAi={() => openLocalWorkflow({ mode: 'read' })}
    onOpenReview={openReview}
  />;

  const chainRefreshKey = `${task.version}:${assets.length}:${jobs.map(job => `${job.id}:${job.status}:${job.stale ? 1 : 0}`).join(',')}:${children.map(child => `${child.id}:${child.version}`).join(',')}`;
  const assetModeForKind = (kind: AssetKind): AssetInputMode => {
    if (kind === 'CODE') return 'git';
    if (kind === 'PRD' || kind === 'TECH_SPEC') return 'link';
    return smartHints.detectedLinks.some(l => l.suggestedKinds.includes(kind)) ? 'link' : 'manual';
  };
  const openChainInput = (link: ChainLink) => {
    if (busy || inputsFrozen) return;
    if (link.id === 'BREAKDOWN') { openDecompose(); return; }
    const kind = link.stage === 'RELEASE' ? 'RELEASE_PLAN' : STAGE_ASSET[link.stage as GateStage];
    if (!kind || !allowedKinds.includes(kind)) { void message.warning('当前角色无权补充该类材料。'); return; }
    openAssetDrawer({ mode: assetModeForKind(kind), kind });
  };
  // One handler for every delivery-chain action, so each link exposes exactly one primary entry point.
  const handleChainAction = (link: ChainLink, action: ChainNextAction) => {
    if (busy) return;
    if (action.type === 'ADD_INPUT' && action.assetKind) {
      if (inputsFrozen || !allowedKinds.includes(action.assetKind)) { void message.warning('当前角色无权补充该类材料，或任务已冻结。'); return; }
      openAssetDrawer({ mode: assetModeForKind(action.assetKind), kind: action.assetKind });
      return;
    }
    if (action.type === 'ADD_SUBTASKS') { if (!inputsFrozen) openDecompose(); return; }
    if (action.type === 'AI_REVIEW') {
      const stage = action.stage || link.stage;
      if (!REVIEW_ROLES[stage].includes(role)) { void message.warning('当前角色无权发起该环节的审核。'); return; }
      openLocalWorkflow({ mode: 'review', stage, jobId: action.jobId });
      return;
    }
    if (action.jobId) { setChainReviewJobId(action.jobId); return; }
    if (link.review?.jobId) setChainReviewJobId(link.review.jobId);
  };
  const chainPanel = <TaskChainPanel taskId={task.id} refreshKey={chainRefreshKey} frozen={inputsFrozen} onAction={handleChainAction} onAddInput={openChainInput} onOpenTask={onOpenTask} onUnauthorized={onUnauthorized} onForbidden={handleForbidden} onChanged={changed} />;

  const workflowMode: LocalTaskMode = inputsFrozen ? 'read' : canEdit ? 'develop' : 'read';
  const moreActions: MenuProps['items'] = [
    { key: 'workbench', icon: <Laptop size={14} />, label: '在工作台处理' },
    { key: 'context-pack', icon: <Package size={14} />, label: '打包上下文 / 导出' },
    { key: 'git-handoff', icon: <GitBranch size={14} />, label: '分支 / Worktree / MR 描述' },
    ...(boundRepoPath ? [
      { type: 'divider' as const },
      { key: 'finder', icon: <FolderOpen size={14} />, label: 'Finder 打开仓库' },
      { key: 'cursor', icon: <ExternalLink size={14} />, label: '在 Cursor 打开仓库' },
      { key: 'terminal', icon: <Terminal size={14} />, label: '在终端打开仓库' },
    ] : []),
  ];
  const runMoreAction = (key: string) => {
    if (key === 'workbench') openLocalWorkflow({ mode: workflowMode, runner: 'workbench' });
    else if (key === 'context-pack') { setContextPackEverOpened(true); setContextPackOpen(true); }
    else if (key === 'git-handoff') { setGitHandoffEverOpened(true); setGitHandoffOpen(true); }
    else if ((key === 'finder' || key === 'cursor' || key === 'terminal') && boundRepoPath) void openRepoInApp(key, boundRepoPath);
  };

  const assetDrawerPrimaryAction = () => {
    if (assetInputMode === 'link') {
      if (!detectedPaste.provider) {
        void message.warning('请粘贴有效的 Confluence、云效 Codeup、GitLab、Jenkins 链接或同项目 Jira 事项号。');
        return;
      }
      importReferenceAsAsset({
        provider: detectedPaste.provider,
        url: detectedPaste.url,
        issueKey: detectedPaste.issueKey,
        kind: linkKind,
      });
      return;
    }
    if (assetInputMode === 'git') {
      if (gitStatus?.tccProtected) {
        void saveClipboardDiffAsCode();
        return;
      }
      captureGitCodeAsset();
      return;
    }
    assetForm.submit();
  };

  return <Spin spinning={busy}><div className="tf-task-detail">
    <Card className="tf-task-summary">
      <Flex justify="space-between" align="start" gap={16} className="tf-task-summary-layout">
        <div className="tf-task-heading">
          <Space size={8} wrap>
            <Tooltip title="点击复制任务号">
              <Typography.Text
                strong
                style={{ cursor: 'pointer' }}
                onClick={() => { void navigator.clipboard.writeText(task.jiraKey).then(() => message.success(`已复制任务号 ${task.jiraKey}`)).catch(() => {}); }}
              >
                <code>{task.jiraKey}</code>
              </Typography.Text>
            </Tooltip>
            <Typography.Text type="secondary">{jira ? jira.type : taskTypeLabel(task.type)}</Typography.Text>
            {jira?.url && (
              <Typography.Link href={jira.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                <Space size={3}><ExternalLink size={12} />查看 Jira 原单</Space>
              </Typography.Link>
            )}
            {boundRepoPath && <Tag color="geekblue">{boundRepoPath.split('/').pop()}</Tag>}
          </Space>
          {editingTitle ? (
            <div className="tf-task-inline-title-editor">
              <Input
                autoFocus
                value={titleDraft}
                maxLength={200}
                disabled={busy}
                aria-label="编辑任务标题"
                onChange={e => setTitleDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveInlineTitle();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingTitle(false);
                    setTitleDraft(task.title);
                  }
                }}
              />
              <Button type="primary" size="small" icon={<Check size={14} />} disabled={busy} aria-label="保存标题" onClick={saveInlineTitle} />
              <Button size="small" icon={<X size={14} />} disabled={busy} aria-label="取消编辑标题" onClick={() => { setEditingTitle(false); setTitleDraft(task.title); }} />
            </div>
          ) : (
            <div className="tf-task-title-editable">
              <Typography.Title
                level={1}
                className="tf-task-title"
                onDoubleClick={() => {
                  if (canEdit && !inputsFrozen && !busy) {
                    setTitleDraft(task.title);
                    setEditingTitle(true);
                  }
                }}
              >
                {task.title}
              </Typography.Title>
              {canEdit && !inputsFrozen && (
                <Tooltip title="编辑标题（或双击标题直接修改，按回车保存）">
                  <Button
                    type="text"
                    size="small"
                    className="tf-task-title-edit-btn"
                    icon={<Pencil size={14} />}
                    disabled={busy}
                    aria-label="编辑任务标题"
                    onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
                  />
                </Tooltip>
              )}
            </div>
          )}
          <Flex align="center" gap={12} wrap className="tf-task-summary-meta">
            {jira && <Space size={8}><Typography.Text type="secondary">Jira</Typography.Text><StatusBadge variant="blue">{jira.status}</StatusBadge></Space>}
            <Space size={8}>
              <Typography.Text type="secondary">本地状态</Typography.Text>
              {canEdit && !doneAncestor ? (
                <Select
                  size="small"
                  aria-label="快速切换本地状态"
                  value={task.status}
                  disabled={busy}
                  popupMatchSelectWidth={false}
                  options={TASK_STATUS_OPTIONS.map(opt => ({ ...opt, disabled: opt.value === 'DONE' && task.status !== 'DONE' && !canComplete }))}
                  onChange={quickSwitchStatus}
                />
              ) : (
                <StatusBadge variant={task.status === 'DONE' ? 'green' : 'neutral'}>{taskStatusLabel(task.status)}</StatusBadge>
              )}
            </Space>
            <Space size={8}>
              <Typography.Text type="secondary">本地受理人</Typography.Text>
              {canAssign && !inputsFrozen ? (
                <Select<string>
                  size="small"
                  aria-label="快速切换本地受理人"
                  value={task.assigneeId || ''}
                  disabled={busy}
                  popupMatchSelectWidth={false}
                  options={[{ value: '', label: '未指派' }, ...members.map(member => ({ value: member.id, label: member.username }))]}
                  onChange={quickSwitchAssignee}
                />
              ) : (
                <Typography.Text className="tf-break">{memberName(members, task.assigneeId)}</Typography.Text>
              )}
              {canClaim && <Button type="link" size="small" style={{ paddingInline: 2 }} disabled={busy} onClick={claimTaskNow}>认领</Button>}
            </Space>
          </Flex>
        </div>
        <Space size={4}>
          <Button type="text" icon={<RefreshCw size={16} />} disabled={busy} onClick={() => void run(refresh)}>刷新</Button>
          {(permissions.assignTasks || task.ownerId === user.id) && (
            <Button
              type="text"
              danger
              icon={<Trash2 size={15} />}
              disabled={busy}
              onClick={() => {
                modal.confirm({
                  title: children.length ? `移出 ${task.jiraKey} 及其子任务？` : `移出任务 ${task.jiraKey}？`,
                  content: '仅从当前本地工作台移除该任务及关联的本地材料/评审记录，不会修改或删除外部 Jira 事项。',
                  okText: '移出工作台',
                  cancelText: '取消',
                  okButtonProps: { danger: true },
                  onOk: () => run(async () => {
                    const res = await api<{ deletedCount: number }>('tasks/' + task.id + '?cascade=1', undefined, 'DELETE');
                    void message.success(`已从工作台移出 ${res.deletedCount} 项任务。`);
                    await onChanged();
                    onOpenTask('');
                  }),
                });
              }}
            >
              移出
            </Button>
          )}
        </Space>
      </Flex>
      <Flex gap={8} wrap className="tf-task-summary-actions">
        {canComplete && task.status !== 'DONE' && canEdit && !doneAncestor && (
          <Button type="primary" icon={<CheckCircle2 size={16} />} onClick={completeTaskNow}>一键完成核验</Button>
        )}
        <Button type={canComplete && task.status !== 'DONE' ? 'default' : 'primary'} icon={<Sparkles size={16} />} disabled={busy} onClick={() => openLocalWorkflow({ mode: workflowMode })}>本地 AI 一键处理</Button>
        <Dropdown trigger={['click']} disabled={busy} menu={{ items: moreActions, onClick: ({ key }) => runMoreAction(key) }}>
          <Button>更多操作<ChevronDown size={14} /></Button>
        </Dropdown>
      </Flex>
    </Card>

    <div ref={panelRef} className="tf-detail-panel"><Tabs more={{ trigger: 'click', icon: <MoreHorizontal size={16} aria-label="更多页签" /> }} locale={{ dropdownAriaLabel: '更多页签' }} className="tf-task-tabs" activeKey={tab} onChange={changeTab} items={[
      { key: 'chain', label: '交付链路', children: chainPanel },
      { key: 'overview', label: '任务信息', children: overview },
      { key: 'assets', label: '材料 (' + assets.length + ')', children: assetPanel },
      { key: 'reviews', label: '评审 (' + jobs.length + ')', children: reviewPanel },
      { key: 'release', label: '门禁与发布 (' + passedGateCount + '/' + STAGES.length + ')', children: releasePanel },
      { key: 'activity', label: '开发进度', children: activityPanel },
    ]} /></div>

    <Drawer forceRender title="编辑任务" size={640} className="tf-task-detail-drawer" open={drawer === 'task'} closable={!busy} keyboard={!busy} maskClosable={!busy} onClose={closeDrawer} footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeDrawer}>取消</Button><Button type="primary" loading={busy} disabled={!canEdit || !!doneAncestor} onClick={() => taskForm.submit()}>保存任务</Button></Flex>}>{taskEditor}</Drawer>
    <Drawer
      forceRender
      title="导入 / 添加任务材料"
      size={680}
      className="tf-task-detail-drawer"
      open={drawer === 'asset'}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      onClose={closeDrawer}
      footer={<Flex justify="flex-end" gap={8}>
        <Button disabled={busy} onClick={closeDrawer}>取消</Button>
        <Button
          type="primary"
          loading={busy}
          disabled={inputsFrozen || !allowedKinds.length || (assetInputMode === 'git' && !boundRepoPath)}
          onClick={assetDrawerPrimaryAction}
        >
          {assetInputMode === 'link' ? '一键拉取并保存' : assetInputMode === 'git' ? (gitStatus?.tccProtected ? '从剪贴板保存代码改动' : '提取 Git 改动并保存') : '保存新版本'}
        </Button>
      </Flex>}
    >
      {assetEditor}
    </Drawer>
    <Drawer forceRender title="发起评审" size={640} className="tf-task-detail-drawer" open={drawer === 'review'} closable={!busy} keyboard={!busy} maskClosable={!busy} onClose={closeDrawer} footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeDrawer}>取消</Button><Button type="primary" loading={busy} disabled={!allowedStages.length || inputsFrozen} onClick={() => reviewForm.submit()}>登记评审申请</Button></Flex>}>{reviewEditor}</Drawer>
    <Drawer title="环节审核报告" size={920} className="tf-task-detail-drawer" open={!!chainReviewJobId} onClose={() => setChainReviewJobId('')} destroyOnHidden>
      {chainReviewJobId && <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}><ReviewDetail key={chainReviewJobId} jobId={chainReviewJobId} task={task} user={user} role={role} members={members} repoPath={boundRepoPath} constitutionFiles={gitStatus?.constitutionFiles || []} onChanged={changed} onUnauthorized={onUnauthorized} onForbidden={handleForbidden} onOpenJob={id => setChainReviewJobId(id)} readOnly={inputsFrozen} /></Suspense>}
    </Drawer>
    {(decomposeOpen || decomposeEverOpened) && (
      <Suspense fallback={null}>
        <SubtaskDecomposeModal
          open={decomposeOpen && !busy && !inputsFrozen}
          onClose={() => setDecomposeOpen(false)}
          parentTask={task}
          assets={assets}
          existingTasks={allTasks || tasks}
          members={members}
          currentUser={user}
          canAssign={permissions.assignTasks}
          onCreated={changed}
        />
      </Suspense>
    )}
    {(gitHandoffOpen || gitHandoffEverOpened) && (
      <Suspense fallback={null}>
        <GitHandoffModal
          open={gitHandoffOpen && !busy}
          onClose={() => setGitHandoffOpen(false)}
          task={task}
          assets={assets}
          gates={gates}
          repoPath={boundRepoPath}
          currentBranch={gitStatus?.branch}
        />
      </Suspense>
    )}
    {(contextPackOpen || contextPackEverOpened) && (
      <Suspense fallback={null}>
        <TaskContextPackModal
          open={contextPackOpen && !busy}
          onClose={() => setContextPackOpen(false)}
          task={task}
          assets={assets}
          jobs={jobs}
          gates={gates}
          progressEvents={context?.progressEvents || []}
          repoPath={boundRepoPath}
          constitutionFiles={gitStatus?.constitutionFiles}
        />
      </Suspense>
    )}
    {(localWorkflowOpen || localWorkflowEverOpened) && (
      <Suspense fallback={null}>
        <LocalTaskWorkflow
          key={user.id + ':' + role + ':' + task.id}
          userId={user.id}
          open={localWorkflowOpen && !busy}
          onClose={() => setLocalWorkflowOpen(false)}
          task={task}
          jobs={jobs}
          role={role}
          canDevelop={canEdit && !inputsFrozen}
          frozen={inputsFrozen}
          canCreateLocalReview={!inputsFrozen && !!allowedStages.length}
          constitutionFiles={gitStatus?.constitutionFiles}
          initialMode={workflowInit.mode}
          initialStage={workflowInit.stage}
          initialJobId={workflowInit.jobId}
          initialRunner={workflowInit.runner}
          onChanged={changed}
          onOpenReview={id => { setLocalWorkflowOpen(false); if (tab === 'chain') setChainReviewJobId(id); else openReview(id); }}
          onOpenAssets={() => { setLocalWorkflowOpen(false); changeTab('assets'); }}
          onCreateLocalReview={() => { if (inputsFrozen || !allowedStages.length) return; setLocalWorkflowOpen(false); changeTab('reviews'); openDrawer('review'); reviewForm.setFieldValue('executionMode', 'LOCAL_REPORT'); }}
        />
      </Suspense>
    )}
  </div></Spin>;
};

import React, { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Collapse, Descriptions, Drawer, Empty, Flex, Input, Segmented, Select, Space, Spin, Tag, Typography } from 'antd';
import { Check, Copy, ExternalLink, FileCheck2, FilePlus2, FolderGit2, FolderOpen, Play, RefreshCw, Settings2, Sparkles, Square, Terminal } from 'lucide-react';
import {
  api, ApiError, ASSET_ROLES, AssetKind, LocalAiEngineId, LocalAiRun, LocalAiRunner, LocalAutomationCapabilities, LocalGitRepo, openWorkbench, TeamAgent, TeamSkillItem,
  ProjectWorkspace, REVIEW_ROLES, REVIEW_STAGE_OPTIONS, ReviewJob, Role, SkillScopeId, Stage, timeText, WorkTask,
} from './workspaceApi';
import { buildCompanionSyncCommand, buildLocalTaskPrompt, LOCAL_TASK_TARGETS, localReviewCandidates, LocalTaskMode, LocalTaskTarget } from './localTaskWorkflowPrompt';
import { extractTaskSmartHints } from './taskSmartLinks';
import { aiRunModeLabel, aiRunStatusLabel, runLocationLabel, severityLabel, stageLabel, taskStatusLabel } from './displayLabels';
import { isSubmitShortcut, readStoredBool, writeStoredBool } from './uiPreferences';
import { StatusBadge } from '../components/Primitives';
import { bridgeInstallCommand } from './bridgeInstall';
import { ChecklistTable, draftExtras, VerdictTag } from './ChainReportBits';
import { MarkdownPreview } from './MarkdownPreview';
import { plainReviewText, ReviewFindingContent, sortReviewFindings } from './ReviewFindingContent';
import { ReviewExportActions } from './ReviewExportActions';
import { parseAiRunOutput } from './aiRunOutputParser';
import { navigateWorkspace } from './workspaceNavigation';
import { requiresTaskReview } from './taskAvailability';
import { AiRunIdentity, aiRunModelLabel, availableAiEngine, LocalAiExecutionFields, readAiEngine, readAiEngineOverride, useAiModelSelection } from './LocalAiExecutionFields';

const AI_AUTO_SUBMIT_KEY = 'taskflow.ai.autoSubmitReport';

type WorkflowScene = 'review' | 'tech_spec' | 'develop' | 'jira' | 'test_case' | 'analyze';

const isValidTarget = (value: string | undefined): value is LocalTaskTarget => LOCAL_TASK_TARGETS.some(item => item.value === value);

const targetToEngine = (target: LocalTaskTarget): LocalAiEngineId => {
  if (target === 'antigravity') return 'antigravity';
  if (target === 'cursor') return 'cursor';
  if (target === 'claude') return 'claude';
  return 'codex';
};

function targetScopesForScene(scene: WorkflowScene, stage?: Stage | ''): SkillScopeId[] {
  if (scene === 'review') {
    if (stage === 'PRD') return ['PRD_REVIEW'];
    if (stage === 'TASK_BREAKDOWN') return ['JIRA_GEN'];
    if (stage === 'TECH_SPEC') return ['TECH_SPEC_REVIEW'];
    if (stage === 'CODE_REVIEW') return ['CODE_REVIEW'];
    if (stage === 'TEST_CASE') return ['TEST_CASE'];
    if (stage === 'RELEASE') return ['RELEASE'];
    return ['CODE_REVIEW'];
  }
  if (scene === 'tech_spec') return ['TECH_SPEC_GEN'];
  if (scene === 'develop') return ['CODE_GEN'];
  if (scene === 'jira') return ['JIRA_GEN'];
  if (scene === 'test_case') return ['TEST_CASE'];
  return ['PRD_REVIEW', 'TECH_SPEC_REVIEW', 'CODE_REVIEW'];
}

function sceneLabel(scene: WorkflowScene): string {
  switch (scene) {
    case 'review': return 'AI 评审';
    case 'tech_spec': return '写技术方案';
    case 'develop': return '写代码';
    case 'jira': return '拆 Jira 任务';
    case 'test_case': return '写测试用例';
    default: return '任务分析';
  }
}

export const LocalTaskWorkflow: React.FC<{
  open: boolean; onClose: () => void; userId: string; task: WorkTask; jobs: ReviewJob[]; role: Role;
  canDevelop: boolean; frozen: boolean; canCreateLocalReview: boolean;
  constitutionFiles?: string[];
  initialMode?: LocalTaskMode; initialStage?: Stage; initialJobId?: string; initialRunner?: LocalAiRunner;
  onOpenAssets: () => void; onCreateLocalReview: () => void;
  onChanged?: () => Promise<void>; onOpenReview?: (jobId: string) => void;
}> = ({
  open, onClose, userId, task, jobs, role, canDevelop, frozen, canCreateLocalReview,
  constitutionFiles, initialMode, initialStage, initialJobId, initialRunner, onOpenAssets, onCreateLocalReview, onChanged, onOpenReview,
}) => {
  const { message } = App.useApp();
  const canDraftSubtasks = requiresTaskReview(task, 'TASK_BREAKDOWN');
  const allowedStages = (Object.keys(REVIEW_ROLES) as Stage[]).filter(stage => requiresTaskReview(task, stage) && REVIEW_ROLES[stage].includes(role));
  const candidates = localReviewCandidates(task, jobs.filter(job => job.reviewRequired !== false), { frozen, allowedStages });
  const candidateScope = JSON.stringify(candidates.map(job => [job.id, job.inputHash, job.stage]));

  const [scene, setScene] = useState<WorkflowScene>('review');
  const [outputView, setOutputView] = useState<'readable' | 'raw'>('readable');
  const [repoEditorOpen, setRepoEditorOpen] = useState(false);
  const [target, setTarget] = useState<LocalTaskTarget>('workbench');
  const [runner, setRunner] = useState<LocalAiRunner>('local');
  const [engine, setEngine] = useState(readAiEngine);
  const [jobId, setJobId] = useState('');
  const [reviewStage, setReviewStage] = useState<Stage | ''>('');
  const [autoClaim, setAutoClaim] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [autoSubmitReport, setAutoSubmitReport] = useState(() => readStoredBool(AI_AUTO_SUBMIT_KEY, false));
  const [customInstruction, setCustomInstruction] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedSync, setCopiedSync] = useState(false);
  const [copying, setCopying] = useState(false);
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [repoInput, setRepoInput] = useState('');
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [openingApp, setOpeningApp] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [repositories, setRepositories] = useState<LocalGitRepo[]>([]);
  const [projectSkills, setProjectSkills] = useState<TeamSkillItem[]>([]);
  const [pickedSkillIds, setPickedSkillIds] = useState<string[]>([]);
  const [runs, setRuns] = useState<LocalAiRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [startingRun, setStartingRun] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [submittingDraft, setSubmittingDraft] = useState(false);
  const [savingGeneratedAsset, setSavingGeneratedAsset] = useState(false);
  const [rescanningRepos, setRescanningRepos] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [teamAgents, setTeamAgents] = useState<TeamAgent[]>([]);

  const sequence = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const workspaceSeq = useRef(0);
  const targetTouched = useRef(false);
  const runnerTouched = useRef(false);
  const prevRunningIds = useRef<Set<string>>(new Set());
  const consoleRef = useRef<HTMLPreElement>(null);

  const serverMode = capabilities?.deployment === 'server';
  const bridgeModes = serverMode ? capabilities?.bridgeModes || ['read'] : null;
  const bridgeDevices = serverMode ? (capabilities?.devices || []).filter(device => device.projectIds.includes(task.projectId)) : [];
  const memberAgents = serverMode ? teamAgents.filter(agent => !agent.mine && agent.dispatchable) : [];
  const dispatchTargets = [
    ...bridgeDevices.map(device => ({ id: device.id, deviceName: device.deviceName, online: device.online, lastSeenAt: device.lastSeenAt, modelEngines: device.modelEngines, owner: null as TeamAgent['owner'] | null })),
    ...memberAgents.map(agent => ({ id: agent.id, deviceName: agent.deviceName, online: agent.online, lastSeenAt: agent.lastSeenAt, modelEngines: agent.modelEngines, owner: agent.owner })),
  ];
  const selectedDevice = dispatchTargets.find(device => device.id === deviceId) || null;
  const frozenTask = frozen || task.status === 'DONE';
  const canLaunchDevelop = !frozenTask && (canDevelop || !task.assigneeId) && (!bridgeModes || bridgeModes.includes('develop'));
  const canLaunchReview = !frozenTask && !!allowedStages.length && (!bridgeModes || bridgeModes.includes('review'));

  const safeScene: WorkflowScene =
    frozenTask && (scene === 'develop' || scene === 'review') ? 'analyze'
    : scene === 'develop' && !canLaunchDevelop ? 'analyze'
    : scene === 'review' && !canLaunchReview ? 'analyze'
    : scene === 'jira' && !canDraftSubtasks ? 'analyze'
    : scene;
  const safeMode: LocalTaskMode = safeScene === 'develop' ? 'develop' : safeScene === 'review' ? 'review' : 'read';

  const activeStageForSkills: Stage | '' = safeScene === 'review'
    ? (candidates.find(c => c.id === jobId)?.stage || reviewStage)
    : '';
  const sceneTargetScopes = targetScopesForScene(safeScene, activeStageForSkills);
  const autoMatchedSkills = projectSkills.filter(
    s => s.enabled && (!s.scopes.length || s.scopes.some(sc => sceneTargetScopes.includes(sc))),
  );

  let prompt = '';
  try {
    prompt = buildLocalTaskPrompt({ task, jobs, mode: safeMode, target, selectedJobId: jobId, canDevelop: canDevelop || !task.assigneeId, frozen, allowedStages, repoPath: workspace?.repoPath });
  } catch { /* Unavailable or changed candidates leave manual copying disabled until selected again. */ }
  const companionCommand = safeMode === 'develop' ? buildCompanionSyncCommand({ task, target, repoPath: workspace?.repoPath }) : '';
  const scope = JSON.stringify([open, userId, task.id, task.projectId, task.version, task.status, role, canDevelop, frozen, canCreateLocalReview, safeScene, target, jobId, candidateScope, workspace?.repoPath || '', prompt]);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  const smartHints = extractTaskSmartHints(task, repositories);
  const runningRun = runs.find(item => item.status === 'RUNNING') || null;
  const activeRun = runs.find(item => item.id === selectedRunId) || runningRun;
  const parsedOutput = activeRun ? parseAiRunOutput(activeRun.output || '', {
    status: activeRun.status,
    mode: activeRun.mode,
    actionType: activeRun.actionType,
    runner: activeRun.runner,
    bridgePhase: activeRun.bridgePhase,
    draftAnswer: activeRun.draft?.answer,
    hasReviewDraft: activeRun.mode === 'review' && !!activeRun.draft,
  }) : null;
  const workbench = !serverMode && runner === 'workbench';
  const bridgeCommand = bridgeInstallCommand(location.origin);
  const selectedEngine = workbench && engine !== 'cursor' ? 'codex' : engine;
  const executionRunner = serverMode ? 'bridge' : workbench ? 'workbench' : 'local';
  const model = useAiModelSelection(capabilities, selectedEngine, executionRunner, selectedDevice?.modelEngines, selectedDevice?.id);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; workspaceSeq.current += 1; pending.current = false; };
  }, []);

  useEffect(() => {
    sequence.current += 1; pending.current = false; setCopying(false); setCopied(false); setCopiedSync(false);
  }, [scope]);

  const loadRuns = async (ownerTask: string) => {
    try {
      const data = await api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(ownerTask)}/ai-runs`);
      if (!mounted.current || ownerTask !== task.id) return;
      const prev = prevRunningIds.current;
      const nowRunning = new Set(data.runs.filter(r => r.status === 'RUNNING').map(r => r.id));
      const finishedJustNow = [...prev].some(id => !nowRunning.has(id));
      prevRunningIds.current = nowRunning;
      setRuns(data.runs);
      if (finishedJustNow) void onChanged?.().catch(() => {});
    } catch { /* Non-fatal in demo or restricted sessions */ }
  };

  const pollSingleRun = async (ownerTask: string, runId: string) => {
    try {
      const data = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(runId)}`);
      if (!mounted.current || ownerTask !== task.id) return;
      const updated = data.run;
      const wasRunning = prevRunningIds.current.has(updated.id);
      if (updated.status !== 'RUNNING') prevRunningIds.current.delete(updated.id);
      setRuns(current => current.map(item => item.id === updated.id ? updated : item));
      if (wasRunning && updated.status !== 'RUNNING') void onChanged?.().catch(() => {});
    } catch {
      await loadRuns(ownerTask);
    }
  };

  const rescanRepositories = async () => {
    if (rescanningRepos) return;
    setRescanningRepos(true);
    try {
      const res = await api<{ repositories: LocalGitRepo[] }>('local-git/repositories?refresh=1');
      if (mounted.current) {
        setRepositories(res.repositories || []);
        void message.success(`已扫描到 ${res.repositories?.length || 0} 个本机 Git 仓库。`);
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '扫描本机仓库失败。');
    } finally {
      if (mounted.current) setRescanningRepos(false);
    }
  };

  useEffect(() => {
    targetTouched.current = false;
    runnerTouched.current = false;
    const storedEngine = readAiEngineOverride();
    const desiredScene: WorkflowScene =
      initialMode === 'review' && !frozenTask ? 'review'
      : initialMode === 'develop' && !frozenTask ? 'develop'
      : !frozenTask && canLaunchReview ? 'review'
      : 'analyze';
    setScene(desiredScene);
    setRunner(initialRunner || 'local');
    setDeviceId('');
    setRuns([]);
    setPickedSkillIds([]);
    setRepoEditorOpen(false);
    setTarget('workbench');
    setEngine(storedEngine || 'codex');
    const stageCandidate = initialStage ? candidates.find(item => item.stage === initialStage)?.id : undefined;
    setJobId(initialJobId || stageCandidate || (initialStage ? '__auto__' : open && candidates.length === 1 ? candidates[0].id : ''));
    setReviewStage(initialStage || allowedStages[0] || '');
    setAutoClaim(true);
    setAutoSubmitReport(readStoredBool(AI_AUTO_SUBMIT_KEY, false));
    setCustomInstruction('');
    setWorkspace(null);
    setRepoInput('');
    setSelectedRunId('');
    prevRunningIds.current = new Set();
    if (!open) return;

    const reqId = ++workspaceSeq.current;
    const ownerProject = task.projectId;
    const ownerTask = task.id;
    const ownerUser = userId;

    void Promise.allSettled([
      api<{ workspace: ProjectWorkspace | null }>(`projects/${encodeURIComponent(ownerProject)}/workspace`),
      api<LocalAutomationCapabilities>('local-automation/capabilities'),
      api<{ repositories: LocalGitRepo[] }>('local-git/repositories'),
      api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(ownerTask)}/ai-runs`),
      api<{ agents: TeamAgent[] }>(`agents?projectId=${encodeURIComponent(ownerProject)}`),
      api<{ skills: TeamSkillItem[] }>(`skills?projectId=${encodeURIComponent(ownerProject)}&enabled=1`),
    ]).then(([wsRes, capRes, repoRes, runRes, agentRes, skillRes]) => {
      if (!mounted.current || reqId !== workspaceSeq.current || ownerProject !== task.projectId || ownerUser !== userId) return;
      if (wsRes.status === 'fulfilled') {
        setWorkspace(wsRes.value.workspace);
        setRepoInput(wsRes.value.workspace?.repoPath || '');
        if (!targetTouched.current && isValidTarget(wsRes.value.workspace?.defaultTarget)) {
          setTarget(wsRes.value.workspace.defaultTarget);
          if (!storedEngine) setEngine(targetToEngine(wsRes.value.workspace.defaultTarget));
        }
      }
      if (capRes.status === 'fulfilled') {
        setCapabilities(capRes.value);
        if (capRes.value.deployment === 'server') {
          setRunner('bridge');
          const scoped = (capRes.value.devices || []).filter(device => device.projectIds.includes(ownerProject));
          setDeviceId((scoped.find(device => device.online) || scoped[0])?.id || '');
        } else if (!initialRunner && !runnerTouched.current && capRes.value.apps.workbenchUrl && capRes.value.apps.workbenchProjectIds?.includes(ownerProject)) {
          setRunner('workbench');
        }
        setEngine(current => availableAiEngine(capRes.value, current));
      }
      const agents = agentRes.status === 'fulfilled' ? agentRes.value.agents || [] : [];
      setTeamAgents(agents);
      if (capRes.status === 'fulfilled' && capRes.value.deployment === 'server' && !(capRes.value.devices || []).some(device => device.projectIds.includes(ownerProject))) {
        const fallback = agents.filter(agent => !agent.mine && agent.dispatchable);
        setDeviceId((fallback.find(agent => agent.online) || fallback[0])?.id || '');
      }
      if (repoRes.status === 'fulfilled') setRepositories(repoRes.value.repositories || []);
      if (skillRes.status === 'fulfilled') setProjectSkills(skillRes.value.skills || []);
      if (runRes.status === 'fulfilled') {
        const list = runRes.value.runs || [];
        prevRunningIds.current = new Set(list.filter(r => r.status === 'RUNNING').map(r => r.id));
        setRuns(list);
        const ongoing = list.find(run => run.status === 'RUNNING');
        if (ongoing) setSelectedRunId(ongoing.id);
      }
    });
  }, [open, userId, task.id, task.projectId, role, initialMode, initialStage, initialJobId, initialRunner]);

  useEffect(() => {
    const runningIds = runs.filter(item => item.status === 'RUNNING').map(item => item.id);
    if (!open || !runningIds.length) return;
    const ownerTask = task.id;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (runningIds.length === 1) void pollSingleRun(ownerTask, runningIds[0]);
      else void loadRuns(ownerTask);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [open, task.id, runs.filter(item => item.status === 'RUNNING').map(item => item.id).join(',')]);

  const hasWorkbenchRuns = runs.some(run => run.runner === 'workbench');
  useEffect(() => {
    if (!open || !hasWorkbenchRuns) return;
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') void loadRuns(task.id);
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => document.removeEventListener('visibilitychange', refreshOnReturn);
  }, [open, task.id, hasWorkbenchRuns]);

  useEffect(() => {
    const el = consoleRef.current;
    if (!el || activeRun?.status !== 'RUNNING') return;
    el.scrollTop = el.scrollHeight;
  }, [activeRun?.id, activeRun?.status, activeRun?.output]);

  useEffect(() => {
    if (jobId && jobId !== '__auto__' && !candidates.some(job => job.id === jobId)) setJobId('');
  }, [candidateScope, jobId]);

  const close = () => {
    sequence.current += 1; workspaceSeq.current += 1; pending.current = false;
    setCopied(false); setCopiedSync(false); onClose();
  };
  const leave = (action: () => void) => { close(); action(); };

  const bindWorkspacePath = async (pathValue: string) => {
    const trimmed = pathValue.trim();
    if (!trimmed) { void message.warning('请选择或输入本机业务代码仓库的绝对路径。'); return; }
    const reqId = ++workspaceSeq.current;
    setSavingWorkspace(true);
    try {
      const data = await api<{ workspace: ProjectWorkspace | null }>(`projects/${encodeURIComponent(task.projectId)}/workspace`, { repoPath: trimmed, defaultTarget: target }, 'PUT');
      if (!mounted.current || reqId !== workspaceSeq.current) return;
      setWorkspace(data.workspace);
      setRepoInput(data.workspace?.repoPath || trimmed);
      setRepoEditorOpen(false);
      void message.success(`已绑定本地仓库：${data.workspace?.repoPath || trimmed}`);
      void onChanged?.().catch(() => {});
    } catch (error) {
      if (mounted.current && reqId === workspaceSeq.current) void message.error(error instanceof ApiError ? error.message : '保存目录绑定失败。');
    } finally {
      if (mounted.current && reqId === workspaceSeq.current) setSavingWorkspace(false);
    }
  };

  const clearWorkspace = async () => {
    const reqId = ++workspaceSeq.current;
    setSavingWorkspace(true);
    try {
      await api(`projects/${encodeURIComponent(task.projectId)}/workspace`, undefined, 'DELETE');
      if (!mounted.current || reqId !== workspaceSeq.current) return;
      setWorkspace(null); setRepoInput('');
      void message.success('已解除本地仓库绑定。');
      void onChanged?.().catch(() => {});
    } catch (error) {
      if (mounted.current && reqId === workspaceSeq.current) void message.error(error instanceof ApiError ? error.message : '解除绑定失败。');
    } finally {
      if (mounted.current && reqId === workspaceSeq.current) setSavingWorkspace(false);
    }
  };

  const openLocalApp = async (app: 'cursor' | 'terminal' | 'finder') => {
    const targetPath = (workspace?.repoPath || repoInput).trim();
    if (!targetPath) { void message.warning('请先绑定本地代码仓库目录。'); return; }
    setOpeningApp(app);
    try {
      await api('local-git/open', { projectId: task.projectId, app, repoPath: targetPath });
      if (mounted.current) {
        void message.success(app === 'finder' ? '已在 Finder 打开仓库。' : app === 'cursor' ? '已在 Cursor 打开仓库。' : '已在终端打开仓库。');
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '打开本地应用失败。');
    } finally {
      if (mounted.current) setOpeningApp(null);
    }
  };

  const launchAiRun = async () => {
    if (startingRun || runningRun || model.invalid) return;
    if (serverMode && !selectedDevice) {
      void message.warning('请先在本机配对并运行 Bridge，然后选择接收任务的设备。');
      return;
    }
    if (!serverMode && safeMode === 'develop' && !workspace?.repoPath && !repoInput.trim()) {
      void message.warning('AI 写代码需要先绑定本机业务 Git 仓库目录。');
      setRepoEditorOpen(true);
      return;
    }
    const workbenchTab = workbench ? window.open('about:blank', '_blank') : null;
    if (workbenchTab) workbenchTab.opener = null;
    let openedWorkbench = false;
    setStartingRun(true);
    try {
      if (!serverMode && !workspace?.repoPath && repoInput.trim().startsWith('/')) {
        const saved = await api<{ workspace: ProjectWorkspace | null }>(`projects/${encodeURIComponent(task.projectId)}/workspace`, { repoPath: repoInput.trim(), defaultTarget: target }, 'PUT');
        if (mounted.current) setWorkspace(saved.workspace);
      }
      const actionType =
        safeScene === 'tech_spec' ? 'TECH_SPEC_GEN'
        : safeScene === 'jira' ? 'SUBTASK_DRAFT'
        : safeScene === 'test_case' ? 'TEST_CASE_GEN'
        : 'DEFAULT';
      const payload: Record<string, unknown> = {
        mode: safeMode,
        engine: selectedEngine,
        ...(model.model ? { model: model.model } : {}),
        ...(actionType !== 'DEFAULT' ? { actionType } : {}),
        ...(pickedSkillIds.length ? { skillIds: pickedSkillIds } : {}),
        ...(workbench ? { runner } : {}),
        ...(serverMode && selectedDevice ? { runner: 'bridge', deviceId: selectedDevice.id } : {}),
        ...(customInstruction.trim() ? { customInstruction: customInstruction.trim() } : {}),
      };
      if (safeMode === 'develop' && !task.assigneeId && autoClaim && !selectedDevice?.owner) {
        payload.autoClaim = true;
      }
      if (safeMode === 'develop' && !workbench && !serverMode && useWorktree) {
        payload.useWorktree = true;
      }
      if (safeMode === 'review') {
        const chosenCandidate = candidates.find(item => item.id === jobId);
        if (chosenCandidate) {
          payload.jobId = chosenCandidate.id;
        } else if (reviewStage && allowedStages.includes(reviewStage)) {
          payload.stage = reviewStage;
        } else {
          void message.warning('请选择要评审的阶段。');
          setStartingRun(false);
          return;
        }
        if (!workbench && !serverMode && autoSubmitReport) payload.autoSubmitReport = true;
      }
      const res = await api<{ run: LocalAiRun; job?: ReviewJob }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`, payload);
      if (!mounted.current) return;
      if (res.run.status === 'RUNNING') prevRunningIds.current.add(res.run.id);
      setRuns(current => [res.run, ...current.filter(item => item.id !== res.run.id)]);
      setSelectedRunId(res.run.id);
      if (res.job) setJobId(res.job.id);
      if (workbench && workbenchTab && res.run.workbenchUrl) {
        workbenchTab.location.replace(res.run.workbenchUrl);
        openedWorkbench = true;
      }
      void message.success(serverMode ? '已派发到本机执行。' : workbench ? '已打开工作台会话。' : `已启动「${sceneLabel(safeScene)}」，下方实时展示结果。`);
      void onChanged?.().catch(() => {});
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '启动 AI 执行失败。');
    } finally {
      if (!openedWorkbench) workbenchTab?.close();
      if (mounted.current) setStartingRun(false);
    }
  };

  const stopAiRun = async (runId: string) => {
    setStoppingRun(true);
    try {
      const res = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(runId)}/stop`, {});
      if (!mounted.current) return;
      setRuns(current => current.map(item => item.id === res.run.id ? res.run : item));
      void message.info('已停止执行。');
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '停止执行失败。');
    } finally {
      if (mounted.current) setStoppingRun(false);
    }
  };

  const submitRunDraft = async (run: LocalAiRun) => {
    if (!run.jobId || !run.draft) return;
    setSubmittingDraft(true);
    try {
      await api(`jobs/${encodeURIComponent(run.jobId)}/report`, {
        source: 'LOCAL_TOOL',
        tool: run.tool || 'codex-cli',
        summary: run.draft.summary,
        ...(run.draft.evidence ? { evidence: run.draft.evidence } : {}),
        findings: run.draft.findings || [],
        ...draftExtras(run.draft),
      });
      if (!mounted.current) return;
      void message.success('已提交评审报告。');
      await onChanged?.();
      if (onOpenReview) leave(() => onOpenReview(run.jobId!));
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '提交评审报告失败。');
    } finally {
      if (mounted.current) setSubmittingDraft(false);
    }
  };

  const saveOutputAsAsset = async (kind: AssetKind, content: string) => {
    if (!content.trim() || frozenTask) return;
    setSavingGeneratedAsset(true);
    try {
      const title = kind === 'TECH_SPEC' ? `${task.jiraKey} 技术方案（AI 生成）` : `${task.jiraKey} 测试用例（AI 生成）`;
      await api(`tasks/${encodeURIComponent(task.id)}/assets`, { kind, title, content: content.slice(0, 65000) });
      if (!mounted.current) return;
      void message.success(`已保存为本任务的「${kind === 'TECH_SPEC' ? '技术方案' : '测试用例'}」材料。`);
      await onChanged?.();
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '保存材料失败。');
    } finally {
      if (mounted.current) setSavingGeneratedAsset(false);
    }
  };

  const copy = async (openWorkbenchAfter = false) => {
    const routeIsCurrent = () => {
      const route = new URLSearchParams(location.hash.slice(1));
      return route.get('task') === task.id && route.get('mode') !== 'demo';
    };
    if (!open || !prompt || pending.current || currentScope.current !== scope || !routeIsCurrent()) {
      if (openWorkbenchAfter) openWorkbench();
      return;
    }
    const ownerRoute = location.hash;
    const request = ++sequence.current; const owner = scope;
    pending.current = true; setCopying(true); setCopied(false);
    const ownsRequest = () => mounted.current && currentScope.current === owner && sequence.current === request;
    const current = () => ownsRequest() && location.hash === ownerRoute && routeIsCurrent();
    try {
      await navigator.clipboard.writeText(prompt);
      if (current()) {
        setCopied(true);
        void message.success(openWorkbenchAfter ? '指令已复制，正在打开工作台。' : '指令已复制。');
      }
      if (openWorkbenchAfter) openWorkbench();
    } catch {
      if (current()) void message.warning('复制未完成。');
    } finally {
      if (ownsRequest()) { pending.current = false; setCopying(false); }
    }
  };

  const copyCompanion = async () => {
    if (!companionCommand) return;
    try {
      await navigator.clipboard.writeText(companionCommand);
      if (mounted.current) { setCopiedSync(true); void message.success('命令已复制。'); }
    } catch { if (mounted.current) void message.warning('复制未完成。'); }
  };

  const draftJob = activeRun?.jobId ? jobs.find(j => j.id === activeRun.jobId) : undefined;
  const draftAlreadyReported = !!activeRun?.draft?.autoSubmitted || !!draftJob?.report;
  const canSaveTechSpec = !frozenTask && ASSET_ROLES.TECH_SPEC.includes(role);
  const canSaveTestCase = !frozenTask && ASSET_ROLES.TEST_CASE.includes(role);
  const activeRunLabel = (run: LocalAiRun) => {
    if (run.actionType === 'TECH_SPEC_GEN') return '写技术方案';
    if (run.actionType === 'SUBTASK_DRAFT') return '拆 Jira 任务';
    if (run.actionType === 'TEST_CASE_GEN') return '写测试用例';
    if (run.actionType === 'CHAIN_ANALYZE') return '一致性检查';
    return aiRunModeLabel(run.mode);
  };

  return <Drawer
    title={
      <Space size={8} wrap>
        <Sparkles size={16} />
        <span>AI 助手</span>
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>{task.jiraKey}</Tag>
      </Space>
    }
    open={open}
    onClose={close}
    size={820}
    destroyOnHidden
    footer={
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Space size={6} wrap>
          {!workbench && (
            <Button type="text" size="small" icon={<Copy size={13} />} disabled={!prompt} loading={copying} onClick={() => void copy(false)}>
              {copied ? '已复制提示词' : '复制提示词'}
            </Button>
          )}
          <Button type="text" size="small" icon={<Settings2 size={13} />} onClick={() => leave(() => navigateWorkspace('skills'))}>
            配置 Skills
          </Button>
        </Space>
        <Space size={8}>
          <Button onClick={close}>关闭</Button>
          {runningRun ? (
            <Button danger type="primary" icon={<Square size={14} />} loading={stoppingRun} onClick={() => void stopAiRun(runningRun.id)}>
              停止执行
            </Button>
          ) : (
            <Button type="primary" icon={<Play size={14} />} loading={startingRun} disabled={model.invalid || (serverMode && !selectedDevice)} onClick={() => void launchAiRun()}>
              {workbench ? '在工作台启动' : serverMode ? '派发执行' : `开始${sceneLabel(safeScene)}`}
            </Button>
          )}
        </Space>
      </Flex>
    }
  >
    <Flex vertical gap={14}>
      {/* Compact Task & Repo Strip */}
      <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--tf-border)', background: 'var(--tf-raised)', display: 'grid', gap: 8 }}>
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Typography.Text strong style={{ fontSize: 15 }}>{task.title}</Typography.Text>
          {!serverMode && (
            <Space size={4} wrap>
              {workspace?.repoPath ? (
                <>
                  <Tag icon={<FolderGit2 size={11} />} color="geekblue" style={{ marginInlineEnd: 0 }}>
                    {workspace.repoPath.split('/').pop()}
                  </Tag>
                  <Button size="small" type="text" icon={<ExternalLink size={12} />} loading={openingApp === 'cursor'} onClick={() => void openLocalApp('cursor')}>Cursor</Button>
                  <Button size="small" type="text" icon={<Terminal size={12} />} loading={openingApp === 'terminal'} onClick={() => void openLocalApp('terminal')}>终端</Button>
                  <Button size="small" type="text" icon={<FolderOpen size={12} />} loading={openingApp === 'finder'} onClick={() => void openLocalApp('finder')}>Finder</Button>
                  <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => setRepoEditorOpen(v => !v)}>
                    {repoEditorOpen ? '收起' : '切换'}
                  </Button>
                </>
              ) : (
                <Button size="small" icon={<FolderGit2 size={12} />} onClick={() => setRepoEditorOpen(v => !v)}>
                  绑定本地代码仓
                </Button>
              )}
            </Space>
          )}
        </Flex>

        {!serverMode && !workspace?.repoPath && smartHints.matchedRepos.length > 0 && !repoEditorOpen && (
          <Flex justify="space-between" align="center" gap={8} wrap style={{ paddingTop: 6, borderTop: '1px dashed var(--tf-divider)' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              检测到匹配的本机仓库：<code>{smartHints.matchedRepos[0].name}</code>
            </Typography.Text>
            <Button size="small" type="primary" ghost loading={savingWorkspace} onClick={() => void bindWorkspacePath(smartHints.matchedRepos[0].path)}>
              一键绑定
            </Button>
          </Flex>
        )}

        {!serverMode && repoEditorOpen && (
          <Flex vertical gap={8} style={{ paddingTop: 8, borderTop: '1px solid var(--tf-divider)' }}>
            {repositories.length > 0 && (
              <Flex gap={6}>
                <Select
                  size="small"
                  style={{ flex: 1 }}
                  showSearch={{ optionFilterProp: 'label' }}
                  placeholder="从本机扫描到的 Git 仓库选择"
                  value={repositories.some(r => r.path === repoInput) ? repoInput : undefined}
                  options={repositories.map(repo => ({ value: repo.path, label: `${repo.name}${repo.group ? ` (${repo.group})` : ''} · ${repo.path}` }))}
                  onChange={value => { setRepoInput(value); void bindWorkspacePath(value); }}
                />
                <Button size="small" icon={<RefreshCw size={12} />} loading={rescanningRepos} onClick={() => void rescanRepositories()}>重扫</Button>
              </Flex>
            )}
            <Flex gap={6}>
              <Input size="small" placeholder="/Users/you/workspace/repo" value={repoInput} disabled={savingWorkspace} onChange={e => setRepoInput(e.target.value)} />
              <Button size="small" type="primary" loading={savingWorkspace} onClick={() => void bindWorkspacePath(repoInput)}>保存</Button>
              {workspace && <Button size="small" danger disabled={savingWorkspace} onClick={() => void clearWorkspace()}>解除</Button>}
            </Flex>
          </Flex>
        )}
      </div>

      {serverMode && !dispatchTargets.length && (
        <Alert
          type="warning"
          showIcon
          title="尚未连接本机 Bridge"
          description={
            <Flex gap={8} align="center" style={{ marginTop: 4 }}>
              <Input size="small" readOnly value={bridgeCommand} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }} />
              <Button size="small" icon={<Copy size={13} />} onClick={() => { void navigator.clipboard.writeText(bridgeCommand).then(() => message.success('命令已复制。')); }}>复制</Button>
            </Flex>
          }
        />
      )}

      <section className="tf-ai-workflow-config" aria-label="执行配置">
        <Flex justify="space-between" align="center" gap={8}>
          <Typography.Text strong>执行配置</Typography.Text>
          {!serverMode && (
            <Segmented<LocalAiRunner>
              size="small"
              aria-label="执行位置"
              value={runner}
              options={[{ value: 'local', label: '本机' }, { value: 'workbench', label: '5288 工作台' }]}
              disabled={startingRun || !!runningRun}
              onChange={value => { runnerTouched.current = true; setRunner(value); }}
            />
          )}
        </Flex>
        <Segmented
          block
          aria-label="选择 AI 任务"
          value={safeScene}
          options={[
            { value: 'review', label: 'AI 评审', disabled: !canLaunchReview },
            { value: 'tech_spec', label: '写技术方案' },
            { value: 'develop', label: '写代码', disabled: !canLaunchDevelop },
            ...(canDraftSubtasks ? [{ value: 'jira', label: '拆 Jira 任务' }] : []),
            { value: 'test_case', label: '写测试用例' },
            { value: 'analyze', label: '任务分析' },
          ]}
          onChange={v => { setScene(v as WorkflowScene); setPickedSkillIds([]); }}
        />

        {(serverMode || safeScene === 'review') && <Flex gap={10} wrap align="center">
          {safeScene === 'review' && (
            <div style={{ flex: '1 1 220px' }}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>评审阶段</Typography.Text>
              {candidates.length > 0 ? (
                <Select
                  style={{ width: '100%' }}
                  value={candidates.some(job => job.id === jobId) ? jobId : '__auto__'}
                  options={[
                    ...candidates.map(job => ({ value: job.id, label: `待提交 · ${stageLabel(job.stage)} (${timeText(job.createdAt)})` })),
                    { value: '__auto__', label: '新建评审阶段…' },
                  ]}
                  onChange={val => setJobId(val)}
                />
              ) : (
                <Select
                  style={{ width: '100%' }}
                  value={reviewStage || undefined}
                  placeholder="选择评审阶段"
                  options={REVIEW_STAGE_OPTIONS.filter(s => allowedStages.includes(s.value)).map(s => ({ value: s.value, label: s.label }))}
                  onChange={val => setReviewStage(val)}
                />
              )}
            </div>
          )}

          {safeScene === 'review' && jobId === '__auto__' && candidates.length > 0 && (
            <div style={{ flex: '1 1 180px' }}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>新建阶段</Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={reviewStage || undefined}
                options={REVIEW_STAGE_OPTIONS.filter(s => allowedStages.includes(s.value)).map(s => ({ value: s.value, label: s.label }))}
                onChange={val => setReviewStage(val)}
              />
            </div>
          )}

          {serverMode && (
            <div style={{ flex: '1 1 200px' }}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>执行设备</Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={selectedDevice?.id}
                placeholder="未配对 Bridge"
                options={dispatchTargets.map(device => ({
                  value: device.id,
                  label: `${device.deviceName} · ${device.online ? '在线' : '离线'}`,
                }))}
                onChange={setDeviceId}
              />
            </div>
          )}
        </Flex>}

        <LocalAiExecutionFields
          capabilities={capabilities} engine={selectedEngine} onEngineChange={setEngine} model={model}
          runner={executionRunner} disabled={startingRun || !!runningRun}
        />

        {projectSkills.length > 0 && <Flex justify="space-between" align="center" gap={8} wrap>
          <Space size={6} wrap style={{ flex: 1, minWidth: 0 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Skills</Typography.Text>
            {pickedSkillIds.length > 0 ? (
              pickedSkillIds.map(id => {
                const s = projectSkills.find(item => item.id === id);
                return s ? <Tag key={id} color="blue" closable onClose={() => setPickedSkillIds(prev => prev.filter(x => x !== id))} style={{ marginInlineEnd: 0 }}>{s.title || s.name}</Tag> : null;
              })
            ) : autoMatchedSkills.length > 0 ? (
              autoMatchedSkills.slice(0, 5).map(s => (
                <Tag key={s.id} color="blue" style={{ marginInlineEnd: 0 }}>{s.title || s.name}</Tag>
              ))
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>默认规则</Typography.Text>
            )}
          </Space>
          <Space size={6}>
            <Select
              size="small"
              mode="multiple"
              allowClear
              maxTagCount={0}
              maxTagPlaceholder={() => `已指定 ${pickedSkillIds.length}`}
              style={{ width: 118 }}
              placeholder="指定 Skill"
              value={pickedSkillIds}
              options={projectSkills.map(s => ({ value: s.id, label: s.title || s.name }))}
              onChange={setPickedSkillIds}
            />
            <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => leave(() => navigateWorkspace('skills'))}>
              导入 / 配置 →
            </Button>
          </Space>
        </Flex>}

        <Input
          aria-label="补充要求"
          placeholder="补充要求（可选，按 Cmd/Ctrl + Enter 立即执行）"
          maxLength={500}
          value={customInstruction}
          onChange={e => setCustomInstruction(e.target.value)}
          onKeyDown={event => {
            if (isSubmitShortcut(event) && !runningRun && !startingRun) {
              event.preventDefault();
              void launchAiRun();
            }
          }}
        />

        {(['review', 'develop'].includes(safeScene) && !workbench && !serverMode || safeScene === 'develop' && !task.assigneeId && !frozenTask) && <Flex gap={14} wrap align="center">
          {safeScene === 'review' && !workbench && !serverMode && (
            <Checkbox checked={autoSubmitReport} onChange={e => { setAutoSubmitReport(e.target.checked); writeStoredBool(AI_AUTO_SUBMIT_KEY, e.target.checked); }}>
              <span style={{ fontSize: 12.5 }}>完成后自动提交为评审报告</span>
            </Checkbox>
          )}
          {safeScene === 'develop' && !workbench && !serverMode && (
            <Checkbox checked={useWorktree} onChange={e => setUseWorktree(e.target.checked)}>
              <span style={{ fontSize: 12.5 }}>使用隔离 git worktree 沙盒分支</span>
            </Checkbox>
          )}
          {safeScene === 'develop' && !task.assigneeId && !frozenTask && (
            <Checkbox checked={autoClaim} onChange={e => setAutoClaim(e.target.checked)}>
              <span style={{ fontSize: 12.5 }}>自动认领任务</span>
            </Checkbox>
          )}
        </Flex>}
      </section>

      {runs[0] && (
        <div className="tf-ai-run-history">
          <strong>执行记录</strong>
          <AiRunIdentity run={activeRun || runs[0]} />
          <Select<string>
            aria-label="执行记录"
            size="small"
            allowClear
            popupMatchSelectWidth={false}
            value={activeRun?.id}
            placeholder="查看历史执行"
            options={runs.map(item => ({
              value: item.id,
              label: `${activeRunLabel(item)} · ${aiRunStatusLabel(item.status)} · ${timeText(item.startedAt)} · ${aiRunModelLabel(item)}`,
            }))}
            onChange={id => { setSelectedRunId(id || ''); setOutputView('readable'); }}
          />
        </div>
      )}
      {runs.length > 0 && activeRun && (
        <div style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid var(--tf-border)', background: 'var(--tf-surface)', display: 'grid', gap: 12 }}>
          <Flex justify="space-between" align="center" gap={8} wrap>
            <Space size={6} wrap>
              <Typography.Text strong style={{ fontSize: 13.5 }}>执行结果</Typography.Text>
              <StatusBadge variant={activeRun.status === 'SUCCEEDED' ? 'green' : activeRun.status === 'RUNNING' ? 'blue' : activeRun.status === 'FAILED' ? 'block' : 'neutral'}>
                {aiRunStatusLabel(activeRun.status)}
              </StatusBadge>
              <Tag style={{ marginInlineEnd: 0 }}>{activeRunLabel(activeRun)}</Tag>
              <AiRunIdentity run={activeRun} />
              {activeRun.appliedSkills?.length ? (
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>Skills: {activeRun.appliedSkills.join(', ')}</Tag>
              ) : null}
              {activeRun.worktreeBranch && <Tag color="cyan" style={{ marginInlineEnd: 0 }}>{activeRun.worktreeBranch}</Tag>}
            </Space>
            <Space size={6} wrap>
              <Segmented
                size="small"
                value={outputView}
                options={[{ value: 'readable', label: '结果' }, { value: 'raw', label: '日志' }]}
                onChange={value => setOutputView(value === 'raw' ? 'raw' : 'readable')}
              />
              {(activeRun.output || parsedOutput?.finalMarkdown) && (
                <Button
                  size="small"
                  icon={<Copy size={12} />}
                  onClick={() => {
                    const copyText = outputView === 'raw' ? activeRun.output : (parsedOutput?.finalMarkdown || activeRun.draft?.summary || activeRun.output);
                    void navigator.clipboard.writeText(copyText).then(() => message.success('已复制。'));
                  }}
                >
                  复制
                </Button>
              )}
            </Space>
          </Flex>

          {activeRun.error && (
            <Alert type="warning" showIcon title={activeRun.error} />
          )}

          {activeRun.mode === 'review' && activeRun.draft && outputView === 'readable' && (
            <Flex vertical gap={12}>
              <div style={{ padding: '12px 14px', borderRadius: 8, background: 'var(--tf-raised)', border: '1px solid var(--tf-border)', display: 'grid', gap: 8 }}>
                <Flex justify="space-between" align="center" gap={8} wrap>
                  <Space size={6} wrap>
                    <FileCheck2 size={15} />
                    <Typography.Text strong>评审结论</Typography.Text>
                    <VerdictTag verdict={activeRun.draft.verdict} score={activeRun.draft.score} />
                  </Space>
                  <Space size={6} wrap>
                    <ReviewExportActions
                      data={{
                        task: { jiraKey: task.jiraKey, title: task.title, url: task.externalRef?.url || null },
                        stage: draftJob?.stage || (reviewStage || 'CODE_REVIEW'),
                        isDraft: !draftAlreadyReported,
                        stale: draftJob?.stale,
                        report: {
                          summary: activeRun.draft.summary,
                          evidence: activeRun.draft.evidence,
                          verdict: activeRun.draft.verdict,
                          score: activeRun.draft.score,
                          checklist: activeRun.draft.checklist,
                          meta: activeRun.draft.meta,
                          tool: activeRun.tool,
                          createdAt: activeRun.finishedAt || activeRun.updatedAt,
                        },
                        findings: activeRun.draft.findings || [],
                      }}
                    />
                    {draftAlreadyReported ? (
                      <>
                        <Tag color="success" style={{ marginInlineEnd: 0 }}>已提交报告</Tag>
                        {activeRun.jobId && onOpenReview && (
                          <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => leave(() => onOpenReview(activeRun.jobId!))}>
                            去查看 / 审批 →
                          </Button>
                        )}
                      </>
                    ) : activeRun.jobId && (
                      <Button type="primary" size="small" loading={submittingDraft} disabled={frozenTask || !!draftJob?.stale} onClick={() => void submitRunDraft(activeRun)}>
                        提交为评审报告
                      </Button>
                    )}
                  </Space>
                </Flex>
                <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                  {plainReviewText(activeRun.draft.summary)}
                </Typography.Paragraph>
              </div>

              {activeRun.draft.findings.length > 0 ? (
                <Flex vertical gap={8}>
                  <Typography.Text strong style={{ fontSize: 13 }}>发现的问题（{activeRun.draft.findings.length}）</Typography.Text>
                  {sortReviewFindings(activeRun.draft.findings).map((finding, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        border: '1px solid var(--tf-border)',
                        borderLeft: `3px solid ${finding.severity === 'CRITICAL' ? 'var(--tf-error, #dc2626)' : finding.severity === 'WARN' ? 'var(--tf-warning, #d97706)' : 'var(--tf-border)'}`,
                        background: 'var(--tf-surface)',
                      }}
                    >
                      <Space size={6} wrap>
                        <StatusBadge variant={finding.severity === 'CRITICAL' ? 'block' : finding.severity === 'WARN' ? 'warn' : 'neutral'}>{severityLabel(finding.severity)}</StatusBadge>
                        <Typography.Text strong>{plainReviewText(finding.title)}</Typography.Text>
                      </Space>
                      <div style={{ marginTop: 8 }}><ReviewFindingContent detail={finding.detail} location={finding.location} /></div>
                    </div>
                  ))}
                </Flex>
              ) : (
                <Tag color="success" style={{ alignSelf: 'flex-start' }}>未发现阻断或风险项</Tag>
              )}

              {!!activeRun.draft.checklist?.length && (
                <Flex vertical gap={6}>
                  <Typography.Text strong style={{ fontSize: 13 }}>逐项核查清单（{activeRun.draft.checklist.length}）</Typography.Text>
                  <ChecklistTable items={activeRun.draft.checklist} />
                </Flex>
              )}

              {activeRun.draft.evidence && (
                <section aria-label="核验依据与提交范围">
                  <Typography.Text strong>核验依据与提交范围</Typography.Text>
                  <Typography.Paragraph type="secondary" className="tf-break" style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{activeRun.draft.evidence}</Typography.Paragraph>
                </section>
              )}
            </Flex>
          )}

          {outputView === 'raw' ? (
            <pre ref={consoleRef} className="tf-code-panel" style={{ maxHeight: 320 }}>
              {activeRun.output || (activeRun.status !== 'RUNNING' ? '（无控制台输出）' : '正在执行，请稍候…')}
            </pre>
          ) : parsedOutput && !(activeRun.mode === 'review' && activeRun.draft) && (
            <Flex vertical gap={10}>
              {activeRun.status === 'RUNNING' && (
                <div style={{ padding: '10px 12px', background: 'var(--tf-raised)', border: '1px solid var(--tf-border)', borderRadius: 8 }}>
                  <Space size={8} align="center">
                    <Spin size="small" />
                    <Typography.Text strong style={{ fontSize: 13 }}>{parsedOutput.currentActivity}</Typography.Text>
                  </Space>
                </div>
              )}

              {parsedOutput.steps.length > 0 && activeRun.status === 'RUNNING' && (
                <div aria-label="执行进度" role="region" tabIndex={0} style={{ padding: '8px 12px', background: 'var(--tf-raised)', borderRadius: 8, display: 'grid', gap: 5, maxHeight: 200, overflow: 'auto' }}>
                  {parsedOutput.steps.map(step => (
                    <Flex key={step.id} align="center" justify="space-between" gap={8} style={{ fontSize: 12 }}>
                      <Space size={6} style={{ minWidth: 0 }}>
                        <span aria-hidden="true" style={{ display: 'block', width: 6, height: 6, borderRadius: '50%', background: step.status === 'failed' ? '#cf1322' : step.status === 'running' ? '#1677ff' : '#389e0d' }} />
                        <span className="tf-break">{step.title}</span>
                      </Space>
                      {step.duration && <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>{step.duration}</Typography.Text>}
                    </Flex>
                  ))}
                </div>
              )}

              {parsedOutput.finalMarkdown && (
                <>
                  {activeRun.status === 'SUCCEEDED' && activeRun.actionType === 'TECH_SPEC_GEN' && canSaveTechSpec && (
                    <Flex justify="flex-end">
                      <Button type="primary" size="small" icon={<FilePlus2 size={13} />} loading={savingGeneratedAsset} onClick={() => void saveOutputAsAsset('TECH_SPEC', parsedOutput.finalMarkdown!)}>
                        一键存为本任务「技术方案」材料
                      </Button>
                    </Flex>
                  )}
                  {activeRun.status === 'SUCCEEDED' && activeRun.actionType === 'TEST_CASE_GEN' && canSaveTestCase && (
                    <Flex justify="flex-end">
                      <Button type="primary" size="small" icon={<FilePlus2 size={13} />} loading={savingGeneratedAsset} onClick={() => void saveOutputAsAsset('TEST_CASE', parsedOutput.finalMarkdown!)}>
                        一键存为本任务「测试用例」材料
                      </Button>
                    </Flex>
                  )}
                  <div style={{ padding: '14px 16px', background: 'var(--tf-raised)', border: '1px solid var(--tf-border)', borderRadius: 8, maxHeight: 420, overflowY: 'auto' }}>
                    <MarkdownPreview content={parsedOutput.finalMarkdown} />
                  </div>
                </>
              )}
            </Flex>
          )}
        </div>
      )}

      <Collapse
        ghost
        size="small"
        items={[{
          key: 'manual-prompt',
          label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>高级：手动复制提示词 / 终端伴随同步命令</Typography.Text>,
          children: (
            <Flex vertical gap={10}>
              <Descriptions size="small" column={2} items={[
                { key: 'jira', label: '任务号', children: task.jiraKey },
                { key: 'status', label: '状态', children: taskStatusLabel(task.status) },
                ...(constitutionFiles?.length ? [{ key: 'const', label: '仓库规范', span: 2, children: constitutionFiles.join(' · ') }] : []),
              ]} />
              <Flex gap={8} align="center" wrap>
                <Select size="small" aria-label="目标工具" style={{ flex: '1 1 200px' }} value={target} options={LOCAL_TASK_TARGETS} onChange={value => { targetTouched.current = true; setTarget(value); setEngine(targetToEngine(value)); }} />
                <Button size="small" icon={copied ? <Check size={13} /> : <Copy size={13} />} disabled={!prompt} loading={copying} onClick={() => void copy(false)}>{copied ? '已复制' : '复制指令'}</Button>
                <Button size="small" onClick={() => openWorkbench()} icon={<ExternalLink size={13} />}>打开工作台</Button>
              </Flex>
              {prompt ? (
                <Input.TextArea readOnly value={prompt} autoSize={{ minRows: 4, maxRows: 10 }} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }} />
              ) : safeMode === 'review' ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待提交的评审申请。">
                  <Space wrap>
                    <Button size="small" onClick={() => leave(onOpenAssets)}>查看材料</Button>
                    {!frozenTask && canCreateLocalReview && allowedStages.length > 0 && <Button size="small" onClick={() => leave(onCreateLocalReview)}>手动发起评审</Button>}
                  </Space>
                </Empty>
              ) : null}
              {companionCommand && (
                <Flex gap={8} align="center">
                  <Input size="small" readOnly value={companionCommand} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }} />
                  <Button size="small" icon={copiedSync ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copyCompanion()}>{copiedSync ? '已复制' : '复制同步命令'}</Button>
                </Flex>
              )}
            </Flex>
          ),
        }]}
      />
    </Flex>
  </Drawer>;
};

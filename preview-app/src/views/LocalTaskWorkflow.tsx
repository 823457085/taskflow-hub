import React, { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Descriptions, Drawer, Empty, Flex, Input, Segmented, Select, Space, Tag, Typography } from 'antd';
import { Check, Copy, ExternalLink, FileCheck2, FolderGit2, FolderOpen, Play, RefreshCw, Sparkles, Square, Terminal } from 'lucide-react';
import {
  api, ApiError, LocalAiEngineId, LocalAiRun, LocalAiRunner, LocalAutomationCapabilities, LocalGitRepo, TeamAgent,
  ProjectWorkspace, REVIEW_ROLES, ReviewJob, Role, Stage, STAGES, timeText, WorkTask,
} from './workspaceApi';
import { buildCompanionSyncCommand, buildLocalTaskPrompt, LOCAL_TASK_TARGETS, localReviewCandidates, LocalTaskMode, LocalTaskTarget } from './localTaskWorkflowPrompt';
import { extractTaskSmartHints } from './taskSmartLinks';
import { aiRunModeLabel, aiRunStatusLabel, runLocationLabel, severityLabel, stageLabel, taskStatusLabel, toolLabel } from './displayLabels';
import { isSubmitShortcut, readStoredBool, readStoredChoice, writeStoredBool, writeStoredString } from './uiPreferences';
import { StatusBadge } from '../components/Primitives';
import { bridgeInstallCommand } from './bridgeInstall';

const AI_ENGINE_PREF_KEY = 'taskflow.ai.engine';
const AI_AUTO_SUBMIT_KEY = 'taskflow.ai.autoSubmitReport';
const ENGINE_IDS: readonly LocalAiEngineId[] = ['codex', 'antigravity', 'cursor', 'claude'];

const isValidTarget = (value: string | undefined): value is LocalTaskTarget => LOCAL_TASK_TARGETS.some(item => item.value === value);

const targetToEngine = (target: LocalTaskTarget): LocalAiEngineId => {
  if (target === 'antigravity') return 'antigravity';
  if (target === 'cursor') return 'cursor';
  if (target === 'claude') return 'claude';
  return 'codex';
};

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
  const allowedStages = (Object.keys(REVIEW_ROLES) as Stage[]).filter(stage => REVIEW_ROLES[stage].includes(role));
  const candidates = localReviewCandidates(task, jobs, { frozen, allowedStages });
  const candidateScope = JSON.stringify(candidates.map(job => [job.id, job.inputHash, job.stage]));

  const [mode, setMode] = useState<LocalTaskMode>('read');
  const [target, setTarget] = useState<LocalTaskTarget>('workbench');
  const [runner, setRunner] = useState<LocalAiRunner>('local');
  const [engine, setEngine] = useState<LocalAiEngineId>(() => readStoredChoice(AI_ENGINE_PREF_KEY, ENGINE_IDS, 'codex'));
  const [jobId, setJobId] = useState('');
  const [reviewStage, setReviewStage] = useState<Stage | ''>('');
  const [autoClaim, setAutoClaim] = useState(true);
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
  const [runs, setRuns] = useState<LocalAiRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [startingRun, setStartingRun] = useState(false);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [submittingDraft, setSubmittingDraft] = useState(false);
  const [rescanningRepos, setRescanningRepos] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [teamAgents, setTeamAgents] = useState<TeamAgent[]>([]);

  const sequence = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const workspaceSeq = useRef(0);
  const targetTouched = useRef(false);
  const prevRunningIds = useRef<Set<string>>(new Set());
  const consoleRef = useRef<HTMLPreElement>(null);

  const serverMode = capabilities?.deployment === 'server';
  const bridgeModes = serverMode ? capabilities?.bridgeModes || ['read'] : null;
  const bridgeDevices = serverMode ? (capabilities?.devices || []).filter(device => device.projectIds.includes(task.projectId)) : [];
  const memberAgents = serverMode ? teamAgents.filter(agent => !agent.mine && agent.dispatchable) : [];
  const dispatchTargets = [
    ...bridgeDevices.map(device => ({ id: device.id, deviceName: device.deviceName, online: device.online, lastSeenAt: device.lastSeenAt, owner: null as TeamAgent['owner'] | null })),
    ...memberAgents.map(agent => ({ id: agent.id, deviceName: agent.deviceName, online: agent.online, lastSeenAt: agent.lastSeenAt, owner: agent.owner })),
  ];
  const selectedDevice = dispatchTargets.find(device => device.id === deviceId) || null;
  const frozenTask = frozen || task.status === 'DONE';
  const canLaunchDevelop = !frozenTask && (canDevelop || !task.assigneeId) && (!bridgeModes || bridgeModes.includes('develop'));
  const canLaunchReview = !frozenTask && !!allowedStages.length && (!bridgeModes || bridgeModes.includes('review'));
  const safeMode: LocalTaskMode = frozenTask || (mode === 'develop' && !canLaunchDevelop) || (mode === 'review' && !canLaunchReview) ? 'read' : mode;

  let prompt = '';
  try {
    prompt = buildLocalTaskPrompt({ task, jobs, mode: safeMode, target, selectedJobId: jobId, canDevelop: canDevelop || !task.assigneeId, frozen, allowedStages, repoPath: workspace?.repoPath });
  } catch { /* Unavailable or changed candidates leave manual copying disabled until selected again. */ }
  const companionCommand = safeMode === 'develop' ? buildCompanionSyncCommand({ jiraKey: task.jiraKey, target, repoPath: workspace?.repoPath }) : '';
  const scope = JSON.stringify([open, userId, task.id, task.projectId, task.version, task.status, role, canDevelop, frozen, canCreateLocalReview, safeMode, target, jobId, candidateScope, workspace?.repoPath || '', prompt]);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  const smartHints = extractTaskSmartHints(task, repositories);
  const runningRun = runs.find(item => item.status === 'RUNNING') || null;
  const activeRun = runs.find(item => item.id === selectedRunId) || runningRun || runs[0] || null;
  const workbench = !serverMode && runner === 'workbench';
  const bridgeCommand = bridgeInstallCommand(location.origin);
  const selectedEngine = workbench && engine !== 'cursor' ? 'codex' : engine;
  const engineOptions = workbench ? [{ value: 'codex', label: 'Codex CLI' }, { value: 'cursor', label: 'Cursor Agent' }] : (capabilities?.engines || [
    { id: 'codex' as const, label: 'Codex', tool: 'codex-cli', available: true },
    { id: 'antigravity' as const, label: 'Gemini / Antigravity', tool: 'custom', available: true },
    { id: 'cursor' as const, label: 'Cursor Agent', tool: 'cursor', available: true },
    { id: 'claude' as const, label: 'Claude Code', tool: 'claude-code', available: true },
  ]).map(item => ({
    value: item.id,
    label: item.available ? `${item.label} · 已就绪` : `${item.label} · 未安装`,
    disabled: !item.available,
  }));

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
        void message.success(`已重新扫描本机目录，发现 ${res.repositories?.length || 0} 个 Git 仓库。`);
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '扫描本机仓库失败。');
    } finally {
      if (mounted.current) setRescanningRepos(false);
    }
  };

  useEffect(() => {
    targetTouched.current = false;
    const storedEngine = readStoredChoice<LocalAiEngineId | ''>(AI_ENGINE_PREF_KEY, [...ENGINE_IDS, ''], '');
    const desiredMode = initialMode && !(frozenTask && initialMode !== 'read') ? initialMode : 'read';
    setMode(desiredMode);
    setRunner(initialRunner || 'local');
    setDeviceId('');
    setRuns([]);
    setTarget('workbench');
    setEngine(storedEngine || 'codex');
    setJobId(initialJobId || (open && candidates.length === 1 ? candidates[0].id : ''));
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
    ]).then(([wsRes, capRes, repoRes, runRes, agentRes]) => {
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
        }
        setEngine(current => {
          if (capRes.value.engines.some(item => item.id === current && item.available)) return current;
          return capRes.value.engines.find(item => item.available)?.id || current;
        });
      }
      const agents = agentRes.status === 'fulfilled' ? agentRes.value.agents || [] : [];
      setTeamAgents(agents);
      if (capRes.status === 'fulfilled' && capRes.value.deployment === 'server' && !(capRes.value.devices || []).some(device => device.projectIds.includes(ownerProject))) {
        const fallback = agents.filter(agent => !agent.mine && agent.dispatchable);
        setDeviceId((fallback.find(agent => agent.online) || fallback[0])?.id || '');
      }
      if (repoRes.status === 'fulfilled') setRepositories(repoRes.value.repositories || []);
      if (runRes.status === 'fulfilled') {
        const list = runRes.value.runs || [];
        prevRunningIds.current = new Set(list.filter(r => r.status === 'RUNNING').map(r => r.id));
        setRuns(list);
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
      void message.success('已清除当前项目的本地仓库绑定。');
      void onChanged?.().catch(() => {});
    } catch (error) {
      if (mounted.current && reqId === workspaceSeq.current) void message.error(error instanceof ApiError ? error.message : '清除目录绑定失败。');
    } finally {
      if (mounted.current && reqId === workspaceSeq.current) setSavingWorkspace(false);
    }
  };

  const openLocalApp = async (app: 'cursor' | 'terminal' | 'finder') => {
    const targetPath = (workspace?.repoPath || repoInput).trim();
    if (!targetPath) { void message.warning('请先选择或绑定本地代码仓库目录。'); return; }
    setOpeningApp(app);
    try {
      await api('local-git/open', { projectId: task.projectId, app, repoPath: targetPath });
      if (mounted.current) {
        void message.success(app === 'finder' ? '已在 Finder 中打开该仓库文件夹。' : app === 'cursor' ? '已在 Cursor 中打开该仓库。' : '已在终端打开该仓库目录。');
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '打开本地应用失败。');
    } finally {
      if (mounted.current) setOpeningApp(null);
    }
  };

  const launchAiRun = async () => {
    if (startingRun || runningRun) return;
    if (serverMode && !selectedDevice) {
      void message.warning('请先在本机配对并运行 Bridge，然后选择接收任务的设备。');
      return;
    }
    if (!serverMode && safeMode === 'develop' && !workspace?.repoPath && !repoInput.trim()) {
      void message.warning('开发协作需要先选择并绑定本机业务 Git 仓库目录。');
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
      const payload: Record<string, unknown> = {
        mode: safeMode,
        engine: selectedEngine,
        ...(workbench ? { runner } : {}),
        ...(serverMode && selectedDevice ? { runner: 'bridge', deviceId: selectedDevice.id } : {}),
        ...(customInstruction.trim() ? { customInstruction: customInstruction.trim() } : {}),
      };
      if (safeMode === 'develop' && !task.assigneeId && autoClaim && !selectedDevice?.owner) {
        payload.autoClaim = true;
      }
      if (safeMode === 'review') {
        const chosenCandidate = candidates.find(item => item.id === jobId);
        if (chosenCandidate) {
          payload.jobId = chosenCandidate.id;
        } else if (reviewStage && allowedStages.includes(reviewStage)) {
          payload.stage = reviewStage;
        } else {
          void message.warning('请选择要评审的阶段或待报告申请。');
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
      void message.success(serverMode ? `已派发到「${selectedDevice?.owner ? `${selectedDevice.owner.username} · ` : ''}${selectedDevice?.deviceName}」，等待本机 Bridge 领取执行。` : workbench ? '已载入任务工作台会话，下方显示状态与结果。' : '已启动本机 AI 执行，下方实时展示输出进度。');
      void onChanged?.().catch(() => {});
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '启动本机 AI 执行失败。');
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
      void message.info(res.run.status !== 'RUNNING' ? '已停止本机 AI 执行。' : res.run.runner === 'bridge' ? '已请求停止，等待本机 Bridge 响应。' : '已请求停止工作台执行。');
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
      });
      if (!mounted.current) return;
      void message.success('已一键提交本地 AI 评审报告，等待其他授权成员独立审批。');
      await onChanged?.();
      if (onOpenReview) leave(() => onOpenReview(run.jobId!));
    } catch (error) {
      if (mounted.current) void message.error(error instanceof ApiError ? error.message : '提交评审报告失败。');
    } finally {
      if (mounted.current) setSubmittingDraft(false);
    }
  };

  const copy = async (openWorkbenchAfter = false) => {
    const routeIsCurrent = () => {
      const route = new URLSearchParams(location.hash.slice(1));
      return route.get('task') === task.id && route.get('mode') !== 'demo';
    };
    if (!open || !prompt || pending.current || currentScope.current !== scope || !routeIsCurrent()) {
      if (openWorkbenchAfter) window.open('http://127.0.0.1:5288/agent', '_blank', 'noopener,noreferrer');
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
      if (openWorkbenchAfter) window.open('http://127.0.0.1:5288/agent', '_blank', 'noopener,noreferrer');
    } catch {
      if (current()) void message.warning('复制未完成，请展开下方高级面板复制。');
    } finally {
      if (ownsRequest()) { pending.current = false; setCopying(false); }
    }
  };

  const copyCompanion = async () => {
    if (!companionCommand) return;
    try {
      await navigator.clipboard.writeText(companionCommand);
      if (mounted.current) { setCopiedSync(true); void message.success('伴随同步命令已复制，可在本地终端运行。'); }
    } catch { if (mounted.current) void message.warning('复制未完成，请手动复制伴随命令。'); }
  };

  const draftJob = activeRun?.jobId ? jobs.find(j => j.id === activeRun.jobId) : undefined;
  const draftAlreadyReported = !!activeRun?.draft?.autoSubmitted || !!draftJob?.report;

  return <Drawer
    title={workbench ? '任务工作台' : serverMode ? '派发到我的本机 AI' : '本地 AI 自动化工作台'}
    open={open}
    onClose={close}
    size={720}
    destroyOnHidden
    footer={<Flex justify="space-between" align="center" gap={8} wrap>
      <Space size={8} wrap>
        {!workbench && <Button icon={<ExternalLink size={15} />} disabled={!prompt && safeMode !== 'review'} onClick={() => void copy(true)}>复制指令并打开工作台</Button>}
        {!serverMode && (workspace?.repoPath || repoInput.trim()) && <Button icon={<FolderOpen size={15} />} loading={openingApp === 'finder'} onClick={() => void openLocalApp('finder')}>Finder 打开</Button>}
        {!serverMode && (workspace?.repoPath || repoInput.trim()) && <Button icon={<Terminal size={15} />} loading={openingApp === 'cursor'} onClick={() => void openLocalApp('cursor')}>在 Cursor 打开</Button>}
      </Space>
      <Space size={8}>
        <Button onClick={close}>关闭</Button>
        {runningRun ? (
          <Button danger type="primary" icon={<Square size={14} />} loading={stoppingRun} onClick={() => void stopAiRun(runningRun.id)}>停止当前执行</Button>
        ) : (
          <Button type="primary" icon={<Play size={15} />} loading={startingRun} disabled={serverMode && !selectedDevice} onClick={() => void launchAiRun()}>{workbench ? '打开工作台会话' : serverMode ? '派发到本机执行' : '直接启动本机 AI 执行'}</Button>
        )}
      </Space>
    </Flex>}
  >
    <Flex vertical gap={16}>
      <div>
        <Space size={8} wrap>
          <Tag color="blue">{task.jiraKey}</Tag>
          <StatusBadge variant={task.status === 'DONE' ? 'green' : 'neutral'}>{taskStatusLabel(task.status)}</StatusBadge>
          {workspace?.repoPath && <Tag color="geekblue">{workspace.repoPath.split('/').pop()}</Tag>}
          {!!constitutionFiles?.length && <Tag color="cyan">工程规范：{constitutionFiles.join(' · ')}</Tag>}
        </Space>
        <Typography.Title level={4} style={{ margin: '6px 0 4px' }}>{task.title}</Typography.Title>
        <Typography.Text type="secondary">{serverMode
          ? '服务器只负责派发与记录：任务由你本机运行的 Bridge 领取，在你的电脑上调用 Codex / Cursor 执行，代码与凭据不会上传到服务器。'
          : '无需手动复制粘贴任务 ID 或材料：直接调用本机已安装的 Codex / Gemini / Cursor / Claude 执行任务分析、代码协作或生成结构化评审草稿。'}</Typography.Text>
      </div>

      {serverMode && !dispatchTargets.length && (
        <Alert
          type="warning"
          showIcon
          title="还没有可接收该项目任务的本机 Bridge"
          description={<Flex vertical gap={6} style={{ marginTop: 4 }}>
            <span>在你的电脑终端运行下面的一键安装命令，按提示配对（授权时勾选项目 {task.projectId}），再按「本机接入」页的说明填写仓库映射并启动后台运行。也可以请项目负责人让已接入的成员开启「允许团队派发」。</span>
            <Flex gap={8} align="center">
              <Input readOnly value={bridgeCommand} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }} />
              <Button size="small" icon={<Copy size={14} />} onClick={() => { void navigator.clipboard.writeText(bridgeCommand).then(() => message.success('命令已复制。')).catch(() => message.warning('复制未完成，请手动复制。')); }}>复制</Button>
            </Flex>
          </Flex>}
        />
      )}

      {!serverMode && !workspace?.repoPath && smartHints.matchedRepos.length > 0 && (
        <Alert
          type="info"
          showIcon
          title={`智能识别到任务关联本机仓库：${smartHints.matchedRepos[0].name}`}
          description={<Flex justify="space-between" align="center" gap={8} wrap style={{ marginTop: 4 }}>
            <Typography.Text code style={{ fontSize: 12 }}>{smartHints.matchedRepos[0].path}</Typography.Text>
            <Button size="small" type="primary" loading={savingWorkspace} onClick={() => void bindWorkspacePath(smartHints.matchedRepos[0].path)}>一键绑定此仓库</Button>
          </Flex>}
        />
      )}

      {!serverMode && <Card size="small" title={<Space size={6}><FolderGit2 size={15} /><span>项目本地 Git 仓库与快捷打开</span></Space>} extra={<Button size="small" type="text" icon={<RefreshCw size={13} />} loading={rescanningRepos} onClick={() => void rescanRepositories()}>重新扫描</Button>}>
        <Flex vertical gap={10}>
          {repositories.length > 0 && (
            <Select
              aria-label="选择已扫描的本机仓库"
              showSearch={{ optionFilterProp: 'label' }}
              placeholder="从本机扫描到的 Git 仓库中直接选择（免手动输入路径）"
              value={repositories.some(r => r.path === repoInput) ? repoInput : undefined}
              options={repositories.map(repo => ({
                value: repo.path,
                label: `${repo.name}${repo.group ? ` (${repo.group})` : ''} · ${repo.path}`,
              }))}
              onChange={value => {
                setRepoInput(value);
                void bindWorkspacePath(value);
              }}
            />
          )}
          <Flex gap={8} wrap={false}>
            <Input aria-label="项目本地代码目录" placeholder="/Users/you/workspace/business-repo" value={repoInput} disabled={savingWorkspace} onChange={event => setRepoInput(event.target.value)} />
            <Button loading={savingWorkspace} onClick={() => void bindWorkspacePath(repoInput)}>保存绑定</Button>
            {workspace && <Button danger disabled={savingWorkspace} onClick={() => void clearWorkspace()}>解除</Button>}
          </Flex>
          {(workspace?.repoPath || repoInput.trim()) && (
            <Space size={8} wrap>
              <Button size="small" icon={<FolderOpen size={14} />} onClick={() => void openLocalApp('finder')} loading={openingApp === 'finder'}>Finder 打开</Button>
              <Button size="small" onClick={() => void openLocalApp('cursor')} loading={openingApp === 'cursor'}>在 Cursor 打开仓库</Button>
              <Button size="small" icon={<Terminal size={14} />} onClick={() => void openLocalApp('terminal')} loading={openingApp === 'terminal'}>在终端打开目录</Button>
            </Space>
          )}
        </Flex>
      </Card>}

      <Card size="small" title={<Space size={6}><Sparkles size={15} /><span>执行方式</span></Space>}>
        <Flex vertical gap={12}>
          <Segmented
            block
            aria-label="本地处理方式"
            value={safeMode}
            options={[
              { value: 'read', label: '1. 任务与材料缺口分析' },
              { value: 'develop', label: '2. 本地代码开发协作', disabled: !canLaunchDevelop },
              { value: 'review', label: '3. 自动生成评审草稿', disabled: !canLaunchReview },
            ]}
            onChange={value => setMode(value as LocalTaskMode)}
          />

          <Flex gap={12} wrap>
            <div style={{ flex: '1 1 240px' }}>
              <Typography.Text style={{ display: 'block', marginBottom: 4 }}>执行位置</Typography.Text>
              {serverMode ? (
                <Select aria-label="接收任务的本机设备" style={{ width: '100%' }} value={selectedDevice?.id} placeholder="未配对本机 Bridge" options={dispatchTargets.map(device => ({
                  value: device.id,
                  disabled: !!device.owner && safeMode === 'develop' && task.assigneeId !== device.owner.id,
                  label: `${device.owner ? `${device.owner.username} 的本机 Bridge` : '我的本机 Bridge'} · ${device.deviceName} · ${device.online ? '在线' : device.lastSeenAt ? `离线（${timeText(device.lastSeenAt)}）` : '未启动 worker'}${device.owner && safeMode === 'develop' && task.assigneeId !== device.owner.id ? ' · 开发任务需先指派给他' : ''}`,
                }))} onChange={setDeviceId} />
              ) : (
                <Select aria-label="执行位置" style={{ width: '100%' }} value={runner} options={[
                  { value: 'workbench', label: '5288 工作台' },
                  { value: 'local', label: '本机 CLI' },
                ]} onChange={setRunner} />
              )}
            </div>
            <div style={{ flex: '1 1 240px' }}>
              <Typography.Text style={{ display: 'block', marginBottom: 4 }}>执行引擎</Typography.Text>
              <Select aria-label="执行引擎" style={{ width: '100%' }} value={selectedEngine} options={engineOptions} onChange={val => { setEngine(val); writeStoredString(AI_ENGINE_PREF_KEY, val); }} />
            </div>
            {safeMode === 'review' && (
              <div style={{ flex: '1 1 280px' }}>
                <Typography.Text style={{ display: 'block', marginBottom: 4 }}>目标评审阶段 / 已有申请</Typography.Text>
                {candidates.length > 0 ? (
                  <Select
                    aria-label="待报告的本地评审"
                    style={{ width: '100%' }}
                    value={candidates.some(job => job.id === jobId) ? jobId : '__auto__'}
                    options={[
                      ...candidates.map(job => ({ value: job.id, label: `已有申请 · ${stageLabel(job.stage)} (${timeText(job.createdAt)})` })),
                      { value: '__auto__', label: '自动新建本地评审申请并执行…' },
                    ]}
                    onChange={val => setJobId(val)}
                  />
                ) : (
                  <Select
                    aria-label="自动发起的评审阶段"
                    style={{ width: '100%' }}
                    value={reviewStage || undefined}
                    placeholder="选择评审阶段（自动冻结当前材料并创建申请）"
                    options={STAGES.filter(s => allowedStages.includes(s.value)).map(s => ({ value: s.value, label: s.label }))}
                    onChange={val => setReviewStage(val)}
                  />
                )}
              </div>
            )}
          </Flex>

          {safeMode === 'review' && jobId === '__auto__' && candidates.length > 0 && (
            <div>
              <Typography.Text style={{ display: 'block', marginBottom: 4 }}>选择新建评审阶段</Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={reviewStage || undefined}
                options={STAGES.filter(s => allowedStages.includes(s.value)).map(s => ({ value: s.value, label: s.label }))}
                onChange={val => setReviewStage(val)}
              />
            </div>
          )}

          {safeMode === 'develop' && !task.assigneeId && !frozenTask && (
            <Checkbox checked={autoClaim} onChange={e => setAutoClaim(e.target.checked)}>
              启动前自动认领此任务并将本地状态切换为「进行中」
            </Checkbox>
          )}

          {serverMode && selectedDevice && !selectedDevice.online && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>该设备最近未在线，派发会排队最多 30 分钟，期间需在本机运行 rd.mjs worker 才会被领取。</Typography.Text>
          )}

          {safeMode === 'review' && !workbench && !serverMode && (
            <Checkbox checked={autoSubmitReport} onChange={e => { setAutoSubmitReport(e.target.checked); writeStoredBool(AI_AUTO_SUBMIT_KEY, e.target.checked); }}>
              生成结构化草稿后自动提交为本阶段本地 AI 评审报告（多人项目审批仍由独立成员执行）
            </Checkbox>
          )}

          <Input
            placeholder="补充执行要求（可选，按 Cmd/Ctrl + Enter 直接启动，例如：重点检查金额精度、接口幂等性与异常分支）"
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

          <Flex justify="space-between" align="center" gap={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {safeMode === 'read' && '只读分析任务需求、现有资产与门禁缺口，不修改代码或平台状态。'}
              {safeMode === 'develop' && (serverMode ? '在本机 Bridge 配置映射的仓库中开发与自测，执行前需在本机弹窗确认（绝不自动 push）。' : '在绑定仓库执行本地开发与自测，新 Git 提交自动记录开发进度（绝不自动 push）。')}
              {safeMode === 'review' && '基于冻结快照输出结构化评审结论与发现项，支持一键回填提交。'}
            </Typography.Text>
            {!workbench && (runningRun ? (
              <Button danger icon={<Square size={14} />} loading={stoppingRun} onClick={() => void stopAiRun(runningRun.id)}>停止执行</Button>
            ) : (
              <Button type="primary" icon={<Play size={15} />} loading={startingRun} disabled={serverMode && !selectedDevice} onClick={() => void launchAiRun()}>
                {safeMode === 'read' ? '启动任务分析' : safeMode === 'develop' ? '启动本地开发协作' : '启动 AI 评审'}
              </Button>
            ))}
          </Flex>
        </Flex>
      </Card>

      {runs.length > 0 && activeRun && (
        <Card
          size="small"
          title={<Space size={8} wrap>
            <span>执行记录与实时输出</span>
            <StatusBadge variant={activeRun.status === 'SUCCEEDED' ? 'green' : activeRun.status === 'RUNNING' ? 'blue' : activeRun.status === 'FAILED' ? 'block' : 'neutral'}>
              {aiRunStatusLabel(activeRun.status)}
            </StatusBadge>
            <Tag>{runLocationLabel(activeRun)}{toolLabel(activeRun.engine)} · {aiRunModeLabel(activeRun.mode)}</Tag>
          </Space>}
          extra={(runs.length > 1 || !!activeRun.output || activeRun.workbenchUrl) ? (
            <Space size={6} wrap>
              {activeRun.workbenchUrl && <Button size="small" href={activeRun.workbenchUrl} target="_blank" rel="noopener noreferrer" icon={<ExternalLink size={13} />}>继续工作台会话</Button>}
              {activeRun.output && (
                <Button
                  size="small"
                  icon={<Copy size={13} />}
                  onClick={() => {
                    void navigator.clipboard.writeText(activeRun.output).then(() => message.success('执行输出已复制。')).catch(() => message.warning('浏览器未能复制，请手动选择复制。'));
                  }}
                >
                  复制输出
                </Button>
              )}
              {runs.length > 1 && (
                <Select
                  size="small"
                  style={{ width: 210 }}
                  value={activeRun.id}
                  options={runs.map(item => ({
                    value: item.id,
                    label: `${aiRunModeLabel(item.mode)} · ${toolLabel(item.engine)} · ${aiRunStatusLabel(item.status)}`,
                  }))}
                  onChange={setSelectedRunId}
                />
              )}
            </Space>
          ) : undefined}
        >
          <Flex vertical gap={10}>
            {activeRun.error && (
              <Alert
                type="warning"
                showIcon
                title={activeRun.error}
                action={!serverMode && (activeRun.error.includes('桌面隐私') || activeRun.error.includes('Cursor')) ? (
                  <Space size={4}>
                    <Button size="small" onClick={() => void openLocalApp('cursor')}>打开 Cursor</Button>
                    <Button size="small" onClick={() => void copy(true)}>去工作台处理</Button>
                  </Space>
                ) : undefined}
              />
            )}

            {activeRun.mode === 'review' && activeRun.draft && (
              <Card size="small" style={{ background: 'var(--tf-raised)', borderColor: 'var(--tf-border)' }} title={<Space size={6}><FileCheck2 size={15} /><span>结构化评审草稿预览</span></Space>}>
                <Flex vertical gap={8}>
                  <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{activeRun.draft.summary}</Typography.Paragraph>
                  {activeRun.draft.evidence && <Typography.Text type="secondary" style={{ fontSize: 12 }}>核验依据：{activeRun.draft.evidence}</Typography.Text>}
                  {activeRun.draft.findings.length > 0 ? (
                    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                      {activeRun.draft.findings.map((finding, idx) => (
                        <div key={idx} style={{ padding: '6px 10px', background: 'var(--tf-surface)', border: '1px solid var(--tf-border)', borderRadius: 'var(--tf-control-radius, 6px)' }}>
                          <Space size={6} wrap>
                            <StatusBadge variant={finding.severity === 'CRITICAL' ? 'block' : finding.severity === 'WARN' ? 'warn' : 'neutral'}>{severityLabel(finding.severity)}</StatusBadge>
                            <Typography.Text strong>{finding.title}</Typography.Text>
                            {finding.location && <Typography.Text code style={{ fontSize: 12 }}>{finding.location}</Typography.Text>}
                          </Space>
                          <div style={{ fontSize: 12, color: 'var(--tf-secondary)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{finding.detail}</div>
                        </div>
                      ))}
                    </Space>
                  ) : (
                    <Tag color="success" style={{ alignSelf: 'flex-start' }}>未发现阻断或风险项</Tag>
                  )}
                  <Flex justify="flex-end" gap={8} wrap>
                    {draftAlreadyReported ? (
                      <>
                        <Tag color="success">报告已提交至评审记录 · 待独立审批</Tag>
                        {activeRun.jobId && onOpenReview && <Button size="small" type="link" onClick={() => leave(() => onOpenReview(activeRun.jobId!))}>打开评审详情</Button>}
                      </>
                    ) : activeRun.jobId && (
                      <Button type="primary" size="small" loading={submittingDraft} disabled={frozenTask || !!draftJob?.stale} onClick={() => void submitRunDraft(activeRun)}>
                        一键提交此草稿为评审报告
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Card>
            )}

            <pre ref={consoleRef} className="tf-code-panel" style={{ maxHeight: 260 }}>
              {activeRun.output || (activeRun.status !== 'RUNNING' ? '（无控制台输出）'
                : activeRun.runner === 'bridge' && activeRun.bridgePhase === 'QUEUED' ? '已排队，等待本机 Bridge 领取（请确认本机正在运行 rd.mjs worker）…'
                : '正在启动本机 AI 并读取任务快照，请稍候…')}
            </pre>
          </Flex>
        </Card>
      )}

      <Collapse
        size="small"
        items={[{
          key: 'manual-prompt',
          label: '高级：在交互式工作台 (5288) / IDE 会话中手动使用指令或伴随命令',
          children: <Flex vertical gap={12}>
            <Descriptions size="small" column={2} items={[
              { key: 'jira', label: '任务号', children: task.jiraKey },
              { key: 'status', label: '本地状态', children: taskStatusLabel(task.status) },
            ]} />
            <Flex gap={8} align="center" wrap>
              <Select aria-label="目标工具" style={{ flex: '1 1 240px' }} value={target} options={LOCAL_TASK_TARGETS} onChange={value => { targetTouched.current = true; setTarget(value); setEngine(targetToEngine(value)); }} />
              <Button icon={copied ? <Check size={15} /> : <Copy size={15} />} disabled={!prompt} loading={copying} onClick={() => void copy(false)}>{copied ? '已复制' : '复制处理指令'}</Button>
              <Button href="http://127.0.0.1:5288/agent" target="_blank" rel="noopener noreferrer" icon={<ExternalLink size={15} />}>打开工作台</Button>
            </Flex>
            {prompt ? (
              <Input.TextArea aria-label="将复制的指令" readOnly value={prompt} autoSize={{ minRows: 5, maxRows: 12 }} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }} />
            ) : safeMode === 'review' ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="若需复制交互式评审指令，请先拥有一条待提交报告的本地评审申请（或直接使用上方「启动 AI 评审」自动创建）。">
                <Space wrap>
                  <Button size="small" onClick={() => leave(onOpenAssets)}>查看任务材料</Button>
                  {!frozenTask && canCreateLocalReview && allowedStages.length > 0 && <Button size="small" onClick={() => leave(onCreateLocalReview)}>手动登记本地评审</Button>}
                </Space>
              </Empty>
            ) : null}
            {companionCommand && <Flex vertical gap={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>伴随心跳与 Git 提交自动同步（终端常驻可选）：</Typography.Text>
              <Flex gap={8} align="center">
                <Input readOnly value={companionCommand} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12 }} />
                <Button size="small" icon={copiedSync ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copyCompanion()}>{copiedSync ? '已复制' : '复制'}</Button>
              </Flex>
            </Flex>}
          </Flex>,
        }]}
      />
    </Flex>
  </Drawer>;
};

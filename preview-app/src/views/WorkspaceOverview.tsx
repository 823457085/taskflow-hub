import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Empty, Input, List, Select, Skeleton, Tag, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import { ArrowRight, Check, CheckCircle2, ClipboardCheck, FileSpreadsheet, FileText, FolderKanban, FolderOpen, ListTodo, Pencil, Plus, RefreshCw, Search, Terminal, Trash2, X } from 'lucide-react';
import { api, ApiError, APPROVE_ROLES, OverviewStageStat, OverviewSummary, OverviewSummaryJob, Project, projectGroup, ProjectWorkspace, REVIEW_STAGE_OPTIONS, Stage, timeText, User, WorkTask } from './workspaceApi';
import { StatusBadge } from '../components/Primitives';
import { navigateWorkspace, openTaskRoute, SECTION_LABELS, WorkspaceSection } from './workspaceNavigation';
import { isTaskFrozen } from './taskAvailability';
import { DeliveryFlowGuide } from './DeliveryFlowGuide';
import { ProjectSkillsDialog } from './ProjectSkillsDialog';
import { DEFAULT_APPROVE_REASON, roleLabel, stageLabel, taskStatusLabel } from './displayLabels';
import { formatFlowHours, type OverviewFlowTelemetry } from './deliveryMetrics';
import { evaluateReviewSla } from './reviewQueueSla';
import { clearSearchOnEscape, isEditableTarget } from './uiPreferences';
import './WorkspaceOverview.css';

const StandupDigestModal = lazy(() => import('./StandupDigestModal').then(mod => ({ default: mod.StandupDigestModal })));


export const WorkspaceOverview: React.FC<{ projects: Project[]; tasks: WorkTask[]; user: User; onUnauthorized: () => void; onSyncJira?: () => void; syncingJira?: boolean; onApproved?: () => void; openDigestTick?: number }> = ({ projects, tasks, user, onUnauthorized, onSyncJira, syncingJira, onApproved, openDigestTick }) => {
  const { message } = App.useApp();
  const scope = JSON.stringify([user.id, user.role, projects.map(project => [project.id, project.role]), tasks.map(task => [task.id, task.projectId])]);
  const [result, setResult] = useState<{
    scope: string; projects: Project[]; tasks: WorkTask[];
    status: 'loading' | 'ready' | 'error';
    reviewCount?: number; assetCount?: number; openBlockersCount?: number;
    stageBreakdown?: Partial<Record<Stage, OverviewStageStat>>;
    flowTelemetry?: OverviewFlowTelemetry;
    pendingJobs: OverviewSummaryJob[]; failure?: string;
  }>();
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [approvingJobId, setApprovingJobId] = useState('');
  const [batchApproving, setBatchApproving] = useState(false);
  const [openingTaskProject, setOpeningTaskProject] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [digestOpen, setDigestOpen] = useState(false);
  const [digestEverOpened, setDigestEverOpened] = useState(false);
  const openDigest = () => { setDigestEverOpened(true); setDigestOpen(true); };
  useEffect(() => {
    if (openDigestTick) {
      setDigestEverOpened(true);
      setDigestOpen(true);
    }
  }, [openDigestTick]);
  const sequence = useRef(0);
  const mountedRef = useRef(true);
  const unauthorizedRef = useRef(onUnauthorized);
  const messageRef = useRef(message);
  unauthorizedRef.current = onUnauthorized;
  messageRef.current = message;
  useEffect(() => {
    mountedRef.current = true;
    void api<{ workspaces: ProjectWorkspace[] }>('project-workspaces')
      .then(res => { if (mountedRef.current && Array.isArray(res?.workspaces)) setWorkspaces(res.workspaces); })
      .catch(() => { /* optional local repo decoration */ });
    return () => { mountedRef.current = false; };
  }, [user.id, projects.length]);
  useEffect(() => {
    const current = ++sequence.current;
    // The result belongs to this exact permission/data snapshot. Clear it before
    // starting the summary read so a failed refresh cannot keep old report links.
    setResult({ scope, projects, tasks, status: 'loading', pendingJobs: [] });
    const visibleProjects = new Set(projects.map(project => project.id));
    const visibleTasks = new Map(tasks.filter(task => visibleProjects.has(task.projectId)).map(task => [task.id, task.projectId]));
    void api<OverviewSummary>('overview-summary').then(summary => {
      if (current !== sequence.current) return;
      if (typeof summary?.reviewCount !== 'number' || typeof summary?.assetCount !== 'number' || !Array.isArray(summary?.pendingJobs)) {
        throw new Error('平台响应格式不正确。');
      }
      const pendingJobs = summary.pendingJobs.filter(job => job && visibleProjects.has(job.projectId) && visibleTasks.get(job.taskId) === job.projectId);
      setResult({
        scope,
        projects,
        tasks,
        status: 'ready',
        reviewCount: summary.reviewCount,
        assetCount: summary.assetCount,
        openBlockersCount: summary.openBlockersCount ?? 0,
        stageBreakdown: summary.stageBreakdown || {},
        flowTelemetry: summary.flowTelemetry,
        pendingJobs,
      });
    }).catch(error => {
      if (current !== sequence.current) return;
      const failure = error instanceof Error ? error.message : '请求失败。';
      setResult({ scope, projects, tasks, status: 'error', pendingJobs: [], failure });
      if (error instanceof ApiError && error.status === 401) unauthorizedRef.current();
      void messageRef.current.error(failure);
    });
    return () => { sequence.current += 1; };
  }, [scope, tasks, projects, reloadTick]);

  const quickApprove = async (job: OverviewSummaryJob) => {
    if (approvingJobId || batchApproving) return;
    setApprovingJobId(job.id);
    try {
      await api(`jobs/${encodeURIComponent(job.id)}/decision`, { decision: 'APPROVE', reason: DEFAULT_APPROVE_REASON });
      void messageRef.current.success(`已一键批准【${stageLabel(job.stage)}】。`);
      setReloadTick(tick => tick + 1);
      onApproved?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) unauthorizedRef.current();
      void messageRef.current.error(error instanceof Error ? error.message : '审批请求失败。');
    } finally {
      setApprovingJobId('');
    }
  };

  const quickApproveAll = async (jobsToApprove: OverviewSummaryJob[]) => {
    if (!jobsToApprove.length || approvingJobId || batchApproving) return;
    setBatchApproving(true);
    let approvedCount = 0;
    const stageOrder = (stage: string) => REVIEW_STAGE_OPTIONS.findIndex(item => item.value === stage);
    const ordered = [...jobsToApprove].sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage));
    try {
      for (const job of ordered) {
        await api(`jobs/${encodeURIComponent(job.id)}/decision`, { decision: 'APPROVE', reason: DEFAULT_APPROVE_REASON });
        approvedCount += 1;
      }
      void messageRef.current.success(`已一键批准全部 ${approvedCount} 份待办报告。`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) unauthorizedRef.current();
      const errText = error instanceof Error ? error.message : '批量审批中断。';
      void messageRef.current.error(approvedCount ? `已批准 ${approvedCount} 份，剩余项失败：${errText}` : errText);
    } finally {
      setBatchApproving(false);
      if (approvedCount > 0) {
        setReloadTick(tick => tick + 1);
        onApproved?.();
      }
    }
  };

  const openTaskRepo = async (projectId: string, repoPath: string) => {
    if (openingTaskProject) return;
    setOpeningTaskProject(projectId);
    try {
      await api('local-git/open', { projectId, repoPath, app: 'finder' });
      if (mountedRef.current) void messageRef.current.success('已在 Finder 中打开项目文件夹。');
    } catch (error) {
      if (mountedRef.current) void messageRef.current.error(error instanceof Error ? error.message : '打开本地目录失败。');
    } finally {
      if (mountedRef.current) setOpeningTaskProject('');
    }
  };

  // Permission changes must hide the previous response in this render, before
  // the effect for the next request has had a chance to run.
  const current = result?.scope === scope && result.projects === projects && result.tasks === tasks ? result : undefined;
  const loading = !current || current.status === 'loading';
  const ready = current?.status === 'ready';
  const pendingJobs = ready ? current.pendingJobs : [];
  const reviewCount = ready ? current.reviewCount : undefined;
  const assetCount = ready ? current.assetCount : undefined;
  const visibleProjectIds = new Set(projects.map(project => project.id));
  const visibleTasks = tasks.filter(task => visibleProjectIds.has(task.projectId));
  const workspaceByProject = new Map(workspaces.map(ws => [ws.projectId, ws]));
  const mine = [...visibleTasks.filter(task => task.assigneeId === user.id && task.status !== 'DONE')].sort((a, b) => (Date.parse(b.externalRef?.version || b.updatedAt) || 0) - (Date.parse(a.externalRef?.version || a.updatedAt) || 0));
  const pending = pendingJobs.filter(job => !job.stale && !job.decision && !!job.report && !isTaskFrozen(visibleTasks.find(task => task.id === job.taskId), visibleTasks));
  const isJobQuickApprovable = (job: OverviewSummaryJob) => {
    const jobTask = visibleTasks.find(task => task.id === job.taskId);
    const projRole = projects.find(project => project.id === job.projectId)?.role || user.role;
    const isIndep = !!job.report && job.report.actorId !== user.id && jobTask?.assigneeId !== user.id;
    return (isIndep || !!job.soloMode) && APPROVE_ROLES[job.stage].includes(projRole) && !job.hasBlockingFindings && !job.prerequisitesBlocked;
  };
  const approvablePending = pending.filter(isJobQuickApprovable);
  const metrics: { title: string; value: number | string; section: WorkspaceSection; icon: React.ReactNode; loading?: boolean }[] = [
    { title: '可见项目', value: projects.length, section: 'projects', icon: <FolderKanban size={18} /> },
    { title: '我的待办', value: mine.length, section: 'tasks', icon: <ListTodo size={18} /> },
    { title: '评审记录', value: reviewCount ?? '—', section: 'reviews', icon: <ClipboardCheck size={18} /> , loading },
    { title: '材料版本', value: assetCount ?? '—', section: 'assets', icon: <FileText size={18} />, loading },
  ];
  return <div className="tf-overview">
    <div className="tf-overview-metrics" aria-label="工作台数据">
      {metrics.map(item => (
        <button key={item.section} type="button" className="tf-overview-metric" onClick={() => navigateWorkspace(item.section)}>
          <span className="tf-overview-icon" aria-hidden="true">{item.icon}</span>
          <span className="tf-overview-metric-text">
            <span>{item.title}</span>
            {item.loading ? <Skeleton.Input active size="small" /> : <strong>{item.value}</strong>}
          </span>
          <ArrowRight className="tf-overview-metric-arrow" size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
    <div className="tf-overview-columns">
      <Card
        className="tf-overview-queue"
        title={<span className="tf-overview-panel-title"><ListTodo size={17} />我的待办</span>}
        extra={<div className="tf-overview-panel-actions">{onSyncJira && <Tooltip title="同步最新 Jira"><Button aria-label="同步最新 Jira" size="small" icon={<RefreshCw size={14} />} loading={syncingJira} onClick={onSyncJira} /></Tooltip>}<Button type="text" size="small" onClick={() => navigateWorkspace('tasks')}>任务中心<ArrowRight size={14} /></Button></div>}
      >
        <List dataSource={mine.slice(0, 10)} locale={{ emptyText: <Empty description="暂无我的待办" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} renderItem={task => {
          const boundWs = workspaceByProject.get(task.projectId);
          return <List.Item className="tf-overview-task">
            <div className="tf-overview-task-main">
              <div className="tf-overview-task-meta"><code>{task.jiraKey}</code><span>{projects.find(project => project.id === task.projectId)?.name}</span></div>
              <button type="button" className="tf-overview-task-title" title={task.title} onClick={() => openTaskRoute(task.id, { from: 'overview' })}>{task.title}</button>
              <time className="tf-overview-meta">{timeText(task.externalRef?.version || task.updatedAt)}</time>
            </div>
            <div className="tf-overview-row-actions">
              <StatusBadge variant="neutral">{task.externalRef ? task.externalRef.status : taskStatusLabel(task.status)}</StatusBadge>
              {boundWs && (
                <Tooltip title={`在 Finder 打开仓库：${boundWs.repoPath}`}>
                  <Button
                    size="small"
                    type="text"
                    icon={<FolderOpen size={14} />}
                    loading={openingTaskProject === task.projectId}
                    aria-label="在 Finder 打开仓库"
                    onClick={() => void openTaskRepo(task.projectId, boundWs.repoPath)}
                  />
                </Tooltip>
              )}
            </div>
          </List.Item>;
        }} />
      </Card>
      <Card
          className="tf-overview-queue tf-overview-reviews"
          title={<span className="tf-overview-panel-title"><ClipboardCheck size={17} />待审批 <span className="tf-overview-count">{loading ? '—' : pending.length}</span></span>}
          extra={
            <div className="tf-overview-panel-actions">
              {approvablePending.length >= 2 && (
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckCircle2 size={13} />}
                  loading={batchApproving}
                  disabled={!!approvingJobId}
                  onClick={() => void quickApproveAll(approvablePending)}
                >
                  一键全部批准 ({approvablePending.length})
                </Button>
              )}
              <Button type="text" size="small" onClick={() => navigateWorkspace('reviews')}>{SECTION_LABELS.reviews}<ArrowRight size={14} /></Button>
            </div>
          }
        >
          {loading ? <Skeleton active paragraph={{ rows: 2 }} /> : pending.length ? <List dataSource={pending.slice(0, 5)} renderItem={job => {
            const jobTask = visibleTasks.find(task => task.id === job.taskId);
            const canQuickApprove = isJobQuickApprovable(job);
            const sla = evaluateReviewSla(job);
            return <List.Item>
              <div className="tf-overview-review-row">
                <div className="tf-overview-task-main">
                  <div className="tf-overview-task-meta"><code>{jobTask?.jiraKey || job.taskId}</code><span>{stageLabel(job.stage)}</span></div>
                  <button type="button" className="tf-overview-task-title" title={jobTask?.title} onClick={() => openTaskRoute(job.taskId, { tab: 'reviews', jobId: job.id, from: 'overview' })}>{jobTask?.title || stageLabel(job.stage)}</button>
                </div>
                <div className="tf-overview-row-actions">
                  <Tag color={sla.tagColor}>{sla.label}</Tag>
                  {canQuickApprove && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<CheckCircle2 size={13} />}
                      loading={approvingJobId === job.id}
                      disabled={batchApproving || (!!approvingJobId && approvingJobId !== job.id)}
                      onClick={() => void quickApprove(job)}
                    >
                      一键批准
                    </Button>
                  )}
                </div>
              </div>
            </List.Item>;
          }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={ready ? '暂无待审批报告' : current?.failure || '尚未读取评审记录。'} />}
        </Card>

    </div>
    {(() => {
      const total = visibleTasks.length;
      const distribution = [
        { label: '已完成', count: visibleTasks.filter(task => task.status === 'DONE').length, className: 'done' },
        { label: '评审中', count: visibleTasks.filter(task => task.status === 'IN_REVIEW').length, className: 'review' },
        { label: '进行中', count: visibleTasks.filter(task => task.status === 'IN_PROGRESS').length, className: 'progress' },
        { label: '待开始', count: visibleTasks.filter(task => task.status === 'OPEN').length, className: 'open' },
      ];
      const done = distribution[0].count;
      const rate = total ? Math.round(done / total * 100) : 0;
      const unclaimed = visibleTasks.filter(task => !task.assigneeId && task.status !== 'DONE').length;
      const blockers = ready ? (current.openBlockersCount ?? 0) : 0;
      const breakdown = ready ? current.stageBreakdown : undefined;
      const telemetry = ready ? current.flowTelemetry : undefined;
      return <Card className="tf-overview-delivery"
        title="交付进度"
        extra={<Button type="text" size="small" icon={<FileSpreadsheet size={14} />} onClick={openDigest}>晨会 / 迭代简报</Button>}
      >
        <div className="tf-overview-delivery-grid">
          <div className="tf-overview-progress">
            <div className="tf-overview-completion"><strong>{rate}%</strong><span>任务完成率 · {done}/{total}</span></div>
            <div className="tf-health-bar" aria-label="任务状态分布">
              {total > 0 && distribution.filter(item => item.count > 0).map(item => (
                <span key={item.className} className={`tf-health-seg-${item.className}`} style={{ width: `${item.count / total * 100}%` }} title={`${item.label} ${item.count}`} />
              ))}
            </div>
            <div className="tf-overview-progress-legend">
              {distribution.map(item => <span key={item.className}><i className={`tf-health-seg-${item.className}`} />{item.label} <b>{item.count}</b></span>)}
            </div>
            <div className="tf-overview-workload">
              {unclaimed > 0 && <span>待认领 <b>{unclaimed}</b></span>}
              {ready && <span>阻断项 <b>{blockers}</b></span>}
            </div>
          </div>
          <DeliveryFlowGuide breakdown={breakdown} />
        </div>
        {telemetry && <dl className="tf-overview-flow-stats">
          <div><dt>变更前置周期 P50</dt><dd>{formatFlowHours(telemetry.medianLeadTimeHours)}</dd></div>
          <div><dt>评审用时 P50</dt><dd>{formatFlowHours(telemetry.medianReviewTurnaroundHours)}</dd></div>
          <div><dt>首次评审通过率</dt><dd>{telemetry.firstTimePassRate == null ? '—' : `${telemetry.firstTimePassRate}%`}</dd></div>
          <div><dt>近 7 天结项</dt><dd>{telemetry.throughput7d.tasksDone} 项</dd></div>
        </dl>}
      </Card>;
    })()}
    {(digestOpen || digestEverOpened) && (
      <Suspense fallback={null}>
        <StandupDigestModal
          open={digestOpen}
          onClose={() => setDigestOpen(false)}
          user={user}
          projects={projects}
          tasks={visibleTasks}
          pendingJobs={pendingJobs}
          workspaces={workspaces}
          openBlockersCount={ready ? (current.openBlockersCount ?? 0) : 0}
          stageBreakdown={ready ? current.stageBreakdown : undefined}
          reviewCount={reviewCount}
          assetCount={assetCount}
        />
      </Suspense>
    )}
  </div>;
};

export const ProjectDirectory: React.FC<{
  projects: Project[];
  tasks: WorkTask[];
  onOpen: (id: string, section?: WorkspaceSection) => void;
  onCreate?: () => void;
  onSyncJiraProjects?: () => void;
  syncingJiraProjects?: boolean;
  onProjectRenamed?: (project: Project) => void;
  onProjectDeleted?: (projectId: string) => void | Promise<void>;
  onUnauthorized?: () => void;
}> = ({ projects, tasks, onOpen, onCreate, onSyncJiraProjects, syncingJiraProjects, onProjectRenamed, onProjectDeleted, onUnauthorized }) => {
  const { message, modal } = App.useApp();
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [editingId, setEditingId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [savingId, setSavingId] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const [openingKey, setOpeningKey] = useState('');
  const [skillsProjectId, setSkillsProjectId] = useState('');
  const searchInputRef = useRef<InputRef>(null);
  const mounted = useRef(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void api<{ workspaces: ProjectWorkspace[] }>('project-workspaces')
      .then(res => { if (mounted.current && Array.isArray(res?.workspaces)) setWorkspaces(res.workspaces); })
      .catch(() => { /* optional local repo decoration */ });
    return () => { mounted.current = false; };
  }, [projects.length]);

  const groups = [...new Map(projects.map(project => { const group = projectGroup(project); return [group.id, group] as const; })).values()];
  const activeGroup = groups.some(group => group.id === groupId) ? groupId : '';
  useEffect(() => { if (activeGroup !== groupId) setGroupId(activeGroup); }, [activeGroup, groupId]);
  const resetFilters = () => { setSearch(''); setGroupId(''); };
  const filtered = projects.filter(project => (!activeGroup || projectGroup(project).id === activeGroup) && (!search.trim() || `${project.key} ${project.name}`.toLowerCase().includes(search.trim().toLowerCase())));

  const canRename = (project: Project) => project.role === 'ADMIN' || project.role === 'LEAD';
  const canDelete = (project: Project) => (project.role === 'ADMIN' || project.role === 'LEAD') && project.id !== 'default';

  const confirmDeleteProject = (project: Project, taskCount: number) => {
    if (!canDelete(project) || deletingId) return;
    modal.confirm({
      title: `删除项目 ${project.key}（${project.name}）？`,
      content: taskCount > 0
        ? `该项目下当前有 ${taskCount} 项本地任务。确认后将从本地工作台永久删除该项目及其任务、材料、评审记录与项目级配置；不会修改或删除外部 Jira / Confluence / GitLab 中的任何数据。`
        : '将从本地工作台删除该空项目及其成员角色与项目级配置；不会影响外部 Jira / Confluence / GitLab 中的任何数据。',
      okText: '确认删除项目',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingId(project.id);
        try {
          const query = taskCount > 0 ? '?cascade=1' : '';
          await api<{ deletedProjectId: string; deletedKey: string; deletedTasks: number }>(
            `projects/${encodeURIComponent(project.id)}${query}`,
            undefined,
            'DELETE',
          );
          if (!mounted.current) return;
          void message.success(`已删除项目 ${project.key}。`);
          await onProjectDeleted?.(project.id);
        } catch (error) {
          if (mounted.current) void message.error(error instanceof Error ? error.message : '删除项目失败。');
        } finally {
          if (mounted.current) setDeletingId('');
        }
      },
    });
  };

  const startRename = (project: Project) => {
    if (!canRename(project) || savingId) return;
    setEditingId(project.id);
    setDraftName(project.name);
  };

  const cancelRename = () => {
    if (savingId) return;
    setEditingId('');
    setDraftName('');
  };

  const commitRename = async (project: Project) => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      void message.warning('项目名称不能为空。');
      return;
    }
    if (trimmed === project.name) {
      cancelRename();
      return;
    }
    setSavingId(project.id);
    try {
      const res = await api<{ project: Project }>(`projects/${encodeURIComponent(project.id)}`, { name: trimmed }, 'PATCH');
      if (!mounted.current) return;
      onProjectRenamed?.(res.project);
      setEditingId('');
      setDraftName('');
      void message.success('项目名称已保存。');
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '修改项目名称失败。');
    } finally {
      if (mounted.current) setSavingId('');
    }
  };

  const openRepoDirect = async (projectId: string, repoPath: string, app: 'finder' | 'cursor') => {
    const key = `${projectId}:${app}`;
    setOpeningKey(key);
    try {
      await api('local-git/open', { projectId, repoPath, app });
      if (mounted.current) {
        void message.success(app === 'finder' ? '已在 Finder 中打开项目文件夹。' : '已在 Cursor 中打开项目仓库。');
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '打开本地目录失败。');
    } finally {
      if (mounted.current) setOpeningKey('');
    }
  };

  const workspaceByProject = new Map(workspaces.map(ws => [ws.projectId, ws]));
  const skillsProject = projects.find(project => project.id === skillsProjectId);

  const renderProject = (project: Project) => {
    const work = tasks.filter(task => task.projectId === project.id);
    const activeCount = work.filter(task => task.status !== 'DONE').length;
    const ws = workspaceByProject.get(project.id);
    const repoBase = ws?.repoPath.split('/').filter(Boolean).pop();
    const isEditing = editingId === project.id;

    return <li key={project.id} className="tf-project-row">
      <div className="tf-project-identity">
        <span className="tf-project-symbol" aria-hidden="true"><FolderKanban size={18} /></span>
        <div className="tf-project-text">
          {isEditing ? (
            <div className="tf-project-inline-rename">
              <Input
                autoFocus
                aria-label={`编辑项目 ${project.key} 名称`}
                value={draftName}
                maxLength={100}
                disabled={savingId === project.id}
                onChange={event => setDraftName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitRename(project);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelRename();
                  }
                }}
              />
              <Button size="small" type="primary" icon={<Check size={14} />} loading={savingId === project.id} aria-label="保存项目名称" onClick={() => void commitRename(project)} />
              <Button size="small" type="text" icon={<X size={14} />} disabled={savingId === project.id} aria-label="取消编辑名称" onClick={cancelRename} />
            </div>
          ) : (
            <div className="tf-project-title-row">
              <button type="button" className="tf-overview-task-title" title={project.name} onClick={() => onOpen(project.id, 'tasks')}>{project.name}</button>
              {canRename(project) && (
                <Tooltip title="编辑名称">
                  <Button type="text" size="small" className="tf-project-rename-trigger" icon={<Pencil size={13} />} aria-label={`编辑 ${project.name} 名称`} onClick={() => startRename(project)} />
                </Tooltip>
              )}
            </div>
          )}
          <div className="tf-overview-task-meta">
            <code>{project.key}</code>
            <span className="tf-project-role-small">{roleLabel(project.role)}</span>
            {repoBase && <span title={ws?.repoPath}>{repoBase}</span>}
          </div>
        </div>
      </div>
      <div className="tf-project-work">
        <strong>{activeCount}</strong><span>待办</span>
        <strong>{work.length - activeCount}</strong><span>已完成</span>
      </div>
      <div className="tf-project-role">{roleLabel(project.role)}</div>
      <div className="tf-project-card-actions">
        {ws && <>
          <Tooltip title="在 Finder 打开仓库"><Button type="text" icon={<FolderOpen size={15} />} loading={openingKey === `${project.id}:finder`} aria-label="在 Finder 打开仓库" onClick={() => void openRepoDirect(project.id, ws.repoPath, 'finder')} /></Tooltip>
          <Tooltip title="在 Cursor 打开仓库"><Button type="text" icon={<Terminal size={15} />} loading={openingKey === `${project.id}:cursor`} aria-label="在 Cursor 打开仓库" onClick={() => void openRepoDirect(project.id, ws.repoPath, 'cursor')} /></Tooltip>
        </>}
        <Button type="text" onClick={() => onOpen(project.id, 'members')}>成员</Button>
        {project.permissions?.manageConnections && <Button type="text" onClick={() => onOpen(project.id, 'connections')}>连接</Button>}
        <Button type="text" aria-label={`配置项目 ${project.key} 的 Skills`} onClick={() => setSkillsProjectId(project.id)}>Skills</Button>
        {canDelete(project) && (
          <Tooltip title="删除项目">
            <Button type="text" danger icon={<Trash2 size={15} />} loading={deletingId === project.id} disabled={Boolean(deletingId && deletingId !== project.id)} aria-label={`删除项目 ${project.key}`} onClick={() => confirmDeleteProject(project, work.length)} />
          </Tooltip>
        )}
        <Tooltip title="进入任务">
          <Button type="text" icon={<ArrowRight size={16} />} aria-label={`进入项目 ${project.key} 任务`} onClick={() => onOpen(project.id, 'tasks')} />
        </Tooltip>
      </div>
    </li>;
  };

  const visibleGroups = groupId || search.trim() ? [] : groups;
  return <div className="tf-project-directory">
    <div className="tf-project-directory-toolbar">
      <div className="tf-project-filter">
        <Input
          ref={searchInputRef}
          prefix={<Search size={16} />}
          aria-label="搜索项目"
          placeholder="搜索项目名称或标识"
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={clearSearchOnEscape(search, () => setSearch(''))}
          allowClear
        />
        <Select aria-label="项目分组" value={activeGroup} onChange={setGroupId} options={[{ value: '', label: '全部分组' }, ...groups.map(group => ({ value: group.id, label: group.name }))]} />
        {(!!search || !!activeGroup) && <Button type="text" onClick={resetFilters}>清空筛选</Button>}
      </div>
      <div className="tf-project-toolbar-actions">
        {onSyncJiraProjects && <Button icon={<RefreshCw size={15} />} aria-label="按 Jira 权限同步项目" loading={syncingJiraProjects} onClick={onSyncJiraProjects}>同步 Jira 项目</Button>}
        {onCreate && <Button type="primary" icon={<Plus size={16} />} onClick={onCreate}>新建项目</Button>}
      </div>
    </div>
    <div className="tf-project-roster">
      {!filtered.length ? (
        <Empty description="没有符合条件的项目" image={Empty.PRESENTED_IMAGE_SIMPLE}>{(!!search || !!activeGroup) && <Button onClick={resetFilters}>清空筛选</Button>}</Empty>
      ) : visibleGroups.length > 1 ? visibleGroups.map(group => {
        const items = filtered.filter(project => projectGroup(project).id === group.id);
        return <section key={group.id} className="tf-project-group-section">
          <h2 className="tf-project-group-header">{group.name}<span>{items.length}</span></h2>
          <ul className="tf-project-list">{items.map(renderProject)}</ul>
        </section>;
      }) : (
        <ul className="tf-project-list">{filtered.map(renderProject)}</ul>
      )}
    </div>
    {skillsProject && <ProjectSkillsDialog key={skillsProject.id} project={skillsProject} onClose={() => setSkillsProjectId('')} onUnauthorized={onUnauthorized} />}
  </div>;
};

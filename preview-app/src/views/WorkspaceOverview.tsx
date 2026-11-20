import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Col, Drawer, Empty, Flex, Input, List, Row, Select, Skeleton, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import { ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, ClipboardCheck, FileSpreadsheet, FileText, FolderKanban, FolderOpen, ListTodo, Pencil, RefreshCw, Search, Terminal, X } from 'lucide-react';
import { api, ApiError, APPROVE_ROLES, OverviewStageStat, OverviewSummary, OverviewSummaryJob, Project, projectGroup, ProjectWorkspace, REVIEW_STAGE_OPTIONS, Stage, STAGES, timeText, User, WorkTask } from './workspaceApi';
import { StatusBadge } from '../components/Primitives';
import { navigateWorkspace, openTaskRoute, WorkspaceSection } from './workspaceNavigation';
import { isTaskFrozen } from './taskAvailability';
import { DeliveryFlowGuide } from './DeliveryFlowGuide';
import { DEFAULT_APPROVE_REASON, roleLabel, stageLabel, taskStatusLabel } from './displayLabels';
import { formatFlowHours, gradeDoraLeadTime, gradeFirstTimePassRate, gradeReviewTurnaround, type OverviewFlowTelemetry } from './deliveryMetrics';
import { evaluateReviewSla } from './reviewQueueSla';
import { clearSearchOnEscape, isEditableTarget, readStoredStringList, writeStoredStringList } from './uiPreferences';
import './WorkspaceOverview.css';

const StandupDigestModal = lazy(() => import('./StandupDigestModal').then(mod => ({ default: mod.StandupDigestModal })));
const ReviewDetail = lazy(() => import('./ReviewDetail').then(mod => ({ default: mod.ReviewDetail })));

const COLLAPSED_GROUPS_KEY = 'taskflow.projects.collapsedGroups';

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
  const [activePendingJob, setActivePendingJob] = useState<OverviewSummaryJob | null>(null);
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
    <DeliveryFlowGuide />
    <Row gutter={[16, 16]}>{metrics.map(item => <Col key={item.section} xs={12} lg={6}><Card className="tf-overview-metric" hoverable role="link" tabIndex={0} aria-label={`查看${item.title}`} onClick={() => navigateWorkspace(item.section)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); navigateWorkspace(item.section); } }}><Flex justify="space-between" align="center"><Statistic title={item.title} value={item.value} loading={item.loading} /><span className="tf-overview-icon" aria-hidden="true">{item.icon}</span></Flex><span className="tf-overview-metric-link">查看<ArrowRight size={13} /></span></Card></Col>)}</Row>
    <div className="tf-overview-columns">
      <Card title="我的待办" extra={<Space size={8} wrap><Button size="small" icon={<FileSpreadsheet size={14} />} onClick={openDigest}>晨会 / 迭代简报</Button>{onSyncJira && <Button size="small" icon={<RefreshCw size={14} />} loading={syncingJira} onClick={onSyncJira}>同步最新 Jira</Button>}<Button type="link" onClick={() => navigateWorkspace('tasks')}>任务中心<ArrowRight size={14} /></Button></Space>}>
        <List dataSource={mine.slice(0, 10)} locale={{ emptyText: <Empty description="当前没有指派给你的未完成任务。" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} renderItem={task => {
          const boundWs = workspaceByProject.get(task.projectId);
          return <List.Item className="tf-overview-task">
            <div className="tf-overview-task-main"><Space size={8} wrap><Typography.Text code>{task.jiraKey}</Typography.Text><Typography.Text type="secondary">{projects.find(project => project.id === task.projectId)?.name}</Typography.Text>{task.externalRef?.assignee?.displayName && <Tag>{task.externalRef.assignee.displayName}</Tag>}</Space><Button type="link" className="tf-overview-task-title" onClick={() => openTaskRoute(task.id, { from: 'overview' })}>{task.title}</Button><Typography.Text type="secondary" className="tf-overview-meta">更新于 {timeText(task.externalRef?.version || task.updatedAt)}</Typography.Text></div>
            <Space size={6} wrap>
              <StatusBadge variant="neutral">{task.externalRef ? task.externalRef.status : taskStatusLabel(task.status)}</StatusBadge>
              {boundWs && (
                <Tooltip title={`在 Finder 打开仓库：${boundWs.repoPath}`}>
                  <Button
                    size="small"
                    type="text"
                    icon={<FolderOpen size={14} />}
                    loading={openingTaskProject === task.projectId}
                    onClick={() => void openTaskRepo(task.projectId, boundWs.repoPath)}
                  >
                    Finder
                  </Button>
                </Tooltip>
              )}
              <Button size="small" type="primary" ghost onClick={() => openTaskRoute(task.id, { from: 'overview' })}>立即推进</Button>
            </Space>
          </List.Item>;
        }} />
      </Card>
      <div className="tf-overview-side">
        <Card
          title="待审批的报告"
          extra={
            <Space size={6} wrap>
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
              <Button type="link" size="small" onClick={() => navigateWorkspace('reviews')}>评审中心</Button>
            </Space>
          }
        >
          {loading ? <Skeleton active paragraph={{ rows: 2 }} /> : pending.length ? <List dataSource={pending.slice(0, 5)} renderItem={job => {
            const jobTask = visibleTasks.find(task => task.id === job.taskId);
            const canQuickApprove = isJobQuickApprovable(job);
            const sla = evaluateReviewSla(job);
            return <List.Item>
              <Flex justify="space-between" align="center" gap={8} style={{ width: '100%' }} wrap>
                <Space size={6} wrap>
                  <Button type="link" className="tf-overview-task-title" onClick={() => setActivePendingJob(job)}>
                    {jobTask?.jiraKey || job.taskId} · {stageLabel(job.stage)}
                  </Button>
                  <Tag color={sla.tagColor} style={{ marginInlineEnd: 0 }}>{sla.label}</Tag>
                </Space>
                <Space size={6} wrap>
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
                  <Button size="small" onClick={() => setActivePendingJob(job)}>
                    {canQuickApprove ? '查看' : '查看并处理'}
                  </Button>
                </Space>
              </Flex>
            </List.Item>;
          }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={ready ? '暂无待审批报告' : current?.failure || '尚未读取评审记录。'} />}
        </Card>

        {(() => {
          const totalVisible = visibleTasks.length;
          const doneTasksCount = visibleTasks.filter(t => t.status === 'DONE').length;
          const reviewTasksCount = visibleTasks.filter(t => t.status === 'IN_REVIEW').length;
          const progressTasksCount = visibleTasks.filter(t => t.status === 'IN_PROGRESS').length;
          const openTasksCount = visibleTasks.filter(t => t.status === 'OPEN').length;
          const unclaimedTasksCount = visibleTasks.filter(t => !t.assigneeId && t.status !== 'DONE').length;
          const completionRate = totalVisible > 0 ? Math.round((doneTasksCount / totalVisible) * 100) : 0;
          const blockers = ready ? (current.openBlockersCount ?? 0) : 0;
          const breakdown = ready ? (current.stageBreakdown || {}) : {};
          return (
            <Card
              title="交付健康度与门禁瓶颈雷达"
              size="small"
              extra={<Button type="link" size="small" icon={<FileSpreadsheet size={13} />} onClick={openDigest}>导出简报</Button>}
            >
              <Flex vertical gap={12}>
                <div>
                  <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 6 }}>
                    <Typography.Text style={{ fontSize: 12.5 }}>
                      任务完成率 <strong>{completionRate}%</strong>（{doneTasksCount}/{totalVisible}）
                    </Typography.Text>
                    <Space size={6} wrap>
                      {unclaimedTasksCount > 0 && <Tag style={{ marginInlineEnd: 0 }}>待认领 {unclaimedTasksCount}</Tag>}
                      {blockers > 0 ? (
                        <Tag color="error" style={{ marginInlineEnd: 0 }}>活跃阻断项 {blockers}</Tag>
                      ) : (
                        <Tag color="success" style={{ marginInlineEnd: 0 }}>0 活跃阻断</Tag>
                      )}
                    </Space>
                  </Flex>
                  {totalVisible > 0 && (
                    <div className="tf-health-bar" aria-label="任务状态分布">
                      {doneTasksCount > 0 && <div className="tf-health-seg-done" style={{ width: `${(doneTasksCount / totalVisible) * 100}%` }} title={`已完成 ${doneTasksCount}`} />}
                      {reviewTasksCount > 0 && <div className="tf-health-seg-review" style={{ width: `${(reviewTasksCount / totalVisible) * 100}%` }} title={`评审中 ${reviewTasksCount}`} />}
                      {progressTasksCount > 0 && <div className="tf-health-seg-progress" style={{ width: `${(progressTasksCount / totalVisible) * 100}%` }} title={`进行中 ${progressTasksCount}`} />}
                      {openTasksCount > 0 && <div className="tf-health-seg-open" style={{ width: `${(openTasksCount / totalVisible) * 100}%` }} title={`待开始 ${openTasksCount}`} />}
                    </div>
                  )}
                  <Flex gap={10} wrap style={{ marginTop: 6 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>已完成 {doneTasksCount}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>评审中 {reviewTasksCount}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>进行中 {progressTasksCount}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>待开始 {openTasksCount}</Typography.Text>
                  </Flex>
                </div>

                <Flex vertical gap={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
                    五阶段门禁流转分布（点击直达对应阶段）
                  </Typography.Text>
                  {STAGES.map(s => {
                    const st = breakdown[s.value] || { approved: 0, pendingApproval: 0, awaitingReport: 0, changesRequested: 0 };
                    return (
                      <div
                        key={s.value}
                        role="link"
                        tabIndex={0}
                        className="tf-stage-radar-row"
                        onClick={() => navigateWorkspace('reviews', { stage: s.value })}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); navigateWorkspace('reviews', { stage: s.value }); } }}
                      >
                        <Typography.Text style={{ fontSize: 12.5, fontWeight: 500 }}>{s.label}</Typography.Text>
                        <Space size={4} wrap>
                          {st.pendingApproval > 0 && <Tag color="processing" style={{ marginInlineEnd: 0 }}>待审 {st.pendingApproval}</Tag>}
                          {st.awaitingReport > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>待报告 {st.awaitingReport}</Tag>}
                          {st.changesRequested > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>退回 {st.changesRequested}</Tag>}
                          <Tag color={st.approved > 0 ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>已过 {st.approved}</Tag>
                        </Space>
                      </div>
                    );
                  })}
                </Flex>

                {ready && current.flowTelemetry && (() => {
                  const flow = current.flowTelemetry;
                  const leadGrade = gradeDoraLeadTime(flow.medianLeadTimeHours);
                  const turnGrade = gradeReviewTurnaround(flow.medianReviewTurnaroundHours);
                  const passGrade = gradeFirstTimePassRate(flow.firstTimePassRate);
                  return (
                    <Flex vertical gap={6}>
                      <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
                        DORA 研发效能与门禁流转遥测
                      </Typography.Text>
                      <div className="tf-dora-telemetry-grid">
                        <div className="tf-dora-tile">
                          <Flex justify="space-between" align="center" gap={4} wrap>
                            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>变更前置周期 (P50)</Typography.Text>
                            <Tag color={leadGrade.tagColor} style={{ marginInlineEnd: 0 }}>{leadGrade.label}</Tag>
                          </Flex>
                          <span className="tf-dora-tile-value">{formatFlowHours(flow.medianLeadTimeHours)}</span>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            P90 {formatFlowHours(flow.p90LeadTimeHours)} · 结项 {flow.completedTasksTotal}
                          </Typography.Text>
                        </div>

                        <div className="tf-dora-tile">
                          <Flex justify="space-between" align="center" gap={4} wrap>
                            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>门禁审批周转 (P50)</Typography.Text>
                            <Tag color={turnGrade.tagColor} style={{ marginInlineEnd: 0 }}>{turnGrade.label}</Tag>
                          </Flex>
                          <span className="tf-dora-tile-value">{formatFlowHours(flow.medianReviewTurnaroundHours)}</span>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            P90 {formatFlowHours(flow.p90ReviewTurnaroundHours)} · 已决 {flow.decidedReviewsCount}
                          </Typography.Text>
                        </div>

                        <div className="tf-dora-tile">
                          <Flex justify="space-between" align="center" gap={4} wrap>
                            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>门禁一次通过率</Typography.Text>
                            <Tag color={passGrade.tagColor} style={{ marginInlineEnd: 0 }}>{passGrade.label}</Tag>
                          </Flex>
                          <span className="tf-dora-tile-value">{flow.firstTimePassRate !== null ? `${flow.firstTimePassRate}%` : '—'}</span>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            放行 {flow.approvedReviewsCount} · 退回返工 {flow.reworkReviewsCount}
                          </Typography.Text>
                        </div>

                        <div className="tf-dora-tile">
                          <Flex justify="space-between" align="center" gap={4} wrap>
                            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>近 7 天交付吞吐</Typography.Text>
                            <Tag color={flow.throughput7d.tasksDone + flow.throughput7d.gatesApproved + flow.throughput7d.assetsVersioned > 0 ? 'processing' : 'default'} style={{ marginInlineEnd: 0 }}>7d 窗口</Tag>
                          </Flex>
                          <span className="tf-dora-tile-value">{flow.throughput7d.tasksDone} 项结项</span>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            过审 {flow.throughput7d.gatesApproved} · 新材料 {flow.throughput7d.assetsVersioned}
                          </Typography.Text>
                        </div>
                      </div>
                    </Flex>
                  );
                })()}
              </Flex>
            </Card>
          );
        })()}
      </div>
    </div>
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
    <Drawer
      title={
        activePendingJob ? (
          <Flex justify="space-between" align="center" gap={8} wrap>
            <span>{`${visibleTasks.find(t => t.id === activePendingJob.taskId)?.jiraKey || activePendingJob.taskId} · ${stageLabel(activePendingJob.stage)}`}</span>
            <Button
              size="small"
              type="link"
              onClick={() => {
                const target = activePendingJob;
                setActivePendingJob(null);
                openTaskRoute(target.taskId, { tab: 'reviews', jobId: target.id, from: 'overview' });
              }}
            >
              前往所属任务链路 →
            </Button>
          </Flex>
        ) : '评审报告详情'
      }
      size={920}
      open={!!activePendingJob}
      onClose={() => setActivePendingJob(null)}
      destroyOnHidden
    >
      {activePendingJob && (() => {
        const jobTask = visibleTasks.find(t => t.id === activePendingJob.taskId);
        if (!jobTask) return <Empty description="该任务当前不可见或已移出。" />;
        const projRole = projects.find(p => p.id === activePendingJob.projectId)?.role || user.role;
        const ws = workspaceByProject.get(activePendingJob.projectId);
        return (
          <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
            <ReviewDetail
              key={activePendingJob.id}
              jobId={activePendingJob.id}
              task={jobTask}
              user={user}
              role={projRole}
              members={[user]}
              repoPath={ws?.repoPath || null}
              onChanged={async () => {
                setReloadTick(tick => tick + 1);
                onApproved?.();
              }}
              onUnauthorized={onUnauthorized}
              onForbidden={onUnauthorized}
            />
          </Suspense>
        );
      })()}
    </Drawer>
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
}> = ({ projects, tasks, onOpen, onCreate, onSyncJiraProjects, syncingJiraProjects, onProjectRenamed }) => {
  const { message } = App.useApp();
  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => readStoredStringList(COLLAPSED_GROUPS_KEY));
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [editingId, setEditingId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [savingId, setSavingId] = useState('');
  const [openingKey, setOpeningKey] = useState('');
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

  const toggleGroupCollapse = (id: string) => {
    setCollapsedGroups(prev => {
      const next = prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id];
      writeStoredStringList(COLLAPSED_GROUPS_KEY, next);
      return next;
    });
  };

  const canRename = (project: Project) => project.role === 'ADMIN' || project.role === 'LEAD';

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

  const renderCard = (project: Project) => {
    const work = tasks.filter(task => task.projectId === project.id);
    const activeWorkCount = work.filter(task => task.status !== 'DONE').length;
    const doneWorkCount = work.length - activeWorkCount;
    const group = projectGroup(project);
    const ws = workspaceByProject.get(project.id);
    const repoBase = ws?.repoPath ? ws.repoPath.split('/').filter(Boolean).pop() || ws.repoPath : '';
    const isEditing = editingId === project.id;
    const editable = canRename(project);

    return <Col key={project.id} xs={24} md={12} xl={8}><Card className="tf-project-directory-card"><Flex vertical gap={14} className="tf-project-card-content">
      <Flex justify="space-between" align="center" gap={8}>
        <Space size={6} wrap>
          <Typography.Text code>{project.key}</Typography.Text>
          {ws && <Tooltip title={`已绑定本地仓库：${ws.repoPath}`}><Tag color="geekblue">{repoBase}</Tag></Tooltip>}
        </Space>
        <Tag>{group.name}</Tag>
      </Flex>

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
        <div className="tf-project-title-row" onDoubleClick={() => startRename(project)} title={editable ? '双击可直接修改本地显示名称' : undefined}>
          <Typography.Title level={3}>{project.name}</Typography.Title>
          {editable && (
            <Tooltip title="编辑名称（双击标题也可直接改）">
              <Button
                type="text"
                size="small"
                className="tf-project-rename-trigger"
                icon={<Pencil size={13} />}
                aria-label={`编辑 ${project.name} 名称`}
                onClick={() => startRename(project)}
              />
            </Tooltip>
          )}
        </div>
      )}

      <Flex gap={24} wrap>
        <div>
          <Typography.Text type="secondary">任务</Typography.Text>
          <div className="tf-project-task-count">{work.length}</div>
          {work.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              待办 {activeWorkCount} · 已完成 {doneWorkCount}
            </Typography.Text>
          )}
        </div>
        <div><Typography.Text type="secondary">本地角色</Typography.Text><div className="tf-project-role">{roleLabel(project.role)}</div></div>
      </Flex>

      <Flex gap={6} wrap className="tf-project-card-actions">
        <Button type="primary" ghost onClick={() => onOpen(project.id, 'tasks')}>进入任务<ArrowRight size={14} /></Button>
        {ws && (
          <Button
            size="middle"
            icon={<FolderOpen size={14} />}
            loading={openingKey === `${project.id}:finder`}
            onClick={() => void openRepoDirect(project.id, ws.repoPath, 'finder')}
          >
            Finder 打开
          </Button>
        )}
        {ws && (
          <Tooltip title="在 Cursor 中打开该仓库">
            <Button
              type="text"
              icon={<Terminal size={14} />}
              loading={openingKey === `${project.id}:cursor`}
              onClick={() => void openRepoDirect(project.id, ws.repoPath, 'cursor')}
            >
              Cursor
            </Button>
          </Tooltip>
        )}
        <Button type="text" onClick={() => onOpen(project.id, 'members')}>成员</Button>
        {project.permissions?.manageConnections && <Button type="text" onClick={() => onOpen(project.id, 'connections')}>连接</Button>}
      </Flex>
    </Flex></Card></Col>;
  };

  const visibleGroups = [...new Map(filtered.map(project => { const group = projectGroup(project); return [group.id, group] as const; })).values()];
  const showGrouped = !activeGroup && !search.trim() && visibleGroups.length > 1;
  const allGroupsCollapsed = showGrouped && visibleGroups.every(group => collapsedGroups.includes(group.id));
  const toggleAllGroups = () => {
    const visibleIds = visibleGroups.map(group => group.id);
    setCollapsedGroups(prev => {
      const next = allGroupsCollapsed
        ? prev.filter(id => !visibleIds.includes(id))
        : [...new Set([...prev, ...visibleIds])];
      writeStoredStringList(COLLAPSED_GROUPS_KEY, next);
      return next;
    });
  };

  return <div className="tf-project-directory">
    <Flex gap={12} wrap className="tf-project-directory-toolbar">
      <Input
        ref={searchInputRef}
        prefix={<Search size={16} />}
        aria-label="搜索项目"
        placeholder="搜索项目名称或标识（按 / 聚焦，Esc 清空）"
        value={search}
        onChange={event => setSearch(event.target.value)}
        onKeyDown={clearSearchOnEscape(search, () => setSearch(''))}
        allowClear
      />
      <Select aria-label="项目分组" value={activeGroup} onChange={setGroupId} options={[{ value: '', label: '全部分组' }, ...groups.map(group => ({ value: group.id, label: group.name }))]} />
      {showGrouped && <Button type="text" onClick={toggleAllGroups}>{allGroupsCollapsed ? '全部展开' : '全部收起'}</Button>}
      {(!!search || !!activeGroup) && <Button type="text" onClick={resetFilters}>清空筛选</Button>}
      {onSyncJiraProjects && <Button icon={<RefreshCw size={15} />} loading={syncingJiraProjects} onClick={onSyncJiraProjects}>按 Jira 权限同步项目</Button>}
      {onCreate && <Button className="tf-project-create" type="primary" onClick={onCreate}>新建本地项目</Button>}
    </Flex>
    <Typography.Paragraph type="secondary" className="tf-project-group-note">
      {projects.some(project => project.jira?.category)
        ? '按 Jira 项目分类展示（分组展开/折叠会自动记住）；双击项目标题可直接修改本地显示名称。'
        : projects.some(project => project.jira)
          ? '按项目名称前缀分组（分组展开/折叠会自动记住）；双击项目标题可直接修改本地显示名称，不影响远端 Jira。'
          : '本地项目空间；在「账号管理」绑定个人 Jira 账号后，可点击上方「按 Jira 权限同步项目」自动显示你有权限的 Jira 项目。'}
    </Typography.Paragraph>
    {!filtered.length ? (
      <Card><Empty description="没有符合条件的项目" image={Empty.PRESENTED_IMAGE_SIMPLE}>{(!!search || !!activeGroup) && <Button onClick={resetFilters}>清空筛选</Button>}</Empty></Card>
    ) : showGrouped ? (
      <Flex vertical gap={14}>
        {visibleGroups.map(group => {
          const items = filtered.filter(project => projectGroup(project).id === group.id);
          const isCollapsed = collapsedGroups.includes(group.id);
          return (
            <section key={group.id} className="tf-project-group-section">
              <button
                type="button"
                className="tf-project-group-header"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroupCollapse(group.id)}
              >
                {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                <span className="tf-project-group-title">{group.name}</span>
                <span className="tf-project-group-count">{items.length} 个项目</span>
              </button>
              {!isCollapsed && <Row gutter={[16, 16]}>{items.map(renderCard)}</Row>}
            </section>
          );
        })}
      </Flex>
    ) : (
      <Row gutter={[16, 16]}>{filtered.map(renderCard)}</Row>
    )}
  </div>;
};

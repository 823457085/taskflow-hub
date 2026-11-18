import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Checkbox, Drawer, Empty, Flex, Grid, Input, List, Pagination, Segmented, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { InputRef, TableColumnsType } from 'antd';
import { ArrowRight, CheckCircle2, ExternalLink, Play, Plus, RefreshCw, Search } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { api, ApiError, AssetKind, REVIEW_STAGE_OPTIONS, ReviewJob, Role, Stage, timeText, User, WorkTask } from './workspaceApi';
import { assetKindFromRoute, navigateWorkspace, openTaskRoute, reviewStageFromRoute } from './workspaceNavigation';
import { canQuickApproveReview, isTaskFrozen } from './taskAvailability';
import { ASSET_KIND_OPTIONS, assetKindLabel, DEFAULT_APPROVE_REASON, reviewStatusLabel, stageLabel, taskStatusLabel } from './displayLabels';
import { evaluateReviewSla, isReviewActionableByUser, sortReviewsByQueuePriority } from './reviewQueueSla';
import { clearSearchOnEscape, isEditableTarget, readStoredBool, readStoredChoice, writeStoredBool, writeStoredString } from './uiPreferences';
import './WorkflowCenters.css';

const { Text } = Typography;
const REVIEW_SCOPE_KEY = 'taskflow.reviews.quickScope';
const REVIEW_SORT_KEY = 'taskflow.reviews.sortMode';
const ASSET_LATEST_ONLY_KEY = 'taskflow.assets.latestOnly';
const REVIEW_SCOPES = ['all', 'needs_my_action', 'pending_approval', 'awaiting_report', 'approved'] as const;
const REVIEW_SORT_MODES = ['newest', 'oldest_waiting'] as const;
type ReviewQuickScope = typeof REVIEW_SCOPES[number];
type ReviewSortMode = typeof REVIEW_SORT_MODES[number];
type CenterProps = { projectId: string; tasks: WorkTask[]; onUnauthorized: () => void };
type ReviewCenterProps = CenterProps & { user?: User | null; role?: Role; onChanged?: () => Promise<void> };
export interface ProjectAssetMetadata {
  id: string;
  taskId: string;
  projectId: string;
  kind: AssetKind;
  logicalKey: string;
  title: string;
  sourceUrl: string | null;
  revision: number;
  sha256: string;
  actorId: string;
  createdAt: string;
  taskKey: string;
  taskTitle: string;
}

function useProjectCollection<T>(resource: 'jobs' | 'assets', projectId: string, onUnauthorized: () => void) {
  const { message } = App.useApp();
  const [data, setData] = useState<{ projectId: string; items: T[] }>({ projectId: '', items: [] });
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ projectId: string; message: string }>();
  const sequence = useRef(0);
  const unauthorizedRef = useRef(onUnauthorized);
  const messageRef = useRef(message);
  unauthorizedRef.current = onUnauthorized;
  messageRef.current = message;

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!projectId) {
      setData({ projectId: '', items: [] }); setFailure(undefined); setLoading(false);
      return;
    }
    setLoading(true); setFailure(undefined);
    try {
      const response = await api<Record<string, T[]>>(resource + '?projectId=' + encodeURIComponent(projectId));
      if (request !== sequence.current) return;
      const items = response?.[resource];
      if (!Array.isArray(items)) throw new Error('平台响应格式不正确。');
      setData({ projectId, items });
    } catch (error) {
      if (request !== sequence.current) return;
      const text = error instanceof Error ? error.message : '请求失败。';
      setFailure({ projectId, message: text });
      setData(current => ({ projectId, items: error instanceof ApiError && error.status === 403 ? [] : current.projectId === projectId ? current.items : [] }));
      void messageRef.current.error(text);
      if (error instanceof ApiError && error.status === 401) unauthorizedRef.current();
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [projectId, resource]);

  useEffect(() => {
    void refresh();
    return () => { sequence.current += 1; };
  }, [refresh]);

  return {
    items: data.projectId === projectId ? data.items : [],
    loading: loading || (!!projectId && data.projectId !== projectId),
    failure: failure?.projectId === projectId ? failure.message : undefined,
    refresh,
  };
}

function TaskPickerDrawer({ open, projectId, tasks, type, onClose }: {
  open: boolean;
  projectId: string;
  tasks: WorkTask[];
  type: 'reviews' | 'assets';
  onClose: () => void;
}) {
  const [filterText, setFilterText] = useState('');
  const eligibleTasks = tasks.filter(task => task.projectId === projectId && !isTaskFrozen(task, tasks));
  const lowered = filterText.trim().toLowerCase();
  const filteredTasks = eligibleTasks.filter(task => !lowered || `${task.jiraKey} ${task.title}`.toLowerCase().includes(lowered));
  const title = type === 'reviews' ? '点击任务进入评审' : '点击任务添加材料';
  useEffect(() => { setFilterText(''); }, [projectId, open]);
  const jumpToTask = (taskId: string) => {
    onClose();
    openTaskRoute(taskId, { tab: type, from: type });
  };

  return <Drawer title={title} open={open} onClose={onClose} size={560} className="tf-workflow-task-picker" footer={<Flex justify="flex-end" gap={8}>
    <Button onClick={onClose}>关闭</Button>
    {!eligibleTasks.length && <Button type="primary" onClick={() => { onClose(); navigateWorkspace('tasks'); }}>前往任务中心</Button>}
  </Flex>}>
    {eligibleTasks.length ? <Flex vertical gap={12}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {type === 'reviews' ? '直接点击下方任意任务，一步直达该任务的评审页。' : '直接点击下方任意任务，一步直达该任务的材料页。'}
      </Typography.Paragraph>
      <Input
        prefix={<Search size={16} />}
        aria-label="筛选任务"
        placeholder="搜索任务号或标题（按 Esc 清空）"
        allowClear
        value={filterText}
        onChange={event => setFilterText(event.target.value)}
        onKeyDown={clearSearchOnEscape(filterText, () => setFilterText(''))}
      />
      <List
        dataSource={filteredTasks}
        rowKey="id"
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的任务。" /> }}
        renderItem={task => (
          <List.Item
            style={{ cursor: 'pointer', paddingInline: 8, borderRadius: 6 }}
            onClick={() => jumpToTask(task.id)}
            actions={[<Button key="go" type="link" size="small" icon={<ArrowRight size={14} />} iconPlacement="end" onClick={e => { e.stopPropagation(); jumpToTask(task.id); }}>{type === 'reviews' ? '去评审' : '加材料'}</Button>]}
          >
            <div className="tf-workflow-title-cell">
              <Space size={8} wrap>
                <Text className="tf-workflow-code">{task.jiraKey}</Text>
                <StatusBadge variant="neutral">{task.externalRef ? task.externalRef.status : taskStatusLabel(task.status)}</StatusBadge>
              </Space>
              <Text strong>{task.title}</Text>
            </div>
          </List.Item>
        )}
      />
    </Flex> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前项目暂无可编辑的任务。" />}
  </Drawer>;
}

const reviewBadgeVariant = (status: string): 'green' | 'blue' | 'warn' | 'neutral' => {
  if (status === 'APPROVED') return 'green';
  if (status === 'REPORT_SUBMITTED') return 'blue';
  if (status === 'CHANGES_REQUESTED' || status === 'REJECTED') return 'warn';
  return 'neutral';
};

export const ReviewCenter: React.FC<ReviewCenterProps> = ({ projectId, tasks, user, role, onChanged, onUnauthorized }) => {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const { items: jobs, loading, failure, refresh } = useProjectCollection<ReviewJob>('jobs', projectId, onUnauthorized);
  const [stage, setStage] = useState<Stage | 'all'>(() => reviewStageFromRoute() || 'all');
  const [statusScope, setStatusScope] = useState<ReviewQuickScope>(() => readStoredChoice(REVIEW_SCOPE_KEY, REVIEW_SCOPES, 'all'));
  const [sortMode, setSortMode] = useState<ReviewSortMode>(() => readStoredChoice(REVIEW_SORT_KEY, REVIEW_SORT_MODES, 'newest'));
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [approvingJobId, setApprovingJobId] = useState('');
  const [batchApproving, setBatchApproving] = useState(false);
  const searchRef = useRef<InputRef>(null);
  useEffect(() => { setStage(reviewStageFromRoute() || 'all'); setPage(1); setQuery(''); setPickerOpen(false); }, [projectId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    const update = () => { setStage(reviewStageFromRoute() || 'all'); setPage(1); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const taskMap = new Map(tasks.filter(task => task.projectId === projectId).map(task => [task.id, task]));
  const eligibleTasks = tasks.filter(task => task.projectId === projectId && !isTaskFrozen(task, tasks));
  const triggerNewReview = () => {
    if (eligibleTasks.length === 1) {
      openTaskRoute(eligibleTasks[0].id, { tab: 'reviews', from: 'reviews' });
      return;
    }
    setPickerOpen(true);
  };
  const quickApprove = async (job: ReviewJob) => {
    if (approvingJobId || batchApproving) return;
    setApprovingJobId(job.id);
    try {
      await api<{ job: ReviewJob }>(`jobs/${encodeURIComponent(job.id)}/decision`, {
        decision: 'APPROVE',
        reason: DEFAULT_APPROVE_REASON,
      });
      const taskKey = taskMap.get(job.taskId)?.jiraKey || '';
      void message.success(`已一键批准${taskKey ? ` ${taskKey}` : ''}【${stageLabel(job.stage)}】。`);
      await Promise.all([refresh(), onChanged ? onChanged().catch(() => {}) : Promise.resolve()]);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '批准失败。');
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
    } finally {
      setApprovingJobId('');
    }
  };
  const stageOrderIndex = (value: Stage) => REVIEW_STAGE_OPTIONS.findIndex(item => item.value === value);
  const quickApproveBatch = async (jobsToApprove: ReviewJob[]) => {
    if (!jobsToApprove.length || approvingJobId || batchApproving) return;
    setBatchApproving(true);
    let approvedCount = 0;
    const ordered = [...jobsToApprove].sort((a, b) => stageOrderIndex(a.stage) - stageOrderIndex(b.stage));
    try {
      for (const job of ordered) {
        await api<{ job: ReviewJob }>(`jobs/${encodeURIComponent(job.id)}/decision`, {
          decision: 'APPROVE',
          reason: DEFAULT_APPROVE_REASON,
        });
        approvedCount += 1;
      }
      void message.success(`已一键批准全部 ${approvedCount} 份待审批记录。`);
    } catch (error) {
      const errText = error instanceof Error ? error.message : '批量批准中断。';
      void message.error(approvedCount ? `已批准 ${approvedCount} 份，剩余项失败：${errText}` : errText);
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
    } finally {
      setBatchApproving(false);
      if (approvedCount > 0) {
        await Promise.all([refresh(), onChanged ? onChanged().catch(() => {}) : Promise.resolve()]);
      }
    }
  };
  const stageFilteredJobs = jobs.filter(job => stage === 'all' || job.stage === stage);
  const actionableByMeJobs = stageFilteredJobs.filter(job => isReviewActionableByUser(job, taskMap.get(job.taskId), tasks, user, role));
  const nextActionableQueue = sortReviewsByQueuePriority(actionableByMeJobs, 'oldest_waiting');
  const overdueActiveCount = stageFilteredJobs.filter(job => evaluateReviewSla(job).isOverdue).length;
  const pendingApprovalCount = stageFilteredJobs.filter(job => job.status === 'REPORT_SUBMITTED' && !job.stale).length;
  const awaitingReportCount = stageFilteredJobs.filter(job => ['AWAITING_REPORT', 'AWAITING_REVIEW'].includes(job.status) && !job.stale).length;
  const approvedCount = stageFilteredJobs.filter(job => job.status === 'APPROVED').length;
  const matchesStatusScope = (job: ReviewJob): boolean => {
    if (statusScope === 'needs_my_action') return isReviewActionableByUser(job, taskMap.get(job.taskId), tasks, user, role);
    if (statusScope === 'pending_approval') return job.status === 'REPORT_SUBMITTED' && !job.stale;
    if (statusScope === 'awaiting_report') return ['AWAITING_REPORT', 'AWAITING_REVIEW'].includes(job.status) && !job.stale;
    if (statusScope === 'approved') return job.status === 'APPROVED';
    return true;
  };
  const search = query.trim().toLowerCase();
  const filteredJobs = stageFilteredJobs.filter(job => {
    const task = taskMap.get(job.taskId);
    return matchesStatusScope(job) && (!search || [job.id, job.status, reviewStatusLabel(job.status), stageLabel(job.stage), task?.jiraKey, task?.title].filter(Boolean).join(' ').toLowerCase().includes(search));
  });
  const visibleJobs = sortReviewsByQueuePriority(filteredJobs, sortMode);
  const approvableVisibleJobs = visibleJobs.filter(job => canQuickApproveReview(job, taskMap.get(job.taskId), tasks, user, role));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleJobs.length / 10)));
  useEffect(() => { if (currentPage !== page) setPage(currentPage); }, [currentPage, page]);
  const resetFilters = () => {
    setStage('all');
    setStatusScope('all');
    writeStoredString(REVIEW_SCOPE_KEY, 'all');
    setQuery('');
    setPage(1);
    navigateWorkspace('reviews');
  };
  const openReview = (job: ReviewJob) => openTaskRoute(job.taskId, { tab: 'reviews', jobId: job.id, from: 'reviews' });
  const columns: TableColumnsType<ReviewJob> = [
    { title: '所属任务', key: 'task', width: 252, render: (_, job) => {
      const task = taskMap.get(job.taskId);
      return <div className="tf-workflow-title-cell"><Text className="tf-workflow-code">{task?.jiraKey || job.taskId}</Text><Button type="link" className="tf-workflow-title-link" onClick={() => openReview(job)}>{task?.title || job.taskId}</Button></div>;
    } },
    { title: '评审阶段', dataIndex: 'stage', key: 'stage', width: 146, render: value => <Text>{stageLabel(value)}</Text> },
    { title: '评审状态', dataIndex: 'status', key: 'status', width: 152, render: value => <StatusBadge variant={reviewBadgeVariant(value)}>{reviewStatusLabel(value)}</StatusBadge> },
    { title: 'SLA 时效', key: 'sla', width: 132, render: (_, job) => {
      const sla = evaluateReviewSla(job);
      return <Tag color={sla.tagColor} style={{ marginInlineEnd: 0 }}>{sla.label}</Tag>;
    } },
    { title: '材料有效性', dataIndex: 'stale', key: 'stale', width: 116, render: value => <StatusBadge variant={value ? 'warn' : 'neutral'}>{value ? '材料已更新' : '当前有效'}</StatusBadge> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 162, render: value => <Text type="secondary" className="tf-workflow-secondary">{timeText(value)}</Text> },
    { title: '操作', key: 'action', width: 164, render: (_, job) => {
      const task = taskMap.get(job.taskId);
      const canApprove = canQuickApproveReview(job, task, tasks, user, role);
      return <Space size={4} wrap>
        {canApprove && (
          <Button
            type="primary"
            size="small"
            icon={<CheckCircle2 size={13} />}
            loading={approvingJobId === job.id}
            disabled={batchApproving || (!!approvingJobId && approvingJobId !== job.id)}
            onClick={event => { event.stopPropagation(); void quickApprove(job); }}
          >
            一键批准
          </Button>
        )}
        <Button type="link" size="small" onClick={event => { event.stopPropagation(); openReview(job); }}>查看</Button>
      </Space>;
    } },
  ];
  const hasFilters = stage !== 'all' || statusScope !== 'all' || !!search;
  const emptyDescription = failure || (projectId ? !hasFilters ? '当前项目暂无评审记录。' : '没有符合条件的评审记录。' : '请先选择项目。');
  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription}>{!failure && projectId && (hasFilters ? <Button onClick={resetFilters}>清空筛选</Button> : <Button onClick={triggerNewReview}>{eligibleTasks.length === 1 ? `前往 ${eligibleTasks[0].jiraKey} 发起评审` : '选择任务发起评审'}</Button>)}</Empty>;

  return <div className="tf-workflow-center">
    <Card
      title={<Space size={8} wrap><h2 className="tf-workflow-heading">评审记录</h2><Text type="secondary" className="tf-workflow-secondary">{visibleJobs.length} / {jobs.length}</Text>{overdueActiveCount > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>超 SLA 滞留 {overdueActiveCount}</Tag>}</Space>}
      extra={
        <Space wrap size={8}>
          {nextActionableQueue.length > 0 && (
            <Tooltip title="按滞留时长优先，立即打开最需要你处理的评审事项">
              <Button
                icon={<Play size={14} />}
                onClick={() => openReview(nextActionableQueue[0])}
              >
                逐项处理待办 ({nextActionableQueue.length})
              </Button>
            </Tooltip>
          )}
          {approvableVisibleJobs.length >= 2 && (
            <Button
              type="primary"
              icon={<CheckCircle2 size={15} />}
              loading={batchApproving}
              disabled={!!approvingJobId}
              onClick={() => void quickApproveBatch(approvableVisibleJobs)}
            >
              一键全部批准 ({approvableVisibleJobs.length})
            </Button>
          )}
          <Button icon={<RefreshCw size={16} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          <Button type={approvableVisibleJobs.length >= 2 ? 'default' : 'primary'} icon={<Plus size={16} />} disabled={!projectId} onClick={triggerNewReview}>{eligibleTasks.length === 1 ? `发起评审 (${eligibleTasks[0].jiraKey})` : '选择任务发起评审'}</Button>
        </Space>
      }
    >
      <Tabs activeKey={stage} onChange={value => { const next = REVIEW_STAGE_OPTIONS.find(item => item.value === value)?.value; setStage(next || 'all'); setPage(1); navigateWorkspace('reviews', { stage: next }); }} items={[{ key: 'all', label: '全部' }, ...REVIEW_STAGE_OPTIONS.map(item => ({ key: item.value, label: item.label }))]} />
      <Flex justify="space-between" align="center" gap={10} wrap style={{ marginBottom: 12 }}>
        <div style={{ overflowX: 'auto' }}>
          <Segmented<ReviewQuickScope>
            aria-label="评审状态快捷筛选"
            value={statusScope}
            onChange={val => { setStatusScope(val); writeStoredString(REVIEW_SCOPE_KEY, val); setPage(1); }}
            options={[
              { value: 'all', label: `全部 (${stageFilteredJobs.length})` },
              { value: 'needs_my_action', label: `待我处理 (${actionableByMeJobs.length})` },
              { value: 'pending_approval', label: `待审批 (${pendingApprovalCount})` },
              { value: 'awaiting_report', label: `待提交报告 (${awaitingReportCount})` },
              { value: 'approved', label: `已通过 (${approvedCount})` },
            ]}
          />
        </div>
        <Segmented<ReviewSortMode>
          size="small"
          aria-label="评审队列排序模式"
          value={sortMode}
          onChange={val => { setSortMode(val); writeStoredString(REVIEW_SORT_KEY, val); setPage(1); }}
          options={[
            { value: 'newest', label: '最新创建' },
            { value: 'oldest_waiting', label: '滞留最久优先' },
          ]}
        />
      </Flex>
      <div className="tf-workflow-toolbar"><Input ref={searchRef} aria-label="搜索评审" prefix={<Search size={16} />} allowClear placeholder="搜索任务号、任务标题或评审状态（按 / 聚焦，Esc 清空）" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} onKeyDown={clearSearchOnEscape(query, () => { setQuery(''); setPage(1); })} />{(stage !== 'all' || statusScope !== 'all' || !!query) && <Button type="text" onClick={resetFilters}>清空筛选</Button>}</div>
      {screens.md ? <Table<ReviewJob> rowKey="id" columns={columns} dataSource={visibleJobs} loading={loading} scroll={{ x: 1124 }} pagination={{ current: currentPage, onChange: setPage, pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} locale={{ emptyText: empty }} onRow={record => ({ style: { cursor: 'pointer' }, onClick: event => { if (!(event.target as HTMLElement).closest('button,a,input,.ant-select')) openReview(record); } })} /> : <>
        <List className="tf-workflow-mobile-list" rowKey="id" loading={loading} dataSource={visibleJobs.slice((currentPage - 1) * 10, currentPage * 10)} locale={{ emptyText: empty }} renderItem={job => {
          const task = taskMap.get(job.taskId);
          const canApprove = canQuickApproveReview(job, task, tasks, user, role);
          const sla = evaluateReviewSla(job);
          return <List.Item>
            <div className="tf-workflow-title-cell"><Text className="tf-workflow-code">{task?.jiraKey || job.taskId}</Text><Button type="link" className="tf-workflow-title-link" onClick={() => openReview(job)}>{task?.title || job.taskId}</Button></div>
            <Text>{stageLabel(job.stage)}</Text>
            <Space wrap size={[8, 8]}><StatusBadge variant={reviewBadgeVariant(job.status)}>{reviewStatusLabel(job.status)}</StatusBadge><Tag color={sla.tagColor} style={{ marginInlineEnd: 0 }}>{sla.label}</Tag>{job.stale && <StatusBadge variant="warn">材料已更新</StatusBadge>}</Space>
            <Flex justify="space-between" align="center" gap={8} wrap>
              <Text type="secondary" className="tf-workflow-secondary">{timeText(job.createdAt)}</Text>
              <Space size={6}>
                {canApprove && <Button type="primary" size="small" icon={<CheckCircle2 size={13} />} loading={approvingJobId === job.id} disabled={!!approvingJobId && approvingJobId !== job.id} onClick={() => void quickApprove(job)}>一键批准</Button>}
                <Button type="link" size="small" onClick={() => openReview(job)}>查看</Button>
              </Space>
            </Flex>
          </List.Item>;
        }} />
        <Pagination className="tf-workflow-mobile-pagination" size="small" current={currentPage} onChange={setPage} total={visibleJobs.length} pageSize={10} showSizeChanger={false} hideOnSinglePage />
      </>}
    </Card>
    <TaskPickerDrawer open={pickerOpen} projectId={projectId} tasks={tasks} type="reviews" onClose={() => setPickerOpen(false)} />
  </div>;
};

export const AssetCenter: React.FC<CenterProps> = ({ projectId, tasks, onUnauthorized }) => {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const { items: assets, loading, failure, refresh } = useProjectCollection<ProjectAssetMetadata>('assets', projectId, onUnauthorized);
  const [kind, setKind] = useState<AssetKind | undefined>(assetKindFromRoute);
  const [latestOnly, setLatestOnly] = useState<boolean>(() => readStoredBool(ASSET_LATEST_ONLY_KEY, false));
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const searchRef = useRef<InputRef>(null);
  useEffect(() => { setKind(assetKindFromRoute()); setPage(1); setQuery(''); setPickerOpen(false); }, [projectId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    const update = () => { setKind(assetKindFromRoute()); setPage(1); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const eligibleTasks = tasks.filter(task => task.projectId === projectId && !isTaskFrozen(task, tasks));
  const triggerNewAsset = () => {
    if (eligibleTasks.length === 1) {
      openTaskRoute(eligibleTasks[0].id, { tab: 'assets', from: 'assets' });
      return;
    }
    setPickerOpen(true);
  };
  const maxRevisionBySlot = new Map<string, number>();
  for (const item of assets) {
    const slotKey = `${item.taskId}::${item.kind}::${item.logicalKey}`;
    const prev = maxRevisionBySlot.get(slotKey) ?? 0;
    if (item.revision > prev) maxRevisionBySlot.set(slotKey, item.revision);
  }
  const isLatestRevision = (item: ProjectAssetMetadata) =>
    maxRevisionBySlot.get(`${item.taskId}::${item.kind}::${item.logicalKey}`) === item.revision;
  const scopedAssets = latestOnly ? assets.filter(isLatestRevision) : assets;
  const search = query.trim().toLowerCase();
  const visibleAssets = scopedAssets.filter(asset => (!kind || asset.kind === kind) && (!search || [asset.title, asset.logicalKey, assetKindLabel(asset.kind), asset.taskKey, asset.taskTitle].join(' ').toLowerCase().includes(search)));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleAssets.length / 10)));
  useEffect(() => { if (currentPage !== page) setPage(currentPage); }, [currentPage, page]);
  const resetFilters = () => { setKind(undefined); setLatestOnly(false); writeStoredBool(ASSET_LATEST_ONLY_KEY, false); setQuery(''); setPage(1); navigateWorkspace('assets'); };
  const openAssets = (asset: ProjectAssetMetadata) => openTaskRoute(asset.taskId, { tab: 'assets', from: 'assets' });
  const formatLogicalKey = (asset: ProjectAssetMetadata) =>
    asset.logicalKey === asset.kind ? `默认${assetKindLabel(asset.kind)}标识` : asset.logicalKey;
  const columns: TableColumnsType<ProjectAssetMetadata> = [
    { title: '材料', key: 'asset', width: 260, render: (_, asset) => <div className="tf-workflow-title-cell"><Button type="link" className="tf-workflow-title-link" onClick={() => openAssets(asset)}>{asset.title}</Button><Text type="secondary" className="tf-workflow-code tf-workflow-ellipsis" ellipsis={{ tooltip: asset.logicalKey }}>{formatLogicalKey(asset)}</Text></div> },
    { title: '类型', dataIndex: 'kind', key: 'kind', width: 112, render: value => <StatusBadge variant="blue">{assetKindLabel(value)}</StatusBadge> },
    { title: '所属任务', key: 'task', width: 200, render: (_, asset) => <div className="tf-workflow-title-cell"><Text className="tf-workflow-code">{asset.taskKey}</Text><Button type="link" className="tf-workflow-title-link" onClick={() => openAssets(asset)}>{asset.taskTitle}</Button></div> },
    { title: '版本', dataIndex: 'revision', key: 'revision', width: 96, render: (value, asset) => <Space size={4}><Text className="tf-workflow-code">r{value}</Text>{isLatestRevision(asset) && value > 1 && <Tag color="success" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', paddingInline: 4 }}>最新</Tag>}</Space> },
    { title: '内容指纹', dataIndex: 'sha256', key: 'sha256', width: 116, render: value => <Tooltip title={`点击复制完整 SHA-256：${value}`}><Text className="tf-workflow-code tf-workflow-hash" style={{ cursor: 'pointer' }} onClick={event => { event.stopPropagation(); void navigator.clipboard.writeText(String(value || '')).then(() => message.success('已复制完整 SHA-256 指纹。')).catch(() => {}); }}>{String(value || '').slice(0, 10)}</Text></Tooltip> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 168, render: value => <Text type="secondary" className="tf-workflow-secondary">{timeText(value)}</Text> },
    { title: '来源', key: 'source', width: 96, render: (_, asset) => asset.sourceUrl ? <Typography.Link href={asset.sourceUrl} target="_blank" rel="noreferrer" className="tf-workflow-source" onClick={event => event.stopPropagation()}><span>查看来源</span><ExternalLink size={14} /></Typography.Link> : <Text type="secondary">—</Text> },
  ];
  const emptyDescription = failure || (projectId ? !kind && !search && !latestOnly ? '当前项目暂无材料版本。' : '没有符合条件的材料版本。' : '请先选择项目。');
  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription}>{!failure && projectId && (kind || !!search || latestOnly ? <Button onClick={resetFilters}>清空筛选</Button> : <Button onClick={triggerNewAsset}>{eligibleTasks.length === 1 ? `前往 ${eligibleTasks[0].jiraKey} 添加材料` : '选择任务添加材料'}</Button>)}</Empty>;

  return <div className="tf-workflow-center">
    <Card title={<Space size={8}><h2 className="tf-workflow-heading">材料版本</h2><Text type="secondary" className="tf-workflow-secondary">{visibleAssets.length} / {assets.length}</Text></Space>} extra={<Space wrap size={8}><Button icon={<RefreshCw size={16} />} loading={loading} onClick={() => void refresh()}>刷新</Button><Button type="primary" icon={<Plus size={16} />} disabled={!projectId} onClick={triggerNewAsset}>{eligibleTasks.length === 1 ? `添加材料 (${eligibleTasks[0].jiraKey})` : '选择任务添加材料'}</Button></Space>}>
      <div style={{ marginBottom: 12, overflowX: 'auto' }}>
        <Segmented<string>
          aria-label="材料类型快捷筛选"
          value={kind || 'all'}
          onChange={val => {
            const next = val === 'all' ? undefined : (val as AssetKind);
            setKind(next);
            setPage(1);
            navigateWorkspace('assets', { kind: next });
          }}
          options={[
            { value: 'all', label: `全部 (${scopedAssets.length})` },
            ...ASSET_KIND_OPTIONS.map(opt => ({
              value: opt.value,
              label: `${opt.label} (${scopedAssets.filter(item => item.kind === opt.value).length})`,
            })),
          ]}
        />
      </div>
      <div className="tf-workflow-toolbar"><Input ref={searchRef} aria-label="搜索材料" prefix={<Search size={16} />} allowClear placeholder="搜索材料、任务或类型（按 / 聚焦，Esc 清空）" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} onKeyDown={clearSearchOnEscape(query, () => { setQuery(''); setPage(1); })} /><Select aria-label="材料类型" placeholder="全部类型" allowClear value={kind} onChange={value => { setKind(value); setPage(1); navigateWorkspace('assets', { kind: value }); }} options={ASSET_KIND_OPTIONS} /><Checkbox checked={latestOnly} onChange={e => { const next = e.target.checked; setLatestOnly(next); writeStoredBool(ASSET_LATEST_ONLY_KEY, next); setPage(1); }}>仅看最新修订</Checkbox>{(kind || !!query || latestOnly) && <Button type="text" onClick={resetFilters}>清空筛选</Button>}</div>
      {screens.md ? <Table<ProjectAssetMetadata> rowKey="id" columns={columns} dataSource={visibleAssets} loading={loading} scroll={{ x: 1028 }} pagination={{ current: currentPage, onChange: setPage, pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} locale={{ emptyText: empty }} onRow={record => ({ style: { cursor: 'pointer' }, onClick: event => { if (!(event.target as HTMLElement).closest('button,a,input,.ant-select')) openAssets(record); } })} /> : <>
        <List className="tf-workflow-mobile-list" rowKey="id" loading={loading} dataSource={visibleAssets.slice((currentPage - 1) * 10, currentPage * 10)} locale={{ emptyText: empty }} renderItem={asset => <List.Item>
          <div className="tf-workflow-title-cell"><Button type="link" className="tf-workflow-title-link" onClick={() => openAssets(asset)}>{asset.title}</Button><Text type="secondary" className="tf-workflow-code">{asset.logicalKey}</Text></div>
          <Space wrap size={[8, 8]}><StatusBadge variant="blue">{assetKindLabel(asset.kind)}</StatusBadge><Text className="tf-workflow-code">r{asset.revision}</Text></Space>
          <Button type="link" className="tf-workflow-title-link" onClick={() => openAssets(asset)}>{asset.taskKey} · {asset.taskTitle}</Button>
          <Text type="secondary" className="tf-workflow-code">{asset.sha256}</Text>
          <Flex gap={8} justify="space-between" wrap><Text type="secondary" className="tf-workflow-secondary">{timeText(asset.createdAt)}</Text>{asset.sourceUrl && <Typography.Link href={asset.sourceUrl} target="_blank" rel="noreferrer" className="tf-workflow-source">查看来源<ExternalLink size={14} /></Typography.Link>}</Flex>
        </List.Item>} />
        <Pagination className="tf-workflow-mobile-pagination" size="small" current={currentPage} onChange={setPage} total={visibleAssets.length} pageSize={10} showSizeChanger={false} hideOnSinglePage />
      </>}
    </Card>
    <TaskPickerDrawer open={pickerOpen} projectId={projectId} tasks={tasks} type="assets" onClose={() => setPickerOpen(false)} />
  </div>;
};

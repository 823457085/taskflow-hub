import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Empty, Flex, Form, Input, Pagination, Segmented, Select, Skeleton, Tag, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import { ChevronRight, ExternalLink, Plus, RefreshCw, Search } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { api, ApiError, ASSET_ROLES, Asset, AssetKind, isChildTask, Project, REVIEW_STAGE_OPTIONS, ReviewJob, Stage, timeText, User, WorkTask } from './workspaceApi';
import { assetKindFromRoute, navigateWorkspace, openTaskRoute, reviewStageFromRoute, taskReturnFilters } from './workspaceNavigation';
import type { MaterialCategory } from './workspaceNavigation';
import { isTaskFrozen } from './taskAvailability';
import { ASSET_KIND_OPTIONS, assetKindLabel, executionModeLabel, reviewStatusLabel, stageLabel } from './displayLabels';
import { currentAiReviews, evaluateReviewSla, isReviewActionableByUser, sortReviewsByQueuePriority } from './reviewQueueSla';
import { clearSearchOnEscape, isEditableTarget, isSubmitShortcut, readStoredChoice, writeStoredString } from './uiPreferences';
import { groupTaskMaterials } from './assetGroups';
import { MarkdownPreview } from './MarkdownPreview';
import { CodeMaterialPreview } from './CodeMaterialPreview';
import { ConfluencePreview, isConfluenceStorage } from './ConfluencePreview';
import './WorkTaskDetail.css';
import './WorkflowCenters.css';

const PAGE_SIZE = 10;
const REVIEW_SCOPE_KEY = 'taskflow.reviews.quickScope';
const REVIEW_SORT_KEY = 'taskflow.reviews.sortMode';
const REVIEW_SCOPES = ['all', 'needs_my_action', 'pending_approval', 'awaiting_report', 'approved'] as const;
const REVIEW_SORT_MODES = ['newest', 'oldest_waiting'] as const;
type ReviewQuickScope = typeof REVIEW_SCOPES[number] | 'history';
type ReviewSortMode = typeof REVIEW_SORT_MODES[number];
type CenterProps = { projectId: string; projects: Project[]; tasks: WorkTask[]; onChanged?: () => Promise<void>; onBeforeRefresh?: () => Promise<boolean>; onUnauthorized: () => void };

async function runCenterRefresh(
  refresh: () => Promise<void>,
  onChanged?: () => Promise<void>,
  onBeforeRefresh?: () => Promise<boolean>,
): Promise<void> {
  if (onBeforeRefresh && (await onBeforeRefresh())) return;
  await Promise.all([refresh(), onChanged ? onChanged().catch(() => {}) : Promise.resolve()]);
}
type ReviewCenterProps = CenterProps & { user?: User | null };
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

const materialCategoryOptions: { value: MaterialCategory; label: string }[] = [
  ...ASSET_KIND_OPTIONS,
  { value: 'JIRA_ISSUE', label: 'Jira 事项' },
  { value: 'DESIGN_REFERENCE', label: '设计稿与原型' },
];

function materialCategory(asset: ProjectAssetMetadata): MaterialCategory {
  if (asset.logicalKey.startsWith('jira:jira_issue:')) return 'JIRA_ISSUE';
  if (asset.logicalKey === 'review:design-references') return 'DESIGN_REFERENCE';
  return asset.kind;
}

function materialCategoryLabel(asset: ProjectAssetMetadata): string {
  return materialCategoryOptions.find(option => option.value === materialCategory(asset))?.label ?? assetKindLabel(asset.kind);
}

function useProjectCollection<T>(resource: 'jobs' | 'assets', projectId: string, onUnauthorized: () => void) {
  const { message } = App.useApp();
  const [data, setData] = useState<{ projectId: string; items: T[] }>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ projectId: string; message: string }>();
  const sequence = useRef(0);
  const activeProjectId = useRef(projectId);
  const unauthorizedRef = useRef(onUnauthorized);
  const messageRef = useRef(message);
  unauthorizedRef.current = onUnauthorized;
  messageRef.current = message;
  activeProjectId.current = projectId;

  const refresh = useCallback(async () => {
    if (activeProjectId.current !== projectId) return;
    const request = ++sequence.current;
    setLoading(true); setFailure(undefined);
    try {
      const response = await api<Record<string, T[]>>(resource + (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
      if (request !== sequence.current) return;
      const items = response?.[resource];
      if (!Array.isArray(items)) throw new Error('平台响应格式不正确。');
      setData({ projectId, items });
    } catch (error) {
      if (request !== sequence.current) return;
      const text = error instanceof Error ? error.message : '请求失败。';
      setFailure({ projectId, message: text });
      setData(current => ({ projectId, items: error instanceof ApiError && error.status === 403 ? [] : current?.projectId === projectId ? current.items : [] }));
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
    items: data?.projectId === projectId ? data.items : [],
    loading: loading || data?.projectId !== projectId,
    failure: failure?.projectId === projectId ? failure.message : undefined,
    refresh,
  };
}

function WorkflowRecords({ label, children, empty, loading, page, total, onPageChange }: {
  label: string;
  children: React.ReactNode;
  empty: React.ReactNode;
  loading: boolean;
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  return <Card className="tf-workflow-records" size="small"
    title={<span className="tf-workflow-records-title">{label}<span>{total}</span></span>}
  >
    {total > 0 ? <>
      <ul className="tf-workflow-record-list" aria-label={label}>{children}</ul>
      <Pagination className="tf-workflow-pagination" size="small" current={page} onChange={onPageChange} total={total} pageSize={PAGE_SIZE} showSizeChanger={false} hideOnSinglePage />
    </> : loading ? <Skeleton active paragraph={{ rows: 4 }} /> : empty}
  </Card>;
}

const reviewBadgeVariant = (status: string): 'green' | 'blue' | 'warn' | 'neutral' => {
  if (status === 'APPROVED') return 'green';
  if (status === 'REPORT_SUBMITTED') return 'blue';
  if (status === 'CHANGES_REQUESTED' || status === 'REJECTED') return 'warn';
  return 'neutral';
};

const readReviewStage = (): Stage | 'all' => reviewStageFromRoute() ?? taskReturnFilters().stage ?? 'all';

export const ReviewCenter: React.FC<ReviewCenterProps> = ({ projectId, projects, tasks, user, onChanged, onBeforeRefresh, onUnauthorized }) => {
  const { items: jobs, loading, failure, refresh } = useProjectCollection<ReviewJob>('jobs', projectId, onUnauthorized);
  const [stage, setStage] = useState(readReviewStage);
  const [statusScope, setStatusScope] = useState<ReviewQuickScope>(() => readStoredChoice(REVIEW_SCOPE_KEY, REVIEW_SCOPES, 'all'));
  const [sortMode, setSortMode] = useState<ReviewSortMode>(() => readStoredChoice(REVIEW_SORT_KEY, REVIEW_SORT_MODES, 'newest'));
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const searchRef = useRef<InputRef>(null);

  useEffect(() => { setStage(readReviewStage()); setPage(1); setQuery(''); }, [projectId]);
  useEffect(() => {
    const update = () => setStage(readReviewStage());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
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

  const taskMap = new Map(tasks.filter(task => !projectId || task.projectId === projectId).map(task => [task.id, task]));
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const isActionable = (job: ReviewJob) => isReviewActionableByUser(job, taskMap.get(job.taskId), tasks, user, projectMap.get(job.projectId)?.role);
  const currentJobs = currentAiReviews(jobs);
  const showingHistory = statusScope === 'history';
  const currentIds = new Set(currentJobs.map(job => job.id));
  const stageFilteredJobs = currentJobs.filter(job => stage === 'all' || job.stage === stage);
  const historicalJobs = jobs.filter(job => !currentIds.has(job.id) && (stage === 'all' || job.stage === stage));
  const actionableByMeJobs = stageFilteredJobs.filter(isActionable);
  const overdueActiveCount = stageFilteredJobs.filter(job => evaluateReviewSla(job).isOverdue).length;
  const pendingApprovalCount = stageFilteredJobs.filter(job => job.status === 'REPORT_SUBMITTED' && !job.stale).length;
  const awaitingReportCount = stageFilteredJobs.filter(job => ['AWAITING_REPORT', 'AWAITING_REVIEW'].includes(job.status) && !job.stale).length;
  const approvedCount = stageFilteredJobs.filter(job => job.status === 'APPROVED').length;
  const matchesStatusScope = (job: ReviewJob): boolean => {
    if (statusScope === 'needs_my_action') return isActionable(job);
    if (statusScope === 'pending_approval') return job.status === 'REPORT_SUBMITTED' && !job.stale;
    if (statusScope === 'awaiting_report') return ['AWAITING_REPORT', 'AWAITING_REVIEW'].includes(job.status) && !job.stale;
    if (statusScope === 'approved') return job.status === 'APPROVED';
    return true;
  };
  const search = query.trim().toLowerCase();
  const filteredJobs = (showingHistory ? historicalJobs : stageFilteredJobs).filter(job => {
    const task = taskMap.get(job.taskId);
    const project = projectMap.get(job.projectId);
    return matchesStatusScope(job) && (!search || [
      job.id, job.status, reviewStatusLabel(job.status), stageLabel(job.stage), executionModeLabel(job.executionMode), task?.jiraKey, task?.title, project?.key, project?.name,
    ].filter(Boolean).join(' ').toLowerCase().includes(search));
  });
  const visibleJobs = sortReviewsByQueuePriority(filteredJobs, sortMode);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleJobs.length / PAGE_SIZE)));
  const pageJobs = visibleJobs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  useEffect(() => { if (currentPage !== page) setPage(currentPage); }, [currentPage, page]);

  const resetFilters = () => {
    setStage('all');
    setStatusScope('all');
    writeStoredString(REVIEW_SCOPE_KEY, 'all');
    setQuery('');
    setPage(1);
    navigateWorkspace('reviews');
  };
  const hasFilters = stage !== 'all' || statusScope !== 'all' || !!search;
  const emptyDescription = failure || (hasFilters ? '没有符合条件的评审记录。' : '暂无评审记录。');

  return <div className="tf-workflow-center tf-workflow-center--reviews">
    <div className="tf-workflow-controls">
      <div className="tf-workflow-toolbar">
        <Input ref={searchRef} aria-label="搜索评审" prefix={<Search size={15} />} allowClear placeholder="搜索任务、标题或状态" value={query}
          onChange={event => { setQuery(event.target.value); setPage(1); }}
          onKeyDown={clearSearchOnEscape(query, () => { setQuery(''); setPage(1); })} />
        <Select<Stage | 'all'>
          aria-label="评审阶段"
          value={stage}
          options={[{ value: 'all', label: '全部阶段' }, ...REVIEW_STAGE_OPTIONS]}
          onChange={value => {
            setStage(value);
            setPage(1);
            navigateWorkspace('reviews', { stage: value === 'all' ? undefined : value });
          }}
        />
        <Select<ReviewSortMode>
          aria-label="评审队列排序模式"
          value={sortMode}
          onChange={value => { setSortMode(value); writeStoredString(REVIEW_SORT_KEY, value); setPage(1); }}
          options={[{ value: 'newest', label: '最新创建' }, { value: 'oldest_waiting', label: '滞留最久优先' }]}
        />
      </div>
      <div className="tf-workflow-actions">
        <Tooltip title="刷新评审">
          <Button aria-label="刷新评审" icon={<RefreshCw size={15} />} loading={loading} onClick={() => void runCenterRefresh(refresh, onChanged, onBeforeRefresh)} />
        </Tooltip>
      </div>
    </div>
    <div className="tf-workflow-scopes">
      <div className="tf-workflow-quick-scopes">
        <Segmented<ReviewQuickScope>
          aria-label="评审状态快捷筛选"
          value={statusScope}
          onChange={value => { setStatusScope(value); if (value !== 'history') writeStoredString(REVIEW_SCOPE_KEY, value); setPage(1); }}
          options={[
            { value: 'all', label: `当前评审 (${stageFilteredJobs.length})` },
            { value: 'needs_my_action', label: `待我处理 (${actionableByMeJobs.length})` },
            { value: 'pending_approval', label: `待审批 (${pendingApprovalCount})` },
            { value: 'awaiting_report', label: `待提交报告 (${awaitingReportCount})` },
            { value: 'approved', label: `已通过 (${approvedCount})` },
            { value: 'history', label: `历史 (${historicalJobs.length})` },
          ]}
        />
      </div>
      {overdueActiveCount > 0 && <Tag color="warning">超 SLA {overdueActiveCount}</Tag>}
      {hasFilters && <Button type="text" size="small" onClick={resetFilters}>清空筛选</Button>}
    </div>
    <WorkflowRecords label={showingHistory ? '历史评审' : '评审列表'}
      empty={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />}
      loading={loading} page={currentPage} total={visibleJobs.length} onPageChange={setPage}>
      {pageJobs.map(job => {
        const task = taskMap.get(job.taskId);
        const project = projectMap.get(job.projectId);
        const sla = evaluateReviewSla(job);
        return <li key={job.id} className="tf-workflow-record">
          <button type="button" className="tf-workflow-record-button tf-review-queue-row" disabled={!task}
            onClick={() => task && openTaskRoute(task.id, { tab: 'reviews', jobId: job.id, from: 'reviews' })}>
            <span className="tf-review-queue-task">
              {task && <span className="tf-workflow-code">{task.jiraKey}</span>}
              {!projectId && project && <span className="tf-workflow-project" title={project.name}>{project.key}</span>}
              <span className="tf-workflow-record-title" title={task?.title}>{task?.title || '所属任务不可见'}</span>
            </span>
            <span className="tf-review-queue-stage">{stageLabel(job.stage)}</span>
            <span className="tf-review-queue-status">
              <StatusBadge variant={reviewBadgeVariant(job.status)}>{reviewStatusLabel(job.status)}</StatusBadge>
              {showingHistory && job.stale && <Tag>快照已过期</Tag>}
              {!showingHistory && <Tag color={sla.tagColor}>{sla.label}</Tag>}
            </span>
            <time className="tf-review-queue-date" dateTime={job.createdAt}>{timeText(job.createdAt)}</time>
            {task && <ChevronRight size={15} className="tf-review-queue-chevron" aria-hidden />}
          </button>
        </li>;
      })}
    </WorkflowRecords>
  </div>;
};

const AssetReadingPane: React.FC<{
  asset: ProjectAssetMetadata;
  versions: ProjectAssetMetadata[];
  onVersionChange: (id: string) => void;
  onUnauthorized: () => void;
}> = ({ asset, versions, onVersionChange, onUnauthorized }) => {
  const { message } = App.useApp();
  const [detail, setDetail] = useState<Asset | null>();
  const [readAttempt, setReadAttempt] = useState(0);
  const onUnauthorizedRef = useRef(onUnauthorized);
  const messageRef = useRef(message);
  onUnauthorizedRef.current = onUnauthorized;
  messageRef.current = message;

  useEffect(() => {
    let alive = true;
    void api<{ assets: Asset[] }>(`tasks/${encodeURIComponent(asset.taskId)}/assets`)
      .then(result => { if (alive) setDetail(result.assets.find(item => item.id === asset.id) ?? null); })
      .catch(error => {
        if (!alive) return;
        setDetail(null);
        void messageRef.current.error(error instanceof Error ? error.message : '读取材料正文失败。');
        if (error instanceof ApiError && error.status === 401) onUnauthorizedRef.current();
      });
    return () => { alive = false; };
  }, [asset.taskId, asset.id, readAttempt]);

  const title = materialTitle(asset);
  const confluence = detail && detail.kind !== 'CODE' && isConfluenceStorage(detail.content);
  return <section className="tf-asset-reading-pane" aria-label="材料正文">
    <Flex vertical gap={12}>
      <header className="tf-asset-reading-header">
        <h3 title={asset.title}>{title}</h3>
        <Flex align="center" gap={8} wrap className="tf-asset-reading-meta">
          <span className="tf-asset-kind">{materialCategoryLabel(asset)}</span>
          <span className="tf-asset-owner">所属任务 <Button size="small" type="link" className="tf-workflow-copy" title={asset.taskTitle} onClick={() => openTaskRoute(asset.taskId, { tab: 'assets', from: 'assets' })}>{asset.taskKey}</Button></span>
          <span>版本</span>
          {versions.length > 1 ? <Select
            aria-label="材料修订版本"
            size="small"
            value={asset.id}
            onChange={onVersionChange}
            options={versions.map(item => ({ value: item.id, label: `r${item.revision} · ${timeText(item.createdAt)}` }))}
          /> : <span>r{asset.revision}</span>}
          {asset.sourceUrl && /^https?:\/\//i.test(asset.sourceUrl) && <Typography.Link href={asset.sourceUrl} target="_blank" rel="noreferrer noopener" className="tf-workflow-source">查看原文<ExternalLink size={13} /></Typography.Link>}
        </Flex>
        <details className="tf-asset-metadata">
          <summary>材料信息</summary>
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
            ...(title !== asset.title ? [{ key: 'original-title', label: '原始标题', children: asset.title }] : []),
            { key: 'created', label: '创建时间', children: timeText(asset.createdAt) },
            { key: 'sha', label: 'SHA-256', children: <Button size="small" type="link" className="tf-workflow-copy" title={asset.sha256} onClick={() => { void navigator.clipboard.writeText(asset.sha256).then(() => message.success('已复制 SHA-256 指纹。')).catch(() => {}); }}><code>{asset.sha256.slice(0, 12)}</code> · 复制</Button> },
          ]} />
        </details>
      </header>
      {detail === undefined ? <Skeleton active paragraph={{ rows: 6 }} /> : detail ? (
        detail.kind === 'CODE' ? <CodeMaterialPreview content={detail.content} />
          : confluence ? <>
            <ConfluencePreview content={detail.content} sourceUrl={detail.sourceUrl} />
            <details className="tf-asset-metadata">
              <summary>查看原始文本</summary>
              <pre className="tf-code-panel">{detail.content}</pre>
            </details>
          </> : <MarkdownPreview content={detail.content} />
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可查看的材料正文"><Button size="small" onClick={() => { setDetail(undefined); setReadAttempt(value => value + 1); }}>重新加载正文</Button></Empty>}
    </Flex>
  </section>;
};

function materialTitle(asset: ProjectAssetMetadata): string {
  if (asset.kind === 'CODE') {
    const commit = /^\S+\/\S+\s+\(([a-f0-9]{7,64})\)(?:\s*[·—：:]\s*(\S.*))?$/i.exec(asset.title);
    if (commit) return commit[2]?.trim() || `代码提交 ${commit[1].slice(0, 8)}`;
  }
  return asset.title;
}

function materialVersions(assets: ProjectAssetMetadata[]): ProjectAssetMetadata[][] {
  const byDocument = new Map<string, ProjectAssetMetadata[]>();
  for (const asset of assets) {
    const key = JSON.stringify([asset.taskId, asset.kind, asset.logicalKey]);
    const versions = byDocument.get(key);
    if (versions) versions.push(asset);
    else byDocument.set(key, [asset]);
  }
  return [...byDocument.values()].map(versions => versions.sort((a, b) => b.revision - a.revision));
}

const materialKinds = (project?: Project) => ASSET_KIND_OPTIONS.filter(option => project && ASSET_ROLES[option.value].includes(project.role));

export const AssetCenter: React.FC<CenterProps> = ({ projectId, projects, tasks, onChanged, onBeforeRefresh, onUnauthorized }) => {
  const { message } = App.useApp();
  const { items: assets, loading, failure, refresh } = useProjectCollection<ProjectAssetMetadata>('assets', projectId, onUnauthorized);
  const [kind, setKind] = useState(() => assetKindFromRoute() ?? taskReturnFilters().kind);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [savingAsset, setSavingAsset] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [assetForm] = Form.useForm<{ taskId: string; kind: AssetKind; title: string; content: string; sourceUrl?: string; logicalKey?: string }>();
  const assetTaskId = Form.useWatch('taskId', assetForm);
  const searchRef = useRef<InputRef>(null);
  useEffect(() => { setKind(assetKindFromRoute()); setPage(1); setQuery(''); setCreateOpen(false); setSelectedGroupId(''); setSelectedAssetId(''); }, [projectId]);
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
    const update = () => setKind(assetKindFromRoute() ?? taskReturnFilters().kind);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const writableProjects = new Set(projects.filter(project => materialKinds(project).length > 0).map(project => project.id));
  const eligibleTasks = tasks.filter(task => !isChildTask(task) && (!projectId || task.projectId === projectId) && writableProjects.has(task.projectId) && !isTaskFrozen(task, tasks));
  const selectedTask = eligibleTasks.find(task => task.id === assetTaskId);
  const allowedKinds = materialKinds(projectMap.get(selectedTask?.projectId || ''));
  const triggerNewAsset = () => {
    assetForm.resetFields();
    if (projectId) {
      const task = eligibleTasks.find(task => task.id === activeAsset?.taskId)
        || eligibleTasks.find(task => task.id === (activeAsset && activeGroup?.rootTaskIds.get(activeAsset.taskId)))
        || eligibleTasks.find(task => task.id === activeGroup?.taskId) || eligibleTasks[0];
      const kinds = materialKinds(projectMap.get(projectId));
      assetForm.setFieldsValue({ taskId: task?.id, kind: kinds.find(option => option.value === kind)?.value ?? kinds[0]?.value });
    }
    setCreateOpen(true);
  };
  const submitNewAsset = async (values: { taskId: string; kind: AssetKind; title: string; content: string; sourceUrl?: string; logicalKey?: string }) => {
    const task = eligibleTasks.find(item => item.id === values.taskId);
    if (savingAsset || !task || !materialKinds(projectMap.get(task.projectId)).some(option => option.value === values.kind)) return;
    setSavingAsset(true);
    try {
      await api<{ asset: Asset }>(`tasks/${encodeURIComponent(values.taskId)}/assets`, {
        kind: values.kind,
        title: values.title,
        content: values.content,
        ...(values.logicalKey?.trim() ? { logicalKey: values.logicalKey } : {}),
        ...(values.sourceUrl?.trim() ? { sourceUrl: values.sourceUrl } : {}),
      });
      setCreateOpen(false);
      void message.success('新材料版本已保存。');
      await Promise.all([refresh(), onChanged ? onChanged().catch(() => {}) : Promise.resolve()]);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '保存材料失败。');
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
    } finally {
      setSavingAsset(false);
    }
  };
  const search = query.trim().toLowerCase();
  const matchesAsset = (asset: ProjectAssetMetadata) =>
    [asset.title, materialTitle(asset), asset.logicalKey, materialCategoryLabel(asset), asset.taskKey, asset.taskTitle].join(' ').toLowerCase().includes(search);
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const groups = groupTaskMaterials(assets, tasks).map(group => ({
    ...group, documents: materialVersions(group.assets), project: projectMap.get(group.assets[0].projectId),
  }));
  const documentCounts = new Map<MaterialCategory, number>();
  let documentCount = 0;
  for (const group of groups) {
    documentCount += group.documents.length;
    for (const [latest] of group.documents) {
      const category = materialCategory(latest);
      documentCounts.set(category, (documentCounts.get(category) || 0) + 1);
    }
  }
  const visibleGroups = groups.map(group => {
    const matchesGroup = !search || [group.taskKey, group.taskTitle, group.project?.key, group.project?.name].join(' ').toLowerCase().includes(search);
    const documents = group.documents.filter(versions => {
      const owner = tasksById.get(group.rootTaskIds.get(versions[0].taskId) || '');
      const matchesOwner = owner && `${owner.jiraKey} ${owner.title}`.toLowerCase().includes(search);
      return (!kind || materialCategory(versions[0]) === kind) && (matchesGroup || matchesOwner || versions.some(matchesAsset));
    });
    return { ...group, documents, matchesGroup };
  }).filter(group => group.documents.length > 0);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visibleGroups.length / PAGE_SIZE)));
  const pageGroups = visibleGroups.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const activeGroup = pageGroups.find(group => group.id === selectedGroupId) || pageGroups[0];
  const activeVersions = activeGroup?.documents.find(versions => versions.some(asset => asset.id === selectedAssetId)) || activeGroup?.documents[0] || [];
  const preferredVersion = (versions: ProjectAssetMetadata[]) =>
    (!activeGroup?.matchesGroup && versions.find(matchesAsset)) || versions[0];
  const activeAsset = activeVersions.find(asset => asset.id === selectedAssetId) || preferredVersion(activeVersions);
  useEffect(() => { if (currentPage !== page) setPage(currentPage); }, [currentPage, page]);
  const changePage = (value: number) => { setSelectedGroupId(''); setSelectedAssetId(''); setPage(value); };
  const resetFilters = () => { setKind(undefined); setQuery(''); changePage(1); navigateWorkspace('assets'); };
  const emptyDescription = failure || (!kind && !search ? '暂无材料。' : '没有符合条件的材料。');
  const empty = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription}>{!failure && !kind && !search && !eligibleTasks.length && <Button onClick={() => navigateWorkspace('tasks')}>需求中心</Button>}</Empty>;

  return <div className="tf-workflow-center tf-workflow-center--assets">
    <div className="tf-workflow-controls">
      <div className="tf-workflow-toolbar">
        <Input ref={searchRef} aria-label="搜索材料" prefix={<Search size={15} />} allowClear placeholder="搜索需求、任务或材料" value={query} onChange={event => { setQuery(event.target.value); changePage(1); }} onKeyDown={clearSearchOnEscape(query, () => { setQuery(''); changePage(1); })} />
        <Select<MaterialCategory | 'all'> aria-label="材料类型" value={kind || 'all'} onChange={value => { const next = value === 'all' ? undefined : value; setKind(next); changePage(1); navigateWorkspace('assets', { kind: next }); }} options={[
          { value: 'all', label: `全部类型 (${documentCount})` },
          ...materialCategoryOptions.map(opt => ({ value: opt.value, label: `${opt.label} (${documentCounts.get(opt.value) || 0})` })),
        ]} />
        {(kind || !!query) && <Button type="text" onClick={resetFilters}>清空筛选</Button>}
      </div>
      <div className="tf-workflow-actions">
        <Tooltip title="刷新材料"><Button aria-label="刷新材料" icon={<RefreshCw size={15} />} loading={loading} onClick={() => void runCenterRefresh(refresh, onChanged, onBeforeRefresh)} /></Tooltip>
        <Button type="primary" icon={<Plus size={15} />} disabled={!eligibleTasks.length} onClick={triggerNewAsset}>添加材料</Button>
      </div>
    </div>
    <div className={activeAsset ? 'tf-reading-layout tf-workflow-reader' : 'tf-workflow-empty'}>
      <WorkflowRecords label="按需求查看" empty={empty} loading={loading} page={currentPage} total={visibleGroups.length} onPageChange={changePage}>
        {pageGroups.map(group => (
          <li key={group.id} className="tf-workflow-record">
            <button type="button" className="tf-workflow-record-button" aria-pressed={group.id === activeGroup?.id} onClick={() => {
              if (group.id !== activeGroup?.id) { setSelectedGroupId(group.id); setSelectedAssetId(''); }
            }}>
              <span className="tf-workflow-record-title" title={group.taskTitle}>{group.taskTitle}</span>
              <span className="tf-asset-group-meta tf-workflow-record-meta">
                <span className="tf-asset-group-key">
                  <span className="tf-workflow-code">{group.taskKey}</span>
                  {!projectId && group.project && <span className="tf-workflow-project" title={group.project.name}>{group.project.name}</span>}
                </span>
                <span>{group.documents.length} 份材料</span>
              </span>
            </button>
          </li>
        ))}
      </WorkflowRecords>
      {activeGroup && activeAsset && <Card className="tf-workflow-asset-detail" title={
        <h2 className="tf-workflow-heading" title={activeGroup.taskTitle}>{activeGroup.taskKey} · {activeGroup.taskTitle}</h2>
      } extra={<Button type="link" size="small" onClick={() => openTaskRoute(activeGroup.taskId, { tab: 'assets', from: 'assets' })}>打开任务 {activeGroup.taskKey}</Button>}>
        <ul className="tf-asset-document-list" aria-label="需求材料">
          {activeGroup.documents.map(versions => {
            const asset = preferredVersion(versions);
            return <li key={versions[0].id}>
              <button type="button" className="tf-asset-document-button" aria-pressed={versions === activeVersions} onClick={() => {
                if (versions !== activeVersions) setSelectedAssetId(asset.id);
              }}>
                <span className="tf-workflow-record-title" title={asset.title}>{materialTitle(asset)}</span>
                <span className="tf-asset-document-meta">
                  <span className="tf-asset-kind">{materialCategoryLabel(asset)}</span>
                  <span className="tf-workflow-code">{asset.taskKey}</span>
                </span>
              </button>
            </li>;
          })}
        </ul>
        <AssetReadingPane key={activeAsset.id} asset={activeAsset} versions={activeVersions} onVersionChange={setSelectedAssetId} onUnauthorized={onUnauthorized} />
      </Card>}
    </div>
    <Drawer
      forceRender
      title="登记任务材料"
      size={640}
      open={createOpen}
      closable={!savingAsset}
      maskClosable={!savingAsset}
      onClose={() => !savingAsset && setCreateOpen(false)}
      footer={
        <Flex justify="flex-end" gap={8}>
          <Button disabled={savingAsset} onClick={() => setCreateOpen(false)}>取消</Button>
          <Button type="primary" loading={savingAsset} disabled={!selectedTask || !allowedKinds.length} onClick={() => assetForm.submit()}>
            保存新版本
          </Button>
        </Flex>
      }
    >
      <Form form={assetForm} layout="vertical" disabled={savingAsset} onFinish={values => void submitNewAsset(values)}>
        <Form.Item name="taskId" label="所属主任务" rules={[{ required: true, message: '请选择所属主任务' }]}>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            placeholder={projectId ? '选择主任务' : '选择项目及主任务'}
            options={eligibleTasks.map(item => ({
              value: item.id,
              label: [!projectId && projectMap.get(item.projectId)?.name, item.jiraKey, item.title].filter(Boolean).join(' · '),
            }))}
            onChange={taskId => {
              const task = eligibleTasks.find(item => item.id === taskId);
              const kinds = materialKinds(projectMap.get(task?.projectId || ''));
              const previousKind = assetForm.getFieldValue('kind');
              if (!kinds.some(option => option.value === previousKind)) {
                assetForm.setFieldValue('kind', kinds.find(option => option.value === kind)?.value ?? kinds[0]?.value);
              }
            }}
          />
        </Form.Item>
        <Form.Item name="kind" label="材料类型" rules={[{ required: true, message: '请选择材料类型' }]}>
          <Select
            disabled={!selectedTask}
            options={allowedKinds}
          />
        </Form.Item>
        <Form.Item name="title" label="材料标题" rules={[{ required: true, whitespace: true, message: '请填写材料标题' }]}>
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item name="content" label="材料正文 / Diff / 用例内容（Cmd/Ctrl + Enter 保存）" rules={[{ required: true, whitespace: true, message: '请填写材料正文' }]}>
          <Input.TextArea
            rows={10}
            maxLength={65536}
            className="tf-code-input"
            onKeyDown={event => {
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                assetForm.submit();
              }
            }}
          />
        </Form.Item>
        <Form.Item name="sourceUrl" label="来源链接（可选）" rules={[{ type: 'url', message: '请输入有效的来源链接' }]}>
          <Input placeholder="Confluence / Jira / MR 链接" />
        </Form.Item>
        <Form.Item name="logicalKey" label="逻辑资产标识（可选）" extra="留空默认按类型归档并自动递增修订版本号 r1 -> r2">
          <Input maxLength={100} />
        </Form.Item>
      </Form>
    </Drawer>

  </div>;
};

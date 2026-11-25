import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { App, Button, Empty, Input, Modal, Pagination, Select, Skeleton } from 'antd';
import type { InputRef } from 'antd';
import { ExternalLink, Link2, Search, Settings2 } from 'lucide-react';
import { gateStatusLabel, reviewStatusLabel, taskStatusLabel, toolLabel } from './displayLabels';
import { availableAiEngine, LocalAiExecutionFields, readAiEngine, useAiModelSelection } from './LocalAiExecutionFields';
import type { RequirementReviewExecutor, RequirementReviewStage } from './requirementReviewFlow';
import { RequirementStageReview } from './RequirementStageReview';
import { currentAiReviews } from './reviewQueueSla';
import { buildTaskTree, type TreeTaskRow } from './taskTree';
import { clearSearchOnEscape, readStoredChoice, readStoredString, writeStoredString } from './uiPreferences';
import {
  api, ApiError, isChildTask, type LocalAutomationCapabilities,
  type Project, type TaskDetailBundle, type User, type WorkTask,
} from './workspaceApi';
import { openTaskRoute, navigateWorkspace, type WorkspaceSection } from './workspaceNavigation';
import './RequirementsCenter.css';

const PAGE_SIZE = 12;

function matchesRequirement(task: TreeTaskRow, query: string): boolean {
  if (!query) return true;
  return [task.jiraKey, task.title, ...(task.externalRef?.fixVersions || []).map(item => item.name)]
    .some(value => value.toLowerCase().includes(query)) || !!task.subtasks?.some(child => matchesRequirement(child, query));
}

function childCount(task: TreeTaskRow): number {
  return task.subtasks?.reduce((count, child) => count + 1 + childCount(child), 0) || 0;
}

interface RequirementsCenterProps {
  projectId: string;
  tasks: WorkTask[];
  projects: Project[];
  user: User;
  reviewStage: RequirementReviewStage;
  section?: WorkspaceSection;
  preferredTaskId?: string;
  searchInputRef?: Ref<InputRef>;
  onIntake?: () => void;
  onShowTaskList?: () => void;
  onChooseTask?: (task: WorkTask) => void;
  onSelectTask?: (task: WorkTask) => void;
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
  onForbidden: () => void;
}

export function RequirementsCenter({
  projectId, tasks, projects, user, reviewStage, section = 'tasks', preferredTaskId, searchInputRef,
  onIntake, onShowTaskList, onChooseTask, onSelectTask, onChanged, onUnauthorized, onForbidden,
}: RequirementsCenterProps) {
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState(1);
  const [bundle, setBundle] = useState<TaskDetailBundle>();
  const [bundleLoading, setBundleLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [runnerChoice, setRunnerChoice] = useState<{ key: string; value: 'local' | 'workbench' }>();
  const [deviceChoice, setDeviceChoice] = useState<{ key: string; value: string }>();
  const [enginePreference, setEnginePreference] = useState(readAiEngine);
  const requestVersion = useRef(0);
  const loadedPreferredId = useRef('');
  const feedback = useRef({ message, onUnauthorized, onForbidden, onSelectTask });
  feedback.current = { message, onUnauthorized, onForbidden, onSelectTask };
  const projectsById = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const linkedTasks = useMemo(() => {
    const tasksByJiraKey = new Map(tasks.filter(task => task.externalRef?.provider === 'jira')
      .map(task => [`${task.projectId}:${task.jiraKey}`, task]));
    return tasks.map(task => {
      const ref = task.externalRef;
      const jiraParentKey = ref?.provider === 'jira' && ref.issueType?.subtask && ref.parentKey;
      const parent = !task.parentId && jiraParentKey ? tasksByJiraKey.get(`${task.projectId}:${jiraParentKey}`) : undefined;
      return parent ? { ...task, parentId: parent.id } : task;
    });
  }, [tasks]);
  const requirements = useMemo(() => buildTaskTree(linkedTasks).filter(task => !isChildTask(task)), [linkedTasks]);
  const search = query.trim().toLowerCase();
  const filtered = requirements.filter(task => matchesRequirement(task, search));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const pageTasks = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const current = pageTasks.find(task => task.id === selectedId) || pageTasks[0];
  const currentId = current?.id;
  const activeProject = projectsById.get(current?.projectId || projectId);
  const activeProjectId = activeProject?.id;
  const relatedTasks = useMemo(() => linkedTasks.filter(task => task.projectId === activeProjectId), [linkedTasks, activeProjectId]);
  const preferencesKey = `taskflow.requirements.${user.id}.${activeProjectId || ''}`;
  const runnerKey = preferencesKey + '.runner';
  const deviceKey = preferencesKey + '.device';
  const serverMode = capabilities?.deployment === 'server';
  const supportsWorkbench = !!capabilities?.apps.workbenchUrl;
  const workbenchAuthorized = !!activeProjectId && (capabilities?.apps.workbenchProjectIds?.includes(activeProjectId) ?? false);
  const defaultRunner: 'local' | 'workbench' = supportsWorkbench && workbenchAuthorized ? 'workbench' : 'local';
  const preferredRunner = runnerChoice?.key === runnerKey ? runnerChoice.value : readStoredChoice(runnerKey, ['local', 'workbench'] as const, defaultRunner);
  const preferredDevice = deviceChoice?.key === deviceKey ? deviceChoice.value : readStoredString(deviceKey);
  const isRequirementCenter = section === 'tasks';
  const showProject = !projectId;
  const activeBundle = bundle?.task.id === currentId && bundle?.task.projectId === activeProjectId ? bundle : undefined;
  const stageJob = activeBundle && currentAiReviews(activeBundle.jobs).find(job => job.stage === reviewStage);
  const stageGate = activeBundle?.gates.gates.find(gate => gate.stage === reviewStage);
  const stageStatus = bundleLoading && !activeBundle ? '读取中'
    : stageJob ? reviewStatusLabel(stageJob.status) : stageGate ? gateStatusLabel(stageGate.status) : '待发起评审';

  useEffect(() => {
    if (current) feedback.current.onSelectTask?.(current);
  }, [currentId]);

  useEffect(() => {
    loadedPreferredId.current = '';
    setQuery('');
    setPage(1);
    setSelectedId('');
  }, [projectId]);

  useEffect(() => {
    if (!preferredTaskId) {
      loadedPreferredId.current = '';
      return;
    }
    if (loadedPreferredId.current === preferredTaskId) return;
    const index = requirements.findIndex(task => task.id === preferredTaskId);
    if (index < 0) return;
    loadedPreferredId.current = preferredTaskId;
    setSelectedId(preferredTaskId);
    if (preferredTaskId === currentId) return;
    setQuery('');
    setPage(Math.floor(index / PAGE_SIZE) + 1);
  }, [preferredTaskId, requirements, currentId]);

  const readBundle = useCallback(async () => {
    if (!currentId) return;
    const version = ++requestVersion.current;
    setBundleLoading(true);
    try {
      const result = await api<TaskDetailBundle>(`tasks/${encodeURIComponent(currentId)}/bundle`);
      if (requestVersion.current === version) setBundle(result);
    } catch (error) {
      if (requestVersion.current !== version) return;
      if (error instanceof ApiError && error.status === 401) feedback.current.onUnauthorized();
      else if (error instanceof ApiError && error.status === 403) {
        setBundle(undefined);
        feedback.current.onForbidden();
      } else if (error instanceof Error) void feedback.current.message.error(error.message);
    } finally {
      if (requestVersion.current === version) setBundleLoading(false);
    }
  }, [currentId]);
  useEffect(() => {
    void readBundle();
    return () => { requestVersion.current += 1; };
  }, [readBundle]);

  useEffect(() => {
    let active = true;
    void api<LocalAutomationCapabilities>('local-automation/capabilities').then(result => {
      if (active) setCapabilities(result);
    }).catch(error => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) feedback.current.onUnauthorized();
      else if (error instanceof Error) void feedback.current.message.error(error.message);
    });
    return () => { active = false; };
  }, [user.id, settingsOpen]);

  const runner = serverMode ? 'bridge' : supportsWorkbench ? preferredRunner : 'local';
  const devices = (capabilities?.devices || []).filter(device => activeProjectId && device.projectIds.includes(activeProjectId));
  const device = devices.find(item => item.id === preferredDevice) || devices.find(item => item.online) || devices[0];
  const engine = runner === 'workbench'
    ? enginePreference === 'cursor' ? 'cursor' : 'codex'
    : capabilities ? availableAiEngine(capabilities, enginePreference) : enginePreference;
  const model = useAiModelSelection(capabilities, engine, runner, device?.modelEngines, device?.id);
  const available = !!capabilities?.supported && !model.invalid && (
    runner === 'bridge' ? !!device && !!capabilities.bridgeModes?.includes('review')
      : runner === 'workbench' ? supportsWorkbench : capabilities.engines.some(item => item.id === engine && item.available)
  );
  const executor: RequirementReviewExecutor = {
    runner, engine, ...(model.model ? { model: model.model } : {}),
    ...(runner === 'bridge' && device ? { deviceId: device.id } : {}),
  };
  const configuredModel = model.model || model.defaultModel;
  const executionLabel = runner === 'workbench' ? '本地工作台' : runner === 'bridge' ? device?.deviceName : toolLabel(engine);
  const jiraUrl = current?.externalRef?.provider === 'jira' && /^https?:\/\//i.test(current.externalRef.url) ? current.externalRef.url : '';
  const linkedChildren = current ? childCount(current) : 0;
  const fixVersions = current?.externalRef?.fixVersions?.map(version => version.name).filter(Boolean) || [];

  function updateSearch(value: string) {
    setQuery(value);
    setPage(1);
  }

  return <div className="tf-requirements-center">
    <div className="tf-requirements-toolbar">
      <Input
        ref={searchInputRef}
        aria-label="搜索需求"
        placeholder="搜索 Jira 编号、需求标题或版本"
        prefix={<Search size={15} />}
        value={query}
        allowClear
        onChange={event => updateSearch(event.target.value)}
        onKeyDown={clearSearchOnEscape(query, () => updateSearch(''))}
      />
      <div className="tf-requirements-actions">
        {onShowTaskList && <Button type="text" onClick={onShowTaskList}>任务列表</Button>}
        <Button disabled={!activeProject} icon={<Settings2 size={15} />} onClick={() => setSettingsOpen(true)}>AI 配置</Button>
        {onIntake && <Button type="primary" icon={<Link2 size={15} />} onClick={onIntake}>接入 Jira 需求</Button>}
      </div>
    </div>
    <div className="tf-requirements-workspace">
      <aside className="tf-requirements-list-pane" aria-label="需求列表">
        <div className="tf-requirements-list-heading"><span>{isRequirementCenter ? '已接入需求' : '需求'}</span><span>{filtered.length} 项</span></div>
        <div className="tf-requirements-list-scroll">
          {!pageTasks.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? '没有匹配的需求' : projectId ? '当前项目暂无需求' : '暂无已接入需求'} />}
          {!!pageTasks.length && <ul className="tf-requirements-list">
            {pageTasks.map(task => {
              const taskProject = showProject ? projectsById.get(task.projectId) : undefined;
              return <li key={task.id}>
                <button type="button" aria-pressed={task.id === currentId} onClick={() => {
                  setSelectedId(task.id);
                  onChooseTask?.(task);
                }}>
                  <span className="tf-requirements-title-text" title={task.title}>{task.title}</span>
                  <span className="tf-requirements-row-meta">
                    <span className="tf-requirements-key">{task.jiraKey}</span>
                    {taskProject && <span className="tf-requirements-project" title={taskProject.name}>{taskProject.key}</span>}
                    <span>{task.externalRef?.status || taskStatusLabel(task.status)}</span>
                  </span>
                </button>
              </li>;
            })}
          </ul>}
        </div>
        {filtered.length > PAGE_SIZE && <Pagination
          size="small" simple current={currentPage} total={filtered.length} pageSize={PAGE_SIZE}
          showSizeChanger={false} onChange={value => { setPage(value); setSelectedId(''); }}
        />}
      </aside>
      <section className="tf-requirements-detail" aria-label="需求详情">
        {current ? <>
          <header className="tf-requirements-detail-header">
            <div className="tf-requirements-detail-title">
              <h2 title={current.title}>{current.title}</h2>
              <div className="tf-requirements-detail-meta">
                {jiraUrl ? <a href={jiraUrl} target="_blank" rel="noopener noreferrer" className="tf-requirements-key">{current.jiraKey}<ExternalLink size={12} /></a>
                  : <span className="tf-requirements-key">{current.jiraKey}</span>}
                {isRequirementCenter ? <>
                  {showProject && activeProject && <span>{activeProject.name}</span>}
                  <span>{current.externalRef?.status || taskStatusLabel(current.status)}</span>
                  {linkedChildren > 0 && <span>{linkedChildren} 个关联子任务</span>}
                  {fixVersions.length > 0 && <span>{fixVersions.join('、')}</span>}
                </> : <span>{stageStatus}</span>}
              </div>
            </div>
            <Button type="text" size="small" onClick={() => openTaskRoute(current.id, {
              tab: 'overview', from: section, requirementId: current.id,
            })}>任务详情</Button>
          </header>
          <div className="tf-requirements-stage-body" key={`${current.id}:${reviewStage}`}>
            {isRequirementCenter && <div className="tf-requirements-review-heading">
              <h3>需求评审</h3>
              <span>{stageStatus}</span>
            </div>}
            {activeProject && <RequirementStageReview
              task={activeBundle?.task || current} stage={reviewStage} user={user} role={activeProject.role}
              bundle={activeBundle} available={available} executor={executor} relatedTasks={relatedTasks}
              onConfigure={() => setSettingsOpen(true)} onUnauthorized={onUnauthorized} onForbidden={onForbidden}
              onChanged={async () => { await Promise.all([readBundle(), onChanged()]); }}
            />}
          </div>
        </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isRequirementCenter ? '选择需求查看详情' : '选择需求查看评审'} />}
      </section>
    </div>
    <Modal title="AI 评审配置" open={settingsOpen && !!activeProject} onCancel={() => setSettingsOpen(false)}
      footer={<Button type="primary" onClick={() => setSettingsOpen(false)}>完成</Button>}
    >
      {!capabilities ? <Skeleton active paragraph={{ rows: 2 }} /> : <div className="tf-requirements-settings">
        <label>
          执行位置
          <Select value={runner} disabled={serverMode} aria-label="执行位置"
            options={serverMode ? [{ value: 'bridge', label: '本机 Bridge' }] : [
              { value: 'local', label: '本机 CLI' },
              ...(supportsWorkbench ? [{ value: 'workbench', label: '本地工作台' }] : []),
            ]}
            onChange={value => {
              if (value === 'local' || value === 'workbench') { setRunnerChoice({ key: runnerKey, value }); writeStoredString(runnerKey, value); }
            }}
          />
        </label>
        {serverMode && <label>
          执行设备
          <Select value={device?.id} aria-label="执行设备" placeholder="未连接设备"
            options={devices.map(item => ({ value: item.id, label: item.deviceName + (item.online ? '' : ' · 离线') }))}
            onChange={value => { setDeviceChoice({ key: deviceKey, value }); writeStoredString(deviceKey, value); }}
          />
        </label>}
        {!serverMode && runner === 'workbench' && !workbenchAuthorized && <span className="tf-requirements-execution-label">
          当前账号尚未授权本项目接入本地工作台，请先前往
          <Button type="link" size="small" onClick={() => { setSettingsOpen(false); navigateWorkspace('local'); }}>本地 AI 接入</Button>
          完成授权。
        </span>}
        <LocalAiExecutionFields capabilities={capabilities} engine={engine} onEngineChange={setEnginePreference} model={model} runner={runner} />
        {available && <span className="tf-requirements-execution-label">{executionLabel}{configuredModel ? ` · ${configuredModel}` : ''}</span>}
      </div>}
    </Modal>
  </div>;
}

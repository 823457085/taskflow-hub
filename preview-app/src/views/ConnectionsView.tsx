import React, { useEffect, useRef, useState } from 'react';
import { readTogether } from './readTogether';
import { App, Badge, Button, Card, Descriptions, Divider, Flex, Form, Input, Segmented, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Check, ClipboardPaste, Copy, ExternalLink, RefreshCw, Search } from 'lucide-react';
import { api, ApiError, ASSET_ROLES, type AssetKind, isChildTask, JiraIssueMetadata, JiraProject, PlatformPermissions, Project, projectGroup, Role, timeText, User, WorkTask } from './workspaceApi';
import { StatusBadge } from '../components/Primitives';
import { parseSourceReference, type SourceProvider } from './sourceReference';
import { AccountUsageSelector } from './AccountUsageSelector';
import { listAccounts, syncPersonalJiraProjects, type AccountAuthMode } from './accountApi';
import { navigateWorkspace, openTaskRoute } from './workspaceNavigation';
import { isTaskFrozen } from './taskAvailability';
import { assetKindLabel, connectorStatusLabel, mrStateLabel } from './displayLabels';
import { clearSearchOnEscape } from './uiPreferences';
import { ConnectionsAutomationPanel } from './ConnectionsAutomationPanel';
import { LinkifiedText } from './MarkdownPreview';
import './ConnectionsView.css';

type Provider = 'jira' | 'confluence' | 'gitlab' | 'github' | 'jenkins' | 'yunxiao';
type Connector = { provider: Provider; name: string; status: string; baseUrl?: string; authMode?: AccountAuthMode; hasCredential?: boolean; lastCheckedAt?: string; lastError?: string; capabilities?: string[]; readOnly: boolean; accountId?: string; accountName?: string; accountScope?: 'PERSONAL' | 'PROJECT'; selectionUnavailable?: boolean };
type ResourceItem = Record<string, unknown> & JiraIssueMetadata;
type ReadResult = JiraIssueMetadata & { resource: string; items?: ResourceItem[]; total?: number; title?: string; status?: string; content?: string; externalUrl?: string; version?: string | number };
const writableMainTasks = (tasks: WorkTask[]) => tasks.filter(task => !isChildTask(task) && !isTaskFrozen(task, tasks));
const RESOURCES: Record<Provider, { value: string; label: string }[]> = {
  jira: [{ value: 'jira_issues', label: '搜索 Jira 任务' }, { value: 'jira_issue', label: '读取单个任务' }],
  confluence: [{ value: 'confluence_page', label: '读取 Confluence 页面' }],
  gitlab: [{ value: 'gitlab_mr', label: '读取合并请求' }],
  github: [{ value: 'github_repo', label: '读取仓库信息' }, { value: 'github_pull', label: '读取 Pull Request' }],
  jenkins: [{ value: 'jenkins_jobs', label: '读取 Job 列表' }, { value: 'jenkins_build', label: '读取构建结果' }],
  yunxiao: [
    { value: 'yunxiao_mrs', label: '读取 Codeup 合并请求列表' },
    { value: 'yunxiao_mr', label: '读取单个 Codeup 合并请求' },
    { value: 'yunxiao_repos', label: '读取 Codeup 代码库列表' },
    { value: 'yunxiao_pipelines', label: '读取流水线列表' },
    { value: 'yunxiao_run', label: '读取运行记录' },
  ],
};
const NAMES: Record<Provider, string> = { jira: 'Jira', confluence: 'Confluence', gitlab: 'GitLab', github: 'GitHub', jenkins: 'Jenkins', yunxiao: '云效' };
const IMPORT_KINDS: Record<Provider, AssetKind[]> = { jira: [], confluence: ['PRD', 'TECH_SPEC'], gitlab: ['CODE'], github: [], jenkins: ['RELEASE_PLAN'], yunxiao: ['CODE', 'RELEASE_PLAN'] };
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const required = (name: string) => ({ required: true, whitespace: true, message: `请输入${name}。` });
const positiveId = { pattern: /^[1-9]\d*$/, message: '请输入有效的正整数 ID。' };

export const ConnectionsView: React.FC<{ projectId: string; project?: Project; projects?: Project[]; role: Role; user: User; platformPermissions: PlatformPermissions; onUnauthorized: () => void; onForbidden?: () => void; onProjectsChanged?: (projectId?: string) => Promise<void> }> = ({ projectId, project, projects = [], role, user, platformPermissions, onUnauthorized, onForbidden, onProjectsChanged }) => {
  const { message } = App.useApp();
  const [resourceForm] = Form.useForm();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [active, setActive] = useState<Provider>('jira');
  const [operation, setOperation] = useState<string | null>('initial');
  const [resource, setResource] = useState('jira_issues');
  const [jql, setJql] = useState('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  const [issueKey, setIssueKey] = useState('');
  const [pageId, setPageId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [mrIid, setMrIid] = useState('');
  const [jobName, setJobName] = useState('');
  const [buildNumber, setBuildNumber] = useState('lastSuccessfulBuild');
  const [pipelineId, setPipelineId] = useState('');
  const [runId, setRunId] = useState('');
  const [inputMode, setInputMode] = useState<'link' | 'manual'>('link');
  const [sourceReference, setSourceReference] = useState('');
  const [jiraPreset, setJiraPreset] = useState('mine');
  const [buildPreset, setBuildPreset] = useState('lastSuccessfulBuild');
  const [jobOptions, setJobOptions] = useState<{ value: string; label: string }[]>([]);
  const [pipelineOptions, setPipelineOptions] = useState<{ value: string; label: string }[]>([]);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [readParameters, setReadParameters] = useState<Record<string, unknown> | null>(null);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [taskId, setTaskId] = useState('');
  const [kind, setKind] = useState<AssetKind>('PRD');
  const [catalog, setCatalog] = useState<JiraProject[] | null>(null);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  useEffect(() => { if (!catalog) setCatalogSearch(''); }, [catalog]);
  const [accessDenied, setAccessDenied] = useState(false);
  const [resolvedAccount, setResolvedAccount] = useState<{ scope: string; id: string | null }>();
  const resolvedAccountRef = useRef(resolvedAccount); resolvedAccountRef.current = resolvedAccount;
  const alignmentAttempt = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const operationPending = useRef(false);
  const connection = connectors.find(item => item.provider === active);
  const supportsLink = ['confluence_page', 'gitlab_mr', 'jenkins_build', 'yunxiao_mr'].includes(resource);
  const busy = operation !== null;
  const roleCanManage = project?.permissions?.manageConnections === true;
  const accountScope = JSON.stringify([user.id, user.role, projectId, role, active, project?.permissions]);
  const currentAccountScope = useRef(accountScope); currentAccountScope.current = accountScope;
  const resolvedAccountId = resolvedAccount?.scope === accountScope ? resolvedAccount.id : undefined;
  const accountAligned = resolvedAccountId !== undefined && !!connection && (connection.accountId ?? null) === resolvedAccountId && connection.status !== 'ACCOUNT_UNAVAILABLE';
  const canManage = !!projectId && roleCanManage && !accessDenied;
  const canRead = !!projectId && !accessDenied && accountAligned && (canManage || !!connection?.accountId);
  const canImportJira = ['ADMIN', 'LEAD', 'PM'].includes(role);
  const mainTaskOptions = writableMainTasks(tasks);
  const findJiraTask = (key: string) => tasks.find(task => task.jiraKey.toUpperCase() === key.toUpperCase());
  const isJiraChild = (issue: JiraIssueMetadata, key: string) => {
    const local = findJiraTask(key);
    return issue.issueType?.subtask === true || (local ? isChildTask(local) : !!(issue.parentKey && findJiraTask(issue.parentKey)?.externalRef?.provider === 'jira'));
  };
  const importKinds = (active === 'yunxiao'
    ? (['yunxiao_mr', 'yunxiao_commit'].includes(result?.resource || resource) ? (['CODE'] as AssetKind[]) : (['RELEASE_PLAN'] as AssetKind[]))
    : IMPORT_KINDS[active]).filter(value => ASSET_ROLES[value].includes(role));
  const notify = (value: string) => { void message.success(value); };
  const handleAccessError = (error: unknown, expected: number) => {
    if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) return false;
    if (expected !== generation.current) return true;
    if (error.status === 401) onUnauthorized();
    else {
      generation.current += 1;
      operationPending.current = false;
      setAccessDenied(true); setOperation(null);
      setResult(null); setReadParameters(null); setConnectors([]); setTasks([]); setTaskId('');
      setCatalog(null); setSelectedProjectIds([]); resourceForm.resetFields();
      setIssueKey(''); setPageId(''); setRepositoryId(''); setMrIid(''); setJobName('');
      setBuildNumber('lastSuccessfulBuild'); setPipelineId(''); setRunId('');
      setSourceReference(''); setInputMode('link'); setJiraPreset('mine'); setBuildPreset('lastSuccessfulBuild'); setJobOptions([]); setPipelineOptions([]);
      onForbidden?.();
    }
    return true;
  };

  const refresh = async (expected = generation.current) => {
    const [data, taskData] = await readTogether([
      api<{ connectors: Connector[] }>(`connectors?projectId=${encodeURIComponent(projectId)}`),
      api<{ tasks: WorkTask[] }>(`tasks?projectId=${encodeURIComponent(projectId)}`),
    ]);
    if (expected !== generation.current) return;
    setConnectors(data.connectors); setTasks(taskData.tasks);
    const writable = writableMainTasks(taskData.tasks);
    setTaskId(current => writable.some(task => task.id === current) ? current : writable[0]?.id || '');
    return data.connectors;
  };
  const run = async (action: (expected: number) => Promise<unknown>, name = 'request') => {
    if (!projectId || operationPending.current) return;
    if (accessDenied && name !== 'refresh' && name !== 'initial') return;
    const expected = generation.current; operationPending.current = true; setOperation(name);
    try { await action(expected); }
    catch (error) {
      if (expected !== generation.current) return;
      if (handleAccessError(error, expected)) { void message.error(error instanceof Error ? error.message : '请求失败。'); return; }
      try { await refresh(expected); }
      catch (refreshError) {
        if (expected !== generation.current) return;
        if (handleAccessError(refreshError, expected)) { void message.error(refreshError instanceof Error ? refreshError.message : '请求失败。'); return; }
      }
      if (expected === generation.current) void message.error(error instanceof Error ? error.message : '请求失败。');
    }
    finally { if (expected === generation.current) { operationPending.current = false; setOperation(null); } }
  };
  useEffect(() => {
    generation.current += 1; operationPending.current = false; setAccessDenied(false); setResult(null); setReadParameters(null); setConnectors([]); setTasks([]); setTaskId(''); setCatalog(null); setSelectedProjectIds([]);
    setIssueKey(''); setPageId(''); setRepositoryId(''); setMrIid(''); setJobName(''); setBuildNumber('lastSuccessfulBuild'); setPipelineId(''); setRunId('');
    setSourceReference(''); setInputMode('link'); setJiraPreset('mine'); setBuildPreset('lastSuccessfulBuild'); setJobOptions([]); setPipelineOptions([]);
    resourceForm.resetFields();
    if (projectId) void run(refresh, 'initial'); else setOperation(null);
    return () => { generation.current += 1; operationPending.current = false; };
  }, [projectId, roleCanManage, role, user.id, user.role]);
  useEffect(() => {
    setCatalog(null); setSelectedProjectIds([]); setResult(null); setReadParameters(null);
    const nextResource = RESOURCES[active][0].value;
    const scope = project?.jira ? `project = ${JSON.stringify(project.jira.key)} AND ` : '';
    const nextJql = `${scope}assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
    setResource(nextResource);
    setJql(nextJql);
    setSourceReference(''); setInputMode('link'); setJiraPreset('mine'); setBuildPreset('lastSuccessfulBuild'); setJobOptions([]); setPipelineOptions([]);
    setIssueKey(''); setPageId(''); setRepositoryId(''); setMrIid(''); setJobName(''); setBuildNumber('lastSuccessfulBuild'); setPipelineId(''); setRunId('');
    if (canRead) {
      resourceForm.resetFields();
      resourceForm.setFieldsValue({ resource: nextResource, jql: nextJql, jiraPreset: 'mine', sourceReference: '', issueKey: '', pageId: '', repositoryId: '', mrIid: '', jobName: '', buildPreset: 'lastSuccessfulBuild', buildNumber: 'lastSuccessfulBuild', pipelineId: '', runId: '' });
    }
    setKind(IMPORT_KINDS[active].find(value => ASSET_ROLES[value].includes(role)) || 'PRD');
  }, [active, connection?.baseUrl, connection?.authMode, connection?.accountId, connection?.status, projectId, project?.jira?.key, canRead, role]);
  useEffect(() => { setResult(null); setReadParameters(null); }, [active, projectId, resource, jql, issueKey, pageId, repositoryId, mrIid, jobName, buildNumber, pipelineId, runId, sourceReference, inputMode]);

  useEffect(() => {
    if (busy || accessDenied || resolvedAccountId === undefined || !connection || accountAligned || connection.status === 'ACCOUNT_UNAVAILABLE') return;
    const attempt = JSON.stringify([accountScope, resolvedAccountId]);
    if (alignmentAttempt.current === attempt) return;
    alignmentAttempt.current = attempt;
    const requestedId = resolvedAccountId;
    void run(async expected => {
      const next = await refresh(expected);
      if (expected !== generation.current || currentAccountScope.current !== accountScope || resolvedAccountRef.current?.id !== requestedId) return;
      const updated = next?.find(item => item.provider === active);
      if (updated && updated.status !== 'ACCOUNT_UNAVAILABLE' && (updated.accountId ?? null) !== requestedId) void message.error('账号选择与连接状态尚未同步，请重新选择使用账号。');
    }, 'account-refresh');
  }, [accountScope, resolvedAccountId, connection?.accountId, connection?.status, busy, accessDenied, accountAligned]);

  const resolveAccount = (id: string | null | undefined) => {
    if (currentAccountScope.current !== accountScope) return;
    const next = id === undefined ? undefined : { scope: accountScope, id };
    resolvedAccountRef.current = next; setResolvedAccount(next);
    setResult(null); setReadParameters(null); setCatalog(null); setSelectedProjectIds([]); setJobOptions([]); setPipelineOptions([]);
  };

  const changeAccountStart = () => {
    if (currentAccountScope.current !== accountScope) return;
    generation.current += 1; operationPending.current = true; setOperation('account-changing');
    alignmentAttempt.current = undefined;
    setConnectors([]); setResult(null); setReadParameters(null);
    setCatalog(null); setSelectedProjectIds([]); setJobOptions([]); setPipelineOptions([]);
    resourceForm.resetFields();
  };
  const changeAccountComplete = async () => {
    if (currentAccountScope.current !== accountScope) return;
    operationPending.current = false; setOperation(null);
    await run(refresh, 'refresh');
  };
  const parameters = (overrideIssue?: string) => supportsLink && inputMode === 'link' && !overrideIssue ? { projectId, accountId: connection?.accountId ?? null, ...parseSourceReference(active as SourceProvider, sourceReference, connection?.baseUrl || '') } : ({ projectId, accountId: connection?.accountId ?? null, resource: overrideIssue ? 'jira_issue' : resource,
    ...(resource === 'jira_issues' && !overrideIssue ? { jql, limit: 20 } : {}),
    ...(overrideIssue || resource === 'jira_issue' ? { issueKey: overrideIssue || issueKey } : {}),
    ...(resource === 'confluence_page' ? { pageId } : {}), ...(resource === 'gitlab_mr' ? { repositoryId, mrIid } : {}),
    ...(resource === 'github_repo' || resource === 'github_pull' ? { repository: repositoryId.trim() } : {}),
    ...(resource === 'github_pull' ? { pullNumber: mrIid.trim() } : {}),
    ...(resource === 'yunxiao_mr' ? { repositoryId, mrLocalId: mrIid } : {}),
    ...(resource === 'jenkins_build' ? { jobName, buildNumber } : {}), ...(resource === 'yunxiao_run' ? { pipelineId, runId } : {}),
  });
  const testConnection = async (expected: number) => {
    if (expected !== generation.current || !accountAligned) return;
    const data = await api<{ connector: Connector; identity?: { displayName?: string; name?: string } }>(`connectors/${active}/test`, { projectId, accountId: connection?.accountId ?? null });
    if (expected !== generation.current) return;
    setConnectors(current => [...current.filter(item => item.provider !== active), data.connector]);
    notify(data.identity?.displayName || data.identity?.name || `${NAMES[active]} 连接验证通过`);
    await refresh(expected);
  };
  const importResource = (overrideIssue?: string) => void run(async expected => {
    if (!canRead || connection?.status === 'ACCOUNT_UNAVAILABLE') return;
    if (!readParameters || !result) throw new Error('请先读取并确认需要导入的资源。');
    if (active === 'jira' && !canImportJira) return;
    if (active !== 'jira' && !importKinds.includes(kind)) return;
    if (active === 'jira' && !project?.jira) throw new Error('请先同步并切换到对应的 Jira 项目，再导入任务。');
    if (active !== 'jira' && !mainTaskOptions.some(task => task.id === taskId)) throw new Error('请选择可编辑的主任务。');
    if (active === 'jira') {
      const issue = overrideIssue ? result.items?.find(item => text(item.key) === overrideIssue) : result;
      if (!issue || isJiraChild(issue, overrideIssue || text(readParameters.issueKey))) return;
    }
    const source = overrideIssue ? { projectId, accountId: readParameters.accountId, resource: 'jira_issue', issueKey: overrideIssue } : readParameters;
    const data = await api<{ imported: boolean }>(`connectors/${active}/import`, { ...source, ...(active !== 'jira' ? { taskId, kind } : {}) });
    if (expected !== generation.current) return;
    notify(data.imported ? '已导入本项目，原始来源与版本已保留。' : '此来源版本已存在，未重复导入。');
    await refresh(expected);
    if (expected !== generation.current) return;
    if (active === 'jira') await onProjectsChanged?.(projectId);
  }, 'import');
  const readResource = () => void run(async expected => {
    if (!canRead || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE') return;
    const requestParameters = parameters();
    const data = await api<ReadResult>(`connectors/${active}/read`, requestParameters);
    if (expected === generation.current) {
      setReadParameters(requestParameters); setResult(data);
      if (active === 'jenkins' && data.resource === 'jenkins_jobs') setJobOptions((data.items || []).filter(item => !item.isFolder && text(item.jobName)).map(item => ({ value: text(item.jobName), label: text(item.name) + ' · ' + text(item.jobName) })));
      if (active === 'yunxiao' && data.resource === 'yunxiao_pipelines') setPipelineOptions((data.items || []).map(item => ({ value: text(item.id), label: text(item.name) + ' · ' + text(item.id) })));
    }
  }, 'read');
  const changeResource = (value: string) => { setResource(value); setSourceReference(''); setInputMode('link'); setResult(null); setReadParameters(null); resourceForm.setFieldsValue({ resource: value, sourceReference: '' }); };
  const selectJob = (item: ResourceItem) => {
    const next = text(item.jobName); changeResource('jenkins_build'); setInputMode('manual'); setJobName(next); setBuildPreset('lastSuccessfulBuild'); setBuildNumber('lastSuccessfulBuild');
    resourceForm.setFieldsValue({ resource: 'jenkins_build', jobName: next, buildPreset: 'lastSuccessfulBuild', buildNumber: 'lastSuccessfulBuild' });
  };
  const selectPipeline = (item: ResourceItem) => {
    const next = text(item.id); changeResource('yunxiao_run'); setPipelineId(next); setRunId(''); resourceForm.setFieldsValue({ resource: 'yunxiao_run', pipelineId: next, runId: '' });
  };
  const selectCodeupMr = (item: ResourceItem) => {
    const repo = text(item.repositoryId);
    const localId = text(item.localId);
    changeResource('yunxiao_mr'); setInputMode('manual'); setRepositoryId(repo); setMrIid(localId);
    if (ASSET_ROLES.CODE.includes(role)) setKind('CODE');
    resourceForm.setFieldsValue({ resource: 'yunxiao_mr', repositoryId: repo, mrIid: localId });
  };
  const selectJiraPreset = (value: string) => {
    setJiraPreset(value);
    if (value === 'custom') { resourceForm.setFieldValue('jql', jql); return; }
    const scope = project?.jira ? `project = ${JSON.stringify(project.jira.key)} AND ` : '';
    const next = value === 'recent' ? `${project?.jira ? `project = ${JSON.stringify(project.jira.key)} ` : ''}ORDER BY updated DESC` : `${scope}${value === 'mine' ? 'assignee = currentUser() AND ' : ''}statusCategory != Done ORDER BY updated DESC`;
    setJql(next); resourceForm.setFieldValue('jql', next);
  };
  const readCatalog = () => void run(async expected => {
    if (!accountAligned || !canManage || !platformPermissions.syncJiraProjects || active !== 'jira') return;
    const data = await api<{ items: JiraProject[] }>('connectors/jira/read', { projectId, accountId: connection?.accountId ?? null, resource: 'jira_projects' });
    if (expected !== generation.current) return;
    setCatalog(data.items); setSelectedProjectIds(current => current.filter(id => data.items.some(item => item.id === id)));
  }, 'catalog');
  const syncCatalog = () => void run(async expected => {
    if (!accountAligned || !canManage || !platformPermissions.syncJiraProjects || active !== 'jira') return;
    const data = await api<{ projects: Project[]; created: number; updated: number; unchanged: number }>('connectors/jira/sync-projects', { projectId, accountId: connection?.accountId ?? null, projectIds: selectedProjectIds });
    if (expected !== generation.current) return;
    notify(`项目同步完成：新增 ${data.created}，更新 ${data.updated}，未变化 ${data.unchanged}。`);
    const selected = data.projects.find(item => item.jira?.id === selectedProjectIds[0] && item.jira?.baseUrl === connection?.baseUrl);
    await onProjectsChanged?.(selected?.id || projectId);
  }, 'sync');

  const isSyncedJiraProject = (item: JiraProject) =>
    projects.some(p => p.jira?.id === item.id && (!connection?.baseUrl || p.jira?.baseUrl === connection.baseUrl));
  const filteredCatalog = catalog
    ? catalog.filter(item => !catalogSearch.trim() || `${item.key} ${item.name} ${item.category || ''}`.toLowerCase().includes(catalogSearch.trim().toLowerCase()))
    : null;
  const unsyncedCatalogIds = (filteredCatalog || []).filter(item => !isSyncedJiraProject(item)).map(item => item.id);

  const pasteSourceClipboard = async () => {
    if (busy || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE') return;
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        void message.info('剪贴板暂无内容。');
        return;
      }
      setSourceReference(clip);
      resourceForm.setFieldValue('sourceReference', clip);
      void message.success('已粘贴来源链接。');
    } catch {
      void message.warning('无法直接读取剪贴板，请按 Cmd/Ctrl + V 粘贴。');
    }
  };

  const catalogColumns: TableColumnsType<JiraProject> = [
    { title: 'Jira 项目', dataIndex: 'name', render: (_, item) => <Space orientation="vertical" size={2}><Space size={6} wrap><Typography.Text strong>{item.name}</Typography.Text>{isSyncedJiraProject(item) && <Tag color="success">已同步</Tag>}</Space><Typography.Text code>{item.key}</Typography.Text></Space> },
    { title: '分组', width: 180, render: (_, item) => { const group = projectGroup({ id: item.id, key: item.key, name: item.name, role: 'ADMIN', jira: item }); return <Space orientation="vertical" size={0}><Typography.Text>{group.name}</Typography.Text><Typography.Text type="secondary">{item.category ? 'Jira 分类' : '名称分组'}</Typography.Text></Space>; } },
    { title: '项目类型', dataIndex: 'projectTypeKey', width: 140 },
  ];
  const itemColumns: TableColumnsType<ResourceItem> = active === 'jira' ? [
    { title: 'Jira 任务', render: (_, item) => {
      const existingTask = findJiraTask(text(item.key));
      return <Space orientation="vertical" size={4}><Space size={6} wrap><Typography.Text code>{text(item.key)}</Typography.Text>{existingTask && <Tag color="blue">已在工作台</Tag>}</Space><Typography.Text strong>{text(item.summary)}</Typography.Text><Typography.Text type="secondary">{item.type}{item.priority ? ` · ${item.priority.name}` : ''}</Typography.Text></Space>;
    } },
    { title: 'Jira 状态', width: 140, render: (_, item) => <StatusBadge variant="blue">{text(item.status)}</StatusBadge> },
    { title: '修复版本', width: 160, render: (_, item) => item.fixVersions?.map(version => version.name).join(' · ') || '—' },
    { title: '操作', width: 168, render: (_, item) => {
      const existingTask = findJiraTask(text(item.key));
      if (isJiraChild(item, text(item.key))) return null;
      if (existingTask) return <Button size="small" type="link" disabled={busy} onClick={() => openTaskRoute(existingTask.id, { from: 'connections' })}>打开任务</Button>;
      return canImportJira ? <Button size="small" disabled={busy || !project?.jira} onClick={() => importResource(text(item.key))}>导入任务</Button> : <Button size="small" disabled={busy} onClick={() => navigateWorkspace('tasks')}>到需求中心接入</Button>;
    } },
  ] : result?.resource === 'yunxiao_mrs' ? [
    { title: 'Codeup 合并请求', render: (_, item) => <Space orientation="vertical" size={4}><Typography.Text strong>{text(item.name)}</Typography.Text><Typography.Text type="secondary">{text(item.repositoryName)} · <code>{text(item.sourceBranch)} → {text(item.targetBranch)}</code> · {mrStateLabel(text(item.state))}</Typography.Text></Space> },
    { title: '操作', width: 140, render: (_, item) => <Button size="small" type="primary" disabled={busy} onClick={() => selectCodeupMr(item)}>选择并读取</Button> },
  ] : result?.resource === 'yunxiao_repos' ? [
    { title: 'Codeup 代码库', render: (_, item) => <Space orientation="vertical" size={4}><Typography.Text strong>{text(item.name)}</Typography.Text><Typography.Text code>{text(item.pathWithNamespace)}</Typography.Text></Space> },
    { title: '仓库 ID', width: 120, render: (_, item) => <Typography.Text code>{text(item.id)}</Typography.Text> },
  ] : [
    { title: active === 'jenkins' ? 'Job 名称' : '流水线名称', render: (_, item) => <Space orientation="vertical" size={4}><Typography.Text strong>{text(item.name)}</Typography.Text><Typography.Text code>{text(item.id)}</Typography.Text></Space> },
    { title: '操作', width: 120, render: (_, item) => active === 'jenkins' ? !item.isFolder ? <Button size="small" disabled={busy} onClick={() => selectJob(item)}>选择 Job</Button> : null : <Button size="small" disabled={busy} onClick={() => selectPipeline(item)}>选择流水线</Button> },
  ];

  const syncPersonalProjects = () => run(async expected => {
    if (!connection?.accountId || connection.accountScope !== 'PERSONAL' || active !== 'jira') return;
    const listed = await listAccounts();
    if (expected !== generation.current) return;
    const target = listed.accounts.find(item => item.id === connection.accountId);
    if (!target) { void message.error('所选个人 Jira 账号不存在或已不可用。'); return; }
    const synced = await syncPersonalJiraProjects(target.id, target.version, true);
    if (expected !== generation.current) return;
    const extra = synced.unmatchedRemoteCount > 0 ? `；另有 ${synced.unmatchedRemoteCount} 个远端 Jira 项目尚未由管理员同步到平台` : '';
    notify(synced.joinedCount > 0
      ? `已按你的 Jira 权限同步可见项目：新增 ${synced.joinedCount} 个，共匹配 ${synced.matchedCount} 个${extra}。`
      : `已按你的 Jira 权限校验：当前共匹配 ${synced.matchedCount} 个平台项目，无需新增${extra}。`);
    await onProjectsChanged?.(synced.joinedProjects[0]?.id || projectId);
  }, 'sync-personal');
  return <div className="tf-connections">
    <Card className="tf-connections-provider-card" title="外部平台" extra={
      <Space size={8} wrap>
        {projectId && !accessDenied && <Button type="text" size="small" onClick={() => document.getElementById('tf-project-automation')?.scrollIntoView({ block: 'start' })}>自动化配置</Button>}
        <Button size="small" icon={<RefreshCw size={15} />} disabled={busy || !projectId} loading={operation === 'refresh'} onClick={() => void run(refresh, 'refresh')}>刷新状态</Button>
      </Space>
    }>
      <nav className="tf-connection-provider-nav" aria-label="外部平台">
        {(Object.keys(NAMES) as Provider[]).map(provider => {
          const item = connectors.find(row => row.provider === provider);
          return (
            <Button
              key={provider}
              aria-pressed={active === provider}
              type={active === provider ? 'default' : 'text'}
              disabled={busy}
              onClick={() => setActive(provider)}
            >
              {item?.name || NAMES[provider]}
              {item && <Badge status={item.status === 'CONNECTED' ? 'success' : item.status === 'ERROR' || item.status === 'ACCOUNT_UNAVAILABLE' ? 'error' : 'default'} aria-label={connectorStatusLabel(item.status)} />}
            </Button>
          );
        })}
      </nav>
      <Skeleton active loading={operation === 'initial' && !connectors.length} paragraph={{ rows: 4 }}>
        <Flex vertical gap={16}>
          <Flex justify="space-between" align="flex-start" gap={16} wrap>
            <Space orientation="vertical" size={8}>
              <Typography.Title level={4}>{connection?.name || NAMES[active]} 连接</Typography.Title>
              {(accountAligned || connection?.status === 'ACCOUNT_UNAVAILABLE') && <Space wrap size={8}><StatusBadge variant={connection?.status === 'CONNECTED' ? 'green' : ['ERROR', 'ACCOUNT_UNAVAILABLE'].includes(connection?.status || '') ? 'block' : 'neutral'}>{connectorStatusLabel(connection?.status || 'UNCONFIGURED')}</StatusBadge>{connection?.lastCheckedAt && <Typography.Text type="secondary">最近验证：{timeText(connection.lastCheckedAt)}</Typography.Text>}</Space>}
              {accountAligned && connection?.accountId && <Space size={8} wrap><Typography.Text>{connection.accountName}</Typography.Text><Typography.Text type="secondary">{connection.accountScope === 'PERSONAL' ? '个人账号' : '项目共享账号'}</Typography.Text></Space>}
              {accountAligned && connection?.baseUrl && <Typography.Text type="secondary" className="tf-break-anywhere">{connection.baseUrl}</Typography.Text>}
              {(accountAligned || connection?.status === 'ACCOUNT_UNAVAILABLE') && connection?.lastError && <Typography.Text type="danger" className="tf-break-anywhere">{connection.lastError}</Typography.Text>}
            </Space>
          </Flex>
          <div className="tf-connection-account"><AccountUsageSelector key={accountScope} userId={user.id} projectId={projectId} provider={active} disabled={busy || accessDenied} onChanging={changeAccountStart} onChanged={changeAccountComplete} onResolved={resolveAccount} onUnauthorized={onUnauthorized} onForbidden={() => { handleAccessError(new ApiError('', 403), generation.current); }} /></div>
          <Flex wrap gap={8}>
            {canRead && <Button type={connection?.hasCredential && connection.status !== 'CONNECTED' ? 'primary' : 'default'} icon={<Check size={16} />} disabled={busy || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE'} loading={operation === 'test'} onClick={() => void run(testConnection, 'test')}>验证连接</Button>}
            {active === 'jira' && accountAligned && connection?.accountScope === 'PERSONAL' && connection?.accountId && <Button icon={<RefreshCw size={15} />} disabled={busy} loading={operation === 'sync-personal'} onClick={() => void syncPersonalProjects()}>按 Jira 权限同步可见项目</Button>}
            <Button disabled={busy} onClick={() => navigateWorkspace('accounts')}>管理账号</Button>
          </Flex>
          {accountAligned && !connection?.hasCredential
            ? <Typography.Text type="secondary">请在账号管理绑定 {NAMES[active]} 账号，再在上方选择使用账号。</Typography.Text>
            : projectId && !canRead && !accessDenied && !busy && <Typography.Text type="secondary">选择可用账号后即可读取资源。</Typography.Text>}
        </Flex>
      </Skeleton>
    </Card>
    {active === 'jira' && canManage && platformPermissions.syncJiraProjects && <Card className="tf-connection-catalog" title="Jira 项目目录" extra={<Button size="small" icon={<Search size={15} />} disabled={busy || !accountAligned || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE'} loading={operation === 'catalog'} onClick={readCatalog}>读取项目目录</Button>}>
      {catalog ? <Flex vertical gap={16}>
        <Flex gap={8} wrap align="center" justify="space-between">
          <Input
            style={{ maxWidth: 320 }}
            prefix={<Search size={15} />}
            aria-label="搜索 Jira 项目目录"
            placeholder="搜索项目名称、标识或分类（按 Esc 清空）"
            value={catalogSearch}
            allowClear
            onChange={event => setCatalogSearch(event.target.value)}
            onKeyDown={clearSearchOnEscape(catalogSearch, () => setCatalogSearch(''))}
          />
          <Space size={6} wrap>
            {unsyncedCatalogIds.length > 0 && (
              <Button size="small" disabled={busy || !accountAligned} onClick={() => setSelectedProjectIds(prev => [...new Set([...prev, ...unsyncedCatalogIds])])}>
                全选未同步 ({unsyncedCatalogIds.length})
              </Button>
            )}
            {selectedProjectIds.length > 0 && (
              <Button size="small" type="text" disabled={busy} onClick={() => setSelectedProjectIds([])}>
                清空选择
              </Button>
            )}
          </Space>
        </Flex>
        <Table<JiraProject> rowKey="id" className="tf-connection-table" columns={catalogColumns} dataSource={filteredCatalog || []} size="middle" scroll={{ x: 600 }} pagination={(filteredCatalog?.length || 0) > 10 ? { pageSize: 10, showSizeChanger: false } : false} rowSelection={{ selectedRowKeys: selectedProjectIds, onChange: keys => setSelectedProjectIds(keys.map(String)), getCheckboxProps: () => ({ disabled: busy || !accountAligned }) }} />
        <Flex justify="space-between" align="center" gap={12} wrap><Typography.Text type="secondary">已选择 {selectedProjectIds.length} / {catalog.length} 个可见项目</Typography.Text><Button type="primary" disabled={busy || !accountAligned || !selectedProjectIds.length} loading={operation === 'sync'} onClick={syncCatalog}>同步已选项目（{selectedProjectIds.length}）</Button></Flex>
      </Flex> : <Typography.Text type="secondary">读取目录后，可选择需要同步的 Jira 项目。</Typography.Text>}
    </Card>}
    {canRead && connection?.hasCredential && <Card title={active === 'jira' && !canImportJira || active !== 'jira' && !importKinds.length ? '读取资源' : '读取与导入'}>
      <Flex vertical gap={16}>
        {active === 'jira' && <Typography.Paragraph type="secondary">{project?.jira ? <>当前归属：{project.jira.key} · {project.jira.name}。任务查询和导入受此 Jira 项目范围约束。</> : '当前是本地项目。请先同步并切换到对应的 Jira 项目，再导入任务。'}</Typography.Paragraph>}
        <Form form={resourceForm} className="tf-connection-resource-form" layout="vertical" requiredMark="optional" disabled={busy || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE'} initialValues={{ resource, jql, jiraPreset: 'mine', buildPreset: 'lastSuccessfulBuild', buildNumber }} onFinish={readResource}>
          <Form.Item name="resource" label="读取内容"><Select options={RESOURCES[active]} onChange={changeResource} /></Form.Item>
          {resource === 'jira_issues' && <><Form.Item name="jiraPreset" label="事项范围"><Select options={[{ value: 'mine', label: '连接账号的未完成事项' }, { value: 'open', label: '当前项目未完成事项', disabled: !project?.jira }, { value: 'recent', label: '最近更新的事项' }, { value: 'custom', label: '高级 JQL 查询' }]} onChange={selectJiraPreset} /></Form.Item>{jiraPreset === 'custom' && <Form.Item name="jql" label="JQL 查询" rules={[required('JQL 查询')]}><Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} className="tf-mono" onChange={event => setJql(event.target.value)} /></Form.Item>}</>}
          {resource === 'jira_issue' && <Form.Item name="issueKey" label="Jira 任务号" rules={[required('Jira 任务号'), { pattern: /^[A-Z][A-Z0-9]*-[1-9]\d*$/, message: '请输入有效的 Jira 任务号。' }]}><Input placeholder={project?.jira ? `${project.jira.key}-100` : 'PROJ-100'} onChange={event => setIssueKey(event.target.value)} /></Form.Item>}
          {(resource === 'github_repo' || resource === 'github_pull') && <div className="tf-connection-form-grid">
            <Form.Item name="repositoryId" label="仓库路径" rules={[required('仓库路径')]}><Input placeholder="owner/repository" onChange={event => setRepositoryId(event.target.value)} /></Form.Item>
            {resource === 'github_pull' && <Form.Item name="mrIid" label="Pull Request 编号" rules={[required('Pull Request 编号'), positiveId]}><Input inputMode="numeric" onChange={event => setMrIid(event.target.value)} /></Form.Item>}
          </div>}
          {supportsLink && <Segmented block className="tf-connection-input-mode" aria-label="来源输入方式" value={inputMode} options={[{ value: 'link', label: '粘贴来源链接' }, { value: 'manual', label: '高级参数' }]} onChange={value => { setInputMode(value === 'link' ? 'link' : 'manual'); setResult(null); setReadParameters(null); resourceForm.setFieldsValue({ sourceReference, pageId, repositoryId, mrIid, jobName, buildPreset, buildNumber }); }} />}
          {supportsLink && inputMode === 'link' ? <Form.Item name="sourceReference" label={active === 'confluence' ? 'Confluence 页面链接' : active === 'gitlab' ? 'GitLab MR 链接' : active === 'yunxiao' ? '云效 Codeup MR 或提交链接' : 'Jenkins Job 或构建链接'} preserve={false} rules={[required('来源链接'), { validator: (_, value: string) => { if (!value?.trim()) return Promise.resolve(); try { parseSourceReference(active as SourceProvider, value || '', connection?.baseUrl || ''); return Promise.resolve(); } catch (error) { return Promise.reject(error); } } }]} extra={active === 'jenkins' ? '粘贴 Job 链接时读取最近成功构建；构建链接会读取指定记录。' : active === 'yunxiao' ? '支持粘贴 https://codeup.aliyun.com/.../change/123 合并请求或 /commit/sha 链接。' : '自动识别页面或合并请求，不需要手动抄写 ID。'}><Input placeholder={active === 'confluence' ? 'https://…/pages/viewpage.action?pageId=123 或 /x/短链' : active === 'gitlab' ? 'https://…/group/repo/-/merge_requests/123' : active === 'yunxiao' ? 'https://codeup.aliyun.com/org/group/repo/change/1160' : 'https://…/job/service/123/'} autoComplete="off" onChange={event => setSourceReference(event.target.value)} /></Form.Item> : <>
            {resource === 'confluence_page' && <Form.Item name="pageId" label="页面 ID" rules={[required('页面 ID'), positiveId]}><Input inputMode="numeric" onChange={event => setPageId(event.target.value)} /></Form.Item>}
            {(resource === 'gitlab_mr' || resource === 'yunxiao_mr') && <div className="tf-connection-form-grid"><Form.Item name="repositoryId" label="仓库 ID 或项目路径" rules={[required('仓库 ID 或项目路径')]}><Input onChange={event => setRepositoryId(event.target.value)} /></Form.Item><Form.Item name="mrIid" label="合并请求序号" rules={[required('合并请求序号'), positiveId]}><Input inputMode="numeric" onChange={event => setMrIid(event.target.value)} /></Form.Item></div>}
            {resource === 'jenkins_build' && <><div className="tf-connection-form-grid"><Form.Item name="jobName" label="Job" rules={[required('Job 名称')]}>{jobOptions.length ? <Select showSearch={{ optionFilterProp: 'label' }} options={jobOptions} onChange={setJobName} placeholder="选择已读取的 Job" /> : <Input placeholder="先读取 Job 列表，或填写 folder/job-name" onChange={event => setJobName(event.target.value)} />}</Form.Item><Form.Item name="buildPreset" label="构建记录"><Select options={[{ value: 'lastSuccessfulBuild', label: '最近成功构建' }, { value: 'lastBuild', label: '最近一次构建' }, { value: 'custom', label: '手动指定编号' }]} onChange={value => { setBuildPreset(value); const next = value === 'custom' ? '' : value; setBuildNumber(next); resourceForm.setFieldValue('buildNumber', next); }} /></Form.Item></div>{buildPreset === 'custom' && <Form.Item name="buildNumber" label="构建编号" preserve={false} rules={[required('构建编号'), positiveId]}><Input inputMode="numeric" onChange={event => setBuildNumber(event.target.value)} /></Form.Item>}</>}
          </>}
          {resource === 'yunxiao_run' && <div className="tf-connection-form-grid"><Form.Item name="pipelineId" label="流水线" rules={[required('流水线 ID'), positiveId]}>{pipelineOptions.length ? <Select showSearch={{ optionFilterProp: 'label' }} options={pipelineOptions} onChange={value => { setPipelineId(value); setRunId(''); resourceForm.setFieldValue('runId', ''); }} placeholder="选择已读取的流水线" /> : <Input inputMode="numeric" placeholder="先读取流水线列表，或填写 ID" onChange={event => setPipelineId(event.target.value)} />}</Form.Item><Form.Item name="runId" label="运行 ID" rules={[required('运行 ID'), positiveId]} extra="当前连接器不提供运行列表，请从外部运行记录填写。"><Input inputMode="numeric" onChange={event => setRunId(event.target.value)} /></Form.Item></div>}
          <Space size={8} wrap>
            <Button type={result ? 'default' : 'primary'} htmlType="submit" icon={<Search size={16} />} disabled={busy || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE'} loading={operation === 'read'}>读取资源</Button>
            {supportsLink && inputMode === 'link' && (
              <Button icon={<ClipboardPaste size={15} />} disabled={busy || !connection?.hasCredential || connection.status === 'ACCOUNT_UNAVAILABLE'} onClick={() => void pasteSourceClipboard()}>
                读取剪贴板
              </Button>
            )}
          </Space>
        </Form>
        {result && <div className="tf-connection-result">
          <Divider />
          {result.items ? <Flex vertical gap={16}>
            <Typography.Text type="secondary">已读取 {result.items.length} 项{result.total !== undefined ? ` / 共 ${result.total} 项` : ''}</Typography.Text>
            <Table<ResourceItem> rowKey={(item, index) => text(item.key) || text(item.id) || String(index)} className="tf-connection-table" columns={itemColumns} dataSource={result.items} size="middle" scroll={{ x: active === 'jira' ? 720 : 500 }} pagination={result.items.length > 10 ? { pageSize: 10, showSizeChanger: false } : false} />
          </Flex> : <Flex vertical gap={16}>
            {result.title && <Typography.Title level={5}>{result.title}</Typography.Title>}
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
              ...(active === 'jira' && result.type ? [{ key: 'type', label: 'Jira 类型', children: result.type }] : []),
              ...(active === 'jira' && result.status ? [{ key: 'status', label: 'Jira 状态', children: result.status }] : []),
              ...(result.priority ? [{ key: 'priority', label: '优先级', children: result.priority.name }] : []),
              ...(result.fixVersions?.length ? [{ key: 'versions', label: '修复版本', children: result.fixVersions.map(version => version.name).join(' · ') }] : []),
              ...(result.version !== undefined ? [{ key: 'version', label: '来源版本', children: result.version }] : []),
            ]} />
            {result.externalUrl && <Typography.Link href={result.externalUrl} target="_blank" rel="noreferrer"><Space size={4}>查看来源<ExternalLink size={14} /></Space></Typography.Link>}
            {result.content && <section aria-label="来源内容" className="tf-connection-source-section">
              <Flex align="center" justify="space-between" gap={8} wrap>
                <Typography.Text strong>来源内容</Typography.Text>
                <Button size="small" icon={<Copy size={13} />} onClick={() => void navigator.clipboard.writeText(result.content || '').then(() => message.success('来源内容已复制。')).catch(() => message.warning('复制失败，请手动选择复制。'))}>复制内容</Button>
              </Flex>
              <pre className="tf-connection-source">{active === 'jira' || active === 'confluence'
                ? <LinkifiedText text={result.content} /> : result.content}</pre>
            </section>}
            {active !== 'jira' && !!importKinds.length && <Form layout="vertical" className="tf-connection-resource-form">
              <div className="tf-connection-form-grid"><Form.Item label="关联主任务" required><Select value={taskId || undefined} disabled={busy} placeholder="选择主任务" showSearch={{ optionFilterProp: 'label' }} options={mainTaskOptions.map(task => ({ value: task.id, label: `${task.jiraKey} · ${task.title}` }))} onChange={setTaskId} /></Form.Item><Form.Item label="资产类型"><Select value={kind} disabled={busy} onChange={setKind} options={importKinds.map(value => ({ value, label: assetKindLabel(value) }))} /></Form.Item></div>
            </Form>}
            {active === 'jira' && !isJiraChild(result, text(readParameters?.issueKey)) && (canImportJira
              ? <div><Button type="primary" disabled={busy || !project?.jira} loading={operation === 'import'} onClick={() => importResource()}>导入任务</Button></div>
              : <div><Button type="primary" disabled={busy} onClick={() => navigateWorkspace('tasks')}>到需求中心接入</Button></div>)}
            {active !== 'jira' && !!importKinds.length && <div><Button type="primary" disabled={busy || !mainTaskOptions.some(task => task.id === taskId) || !importKinds.includes(kind)} loading={operation === 'import'} onClick={() => importResource()}>导入为资产新版本</Button></div>}
          </Flex>}
        </div>}
      </Flex>
    </Card>}
    {projectId && !accessDenied && (
      <section id="tf-project-automation" aria-label="项目自动化配置" className="tf-connection-automation">
        <ConnectionsAutomationPanel key={JSON.stringify([user.id, projectId])} projectId={projectId} canManage={canManage} onUnauthorized={onUnauthorized} />
      </section>
    )}
  </div>;
};

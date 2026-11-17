import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Empty, Flex, Form, Input, List, Radio, Segmented, Select, Space, Tag, Typography } from 'antd';
import { ArrowRight, ClipboardPaste, ExternalLink, Link2, Search } from 'lucide-react';
import { jiraReferenceMatchesSource, parseJiraReference } from '../../../platform-server/jira-reference.mjs';
import { AccountUsageSelector } from './AccountUsageSelector';
import { clearSearchOnEscape } from './uiPreferences';
import { api, ApiError, Project, User, WorkTask } from './workspaceApi';
import './JiraTaskIntake.css';

export interface JiraIntakeIssue {
  id: string; key: string; title: string; summary: string; status: string; description: unknown; type: string;
  project: { id: string; key: string; name: string } | null;
  issueType: { id: string; name: string; subtask: boolean } | null;
  priority: { id: string; name: string } | null;
  assignee: { id: string; name: string; displayName: string } | null;
  parentKey: string | null; externalUrl: string;
}
interface UsedAccount { id: string; name: string; scope: string }
interface LookupResult { project: Project; issue: JiraIntakeIssue; existingTask: WorkTask | null; usedAccount?: UsedAccount | null }
interface SearchResult { project: Project; items: JiraIntakeIssue[]; total: number; usedAccount?: UsedAccount | null }
interface IntakeDraft { reference?: string; projectId?: string; query?: string }
interface Preview extends LookupResult { reference: string; generation: number }
type Operation = 'lookup' | 'search' | 'import';

export interface JiraTaskIntakeProps {
  open: boolean;
  user: User;
  projects: Project[];
  existingTasks?: WorkTask[];
  initialProjectId?: string;
  onClose: () => void;
  onManual: () => void;
  onImported: (task: WorkTask, projectId: string) => Promise<void>;
  onUnauthorized: () => void;
  onForbidden?: () => void;
}

export const JiraTaskIntake: React.FC<JiraTaskIntakeProps> = ({ open, user, projects, existingTasks = [], initialProjectId, onClose, onManual, onImported, onUnauthorized, onForbidden }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<IntakeDraft>();
  const [mode, setMode] = useState<'link' | 'select'>('link');
  const currentMode = useRef(mode);
  currentMode.current = mode;
  const [operation, setOperation] = useState<Operation | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [resultFilter, setResultFilter] = useState<'all' | 'unimported' | 'imported'>('all');
  const [selectedKey, setSelectedKey] = useState('');
  const [accountSwitching, setAccountSwitching] = useState(false);
  const [resolvedAccount, setResolvedAccount] = useState<{ projectId: string; userId: string; id: string | null }>();
  const sequence = useRef(0);
  const pending = useRef<Operation | null>(null);
  const autoSearchedKey = useRef('');
  const alive = useRef(true);
  const jiraProjects = projects.filter(project => !!project.jira);
  const preferredProject = jiraProjects.find(project => project.id === initialProjectId)?.id || (jiraProjects.length === 1 ? jiraProjects[0].id : undefined);
  const scope = JSON.stringify([user.id, user.role, initialProjectId, projects.map(project => [project.id, project.role, project.permissions, project.jira?.id, project.jira?.baseUrl, project.jira?.key])]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const openRef = useRef(open);
  openRef.current = open;
  const renderedRoute = location.hash;
  const importing = operation === 'import';
  const referenceValue = Form.useWatch('reference', form);
  const projectValue = Form.useWatch('projectId', form);
  const queryValue = Form.useWatch('query', form);
  const accountProject = (() => {
    if (mode === 'select') return jiraProjects.find(project => project.id === projectValue);
    try {
      const reference = parseJiraReference(referenceValue);
      const candidates = jiraProjects.filter(project => project.jira?.key === reference.key.split('-')[0] && jiraReferenceMatchesSource(reference, project.jira.baseUrl));
      return candidates.find(project => project.id === initialProjectId) || (candidates.length === 1 ? candidates[0] : undefined);
    } catch { return undefined; }
  })();
  const selectedAccountId = resolvedAccount?.projectId === accountProject?.id && resolvedAccount?.userId === user.id ? resolvedAccount.id : undefined;
  const accountUnknown = !!accountProject && selectedAccountId === undefined;

  const invalidate = () => {
    sequence.current += 1; pending.current = null; setOperation(null);
    setPreview(null); setSearchResult(null); setResultFilter('all'); setSelectedKey('');
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current += 1; pending.current = null; };
  }, []);
  useEffect(() => {
    invalidate(); autoSearchedKey.current = ''; setAccountSwitching(false); setMode('link'); form.resetFields();
    form.setFieldsValue({ projectId: preferredProject });
  }, [open, scope]);
  const close = () => { if (pending.current === 'import') return; invalidate(); form.resetFields(); onClose(); };
  const manual = () => { if (pending.current === 'import') return; invalidate(); form.resetFields(); onManual(); };
  const showError = (error: unknown) => {
    void message.error(error instanceof Error ? error.message : '请求失败。');
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      invalidate(); form.resetFields();
      if (error.status === 401) onUnauthorized(); else onForbidden?.();
    }
  };
  const begin = (name: Operation) => {
    if (!alive.current || !openRef.current || pending.current || currentScope.current !== scope || currentMode.current !== mode || renderedRoute !== location.hash) return null;
    const request = ++sequence.current;
    const owner = scope; const route = location.hash;
    pending.current = name; setOperation(name);
    const isCurrent = () => alive.current && openRef.current && currentScope.current === owner && request === sequence.current && location.hash === route;
    return { generation: request, isCurrent, finish: () => { if (isCurrent()) { pending.current = null; setOperation(null); } } };
  };
  const lookup = async (reference: string, projectId?: string, accountId = selectedAccountId) => {
    const request = begin('lookup');
    if (!request) return;
    setPreview(null);
    try {
      const result = await api<LookupResult>('jira/tasks/lookup', { reference, ...(projectId ? { projectId } : {}), ...(accountId !== undefined ? { accountId } : {}) });
      if (!request.isCurrent()) return;
      if (!result?.project?.id || !result?.issue || typeof result.issue.key !== 'string' || typeof result.issue.title !== 'string' || !projects.some(project => project.id === result.project.id)) throw new Error('平台响应格式不正确。');
      setPreview({ ...result, reference, generation: request.generation }); setSelectedKey(result.issue.key);
    } catch (error) { if (request.isCurrent()) { setSelectedKey(''); showError(error); } }
    finally { request.finish(); }
  };
  const read = async (values: IntakeDraft) => {
    if (currentMode.current !== mode || accountSwitching || accountUnknown) return;
    const current = form.getFieldsValue();
    if (mode === 'link' ? current.reference !== values.reference : current.projectId !== values.projectId || current.query !== values.query) return;
    if (mode === 'link') { await lookup(values.reference!.trim()); return; }
    const request = begin('search');
    if (!request) return;
    setPreview(null); setSearchResult(null); setSelectedKey('');
    try {
      const result = await api<SearchResult>('jira/tasks/search', { projectId: values.projectId, ...(selectedAccountId !== undefined ? { accountId: selectedAccountId } : {}), ...(values.query?.trim() ? { query: values.query.trim() } : {}) });
      if (!request.isCurrent()) return;
      if (!result?.project?.id || !Array.isArray(result.items) || !projects.some(project => project.id === result.project.id)) throw new Error('平台响应格式不正确。');
      setSearchResult(result);
    } catch (error) { if (request.isCurrent()) showError(error); }
    finally { request.finish(); }
  };
  const continueToTask = async (task: WorkTask, projectId: string) => {
    const owner = scope; const route = location.hash;
    sequence.current += 1; pending.current = 'import'; setOperation('import'); setPreview(null); setSearchResult(null); setSelectedKey(''); form.resetFields(); onClose();
    try { await onImported(task, projectId); }
    catch (error) { if (alive.current && currentScope.current === owner && location.hash === route) showError(error); }
    finally { if (alive.current && currentScope.current === owner && openRef.current) { pending.current = null; setOperation(null); } }
  };
  const directImport = async (reference: string, targetProjectId?: string, accountId = selectedAccountId) => {
    if (accountSwitching || accountUnknown) return;
    const request = begin('import');
    if (!request) return;
    try {
      const result = await api<{ task: WorkTask; project: Project; existing: boolean; imported: boolean }>('jira/tasks/import', {
        reference: reference.trim(),
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
      });
      if (!request.isCurrent()) return;
      if (!result?.task?.id || !projects.some(project => project.id === result.task.projectId)) throw new Error('平台响应格式不正确。');
      void message.success(result.imported ? 'Jira 任务已一步接入。' : '该事项已接入，已为你打开。');
      await continueToTask(result.task, result.task.projectId);
    } catch (error) {
      if (request.isCurrent()) showError(error);
    } finally {
      request.finish();
    }
  };
  useEffect(() => {
    if (!open || mode !== 'select' || !accountProject || accountUnknown || accountSwitching || searchResult || operation) return;
    const key = `${scope}:${accountProject.id}:${selectedAccountId ?? 'default'}`;
    if (autoSearchedKey.current === key) return;
    autoSearchedKey.current = key;
    void read({ projectId: accountProject.id, query: form.getFieldValue('query') });
  }, [open, mode, accountProject?.id, accountUnknown, accountSwitching, selectedAccountId, searchResult, operation, scope]);

  const confirm = async () => {
    if (!preview || pending.current || preview.generation !== sequence.current || !alive.current || !openRef.current || currentScope.current !== scope || currentMode.current !== mode || renderedRoute !== location.hash) return;
    if (preview.existingTask) { await continueToTask(preview.existingTask, preview.project.id); return; }
    const request = begin('import');
    if (!request) return;
    try {
      const result = await api<{ task: WorkTask; project: Project; existing: boolean; imported: boolean }>('jira/tasks/import', { reference: preview.reference, projectId: preview.project.id, accountId: preview.usedAccount?.id || null });
      if (!request.isCurrent()) return;
      if (!result?.task?.id || result.task.projectId !== preview.project.id) throw new Error('平台响应格式不正确。');
      void message.success(result.imported ? 'Jira 任务已接入。' : '该事项已接入，使用已有任务。');
      await continueToTask(result.task, result.task.projectId);
    } catch (error) { if (request.isCurrent()) { setPreview(null); setSelectedKey(''); showError(error); } }
    finally { request.finish(); }
  };

  const pasteFromClipboard = async () => {
    if (importing || accountSwitching || !jiraProjects.length) return;
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        void message.info('剪贴板暂无内容。');
        return;
      }
      invalidate();
      form.setFieldValue('reference', clip);
      try {
        parseJiraReference(clip);
        let targetProjId: string | undefined;
        try {
          const parsed = parseJiraReference(clip);
          const candidates = jiraProjects.filter(project => project.jira?.key === parsed.key.split('-')[0] && jiraReferenceMatchesSource(parsed, project.jira.baseUrl));
          const matched = candidates.find(project => project.id === initialProjectId) || (candidates.length === 1 ? candidates[0] : undefined);
          targetProjId = matched?.id;
        } catch { /* fallback to server lookup */ }
        const acctId = resolvedAccount?.projectId === targetProjId && resolvedAccount?.userId === user.id ? resolvedAccount.id : undefined;
        if (!targetProjId || acctId !== undefined) {
          void lookup(clip, targetProjId, acctId);
        }
      } catch {
        void message.info('已粘贴剪贴板内容，请核对格式。');
      }
    } catch {
      void message.warning('无法直接读取剪贴板，请按 Cmd/Ctrl + V 粘贴。');
    }
  };

  const existingByProjectKey = new Map(existingTasks.map(task => [`${task.projectId}:${task.jiraKey.toUpperCase()}`, task]));
  const importedSearchItems = searchResult ? searchResult.items.filter(issue => existingByProjectKey.has(`${searchResult.project.id}:${issue.key.toUpperCase()}`)) : [];
  const filteredSearchItems = searchResult ? searchResult.items.filter(issue => {
    const isImported = existingByProjectKey.has(`${searchResult.project.id}:${issue.key.toUpperCase()}`);
    if (resultFilter === 'unimported') return !isImported;
    if (resultFilter === 'imported') return isImported;
    return true;
  }) : [];

  return <Drawer title="接入 Jira 任务" open={open} onClose={close} size={640} forceRender closable={!importing} maskClosable={!importing} keyboard={!importing} className="tf-jira-intake" footer={<Flex justify="space-between" gap={12} wrap>
    <Button type="text" disabled={importing} onClick={manual}>手动登记</Button>
    <Space size={8}><Button disabled={importing} onClick={close}>取消</Button>{preview && <Button type="primary" icon={<ArrowRight size={15} />} iconPlacement="end" loading={importing} disabled={!!operation && !importing} onClick={() => void confirm()}>{preview.existingTask ? '打开已有任务' : '确认接入'}</Button>}</Space>
  </Flex>}>
    <div className="tf-jira-intake-content">
      <div><Typography.Paragraph className="tf-jira-intake-lead">读取 Jira 事项，自动带出标题、项目和类型。</Typography.Paragraph><Typography.Text type="secondary">读取后确认接入本地工作台，不会创建或修改外部 Jira 事项。</Typography.Text></div>
      <Segmented block aria-label="选择 Jira 接入方式" value={mode} disabled={importing || accountSwitching} options={[{ value: 'link', label: '粘贴链接或任务号' }, { value: 'select', label: '选择 Jira 事项' }]} onChange={value => { invalidate(); autoSearchedKey.current = ''; form.resetFields(); form.setFieldsValue({ projectId: preferredProject }); setMode(value as 'link' | 'select'); }} />
      <Form form={form} layout="vertical" disabled={importing || accountSwitching || !jiraProjects.length} preserve={false} onFinish={values => void read(values)} onValuesChange={() => { if (pending.current !== 'import') invalidate(); }}>
        {mode === 'link' ? <Form.Item name="reference" label="Jira 链接或任务号" htmlFor="jira-intake-reference" rules={[{ required: true, whitespace: true, message: '请粘贴 Jira 链接或输入任务号。' }, { validator: (_, value) => { try { parseJiraReference(value); return Promise.resolve(); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('请输入有效的 Jira 链接或任务号。')); } } }]} extra="自动识别你有权限且已接入的 Jira 项目，可直接一步接入打开，也可先读取预览。"><Input id="jira-intake-reference" prefix={<Link2 size={16} />} placeholder="https://jira.example.com/browse/SAMPLE-562 或 SAMPLE-562" autoComplete="off" maxLength={2048} allowClear /></Form.Item> : <>
          <Form.Item name="projectId" label="Jira 项目" rules={[{ required: true, message: '请选择已接入的 Jira 项目。' }]}><Select placeholder="选择项目" showSearch={{ optionFilterProp: 'label' }} options={jiraProjects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))} /></Form.Item>
          <Form.Item name="query" label="搜索事项（可选）" htmlFor="jira-intake-query" rules={[{ max: 100, message: '搜索内容不能超过 100 个字符。' }]}><Input id="jira-intake-query" prefix={<Search size={16} />} placeholder="任务号或标题；留空读取项目事项（按 Esc 清空）" autoComplete="off" maxLength={100} allowClear onKeyDown={clearSearchOnEscape(queryValue || '', () => form.setFieldValue('query', ''))} /></Form.Item>
        </>}
        <Space size={8} wrap>
          {mode === 'link' && (
            <>
              <Button
                type="primary"
                icon={<ArrowRight size={15} />}
                iconPlacement="end"
                loading={importing}
                disabled={!!operation || accountSwitching || accountUnknown || !jiraProjects.length}
                onClick={() => {
                  void form.validateFields(['reference']).then(vals => {
                    if (vals.reference?.trim()) void directImport(vals.reference.trim(), accountProject?.id, selectedAccountId);
                  }).catch(() => {});
                }}
              >
                直接接入并打开
              </Button>
              <Button
                icon={<ClipboardPaste size={15} />}
                disabled={!!operation || accountSwitching || !jiraProjects.length}
                onClick={() => void pasteFromClipboard()}
              >
                读取剪贴板
              </Button>
            </>
          )}
          <Button htmlType="submit" type={mode === 'link' || preview ? 'default' : 'primary'} icon={<Search size={16} />} loading={operation === 'lookup' || operation === 'search'} disabled={importing || accountSwitching || accountUnknown || !jiraProjects.length}>{mode === 'link' ? '读取预览' : '刷新事项列表'}</Button>
        </Space>
      </Form>
      {accountProject && <AccountUsageSelector userId={user.id} projectId={accountProject.id} provider="jira" disabled={!!operation || accountSwitching} onChanging={() => { invalidate(); autoSearchedKey.current = ''; setAccountSwitching(true); }} onChanged={() => { invalidate(); autoSearchedKey.current = ''; setAccountSwitching(false); }} onResolved={id => setResolvedAccount(id === undefined ? undefined : { projectId: accountProject.id, userId: user.id, id })} onUnauthorized={onUnauthorized} onForbidden={() => { invalidate(); setAccountSwitching(false); form.resetFields(); onForbidden?.(); }} />}
      {!jiraProjects.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无可接入的 Jira 项目，请联系管理员接入项目，或使用手动登记。" />}
      {searchResult && <section className="tf-jira-intake-results" aria-label="Jira 事项读取结果">
        <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary">已读取 {searchResult.items.length} 项{searchResult.total > searchResult.items.length ? `，共 ${searchResult.total} 项，可搜索缩小范围` : ''}</Typography.Text>
          {searchResult.items.length > 0 && importedSearchItems.length > 0 && (
            <Segmented<'all' | 'unimported' | 'imported'>
              size="small"
              aria-label="筛选是否已接入"
              value={resultFilter}
              onChange={setResultFilter}
              options={[
                { value: 'all', label: `全部 (${searchResult.items.length})` },
                { value: 'unimported', label: `未接入 (${searchResult.items.length - importedSearchItems.length})` },
                { value: 'imported', label: `已在工作台 (${importedSearchItems.length})` },
              ]}
            />
          )}
        </Flex>
        <Radio.Group value={selectedKey || undefined} disabled={!!operation} onChange={event => { const issue = searchResult.items.find(item => item.key === event.target.value); if (issue) { setSelectedKey(issue.key); void lookup(issue.key, searchResult.project.id, searchResult.usedAccount?.id || null); } }}>
          <List dataSource={filteredSearchItems} rowKey="key" pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false, size: 'small', disabled: !!operation }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合筛选条件的 Jira 事项。" /> }} renderItem={issue => {
            const localTask = existingByProjectKey.get(`${searchResult.project.id}:${issue.key.toUpperCase()}`);
            return (
              <List.Item
                actions={[
                  localTask ? (
                    <Button
                      key="open"
                      type="link"
                      size="small"
                      disabled={!!operation}
                      onClick={event => {
                        event.stopPropagation();
                        void continueToTask(localTask, searchResult.project.id);
                      }}
                    >
                      直接打开
                    </Button>
                  ) : (
                    <Button
                      key="direct"
                      type="link"
                      size="small"
                      disabled={!!operation}
                      onClick={event => {
                        event.stopPropagation();
                        void directImport(issue.key, searchResult.project.id, searchResult.usedAccount?.id || null);
                      }}
                    >
                      直接接入
                    </Button>
                  ),
                ]}
              >
                <Radio value={issue.key}><span className="tf-jira-intake-option"><span className="tf-jira-intake-option-heading"><Typography.Text code>{issue.key}</Typography.Text><Typography.Text type="secondary">{issue.type}</Typography.Text>{localTask && <Tag color="blue">已在工作台</Tag>}</span><span className="tf-jira-intake-option-title">{issue.title}</span><span><Tag>{issue.status}</Tag></span></span></Radio>
              </List.Item>
            );
          }} />
        </Radio.Group>
      </section>}
      {preview && <Card size="small" className="tf-jira-intake-preview" title={<Typography.Text code>{preview.issue.key}</Typography.Text>} extra={<Tag color={preview.existingTask ? 'blue' : 'default'}>{preview.existingTask ? '本地已有记录' : '待确认接入'}</Tag>}>
        <Typography.Title level={3}>{preview.issue.title}</Typography.Title>
        <Descriptions size="small" column={1} items={[
          { key: 'project', label: '所属项目', children: `${preview.project.key} · ${preview.project.name}` },
          { key: 'account', label: '读取账号', children: preview.usedAccount?.name || '项目默认连接' },
          { key: 'status', label: 'Jira 状态', children: preview.issue.status },
          { key: 'type', label: 'Jira 类型', children: preview.issue.type },
          { key: 'assignee', label: 'Jira 经办人', children: preview.issue.assignee ? preview.issue.assignee.displayName : '未分配' },
          ...(preview.issue.parentKey ? [{ key: 'parent', label: 'Jira 父事项', children: preview.issue.parentKey }] : []),
          ...(preview.issue.priority ? [{ key: 'priority', label: '优先级', children: preview.issue.priority.name }] : []),
        ]} />
        <Flex vertical gap={8} className="tf-jira-intake-preview-footer"><Typography.Text type="secondary">{preview.existingTask ? '已找到本地同号任务，直接打开；不会覆盖受理人或进度。' + (preview.existingTask.externalRef ? '' : ' 此记录尚未绑定 Jira 来源。') : '标题、类型与来源自动读取。本地受理人按项目权限设置，与 Jira 经办人分开。'}</Typography.Text><Typography.Link href={preview.issue.externalUrl} target="_blank" rel="noreferrer" className="tf-jira-intake-source">查看 Jira 原事项<ExternalLink size={14} /></Typography.Link></Flex>
      </Card>}
    </div>
  </Drawer>;
};

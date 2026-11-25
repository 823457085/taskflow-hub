import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Empty, Flex, Form, Grid, Input, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, Project, User } from './workspaceApi';
import { readProjectRecords } from './readProjectRecords';
import { LinkifiedText } from './MarkdownPreview';
import './WorkspaceRecords.css';

type Status = 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';
export interface Deployment {
  id: string; projectId: string; provider: 'manual' | 'yunxiao' | 'jenkins' | 'other'; externalId: string | null; environment: string; service: string;
  version: string; status: Status; url: string; notes: string; actorId: string; actorName: string;
  startedAt: string; finishedAt: string | null; createdAt: string; updatedAt: string; canEdit: boolean; canDelete: boolean;
}
interface EnvironmentSummary { environment: string; total: number; latest: Deployment }
interface DeploymentForm { projectId?: string; environment: string; service: string; version: string; status: Status; url: string; notes: string }

const STATUS: Record<Status, { label: string; color: string }> = {
  running: { label: '部署中', color: 'processing' }, success: { label: '成功', color: 'success' }, failed: { label: '失败', color: 'error' },
  cancelled: { label: '已取消', color: 'default' }, unknown: { label: '未知', color: 'warning' },
};
const PROVIDERS: Record<Deployment['provider'], string> = { manual: '手动登记', yunxiao: '云效', jenkins: 'Jenkins', other: '其他' };
const when = (value: string | null) => value ? new Date(value).toLocaleString() : '—';
const duration = (item: Deployment) => {
  if (!item.finishedAt) return '';
  const seconds = Math.max(0, Math.round((Date.parse(item.finishedAt) - Date.parse(item.startedAt)) / 1000));
  if (seconds > 86_400) return '';
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
};

export const DeploymentsView: React.FC<{ user: User; projects: Project[]; projectId: string; onUnauthorized: () => void }> = ({ user, projects, projectId, onUnauthorized }) => {
  const { message } = App.useApp();
  const compact = !Grid.useBreakpoint().lg;
  const [form] = Form.useForm<DeploymentForm>();
  const [items, setItems] = useState<Deployment[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [environment, setEnvironment] = useState<string>();
  const [status, setStatus] = useState<Status>();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Deployment | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const projectKey = (id: string) => projects.find(project => project.id === id)?.key || id;

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const results = await readProjectRecords(projectId ? [projectId] : projects.map(project => project.id), id => {
        const params = new URLSearchParams({ projectId: id, limit: '300' });
        if (environment) params.set('environment', environment);
        if (status) params.set('status', status);
        return api<{ deployments: Deployment[]; environments: EnvironmentSummary[] }>(`deployments?${params}`);
      });
      if (request !== sequence.current) return;
      setItems(results.flatMap(result => result.deployments).sort((left, right) => right.startedAt.localeCompare(left.startedAt)));
      setEnvironments(results.flatMap(result => result.environments).sort((left, right) => right.latest.startedAt.localeCompare(left.latest.startedAt)));
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setItems([]); setEnvironments([]); void refresh(); return () => { sequence.current += 1; }; }, [projectId, projects, environment, status, user.id]);
  useEffect(() => { setEditing(null); }, [projectId, user.id]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && items.some(item => item.status === 'running')) void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [items, projectId, projects, environment, status]);

  const openEditor = (item: Deployment | 'new') => {
    setEditing(item);
    form.setFieldsValue(item === 'new'
      ? { projectId: projectId || undefined, environment: environment || '', service: '', version: '', status: 'running', url: '', notes: '' }
      : { projectId: item.projectId, environment: item.environment, service: item.service, version: item.version, status: item.status, url: item.url, notes: item.notes });
  };
  const save = async (values: DeploymentForm) => {
    if (!editing || saving) return;
    const targetProjectId = projectId || values.projectId;
    if (editing === 'new' && !projects.some(project => project.id === targetProjectId)) return;
    setSaving(true);
    try {
      if (editing === 'new') await api('deployments', { projectId: targetProjectId, environment: values.environment, service: values.service, version: values.version || '', status: values.status, url: values.url || '', notes: values.notes || '' });
      else await api(`deployments/${editing.id}`, editing.provider === 'manual'
        ? { status: values.status, version: values.version || '', url: values.url || '', notes: values.notes || '' }
        : { notes: values.notes || '' }, 'PATCH');
      setEditing(null); void message.success('部署记录已保存。'); void refresh();
    } catch (error) { fail(error); }
    finally { setSaving(false); }
  };
  const quickStatus = async (item: Deployment, next: Status) => {
    try { await api(`deployments/${item.id}`, { status: next }, 'PATCH'); void refresh(); }
    catch (error) { fail(error); }
  };
  const remove = async (item: Deployment) => {
    try { await api(`deployments/${item.id}`, undefined, 'DELETE'); void message.success('部署记录已删除。'); void refresh(); }
    catch (error) { fail(error); }
  };

  const renderStatus = (item: Deployment) => item.provider === 'manual' && item.canEdit
    ? <Select size="small" aria-label="部署状态" value={item.status} style={{ width: 96 }} onChange={value => void quickStatus(item, value)} options={Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.label }))} />
    : <Tag color={STATUS[item.status].color}>{STATUS[item.status].label}</Tag>;
  const renderActions = (item: Deployment) => (
    <Space size={4}>
      {item.canEdit ? <Button type="text" size="small" aria-label="编辑部署记录" icon={<Pencil size={14} />} onClick={() => openEditor(item)} /> : null}
      {item.canDelete ? <Popconfirm title="删除这条部署记录？" okText="删除" cancelText="取消" onConfirm={() => void remove(item)}><Button type="text" size="small" danger aria-label="删除部署记录" icon={<Trash2 size={14} />} /></Popconfirm> : null}
    </Space>
  );
  const renderTime = (item: Deployment) => <Typography.Text type="secondary">{when(item.startedAt)}{duration(item) ? ` · ${duration(item)}` : ''}</Typography.Text>;

  const columns: TableColumnsType<Deployment> = [
    { title: '服务', render: (_, item) => (
      <Flex vertical gap={4}>
        <Space size={[8, 4]} wrap>
          <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>{item.service}</Typography.Text>
          {!projectId && <Typography.Text type="secondary">{projectKey(item.projectId)}</Typography.Text>}
          {item.version ? <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere' }}>{item.version}</Typography.Text> : null}
          {item.url ? <Typography.Link href={item.url} target="_blank" rel="noreferrer" aria-label="打开流水线"><ExternalLink size={12} /></Typography.Link> : null}
        </Space>
        {item.notes ? <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><LinkifiedText text={item.notes} /></Typography.Text> : null}
        {compact && <>
          <Space size={[8, 4]} wrap>
            <Typography.Text>{item.environment}</Typography.Text>
            <Typography.Text type="secondary">{PROVIDERS[item.provider]} · {item.actorName}</Typography.Text>
            {renderTime(item)}
          </Space>
          <Space size={[8, 4]} wrap>{renderStatus(item)}{renderActions(item)}</Space>
        </>}
      </Flex>
    ) },
    ...(!compact ? [
      { title: '环境', width: 100, render: (_: unknown, item: Deployment) => item.environment },
      { title: '状态', width: 112, render: (_: unknown, item: Deployment) => renderStatus(item) },
      { title: '开始时间', width: 174, render: (_: unknown, item: Deployment) => renderTime(item) },
      { title: '来源', width: 116, render: (_: unknown, item: Deployment) => <Flex vertical><span>{PROVIDERS[item.provider]}</span><Typography.Text type="secondary">{item.actorName}</Typography.Text></Flex> },
      { title: '', width: 82, render: (_: unknown, item: Deployment) => renderActions(item) },
    ] : []),
  ];

  return (
    <div className="tf-record-workspace">
      <div className="tf-record-toolbar">
        <div className="tf-record-filters">
          <Select aria-label="环境" allowClear placeholder="全部环境" style={{ width: 140 }} value={environment} onChange={setEnvironment} options={[...new Set(environments.map(item => item.environment))].map(value => ({ value, label: value }))} />
          <Select aria-label="状态" allowClear placeholder="全部状态" style={{ width: 120 }} value={status} onChange={setStatus} options={Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.label }))} />
        </div>
        <div className="tf-record-actions">
          <Button icon={<RefreshCw size={14} />} loading={loading} aria-label="刷新部署记录" title="刷新部署记录" onClick={() => void refresh()} />
          <Button type="primary" icon={<Plus size={14} />} disabled={!projects.length} onClick={() => openEditor('new')}>登记部署</Button>
        </div>
      </div>
      {environments.length > 0 && <div className="tf-record-environments" aria-label="各环境最新部署">
        {environments.map(item => (
          <div key={JSON.stringify([item.latest.projectId, item.environment])} className="tf-record-env">
            <span className="tf-record-env-header"><strong title={item.environment}>{!projectId && `${projectKey(item.latest.projectId)} · `}{item.environment}</strong><Tag color={STATUS[item.latest.status].color}>{STATUS[item.latest.status].label}</Tag></span>
            <span className="tf-record-env-service" title={`${item.latest.service} ${item.latest.version || ''}`}>{item.latest.service}{item.latest.version ? ` ${item.latest.version}` : ''}</span>
            <span className="tf-record-env-meta">{when(item.latest.startedAt)} · {item.total} 次</span>
          </div>
        ))}
      </div>}
      <div className="tf-record-table">
        <Table<Deployment> rowKey="id" size="small" tableLayout="fixed" loading={loading} dataSource={items} columns={columns} pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={environment || status ? '没有符合筛选条件的部署记录' : projectId ? '当前项目暂无部署记录' : '暂无部署记录'} /> }} />
      </div>
      <Drawer open={!!editing} size="min(480px, 100vw)" onClose={() => setEditing(null)} title={editing === 'new' ? '登记部署' : '编辑部署记录'} destroyOnHidden
        extra={<Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button>}>
        <Form<DeploymentForm> form={form} layout="vertical" onFinish={values => void save(values)}>
          {!projectId && <Form.Item name="projectId" label="所属项目" rules={[{ required: true, message: '请选择所属项目' }]}>
            <Select disabled={editing !== 'new'} showSearch={{ optionFilterProp: 'label' }} options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))} />
          </Form.Item>}
          {editing && editing !== 'new' && editing.provider !== 'manual' ? <Typography.Paragraph type="secondary">这条记录从{PROVIDERS[editing.provider]}同步，状态以流水线为准，这里只能补充备注。</Typography.Paragraph> : null}
          <Form.Item name="environment" label="环境" rules={[{ required: true, message: '请填写环境' }, { max: 40 }]}><Input placeholder="例如 test / pre / prod" disabled={editing !== 'new'} /></Form.Item>
          <Form.Item name="service" label="服务" rules={[{ required: true, message: '请填写服务' }, { max: 120 }]}><Input placeholder="例如 example-web" disabled={editing !== 'new'} /></Form.Item>
          <Form.Item name="version" label="版本 / 分支" rules={[{ max: 200 }]}><Input placeholder="例如 v1.2.0 或 release/1.2" disabled={editing !== 'new' && editing?.provider !== 'manual'} /></Form.Item>
          <Form.Item name="status" label="状态"><Select disabled={editing !== 'new' && editing?.provider !== 'manual'} options={Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.label }))} /></Form.Item>
          <Form.Item name="url" label="链接" rules={[{ type: 'url', message: '请填写 http(s) 链接' }, { max: 500 }]}><Input placeholder="流水线或发布单链接" disabled={editing !== 'new' && editing?.provider !== 'manual'} /></Form.Item>
          <Form.Item name="notes" label="备注" rules={[{ max: 2000 }]}><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder="变更内容、灰度比例、回滚方案等" /></Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Drawer, Empty, Flex, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, User } from './workspaceApi';

type Status = 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';
export interface Deployment {
  id: string; projectId: string; provider: 'manual' | 'yunxiao' | 'jenkins' | 'other'; externalId: string | null; environment: string; service: string;
  version: string; status: Status; url: string; notes: string; actorId: string; actorName: string;
  startedAt: string; finishedAt: string | null; createdAt: string; updatedAt: string; canEdit: boolean; canDelete: boolean;
}
interface EnvironmentSummary { environment: string; total: number; latest: Deployment }
interface DeploymentForm { environment: string; service: string; version: string; status: Status; url: string; notes: string }

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

export const DeploymentsView: React.FC<{ user: User; projectId: string; onUnauthorized: () => void }> = ({ user, projectId, onUnauthorized }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<DeploymentForm>();
  const [items, setItems] = useState<Deployment[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [environment, setEnvironment] = useState<string>();
  const [status, setStatus] = useState<Status>();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Deployment | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    if (!projectId) { setItems([]); setEnvironments([]); return; }
    const request = ++sequence.current;
    setLoading(true);
    const params = new URLSearchParams({ projectId, limit: '300' });
    if (environment) params.set('environment', environment);
    if (status) params.set('status', status);
    try {
      const data = await api<{ deployments: Deployment[]; environments: EnvironmentSummary[] }>(`deployments?${params}`);
      if (request === sequence.current) { setItems(data.deployments); setEnvironments(data.environments); }
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setItems([]); void refresh(); }, [projectId, environment, status, user.id]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && items.some(item => item.status === 'running')) void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [items, projectId, environment, status]);

  const openEditor = (item: Deployment | 'new') => {
    setEditing(item);
    form.setFieldsValue(item === 'new'
      ? { environment: environment || '', service: '', version: '', status: 'running', url: '', notes: '' }
      : { environment: item.environment, service: item.service, version: item.version, status: item.status, url: item.url, notes: item.notes });
  };
  const save = async (values: DeploymentForm) => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      if (editing === 'new') await api('deployments', { projectId, environment: values.environment, service: values.service, version: values.version || '', status: values.status, url: values.url || '', notes: values.notes || '' });
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

  const columns: TableColumnsType<Deployment> = [
    { title: '开始时间', width: 170, render: (_, item) => <Flex vertical><span>{when(item.startedAt)}</span>{duration(item) ? <Typography.Text type="secondary">耗时 {duration(item)}</Typography.Text> : null}</Flex> },
    { title: '环境', width: 90, render: (_, item) => <Tag>{item.environment}</Tag> },
    { title: '服务 / 版本', render: (_, item) => (
      <Flex vertical gap={2}>
        <Space size={6}><Typography.Text strong>{item.service}</Typography.Text>{item.version ? <Typography.Text type="secondary">{item.version}</Typography.Text> : null}
          {item.url ? <Typography.Link href={item.url} target="_blank" rel="noreferrer" aria-label="打开流水线"><ExternalLink size={12} /></Typography.Link> : null}</Space>
        {item.notes ? <Typography.Text type="secondary" ellipsis style={{ maxWidth: 480 }}>{item.notes}</Typography.Text> : null}
      </Flex>
    ) },
    { title: '状态', width: 120, render: (_, item) => item.provider === 'manual' && item.canEdit
      ? <Select size="small" aria-label="部署状态" value={item.status} style={{ width: 96 }} onChange={value => void quickStatus(item, value)} options={Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.label }))} />
      : <Tag color={STATUS[item.status].color}>{STATUS[item.status].label}</Tag> },
    { title: '来源', width: 110, render: (_, item) => <Flex vertical><span>{PROVIDERS[item.provider]}</span><Typography.Text type="secondary">{item.actorName}</Typography.Text></Flex> },
    { title: '', width: 80, render: (_, item) => (
      <Space size={4}>
        {item.canEdit ? <Button type="text" size="small" aria-label="编辑" icon={<Pencil size={14} />} onClick={() => openEditor(item)} /> : null}
        {item.canDelete ? <Popconfirm title="删除这条部署记录？" okText="删除" cancelText="取消" onConfirm={() => void remove(item)}><Button type="text" size="small" danger aria-label="删除" icon={<Trash2 size={14} />} /></Popconfirm> : null}
      </Space>
    ) },
  ];

  return (
    <Flex vertical gap={16}>
      {environments.length ? (
        <Flex gap={12} wrap>
          {environments.map(item => (
            <Card key={item.environment} size="small" hoverable onClick={() => setEnvironment(environment === item.environment ? undefined : item.environment)}
              style={{ minWidth: 220, borderColor: environment === item.environment ? 'var(--ant-color-primary)' : undefined }}>
              <Flex justify="space-between" align="center"><Typography.Text strong>{item.environment}</Typography.Text><Tag color={STATUS[item.latest.status].color}>{STATUS[item.latest.status].label}</Tag></Flex>
              <Typography.Text>{item.latest.service}{item.latest.version ? ` ${item.latest.version}` : ''}</Typography.Text><br />
              <Typography.Text type="secondary">{when(item.latest.startedAt)} · 共 {item.total} 次</Typography.Text>
            </Card>
          ))}
        </Flex>
      ) : null}
      <Flex gap={12} wrap justify="space-between">
        <Space wrap>
          <Select aria-label="环境" allowClear placeholder="全部环境" style={{ width: 140 }} value={environment} onChange={setEnvironment} options={environments.map(item => ({ value: item.environment, label: item.environment }))} />
          <Select aria-label="状态" allowClear placeholder="全部状态" style={{ width: 120 }} value={status} onChange={setStatus} options={Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.label }))} />
        </Space>
        <Space>
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          <Button type="primary" icon={<Plus size={14} />} disabled={!projectId} onClick={() => openEditor('new')}>登记部署</Button>
        </Space>
      </Flex>
      <Table<Deployment> rowKey="id" size="middle" loading={loading} dataSource={items} columns={columns} pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty description={<span>还没有部署记录。可以手动登记，或在本机运行 <Typography.Text code>taskflow-bridge sync-delivery --data-dir &lt;Delivery 目录&gt;/.local/data --project {projectId || '<项目ID>'} --match &lt;部署项目名&gt;</Typography.Text> 同步 Delivery 里的云效、Jenkins 部署。</span>} /> }} />
      <Drawer open={!!editing} width={480} onClose={() => setEditing(null)} title={editing === 'new' ? '登记部署' : '编辑部署记录'} destroyOnHidden
        extra={<Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button>}>
        <Form<DeploymentForm> form={form} layout="vertical" onFinish={values => void save(values)}>
          {editing && editing !== 'new' && editing.provider !== 'manual' ? <Typography.Paragraph type="secondary">这条记录从{PROVIDERS[editing.provider]}同步，状态以流水线为准，这里只能补充备注。</Typography.Paragraph> : null}
          <Form.Item name="environment" label="环境" rules={[{ required: true, message: '请填写环境' }, { max: 40 }]}><Input placeholder="例如 test / pre / prod" disabled={editing !== 'new'} /></Form.Item>
          <Form.Item name="service" label="服务" rules={[{ required: true, message: '请填写服务' }, { max: 120 }]}><Input placeholder="例如 example-web" disabled={editing !== 'new'} /></Form.Item>
          <Form.Item name="version" label="版本 / 分支" rules={[{ max: 200 }]}><Input placeholder="例如 v1.2.0 或 release/1.2" disabled={editing !== 'new' && editing?.provider !== 'manual'} /></Form.Item>
          <Form.Item name="status" label="状态"><Select disabled={editing !== 'new' && editing?.provider !== 'manual'} options={Object.entries(STATUS).map(([value, meta]) => ({ value, label: meta.label }))} /></Form.Item>
          <Form.Item name="url" label="链接" rules={[{ type: 'url', message: '请填写 http(s) 链接' }, { max: 500 }]}><Input placeholder="流水线或发布单链接" disabled={editing !== 'new' && editing?.provider !== 'manual'} /></Form.Item>
          <Form.Item name="notes" label="备注" rules={[{ max: 2000 }]}><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder="变更内容、灰度比例、回滚方案等" /></Form.Item>
        </Form>
      </Drawer>
    </Flex>
  );
};

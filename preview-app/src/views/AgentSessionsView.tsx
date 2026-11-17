import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Empty, Flex, Input, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { MessageSquare, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { api, ApiError, Project, User, WorkTask } from './workspaceApi';
import { openTaskRoute } from './workspaceNavigation';

export interface AgentSession {
  id: string; ownerId: string; ownerName: string; projectId: string | null; taskId: string | null; taskKey: string | null;
  source: string; title: string; provider: string; model: string; mode: string; status: string; excerpt: string;
  workspace: string; branch: string; turns: number; inputTokens: number; outputTokens: number; costUsd: number;
  jiraKeys: string[]; shared: boolean; startedAt: string; updatedAt: string; syncedAt: string; comments: number;
}
export interface AgentSessionDetail extends AgentSession {
  objective: string; result: string; error: string; canManage: boolean;
  commentList: { id: string; body: string; createdAt: string; authorId: string; authorName: string }[];
}
type Scope = 'mine' | 'project';

const STATUS: Record<string, { label: string; color: string }> = {
  running: { label: '运行中', color: 'processing' }, queued: { label: '排队中', color: 'processing' }, completed: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' }, interrupted: { label: '已中断', color: 'warning' }, cancelled: { label: '已取消', color: 'default' },
};
const statusTag = (status: string) => <Tag color={STATUS[status]?.color || 'default'}>{STATUS[status]?.label || status}</Tag>;
const tokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const when = (value: string) => new Date(value).toLocaleString();

export const AgentSessionsView: React.FC<{
  user: User; projects: Project[]; projectId: string; tasks: WorkTask[]; onUnauthorized: () => void;
}> = ({ user, projects, projectId, tasks, onUnauthorized }) => {
  const { message, modal } = App.useApp();
  const [scope, setScope] = useState<Scope>('mine');
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const projectKey = (id: string | null) => !id ? '未归属' : projects.find(project => project.id === id)?.key || id;

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    if (scope === 'project' && !projectId) { setSessions([]); setTotal(0); return; }
    const request = ++sequence.current;
    setLoading(true);
    const params = new URLSearchParams({ scope, limit: '200' });
    if (scope === 'project') params.set('projectId', projectId);
    if (query.trim()) params.set('q', query.trim());
    try {
      const data = await api<{ sessions: AgentSession[]; total: number }>(`agent-sessions?${params}`);
      if (request === sequence.current) { setSessions(data.sessions); setTotal(data.total); }
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setSessions([]); setSelected([]); void refresh(); }, [scope, projectId, user.id]);

  const open = async (id: string) => {
    try { setDetail((await api<{ session: AgentSessionDetail }>(`agent-sessions/${id}`)).session); setComment(''); }
    catch (error) { fail(error); }
  };
  const applyDetail = (session: AgentSessionDetail) => {
    setDetail(session);
    setSessions(current => current.map(item => item.id === session.id ? { ...item, ...session } : item).filter(item => scope === 'mine' || (item.shared && item.projectId === projectId)));
  };
  const patch = async (changes: { projectId?: string | null; shared?: boolean; taskId?: string | null }) => {
    if (!detail || busy) return;
    setBusy(true);
    try { applyDetail((await api<{ session: AgentSessionDetail }>(`agent-sessions/${detail.id}`, changes, 'PATCH')).session); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const shareSelected = async (shared: boolean) => {
    if (!selected.length || !projectId) return;
    try {
      const result = await api<{ changed: number }>('agent-sessions/share', { ids: selected, projectId, shared });
      void message.success(shared ? `已把 ${result.changed} 条记录共享到 ${projectKey(projectId)}。` : `已取消 ${result.changed} 条记录的共享。`);
      setSelected([]); void refresh();
    } catch (error) { fail(error); }
  };
  const addComment = async () => {
    if (!detail || !comment.trim() || busy) return;
    setBusy(true);
    try { applyDetail((await api<{ session: AgentSessionDetail }>(`agent-sessions/${detail.id}/comments`, { body: comment })).session); setComment(''); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const remove = () => {
    if (!detail) return;
    modal.confirm({
      title: '删除这条 Agent 记录？', content: '只删除平台上的同步副本，本机 Delivery 里的会话不受影响；之后本机会话有更新时会重新同步。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try { await api(`agent-sessions/${detail.id}`, undefined, 'DELETE'); setSessions(current => current.filter(item => item.id !== detail.id)); setDetail(null); void message.success('记录已删除。'); }
        catch (error) { fail(error); }
      },
    });
  };

  const columns: TableColumnsType<AgentSession> = [
    { title: '会话', render: (_, item) => (
      <Flex vertical gap={2}>
        <Typography.Link onClick={() => void open(item.id)}>{item.title}</Typography.Link>
        {item.excerpt ? <Typography.Text type="secondary" ellipsis style={{ maxWidth: 520 }}>{item.excerpt}</Typography.Text> : null}
      </Flex>
    ) },
    ...(scope === 'project' ? [{ title: '成员', width: 100, render: (_: unknown, item: AgentSession) => item.ownerName }] : []),
    { title: '执行', width: 150, render: (_, item) => <Flex vertical><span>{item.provider || '—'}</span><Typography.Text type="secondary">{item.model}</Typography.Text></Flex> },
    { title: '状态', width: 90, render: (_, item) => statusTag(item.status) },
    { title: '关联', width: 130, render: (_, item) => item.taskId ? <Typography.Link onClick={() => openTaskRoute(item.taskId!, { from: 'sessions' })}>{item.taskKey}</Typography.Link> : item.jiraKeys.length ? <Typography.Text type="secondary">{item.jiraKeys.join('、')}</Typography.Text> : '—' },
    ...(scope === 'mine' ? [{ title: '共享', width: 110, render: (_: unknown, item: AgentSession) => item.shared ? <Tag color="blue">{projectKey(item.projectId)}</Tag> : <Typography.Text type="secondary">仅自己</Typography.Text> }] : []),
    { title: '轮次 / Token', width: 120, render: (_, item) => `${item.turns} 轮 · ${tokens(item.inputTokens + item.outputTokens)}` },
    { title: '更新', width: 170, render: (_, item) => <Space size={4}>{when(item.updatedAt)}{item.comments ? <Tag icon={<MessageSquare size={11} />}>{item.comments}</Tag> : null}</Space> },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex gap={12} wrap justify="space-between" align="center">
        <Space wrap>
          <Segmented<Scope> value={scope} onChange={setScope} options={[{ value: 'mine', label: '我的记录' }, { value: 'project', label: '项目共享' }]} />
          <Input.Search allowClear placeholder="搜索标题、目标或 Jira 号" value={query} onChange={event => setQuery(event.target.value)} onSearch={() => void refresh()} style={{ width: 260 }} />
          <Typography.Text type="secondary">共 {total} 条</Typography.Text>
        </Space>
        <Space wrap>
          {scope === 'mine' && selected.length ? <>
            <Button icon={<Share2 size={14} />} disabled={!projectId} onClick={() => void shareSelected(true)}>共享到 {projectKey(projectId)}（{selected.length}）</Button>
            <Button onClick={() => void shareSelected(false)}>取消共享</Button>
          </> : null}
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
        </Space>
      </Flex>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        {scope === 'mine'
          ? '本机 Delivery 的 Agent 会话由客户端同步上来，默认只有自己能看到；勾选后共享到当前项目，项目成员就能查看和评论。同步时只上传标题、目标和结果摘要，常见密钥会被打码，不上传完整工作目录路径。'
          : '项目成员主动共享到本项目的 Agent 会话，可以查看结果、关联任务并评论交流。'}
      </Typography.Paragraph>
      <Table<AgentSession> rowKey="id" size="middle" loading={loading} dataSource={sessions} columns={columns} pagination={{ pageSize: 20, showSizeChanger: false }}
        rowSelection={scope === 'mine' ? { selectedRowKeys: selected, onChange: keys => setSelected(keys as string[]) } : undefined}
        locale={{ emptyText: <Empty description={scope === 'mine'
          ? <span>还没有同步记录。在本机运行 <Typography.Text code>taskflow-bridge sync-delivery --data-dir &lt;Delivery 目录&gt;/.local/data</Typography.Text>，或在 worker.json 配置 deliverySync 后由后台定时同步。</span>
          : '这个项目还没有成员共享 Agent 会话。'} /> }} />
      <Drawer open={!!detail} width={720} onClose={() => setDetail(null)} title={detail?.title} destroyOnHidden
        extra={detail?.canManage ? <Button danger icon={<Trash2 size={14} />} onClick={remove}>删除</Button> : null}>
        {detail ? (
          <Flex vertical gap={16}>
            <Space wrap>
              {statusTag(detail.status)}
              <Tag>{detail.provider}{detail.model ? ` · ${detail.model}` : ''}</Tag>
              {detail.workspace ? <Tag>{detail.workspace}{detail.branch ? ` @ ${detail.branch}` : ''}</Tag> : null}
              <Tag>{detail.turns} 轮 · 输入 {tokens(detail.inputTokens)} · 输出 {tokens(detail.outputTokens)}</Tag>
              <Typography.Text type="secondary">{detail.ownerName} · {when(detail.startedAt)} 开始 · {when(detail.updatedAt)} 更新</Typography.Text>
            </Space>
            {detail.canManage ? (
              <Flex gap={12} wrap align="center">
                <Select aria-label="归属项目" style={{ minWidth: 200 }} allowClear placeholder="选择项目" value={detail.projectId || undefined} disabled={busy}
                  options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))} onChange={value => void patch({ projectId: value || null, ...(value ? {} : { shared: false }) })} />
                <Space><Switch checked={detail.shared} disabled={busy || !detail.projectId} onChange={value => void patch({ shared: value })} />共享给项目成员</Space>
                {detail.projectId === projectId ? (
                  <Select aria-label="关联任务" style={{ minWidth: 220 }} allowClear showSearch optionFilterProp="label" placeholder="关联任务" value={detail.taskId || undefined} disabled={busy}
                    options={tasks.map(task => ({ value: task.id, label: `${task.jiraKey} ${task.title}` }))} onChange={value => void patch({ taskId: value || null })} />
                ) : detail.taskKey ? <Tag>{detail.taskKey}</Tag> : null}
              </Flex>
            ) : detail.taskId ? <Typography.Link onClick={() => openTaskRoute(detail.taskId!, { from: 'sessions' })}>关联任务 {detail.taskKey}</Typography.Link> : null}
            <div>
              <Typography.Title level={5}>目标</Typography.Title>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{detail.objective || '—'}</Typography.Paragraph>
            </div>
            <div>
              <Typography.Title level={5}>最近一轮结果</Typography.Title>
              {detail.error ? <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap' }}>{detail.error}</Typography.Paragraph> : null}
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{detail.result || (detail.error ? '' : '—')}</Typography.Paragraph>
            </div>
            <div>
              <Typography.Title level={5}>讨论（{detail.commentList.length}）</Typography.Title>
              <Flex vertical gap={8}>
                {detail.commentList.map(item => (
                  <div key={item.id}>
                    <Typography.Text strong>{item.authorName}</Typography.Text> <Typography.Text type="secondary">{when(item.createdAt)}</Typography.Text>
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '2px 0 0' }}>{item.body}</Typography.Paragraph>
                  </div>
                ))}
                {detail.shared || detail.canManage ? (
                  <Flex gap={8}>
                    <Input.TextArea aria-label="评论" autoSize={{ minRows: 1, maxRows: 6 }} maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder={detail.shared ? '补充结论、提问或指出问题' : '共享后成员才能看到评论'} />
                    <Button type="primary" disabled={!comment.trim()} loading={busy} onClick={() => void addComment()}>发送</Button>
                  </Flex>
                ) : null}
              </Flex>
            </div>
          </Flex>
        ) : null}
      </Drawer>
    </Flex>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Empty, Flex, Input, Segmented, Select, Skeleton, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { MessageSquare, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { api, ApiError, isChildTask, Project, User, WorkTask } from './workspaceApi';
import { readProjectRecords } from './readProjectRecords';
import { openTaskRoute } from './workspaceNavigation';
import { toolLabel } from './displayLabels';
import { LinkifiedText } from './MarkdownPreview';
import './LocalAiExecutionFields.css';
import './WorkspaceRecords.css';

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
type Scope = 'all' | 'mine' | 'project';
const PAGE_SIZE = 20;

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
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [shareProjectId, setShareProjectId] = useState<string>();
  const [page, setPage] = useState(1);
  const [preferredId, setPreferredId] = useState('');
  const [detailData, setDetail] = useState<AgentSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const activeScope = useRef({ projectId, scope });
  activeScope.current = { projectId, scope };
  const currentPage = Math.min(page, Math.max(1, Math.ceil(sessions.length / PAGE_SIZE)));
  const pageItems = sessions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const active = pageItems.find(item => item.id === preferredId) || pageItems[0];
  const activeId = active?.id;
  const activeUpdatedAt = active?.updatedAt;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const detail = detailData?.id === activeId ? detailData : null;
  const projectKey = (id: string | null) => !id ? '未归属' : projects.find(project => project.id === id)?.key || id;
  const projectOptions = projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }));
  const shareTarget = projectId || shareProjectId;
  const hasSharedSelection = sessions.some(item => item.shared && selected.includes(item.id));

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async (search = query) => {
    const request = ++sequence.current;
    setLoading(true);
    const read = (source: Exclude<Scope, 'all'>, id?: string) => {
      const params = new URLSearchParams({ scope: source, limit: '200' });
      if (id) params.set('projectId', id);
      if (search.trim()) params.set('q', search.trim());
      return api<{ sessions: AgentSession[]; total: number }>(`agent-sessions?${params}`);
    };
    try {
      const [mine, shared] = await Promise.all([
        scope === 'project' ? null : read('mine'),
        scope === 'mine' ? [] : readProjectRecords(projectId ? [projectId] : projects.map(project => project.id), id => read('project', id)),
      ]);
      if (request !== sequence.current) return;
      const owned = (mine?.sessions || []).filter(item => !projectId || item.projectId === projectId);
      const byId = new Map([...shared.flatMap(result => result.sessions), ...owned].map(item => [item.id, item]));
      const merged = [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      setSessions(merged);
      setTotal(scope === 'project' ? shared.reduce((count, result) => count + result.total, 0) : scope === 'mine' && !projectId ? mine!.total : merged.length);
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    setSessions([]);
    setSelected([]);
    setPreferredId('');
    setPage(1);
    void refresh();
    return () => { sequence.current += 1; };
  }, [scope, projectId, projects, user.id]);
  useEffect(() => { setShareProjectId(undefined); }, [projectId, user.id]);

  useEffect(() => { setComment(''); }, [activeId]);
  useEffect(() => {
    if (!activeId) { setDetail(null); setDetailLoading(false); return; }
    let current = true;
    setDetailLoading(true);
    void api<{ session: AgentSessionDetail }>(`agent-sessions/${activeId}`)
      .then(data => { if (current) setDetail(data.session); })
      .catch(error => { if (current) fail(error); })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [activeId, activeUpdatedAt]);

  const applyDetail = (session: AgentSessionDetail) => {
    if (activeIdRef.current === session.id) setDetail(session);
    setSessions(current => current.flatMap(item => {
      if (item.id !== session.id) return [item];
      const selectedScope = activeScope.current;
      const inScope = (!selectedScope.projectId || session.projectId === selectedScope.projectId) &&
        (selectedScope.scope === 'mine' ? session.ownerId === user.id
          : session.shared || (selectedScope.scope === 'all' && session.ownerId === user.id));
      return inScope ? [{ ...item, ...session }] : [];
    }));
  };
  const patch = async (changes: { projectId?: string | null; shared?: boolean; taskId?: string | null }) => {
    if (!detail || busy) return;
    setBusy(true);
    try { applyDetail((await api<{ session: AgentSessionDetail }>(`agent-sessions/${detail.id}`, changes, 'PATCH')).session); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const shareSelected = async (shared: boolean) => {
    if (!selected.length || busy) return;
    const targetGroups = new Map<string, string[]>();
    if (shared) {
      if (!shareTarget || !projects.some(project => project.id === shareTarget)) return;
      targetGroups.set(shareTarget, selected);
    } else {
      for (const item of sessions) {
        if (!item.shared || !item.projectId || !selected.includes(item.id)) continue;
        targetGroups.set(item.projectId, [...(targetGroups.get(item.projectId) || []), item.id]);
      }
    }
    if (!targetGroups.size) return;
    setBusy(true);
    try {
      let changed = 0;
      for (const [targetProjectId, ids] of targetGroups) {
        changed += (await api<{ changed: number }>('agent-sessions/share', { ids, projectId: targetProjectId, shared })).changed;
      }
      void message.success(shared ? `已把 ${changed} 条记录共享到 ${projectKey(shareTarget!)}。` : `已取消 ${changed} 条记录的共享。`);
      setSelected([]);
    } catch (error) { fail(error); }
    finally {
      setBusy(false);
      if (activeScope.current.projectId === projectId && activeScope.current.scope === scope) void refresh();
    }
  };
  const addComment = async () => {
    if (!detail || !comment.trim() || busy) return;
    setBusy(true);
    try { applyDetail((await api<{ session: AgentSessionDetail }>(`agent-sessions/${detail.id}/comments`, { body: comment })).session); if (activeIdRef.current === detail.id) setComment(''); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const remove = () => {
    if (!detail) return;
    modal.confirm({
      title: '删除这条 Agent 记录？', content: '只删除平台上的同步副本，本机 Delivery 里的会话不受影响；之后本机会话有更新时会重新同步。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try { await api(`agent-sessions/${detail.id}`, undefined, 'DELETE'); setSessions(current => current.filter(item => item.id !== detail.id)); setDetail(current => current?.id === detail.id ? null : current); void message.success('记录已删除。'); }
        catch (error) { fail(error); }
      },
    });
  };

  const columns: TableColumnsType<AgentSession> = [
    { title: '会话', render: (_, item) => (
      <Flex vertical gap={4}>
        <button type="button" className="tf-reading-title" aria-current={activeId === item.id || undefined} onClick={() => setPreferredId(item.id)}>{item.title}</button>
        {item.excerpt ? <Typography.Text type="secondary" ellipsis title={item.excerpt}>{item.excerpt}</Typography.Text> : null}
        <Space size={[8, 4]} wrap>
          {statusTag(item.status)}
          <code className="tf-agent-session-model" title={item.model || '模型未记录'}>{item.model || '模型未记录'}</code>
          {!projectId && <Tag>{projectKey(item.projectId)}</Tag>}
          {scope !== 'mine' && <Typography.Text type="secondary">{item.ownerName}</Typography.Text>}
          {scope === 'mine' && !!projectId && item.shared && <Typography.Text type="secondary">已共享</Typography.Text>}
          <Typography.Text type="secondary">{when(item.updatedAt)}</Typography.Text>
          {item.comments > 0 ? <Tag icon={<MessageSquare size={11} />}>{item.comments}</Tag> : null}
        </Space>
      </Flex>
    ) },
  ];

  return (
    <div className="tf-record-workspace">
      <div className="tf-record-toolbar tf-agent-sessions-toolbar">
        <div className="tf-record-filters">
          <Segmented<Scope> aria-label="记录范围" value={scope} onChange={setScope} options={[{ value: 'all', label: '全部记录' }, { value: 'mine', label: '我的记录' }, { value: 'project', label: '项目共享' }]} />
          <Input.Search aria-label="搜索会话" allowClear placeholder="搜索标题、目标或 Jira 号" value={query} onChange={event => setQuery(event.target.value)} onSearch={value => { setPage(1); void refresh(value); }} style={{ width: 'min(260px, 100%)' }} />
          <Typography.Text type="secondary">{scope === 'all' || (scope === 'mine' && projectId) ? '已读取' : '共'} {total} 条</Typography.Text>
        </div>
        <div className="tf-record-actions">
          {scope === 'mine' && selected.length ? <>
            {!projectId && <Select aria-label="共享到项目" placeholder="选择共享项目" value={shareProjectId}
              showSearch={{ optionFilterProp: 'label' }} style={{ width: 160 }} options={projectOptions} disabled={busy} onChange={setShareProjectId} />}
            <Button icon={<Share2 size={14} />} disabled={!shareTarget || busy} onClick={() => void shareSelected(true)}>共享（{selected.length}）</Button>
            <Button disabled={!hasSharedSelection || busy} onClick={() => void shareSelected(false)}>取消共享</Button>
          </> : null}
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
        </div>
      </div>
      <div className={active ? 'tf-reading-layout tf-agent-sessions-reader' : 'tf-record-table'}>
        <Table<AgentSession> rowKey="id" size="small" loading={loading} dataSource={sessions} columns={columns} tableLayout="fixed"
          scroll={active ? { y: 'clamp(150px, 34dvh, 480px)' } : undefined}
          pagination={{ current: currentPage, pageSize: PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage }}
          rowClassName={item => item.id === activeId ? 'tf-reading-selected' : ''}
          rowSelection={scope === 'mine' ? { selectedRowKeys: selected, onChange: keys => setSelected(keys as string[]) } : undefined}
          locale={{ emptyText: <Empty description={scope === 'mine'
            ? '暂无同步到个人的 Agent 记录。'
            : scope === 'project' ? '暂无成员共享的 Agent 记录。' : '暂无 Agent 记录。'} /> }} />
        {active && <Card size="small" title={<Typography.Text strong style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{active.title}</Typography.Text>}
          extra={detail?.canManage ? <Button danger icon={<Trash2 size={14} />} disabled={busy} onClick={remove}>删除</Button> : null}>
          {detail ? (
            <Flex vertical gap={16}>
              <Space size={[8, 4]} wrap>
                {statusTag(detail.status)}
                <Typography.Text type="secondary">{detail.ownerName} · {when(detail.updatedAt)} 更新</Typography.Text>
              </Space>
              <dl className="tf-agent-session-facts">
                <div><dt>执行端</dt><dd title={detail.provider}>{detail.provider ? toolLabel(detail.provider) : '未记录'}</dd></div>
                <div><dt>模型</dt><dd title={detail.model}>{detail.model ? <code>{detail.model}</code> : '未记录'}</dd></div>
                <div><dt>用量</dt><dd>{detail.turns} 轮 · {tokens(detail.inputTokens)} 入 / {tokens(detail.outputTokens)} 出</dd></div>
                <div><dt>开始时间</dt><dd>{when(detail.startedAt)}</dd></div>
                {detail.workspace && <div className="tf-agent-session-workspace">
                  <dt>工作区</dt><dd title={detail.workspace}>{detail.workspace}{detail.branch ? ` @ ${detail.branch}` : ''}</dd>
                </div>}
              </dl>
              {detail.canManage ? (
                <Flex gap={12} wrap align="center">
                  <Select aria-label="归属项目" style={{ minWidth: 200 }} allowClear placeholder="选择项目" value={detail.projectId || undefined} disabled={busy}
                    options={projectOptions} onChange={value => void patch({ projectId: value || null, ...(value ? {} : { shared: false }) })} />
                  <Space><Switch checked={detail.shared} disabled={busy || !detail.projectId} onChange={value => void patch({ shared: value })} />共享给项目成员</Space>
                  {detail.projectId && (!projectId || detail.projectId === projectId) ? (
                    <Select aria-label="关联主任务" style={{ minWidth: 220 }} allowClear showSearch={{ optionFilterProp: 'label' }} placeholder="关联主任务" value={detail.taskId || undefined} disabled={busy}
                      options={tasks.filter(task => task.projectId === detail.projectId && !isChildTask(task)).map(task => ({ value: task.id, label: `${task.jiraKey} ${task.title}` }))}
                      labelRender={({ label }) => label ?? detail.taskKey ?? '已关联任务'} onChange={value => void patch({ taskId: value || null })} />
                  ) : detail.taskKey ? <Tag>{detail.taskKey}</Tag> : null}
                </Flex>
              ) : detail.taskId ? <Typography.Link onClick={() => openTaskRoute(detail.taskId!, { from: 'sessions' })}>关联任务 {detail.taskKey}</Typography.Link> : null}
              <div>
                <Typography.Title level={5}>目标</Typography.Title>
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}><LinkifiedText text={detail.objective || '—'} /></Typography.Paragraph>
              </div>
              <div>
                <Typography.Title level={5}>最近一轮结果</Typography.Title>
                {detail.error ? <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail.error}</Typography.Paragraph> : null}
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}><LinkifiedText text={detail.result || (detail.error ? '' : '—')} /></Typography.Paragraph>
              </div>
              <div>
                <Typography.Title level={5}>讨论（{detail.commentList.length}）</Typography.Title>
                <Flex vertical gap={8}>
                  {detail.commentList.map(item => (
                    <div key={item.id}>
                      <Typography.Text strong>{item.authorName}</Typography.Text> <Typography.Text type="secondary">{when(item.createdAt)}</Typography.Text>
                      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '2px 0 0' }}><LinkifiedText text={item.body} /></Typography.Paragraph>
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
          ) : detailLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : <Typography.Paragraph>{active.excerpt}</Typography.Paragraph>}
        </Card>}
      </div>
    </div>
  );
};

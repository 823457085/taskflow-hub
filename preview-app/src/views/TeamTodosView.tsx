import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Checkbox, Drawer, Empty, Flex, Form, Input, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api, ApiError, Project, ProjectMember, User, WorkTask } from './workspaceApi';
import { openTaskRoute } from './workspaceNavigation';
import { parseQuickTodoInput } from './todoQuickParse';

export interface Todo {
  id: string; projectId: string | null; ownerId: string; assigneeId: string | null; taskId: string | null;
  title: string; details: string; dueDate: string; priority: 'normal' | 'high'; status: 'todo' | 'doing' | 'done';
  version: number; createdAt: string; updatedAt: string; canEdit: boolean; canDelete: boolean;
}
type Scope = 'mine' | 'project';
type Filter = 'open' | 'all' | 'done';
interface TodoForm { title: string; details: string; dueDate: string; priority: Todo['priority']; status: Todo['status']; projectId: string; assigneeId?: string; taskId?: string }

const STATUS_LABELS: Record<Todo['status'], string> = { todo: '待办', doing: '进行中', done: '已完成' };
const STATUS_COLORS: Record<Todo['status'], string> = { todo: 'default', doing: 'processing', done: 'success' };
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };
const sortTodos = (items: Todo[]) => [...items].sort((left, right) => Number(left.status === 'done') - Number(right.status === 'done')
  || Number(right.priority === 'high') - Number(left.priority === 'high') || (left.dueDate || '9999').localeCompare(right.dueDate || '9999') || right.updatedAt.localeCompare(left.updatedAt));

export const TeamTodosView: React.FC<{
  user: User; projects: Project[]; projectId: string; members: ProjectMember[]; tasks: WorkTask[]; canAssign: boolean; onUnauthorized: () => void;
}> = ({ user, projects, projectId, members, tasks, canAssign, onUnauthorized }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<TodoForm>();
  const [scope, setScope] = useState<Scope>('mine');
  const [filter, setFilter] = useState<Filter>('open');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [quick, setQuick] = useState('');
  const [editing, setEditing] = useState<Todo | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const formProject = Form.useWatch('projectId', form);

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    if (scope === 'project' && !projectId) { setTodos([]); return; }
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = await api<{ todos: Todo[] }>(scope === 'mine' ? 'todos?scope=mine' : `todos?scope=project&projectId=${encodeURIComponent(projectId)}`);
      if (request === sequence.current) setTodos(data.todos);
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setTodos([]); void refresh(); }, [scope, projectId, user.id]);
  useEffect(() => {
    const focused = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(focused, 30_000);
    window.addEventListener('focus', focused);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focused); };
  }, [scope, projectId]);

  const replace = (todo: Todo) => setTodos(current => [...current.filter(item => item.id !== todo.id), todo]);
  const patch = async (todo: Todo, changes: Partial<Pick<Todo, 'status' | 'assigneeId' | 'priority'>>) => {
    if (busyId) return;
    setBusyId(todo.id);
    try { replace((await api<{ todo: Todo }>(`todos/${todo.id}`, { expectedVersion: todo.version, ...changes }, 'PATCH')).todo); }
    catch (error) { fail(error); if (error instanceof ApiError && error.status === 409) void refresh(); }
    finally { setBusyId(''); }
  };
  const remove = async (todo: Todo) => {
    setBusyId(todo.id);
    try { await api(`todos/${todo.id}?expectedVersion=${todo.version}`, undefined, 'DELETE'); setTodos(current => current.filter(item => item.id !== todo.id)); void message.success('待办已删除。'); }
    catch (error) { fail(error); if (error instanceof ApiError && error.status === 409) void refresh(); }
    finally { setBusyId(''); }
  };
  const parsed = quick.trim() ? parseQuickTodoInput(quick) : null;
  const addQuick = async () => {
    if (!parsed?.title.trim() || saving) return;
    setSaving(true);
    try {
      const created = (await api<{ todo: Todo }>('todos', { title: parsed.title, details: parsed.details, dueDate: parsed.dueDate, priority: parsed.priority, ...(scope === 'project' ? { projectId } : {}) })).todo;
      replace(created); setQuick(''); void message.success(scope === 'project' ? '已添加到项目待办。' : '已添加到我的待办。');
    } catch (error) { fail(error); }
    finally { setSaving(false); }
  };
  const openEditor = (todo: Todo | 'new') => {
    setEditing(todo);
    form.setFieldsValue(todo === 'new'
      ? { title: '', details: '', dueDate: '', priority: 'normal', status: 'todo', projectId: scope === 'project' ? projectId : '', assigneeId: undefined, taskId: undefined }
      : { title: todo.title, details: todo.details, dueDate: todo.dueDate, priority: todo.priority, status: todo.status, projectId: todo.projectId || '', assigneeId: todo.assigneeId || undefined, taskId: todo.taskId || undefined });
  };
  const saveEditor = async (values: TodoForm) => {
    if (saving || !editing) return;
    setSaving(true);
    const shared = { title: values.title, details: values.details || '', dueDate: values.dueDate || '', priority: values.priority, status: values.status };
    const scoped = values.projectId && values.projectId === projectId ? { assigneeId: values.assigneeId || null, taskId: values.taskId || null } : {};
    try {
      const saved = editing === 'new'
        ? (await api<{ todo: Todo }>('todos', { ...shared, ...scoped, ...(values.projectId ? { projectId: values.projectId } : {}) })).todo
        : (await api<{ todo: Todo }>(`todos/${editing.id}`, { expectedVersion: editing.version, ...shared, ...scoped }, 'PATCH')).todo;
      const visible = scope === 'mine' ? !saved.projectId || saved.assigneeId === user.id || (!saved.assigneeId && saved.ownerId === user.id) : saved.projectId === projectId;
      if (visible) replace(saved); else setTodos(current => current.filter(item => item.id !== saved.id));
      setEditing(null); void message.success('待办已保存。');
    } catch (error) { fail(error); }
    finally { setSaving(false); }
  };
  const importFile = async (file: File) => {
    try {
      const parsedFile = JSON.parse(await file.text()) as { items?: unknown };
      if (!Array.isArray(parsedFile.items)) throw new Error('文件格式不正确：需要 Delivery 的 workspace-todos.json');
      const result = await api<{ imported: number; skipped: number }>('todos/import', { items: parsedFile.items });
      void message.success(`已导入 ${result.imported} 条到我的待办${result.skipped ? `，${result.skipped} 条之前已导入，已跳过` : ''}。`);
      if (scope === 'mine') void refresh(); else setScope('mine');
    } catch (error) { fail(error instanceof SyntaxError ? new Error('文件不是有效的 JSON') : error); }
  };

  const projectName = (id: string | null) => { if (!id) return '个人'; const project = projects.find(item => item.id === id); return project ? project.key : id; };
  const memberName = (id: string | null) => !id ? '未指派' : id === user.id ? `${user.username}（我）` : members.find(item => item.id === id)?.username || '其他成员';
  const taskLabel = (id: string | null) => { const task = tasks.find(item => item.id === id); return task ? `${task.jiraKey} · ${task.title}` : '关联任务'; };
  const visible = sortTodos(todos.filter(item => filter === 'all' || (filter === 'done' ? item.status === 'done' : item.status !== 'done')));
  const openCount = todos.filter(item => item.status !== 'done').length;
  const memberOptions = members.map(item => ({ value: item.id, label: item.id === user.id ? `${item.username}（我）` : item.username }));

  const columns: TableColumnsType<Todo> = [
    { title: '', width: 44, render: (_, item) => <Checkbox aria-label={`标记「${item.title}」${item.status === 'done' ? '未完成' : '已完成'}`} checked={item.status === 'done'} disabled={!item.canEdit || !!busyId} onChange={() => void patch(item, { status: item.status === 'done' ? 'todo' : 'done' })} /> },
    { title: '事项', render: (_, item) => <Flex vertical gap={2}>
      <Typography.Text strong delete={item.status === 'done'}>{item.title}</Typography.Text>
      {item.details && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.details}</Typography.Text>}
      {item.taskId && <Typography.Link style={{ fontSize: 12 }} onClick={() => openTaskRoute(item.taskId!)}>{taskLabel(item.taskId)}</Typography.Link>}
    </Flex> },
    ...(scope === 'mine' ? [{ title: '归属', width: 110, render: (_: unknown, item: Todo) => <Tag>{projectName(item.projectId)}</Tag> }] : []),
    { title: '优先级', width: 80, render: (_, item) => item.priority === 'high' ? <Tag color="red">高</Tag> : <Typography.Text type="secondary">普通</Typography.Text> },
    { title: '截止', width: 110, render: (_, item) => item.dueDate ? <Typography.Text type={item.status !== 'done' && item.dueDate < today() ? 'danger' : undefined}>{item.dueDate}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text> },
    { title: '状态', width: 120, render: (_, item) => item.canEdit
      ? <Select size="small" aria-label="状态" style={{ width: 100 }} value={item.status} disabled={!!busyId} options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} onChange={status => void patch(item, { status })} />
      : <Tag color={STATUS_COLORS[item.status]}>{STATUS_LABELS[item.status]}</Tag> },
    ...(scope === 'project' ? [{ title: '负责人', width: 150, render: (_: unknown, item: Todo) => item.canEdit && (canAssign || item.ownerId === user.id)
      ? <Select size="small" aria-label="负责人" allowClear placeholder="未指派" style={{ width: 130 }} value={item.assigneeId || undefined} disabled={!!busyId} options={memberOptions} onChange={value => void patch(item, { assigneeId: value || null })} />
      : <Typography.Text>{memberName(item.assigneeId)}</Typography.Text> }] : []),
    { title: '操作', width: 96, render: (_, item) => <Space size={4}>
      <Button size="small" type="text" icon={<Pencil size={14} />} aria-label="编辑" disabled={!item.canEdit} onClick={() => openEditor(item)} />
      {item.canDelete && <Popconfirm title="删除这条待办？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(item)}><Button size="small" type="text" danger icon={<Trash2 size={14} />} aria-label="删除" disabled={!!busyId} /></Popconfirm>}
    </Space> },
  ];

  return <Flex vertical gap={16}>
    <Card>
      <Flex vertical gap={12}>
        <Flex justify="space-between" gap={12} wrap>
          <Segmented<Scope> value={scope} onChange={setScope} options={[{ value: 'mine', label: '我的待办' }, { value: 'project', label: '项目待办', disabled: !projectId }]} />
          <Space wrap>
            <Segmented<Filter> value={filter} onChange={setFilter} options={[{ value: 'open', label: `未完成 ${openCount}` }, { value: 'all', label: '全部' }, { value: 'done', label: '已完成' }]} />
            <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
            <Button icon={<Upload size={15} />} onClick={() => fileInput.current?.click()}>从 Delivery 导入</Button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
          </Space>
        </Flex>
        <Flex gap={8}>
          <Input aria-label="快速添加待办" value={quick} disabled={saving} onChange={event => setQuick(event.target.value)} onPressEnter={() => void addQuick()}
            placeholder={scope === 'project' ? '添加项目待办，例：准备联调环境 @周五 !高 // 先确认测试账号' : '添加我的待办，例：整理周报 @明天 !高 // 带上本周数据'} />
          <Button type="primary" icon={<Plus size={15} />} loading={saving} disabled={!parsed?.title.trim()} onClick={() => void addQuick()}>添加</Button>
          <Button onClick={() => openEditor('new')}>详细新建</Button>
        </Flex>
        {parsed && (parsed.dueDate || parsed.priority === 'high' || parsed.details) && <Space size={6} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>将创建：</Typography.Text>
          {parsed.priority === 'high' && <Tag color="red">高优先级</Tag>}
          {parsed.dueDate && <Tag>截止 {parsed.dueDate}</Tag>}
          {parsed.details && <Tag>备注：{parsed.details}</Tag>}
        </Space>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {scope === 'mine' ? '我的待办包括个人待办，以及各项目里指派给我的待办。个人待办只有自己能看到。' : '项目待办对项目成员可见。创建人和负责人可以修改；项目负责人、PM 和管理员可以指派和改派。'}
          {' '}支持 @今天 / @周五 / @11-20 设截止日期，!高 或 p0 设高优先级，// 后写备注。
        </Typography.Text>
      </Flex>
    </Card>
    <Card>
      <Table<Todo> rowKey="id" size="middle" columns={columns} dataSource={visible} loading={loading} pagination={visible.length > 20 ? { pageSize: 20, showSizeChanger: false } : false} scroll={{ x: 760 }}
        locale={{ emptyText: <Empty description={filter === 'done' ? '还没有已完成的待办。' : '没有待办。'} /> }} />
    </Card>
    <Drawer title={editing === 'new' ? '新建待办' : '编辑待办'} size={480} open={!!editing} onClose={() => setEditing(null)} forceRender
      footer={<Flex justify="flex-end" gap={8}><Button onClick={() => setEditing(null)}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Flex>}>
      <Form form={form} layout="vertical" disabled={saving} onFinish={values => void saveEditor(values)}>
        <Form.Item label="事项" name="title" rules={[{ required: true, whitespace: true, message: '请填写待办事项。' }, { max: 200 }]}><Input maxLength={200} /></Form.Item>
        <Form.Item label="备注" name="details" rules={[{ max: 2000 }]}><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
        <Flex gap={12}>
          <Form.Item label="截止日期" name="dueDate" style={{ flex: 1 }}><Input type="date" /></Form.Item>
          <Form.Item label="优先级" name="priority" style={{ flex: 1 }}><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '高' }]} /></Form.Item>
          <Form.Item label="状态" name="status" style={{ flex: 1 }}><Select options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
        </Flex>
        <Form.Item label="归属" name="projectId" extra={editing !== 'new' ? '创建后不能更改归属。' : undefined}>
          <Select disabled={editing !== 'new'} options={[{ value: '', label: '个人（仅自己可见）' }, ...projects.map(item => ({ value: item.id, label: `${item.key} · ${item.name}`, disabled: item.id !== projectId }))]} />
        </Form.Item>
        {!!formProject && formProject === projectId && <>
          <Form.Item label="负责人" name="assigneeId" extra={canAssign ? undefined : '指派给他人需要项目负责人、PM 或管理员权限。'}>
            <Select allowClear placeholder="未指派" options={canAssign ? memberOptions : memberOptions.filter(item => item.value === user.id)} />
          </Form.Item>
          <Form.Item label="关联任务" name="taskId">
            <Select allowClear showSearch={{ optionFilterProp: 'label' }} placeholder="不关联" options={tasks.map(task => ({ value: task.id, label: `${task.jiraKey} · ${task.title}` }))} />
          </Form.Item>
        </>}
      </Form>
    </Drawer>
  </Flex>;
};

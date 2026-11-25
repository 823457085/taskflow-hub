import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Checkbox, Drawer, Empty, Flex, Form, Grid, Input, Popconfirm, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api, ApiError, isChildTask, Project, ProjectMember, User, WorkTask } from './workspaceApi';
import { readProjectRecords } from './readProjectRecords';
import { openTaskRoute } from './workspaceNavigation';
import { parseQuickTodoInput } from './todoQuickParse';
import { LinkifiedText } from './MarkdownPreview';
import './WorkspaceRecords.css';

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
  const compact = !Grid.useBreakpoint().md;
  const [form] = Form.useForm<TodoForm>();
  const [scope, setScope] = useState<Scope>('mine');
  const [filter, setFilter] = useState<Filter>('open');
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [quick, setQuick] = useState('');
  const [quickProjectId, setQuickProjectId] = useState<string>();
  const [editing, setEditing] = useState<Todo | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [formProjectMembers, setFormProjectMembers] = useState<{ id: string; members: ProjectMember[] }>();
  const sequence = useRef(0);
  const activeScope = useRef({ projectId, scope });
  activeScope.current = { projectId, scope };
  const fileInput = useRef<HTMLInputElement>(null);
  const formProject = Form.useWatch('projectId', form);
  const projectOptions = projects.map(item => ({ value: item.id, label: `${item.key} · ${item.name}` }));
  const quickTarget = scope === 'project' ? projectId || quickProjectId : undefined;

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = scope === 'mine' ? [(await api<{ todos: Todo[] }>('todos?scope=mine')).todos]
        : await readProjectRecords(projectId ? [projectId] : projects.map(project => project.id), async id =>
          (await api<{ todos: Todo[] }>(`todos?scope=project&projectId=${encodeURIComponent(id)}`)).todos);
      if (request === sequence.current) setTodos(data.flat().filter(todo => !projectId || !todo.projectId || todo.projectId === projectId));
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setTodos([]); void refresh(); return () => { sequence.current += 1; }; }, [scope, projectId, projects, user.id]);
  useEffect(() => { setEditing(null); setQuickProjectId(undefined); }, [projectId, user.id]);
  useEffect(() => {
    if (!editing || !formProject || formProject === projectId) return;
    let active = true;
    void api<{ members: ProjectMember[] }>(`projects/${encodeURIComponent(formProject)}/members`)
      .then(data => { if (active) setFormProjectMembers({ id: formProject, members: data.members }); })
      .catch(error => { if (active) fail(error); });
    return () => { active = false; };
  }, [editing, formProject, projectId, user.id]);
  useEffect(() => {
    const focused = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(focused, 30_000);
    window.addEventListener('focus', focused);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', focused); };
  }, [scope, projectId, projects]);

  const replace = (todo: Todo) => {
    const currentScope = activeScope.current;
    const matchesProject = !currentScope.projectId || !todo.projectId || todo.projectId === currentScope.projectId;
    const inScope = currentScope.scope === 'project' ? !!todo.projectId : !todo.projectId || todo.assigneeId === user.id || (!todo.assigneeId && todo.ownerId === user.id);
    setTodos(current => [...current.filter(item => item.id !== todo.id), ...(matchesProject && inScope ? [todo] : [])]);
  };
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
    if (!parsed?.title.trim() || saving || (scope === 'project' && !projects.some(project => project.id === quickTarget))) return;
    setSaving(true);
    try {
      const created = (await api<{ todo: Todo }>('todos', { title: parsed.title, details: parsed.details, dueDate: parsed.dueDate, priority: parsed.priority, ...(quickTarget ? { projectId: quickTarget } : {}) })).todo;
      replace(created); setQuick(''); void message.success(scope === 'project' ? '已添加到项目待办。' : '已添加到我的待办。');
    } catch (error) { fail(error); }
    finally { setSaving(false); }
  };
  const openEditor = (todo: Todo | 'new') => {
    setEditing(todo);
    form.setFieldsValue(todo === 'new'
      ? { title: '', details: '', dueDate: '', priority: 'normal', status: 'todo', projectId: quickTarget || '', assigneeId: undefined, taskId: undefined }
      : { title: todo.title, details: todo.details, dueDate: todo.dueDate, priority: todo.priority, status: todo.status, projectId: todo.projectId || '', assigneeId: todo.assigneeId || undefined, taskId: todo.taskId || undefined });
  };
  const saveEditor = async (values: TodoForm) => {
    if (saving || !editing || (editing === 'new' && scope === 'project' && !projects.some(project => project.id === values.projectId))) return;
    setSaving(true);
    const shared = { title: values.title, details: values.details || '', dueDate: values.dueDate || '', priority: values.priority, status: values.status };
    const targetProject = editing === 'new' ? values.projectId : editing.projectId;
    const taskId = values.taskId || null;
    const scoped = targetProject ? {
      ...(editing === 'new' || editing.ownerId === user.id || projects.find(project => project.id === targetProject)?.permissions?.assignTasks
        ? { assigneeId: values.assigneeId || null } : {}),
      ...(taskId !== (editing === 'new' ? null : editing.taskId) ? { taskId } : {}),
    } : {};
    try {
      const saved = editing === 'new'
        ? (await api<{ todo: Todo }>('todos', { ...shared, ...scoped, ...(values.projectId ? { projectId: values.projectId } : {}) })).todo
        : (await api<{ todo: Todo }>(`todos/${editing.id}`, { expectedVersion: editing.version, ...shared, ...scoped }, 'PATCH')).todo;
      replace(saved);
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
  const editorMembers = formProject === projectId ? members : formProjectMembers?.id === formProject ? formProjectMembers?.members : undefined;
  const editorCanAssign = projects.find(project => project.id === formProject)?.permissions?.assignTasks ||
    (formProject === projectId && canAssign);
  const mayChangeAssignee = editing === 'new' || editing?.ownerId === user.id || editorCanAssign;
  const assigneeOptions = (editorMembers || []).filter(item => editorCanAssign || editing !== 'new' || item.id === user.id)
    .map(item => ({ value: item.id, label: item.id === user.id ? `${item.username}（我）` : item.username }));

  const renderStatus = (item: Todo) => item.canEdit
    ? <Select size="small" aria-label="待办状态" style={{ width: 100 }} value={item.status} disabled={!!busyId} options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} onChange={status => void patch(item, { status })} />
    : <Tag color={STATUS_COLORS[item.status]}>{STATUS_LABELS[item.status]}</Tag>;
  const renderAssignee = (item: Todo) => item.canEdit && !!projectId && item.projectId === projectId && (canAssign || item.ownerId === user.id)
    ? <Select size="small" aria-label="待办负责人" allowClear placeholder="未指派" style={{ width: 110 }} value={item.assigneeId || undefined} disabled={!!busyId} options={memberOptions} onChange={value => void patch(item, { assigneeId: value || null })} />
    : <Typography.Text>{memberName(item.assigneeId)}</Typography.Text>;
  const renderActions = (item: Todo) => (
    <Space size={4}>
      {item.canEdit && <Button size="small" type="text" icon={<Pencil size={14} />} aria-label="编辑待办" onClick={() => openEditor(item)} />}
      {item.canDelete && <Popconfirm title="删除这条待办？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => remove(item)}><Button size="small" type="text" danger icon={<Trash2 size={14} />} aria-label="删除待办" disabled={!!busyId} /></Popconfirm>}
    </Space>
  );

  const columns: TableColumnsType<Todo> = [
    { title: '', width: 44, render: (_, item) => <Checkbox aria-label={`标记「${item.title}」${item.status === 'done' ? '未完成' : '已完成'}`} checked={item.status === 'done'} disabled={!item.canEdit || !!busyId} onChange={() => void patch(item, { status: item.status === 'done' ? 'todo' : 'done' })} /> },
    { title: '事项', render: (_, item) => <Flex vertical gap={4}>
      <Typography.Text strong delete={item.status === 'done'} style={{ overflowWrap: 'anywhere' }}>{item.title}</Typography.Text>
      <Space size={[8, 4]} wrap>
        {(!projectId || scope === 'mine') && <Typography.Text type="secondary">{projectName(item.projectId)}</Typography.Text>}
        {item.priority === 'high' && <Tag color="red">高优先级</Tag>}
        {item.dueDate && <Typography.Text type={item.status !== 'done' && item.dueDate < today() ? 'danger' : 'secondary'}>截止 {item.dueDate}</Typography.Text>}
        {item.taskId && <button type="button" className="tf-reading-title" onClick={() => openTaskRoute(item.taskId!, { from: 'todos' })}>{taskLabel(item.taskId)}</button>}
      </Space>
      {item.details && <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><LinkifiedText text={item.details} /></Typography.Text>}
      {compact && <Space size={[8, 4]} wrap>
        {renderStatus(item)}
        {scope === 'project' && renderAssignee(item)}
        {renderActions(item)}
      </Space>}
    </Flex> },
    ...(!compact ? [
      { title: '状态', width: 120, render: (_: unknown, item: Todo) => renderStatus(item) },
      ...(scope === 'project' ? [{ title: '负责人', width: 132, render: (_: unknown, item: Todo) => renderAssignee(item) }] : []),
      { title: '操作', width: 88, render: (_: unknown, item: Todo) => renderActions(item) },
    ] : []),
  ];

  return <div className="tf-record-workspace">
    <div className="tf-record-toolbar">
      <div className="tf-record-filters">
        <Segmented<Scope> aria-label="待办范围" value={scope} onChange={setScope} options={[{ value: 'mine', label: '我的待办' }, { value: 'project', label: '项目待办', disabled: !projects.length }]} />
        <Segmented<Filter> aria-label="待办状态" value={filter} onChange={setFilter} options={[{ value: 'open', label: `未完成 ${openCount}` }, { value: 'all', label: '全部' }, { value: 'done', label: '已完成' }]} />
      </div>
      <div className="tf-record-actions">
        <Button aria-label="刷新待办" title="刷新待办" icon={<RefreshCw size={15} />} loading={loading} onClick={() => void refresh()} />
        <Button icon={<Upload size={15} />} onClick={() => fileInput.current?.click()}>从 Delivery 导入</Button>
        <Button type="primary" icon={<Plus size={15} />} onClick={() => openEditor('new')}>新建待办</Button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
      </div>
    </div>
    <div className="tf-record-table">
      <div className={scope === 'project' && !projectId ? 'tf-record-composer tf-record-composer--project' : 'tf-record-composer'}>
        {scope === 'project' && !projectId && <Select aria-label="快速添加所属项目" value={quickProjectId}
          placeholder="选择所属项目" showSearch={{ optionFilterProp: 'label' }} options={projectOptions}
          onChange={setQuickProjectId} />}
        <Input aria-label="快速添加待办" value={quick} disabled={saving} onChange={event => setQuick(event.target.value)} onPressEnter={() => void addQuick()}
          placeholder="快速添加待办" title="支持 @日期、!高 和 // 备注" />
        <Button icon={<Plus size={15} />} loading={saving} disabled={!parsed?.title.trim() || (scope === 'project' && !quickTarget)} onClick={() => void addQuick()}>添加</Button>
        {parsed && (parsed.dueDate || parsed.priority === 'high' || parsed.details) && <div className="tf-record-composer-meta">
          {parsed.priority === 'high' && <Tag color="red">高优先级</Tag>}
          {parsed.dueDate && <Tag>截止 {parsed.dueDate}</Tag>}
          {parsed.details && <Tag title={parsed.details}>{parsed.details}</Tag>}
        </div>}
      </div>
      <Table<Todo> rowKey="id" size="small" tableLayout="fixed" columns={columns} dataSource={visible} loading={loading} pagination={visible.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === 'done' ? '暂无已完成的待办' : '暂无待办'} /> }} />
    </div>
    <Drawer title={editing === 'new' ? '新建待办' : '编辑待办'} size="min(480px, 100vw)" open={!!editing} onClose={() => setEditing(null)} forceRender
      footer={<Flex justify="flex-end" gap={8}><Button onClick={() => setEditing(null)}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Flex>}>
      <Form form={form} layout="vertical" disabled={saving} onFinish={values => void saveEditor(values)}>
        <Form.Item label="事项" name="title" rules={[{ required: true, whitespace: true, message: '请填写待办事项。' }, { max: 200 }]}><Input maxLength={200} /></Form.Item>
        <Form.Item label="备注" name="details" rules={[{ max: 2000 }]}><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
        <Flex gap={12} wrap>
          <Form.Item label="截止日期" name="dueDate" style={{ flex: 1 }}><Input type="date" /></Form.Item>
          <Form.Item label="优先级" name="priority" style={{ flex: 1 }}><Select options={[{ value: 'normal', label: '普通' }, { value: 'high', label: '高' }]} /></Form.Item>
          <Form.Item label="状态" name="status" style={{ flex: 1 }}><Select options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
        </Flex>
        <Form.Item label="归属" name="projectId" rules={editing === 'new' && scope === 'project' ? [{ required: true, message: '请选择所属项目。' }] : undefined}
          extra={editing !== 'new' ? '创建后不能更改归属。' : undefined}>
          <Select disabled={editing !== 'new'} placeholder="选择所属项目" onChange={() => form.setFieldsValue({ assigneeId: undefined, taskId: undefined })}
            options={[...(scope === 'mine' || (editing && editing !== 'new' && !editing.projectId) ? [{ value: '', label: '个人（仅自己可见）' }] : []),
              ...projectOptions.map(option => ({ ...option, disabled: !!projectId && option.value !== projectId }))]} />
        </Form.Item>
        {!!formProject && <>
          <Form.Item label="负责人" name="assigneeId" extra={editorCanAssign ? undefined : '新建时，指派给他人需要项目负责人、PM 或管理员权限。'}>
            <Select allowClear placeholder="未指派" loading={!editorMembers} disabled={!editorMembers || !mayChangeAssignee} options={assigneeOptions} />
          </Form.Item>
          <Form.Item label="关联主任务" name="taskId">
            <Select allowClear showSearch={{ optionFilterProp: 'label' }} placeholder="不关联"
              options={tasks.filter(task => task.projectId === formProject && !isChildTask(task)).map(task => ({ value: task.id, label: `${task.jiraKey} · ${task.title}` }))}
              labelRender={({ label, value }) => label ?? taskLabel(String(value))} />
          </Form.Item>
        </>}
      </Form>
    </Drawer>
  </div>;
};

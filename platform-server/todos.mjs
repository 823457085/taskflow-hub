import { randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';
import { projectPermissions } from './permissions.mjs';

const PRIORITIES = ['normal', 'high'];
const STATUSES = ['todo', 'doing', 'done'];
const EDITABLE = ['title', 'details', 'dueDate', 'priority', 'status', 'assigneeId', 'taskId'];
const IMPORT_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const known = (body, fields) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !fields.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const dueDateField = value => {
  if (value === undefined || value === '' || value === null) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail(400, 'INVALID_DUE_DATE', '请填写有效的截止日期');
  return value;
};
const enumField = (value, allowed, name, fallback) => {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) fail(400, 'INVALID_INPUT', `${name}不受支持`);
  return value;
};
const detailsField = value => value === undefined || value === '' ? '' : textField(value, 'details', { min: 0, max: 2000 });

export function createTodos({ db, transaction, audit, projectRole, visibleProjects }) {
  const iso = () => new Date().toISOString();
  // A paired device acts for its owner's own workbench: personal todos only, no delegation or task links.
  const deviceLimits = (user, body, row) => {
    if (!user.localDevice) return;
    if (body && ['projectId', 'assigneeId', 'taskId'].some(name => body[name] !== undefined)) fail(403, 'LOCAL_DEVICE_SCOPE', '本机工作台只能管理个人待办内容，项目指派请在任务中心操作');
    if (row && row.project_id && row.owner_id !== user.id && row.assignee_id !== user.id) fail(403, 'LOCAL_DEVICE_SCOPE', '本机工作台只能修改自己的待办');
  };
  const access = (user, row) => {
    if (!row.project_id) return { edit: row.owner_id === user.id, remove: row.owner_id === user.id, assign: row.owner_id === user.id };
    const permissions = projectPermissions(user, projectRole(user, row.project_id));
    const involved = row.owner_id === user.id || row.assignee_id === user.id;
    return { edit: involved || permissions.assignTasks, remove: row.owner_id === user.id || permissions.manageMembers, assign: row.owner_id === user.id || permissions.assignTasks };
  };
  const view = (user, row) => {
    const can = access(user, row);
    return {
      id: row.id, projectId: row.project_id, ownerId: row.owner_id, assigneeId: row.assignee_id, taskId: row.task_id,
      title: row.title, details: row.details, dueDate: row.due_date, priority: row.priority, status: row.status,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, canEdit: can.edit, canDelete: can.remove,
    };
  };
  const load = (user, id) => {
    const row = typeof id === 'string' && UUID.test(id) ? db.prepare('SELECT * FROM todos WHERE id=?').get(id) : null;
    if (!row || !row.project_id && row.owner_id !== user.id) fail(404, 'TODO_NOT_FOUND', '待办不存在或已删除');
    if (row.project_id) projectRole(user, row.project_id);
    return row;
  };
  const assigneeField = (projectId, value) => {
    if (value === undefined || value === null || value === '') return null;
    if (!projectId) fail(400, 'TODO_ASSIGNEE_PROJECT_REQUIRED', '个人待办不能指派给他人，请选择项目');
    const member = db.prepare('SELECT u.id,u.role FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=? WHERE u.id=? AND (m.user_id IS NOT NULL OR u.role=?)').get(projectId, textField(value, 'assigneeId', { max: 64 }), 'ADMIN');
    if (!member) fail(400, 'TODO_ASSIGNEE_INVALID', '负责人不是该项目成员');
    return member.id;
  };
  const taskField = (projectId, value) => {
    if (value === undefined || value === null || value === '') return null;
    if (!projectId) fail(400, 'TODO_TASK_PROJECT_REQUIRED', '关联任务需要选择项目');
    const task = db.prepare('SELECT id FROM tasks WHERE id=? AND project_id=?').get(textField(value, 'taskId', { max: 64 }), projectId);
    if (!task) fail(400, 'TODO_TASK_INVALID', '关联任务不存在或不属于该项目');
    return task.id;
  };

  function list(user, url) {
    const scope = url.searchParams.get('scope') || 'mine';
    if (scope === 'project') {
      const projectId = textField(url.searchParams.get('projectId'), 'projectId', { max: 64 });
      projectRole(user, projectId);
      return db.prepare('SELECT * FROM todos WHERE project_id=? ORDER BY updated_at DESC LIMIT 1000').all(projectId).map(row => view(user, row));
    }
    if (scope !== 'mine') fail(400, 'INVALID_INPUT', 'scope只能是mine或project');
    const projects = new Set(visibleProjects(user).map(project => project.id));
    return db.prepare(`SELECT * FROM todos WHERE (project_id IS NULL AND owner_id=?) OR (project_id IS NOT NULL AND (assignee_id=? OR (assignee_id IS NULL AND owner_id=?)))
      ORDER BY updated_at DESC LIMIT 1000`).all(user.id, user.id, user.id)
      .filter(row => !row.project_id || projects.has(row.project_id)).map(row => view(user, row));
  }

  function create(user, body) {
    known(body, ['projectId', ...EDITABLE]);
    deviceLimits(user, body);
    const projectId = body.projectId ? textField(body.projectId, 'projectId', { max: 64 }) : null;
    if (projectId) projectRole(user, projectId);
    const assigneeId = assigneeField(projectId, body.assigneeId);
    if (assigneeId && assigneeId !== user.id && !projectPermissions(user, projectRole(user, projectId)).assignTasks) fail(403, 'FORBIDDEN', '只有项目负责人、PM 或管理员可以把待办指派给他人');
    const row = {
      id: randomUUID(), project_id: projectId, owner_id: user.id, assignee_id: assigneeId, task_id: taskField(projectId, body.taskId),
      title: textField(body.title, 'title', { max: 200 }), details: detailsField(body.details), due_date: dueDateField(body.dueDate),
      priority: enumField(body.priority, PRIORITIES, 'priority', 'normal'), status: enumField(body.status, STATUSES, 'status', 'todo'),
      version: 1, created_at: iso(), updated_at: iso(),
    };
    transaction(() => {
      db.prepare(`INSERT INTO todos (id,project_id,owner_id,assignee_id,task_id,title,details,due_date,priority,status,version,created_at,updated_at)
        VALUES (@id,@project_id,@owner_id,@assignee_id,@task_id,@title,@details,@due_date,@priority,@status,@version,@created_at,@updated_at)`).run(row);
      audit(user.id, 'TODO_CREATE', row.id, projectId);
    });
    return view(user, row);
  }

  function update(user, id, body) {
    known(body, ['expectedVersion', ...EDITABLE]);
    const row = load(user, id);
    deviceLimits(user, body, row);
    const can = access(user, row);
    if (!can.edit) fail(403, 'FORBIDDEN', '只有创建人、负责人或项目负责人可以修改该待办');
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion');
    const next = { ...row };
    if (body.title !== undefined) next.title = textField(body.title, 'title', { max: 200 });
    if (body.details !== undefined) next.details = detailsField(body.details);
    if (body.dueDate !== undefined) next.due_date = dueDateField(body.dueDate);
    next.priority = enumField(body.priority, PRIORITIES, 'priority', row.priority);
    next.status = enumField(body.status, STATUSES, 'status', row.status);
    if (body.assigneeId !== undefined) {
      const assigneeId = assigneeField(row.project_id, body.assigneeId);
      if (assigneeId !== row.assignee_id && !can.assign) fail(403, 'FORBIDDEN', '只有创建人或项目负责人可以改派待办');
      next.assignee_id = assigneeId;
    }
    if (body.taskId !== undefined) next.task_id = taskField(row.project_id, body.taskId);
    transaction(() => {
      const changed = db.prepare(`UPDATE todos SET title=?,details=?,due_date=?,priority=?,status=?,assignee_id=?,task_id=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(next.title, next.details, next.due_date, next.priority, next.status, next.assignee_id, next.task_id, iso(), row.id, body.expectedVersion);
      if (!changed.changes) fail(409, 'TODO_CHANGED', '待办已被他人修改，请刷新后重试');
      audit(user.id, 'TODO_UPDATE', row.id, row.project_id);
    });
    return view(user, db.prepare('SELECT * FROM todos WHERE id=?').get(row.id));
  }

  function remove(user, id, url) {
    const row = load(user, id);
    if (user.localDevice && row.project_id) fail(403, 'LOCAL_DEVICE_SCOPE', '本机工作台不能删除项目待办，请在任务中心操作');
    if (!access(user, row).remove) fail(403, 'FORBIDDEN', '只有创建人或项目负责人可以删除该待办');
    const expected = Number(url.searchParams.get('expectedVersion'));
    if (!Number.isInteger(expected) || expected < 1) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion');
    transaction(() => {
      if (!db.prepare('DELETE FROM todos WHERE id=? AND version=?').run(row.id, expected).changes) fail(409, 'TODO_CHANGED', '待办已被他人修改，请刷新后重试');
      audit(user.id, 'TODO_DELETE', row.id, row.project_id);
    });
  }

  function importPersonal(user, body) {
    known(body, ['items']);
    if (!Array.isArray(body.items) || body.items.length > IMPORT_MAX) fail(400, 'INVALID_INPUT', `items需为最多${IMPORT_MAX}条的数组`);
    const rows = body.items.map(item => {
      known(item, ['id', 'title', 'details', 'dueDate', 'priority', 'status', 'createdAt', 'updatedAt']);
      if (typeof item.id !== 'string' || !UUID.test(item.id)) fail(400, 'INVALID_INPUT', '导入的待办缺少有效id');
      const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : iso();
      return {
        id: randomUUID(), owner_id: user.id, source_id: item.id, title: textField(item.title, 'title', { max: 200 }), details: detailsField(item.details),
        due_date: dueDateField(item.dueDate), priority: enumField(item.priority, PRIORITIES, 'priority', 'normal'), status: enumField(item.status, STATUSES, 'status', 'todo'),
        created_at: stamp(item.createdAt), updated_at: stamp(item.updatedAt),
      };
    });
    let imported = 0;
    transaction(() => {
      const insert = db.prepare(`INSERT OR IGNORE INTO todos (id,project_id,owner_id,assignee_id,task_id,title,details,due_date,priority,status,version,created_at,updated_at,source_id)
        VALUES (@id,NULL,@owner_id,NULL,NULL,@title,@details,@due_date,@priority,@status,1,@created_at,@updated_at,@source_id)`);
      for (const row of rows) imported += insert.run(row).changes;
      if (imported) audit(user.id, 'TODO_IMPORT', user.id, null);
    });
    return { imported, skipped: rows.length - imported };
  }

  return function handle({ method, path, url, user, body, send }) {
    if (path === '/api/todos') {
      if (method === 'GET') {
        if (user.localDevice && (url.searchParams.get('scope') || 'mine') !== 'mine') fail(403, 'LOCAL_DEVICE_SCOPE', '本机工作台只能读取自己的待办');
        send(200, { todos: list(user, url) }); return true;
      }
      if (method === 'POST') { send(201, { todo: create(user, body) }); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    if (path === '/api/todos/import') {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(200, importPersonal(user, body)); return true;
    }
    const match = path.match(/^\/api\/todos\/([^/]+)$/);
    if (!match) return false;
    if (method === 'PATCH') { send(200, { todo: update(user, match[1], body) }); return true; }
    if (method === 'DELETE') { remove(user, match[1], url); send(204); return true; }
    fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPlatform } from './server.mjs';
import { sha } from './common.mjs';

const password = 'todo-test-passphrase';

test('personal and project todos are shared by project membership with versioned edits, delegation rules and Delivery import', async () => {
  const platform = createPlatform({ dbPath: ':memory:', logger: { error: () => {} } });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => (await call('/api/login', 'POST', { username, password })).body;
  try {
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password })).status, 201);
    const admin = await login('admin');
    for (const [username, role] of [['dev', 'DEV'], ['peer', 'DEV'], ['pm-lead', 'PM']]) assert.equal((await call('/api/users', 'POST', { username, password, role }, admin.token)).status, 201);
    const outsiderProject = (await call('/api/projects', 'POST', { key: 'SECRET', name: 'Secret' }, admin.token)).body.project;
    const [dev, peer, pm] = [await login('dev'), await login('peer'), await login('pm-lead')];
    const todos = async (token, query = 'scope=mine') => (await call(`/api/todos?${query}`, 'GET', undefined, token)).body.todos;

    assert.equal((await call('/api/todos')).status, 401);
    assert.equal((await call('/api/todos', 'POST', { title: '' }, dev.token)).status, 400);
    assert.equal((await call('/api/todos', 'POST', { title: 'x', dueDate: '2026-02-30' }, dev.token)).body.error.code, 'INVALID_DUE_DATE');
    assert.equal((await call('/api/todos', 'POST', { title: 'x', ownerId: peer.user.id }, dev.token)).status, 400);
    assert.equal((await call('/api/todos', 'POST', { title: 'x', assigneeId: peer.user.id }, dev.token)).body.error.code, 'TODO_ASSIGNEE_PROJECT_REQUIRED');
    assert.equal((await call('/api/todos', 'POST', { title: 'x', projectId: outsiderProject.id }, dev.token)).status, 403);

    const personal = (await call('/api/todos', 'POST', { title: '整理周报', priority: 'high', dueDate: '2026-11-20' }, dev.token)).body.todo;
    assert.deepEqual({ projectId: personal.projectId, ownerId: personal.ownerId, version: personal.version, canEdit: personal.canEdit }, { projectId: null, ownerId: dev.user.id, version: 1, canEdit: true });
    assert.equal((await call(`/api/todos/${personal.id}`, 'PATCH', { expectedVersion: 1, status: 'done' }, peer.token)).status, 404);
    assert.deepEqual(await todos(peer.token), []);

    assert.equal((await call('/api/todos', 'POST', { title: '联调', projectId: 'default', assigneeId: peer.user.id }, dev.token)).status, 403);
    const task = (await call('/api/tasks', 'POST', { jiraKey: 'TODO-1', title: 'todo task' }, dev.token)).body.task;
    const shared = (await call('/api/todos', 'POST', { title: '准备联调环境', projectId: 'default', assigneeId: peer.user.id, taskId: task.id }, pm.token)).body.todo;
    assert.equal(shared.assigneeId, peer.user.id);
    assert.equal(shared.taskId, task.id);
    assert.equal((await call('/api/todos', 'POST', { title: 'x', projectId: 'default', assigneeId: randomUUID() }, pm.token)).body.error.code, 'TODO_ASSIGNEE_INVALID');

    assert.deepEqual((await todos(peer.token)).map(item => item.id), [shared.id]);
    assert.deepEqual((await todos(dev.token)).map(item => item.id), [personal.id]);
    const projectView = await todos(dev.token, 'scope=project&projectId=default');
    assert.deepEqual(projectView.map(item => [item.id, item.canEdit, item.canDelete]), [[shared.id, false, false]]);
    assert.equal((await call(`/api/todos?scope=project&projectId=${outsiderProject.id}`, 'GET', undefined, dev.token)).status, 403);

    assert.equal((await call(`/api/todos/${shared.id}`, 'PATCH', { expectedVersion: 1, status: 'doing' }, dev.token)).status, 403);
    const doing = (await call(`/api/todos/${shared.id}`, 'PATCH', { expectedVersion: 1, status: 'doing' }, peer.token)).body.todo;
    assert.equal(doing.version, 2);
    assert.equal((await call(`/api/todos/${shared.id}`, 'PATCH', { expectedVersion: 1, status: 'done' }, peer.token)).body.error.code, 'TODO_CHANGED');
    assert.equal((await call(`/api/todos/${shared.id}`, 'PATCH', { expectedVersion: 2, assigneeId: dev.user.id }, peer.token)).status, 403);
    assert.equal((await call(`/api/todos/${shared.id}`, 'DELETE', undefined, peer.token)).status, 403);
    const reassigned = (await call(`/api/todos/${shared.id}`, 'PATCH', { expectedVersion: 2, assigneeId: dev.user.id }, pm.token)).body.todo;
    assert.equal(reassigned.assigneeId, dev.user.id);
    assert.ok((await todos(dev.token)).some(item => item.id === shared.id));
    assert.equal((await call(`/api/todos/${shared.id}?expectedVersion=2`, 'DELETE', undefined, admin.token)).body.error.code, 'TODO_CHANGED');
    assert.equal((await call(`/api/todos/${shared.id}?expectedVersion=3`, 'DELETE', undefined, admin.token)).status, 204);
    assert.equal((await call(`/api/todos/${shared.id}`, 'PATCH', { expectedVersion: 3, status: 'done' }, pm.token)).status, 404);

    const exported = { version: 1, items: [
      { id: randomUUID(), title: 'app 支付链路 埋点', details: '', dueDate: '2026-11-20', priority: 'normal', status: 'todo', createdAt: '2026-11-05T14:18:14.900Z', updatedAt: '2026-11-05T14:18:14.900Z' },
      { id: randomUUID(), title: '已完成事项', details: '备注', dueDate: '', priority: 'high', status: 'done', createdAt: '2026-11-06T01:00:00.000Z', updatedAt: '2026-11-06T02:00:00.000Z' },
    ] };
    assert.deepEqual((await call('/api/todos/import', 'POST', { items: exported.items }, dev.token)).body, { imported: 2, skipped: 0 });
    assert.deepEqual((await call('/api/todos/import', 'POST', { items: exported.items }, dev.token)).body, { imported: 0, skipped: 2 });
    assert.deepEqual((await call('/api/todos/import', 'POST', { items: exported.items }, peer.token)).body, { imported: 2, skipped: 0 });
    assert.equal((await call('/api/todos/import', 'POST', { items: [{ ...exported.items[0], id: 'not-a-uuid' }] }, dev.token)).status, 400);
    const mine = await todos(dev.token);
    assert.equal(mine.length, 3);
    assert.equal(mine.find(item => item.title === '已完成事项').createdAt, '2026-11-06T01:00:00.000Z');

    const audit = (await call('/api/audit', 'GET', undefined, admin.token)).body.audit.map(row => row.action);
    for (const action of ['TODO_CREATE', 'TODO_UPDATE', 'TODO_DELETE', 'TODO_IMPORT']) assert.ok(audit.includes(action), action);
  } finally { await platform.close(); }
});

test('a paired device manages only its owner personal todos for the local workbench', async () => {
  const platform = createPlatform({ dbPath: ':memory:', logger: { error: () => {} } });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => (await call('/api/login', 'POST', { username, password })).body;
  const pairDevice = userId => {
    const token = randomBytes(32).toString('base64url'); const expires = Date.now() + 3_600_000;
    platform.db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
    platform.db.prepare('INSERT INTO local_device_sessions (id,token_hash,user_id,device_name,tool,project_ids,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), sha(token), userId, 'test-mac', 'codex-cli', '["default"]', expires, new Date().toISOString());
    return token;
  };
  try {
    await call('/api/setup', 'POST', { username: 'admin', password });
    const admin = await login('admin');
    for (const username of ['dev', 'peer']) await call('/api/users', 'POST', { username, password, role: 'DEV' }, admin.token);
    const [dev, peer] = [await login('dev'), await login('peer')];
    const device = pairDevice(dev.user.id);
    const peerTodo = (await call('/api/todos', 'POST', { title: 'peer 私事' }, peer.token)).body.todo;
    const project = (await call('/api/todos', 'POST', { title: '项目事项', projectId: 'default', assigneeId: dev.user.id }, admin.token)).body.todo;

    const created = (await call('/api/todos', 'POST', { title: '本机新建', priority: 'high' }, device)).body.todo;
    assert.deepEqual({ projectId: created.projectId, ownerId: created.ownerId }, { projectId: null, ownerId: dev.user.id });
    assert.equal((await call('/api/todos', 'POST', { title: 'x', projectId: 'default' }, device)).body.error.code, 'LOCAL_DEVICE_SCOPE');
    assert.equal((await call('/api/todos?scope=project&projectId=default', 'GET', undefined, device)).status, 403);
    assert.deepEqual((await call('/api/todos', 'GET', undefined, device)).body.todos.map(item => item.id).sort(), [created.id, project.id].sort());

    assert.equal((await call(`/api/todos/${peerTodo.id}`, 'PATCH', { expectedVersion: 1, status: 'done' }, device)).status, 404);
    assert.equal((await call(`/api/todos/${created.id}`, 'PATCH', { expectedVersion: 1, assigneeId: peer.user.id }, device)).body.error.code, 'LOCAL_DEVICE_SCOPE');
    assert.equal((await call(`/api/todos/${created.id}`, 'PATCH', { expectedVersion: 1, status: 'done' }, device)).body.todo.version, 2);
    assert.equal((await call(`/api/todos/${project.id}`, 'PATCH', { expectedVersion: 1, status: 'doing' }, device)).body.todo.status, 'doing');
    assert.equal((await call(`/api/todos/${project.id}?expectedVersion=2`, 'DELETE', undefined, device)).body.error.code, 'LOCAL_DEVICE_SCOPE');
    assert.equal((await call(`/api/todos/${created.id}?expectedVersion=2`, 'DELETE', undefined, device)).status, 204);

    const items = [{ id: randomUUID(), title: '旧待办', details: '', dueDate: '', priority: 'normal', status: 'todo', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }];
    assert.deepEqual((await call('/api/todos/import', 'POST', { items }, device)).body, { imported: 1, skipped: 0 });
    assert.deepEqual((await call('/api/todos/import', 'POST', { items }, device)).body, { imported: 0, skipped: 1 });
  } finally { await platform.close(); }
});

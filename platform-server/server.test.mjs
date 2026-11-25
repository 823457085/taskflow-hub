import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, runtimeOptions } from './server.mjs';
const password = 'local-only-test-passphrase';
test('runtime binding ignores inherited workspace PORT and HOST', () => {
  const instanceOptions = port => ({ apiUrl: `http://127.0.0.1:${port}`, envDir: '/var/lib/taskflow/wb-env', stateRoot: '/var/lib/taskflow-wb', maxSlots: 8 });
  const workbench = { workbenchHost: '', workbenchPort: 5189, publicOrigin: '', workbenchMode: 'relay', workbenchInstanceOptions: instanceOptions(5187) };
  const local = { deployment: 'local', trustProxy: false, cookieSecure: false, deviceSessionMs: undefined, bridgeModes: ['read', 'review'], ...workbench };
  assert.deepEqual(runtimeOptions({ PORT: '5288', HOST: '0.0.0.0' }), { port: 5187, host: '127.0.0.1', ...local });
  assert.deepEqual(runtimeOptions({ PORT: '5288', TASKFLOW_PORT: '5190', TASKFLOW_HOST: '127.0.0.2' }), { port: 5190, host: '127.0.0.2', ...local, workbenchInstanceOptions: instanceOptions(5190) });
  assert.equal(runtimeOptions({ TASKFLOW_WORKBENCH_MODE: 'server' }).workbenchMode, 'server');
  assert.throws(() => runtimeOptions({ TASKFLOW_WORKBENCH_MODE: 'cloud' }), /TASKFLOW_WORKBENCH_MODE/);
  assert.throws(() => runtimeOptions({ TASKFLOW_PORT: '0' }), /TASKFLOW_PORT/);
  assert.deepEqual(runtimeOptions({ TASKFLOW_DEPLOYMENT: 'server', TASKFLOW_TRUST_PROXY: '1', TASKFLOW_DEVICE_SESSION_HOURS: '168' }),
    { port: 5187, host: '127.0.0.1', deployment: 'server', trustProxy: true, cookieSecure: true, deviceSessionMs: 168 * 3_600_000, bridgeModes: ['read', 'review'], ...workbench });
  assert.deepEqual(runtimeOptions({ TASKFLOW_BRIDGE_MODES: 'read, review,develop' }).bridgeModes, ['read', 'review', 'develop']);
  assert.throws(() => runtimeOptions({ TASKFLOW_BRIDGE_MODES: 'read,shell' }), /TASKFLOW_BRIDGE_MODES/);
  assert.deepEqual(runtimeOptions({ TASKFLOW_WORKBENCH_HOST: 'wb.example.com', TASKFLOW_PUBLIC_ORIGIN: 'https://hub.example.com' }).workbenchHost, 'wb.example.com');
  assert.throws(() => runtimeOptions({ TASKFLOW_WORKBENCH_HOST: 'wb.example.com' }), /TASKFLOW_PUBLIC_ORIGIN/);
  const sharedIp = { TASKFLOW_WORKBENCH_HOST: '192.0.2.1:8443', TASKFLOW_PUBLIC_ORIGIN: 'https://192.0.2.1' };
  assert.equal(runtimeOptions(sharedIp).workbenchHost, '192.0.2.1:8443');
  assert.throws(() => runtimeOptions({ ...sharedIp, TASKFLOW_WORKBENCH_HOST: '192.0.2.1:65536' }), /TASKFLOW_WORKBENCH_HOST port/);
  assert.throws(() => runtimeOptions({ ...sharedIp, TASKFLOW_WORKBENCH_HOST: '192.0.2.1:443' }), /different origins/);
  assert.equal(runtimeOptions({ TASKFLOW_DEPLOYMENT: 'server', TASKFLOW_COOKIE_SECURE: '0' }).cookieSecure, false);
  assert.throws(() => runtimeOptions({ TASKFLOW_DEPLOYMENT: 'cloud' }), /TASKFLOW_DEPLOYMENT/);
  assert.throws(() => runtimeOptions({ TASKFLOW_DEVICE_SESSION_HOURS: '0' }), /TASKFLOW_DEVICE_SESSION_HOURS/);
});
test('HTTP authentication, role boundaries, tracked work and persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-test-'));
  const dbPath = join(dir, 'platform.sqlite');
  const logs = []; let platform;
  async function start() {
    platform = createPlatform({ dbPath, logger: { error: (...args) => logs.push(args.join(' ')) } });
    await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${platform.server.address().port}`;
  }
  let base = await start();
  const call = async (path, method = 'GET', body, token, extraHeaders = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? undefined : await response.json() };
  };
  try {
    assert.equal((await call('/health')).body.status, 'ok');
    assert.equal((await call('/api/tasks')).status, 401);
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password: 'short' })).status, 400);
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password })).status, 201);
    assert.equal((await call('/api/setup', 'POST', { username: 'second', password })).status, 409);
    assert.equal((await call('/api/login', 'POST', { username: 'admin', password: 'wrong-password' })).status, 401);
    const login = await call('/api/login', 'POST', { username: 'admin', password });
    assert.equal(login.status, 200); const adminToken = login.body.token;
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const me = await call('/api/me', 'GET', undefined, undefined, { Cookie: login.headers.get('set-cookie').split(';')[0] });
    assert.equal(me.body.user.role, 'ADMIN');
    assert.deepEqual(me.body.workbench, { enabled: false, mode: null });
    assert.equal((await call('/api/users', 'POST', { username: 'developer', password, role: 'DEV' }, adminToken)).status, 201);
    assert.equal((await call('/api/users', 'POST', { username: 'quality', password, role: 'QA' }, adminToken)).status, 201);
    const dev = (await call('/api/login', 'POST', { username: 'developer', password })).body;
    const qa = (await call('/api/login', 'POST', { username: 'quality', password })).body;
    assert.equal((await call('/api/users', 'POST', { username: 'fakeadmin', password, role: 'ADMIN' }, dev.token, { 'X-Role': 'ADMIN' })).status, 403);
    assert.equal((await call('/api/audit', 'GET', undefined, dev.token)).status, 403);
    assert.equal((await call('/api/tasks', 'POST', { jiraKey: 'invalid', title: 'test' }, adminToken)).status, 400);
    const created = await call('/api/tasks', 'POST', { jiraKey: 'TEST-1', title: 'Local tracked task' }, dev.token);
    assert.equal(created.status, 201); const task = created.body.task;
    assert.equal(task.jiraStatus, 'unverified');
    assert.equal((await call('/api/tasks', 'POST', { jiraKey: 'TEST-1', title: 'Duplicate' }, dev.token)).status, 409);
    const progress = { tool: 'codex-cli', deviceId: 'test-device', progress: 50, summary: 'Implemented local checks', branch: 'feature/TEST-1', actorId: 'forged-actor' };
    assert.equal((await call(`/api/tasks/${task.id}/progress`, 'POST', progress, qa.token)).status, 403);
    assert.equal((await call(`/api/tasks/${task.id}/progress`, 'POST', { ...progress, progress: 101 }, dev.token)).status, 400);
    const reported = await call(`/api/tasks/${task.id}/progress`, 'POST', progress, dev.token);
    assert.equal(reported.status, 201); assert.equal(reported.body.progress.actorId, dev.user.id); assert.equal(reported.body.progress.source, 'self_reported');
    const context = await call(`/api/tasks/${task.id}/context`, 'GET', undefined, qa.token);
    assert.equal(context.body.task.progress, 50); assert.equal(context.body.integrationStatus, 'UNCONFIGURED'); assert.deepEqual(context.body.assets, []);
    assert.equal((await call('/api/reviews', 'POST', { taskId: task.id, stage: 'RELEASE' }, qa.token)).status, 403);
    assert.equal((await call('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW' }, qa.token)).status, 403);
    assert.equal((await call('/api/reviews', 'POST', { taskId: task.id, stage: 'RELEASE' }, dev.token)).status, 409);
    assert.equal((await call('/api/reviews', 'POST', { taskId: task.id, stage: 'TEST_CASE' }, dev.token)).status, 409);
    assert.equal((await call('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW' }, dev.token)).status, 409);
    const review = await call('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'CLOUD_AI' }, dev.token);
    assert.equal(review.status, 201); assert.equal(review.body.job.status, 'AWAITING_CONFIGURATION');
    assert.equal(review.body.job.persona, 'ai-reviewer'); assert.equal(review.body.job.executor, 'UNCONFIGURED'); assert.ok(review.body.job.skills.includes('cross-repo-contract-diff'));
    const retry = await call('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'CLOUD_AI' }, dev.token);
    assert.equal(retry.status, 200); assert.equal(retry.body.job.id, review.body.job.id);
    assert.equal((await call('/api/reviews', 'POST', { taskId: 'missing', stage: 'TEST_CASE' }, qa.token)).status, 404);
    const manifest = { id: 'contract-audit', name: 'Contract audit', version: '1.0.0', stages: ['CODE_REVIEW'], command: 'must-not-be-stored' };
    assert.equal((await call('/api/plugins', 'POST', manifest, dev.token)).status, 403);
    assert.equal((await call('/api/plugins', 'POST', { ...manifest, id: '../bad' }, adminToken)).status, 400);
    const plugin = await call('/api/plugins', 'POST', manifest, adminToken);
    assert.equal(plugin.status, 201); assert.equal(plugin.body.plugin.status, 'REGISTERED_NOT_EXECUTABLE'); assert.equal(plugin.body.plugin.command, undefined);
    const connectors = await call('/api/connectors', 'GET', undefined, adminToken);
    assert.deepEqual(connectors.body.connectors.map(connector => connector.provider).sort(), ['confluence', 'github', 'gitlab', 'jenkins', 'jira', 'yunxiao']);
    assert.ok(connectors.body.connectors.every(c => c.status === 'UNCONFIGURED'));
    assert.equal((await call('/api/tasks', 'POST', { jiraKey: 'TEST-2', title: 'cross origin' }, adminToken, { Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await call('/api/tasks', 'POST', { jiraKey: 'TEST-2', title: 'x'.repeat(200_000) }, adminToken)).status, 413);
    const audit = await call('/api/audit', 'GET', undefined, adminToken); const serializedAudit = JSON.stringify(audit.body);
    assert.ok(!serializedAudit.includes(password)); assert.ok(!serializedAudit.includes(adminToken)); assert.ok(audit.body.audit.some(a => a.action === 'PROGRESS_REPORT' && a.actorId === dev.user.id));
    assert.notEqual(platform.db.prepare('SELECT * FROM users WHERE username=?').get('admin').hash, password);
    assert.ok(platform.db.prepare('SELECT token_hash FROM sessions').all().every(s => s.token_hash !== adminToken));
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    assert.equal((await call('/api/logout', 'POST', undefined, dev.token)).status, 204); assert.equal((await call('/api/me', 'GET', undefined, dev.token)).status, 401);
    await platform.close(); base = await start();
    assert.equal((await call('/api/tasks', 'GET', undefined, adminToken)).body.tasks[0].progress, 50);
    assert.equal((await call('/api/jobs', 'GET', undefined, adminToken)).body.jobs.length, 1);
    assert.equal((await call('/api/plugins', 'GET', undefined, adminToken)).body.plugins.length, 1);
    assert.equal(logs.length, 0);
  } finally { await platform.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('DELETE /api/projects/:id enforces RBAC, protects default, guards non-empty projects, and cascades cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-proj-del-'));
  const dbPath = join(dir, 'platform.sqlite');
  const platform = createPlatform({ dbPath, logger: { error: () => {} } });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token, extraHeaders = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? undefined : await response.json() };
  };
  try {
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password })).status, 201);
    const adminLogin = await call('/api/login', 'POST', { username: 'admin', password });
    const adminToken = adminLogin.body.token;
    const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/users', 'POST', { username: 'dev1', password, role: 'DEV' }, adminToken)).status, 201);
    const devLogin = await call('/api/login', 'POST', { username: 'dev1', password });
    const devToken = devLogin.body.token;
    const devUserId = devLogin.body.user.id;

    // 1. Default project cannot be deleted
    const delDefault = await call('/api/projects/default', 'DELETE', undefined, adminToken);
    assert.equal(delDefault.status, 409);
    assert.equal(delDefault.body.error.code, 'DEFAULT_PROJECT_PROTECTED');

    // 2. Create an empty drill project, add dev1 as DEV
    const emptyProjRes = await call('/api/projects', 'POST', { key: 'DRILL1', name: 'Empty Drill' }, adminToken);
    assert.equal(emptyProjRes.status, 201);
    const emptyProjId = emptyProjRes.body.project.id;
    assert.equal((await call(`/api/projects/${emptyProjId}/members`, 'POST', { userId: devUserId, role: 'DEV' }, adminToken)).status, 200);

    // DEV cannot delete project
    assert.equal((await call(`/api/projects/${emptyProjId}`, 'DELETE', undefined, devToken)).status, 403);
    // Cookie DELETE without Origin header is rejected
    const noOrigin = await call(`/api/projects/${emptyProjId}`, 'DELETE', undefined, undefined, { Cookie: adminCookie });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.body.error.code, 'ORIGIN_REQUIRED');
    // Cookie DELETE with matching Origin succeeds for empty project
    const delEmpty = await call(`/api/projects/${emptyProjId}`, 'DELETE', undefined, undefined, { Cookie: adminCookie, Origin: base });
    assert.equal(delEmpty.status, 200);
    assert.equal(delEmpty.body.deletedKey, 'DRILL1');
    assert.equal(delEmpty.body.deletedTasks, 0);
    const afterEmpty = await call('/api/projects', 'GET', undefined, adminToken);
    assert.ok(!afterEmpty.body.projects.some(p => p.id === emptyProjId));

    // 3. Create a populated project with task, asset, review job, plugin, workspace, and linked todo
    const fullProjRes = await call('/api/projects', 'POST', { key: 'DRILL2', name: 'Populated Drill' }, adminToken);
    assert.equal(fullProjRes.status, 201);
    const fullProjId = fullProjRes.body.project.id;
    const taskRes = await call('/api/tasks', 'POST', { projectId: fullProjId, jiraKey: 'DRILL2-1', title: 'Drill task' }, adminToken);
    assert.equal(taskRes.status, 201);
    const taskId = taskRes.body.task.id;
    assert.equal((await call(`/api/tasks/${taskId}/assets`, 'POST', { kind: 'PRD', logicalKey: 'prd', title: 'PRD', content: 'PRD body' }, adminToken)).status, 201);
    assert.equal((await call('/api/reviews', 'POST', { taskId, stage: 'PRD' }, adminToken)).status, 201);
    assert.equal((await call('/api/plugins', 'POST', { id: 'drill-plugin', projectId: fullProjId, name: 'Drill', version: '1.0.0', stages: ['PRD'] }, adminToken)).status, 201);
    assert.equal((await call(`/api/projects/${fullProjId}/workspace`, 'PUT', { repoPath: dir, defaultTarget: 'workbench' }, adminToken)).status, 200);
    const todoRes = await call('/api/todos', 'POST', { projectId: fullProjId, taskId, title: 'Keep my personal todo' }, adminToken);
    assert.equal(todoRes.status, 201);
    const todoId = todoRes.body.todo.id;

    // Non-empty project requires ?cascade=1
    const blockedDel = await call(`/api/projects/${fullProjId}`, 'DELETE', undefined, adminToken);
    assert.equal(blockedDel.status, 409);
    assert.equal(blockedDel.body.error.code, 'PROJECT_HAS_TASKS');

    // Cascade delete succeeds with zero FK violations, detaches personal todo, and writes audit
    const cascaded = await call(`/api/projects/${fullProjId}?cascade=1`, 'DELETE', undefined, adminToken);
    assert.equal(cascaded.status, 200);
    assert.equal(cascaded.body.deletedKey, 'DRILL2');
    assert.equal(cascaded.body.deletedTasks, 1);

    const remainingProjects = await call('/api/projects', 'GET', undefined, adminToken);
    assert.ok(!remainingProjects.body.projects.some(p => p.id === fullProjId));
    const todoRow = platform.db.prepare('SELECT project_id, task_id FROM todos WHERE id=?').get(todoId);
    assert.equal(todoRow.project_id, null);
    assert.equal(todoRow.task_id, null);
    const auditRow = platform.db.prepare("SELECT action, target_id FROM audit WHERE action='PROJECT_DELETE' AND target_id=?").get('DRILL2');
    assert.equal(auditRow?.action, 'PROJECT_DELETE');
  } finally {
    await platform.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

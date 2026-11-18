import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createPlatform } from './server.mjs';
import { TOOLS } from './common.mjs';
import { TOOLS as CLI_TOOLS } from '../local-bridge/rd.mjs';

test('custom client pairs and collaborates within current project and device permissions', async t => {
  const app = createPlatform({ dbPath: ':memory:', logger: { error() {} } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { body, bearer, cookie, origin, method = body ? 'POST' : 'GET' } = {}, status = 200, code) => {
    const response = await fetch(base + path, { method, headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: base } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, `${path}: expected ${status}, got ${response.status}`);
    if (code) assert.equal(data.error.code, code);
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = randomBytes(24).toString('base64url');
  await request('/api/setup', { body: { username: 'custom-admin', password } }, 201);
  const { data: admin } = await request('/api/login', { body: { username: 'custom-admin', password } });
  await request('/api/users', { bearer: admin.token, body: { username: 'custom-member', password, role: 'DEV' } }, 201);
  const { data: member, cookie } = await request('/api/login', { body: { username: 'custom-member', password } });
  const { data: { project: other } } = await request('/api/projects', { bearer: admin.token, body: { key: 'HIDDEN', name: 'Unconsented project' } }, 201);
  const { data: { task } } = await request('/api/tasks', { bearer: admin.token, body: { jiraKey: 'CUSTOM-1', title: 'Custom client work', assigneeId: null } }, 201);
  const { data: { task: hidden } } = await request('/api/tasks', { bearer: admin.token, body: { projectId: other.id, jiraKey: 'HIDDEN-1', title: 'Hidden work' } }, 201);
  const { data: pair } = await request('/api/device-authorizations', { body: { deviceName: '我的工作台', tool: 'custom' } }, 201);
  const approval = { userCode: pair.userCode, decision: 'APPROVE', projectIds: ['default'] };
  await request('/api/device-authorizations/decision', { bearer: member.token, origin: true, body: approval }, 403, 'BROWSER_SESSION_REQUIRED');
  await request('/api/device-authorizations/decision', { cookie, body: approval }, 403, 'BROWSER_SESSION_REQUIRED');
  await request('/api/device-authorizations/decision', { cookie, origin: true, body: { ...approval, projectIds: [] } }, 400, 'PROJECT_SCOPE_REQUIRED');
  await request('/api/device-authorizations/decision', { cookie, origin: true, body: approval });
  const { data: device } = await request('/api/device-authorizations/poll', { body: { deviceCode: pair.deviceCode } });
  const local = { bearer: device.token };
  const { data: me } = await request('/api/me', local);
  assert.equal(me.authorization.kind, 'LOCAL_DEVICE');
  assert.ok(Object.values(me.permissions).every(value => value === false));
  assert.deepEqual((await request('/api/tasks', local)).data.tasks.map(item => item.id), [task.id]);
  const claimed = (await request(`/api/tasks/${task.id}/claim`, { ...local, body: { expectedVersion: task.version } })).data.task;
  assert.equal(claimed.assigneeId, member.user.id);
  const progress = (await request(`/api/tasks/${task.id}/progress`, { ...local, body: { deviceId: device.deviceId, tool: 'custom', progress: 45, summary: 'L123 原样保留', branch: 'feature/custom-client' } }, 201)).data.progress;
  assert.equal(progress.tool, 'custom'); assert.equal(progress.source, 'self_reported'); assert.equal(progress.summary, 'L123 原样保留');
  const beat = (await request(`/api/tasks/${task.id}/heartbeat`, { ...local, body: { deviceId: device.deviceId, tool: 'custom', status: 'WORKING' } })).data.device;
  assert.equal(beat.tool, 'custom'); assert.equal(beat.actorId, member.user.id);
  await request(`/api/tasks/${task.id}/heartbeat`, { ...local, body: { deviceId: 'forged', tool: 'custom', status: 'WORKING' } }, 403, 'DEVICE_ID_MISMATCH');
  for (const kind of ['PRD', 'TECH_SPEC', 'CODE']) await request(`/api/tasks/${task.id}/assets`, { bearer: admin.token, body: { kind, title: kind, content: `Original ${kind}` } }, 201);
  const review = async () => (await request('/api/reviews', { bearer: admin.token, body: { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'LOCAL_REPORT' } }, 201)).data.job;
  const job = await review();
  const report = { source: 'LOCAL_TOOL', tool: 'custom', summary: 'L456 自定义客户端报告原文', findings: [] };
  const submitted = (await request(`/api/jobs/${job.id}/report`, { ...local, body: report }, 201)).data.job;
  assert.equal(submitted.report.tool, 'custom'); assert.equal(submitted.report.actorId, member.user.id);
  assert.equal(submitted.report.summary, report.summary); assert.equal(submitted.executor, 'UNCONFIGURED'); assert.equal(submitted.decision, null);
  for (const [method, path, body] of [
    ['GET', '/api/users'], ['GET', '/api/projects/default/members'], ['POST', '/api/projects/default/members', {}],
    ['GET', '/api/connectors'], ['POST', '/api/plugins', {}], ['GET', '/api/audit'],
    ['POST', `/api/jobs/${job.id}/decision`, { decision: 'APPROVE' }], ['POST', `/api/jobs/${job.id}/findings/fake/waiver`, { reason: 'forged' }],
  ]) await request(path, { ...local, method, body }, 403, 'LOCAL_DEVICE_SCOPE');
  for (const suffix of ['', '/context', '/assets']) await request(`/api/tasks/${hidden.id}${suffix}`, local, 403, 'LOCAL_DEVICE_PROJECT_SCOPE');
  await request(`/api/tasks?projectId=${other.id}`, local, 403, 'LOCAL_DEVICE_PROJECT_SCOPE');
  const nextJob = await review();
  app.db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?').run('QA', 'default', member.user.id);
  await request(`/api/jobs/${nextJob.id}/report`, { ...local, body: report }, 403, 'FORBIDDEN');
  app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run('default', member.user.id);
  assert.deepEqual((await request('/api/tasks', local)).data.tasks, []);
  await request(`/api/tasks/${task.id}/context`, local, 403, 'PROJECT_FORBIDDEN');
});

test('custom is a fixed source alongside legacy clients, not an arbitrary plugin executable', async t => {
  assert.deepEqual(TOOLS, ['codex', 'codex-cli', 'claude-code', 'cursor', 'antigravity', 'custom']);
  assert.deepEqual(CLI_TOOLS, TOOLS);
  const app = createPlatform({ dbPath: ':memory:', logger: { error() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const pair = body => fetch(base + '/api/device-authorizations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const tool of TOOLS) assert.equal((await pair({ deviceName: 'Compatibility fixture', tool })).status, 201);
  assert.equal((await pair({ deviceName: 'Invalid source', tool: 'arbitrary-plugin' })).status, 400);
  assert.equal((await pair({ deviceName: 'Injected executable', tool: 'custom', command: 'arbitrary-command' })).status, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM local_authorizations').get().n, TOOLS.length);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform } from './server.mjs';
const password = 'isolated-workspace-index-test-passphrase';
const bodyMarker = 'DO_NOT_RETURN_ASSET_BODY_99172';
async function fixture() {
  const app = createPlatform({ dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, token, cookie, origin } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: base } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  const expect = async (path, options, status = 200) => { const result = await request(path, options); assert.equal(result.status, status, `${path}: expected ${status}, got ${result.status}`); return result.data; };
  await expect('/api/setup', { method: 'POST', body: { username: 'administrator', password } }, 201);
  const loginResponse = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'administrator', password }) });
  const admin = { ...await loginResponse.json(), cookie: loginResponse.headers.get('set-cookie').split(';')[0] };
  const project = (await expect('/api/projects', { method: 'POST', token: admin.token, body: { key: 'PRIVATE', name: 'L_PRIVATE_PROJECT' } }, 201)).project;
  const memberUser = (await expect('/api/users', { method: 'POST', token: admin.token, body: { username: 'developer', password, role: 'DEV' } }, 201)).user;
  const member = { ...await expect('/api/login', { method: 'POST', body: { username: 'developer', password } }), id: memberUser.id };
  const createTask = async (jiraKey, title, projectId = 'default') => (await expect('/api/tasks', { method: 'POST', token: admin.token, body: { jiraKey, title, projectId } }, 201)).task;
  const ownTask = await createTask('INDEX-1', 'L_TASK_TITLE');
  const privateTask = await createTask('PRIVATE-1', 'L_PRIVATE_TASK', project.id);
  const addAsset = async (task, kind, title, sourceUrl) => (await expect(`/api/tasks/${task.id}/assets`, { method: 'POST', token: admin.token, body: { kind, logicalKey: 'L_LOGICAL_KEY', title, content: bodyMarker + kind, ...(sourceUrl ? { sourceUrl } : {}) } }, 201)).asset;
  const original = await addAsset(ownTask, 'PRD', '  L_PRD_ORIGINAL_TITLE  ', 'https://docs.example.invalid/L_DOCUMENT?version=L_1');
  const revision = await addAsset(ownTask, 'PRD', 'L_PRD_REVISION_TITLE', 'https://docs.example.invalid/L_DOCUMENT?version=L_2');
  const code = await addAsset(ownTask, 'CODE', 'L_CODE_TITLE');
  const hidden = await addAsset(privateTask, 'PRD', 'L_PRIVATE_ASSET');
  for (const [asset, time] of [[original, '01'], [revision, '02'], [code, '02'], [hidden, '03']]) app.db.prepare('UPDATE assets SET created_at=? WHERE id=?').run(`2026-11-12T00:00:${time}.000Z`, asset.id);
  return { app, expect, request, admin, member, project, ownTask, privateTask, original, revision, code, hidden };
}

test('workspace assets index returns only metadata, preserves original labels, and sorts revisions deterministically without writing state', async () => {
  const f = await fixture();
  try {
    const before = f.app.db.prepare('SELECT total_changes() AS count').get().count;
    const visible = await f.expect('/api/assets', { token: f.member.token });
    assert.deepEqual(visible.assets.map(asset => asset.id), [f.code.id, f.revision.id, f.original.id]);
    const fields = ['id', 'taskId', 'projectId', 'kind', 'logicalKey', 'title', 'sourceUrl', 'revision', 'sha256', 'actorId', 'createdAt', 'taskKey', 'taskTitle'].sort();
    for (const asset of visible.assets) { assert.deepEqual(Object.keys(asset).sort(), fields); assert.equal(asset.taskKey, 'INDEX-1'); assert.equal(asset.taskTitle, 'L_TASK_TITLE'); assert.equal(asset.projectId, 'default'); }
    assert.equal(visible.assets[2].title, '  L_PRD_ORIGINAL_TITLE  ');
    assert.equal(visible.assets[2].sourceUrl, 'https://docs.example.invalid/L_DOCUMENT?version=L_1');
    assert.equal(visible.assets[2].logicalKey, 'L_LOGICAL_KEY'); assert.equal(visible.assets[2].revision, 1); assert.equal(visible.assets[1].revision, 2);
    assert.ok(!JSON.stringify(visible).includes(bodyMarker)); assert.ok(!JSON.stringify(visible).includes('L_PRIVATE_ASSET'));
    const all = await f.expect('/api/assets', { token: f.admin.token });
    assert.deepEqual(all.assets.map(asset => asset.id), [f.hidden.id, f.code.id, f.revision.id, f.original.id]);
    assert.deepEqual((await f.expect('/api/assets?projectId=default', { token: f.admin.token })).assets.map(asset => asset.id), [f.code.id, f.revision.id, f.original.id]);
    assert.equal(f.app.db.prepare('SELECT total_changes() AS count').get().count, before);
  } finally { await f.app.close(); }
});

test('workspace assets index rejects explicit hidden projects and immediately follows project membership removal', async () => {
  const f = await fixture();
  try {
    await f.expect('/api/assets', {}, 401);
    assert.equal((await f.expect(`/api/assets?projectId=${f.project.id}`, { token: f.member.token }, 403)).error.code, 'PROJECT_FORBIDDEN');
    assert.equal((await f.expect('/api/assets?projectId=missing-project', { token: f.member.token }, 404)).error.code, 'PROJECT_NOT_FOUND');
    await f.expect('/api/assets?projectId=' + encodeURIComponent("default' OR 1=1 --"), { token: f.member.token }, 404);
    f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run('default', f.member.id);
    assert.deepEqual((await f.expect('/api/assets', { token: f.member.token })).assets, []);
    await f.expect('/api/assets?projectId=default', { token: f.member.token }, 403);
    f.app.db.prepare('INSERT INTO project_members VALUES (?,?,?)').run(f.project.id, f.member.id, 'QA');
    assert.deepEqual((await f.expect('/api/assets', { token: f.member.token })).assets.map(asset => asset.id), [f.hidden.id]);
  } finally { await f.app.close(); }
});

test('device capability remains task-scoped and cannot call the new workspace-wide assets index even for ADMIN', async () => {
  const f = await fixture();
  try {
    const pair = await f.expect('/api/device-authorizations', { method: 'POST', body: { deviceName: 'Isolated asset-index device', tool: 'codex-cli' } }, 201);
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: f.admin.cookie, origin: true, body: { userCode: pair.userCode, decision: 'APPROVE', projectIds: ['default'] } });
    const device = await f.expect('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: pair.deviceCode } });
    for (const path of ['/api/assets', '/api/assets?projectId=default', `/api/assets?projectId=${f.project.id}`]) assert.equal((await f.expect(path, { token: device.token }, 403)).error.code, 'LOCAL_DEVICE_SCOPE');
    const existing = await f.expect(`/api/tasks/${f.ownTask.id}/assets`, { token: device.token });
    assert.equal(existing.assets.length, 3);
    await f.expect(`/api/tasks/${f.privateTask.id}/assets`, { token: device.token }, 403);
  } finally { await f.app.close(); }
});

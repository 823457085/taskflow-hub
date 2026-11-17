import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';
import { sha } from './common.mjs';
const password = 'isolated-device-test-passphrase';
async function fixture({ persistent = false, hostBridge = false } = {}) {
  const dir = persistent || hostBridge ? mkdtempSync(join(tmpdir(), 'taskflow-device-test-')) : null;
  const dbPath = persistent ? join(dir, 'platform.sqlite') : ':memory:';
  const hostBridgeStateDir = hostBridge ? join(dir, 'bridge-state') : null;
  let clock = Date.now(); let app; let base;
  const logs = [];
  const start = async () => {
    app = createPlatform({ dbPath, hostBridgeStateDir, deviceClock: () => clock, logger: { error: (...args) => logs.push(args.join(' ')) } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  await start();
  const request = async (path, { method = 'GET', body, bearer, cookie, origin, contentType = 'application/json' } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': contentType }), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin === true ? { Origin: base } : origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers, text };
  };
  const expect = async (path, options, status = 200, code) => {
    const result = await request(path, options); assert.equal(result.status, status, `${path} expected ${status}; got ${result.status}`);
    if (code) assert.equal(result.data.error.code, code); return result;
  };
  const account = async (username = 'administrator', role = 'ADMIN', admin) => {
    if (!admin) await expect('/api/setup', { method: 'POST', body: { username, password } }, 201);
    else await expect('/api/users', { method: 'POST', bearer: admin.token, body: { username, password, role } }, 201);
    const result = await expect('/api/login', { method: 'POST', body: { username, password } });
    return { ...result.data, cookie: result.headers.get('set-cookie').split(';')[0] };
  };
  const begin = async (extra = {}) => (await expect('/api/device-authorizations', { method: 'POST', body: { deviceName: 'Isolated workstation', tool: 'codex-cli', ...extra } }, 201)).data;
  const decision = async (pair, user, value = 'APPROVE', projectIds = ['default']) => expect('/api/device-authorizations/decision', { method: 'POST', cookie: user.cookie, origin: true, body: { userCode: pair.userCode, decision: value, ...(value === 'APPROVE' ? { projectIds } : {}) } });
  const poll = async (pair, status = 200, code) => expect('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: pair.deviceCode } }, status, code);
  return { get app() { return app; }, get base() { return base; }, hostBridgeStateDir, logs, request, expect, account, begin, decision, poll, advance: ms => { clock += ms; }, restart: async () => { await app.close(); await start(); }, close: async () => { await app.close(); if (dir) rmSync(dir, { recursive: true, force: true }); } };
}
const approvalBody = pair => ({ userCode: pair.userCode, decision: 'APPROVE', projectIds: ['default'] });

test('device pairing requires a cookie browser session, explicit Origin, JSON and explicit project consent', async () => {
  const f = await fixture();
  try {
    const admin = await f.account(); const pair = await f.begin();
    assert.match(pair.deviceCode, /^[A-Za-z0-9_-]{43}$/); assert.match(pair.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(pair.interval, 3);
    const stored = f.app.db.prepare('SELECT * FROM local_authorizations').get();
    assert.notEqual(stored.device_hash, pair.deviceCode); assert.equal(stored.device_hash, sha(pair.deviceCode));
    assert.ok(!JSON.stringify(stored).includes(pair.userCode));
    await f.expect('/api/device-authorizations/inspect', { method: 'POST', body: { userCode: pair.userCode } }, 401);
    await f.expect('/api/device-authorizations/inspect', { method: 'POST', bearer: admin.token, origin: true, body: { userCode: pair.userCode } }, 403, 'BROWSER_SESSION_REQUIRED');
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, body: approvalBody(pair) }, 403, 'BROWSER_SESSION_REQUIRED');
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: 'https://untrusted.invalid', body: approvalBody(pair) }, 403, 'ORIGIN_REJECTED');
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: true, contentType: 'text/plain', body: approvalBody(pair) }, 415);
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: true, body: { ...approvalBody(pair), userId: 'forged' } }, 400, 'INVALID_INPUT');
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: true, body: { ...approvalBody(pair), projectIds: [] } }, 400, 'PROJECT_SCOPE_REQUIRED');
    await f.expect('/api/device-authorizations/inspect', { method: 'POST', cookie: admin.cookie, origin: true, body: { userCode: 'not-a-code' } }, 400, 'INVALID_USER_CODE');
    const inspection = await f.expect('/api/device-authorizations/inspect', { method: 'POST', cookie: admin.cookie, origin: true, body: { userCode: pair.userCode.toLowerCase().replace('-', '') } });
    assert.equal(inspection.data.request.status, 'PENDING');
    const get = await f.request(`/api/device-authorizations/decision?userCode=${pair.userCode}`, { cookie: admin.cookie });
    assert.equal(get.status, 404); assert.equal(f.app.db.prepare('SELECT status FROM local_authorizations').get().status, 'PENDING');
    await f.decision(pair, admin);
    assert.equal((await f.poll(pair)).data.status, 'AUTHORIZED');
  } finally { await f.close(); }
});

test('pending, slow polling, unknown credentials, denial, expiry and decisions are finite and single-use', async () => {
  const f = await fixture();
  try {
    const admin = await f.account(); const member = await f.account('developer', 'DEV', admin);
    const pending = await f.begin(); assert.equal((await f.poll(pending)).data.status, 'PENDING');
    await f.poll(pending, 429, 'SLOW_DOWN');
    await f.expect('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: pending.userCode } }, 400, 'INVALID_DEVICE_CODE');
    await f.expect('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: randomBytes(32).toString('base64url') } }, 404, 'PAIRING_NOT_FOUND');
    await f.decision(pending, admin, 'DENY'); f.advance(3001); assert.equal((await f.poll(pending)).data.status, 'DENIED');
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: true, body: approvalBody(pending) }, 409, 'PAIRING_DECIDED');
    await f.expect('/api/device-authorizations/inspect', { method: 'POST', cookie: member.cookie, origin: true, body: { userCode: pending.userCode } }, 404, 'PAIRING_NOT_FOUND');
    const expired = await f.begin(); f.advance(600_001);
    await f.poll(expired, 410, 'PAIRING_EXPIRED');
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: true, body: approvalBody(expired) }, 410, 'PAIRING_EXPIRED');
    const ready = await f.begin(); await f.decision(ready, admin);
    await f.expect('/api/device-authorizations/decision', { method: 'POST', cookie: admin.cookie, origin: true, body: { userCode: ready.userCode, decision: 'DENY' } }, 409, 'PAIRING_DECIDED');
    const consumed = await Promise.all([f.request('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: ready.deviceCode } }), f.request('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: ready.deviceCode } })]);
    assert.deepEqual(consumed.map(result => result.status).sort(), [200, 409]);
    assert.equal(consumed.filter(result => result.data.status === 'AUTHORIZED' && result.data.token).length, 1);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM local_device_sessions').get().n, 1);
    await f.poll(ready, 409, 'PAIRING_CONSUMED');
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM local_device_sessions').get().n, 1);
  } finally { await f.close(); }
});

test('even ADMIN device tokens are limited to consented projects and cannot manage, approve or access connectors', async () => {
  const f = await fixture();
  try {
    const admin = await f.account();
    const other = (await f.expect('/api/projects', { method: 'POST', bearer: admin.token, body: { key: 'OTHER', name: 'Unconsented project' } }, 201)).data.project;
    const ownTask = (await f.expect('/api/tasks', { method: 'POST', bearer: admin.token, body: { jiraKey: 'DEV-1', title: 'Allowed local work' } }, 201)).data.task;
    const hiddenTask = (await f.expect('/api/tasks', { method: 'POST', bearer: admin.token, body: { projectId: other.id, jiraKey: 'OTHER-1', title: 'Hidden work' } }, 201)).data.task;
    const hiddenJob = (await f.expect('/api/reviews', { method: 'POST', bearer: admin.token, body: { taskId: hiddenTask.id, stage: 'CODE_REVIEW' } }, 201)).data.job;
    const pair = await f.begin(); await f.decision(pair, admin); const device = (await f.poll(pair)).data;
    assert.equal(device.user.role, 'ADMIN');
    const me = await f.expect('/api/me', { bearer: device.token }); assert.equal(me.data.authorization.kind, 'LOCAL_DEVICE');
    assert.deepEqual((await f.expect('/api/projects', { bearer: device.token })).data.projects.map(project => project.id), ['default']);
    assert.deepEqual((await f.expect('/api/tasks', { bearer: device.token })).data.tasks.map(task => task.id), [ownTask.id]);
    for (const suffix of ['', '/context', '/assets', '/gates', '/bundle']) await f.expect(`/api/tasks/${hiddenTask.id}${suffix}`, { bearer: device.token }, 403, 'LOCAL_DEVICE_PROJECT_SCOPE');
    const ownBundle = await f.expect(`/api/tasks/${ownTask.id}/bundle`, { bearer: device.token });
    assert.equal(ownBundle.data.task.id, ownTask.id);
    await f.expect(`/api/jobs/${hiddenJob.id}`, { bearer: device.token }, 403, 'LOCAL_DEVICE_PROJECT_SCOPE');
    await f.expect(`/api/tasks?projectId=${other.id}`, { bearer: device.token }, 403, 'LOCAL_DEVICE_PROJECT_SCOPE');
    for (const [method, path, body] of [['GET', '/api/users'], ['POST', '/api/users', {}], ['POST', '/api/projects', {}], ['GET', '/api/projects/default/members'], ['GET', '/api/connectors'], ['POST', '/api/connectors/jira/config', {}], ['POST', '/api/connectors/jira/read', {}], ['GET', '/api/audit'], ['POST', '/api/plugins', {}], ['POST', '/api/reviews', {}], ['POST', '/api/jobs/fake/decision', {}], ['POST', '/api/jobs/fake/findings/fake/waiver', {}], ['PATCH', `/api/tasks/${ownTask.id}`, {}], ['POST', '/api/device-authorizations/decision', approvalBody(pair)]]) {
      await f.expect(path, { method, body, bearer: device.token, origin: true }, 403, 'LOCAL_DEVICE_SCOPE');
    }
    await f.expect('/api/local-devices', { bearer: device.token }, 403, 'LOCAL_DEVICE_SCOPE');
    await f.expect('/api/local-devices', { cookie: `taskflow_session=${device.token}` }, 403, 'LOCAL_DEVICE_SCOPE');
    await f.expect(`/api/tasks/${ownTask.id}/heartbeat`, { method: 'POST', bearer: device.token, body: { deviceId: 'forged-device', tool: 'codex-cli', status: 'WORKING' } }, 403, 'DEVICE_ID_MISMATCH');
    await f.expect(`/api/tasks/${ownTask.id}/progress`, { method: 'POST', bearer: device.token, body: { deviceId: 'forged-device', tool: 'codex-cli', progress: 10, summary: 'forged' } }, 403, 'DEVICE_ID_MISMATCH');
    const beat = await f.expect(`/api/tasks/${ownTask.id}/heartbeat`, { method: 'POST', bearer: device.token, body: { deviceId: device.deviceId, tool: 'codex-cli', status: 'WORKING', actorId: 'forged' } });
    assert.equal(beat.data.device.actorId, admin.user.id);
    const list = await f.expect('/api/local-devices', { cookie: admin.cookie });
    for (const secret of [pair.deviceCode, pair.userCode, device.token, sha(device.token)]) assert.ok(!list.text.includes(secret));
    assert.equal(list.data.devices[0].scope, 'LOCAL_BRIDGE');
  } finally { await f.close(); }
});

test('device scope follows current membership and role, including after approval but before exchange', async () => {
  const f = await fixture();
  try {
    const admin = await f.account(); const member = await f.account('developer', 'DEV', admin);
    const task = (await f.expect('/api/tasks', { method: 'POST', bearer: member.token, body: { jiraKey: 'SCOPE-1', title: 'Current project work' } }, 201)).data.task;
    const pair = await f.begin(); await f.decision(pair, member); const device = (await f.poll(pair)).data;
    await f.expect(`/api/tasks/${task.id}/heartbeat`, { method: 'POST', bearer: device.token, body: { deviceId: device.deviceId, tool: 'codex-cli', status: 'WORKING' } });
    for (const kind of ['PRD', 'TECH_SPEC', 'CODE']) await f.expect(`/api/tasks/${task.id}/assets`, { method: 'POST', bearer: admin.token, body: { kind, title: kind, content: `Original ${kind}` } }, 201);
    const job = (await f.expect('/api/reviews', { method: 'POST', bearer: admin.token, body: { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'LOCAL_REPORT' } }, 201)).data.job;
    f.app.db.prepare('UPDATE project_members SET role=? WHERE user_id=? AND project_id=?').run('QA', member.user.id, 'default');
    await f.expect(`/api/jobs/${job.id}/report`, { method: 'POST', bearer: device.token, body: { source: 'LOCAL_TOOL', tool: 'codex-cli', summary: 'Explicit local report', findings: [] } }, 403, 'FORBIDDEN');
    f.app.db.prepare('UPDATE project_members SET role=? WHERE user_id=? AND project_id=?').run('DEV', member.user.id, 'default');
    await f.expect(`/api/jobs/${job.id}/report`, { method: 'POST', bearer: device.token, body: { source: 'LOCAL_TOOL', tool: 'codex-cli', summary: 'Explicit local report', findings: [] } }, 201);
    f.app.db.prepare('DELETE FROM project_members WHERE user_id=? AND project_id=?').run(member.user.id, 'default');
    assert.deepEqual((await f.expect('/api/projects', { bearer: device.token })).data.projects, []);
    assert.deepEqual((await f.expect('/api/tasks', { bearer: device.token })).data.tasks, []);
    await f.expect(`/api/tasks/${task.id}/context`, { bearer: device.token }, 403, 'PROJECT_FORBIDDEN');
    await f.expect(`/api/tasks/${task.id}/heartbeat`, { method: 'POST', bearer: device.token, body: { deviceId: device.deviceId, tool: 'codex-cli', status: 'WORKING' } }, 403, 'PROJECT_FORBIDDEN');
    f.app.db.prepare('INSERT INTO project_members VALUES (?,?,?)').run('default', member.user.id, 'DEV');
    const pending = await f.begin(); await f.decision(pending, member);
    f.app.db.prepare('DELETE FROM project_members WHERE user_id=? AND project_id=?').run(member.user.id, 'default');
    await f.poll(pending, 403, 'PROJECT_FORBIDDEN');
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM local_device_sessions').get().n, 1);
  } finally { await f.close(); }
});

test('device logout and browser revocation affect only the selected device, never browser or another account', async () => {
  const f = await fixture();
  try {
    const admin = await f.account(); const member = await f.account('developer', 'DEV', admin);
    const pair1 = await f.begin(); await f.decision(pair1, admin); const device1 = (await f.poll(pair1)).data;
    const pair2 = await f.begin(); await f.decision(pair2, admin); const device2 = (await f.poll(pair2)).data;
    await f.expect(`/api/local-devices/${device2.deviceId}`, { method: 'DELETE', cookie: member.cookie, origin: true }, 404, 'DEVICE_NOT_FOUND');
    await f.expect(`/api/local-devices/${device2.deviceId}`, { method: 'DELETE', cookie: admin.cookie }, 403, 'BROWSER_SESSION_REQUIRED');
    await f.expect('/api/logout', { method: 'POST', bearer: device1.token }, 204);
    await f.expect('/api/me', { bearer: device1.token }, 401);
    await f.expect('/api/me', { bearer: device2.token }); await f.expect('/api/me', { cookie: admin.cookie });
    await f.expect(`/api/local-devices/${device2.deviceId}`, { method: 'DELETE', cookie: admin.cookie, origin: true }, 204);
    await f.expect('/api/me', { bearer: device2.token }, 401); await f.expect('/api/me', { cookie: admin.cookie });
    const list = (await f.expect('/api/local-devices', { cookie: admin.cookie })).data.devices;
    assert.ok(list.every(row => row.status === 'REVOKED'));
    assert.ok(!JSON.stringify(f.logs).includes(device1.token)); assert.ok(!JSON.stringify(f.logs).includes(device2.token));
  } finally { await f.close(); }
});

test('pending authorizations, single consumption and device session metadata survive isolated database restart', async () => {
  const f = await fixture({ persistent: true });
  try {
    const admin = await f.account(); const pair = await f.begin();
    await f.restart(); await f.decision(pair, admin); await f.restart();
    const device = (await f.poll(pair)).data; await f.restart();
    await f.expect('/api/me', { bearer: device.token }); await f.poll(pair, 409, 'PAIRING_CONSUMED');
    const list = await f.expect('/api/local-devices', { cookie: admin.cookie }); assert.equal(list.data.devices.length, 1);
    assert.equal(list.data.devices[0].id, device.deviceId);
    assert.equal(f.app.db.prepare('SELECT token_hash FROM local_device_sessions WHERE id=?').get(device.deviceId).token_hash, sha(device.token));
    assert.equal(f.app.db.prepare('SELECT token_hash FROM sessions WHERE token_hash=?').get(device.token), undefined);
    f.app.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, sha(device.token));
    f.advance(8 * 60 * 60_000 + 1);
    await f.expect('/api/me', { bearer: device.token }, 401);
    assert.equal((await f.expect('/api/local-devices', { cookie: admin.cookie })).data.devices[0].status, 'EXPIRED');
    assert.deepEqual(f.logs, []);
  } finally { await f.close(); }
});

test('revoking a device while its request body is streaming prevents the pending write', { timeout: 5000 }, async () => {
  const f = await fixture(); let writer;
  try {
    const admin = await f.account();
    const task = (await f.expect('/api/tasks', { method: 'POST', bearer: admin.token, body: { jiraKey: 'STREAM-1', title: 'Streaming authorization check' } }, 201)).data.task;
    const pair = await f.begin(); await f.decision(pair, admin); const device = (await f.poll(pair)).data;
    const path = `/api/tasks/${task.id}/progress`;
    const body = JSON.stringify({ deviceId: device.deviceId, tool: 'codex-cli', progress: 80, summary: 'Must not be persisted after revocation' });
    const seen = new Promise(resolve => { f.app.server.once('request', req => resolve(req.url)); });
    const result = new Promise((resolve, reject) => {
      writer = http.request(new URL(path, f.base), { method: 'POST', headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      writer.on('error', reject); writer.write(body.slice(0, -1));
    });
    assert.equal(await seen, path);
    await f.expect(`/api/local-devices/${device.deviceId}`, { method: 'DELETE', cookie: admin.cookie, origin: true }, 204);
    writer.end(body.slice(-1));
    const completed = await result; assert.equal(completed.status, 401); assert.equal(completed.body.error.code, 'UNAUTHENTICATED');
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM progress_events WHERE task_id=?').get(task.id).n, 0);
    assert.equal((await f.expect(`/api/tasks/${task.id}`, { cookie: admin.cookie })).data.task.progress, 0);
  } finally { writer?.destroy(); await f.close(); }
});

test('anonymous pairing starts and authenticated short-code lookups are rate limited', async () => {
  const f = await fixture();
  try {
    const admin = await f.account();
    for (let i = 0; i < 10; i++) await f.begin({ deviceName: `Isolated device ${i}` });
    await f.expect('/api/device-authorizations', { method: 'POST', body: { deviceName: 'Rate limited', tool: 'codex-cli' } }, 429, 'TRY_LATER');
    let wrong = 'ZZZZ-ZZZZ';
    if (f.app.db.prepare('SELECT user_hash FROM local_authorizations WHERE user_hash=?').get(sha('ZZZZZZZZ'))) wrong = 'YYYY-YYYY';
    for (let i = 0; i < 30; i++) await f.expect('/api/device-authorizations/inspect', { method: 'POST', cookie: admin.cookie, origin: true, body: { userCode: wrong } }, 404, 'PAIRING_NOT_FOUND');
    await f.expect('/api/device-authorizations/inspect', { method: 'POST', cookie: admin.cookie, origin: true, body: { userCode: wrong } }, 429, 'TRY_LATER');
    assert.deepEqual(f.logs, []);
  } finally { await f.close(); }
});

test('one-click host bridge requires browser cookie+Origin, writes 0600 private session without leaking secrets, rotates and cleans up on revoke', async () => {
  const f = await fixture({ hostBridge: true });
  try {
    const admin = await f.account();
    const extraProject = (await f.expect('/api/projects', { method: 'POST', bearer: admin.token, body: { key: 'HIDDEN', name: 'Hidden Project' } }, 201)).data.project;
    const allowedTask = (await f.expect('/api/tasks', { method: 'POST', bearer: admin.token, body: { jiraKey: 'HOST-1', title: 'Allowed host bridge task' } }, 201)).data.task;
    await f.expect('/api/tasks', { method: 'POST', bearer: admin.token, body: { projectId: extraProject.id, jiraKey: 'HIDDEN-1', title: 'Out of scope task' } }, 201);

    await f.expect('/api/local-devices/host-bridge', { bearer: admin.token }, 403, 'BROWSER_SESSION_REQUIRED');
    await f.expect('/api/local-devices/host-bridge', { method: 'POST', cookie: admin.cookie, body: { projectIds: ['default'] } }, 403, 'BROWSER_SESSION_REQUIRED');
    await f.expect('/api/local-devices/host-bridge', { method: 'POST', cookie: admin.cookie, origin: 'http://evil.example', body: { projectIds: ['default'] } }, 403, 'ORIGIN_REJECTED');

    const initial = (await f.expect('/api/local-devices/host-bridge', { cookie: admin.cookie })).data;
    assert.equal(initial.supported, true);
    assert.equal(initial.connected, false);
    assert.equal(initial.status, 'DISCONNECTED');

    const created = await f.expect('/api/local-devices/host-bridge', {
      method: 'POST', cookie: admin.cookie, origin: true,
      body: { deviceName: '工作台与本地 AI', tool: 'custom', projectIds: ['default'] },
    }, 201);
    assert.equal(created.data.connected, true);
    assert.equal(created.data.device.status, 'ACTIVE');
    assert.ok(!created.text.includes('"token"'), 'HTTP response must never expose bearer secret');

    const sessionFile = join(f.hostBridgeStateDir, 'session.json');
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
    const firstSession = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(firstSession.deviceId, created.data.device.id);
    assert.deepEqual(firstSession.projectIds, ['default']);

    const scopedTasks = (await f.expect('/api/tasks', { bearer: firstSession.token })).data.tasks;
    assert.deepEqual(scopedTasks.map(item => item.id), [allowedTask.id]);
    await f.expect(`/api/tasks?projectId=${extraProject.id}`, { bearer: firstSession.token }, 403, 'LOCAL_DEVICE_PROJECT_SCOPE');
    await f.expect('/api/local-devices/host-bridge', { bearer: firstSession.token }, 403, 'LOCAL_DEVICE_SCOPE');

    const rotated = await f.expect('/api/local-devices/host-bridge', {
      method: 'POST', cookie: admin.cookie, origin: true,
      body: { deviceName: '工作台与本地 AI', tool: 'custom', projectIds: ['default', extraProject.id] },
    }, 201);
    const secondSession = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.notEqual(secondSession.token, firstSession.token);
    assert.equal(secondSession.deviceId, rotated.data.device.id);
    await f.expect('/api/tasks', { bearer: firstSession.token }, 401, 'UNAUTHENTICATED');
    assert.equal((await f.expect('/api/tasks', { bearer: secondSession.token })).data.tasks.length, 2);

    await f.expect(`/api/local-devices/${rotated.data.device.id}`, { method: 'DELETE', cookie: admin.cookie, origin: true }, 204);
    assert.equal(existsSync(sessionFile), false);
    assert.equal((await f.expect('/api/local-devices/host-bridge', { cookie: admin.cookie })).data.connected, false);
    assert.deepEqual(f.logs, []);
  } finally { await f.close(); }
});

test('project workspace bindings persist per user, expose in task context, and block local device management writes', async () => {
  const f = await fixture({ hostBridge: true });
  try {
    const admin = await f.account();
    const task = (await f.expect('/api/tasks', { method: 'POST', bearer: admin.token, body: { jiraKey: 'REPO-1', title: 'Workspace binding task' } }, 201)).data.task;
    await f.expect('/api/projects/default/workspace', { method: 'PUT', cookie: admin.cookie, origin: true, body: { repoPath: 'relative/path' } }, 400, 'INVALID_REPO_PATH');
    const saved = (await f.expect('/api/projects/default/workspace', {
      method: 'PUT', cookie: admin.cookie, origin: true,
      body: { repoPath: '/Users/demo/workspace/sample-repo/', defaultTarget: 'antigravity' },
    })).data.workspace;
    assert.equal(saved.repoPath, '/Users/demo/workspace/sample-repo');
    assert.equal(saved.defaultTarget, 'antigravity');

    const list = (await f.expect('/api/project-workspaces', { cookie: admin.cookie })).data.workspaces;
    assert.equal(list.length, 1);
    assert.equal(list[0].projectId, 'default');

    await f.expect('/api/local-devices/host-bridge', { method: 'POST', cookie: admin.cookie, origin: true, body: { projectIds: ['default'] } }, 201);
    const deviceSession = JSON.parse(readFileSync(join(f.hostBridgeStateDir, 'session.json'), 'utf8'));
    const context = (await f.expect(`/api/tasks/${task.id}/context`, { bearer: deviceSession.token })).data;
    assert.equal(context.workspace.repoPath, '/Users/demo/workspace/sample-repo');
    await f.expect('/api/project-workspaces', { bearer: deviceSession.token }, 403, 'LOCAL_DEVICE_SCOPE');
    await f.expect('/api/projects/default/workspace', { method: 'PUT', bearer: deviceSession.token, body: { repoPath: '/Users/demo/other' } }, 403, 'LOCAL_DEVICE_SCOPE');

    await f.expect('/api/projects/default/workspace', { method: 'DELETE', cookie: admin.cookie, origin: true }, 204);
    assert.equal((await f.expect('/api/projects/default/workspace', { cookie: admin.cookie })).data.workspace, null);
  } finally { await f.close(); }
});

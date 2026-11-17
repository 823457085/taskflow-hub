import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';
import { redactText } from './agent-sessions.mjs';

const password = 'agent-sessions-passphrase';
const setupToken = 'agent-sessions-setup-token';

async function startHub() {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-sessions-'));
  let offset = 0;
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, deployment: 'server', setupToken, deviceClock: () => Date.now() + offset });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const body = await response.json();
    return { token: body.token, user: body.user, post: { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: base } };
  };
  const pair = async (member, projectIds) => {
    const start = await call('/api/device-authorizations', 'POST', { deviceName: 'mac', tool: 'custom' });
    await call('/api/device-authorizations/decision', 'POST', { userCode: start.body.userCode, decision: 'APPROVE', projectIds }, undefined, member.post);
    offset += 3100;
    return (await call('/api/device-authorizations/poll', 'POST', { deviceCode: start.body.deviceCode })).body.token;
  };
  return { platform, call, login, pair, close: async () => { await platform.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function seed(hub) {
  await hub.call('/api/setup', 'POST', { username: 'admin', password, setupToken });
  const admin = await hub.login('admin');
  for (const [username, role] of [['dev', 'DEV'], ['peer', 'DEV'], ['pm-lead', 'PM']]) await hub.call('/api/users', 'POST', { username, password, role }, admin.token);
  const secret = (await hub.call('/api/projects', 'POST', { key: 'SECRET', name: 'Secret' }, admin.token)).body.project;
  return { admin, secret, dev: await hub.login('dev'), peer: await hub.login('peer'), pm: await hub.login('pm-lead') };
}

const session = (id, extra = {}) => ({ id, title: `会话 ${id}`, objective: '排查 PAY-12 回调', provider: 'codex', model: 'gpt', mode: 'ask', status: 'completed', result: '已定位问题', turns: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.01, jiraKeys: ['PAY-12'], workspace: '/Users/me/repo/payments', startedAt: '2026-11-17T01:00:00.000Z', updatedAt: '2026-11-17T02:00:00.000Z', ...extra });

test('redactText masks common credentials in agent output', () => {
  const text = redactText('token=abcd1234efgh Authorization: Bearer abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstu ghp_abcdefghijklmnopqrstuvwxyz password: "hunter22"');
  for (const secret of ['abcd1234efgh', 'abcdefghijklmnopqrstuvwxyz', 'sk-abcdefghijklmnopqrstu', 'ghp_abcdefghijklmnopqrstuvwxyz', 'hunter22']) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /token=\[REDACTED\]/);
  assert.equal(redactText('见 /Users/demo/work/app/src 和 /home/ci/build'), '见 ~/work/app/src 和 ~/build');
});

test('agent sessions sync from a paired device stay private until the owner shares them with a project, then members can comment', async () => {
  const hub = await startHub();
  try {
    const { secret, dev, peer, pm } = await seed(hub);
    const device = await hub.pair(dev, ['default']);
    const task = (await hub.call('/api/tasks', 'POST', { jiraKey: 'PAY-12', title: '支付回调' }, dev.token)).body.task;

    assert.equal((await hub.call('/api/agent-sessions/sync', 'POST', { source: 'other', items: [] }, device)).status, 400);
    assert.equal((await hub.call('/api/agent-sessions/sync', 'POST', { source: 'delivery', items: [session('a', { projectId: secret.id })] }, device)).status, 403);
    const first = await hub.call('/api/agent-sessions/sync', 'POST', { source: 'delivery', items: [session('a', { result: '日志里有 token=abcd1234efgh' }), session('b', { projectId: 'default', shared: true })] }, device);
    assert.deepEqual(first.body, { created: 2, updated: 0, unchanged: 0 });
    assert.deepEqual((await hub.call('/api/agent-sessions/sync', 'POST', { source: 'delivery', items: [session('a'), session('b', { status: 'failed', updatedAt: '2026-11-17T03:00:00.000Z' })] }, device)).body, { created: 0, updated: 1, unchanged: 1 });
    assert.equal((await hub.call('/api/agent-sessions', 'GET', undefined, device)).status, 403);

    const mine = (await hub.call('/api/agent-sessions', 'GET', undefined, dev.token)).body;
    assert.equal(mine.total, 2);
    const [b, a] = mine.sessions;
    assert.deepEqual([a.title, a.shared, a.workspace, a.projectId], ['会话 a', false, 'payments', null]);
    assert.deepEqual([b.status, b.shared, b.taskId, b.taskKey], ['failed', true, task.id, 'PAY-12']);
    assert.equal((await hub.call(`/api/agent-sessions/${a.id}`, 'GET', undefined, dev.token)).body.session.result, '日志里有 token=[REDACTED]');
    assert.equal((await hub.call('/api/agent-sessions?q=PAY-12', 'GET', undefined, dev.token)).body.total, 2);

    assert.equal((await hub.call(`/api/agent-sessions/${a.id}`, 'GET', undefined, peer.token)).status, 404);
    assert.deepEqual((await hub.call('/api/agent-sessions?scope=project&projectId=default', 'GET', undefined, peer.token)).body.sessions.map(item => item.id), [b.id]);
    assert.equal((await hub.call(`/api/agent-sessions?scope=project&projectId=${secret.id}`, 'GET', undefined, peer.token)).status, 403);
    assert.equal((await hub.call(`/api/agent-sessions/${b.id}`, 'PATCH', { shared: false }, peer.token)).status, 403);

    assert.equal((await hub.call(`/api/agent-sessions/${a.id}`, 'PATCH', { shared: true }, dev.token)).body.error.code, 'AGENT_SESSION_PROJECT_REQUIRED');
    const shared = (await hub.call(`/api/agent-sessions/${a.id}`, 'PATCH', { projectId: 'default', shared: true }, dev.token)).body.session;
    assert.deepEqual([shared.shared, shared.taskId], [true, task.id]);
    const commented = (await hub.call(`/api/agent-sessions/${a.id}/comments`, 'POST', { body: '我也遇到过，见 PAY-12' }, peer.token)).body.session;
    assert.deepEqual(commented.commentList.map(item => [item.authorName, item.body]), [['peer', '我也遇到过，见 PAY-12']]);
    assert.equal((await hub.call('/api/agent-sessions?scope=project&projectId=default', 'GET', undefined, pm.token)).body.sessions.find(item => item.id === a.id).comments, 1);

    assert.deepEqual((await hub.call('/api/agent-sessions/share', 'POST', { ids: [a.id, b.id], projectId: 'default', shared: false }, dev.token)).body, { changed: 2 });
    assert.equal((await hub.call(`/api/agent-sessions/${a.id}`, 'GET', undefined, peer.token)).status, 404);
    assert.equal((await hub.call(`/api/agent-sessions/${a.id}`, 'DELETE', undefined, peer.token)).status, 404);
    assert.equal((await hub.call(`/api/agent-sessions/${a.id}`, 'DELETE', undefined, dev.token)).status, 204);
    assert.equal((await hub.call('/api/agent-sessions', 'GET', undefined, dev.token)).body.total, 1);
  } finally { await hub.close(); }
});

test('deployment records support manual entries and idempotent pipeline sync scoped to project members', async () => {
  const hub = await startHub();
  try {
    const { secret, dev, peer, pm, admin } = await seed(hub);
    const device = await hub.pair(dev, ['default']);
    const run = { externalId: 'yunxiao:983', provider: 'yunxiao', environment: 'pre', service: 'example-web', status: 'running', url: 'https://flow.aliyun.com/pipelines/3290340/current', startedAt: '2026-11-16T07:53:08.366Z' };

    assert.equal((await hub.call('/api/deployments/sync', 'POST', { projectId: secret.id, items: [run] }, device)).status, 403);
    assert.equal((await hub.call('/api/deployments/sync', 'POST', { projectId: 'default', items: [{ ...run, provider: 'manual' }] }, device)).status, 400);
    assert.deepEqual((await hub.call('/api/deployments/sync', 'POST', { projectId: 'default', items: [run] }, device)).body, { created: 1, updated: 0, unchanged: 0 });
    assert.deepEqual((await hub.call('/api/deployments/sync', 'POST', { projectId: 'default', items: [{ ...run, status: 'success', finishedAt: '2026-11-16T07:55:27.068Z' }] }, device)).body, { created: 0, updated: 1, unchanged: 0 });
    assert.deepEqual((await hub.call('/api/deployments/sync', 'POST', { projectId: 'default', items: [{ ...run, status: 'success', finishedAt: '2026-11-16T07:55:27.068Z' }] }, device)).body, { created: 0, updated: 0, unchanged: 1 });
    assert.equal((await hub.call('/api/deployments?projectId=default', 'GET', undefined, device)).status, 403);

    assert.equal((await hub.call('/api/deployments', 'POST', { projectId: 'default', environment: 'prod', service: 'web', url: 'javascript:alert(1)' }, peer.token)).status, 400);
    const manual = (await hub.call('/api/deployments', 'POST', { projectId: 'default', environment: 'prod', service: 'web', version: 'v1.2.0', notes: '灰度 10%' }, peer.token)).body.deployment;
    assert.deepEqual([manual.provider, manual.status, manual.actorName, manual.canEdit, manual.canDelete], ['manual', 'running', 'peer', true, true]);
    assert.equal((await hub.call(`/api/deployments/${manual.id}`, 'PATCH', { status: 'success' }, dev.token)).status, 403);
    const done = (await hub.call(`/api/deployments/${manual.id}`, 'PATCH', { status: 'success' }, pm.token)).body.deployment;
    assert.equal(done.status, 'success');
    assert.ok(done.finishedAt);

    const listed = (await hub.call('/api/deployments?projectId=default', 'GET', undefined, dev.token)).body;
    assert.deepEqual(listed.deployments.map(item => item.environment).sort(), ['pre', 'prod']);
    assert.deepEqual(listed.environments.map(item => [item.environment, item.total, item.latest.status]), [['pre', 1, 'success'], ['prod', 1, 'success']]);
    const synced = listed.deployments.find(item => item.provider === 'yunxiao');
    assert.equal(synced.canDelete, false);
    assert.equal((await hub.call(`/api/deployments/${synced.id}`, 'PATCH', { status: 'failed' }, dev.token)).status, 400);
    assert.equal((await hub.call(`/api/deployments/${synced.id}`, 'PATCH', { notes: '回滚演练' }, dev.token)).body.deployment.notes, '回滚演练');
    assert.equal((await hub.call(`/api/deployments?projectId=${secret.id}`, 'GET', undefined, dev.token)).status, 403);
    assert.equal((await hub.call('/api/deployments?projectId=default&environment=pre', 'GET', undefined, dev.token)).body.deployments.length, 1);

    assert.equal((await hub.call(`/api/deployments/${manual.id}`, 'DELETE', undefined, dev.token)).status, 403);
    assert.equal((await hub.call(`/api/deployments/${manual.id}`, 'DELETE', undefined, peer.token)).status, 204);
    const actions = (await hub.call('/api/audit', 'GET', undefined, admin.token)).body.audit.map(row => row.action);
    for (const action of ['DEPLOYMENT_SYNC', 'DEPLOYMENT_RECORD', 'DEPLOYMENT_UPDATE', 'DEPLOYMENT_DELETE']) assert.ok(actions.includes(action), action);
  } finally { await hub.close(); }
});

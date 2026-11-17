import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';

const password = 'bridge-dispatch-passphrase';
const setupToken = 'bridge-dispatch-setup-token';

async function startHub(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-bridge-'));
  let offset = 0;
  const clock = () => Date.now() + offset;
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, deployment: 'server', setupToken, deviceClock: clock, ...options });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => {
    const result = await call('/api/login', { method: 'POST', body: { username, password } });
    const cookie = result.headers.get('set-cookie').split(';')[0];
    return { token: result.body.token, user: result.body.user, get: { Cookie: cookie }, post: { Cookie: cookie, Origin: base } };
  };
  const pair = async (member, projectIds, deviceName = 'dev-laptop') => {
    const start = await call('/api/device-authorizations', { method: 'POST', body: { deviceName, tool: 'custom' } });
    await call('/api/device-authorizations/decision', { method: 'POST', body: { userCode: start.body.userCode, decision: 'APPROVE', projectIds }, headers: member.post });
    offset += 3100;
    const paired = await call('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: start.body.deviceCode } });
    assert.equal(paired.body.status, 'AUTHORIZED');
    return { token: paired.body.token, deviceId: paired.body.deviceId };
  };
  return { platform, call, login, pair, base, advance: ms => { offset += ms; }, close: async () => { await platform.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function seed(hub) {
  await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } });
  const admin = await hub.login('admin');
  await hub.call('/api/users', { method: 'POST', body: { username: 'developer', password, role: 'DEV' }, token: admin.token });
  await hub.call('/api/users', { method: 'POST', body: { username: 'other', password, role: 'DEV' }, token: admin.token });
  const other = (await hub.call('/api/projects', { method: 'POST', body: { key: 'OTHER', name: 'Other' }, token: admin.token })).body.project;
  const dev = await hub.login('developer');
  const peer = await hub.login('other');
  const task = (await hub.call('/api/tasks', { method: 'POST', body: { jiraKey: 'BRG-1', title: 'bridge task' }, token: dev.token })).body.task;
  return { admin, dev, peer, task, otherProject: other };
}

test('dispatches a read run to the requesting member\'s own paired bridge and enforces device, scope and mode boundaries', async () => {
  const hub = await startHub();
  try {
    const { dev, peer, task, admin, otherProject } = await seed(hub);
    const device = await hub.pair(dev, ['default']);
    const peerDevice = await hub.pair(peer, ['default'], 'peer-laptop');
    const adminScoped = await hub.pair(admin, [otherProject.id], 'admin-other');

    const capabilities = await hub.call('/api/local-automation/capabilities', { headers: dev.get });
    assert.deepEqual(capabilities.body.devices.map(item => item.id), [device.deviceId]);
    assert.equal(capabilities.body.devices[0].online, false);

    const start = body => hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body, headers: dev.post });
    assert.equal((await start({ mode: 'read', engine: 'codex', runner: 'bridge', deviceId: peerDevice.deviceId })).body.error.code, 'BRIDGE_DEVICE_UNAVAILABLE');
    assert.equal((await hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'read', deviceId: adminScoped.deviceId }, headers: admin.post })).body.error.code, 'BRIDGE_DEVICE_PROJECT_SCOPE');
    assert.equal((await start({ mode: 'develop', deviceId: device.deviceId })).body.error.code, 'BRIDGE_MODE_DISABLED');
    assert.equal((await start({ mode: 'read', engine: 'claude', deviceId: device.deviceId })).body.error.code, 'INVALID_AI_ENGINE');
    assert.equal((await hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'read', deviceId: device.deviceId }, token: dev.token })).body.error.code, 'BROWSER_SESSION_REQUIRED');

    const queued = await start({ mode: 'read', engine: 'codex', runner: 'bridge', deviceId: device.deviceId, customInstruction: '重点看接口' });
    assert.equal(queued.status, 201);
    assert.equal(queued.body.run.status, 'RUNNING');
    assert.equal(queued.body.run.bridgePhase, 'QUEUED');
    assert.equal(queued.body.run.runner, 'bridge');
    const runId = queued.body.run.id;
    assert.deepEqual((await hub.call(`/api/tasks/${task.id}/ai-runs`, { headers: peer.get })).body.runs, []);
    assert.equal((await hub.call(`/api/ai-runs/${runId}`, { headers: peer.get })).status, 404);

    assert.equal((await hub.call('/api/bridge/runs/next?wait=0', { token: dev.token })).body.error.code, 'BRIDGE_DEVICE_REQUIRED');
    assert.equal((await hub.call('/api/bridge/runs/next?wait=0', { token: peerDevice.token })).body.run, null);
    const next = await hub.call('/api/bridge/runs/next?wait=0', { token: device.token });
    assert.equal(next.body.run.id, runId);
    assert.equal((await hub.call(`/api/bridge/runs/${runId}/claim`, { method: 'POST', body: {}, token: peerDevice.token })).status, 404);
    const claim = await hub.call(`/api/bridge/runs/${runId}/claim`, { method: 'POST', body: {}, token: device.token });
    assert.equal(claim.status, 200);
    assert.match(claim.body.payload.objective, /\{\{TASKFLOW_CONTEXT_FILE\}\}/);
    assert.match(claim.body.payload.objective, /重点看接口/);
    assert.equal(claim.body.payload.context.task.id, task.id);
    assert.equal(claim.body.payload.taskFlowUrl, `${hub.base}/#view=tasks&task=${task.id}`);
    assert.equal(JSON.stringify(claim.body).includes(device.token), false);
    assert.equal((await hub.call(`/api/bridge/runs/${runId}/claim`, { method: 'POST', body: {}, token: device.token })).body.error.code, 'BRIDGE_RUN_NOT_QUEUED');

    const online = await hub.call('/api/local-automation/capabilities', { headers: dev.get });
    assert.equal(online.body.devices[0].online, true);

    assert.equal((await hub.call(`/api/bridge/runs/${runId}/progress`, { method: 'POST', body: { output: 'step 1' }, token: device.token })).body.cancelRequested, false);
    assert.equal((await hub.call(`/api/ai-runs/${runId}`, { headers: dev.get })).body.run.output, 'step 1');
    const stopped = await hub.call(`/api/ai-runs/${runId}/stop`, { method: 'POST', body: {}, headers: dev.post });
    assert.equal(stopped.body.run.status, 'RUNNING');
    assert.equal(stopped.body.run.cancelRequested, true);
    assert.equal((await hub.call(`/api/bridge/runs/${runId}/progress`, { method: 'POST', body: { output: 'step 2' }, token: device.token })).body.cancelRequested, true);
    const finished = await hub.call(`/api/bridge/runs/${runId}/result`, { method: 'POST', body: { status: 'CANCELLED', output: 'step 2\nstopped', error: '用户取消' }, token: device.token });
    assert.equal(finished.body.run.status, 'CANCELLED');
    assert.equal((await hub.call(`/api/bridge/runs/${runId}/progress`, { method: 'POST', body: { output: 'late' }, token: device.token })).body.error.code, 'BRIDGE_RUN_CLOSED');
    assert.equal((await hub.call(`/api/bridge/runs/${runId}/result`, { method: 'POST', body: { status: 'SUCCEEDED', output: 'late' }, token: device.token })).body.error.code, 'BRIDGE_RUN_CLOSED');

    const audit = (await hub.call('/api/audit', { token: admin.token })).body.audit.map(item => item.action);
    for (const action of ['BRIDGE_RUN_QUEUE', 'BRIDGE_RUN_CLAIM', 'BRIDGE_RUN_STOP', 'BRIDGE_RUN_FINISH']) assert.ok(audit.includes(action), action);
  } finally { await hub.close(); }
});

test('review dispatch freezes a local review job and stores the structured draft returned by the bridge', async () => {
  const hub = await startHub();
  try {
    const { admin, task } = await seed(hub);
    assert.equal((await hub.call(`/api/tasks/${task.id}/assets`, { method: 'POST', body: { kind: 'PRD', title: 'PRD', content: '需求正文' }, token: admin.token })).status, 201);
    const device = await hub.pair(admin, ['default']);
    const queued = await hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'review', stage: 'PRD', engine: 'cursor', deviceId: device.deviceId }, headers: admin.post });
    assert.equal(queued.status, 201);
    assert.ok(queued.body.job.id);
    const claim = await hub.call(`/api/bridge/runs/${queued.body.run.id}/claim`, { method: 'POST', body: {}, token: device.token });
    assert.equal(claim.body.payload.context.reviewJob.id, queued.body.job.id);
    const output = '分析完成\n```taskflow-review-draft\n{"summary":"方案缺少错误码","evidence":"TECH_SPEC r1","findings":[{"severity":"WARN","title":"错误码","detail":"补充错误码","location":"spec#3"}]}\n```';
    const result = await hub.call(`/api/bridge/runs/${queued.body.run.id}/result`, { method: 'POST', body: { status: 'SUCCEEDED', output, exitCode: 0 }, token: device.token });
    assert.equal(result.body.run.status, 'SUCCEEDED');
    assert.equal(result.body.run.draft.summary, '方案缺少错误码');
    assert.equal(result.body.run.draft.findings[0].severity, 'WARN');
    assert.equal(result.body.run.jobId, queued.body.job.id);
  } finally { await hub.close(); }
});

test('lost bridges and unclaimed dispatches expire, long-poll returns empty and cancelled queued runs are never handed out', async () => {
  const hub = await startHub();
  try {
    const { dev, task } = await seed(hub);
    const device = await hub.pair(dev, ['default']);
    const start = () => hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'read', deviceId: device.deviceId }, headers: dev.post });

    const cancelled = (await start()).body.run;
    assert.equal((await hub.call(`/api/ai-runs/${cancelled.id}/stop`, { method: 'POST', body: {}, headers: dev.post })).body.run.status, 'CANCELLED');
    const began = Date.now();
    assert.equal((await hub.call('/api/bridge/runs/next?wait=1', { token: device.token })).body.run, null);
    assert.ok(Date.now() - began >= 900);

    const lost = (await start()).body.run;
    await hub.call(`/api/bridge/runs/${lost.id}/claim`, { method: 'POST', body: {}, token: device.token });
    const stale = (await start()).body.run;
    assert.equal((await start()).body.error.code, 'AI_RUN_BUSY');
    hub.advance(61_000);
    const lostRow = (await hub.call(`/api/ai-runs/${lost.id}`, { headers: dev.get })).body.run;
    assert.equal(lostRow.status, 'INTERRUPTED');
    assert.match(lostRow.error, /60 秒未回报/);
    assert.equal((await hub.call(`/api/bridge/runs/${lost.id}/result`, { method: 'POST', body: { status: 'SUCCEEDED', output: 'late' }, token: device.token })).body.error.code, 'BRIDGE_RUN_CLOSED');
    hub.advance(30 * 60_000);
    const staleRow = (await hub.call(`/api/ai-runs/${stale.id}`, { headers: dev.get })).body.run;
    assert.equal(staleRow.status, 'INTERRUPTED');
    assert.match(staleRow.error, /30 分钟内未领取/);

    await hub.call(`/api/local-devices/${device.deviceId}`, { method: 'DELETE', headers: dev.post });
    assert.equal((await start()).body.error.code, 'BRIDGE_DEVICE_UNAVAILABLE');
    assert.equal((await hub.call('/api/bridge/runs/next?wait=0', { token: device.token })).status, 401);
  } finally { await hub.close(); }
});

test('develop dispatch requires the server to allow it and the member to own the task', async () => {
  const hub = await startHub({ bridgeModes: ['read', 'review', 'develop'] });
  try {
    const { dev, peer, task } = await seed(hub);
    const peerDevice = await hub.pair(peer, ['default'], 'peer');
    const denied = await hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'develop', deviceId: peerDevice.deviceId }, headers: peer.post });
    assert.equal(denied.body.error.code, 'FORBIDDEN');
    const device = await hub.pair(dev, ['default']);
    const queued = await hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'develop', deviceId: device.deviceId }, headers: dev.post });
    assert.equal(queued.status, 201);
    const claim = await hub.call(`/api/bridge/runs/${queued.body.run.id}/claim`, { method: 'POST', body: {}, token: device.token });
    assert.match(claim.body.payload.objective, /\{\{TASKFLOW_REPO_PATH\}\}/);
    assert.match(claim.body.payload.objective, /严禁执行 git push/);
  } finally { await hub.close(); }
});

test('agent directory lists project bridges and leads dispatch to members who opted into team dispatch', async () => {
  const hub = await startHub({ bridgeModes: ['read', 'review', 'develop'] });
  try {
    const { admin, dev, peer, task } = await seed(hub);
    const devDevice = await hub.pair(dev, ['default'], 'dev-mac');
    const peerDevice = await hub.pair(peer, ['default'], 'peer-mac');
    const agents = async member => (await hub.call('/api/agents?projectId=default', { headers: member.get })).body.agents;
    const dispatch = (member, body) => hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { engine: 'codex', runner: 'bridge', ...body }, headers: member.post });

    assert.equal((await hub.call('/api/agents?projectId=default', { token: admin.token })).body.error.code, 'BROWSER_SESSION_REQUIRED');
    let listed = await agents(admin);
    assert.deepEqual(listed.map(item => item.deviceName).sort(), ['dev-mac', 'peer-mac']);
    const devAgent = listed.find(item => item.id === devDevice.deviceId);
    assert.deepEqual({ owner: devAgent.owner.username, mine: devAgent.mine, teamDispatch: devAgent.teamDispatch, dispatchable: devAgent.dispatchable }, { owner: 'developer', mine: false, teamDispatch: false, dispatchable: false });
    assert.equal((await agents(dev)).find(item => item.id === devDevice.deviceId).dispatchable, true);

    assert.equal((await dispatch(admin, { mode: 'read', deviceId: devDevice.deviceId })).body.error.code, 'BRIDGE_TEAM_DISPATCH_DISABLED');
    const toggle = (member, deviceId, teamDispatch, auth = { headers: member.post }) => hub.call(`/api/local-devices/${deviceId}`, { method: 'PATCH', body: { teamDispatch }, ...auth });
    assert.equal((await toggle(peer, devDevice.deviceId, true)).status, 404);
    assert.equal((await toggle(dev, devDevice.deviceId, true, { token: dev.token })).body.error.code, 'BROWSER_SESSION_REQUIRED');
    assert.equal((await toggle(dev, devDevice.deviceId, 'yes')).status, 400);
    assert.equal((await toggle(dev, devDevice.deviceId, true)).status, 200);
    assert.equal((await toggle(peer, peerDevice.deviceId, true)).status, 200);
    assert.equal((await hub.call('/api/local-devices', { headers: dev.get })).body.devices[0].teamDispatch, true);

    listed = await agents(admin);
    assert.equal(listed.find(item => item.id === devDevice.deviceId).dispatchable, true);
    assert.equal((await agents(peer)).find(item => item.id === devDevice.deviceId).dispatchable, false);
    assert.equal((await dispatch(peer, { mode: 'read', deviceId: devDevice.deviceId })).body.error.code, 'BRIDGE_DEVICE_UNAVAILABLE');
    assert.equal((await dispatch(admin, { mode: 'develop', deviceId: peerDevice.deviceId })).body.error.code, 'BRIDGE_TARGET_NOT_ASSIGNEE');

    const read = await dispatch(admin, { mode: 'read', deviceId: devDevice.deviceId });
    assert.equal(read.status, 201);
    assert.equal(read.body.run.actorId, admin.user.id);
    assert.deepEqual(read.body.run.deviceOwner, { id: dev.user.id, username: 'developer' });
    assert.ok((await hub.call(`/api/tasks/${task.id}/ai-runs`, { headers: dev.get })).body.runs.some(run => run.id === read.body.run.id));
    assert.equal((await hub.call(`/api/ai-runs/${read.body.run.id}`, { headers: dev.get })).status, 200);
    assert.deepEqual((await hub.call(`/api/tasks/${task.id}/ai-runs`, { headers: peer.get })).body.runs, []);
    const next = await hub.call('/api/bridge/runs/next?wait=0', { token: devDevice.token });
    assert.equal(next.body.run.id, read.body.run.id);
    const claim = await hub.call(`/api/bridge/runs/${read.body.run.id}/claim`, { method: 'POST', body: {}, token: devDevice.token });
    assert.equal(claim.body.payload.dispatchedBy, 'admin');

    const develop = await dispatch(admin, { mode: 'develop', deviceId: devDevice.deviceId, autoClaim: true });
    assert.equal(develop.status, 201);
    const developClaim = await hub.call(`/api/bridge/runs/${develop.body.run.id}/claim`, { method: 'POST', body: {}, token: devDevice.token });
    assert.equal(developClaim.status, 200);
    assert.equal((await hub.call(`/api/tasks/${task.id}`, { headers: dev.get })).body.task.assigneeId, dev.user.id);

    assert.equal((await toggle(dev, devDevice.deviceId, false)).status, 200);
    assert.equal((await dispatch(admin, { mode: 'read', deviceId: devDevice.deviceId })).body.error.code, 'BRIDGE_TEAM_DISPATCH_DISABLED');
    const audit = (await hub.call('/api/audit', { token: admin.token })).body.audit.map(row => row.action);
    assert.ok(audit.includes('LOCAL_DEVICE_TEAM_DISPATCH_ON') && audit.includes('LOCAL_DEVICE_TEAM_DISPATCH_OFF'));
  } finally { await hub.close(); }
});

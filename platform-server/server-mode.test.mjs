import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';
import { runRemoteAgent } from '../local-bridge/remote-agent.mjs';

const password = 'server-mode-test-passphrase';
const setupToken = 'server-setup-token-for-tests';

async function startPlatform(options) {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-server-mode-'));
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, setupToken, ...options });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? undefined : await response.json() };
  };
  return { platform, call, base, close: async () => { await platform.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('server deployment disables loopback-gated local execution even when every request arrives from a proxy on loopback', async () => {
  const runnerCalls = [];
  const hub = await startPlatform({
    deployment: 'server', cookieSecure: true, hostBridgeStateDir: mkdtempSync(join(tmpdir(), 'taskflow-host-bridge-')),
    runnerOverride: () => { runnerCalls.push('spawn'); throw new Error('must not spawn'); },
  });
  try {
    assert.equal((await hub.call('/health')).body.deployment, 'server');
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } })).status, 201);
    const login = await hub.call('/api/login', { method: 'POST', body: { username: 'admin', password } });
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Secure; Max-Age=/);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const browser = { Cookie: cookie };
    const origin = { ...browser, Origin: hub.base };
    const task = (await hub.call('/api/tasks', { method: 'POST', body: { jiraKey: 'SRV-1', title: 'server task' }, token: login.body.token })).body.task;

    const capabilities = await hub.call('/api/local-automation/capabilities', { headers: browser });
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.deployment, 'server');
    assert.deepEqual(capabilities.body.runners, ['bridge']);
    assert.deepEqual(capabilities.body.devices, []);
    assert.deepEqual((await hub.call('/api/local-git/repositories', { headers: browser })).body.repositories, []);
    assert.deepEqual((await hub.call(`/api/tasks/${task.id}/ai-runs`, { headers: browser })).body.runs, []);

    for (const [path, method, body] of [
      ['/api/local-automation/doctor', 'GET'],
      ['/api/local-git/open', 'POST', { projectId: 'default', app: 'finder', repoPath: '/tmp' }],
      ['/api/projects/default/git-status', 'GET'],
      [`/api/tasks/${task.id}/assets/from-git`, 'POST', {}],
    ]) {
      const result = await hub.call(path, { method, body, headers: method === 'GET' ? browser : origin });
      assert.equal(result.status, 403, path);
      assert.equal(result.body.error.code, 'LOCAL_ONLY_ENDPOINT', path);
    }
    const localRun = await hub.call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { mode: 'read', engine: 'codex', runner: 'local' }, headers: origin });
    assert.equal(localRun.body.error.code, 'INVALID_AI_RUNNER');
    assert.equal((await hub.call('/api/ai-runs/any', { headers: browser })).status, 404);
    assert.equal(runnerCalls.length, 0);

    const hostBridge = await hub.call('/api/local-devices/host-bridge', { headers: browser });
    assert.equal(hostBridge.body.supported, false);
    assert.equal((await hub.call('/api/local-devices/host-bridge', { method: 'POST', body: { projectIds: ['default'] }, headers: origin })).status, 403);
    assert.equal((await hub.call('/api/taskflow/workbench/exchange', { method: 'POST', body: { ticket: 'x'.repeat(43) } })).status, 401);
  } finally { await hub.close(); }
});

test('explicit hosted repo scan uses only the browser user’s live Agent authorized for the project', async () => {
  const hub = await startPlatform({ deployment: 'server' });
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-repo-scan-'));
  const abort = new AbortController();
  const agents = [];
  const scan = (projectId, options) => hub.call('/api/local-git/repositories?refresh=1&projectId=' + projectId, options);
  const member = async username => {
    const login = await hub.call('/api/login', { method: 'POST', body: { username, password } });
    return { token: login.body.token, headers: { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: hub.base } };
  };
  const connect = async (actor, home, projectIds) => {
    const start = await hub.call('/api/device-authorizations', { method: 'POST', body: { deviceName: 'scan device', tool: 'custom' } });
    assert.equal(start.status, 201);
    const approved = await hub.call('/api/device-authorizations/decision', {
      method: 'POST', headers: actor.headers, body: { userCode: start.body.userCode, decision: 'APPROVE', projectIds },
    });
    assert.equal(approved.status, 200);
    const paired = await hub.call('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: start.body.deviceCode } });
    assert.equal(paired.body.status, 'AUTHORIZED');
    agents.push(runRemoteAgent({ apiUrl: hub.base, token: paired.body.token, home, signal: abort.signal }));
  };
  const waitForScan = async (projectId, actor) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await scan(projectId, actor);
      if (result.status !== 409) return result;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('scoped Agent did not connect');
  };
  try {
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } })).status, 201);
    const admin = await member('admin');
    const project = await hub.call('/api/projects', { method: 'POST', token: admin.token, body: { key: 'OTHER', name: 'Other' } });
    assert.equal(project.status, 201);
    const other = project.body.project.id;
    assert.equal((await hub.call('/api/users', { method: 'POST', token: admin.token, body: { username: 'peer', password, role: 'DEV' } })).status, 201);
    const peer = await member('peer');
    const home = join(dir, 'owner-home');
    const repo = join(home, 'Desktop', '工作台', 'team', 'business');
    const worktree = join(home, 'workspace', 'checked-out-worktree');
    const hidden = join(home, '.private-repository');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: test worktree');
    mkdirSync(join(hidden, '.git'), { recursive: true });
    mkdirSync(join(home, 'workspace', '.hidden', '.git'), { recursive: true });
    mkdirSync(join(home, 'workspace', 'node_modules', 'dependency', '.git'), { recursive: true });
    mkdirSync(join(home, 'Documents'), { recursive: true });
    symlinkSync(hidden, join(home, 'workspace', 'linked'));
    symlinkSync(hidden, join(home, 'Documents', 'Codex'));
    const otherHome = join(dir, 'other-home');
    mkdirSync(join(otherHome, 'projects', 'wrong-project', '.git'), { recursive: true });

    assert.equal((await scan('default', { token: admin.token })).body.error.code, 'BROWSER_SESSION_REQUIRED');
    assert.equal((await scan('default', { headers: admin.headers })).body.error.code, 'BRIDGE_REPO_SCAN_UNAVAILABLE');
    await connect(admin, home, ['default']);
    assert.equal((await waitForScan('default', { headers: admin.headers })).status, 200);
    await connect(admin, otherHome, [other]);
    const otherResult = await waitForScan(other, { headers: admin.headers });
    assert.deepEqual(otherResult.body.repositories.map(item => item.name), ['wrong-project']);
    const result = await scan('default', { headers: admin.headers });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.repositories, [
      { name: 'business', path: repo, group: 'team' },
      { name: 'checked-out-worktree', path: worktree, group: 'workspace' },
    ]);
    assert.equal((await scan('default', { headers: peer.headers })).body.error.code, 'BRIDGE_REPO_SCAN_UNAVAILABLE');
    assert.equal((await scan(other, { headers: peer.headers })).status, 403);
  } finally {
    abort.abort();
    await hub.close();
    await Promise.allSettled(agents);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server deployment only creates the first administrator with the configured setup token', async () => {
  const unconfigured = await startPlatform({ deployment: 'server', setupToken: '' });
  try {
    const result = await unconfigured.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken: '' } });
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'SETUP_TOKEN_UNCONFIGURED');
  } finally { await unconfigured.close(); }
  const hub = await startPlatform({ deployment: 'server' });
  try {
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password } })).body.error.code, 'SETUP_TOKEN_INVALID');
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken: 'wrong-setup-token-value' } })).body.error.code, 'SETUP_TOKEN_INVALID');
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } })).status, 201);
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'other', password, setupToken } })).status, 409);
  } finally { await hub.close(); }
  const local = await startPlatform({ deployment: 'local', setupToken: '' });
  try {
    assert.equal((await local.call('/api/setup', { method: 'POST', body: { username: 'admin', password } })).status, 201);
  } finally { await local.close(); }
});

test('trusted proxy rate-limits logins per forwarded client instead of sharing one loopback bucket', async () => {
  const hub = await startPlatform({ deployment: 'server', trustProxy: true });
  try {
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } })).status, 201);
    const attempt = ip => hub.call('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong-password-123' }, headers: { 'X-Real-IP': ip } });
    for (let index = 0; index < 15; index += 1) assert.equal((await attempt('203.0.113.7')).status, 401);
    assert.equal((await attempt('203.0.113.7')).status, 429);
    assert.equal((await attempt('198.51.100.9')).status, 401);
    assert.equal((await attempt('not-an-ip<script>')).status, 401);
  } finally { await hub.close(); }
});

test('forwarded client headers are ignored unless the proxy is explicitly trusted', async () => {
  const hub = await startPlatform({ deployment: 'server' });
  try {
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } })).status, 201);
    for (let index = 0; index < 15; index += 1) {
      await hub.call('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong-password-123' }, headers: { 'X-Real-IP': `203.0.113.${index}` } });
    }
    assert.equal((await hub.call('/api/login', { method: 'POST', body: { username: 'admin', password }, headers: { 'X-Real-IP': '198.51.100.1' } })).status, 429);
  } finally { await hub.close(); }
});

test('device sessions honour the configured lifetime for long-running bridges', async () => {
  let clock = Date.parse('2026-11-17T00:00:00Z');
  const hub = await startPlatform({ deployment: 'server', deviceClock: () => clock, deviceSessionMs: 168 * 3_600_000 });
  try {
    assert.equal((await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } })).status, 201);
    const login = await hub.call('/api/login', { method: 'POST', body: { username: 'admin', password } });
    const browser = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: hub.base };
    const start = await hub.call('/api/device-authorizations', { method: 'POST', body: { deviceName: 'dev-laptop', tool: 'custom' } });
    assert.equal((await hub.call('/api/device-authorizations/decision', { method: 'POST', body: { userCode: start.body.userCode, decision: 'APPROVE', projectIds: ['default'] }, headers: browser })).body.status, 'APPROVED');
    const paired = await hub.call('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: start.body.deviceCode } });
    assert.equal(paired.body.status, 'AUTHORIZED');
    assert.equal(Date.parse(paired.body.expiresAt) - clock, 168 * 3_600_000);
  } finally { await hub.close(); }
});

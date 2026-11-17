import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';

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

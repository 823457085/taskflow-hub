import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';
import { runRemoteAgent } from '../local-bridge/remote-agent.mjs';

const password = 'workbench-remote-passphrase';
const setupToken = 'workbench-remote-setup-token';
const WB = 'hub.test:80';
const FIXTURE = join(import.meta.dirname, 'workbench-remote/instance.fixture.mjs');

function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    env[match[1]] = value;
  }
  return env;
}

/** Plays systemd: runs the fixture with the env file the platform wrote for the slot. */
function fakeControl(envDir) {
  const running = new Map();
  const start = async slot => {
    if (running.has(slot)) return;
    const env = parseEnv(readFileSync(join(envDir, `${slot}.env`), 'utf8'));
    const child = spawn(process.execPath, [FIXTURE], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    running.set(slot, child);
    child.once('exit', () => running.delete(slot));
  };
  const stop = async slot => { running.get(slot)?.kill('SIGKILL'); running.delete(slot); };
  return { start, stop, restart: async slot => { await stop(slot); await start(slot); }, active: async slot => running.has(slot), running };
}

test('server-side workbench runs on the server while files and commands execute on the owner\'s computer', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-remote-'));
  const home = join(dir, 'mac-home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const envDir = join(dir, 'wb-env');
  const control = fakeControl(envDir);
  let offset = 0;
  const clock = () => Date.now() + offset;
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, deployment: 'server', setupToken, deviceClock: clock, workbenchHost: WB,
    publicOrigin: 'https://hub.test', workbenchMode: 'server', workbenchInstanceOptions: { apiUrl: () => `http://127.0.0.1:${platform.server.address().port}`, envDir, stateRoot: join(dir, 'state'), control, basePort: 15300 + Math.floor(Math.random() * 500) } });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => platform.workbenchServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const abort = new AbortController();
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };
  const login = async username => {
    const result = await call('/api/login', { method: 'POST', body: { username, password } });
    const cookie = result.headers.get('set-cookie').split(';')[0];
    return { token: result.body.token, post: { Cookie: cookie, Origin: base } };
  };
  const wb = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: platform.workbenchServer.address().port, path, headers: { Host: WB, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  const enter = async member => {
    const code = await call('/api/workbench/codes', { method: 'POST', body: { return: '/' }, headers: member.post });
    const url = new URL(code.body.url);
    assert.equal(url.origin, `https://${WB}`);
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: platform.workbenchServer.address().port, path: url.pathname + url.search, headers: { Host: WB } }, res => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }).on('error', reject);
    });
  };
  try {
    await call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } });
    const admin = await login('admin');
    for (const username of ['dev', 'peer']) await call('/api/users', { method: 'POST', body: { username, password, role: 'DEV' }, token: admin.token });
    const [dev, peer] = [await login('dev'), await login('peer')];
    const start = await call('/api/device-authorizations', { method: 'POST', body: { deviceName: 'dev-mac', tool: 'custom' } });
    await call('/api/device-authorizations/decision', { method: 'POST', body: { userCode: start.body.userCode, decision: 'APPROVE', projectIds: ['default'] }, headers: dev.post });
    offset += 3100;
    const device = (await call('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: start.body.deviceCode } })).body;
    assert.equal(device.status, 'AUTHORIZED');

    assert.equal((await call('/api/bridge/remote/stream?info=x', { token: dev.token })).status, 403, 'browser sessions cannot act as an agent');
    assert.equal((await call('/internal/remote/status', { token: 'x'.repeat(43) })).status, 401);
    assert.equal((await call('/internal/remote/status', { token: 'x'.repeat(43), headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 404, 'instance routes are loopback only');

    const devCookie = await enter(dev);
    const offline = await wb('/', { Cookie: devCookie, Accept: 'text/html' });
    assert.equal(offline.status, 503);
    assert.match(offline.text, /你的电脑未连接/);

    void runRemoteAgent({ apiUrl: base, token: device.token, home, signal: abort.signal, sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 200))) });
    for (let i = 0; i < 50 && !(await call('/api/workbench/status', { token: dev.token })).body.online; i++) await new Promise(resolve => setTimeout(resolve, 100));

    let page;
    for (let i = 0; i < 100; i++) {
      page = await wb('/', { Cookie: devCookie, Accept: 'text/html' });
      if (page.status === 200) break;
      assert.equal(page.status, 503);
      assert.match(page.text, /正在服务器上启动/);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(page.status, 200);
    assert.match(page.text, /workbench 127\.0\.0\.1:\d+/, 'Host is rewritten so the workbench same-origin checks still pass');

    const probe = await wb('/probe', { Cookie: devCookie });
    assert.equal(probe.status, 200, probe.text);
    const result = JSON.parse(probe.text);
    assert.equal(result.read, 'hello from server');
    assert.equal(readFileSync(join(home, 'proj', 'a.txt'), 'utf8'), 'hello from server');
    assert.equal(result.existsSync, true);
    assert.deepEqual(result.listing, ['a.txt:file']);
    assert.equal(result.statSize, 17);
    assert.equal(result.ssh, 'EACCES', 'credential stores on the computer stay private');
    assert.equal(result.git, 'true');
    assert.match(result.shell, /proj\npiped-stdin$/);
    assert.equal(result.nodeChild, 'hello from server', 'node children inherit the remote layer');
    assert.equal(result.localData, 'server-side');
    assert.notEqual(result.codex, 'EACCES');

    const peerCookie = await enter(peer);
    const peerPage = await wb('/', { Cookie: peerCookie, Accept: 'text/html' });
    assert.equal(peerPage.status, 503, 'another member never reaches this computer or instance');
    assert.match(peerPage.text, /你的电脑未连接/);
  } finally {
    abort.abort();
    for (const child of control.running.values()) child.kill('SIGKILL');
    await platform.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

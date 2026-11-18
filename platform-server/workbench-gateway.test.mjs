import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';
import { runWorkbenchTunnel } from '../local-bridge/workbench-tunnel.mjs';

const password = 'workbench-gateway-passphrase';
const setupToken = 'workbench-gateway-setup-token';
const WB = 'hub.test:8443';

async function startHub() {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-wb-'));
  let offset = 0;
  const clock = () => Date.now() + offset;
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, deployment: 'server', setupToken, deviceClock: clock, workbenchHost: WB, publicOrigin: 'https://hub.test' });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => platform.workbenchServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => {
    const result = await call('/api/login', { method: 'POST', body: { username, password } });
    const cookie = result.headers.get('set-cookie').split(';')[0];
    return { token: result.body.token, get: { Cookie: cookie }, post: { Cookie: cookie, Origin: base } };
  };
  const pair = async (member, deviceName) => {
    const start = await call('/api/device-authorizations', { method: 'POST', body: { deviceName, tool: 'custom' } });
    await call('/api/device-authorizations/decision', { method: 'POST', body: { userCode: start.body.userCode, decision: 'APPROVE', projectIds: ['default'] }, headers: member.post });
    offset += 3100;
    const paired = await call('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: start.body.deviceCode } });
    assert.equal(paired.body.status, 'AUTHORIZED');
    return { token: paired.body.token, deviceId: paired.body.deviceId };
  };
  // Requests to the workbench host must carry its Host header, which fetch cannot set.
  const wb = (path, { method = 'GET', headers = {}, body, stream = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: platform.workbenchServer.address().port, path, method, headers: { Host: WB, ...headers } }, res => {
      if (stream) return resolve({ status: res.statusCode, headers: res.headers, res, req });
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const enter = async member => {
    const code = await call('/api/workbench/codes', { method: 'POST', body: { return: '/' }, headers: member.post });
    assert.equal(code.status, 200);
    const callback = await wb(new URL(code.body.url).pathname + new URL(code.body.url).search);
    assert.equal(callback.status, 302);
    return callback.headers['set-cookie'][0].split(';')[0];
  };
  return { platform, call, login, pair, wb, enter, base, close: async () => { await platform.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function startWorkbench() {
  const server = http.createServer((req, res) => {
    const info = { method: req.method, path: req.url, host: req.headers.host, origin: req.headers.origin || '', cookie: req.headers.cookie || '', confirmed: req.headers['x-delivery-confirmed'] || '' };
    if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: one\n\n');
      const timer = setTimeout(() => res.write('data: two\n\n'), 150);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://${req.headers.host}/target` }); return res.end(); }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['local=1; Path=/', 'taskflow_session=upstream-value; Path=/', '__Host-tfwb=upstream-value; Path=/; Secure'] });
      res.end(JSON.stringify({ ...info, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

async function seed(hub) {
  await hub.call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } });
  const admin = await hub.login('admin');
  await hub.call('/api/users', { method: 'POST', body: { username: 'developer', password, role: 'DEV' }, token: admin.token });
  await hub.call('/api/users', { method: 'POST', body: { username: 'other', password, role: 'DEV' }, token: admin.token });
  return { dev: await hub.login('developer'), peer: await hub.login('other') };
}

test('workbench host requires a TaskFlow handoff and relays only to the signed-in member\'s own bridge', async () => {
  const hub = await startHub();
  const local = await startWorkbench();
  const stop = new AbortController();
  try {
    const { dev, peer } = await seed(hub);
    const devDevice = await hub.pair(dev, 'dev-mac');
    const peerDevice = await hub.pair(peer, 'peer-mac');

    const anonymous = await hub.wb('/agent?tab=1', { headers: { Accept: 'text/html' } });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.location, 'https://hub.test/?workbench=1&return=%2Fagent%3Ftab%3D1');
    assert.equal((await hub.wb('/api/ping')).status, 401);
    assert.equal((await hub.wb('/api/ping', { headers: { Host: 'evil.test' } })).status, 421);
    assert.equal((await hub.wb('/api/ping', { headers: { Host: 'hub.test' } })).status, 421);
    assert.equal((await hub.call('/api/workbench/status', { headers: dev.get })).body.url, `https://${WB}/`);

    assert.equal((await hub.call('/api/workbench/codes', { method: 'POST', body: { return: '/' }, token: dev.token })).status, 403, 'bearer tokens cannot mint browser sessions');
    assert.equal((await hub.call('/api/workbench/codes', { method: 'POST', body: { return: '/' }, token: devDevice.token })).status, 403, 'device tokens cannot mint browser sessions');
    const code = await hub.call('/api/workbench/codes', { method: 'POST', body: { return: '//evil.test/x' }, headers: dev.post });
    const callbackPath = new URL(code.body.url).pathname + new URL(code.body.url).search;
    assert.equal(new URL(code.body.url).host, WB);
    const callback = await hub.wb(callbackPath);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, '/', 'open redirects are collapsed to the workbench root');
    assert.match(callback.headers['set-cookie'][0], /^__Host-tfwb=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    assert.equal((await hub.wb(callbackPath)).status, 400, 'handoff codes are single use');
    const devCookie = callback.headers['set-cookie'][0].split(';')[0];

    const offline = await hub.wb('/', { headers: { Cookie: devCookie, Accept: 'text/html' } });
    assert.equal(offline.status, 503);
    assert.match(offline.text, /你的电脑未连接/);

    void runWorkbenchTunnel({ apiUrl: hub.base, token: devDevice.token, target: local.origin, signal: stop.signal, polls: 2 });
    await new Promise(resolve => setTimeout(resolve, 100));

    const ping = await hub.wb('/api/ping?x=1', { headers: { Cookie: `theme=dark; ${dev.get.Cookie}; ${devCookie}` } });
    assert.equal(ping.status, 200);
    const pinged = JSON.parse(ping.text);
    assert.equal(pinged.path, '/api/ping?x=1');
    assert.equal(pinged.host, new URL(local.origin).host);
    assert.equal(pinged.cookie, 'theme=dark', 'the TaskFlow and gateway session cookies never reach the workbench');
    assert.deepEqual(ping.headers['set-cookie'], ['local=1; Path=/']);

    const posted = await hub.wb('/api/echo', { method: 'POST', headers: { Cookie: devCookie, Origin: `https://${WB}`, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{"a":1}' });
    const echoed = JSON.parse(posted.text);
    assert.equal(echoed.body, '{"a":1}');
    assert.equal(echoed.origin, local.origin, 'a verified browser origin is presented to the workbench as local');
    assert.equal(echoed.confirmed, 'yes');
    assert.equal((await hub.wb('/api/echo', { method: 'POST', headers: { Cookie: devCookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'writes without the workbench origin are rejected');
    assert.equal((await hub.wb('/api/echo', { method: 'POST', headers: { Cookie: devCookie, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await hub.wb('/api/echo', { method: 'POST', headers: { Cookie: devCookie, Origin: 'https://hub.test' }, body: '{}' })).status, 403);

    const redirected = await hub.wb('/redirect', { headers: { Cookie: devCookie } });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.location, '/target');

    const events = await hub.wb('/api/events', { headers: { Cookie: devCookie, Accept: 'text/event-stream' }, stream: true });
    assert.equal(events.status, 200);
    const first = await new Promise(resolve => events.res.once('data', chunk => resolve(chunk.toString('utf8'))));
    assert.match(first, /data: one/, 'server-sent events are streamed before the response completes');
    const second = await new Promise(resolve => events.res.once('data', chunk => resolve(chunk.toString('utf8'))));
    assert.match(second, /data: two/);
    events.req.destroy();

    const peerCookie = await hub.enter(peer);
    const peerView = await hub.wb('/api/ping', { headers: { Cookie: peerCookie, Accept: 'text/html' } });
    assert.equal(peerView.status, 503, 'another member never reaches the developer\'s computer');

    const peerPoll = await hub.call('/api/bridge/tunnel/next?wait=0', { token: peerDevice.token });
    assert.deepEqual(peerPoll.body, { request: null });
    assert.equal((await hub.call('/api/bridge/tunnel/next?wait=0', { headers: dev.get })).status, 403, 'browser sessions cannot poll the tunnel');

    await hub.call('/api/logout', { method: 'POST', body: {}, headers: dev.post });
    assert.equal((await hub.wb('/api/ping', { headers: { Cookie: devCookie } })).status, 401, 'signing out of TaskFlow ends the workbench session');
  } finally {
    stop.abort();
    await local.close();
    await hub.close();
  }
});

test('a queued request is only claimable and answerable by the owner\'s device', async () => {
  const hub = await startHub();
  try {
    const { dev, peer } = await seed(hub);
    const devDevice = await hub.pair(dev, 'dev-mac');
    const peerDevice = await hub.pair(peer, 'peer-mac');
    const devCookie = await hub.enter(dev);
    assert.deepEqual((await hub.call('/api/bridge/tunnel/next?wait=0', { token: devDevice.token })).body, { request: null });

    const browser = hub.wb('/api/secret', { headers: { Cookie: devCookie } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual((await hub.call('/api/bridge/tunnel/next?wait=1', { token: peerDevice.token })).body, { request: null });
    const claimed = (await hub.call('/api/bridge/tunnel/next?wait=1', { token: devDevice.token })).body.request;
    assert.equal(claimed.path, '/api/secret');
    assert.equal(claimed.headers.cookie, undefined);

    const answer = (token, text) => fetch(`${hub.base}/api/bridge/tunnel/responses/${claimed.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: `${JSON.stringify({ status: 200, headers: [['content-type', 'text/plain'], ['strict-transport-security', 'max-age=1']] })}\n${text}`,
    });
    assert.equal((await answer(peerDevice.token, 'forged')).status, 404, 'another member\'s device cannot answer the request');
    assert.equal((await answer(devDevice.token, 'genuine')).status, 204);
    const result = await browser;
    assert.equal(result.status, 200);
    assert.equal(result.text, 'genuine');
    assert.equal(result.headers['strict-transport-security'], undefined);
    assert.equal((await answer(devDevice.token, 'again')).status, 404, 'a request is answered at most once');
  } finally {
    await hub.close();
  }
});

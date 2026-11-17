import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBrowserHandoff } from './browser-handoff.mjs';
import { parseArgs } from './rd.mjs';
import { createPlatform } from '../platform-server/server.mjs';

const bridge = dirname(fileURLToPath(import.meta.url));
const origin = 'http://127.0.0.1:5186';
const publicCode = 'ABCD-EFGH';
const payload = () => ({ webUrl: origin, userCode: publicCode, deviceName: 'Fixture device', tool: 'custom', expiresAt: new Date(Date.now() + 10000).toISOString(), suggestedProjectIds: ['default'] });
async function directory(t) { const value = await mkdtemp(join(tmpdir(), 'taskflow-browser-connect-')); t.after(() => rm(value, { recursive: true, force: true })); return value; }
async function listen(t, handler) { const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve))); return `http://127.0.0.1:${server.address().port}`; }
function rawGet(url, headers) { return new Promise((resolve, reject) => { const req = httpRequest(url, { headers }, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body })); }); req.on('error', reject); req.end(); }); }
function connect(options, state, { onOpen, throwOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const source = `import {connectDevice} from './device-pair.mjs';
      connectDevice(JSON.parse(process.env.TEST_CONNECT_OPTIONS), {openBrowser:async url=>{
        console.log(JSON.stringify({fixtureOpen:url}));
        if(process.env.TEST_THROW_OPEN==='1')throw new Error('Fixture browser did not open');
      }}).catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: bridge, env: { ...process.env, RD_HUB_STATE_DIR: state, TEST_CONNECT_OPTIONS: JSON.stringify(options), TEST_THROW_OPEN: throwOpen ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', opened;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture connect did not finish')); }, 15000);
    child.stdout.on('data', chunk => {
      const text = chunk.toString(); stdout += text; pending += text;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.fixtureOpen && !opened) opened = Promise.resolve(onOpen?.(value.fixtureOpen)).catch(error => { child.kill(); throw error; });
      }
    });
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', async code => { clearTimeout(timer); try { await opened; resolve({ code, stdout, stderr }); } catch (error) { reject(error); } });
  });
}

test('connect validates suggested IDs without changing manual pair arguments', () => {
  const parsed = parseArgs(['connect', '--name', ' Mac ', '--tool', 'codex-cli', '--projects', 'default,one,default']);
  assert.equal(parsed.options.name, 'Mac'); assert.deepEqual(parsed.options.projects, ['default', 'one']); assert.equal(parsed.options['web-url'], origin);
  assert.throws(() => parseArgs(['connect', '--name', 'Mac', '--tool', 'custom', '--projects', 'one,']), /projects/);
  assert.throws(() => parseArgs(['connect', '--name', 'Mac', '--tool', 'custom', '--projects', Array.from({ length: 101 }, (_, i) => 'p' + i).join(',')]), /projects/);
  assert.throws(() => parseArgs(['pair', '--name', 'Mac', '--tool', 'custom', '--projects', 'default']), /参数/);
});

test('loopback handoff exposes only bounded confirmation metadata to its exact web origin and host', async t => {
  const input = { ...payload(), deviceCode: 'must-never-return-device-secret', token: 'must-never-return-bearer-secret' };
  const handoff = await createBrowserHandoff(input); t.after(() => handoff.close());
  const url = `http://127.0.0.1:${handoff.port}/taskflow-pairing`;
  const good = await fetch(url, { headers: { Origin: origin } }); const data = await good.json();
  assert.equal(good.status, 200); assert.equal(good.headers.get('access-control-allow-origin'), origin); assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(data).sort(), ['schemaVersion', 'userCode', 'deviceName', 'tool', 'expiresAt', 'suggestedProjectIds'].sort());
  assert.equal(data.schemaVersion, 1); assert.equal(data.userCode, publicCode); assert.deepEqual(data.suggestedProjectIds, ['default']);
  assert.deepEqual(await (await fetch(url, { headers: { Origin: origin } })).json(), data, 'GET remains repeatable until the pairing settles');
  for (const headers of [{}, { Origin: 'http://evil.invalid' }, { Origin: origin + '/' }, { Origin: 'null' }]) assert.equal((await fetch(url, { headers })).status, 403);
  assert.equal((await rawGet(url, { Origin: origin, Host: 'localhost:' + handoff.port })).status, 403);
  assert.equal((await fetch(url + '?token=ignored', { headers: { Origin: origin } })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', headers: { Origin: origin } })).status, 405);
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })).status, 403);
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
  assert.equal(new URL(handoff.verificationUrl).hash, `#view=local&localBridgePort=${handoff.port}`);
  assert.ok(!handoff.verificationUrl.includes(publicCode));
  await handoff.close(); await handoff.close();
  await assert.rejects(fetch(url, { headers: { Origin: origin } }));
});

test('handoff refuses malformed inputs and closes at expiry', async () => {
  for (const value of [{ ...payload(), userCode: 'bad' }, { ...payload(), suggestedProjectIds: ['../escape'] }, { ...payload(), expiresAt: new Date(0).toISOString() }]) await assert.rejects(createBrowserHandoff(value), /确认信息/);
  const handoff = await createBrowserHandoff({ ...payload(), expiresAt: new Date(Date.now() + 200).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${handoff.port}/taskflow-pairing`, { headers: { Origin: origin } }));
  await handoff.close();
});

test('connect opens a code-free page, completes real cookie-approved device pairing and SDK task reads, then reuses that session', async t => {
  const app = createPlatform({ dbPath: ':memory:', connectorProfiles: {}, logger: { error() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const state = await directory(t); const url = `http://127.0.0.1:${app.server.address().port}`;
  const password = randomBytes(32).toString('base64url');
  const post = (path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/setup', { username: 'connect-fixture', password })).status, 201);
  const login = await post('/api/login', { username: 'connect-fixture', password }); const cookie = login.headers.get('set-cookie').split(';')[0]; const webToken = (await login.json()).token;
  assert.equal((await post('/api/tasks', { jiraKey: 'CONNECT-1', title: 'L_TASK_TITLE' }, { Cookie: cookie, Origin: url })).status, 201);
  let openedUrl; let readCode;
  const result = await connect({ url, 'web-url': url, name: 'Connect fixture', tool: 'custom', projects: ['default'] }, state, { onOpen: async value => {
    openedUrl = value; const port = new URLSearchParams(new URL(value).hash.slice(1)).get('localBridgePort');
    assert.match(port, /^[1-9]\d{3,4}$/);
    const response = await fetch(`http://127.0.0.1:${port}/taskflow-pairing`, { headers: { Origin: url } });
    const data = await response.json(); assert.equal(response.status, 200); assert.deepEqual(data.suggestedProjectIds, ['default']); readCode = data.userCode;
    const inspect = await post('/api/device-authorizations/inspect', { userCode: readCode }, { Cookie: cookie, Origin: url });
    assert.equal(inspect.status, 200); assert.equal((await inspect.json()).request.deviceName, 'Connect fixture');
    assert.equal((await post('/api/device-authorizations/decision', { userCode: readCode, decision: 'APPROVE', projectIds: ['default'] }, { Cookie: cookie, Origin: url })).status, 200);
  } });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /已连接并验证任务读取/);
  const saved = JSON.parse(await readFile(join(state, 'session.json'), 'utf8'));
  assert.deepEqual(saved.projectIds, ['default']); assert.equal((await stat(join(state, 'session.json'))).mode & 0o777, 0o600);
  for (const secret of [password, webToken, cookie, saved.token, readCode]) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  const me = await (await fetch(url + '/api/me', { headers: { Authorization: `Bearer ${saved.token}` } })).json(); assert.equal(me.authorization.kind, 'LOCAL_DEVICE');
  assert.equal((await fetch(url + '/api/accounts', { headers: { Authorization: `Bearer ${saved.token}` } })).status, 403);
  assert.equal((await fetch(url + '/api/me', { headers: { Cookie: cookie } })).status, 200);
  const handoffPort = new URLSearchParams(new URL(openedUrl).hash.slice(1)).get('localBridgePort');
  await assert.rejects(fetch(`http://127.0.0.1:${handoffPort}/taskflow-pairing`, { headers: { Origin: url } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(bridge, 'mcp.mjs')], env: { RD_HUB_STATE_DIR: state }, stderr: 'pipe' }); transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'handoff-fixture', version: '1.0.0' });
  try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 11); const tasks = await client.callTool({ name: 'task_list', arguments: {} }); assert.equal(tasks.isError, undefined); assert.equal(JSON.parse(tasks.content[0].text).tasks.length, 1); }
  finally { await client.close(); }
  const oldFile = await readFile(join(state, 'session.json'), 'utf8'); const before = app.db.prepare('SELECT count(*) AS n FROM local_device_sessions').get().n;
  const reused = await connect({ url, 'web-url': url, name: 'Ignored on reuse', tool: 'custom' }, state, { throwOpen: true });
  assert.equal(reused.code, 0, reused.stderr); assert.ok(!reused.stdout.includes('fixtureOpen')); assert.equal(await readFile(join(state, 'session.json'), 'utf8'), oldFile); assert.equal(app.db.prepare('SELECT count(*) AS n FROM local_device_sessions').get().n, before);
});

test('connect closes handoff on opener failure, denial, expiry and poll errors without saving a session or printing codes', async t => {
  for (const mode of ['opener', 'denied', 'expired', 'poll-error']) {
    const state = await directory(t); const deviceSecret = randomBytes(32).toString('base64url'); let opened;
    const url = await listen(t, async (req, res) => {
      for await (const chunk of req) { /* no logging */ }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/device-authorizations') res.writeHead(201).end(JSON.stringify({ deviceCode: deviceSecret, userCode: publicCode, expiresAt: new Date(Date.now() + (mode === 'expired' ? 150 : 10000)).toISOString(), interval: 1 }));
      else if (mode === 'poll-error') res.writeHead(429).end(JSON.stringify({ error: { message: 'L_RATE_LIMIT' } }));
      else res.end(JSON.stringify({ status: 'DENIED' }));
    });
    const result = await connect({ url, 'web-url': origin, name: 'Failed fixture', tool: 'custom' }, state, { throwOpen: mode === 'opener', onOpen: value => { opened = value; } });
    assert.equal(result.code, 1); assert.ok(opened); assert.ok(!`${result.stdout}${result.stderr}`.includes(publicCode)); assert.ok(!`${result.stdout}${result.stderr}`.includes(deviceSecret));
    assert.ok(!(await readdir(state)).includes('session.json'));
    const port = new URLSearchParams(new URL(opened).hash.slice(1)).get('localBridgePort'); await assert.rejects(fetch(`http://127.0.0.1:${port}/taskflow-pairing`, { headers: { Origin: origin } }));
  }
});

test('connect archives only confirmed HTTP 401, preserves corrupt/forbidden/network failures and detects concurrently replaced logins', async t => {
  for (const mode of ['unauthorized', 'corrupt', 'forbidden', 'network', 'replacement', 'reuse-replacement']) {
    const state = await directory(t); const token = randomBytes(32).toString('base64url'); let authStarts = 0;
    const url = await listen(t, async (req, res) => {
      for await (const chunk of req) { /* no logging */ }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/me') {
        if (mode === 'network') { res.destroy(); return; }
        if (mode === 'reuse-replacement') { res.end(JSON.stringify({ authorization: { kind: 'LOCAL_DEVICE', projectIds: ['default'] } })); return; }
        if (mode === 'replacement') { await writeFile(join(state, 'new.json'), JSON.stringify({ url, token: randomBytes(32).toString('base64url'), deviceId: 'replacement' }), { mode: 0o600 }); const { rename } = await import('node:fs/promises'); await rename(join(state, 'new.json'), join(state, 'session.json')); }
        res.writeHead(mode === 'forbidden' ? 403 : 401).end(JSON.stringify({ error: { message: 'L_AUTH_REQUIRED' } }));
      } else if (req.url === '/api/tasks') {
        await writeFile(join(state, 'new.json'), JSON.stringify({ url, token: randomBytes(32).toString('base64url'), deviceId: 'replacement' }), { mode: 0o600 });
        const { rename } = await import('node:fs/promises'); await rename(join(state, 'new.json'), join(state, 'session.json'));
        res.end(JSON.stringify({ tasks: [] }));
      } else { authStarts++; res.writeHead(201).end(JSON.stringify({ deviceCode: randomBytes(32).toString('base64url'), userCode: publicCode, expiresAt: new Date(Date.now() + 10000).toISOString(), interval: 1 })); }
    });
    const original = mode === 'corrupt' ? '{not-json' : JSON.stringify({ url, token, deviceId: 'old-device' });
    await writeFile(join(state, 'session.json'), original, { mode: 0o600 });
    const result = await connect({ url, 'web-url': origin, name: 'Recovery fixture', tool: 'custom' }, state, { throwOpen: true });
    assert.equal(result.code, 1); assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
    const names = await readdir(state); const backups = names.filter(name => name.startsWith('session.json.expired-'));
    if (mode === 'unauthorized') { assert.equal(authStarts, 1); assert.equal(backups.length, 1); assert.equal(await readFile(join(state, backups[0]), 'utf8'), original); assert.equal((await stat(join(state, backups[0]))).mode & 0o777, 0o600); assert.ok(!names.includes('session.json')); }
    else { assert.equal(authStarts, 0); assert.equal(backups.length, 0); if (['replacement', 'reuse-replacement'].includes(mode)) assert.equal(JSON.parse(await readFile(join(state, 'session.json'), 'utf8')).deviceId, 'replacement'); else assert.equal(await readFile(join(state, 'session.json'), 'utf8'), original); }
  }
});

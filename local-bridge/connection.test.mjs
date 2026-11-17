import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './rd.mjs';
import { DEFAULT_CLIENT_ADAPTER, parseClientAdapter } from '../shared/local-client-adapter.mjs';
const script = fileURLToPath(new URL('./rd.mjs', import.meta.url));
const deviceCode = 'test-private-device-code-883352';
const token = 'test-private-paired-token-482435';
const deviceId = 'server-device-id-4';
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'taskflow-connect-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function invoke(args, state) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, RD_HUB_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function assertPrivate(result) {
  for (const value of [deviceCode, token]) assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
}

test('pair validates client input and derives the web origin safely', () => {
  assert.equal(parseArgs(['pair', '--name', 'Mac', '--tool', 'codex-cli']).options['web-url'], 'http://127.0.0.1:5186');
  assert.equal(parseArgs(['pair', '--url', 'https://hub.example', '--name', 'Mac', '--tool', 'cursor']).options['web-url'], 'https://hub.example');
  assert.throws(() => parseArgs(['pair', '--name', 'Mac', '--tool', 'other']), /tool/);
  assert.throws(() => parseArgs(['pair', '--name', 'Mac', '--tool', 'cursor', '--web-url', 'http://hub.example']), /HTTPS/);
  assert.throws(() => parseArgs(['install-mcp', '--client', 'codex']), /project/);
});

test('custom adapter parser and CLI reject executable fields, unsafe paths and ambiguous options', () => {
  assert.deepEqual(parseClientAdapter(JSON.stringify(DEFAULT_CLIENT_ADAPTER)), DEFAULT_CLIENT_ADAPTER);
  assert.equal(parseArgs(['pair', '--name', '我的工作台', '--tool', 'custom']).options.tool, 'custom');
  assert.throws(() => parseArgs(['pair', '--name', 'x'.repeat(81), '--tool', 'custom']), /80/);
  assert.equal(parseArgs(['install-mcp', '--adapter', 'adapter.json', '--project', '/work']).options.adapter, 'adapter.json');
  assert.throws(() => parseArgs(['install-mcp', '--adapter', 'a.json', '--client', 'cursor', '--project', '/work']), /只能/);
  assert.throws(() => parseArgs(['install-mcp', '--client', 'unknown', '--project', '/work']), /client/);
  assert.throws(() => parseArgs(['export-mcp']), /adapter/);
  assert.throws(() => parseArgs(['doctor', '--adapter', 'a\nb.json']), /adapter/);
  for (const configPath of ['/tmp/mcp.json', '../mcp.json', 'a/../mcp.json', './mcp.json', 'a\\mcp.json', '~/mcp.json', '$HOME/mcp.json', 'a/b/c/d/mcp.json', '.git/mcp.json', '.local/mcp.json', '.data/mcp.json', 'node_modules/mcp.json', 'auth.json', '.session.json', 'credentials-x.json', 'package-lock.json', 'package.json', 'a\n.json']) assert.throws(() => parseClientAdapter({ ...DEFAULT_CLIENT_ADAPTER, configPath }));
  for (const serversKey of ['__proto__', 'constructor', 'prototype', 'nested.mcpServers', 'a/b']) assert.throws(() => parseClientAdapter({ ...DEFAULT_CLIENT_ADAPTER, serversKey }));
  for (const field of ['command', 'args', 'env', 'script', 'url', 'hooks']) assert.throws(() => parseClientAdapter({ ...DEFAULT_CLIENT_ADAPTER, [field]: 'untrusted' }), /六个字段/);
  assert.throws(() => parseClientAdapter(' '.repeat(8193)), /8 KiB/);
  assert.throws(() => parseClientAdapter({ ...DEFAULT_CLIENT_ADAPTER, includeType: 'true' }), /布尔/);
});

test('custom adapter template/export are portable JSON without reading session contents', async t => {
  const state = await directory(t); const project = await directory(t);
  await writeFile(join(state, 'session.json'), JSON.stringify({ token, deviceCode }), { mode: 0o600 });
  const template = await invoke(['adapter-template'], state);
  assert.equal(template.code, 0, template.stderr);
  assert.deepEqual(JSON.parse(template.stdout), DEFAULT_CLIENT_ADAPTER);
  const adapter = { ...DEFAULT_CLIENT_ADAPTER, serversKey: 'servers', includeType: false };
  const manifest = join(project, 'adapter.json'); await writeFile(manifest, JSON.stringify(adapter));
  const exported = await invoke(['export-mcp', '--adapter', manifest], state);
  assert.equal(exported.code, 0, exported.stderr);
  const config = JSON.parse(exported.stdout);
  assert.deepEqual(Object.keys(config), ['servers']);
  assert.equal(config.servers.taskflow.command, process.execPath);
  assert.equal(config.servers.taskflow.type, undefined);
  assert.deepEqual(config.servers.taskflow.env, { RD_HUB_STATE_DIR: state });
  assert.equal(config.servers.taskflow.args.length, 1); assert.match(config.servers.taskflow.args[0], /local-bridge\/mcp\.mjs$/);
  assert.deepEqual(await readdir(project), ['adapter.json']);
  assertPrivate(exported); assertPrivate(template);
  await writeFile(manifest, JSON.stringify({ ...adapter, command: 'never-run-private-value' }));
  const rejected = await invoke(['export-mcp', '--adapter', manifest], state);
  assert.equal(rejected.code, 1); assert.ok(!rejected.stderr.includes('never-run-private-value'));
  await rm(manifest); await symlink(join(state, 'session.json'), manifest);
  const linked = await invoke(['export-mcp', '--adapter', manifest], state);
  assert.equal(linked.code, 1); assertPrivate(linked);
});

test('custom JSON installer preserves config with private backup, nested paths and idempotence', async t => {
  const state = await directory(t); const project = await directory(t);
  const manifest = join(project, 'adapter.json');
  const adapter = { ...DEFAULT_CLIENT_ADAPTER, configPath: '.workbench/config/mcp.json', serversKey: 'servers' };
  await writeFile(manifest, JSON.stringify(adapter));
  await mkdir(join(project, '.workbench', 'config'), { recursive: true });
  const configPath = join(project, adapter.configPath);
  const original = { keep: 'private-config-value', servers: { other: { command: 'keep' } } };
  await writeFile(configPath, JSON.stringify(original), { mode: 0o600 });
  const args = ['install-mcp', '--adapter', manifest, '--project', project];
  const installed = await invoke(args, state); assert.equal(installed.code, 0, installed.stderr);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.client, 'custom'); assert.equal(result.adapterId, adapter.id);
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), original);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.keep, original.keep); assert.deepEqual(saved.servers.other, original.servers.other);
  assert.equal(saved.servers.taskflow.type, 'stdio'); assert.equal(saved.servers.taskflow.command, process.execPath);
  const twice = await invoke(args, state); assert.equal(twice.code, 0, twice.stderr);
  assert.equal(JSON.parse(twice.stdout).status, 'ALREADY_CONFIGURED');
  assert.equal((await readdir(join(project, '.workbench', 'config'))).filter(name => name.includes('backup')).length, 1);
  saved.servers.taskflow.command = 'never-run'; await writeFile(configPath, JSON.stringify(saved));
  const conflict = await invoke(args, state); assert.equal(conflict.code, 1); assert.match(conflict.stderr, /拒绝覆盖/);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).servers.taskflow.command, 'never-run');
  for (const entry of [installed, twice, conflict]) { assert.ok(!entry.stdout.includes('private-config-value')); assertPrivate(entry); }
  const emptyProject = await directory(t);
  const nested = await invoke(['install-mcp', '--adapter', manifest, '--project', emptyProject], state);
  assert.equal(nested.code, 0, nested.stderr);
  assert.equal((await stat(join(emptyProject, adapter.configPath))).mode & 0o777, 0o600);
});

test('custom installer refuses symlink ancestors/files, lock and invalid JSON without altering targets', async t => {
  const state = await directory(t); const project = await directory(t); const outside = await directory(t);
  const manifest = join(project, 'adapter.json');
  const adapter = { ...DEFAULT_CLIENT_ADAPTER, configPath: 'a/b/mcp.json' };
  await writeFile(manifest, JSON.stringify(adapter)); await mkdir(join(project, 'a'));
  await symlink(outside, join(project, 'a', 'b'));
  const args = ['install-mcp', '--adapter', manifest, '--project', project];
  const linkedParent = await invoke(args, state); assert.equal(linkedParent.code, 1); assert.match(linkedParent.stderr, /符号链接/);
  assert.deepEqual(await readdir(outside), []);
  await rm(join(project, 'a', 'b')); await mkdir(join(project, 'a', 'b'));
  const config = join(project, adapter.configPath); const target = join(outside, 'unchanged.json');
  await writeFile(target, '{}'); await symlink(target, config);
  assert.equal((await invoke(args, state)).code, 1); assert.equal(await readFile(target, 'utf8'), '{}');
  await rm(config); await writeFile(`${config}.taskflow-lock`, 'lock');
  const locked = await invoke(args, state); assert.equal(locked.code, 1); assert.match(locked.stderr, /锁文件/);
  await assert.rejects(stat(config)); await rm(`${config}.taskflow-lock`);
  await writeFile(config, '{broken');
  const invalid = await invoke(args, state); assert.equal(invalid.code, 1); assert.match(invalid.stderr, /JSON/);
  assert.equal(await readFile(config, 'utf8'), '{broken');
  assert.deepEqual((await readdir(join(project, 'a', 'b'))), ['mcp.json']);
});

test('custom doctor verifies fixed SDK transport and config without executing plugin commands', async t => {
  const state = await directory(t); const project = await directory(t);
  const manifest = join(project, 'adapter.json'); const adapter = { ...DEFAULT_CLIENT_ADAPTER, configPath: 'client/mcp.json' };
  await writeFile(manifest, JSON.stringify(adapter));
  const url = await listen(t, (req, res) => {
    assert.equal(req.url, '/api/tasks'); assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tasks: [] }));
  });
  await writeFile(join(state, 'session.json'), JSON.stringify({ url, token, deviceId, projectIds: ['one'] }), { mode: 0o600 });
  assert.equal((await invoke(['install-mcp', '--adapter', manifest, '--project', project], state)).code, 0);
  const checked = await invoke(['doctor', '--adapter', manifest, '--project', project], state);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.configurations.length, 4);
  assert.equal(report.configurations.find(item => item.client === 'custom').status, 'MATCHED');
  assert.deepEqual(report.mcp, { status: 'CONNECTED', toolCount: 9 });
  assert.equal(report.authentication.status, 'AUTHORIZED'); assert.match(report.note, /软件内确认/);
  assertPrivate(checked);
});

test('pair polls at interval, stores the server device ID privately and never prints bearer secrets', async t => {
  const state = await directory(t);
  const requests = [];
  let polls = 0;
  const url = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, body, at: Date.now() });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/device-authorizations') {
      res.writeHead(201).end(JSON.stringify({ deviceCode, userCode: 'ABCD-1234', expiresAt: new Date(Date.now() + 15000).toISOString(), interval: 1 }));
    } else {
      assert.equal(req.url, '/api/device-authorizations/poll');
      assert.deepEqual(body, { deviceCode });
      polls++;
      res.end(JSON.stringify(polls === 1 ? { status: 'PENDING' } : { status: 'AUTHORIZED', token, user: { username: 'developer', role: 'DEV' }, deviceId, projectIds: ['project-one', 'project-two'], expiresAt: new Date(Date.now() + 60000).toISOString() }));
    }
  });
  const result = await invoke(['pair', '--url', url, '--web-url', 'http://127.0.0.1:5186', '--name', ' Mac ', '--tool', 'codex-cli'], state);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ABCD-1234/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:5186\/#view=local/);
  assert.match(result.stdout, /设备配对成功/);
  assert.equal(polls, 2);
  assert.deepEqual(requests[0].body, { deviceName: 'Mac', tool: 'codex-cli' });
  assert.ok(requests[1].at - requests[0].at >= 900);
  assert.ok(requests[2].at - requests[1].at >= 900);
  const saved = JSON.parse(await readFile(join(state, 'session.json'), 'utf8'));
  assert.equal(saved.deviceId, deviceId);
  assert.equal(saved.token, token);
  assert.deepEqual(saved.projectIds, ['project-one', 'project-two']);
  assert.equal((await stat(join(state, 'session.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(state)).mode & 0o777, 0o700);
  assertPrivate(result);
  const before = await readFile(join(state, 'session.json'), 'utf8');
  const repeated = await invoke(['pair', '--url', url, '--name', 'Other', '--tool', 'cursor'], state);
  assert.equal(repeated.code, 1); assert.match(repeated.stderr, /先运行 logout/);
  assert.equal(await readFile(join(state, 'session.json'), 'utf8'), before);
  assert.equal(requests.length, 3, 'existing login must be refused before a network request');
});

test('denied, expired, consumed and throttled authorizations exit without saving secrets', async t => {
  for (const mode of ['denied', 'expired', 'expired-http', 'consumed', 'throttled']) {
    const state = await directory(t);
    let polls = 0;
    const url = await listen(t, async (req, res) => {
      for await (const chunk of req) { /* Never log request bodies. */ }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/device-authorizations') {
        res.writeHead(201).end(JSON.stringify({ deviceCode, userCode: 'ABCD-1234', expiresAt: new Date(Date.now() + (mode === 'expired' ? -1000 : 10000)).toISOString(), interval: 1 }));
      } else {
        polls++;
        if (mode === 'denied') res.end(JSON.stringify({ status: 'DENIED' }));
        else {
          const status = mode === 'expired-http' ? 410 : mode === 'consumed' ? 409 : 429;
          res.writeHead(status).end(JSON.stringify({ error: { message: `L${status} 设备授权不能继续` }, deviceCode, token }));
        }
      }
    });
    const result = await invoke(['pair', '--url', url, '--name', 'Mac', '--tool', 'cursor'], state);
    assert.equal(result.code, 1);
    assert.match(result.stderr, mode === 'denied' ? /已拒绝/ : mode === 'expired' ? /已过期/ : /L(410|409|429)/);
    assert.equal(polls, mode === 'expired' ? 0 : 1);
    assert.ok(!(await readdir(state)).includes('session.json'));
    assertPrivate(result);
  }
});

test('JSON installers preserve unrelated config, are idempotent, back up privately and reject conflicts or symlinks', async t => {
  const state = await directory(t);
  for (const client of ['claude', 'cursor']) {
    const project = await directory(t);
    const config = client === 'claude' ? join(project, '.mcp.json') : join(project, '.cursor', 'mcp.json');
    if (client === 'cursor') await mkdir(join(project, '.cursor'));
    const original = { keep: { value: 42 }, mcpServers: { other: { command: 'other-command', env: { TEST_SECRET: 'preserve-test-value' } } } };
    await writeFile(config, `${JSON.stringify(original)}\n`, { mode: 0o600 });
    const first = await invoke(['install-mcp', '--client', client, '--project', project], state);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(!first.stdout.includes('preserve-test-value'));
    const result = JSON.parse(first.stdout);
    assert.equal(result.status, 'CONFIGURED');
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), original);
    const saved = JSON.parse(await readFile(config, 'utf8'));
    assert.deepEqual(saved.keep, original.keep);
    assert.deepEqual(saved.mcpServers.other, original.mcpServers.other);
    assert.equal(saved.mcpServers.taskflow.command, process.execPath);
    assert.deepEqual(saved.mcpServers.taskflow.env, { RD_HUB_STATE_DIR: state });
    assert.ok(!JSON.stringify(saved.mcpServers.taskflow).includes(token));
    const twice = await invoke(['install-mcp', '--client', client, '--project', project], state);
    assert.equal(twice.code, 0, twice.stderr);
    assert.equal(JSON.parse(twice.stdout).status, 'ALREADY_CONFIGURED');
    saved.mcpServers.taskflow.command = 'different';
    await writeFile(config, JSON.stringify(saved));
    const conflict = await invoke(['install-mcp', '--client', client, '--project', project], state);
    assert.equal(conflict.code, 1); assert.match(conflict.stderr, /拒绝覆盖/);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).mcpServers.taskflow.command, 'different');
    await rm(config);
    const target = join(project, 'untouched.json'); await writeFile(target, '{}'); await symlink(target, config);
    const linked = await invoke(['install-mcp', '--client', client, '--project', project], state);
    assert.equal(linked.code, 1); assert.match(linked.stderr, /符号链接/);
    assert.equal(await readFile(target, 'utf8'), '{}');
  }
  const project = await directory(t); const target = await directory(t);
  await symlink(target, join(project, '.cursor'));
  const parentLink = await invoke(['install-mcp', '--client', 'cursor', '--project', project], state);
  assert.equal(parentLink.code, 1); assert.match(parentLink.stderr, /符号链接/);
});

test('Codex installer safely merges the TOML copy using isolated native CLI, preserving other services', async t => {
  const project = await directory(t); const state = await directory(t);
  await mkdir(join(project, '.codex'));
  const config = join(project, '.codex', 'config.toml');
  const original = '# keep comment\nmodel = "test-model"\n[mcp_servers.other]\ncommand = "/usr/bin/true"\nargs = ["kept"]\n[mcp_servers.other.env]\nTEST_SECRET = "preserve-test-value"\n';
  await writeFile(config, original, { mode: 0o600 });
  const first = await invoke(['install-mcp', '--client', 'codex', '--project', project], state);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(!first.stdout.includes('preserve-test-value'));
  const text = await readFile(config, 'utf8');
  assert.match(text, /\[mcp_servers\.other\]/); assert.match(text, /TEST_SECRET = "preserve-test-value"/);
  assert.match(text, /\[mcp_servers\.taskflow\]/); assert.match(text, /RD_HUB_STATE_DIR/);
  assert.equal(await readFile(JSON.parse(first.stdout).backupPath, 'utf8'), original);
  const second = await invoke(['install-mcp', '--client', 'codex', '--project', project], state);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'ALREADY_CONFIGURED');
  await writeFile(config, '[mcp_servers.taskflow]\ncommand = "different"\n');
  const conflict = await invoke(['install-mcp', '--client', 'codex', '--project', project], state);
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /拒绝覆盖/);
  assert.equal(await readFile(config, 'utf8'), '[mcp_servers.taskflow]\ncommand = "different"\n');
});

test('doctor uses the real SDK stdio handshake and authenticated task_list without exposing task bodies', async t => {
  const project = await directory(t); const state = await directory(t);
  const url = await listen(t, (req, res) => {
    assert.equal(req.url, '/api/tasks'); assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tasks: [{ id: 'one', projectId: 'project-one', title: 'private-task-title' }, { id: 'two', projectId: 'project-two' }] }));
  });
  await writeFile(join(state, 'session.json'), JSON.stringify({ url, token, deviceId, projectIds: ['project-one', 'project-two'] }), { mode: 0o600 });
  const result = await invoke(['doctor', '--project', project], state);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true); assert.equal(report.mcp.status, 'CONNECTED'); assert.equal(report.mcp.toolCount, 9);
  assert.deepEqual(report.authentication, { status: 'AUTHORIZED', taskCount: 2, projectCount: 2 });
  assert.ok(report.software.some(item => item.name === 'codex' && item.installed));
  assert.ok(report.configurations.every(item => item.status === 'MISSING'));
  assert.ok(!result.stdout.includes('private-task-title')); assert.ok(!result.stdout.includes('project-one')); assertPrivate(result);
  await rm(join(state, 'session.json'));
  const missing = await invoke(['doctor', '--project', project], state);
  assert.equal(missing.code, 1);
  const missingReport = JSON.parse(missing.stdout);
  assert.equal(missingReport.mcp.status, 'CONNECTED'); assert.equal(missingReport.authentication.status, 'FAILED');
});

test('real platform device pair, doctor, heartbeat and logout preserve the browser session', async t => {
  const { createPlatform } = await import('../platform-server/server.mjs');
  const platform = createPlatform({ dbPath: ':memory:', logger: { error() {} } });
  platform.server.listen(0, '127.0.0.1'); await once(platform.server, 'listening');
  t.after(() => platform.close());
  const state = await directory(t); const project = await directory(t);
  const url = `http://127.0.0.1:${platform.server.address().port}`;
  const password = 'isolated-pair-cli-test-password';
  const post = (path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/setup', { username: 'pair-admin', password })).status, 201);
  const login = await post('/api/login', { username: 'pair-admin', password });
  const browserCookie = login.headers.get('set-cookie').split(';')[0];
  const browserToken = (await login.json()).token;
  const taskResponse = await post('/api/tasks', { jiraKey: 'PAIR-1', title: 'Isolated device round trip' }, { Authorization: `Bearer ${browserToken}` });
  assert.equal(taskResponse.status, 201); const { task } = await taskResponse.json();
  const paired = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'pair', '--url', url, '--web-url', url, '--name', 'isolated-cli', '--tool', 'codex-cli'], { env: { ...process.env, RD_HUB_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', approval;
    child.stdout.on('data', data => {
      stdout += data;
      const code = stdout.match(/"userCode":\s*"([A-Z2-9]{4}-[A-Z2-9]{4})"/)?.[1];
      if (code && !approval) approval = post('/api/device-authorizations/decision', { userCode: code, decision: 'APPROVE', projectIds: ['default'] }, { Cookie: browserCookie, Origin: url });
    });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', async code => { try { assert.equal((await approval)?.status, 200); resolve({ code, stdout, stderr }); } catch (error) { reject(error); } });
  });
  assert.equal(paired.code, 0, paired.stderr);
  const saved = JSON.parse(await readFile(join(state, 'session.json'), 'utf8'));
  assert.deepEqual(saved.projectIds, ['default']); assert.notEqual(saved.deviceId, deviceId);
  assert.ok(!paired.stdout.includes(saved.token)); assert.ok(!paired.stdout.includes(browserToken));
  const checked = await invoke(['doctor', '--project', project], state);
  assert.equal(checked.code, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout).authentication, { status: 'AUTHORIZED', taskCount: 1, projectCount: 1 });
  const heartbeat = await invoke(['heartbeat', '--task', task.id, '--tool', 'codex-cli', '--status', 'WORKING'], state);
  assert.equal(heartbeat.code, 0, heartbeat.stderr);
  assert.equal(JSON.parse(heartbeat.stdout).device.deviceId, saved.deviceId);
  const logout = await invoke(['logout'], state); assert.equal(logout.code, 0, logout.stderr);
  assert.equal((await fetch(url + '/api/me', { headers: { Cookie: browserCookie } })).status, 200);
  assert.equal((await fetch(url + '/api/me', { headers: { Authorization: `Bearer ${saved.token}` } })).status, 401);
  for (const result of [paired, checked, heartbeat, logout]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(saved.token));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(browserToken));
  }
});

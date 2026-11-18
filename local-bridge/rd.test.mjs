import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, writeFile, access, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { parseArgs, validateReport } from './rd.mjs';
const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'rd.mjs');

function invoke(args, stateDir, stdin = '', extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    if (stateDir === null) delete env.RD_HUB_STATE_DIR;
    else env.RD_HUB_STATE_DIR = stateDir;
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('reject unsafe parameters before network activity', () => {
  assert.throws(() => parseArgs(['login', '--password', 'not-used']), /密码不能/);
  assert.throws(() => parseArgs(['login', '--username', 'dev', '--url', 'http://example.com']), /HTTPS/);
  assert.throws(() => parseArgs(['login', '--username', 'dev', '--url', 'https://name:secret@example.com']), /认证参数/);
  assert.throws(() => parseArgs(['context', '--task', '../other']), /task/);
  for (const progress of ['-1', '101', 'NaN', '1.5', '']) {
    assert.throws(() => parseArgs(['sync', '--task', 'task-1', '--tool', 'codex-cli', '--progress', progress, '--summary', '测试']), /progress|参数/);
  }
  assert.throws(() => parseArgs(['sync', '--task', 'task-1', '--tool', 'other', '--progress', '20', '--summary', '测试']), /tool/);
  assert.equal(parseArgs(['sync', '--task', 'task-1', '--tool', 'cursor', '--progress', '100', '--summary', '完成']).options.progress, '100');
  for (const command of ['assets', 'reviews', 'claim', 'heartbeat']) assert.throws(() => parseArgs([command, '--task', '../escape']), /task/);
  assert.throws(() => parseArgs(['review-context', '--job', '../../escape']), /job/);
  assert.throws(() => parseArgs(['submit-report', '--job', 'job-1']), /file/);
  for (const version of ['0', '-1', '1.5', '9007199254740992']) assert.throws(() => parseArgs(['claim', '--task', 'task-1', '--version', version]), /version/);
  assert.throws(() => parseArgs(['heartbeat', '--task', 'task-1', '--tool', 'cursor', '--status', 'RUNNING']), /status/);
  assert.equal(parseArgs(['claim', '--task', 'task-1', '--version', '2']).options.version, '2');
});

test('report validation preserves submitted evidence and rejects forged cloud execution', () => {
  const report = { summary: '  保留报告原文 L10001  ', source: 'LOCAL_TOOL', tool: 'cursor', evidence: '本地结果，自报来源', findings: [{ severity: 'WARN', title: '权限覆盖待补', detail: '仍需人工判断', location: 'src/task.ts:12', actorId: 'forged' }], actorId: 'forged', decision: 'APPROVE' };
  const valid = validateReport(report);
  assert.equal(valid.summary, report.summary);
  assert.equal(valid.evidence, report.evidence);
  assert.equal(valid.actorId, undefined);
  assert.equal(valid.decision, undefined);
  assert.equal(valid.findings[0].actorId, undefined);
  assert.throws(() => validateReport({ ...report, source: 'CLOUD_AI' }), /source/);
  assert.throws(() => validateReport({ ...report, tool: undefined }), /tool/);
  assert.throws(() => validateReport({ ...report, findings: [{ severity: 'PASS', title: 'x', detail: 'y' }] }), /findings/);
  assert.throws(() => validateReport({ ...report, summary: ' '.repeat(20) }), /summary/);
  assert.throws(() => validateReport({ ...report, findings: Array(51).fill(report.findings[0]) }), /findings/);
  for (const tool of ['codex', 'codex-cli', 'claude-code', 'cursor', 'antigravity', 'custom']) {
    assert.equal(validateReport({ ...report, tool }).tool, tool);
    assert.equal(parseArgs(['sync', '--task', 'task-1', '--tool', tool, '--progress', '20', '--summary', '明确上报']).options.tool, tool);
    assert.equal(parseArgs(['heartbeat', '--task', 'task-1', '--tool', tool, '--status', 'WORKING']).options.tool, tool);
  }
});

test('review and heartbeat commands forward only explicit inputs and share the private device ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-review-bridge-'));
  const token = 'local-test-review-token-938883';
  const password = 'local-test-review-password-338';
  const requests = [];
  const report = { summary: 'L10001 保留本地报告摘要', source: 'LOCAL_TOOL', tool: 'codex-cli', evidence: '用户提供的本地证据', findings: [] };
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify({ ...report, actorId: 'forged', decision: 'APPROVE' }));
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/login') { res.end(JSON.stringify({ token, user: { username: 'dev', role: 'DEV' } })); return; }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url.endsWith('/assets')) res.end(JSON.stringify({ assets: [{ revision: 2, content: 'PRD 原文' }] }));
    else if (req.url === '/api/jobs?taskId=task-1') res.end(JSON.stringify({ jobs: [{ id: 'job-1' }] }));
    else if (req.url === '/api/jobs/job-1') res.end(JSON.stringify({ job: { id: 'job-1', snapshot: { inputHash: 'test-hash' } } }));
    else if (req.url.endsWith('/report')) res.end(JSON.stringify({ job: { report: body, status: 'REPORT_SUBMITTED' } }));
    else if (req.url.endsWith('/claim')) res.end(JSON.stringify({ task: { version: 3 } }));
    else if (req.url.endsWith('/heartbeat')) res.end(JSON.stringify({ device: body }));
    else res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await invoke(['login', '--url', url, '--username', 'dev'], directory, `${password}\n`)).code, 0);
  const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  const outputs = [];
  for (const args of [
    ['assets', '--task', 'task-1'], ['reviews', '--task', 'task-1'], ['review-context', '--job', 'job-1'],
    ['claim', '--task', 'task-1', '--version', '2'],
    ['heartbeat', '--task', 'task-1', '--tool', 'cursor', '--status', 'WORKING'],
    ['heartbeat', '--task', 'task-1', '--tool', 'cursor', '--status', 'OFFLINE'],
    ['submit-report', '--job', 'job-1', '--file', reportPath],
  ]) {
    const result = await invoke(args, directory);
    assert.equal(result.code, 0, result.stderr);
    outputs.push(result.stdout);
  }
  assert.deepEqual(requests.find(request => request.path.endsWith('/claim')).body, { expectedVersion: 2 });
  const beats = requests.filter(request => request.path.endsWith('/heartbeat'));
  assert.equal(beats.length, 2);
  assert.deepEqual(beats[0].body, { deviceId: session.deviceId, tool: 'cursor', status: 'WORKING' });
  assert.equal(beats[1].body.deviceId, session.deviceId);
  assert.deepEqual(requests.find(request => request.path.endsWith('/report')).body, report);
  for (const output of outputs) { assert.ok(!output.includes(token)); assert.ok(!output.includes(password)); }
  const before = requests.length;
  const oversize = join(directory, 'oversize.json');
  await writeFile(oversize, 'x'.repeat(65_537));
  assert.match((await invoke(['submit-report', '--job', 'job-1', '--file', oversize], directory)).stderr, /64 KiB/);
  const malformed = join(directory, 'bad.json');
  await writeFile(malformed, '{ invalid JSON');
  assert.match((await invoke(['submit-report', '--job', 'job-1', '--file', malformed], directory)).stderr, /有效 JSON/);
  assert.match((await invoke(['submit-report', '--job', 'job-1', '--file', directory], directory)).stderr, /普通 JSON/);
  assert.equal(requests.length, before, 'invalid reports must not be sent to the API');
});

test('login, progress, context and logout use private state without printing credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-bridge-'));
  const stateDir = join(directory, 'state');
  const password = 'test-password-only-883';
  const token = 'test-token-only-794238533246';
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url, method: req.method, body, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/login') {
      assert.deepEqual(body, { username: 'dev', password });
      res.end(JSON.stringify({ token, user: { username: 'dev', role: 'DEV' } }));
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === '/api/logout') { res.writeHead(204).end(); return; }
    if (req.url === '/api/tasks') { res.end(JSON.stringify({ tasks: [{ id: 'task-1' }], token })); return; }
    if (req.url.endsWith('/context')) { res.end(JSON.stringify({ task: { id: 'task-1' }, assets: [], integrationStatus: 'UNCONFIGURED' })); return; }
    if (req.url.endsWith('/progress')) { res.end(JSON.stringify({ progress: body })); return; }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await invoke(['login', '--url', url, '--username', 'dev'], stateDir, `${password}\n`);
  assert.equal(login.code, 0, login.stderr);
  const stored = JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8'));
  assert.equal(stored.token, token);
  assert.equal((await stat(join(stateDir, 'session.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  const tasks = await invoke(['tasks'], stateDir);
  assert.equal(tasks.code, 0, tasks.stderr);
  assert.match(tasks.stdout, /REDACTED/);
  const context = await invoke(['context', '--task', 'task-1'], stateDir);
  assert.match(context.stdout, /UNCONFIGURED/);
  const sync = await invoke(['sync', '--task', 'task-1', '--tool', 'claude-code', '--progress', '45', '--summary', '完成接口字段核对', '--branch', 'feature/DEMO-1'], stateDir);
  assert.equal(sync.code, 0, sync.stderr);
  const sent = requests.find((item) => item.path.endsWith('/progress')).body;
  assert.deepEqual(sent, { tool: 'claude-code', deviceId: stored.deviceId, progress: 45, summary: '完成接口字段核对', branch: 'feature/DEMO-1' });
  await writeFile(join(stateDir, 'keep.txt'), 'keep');
  const logout = await invoke(['logout'], stateDir);
  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(JSON.parse(logout.stdout).serverRevoked, true);
  await assert.rejects(access(join(stateDir, 'session.json')));
  assert.equal(await readFile(join(stateDir, 'keep.txt'), 'utf8'), 'keep');
  for (const result of [login, tasks, context, sync, logout]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  }
  const invalid = await invoke(['tasks'], stateDir);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /尚未登录/);
});

test('CLI interoperates with the real platform API', async (t) => {
  const { createPlatform } = await import('../platform-server/server.mjs');
  const platform = createPlatform({ dbPath: ':memory:', logger: { error() {} } });
  platform.server.listen(0, '127.0.0.1');
  await once(platform.server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-real-bridge-'));
  t.after(async () => { await platform.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${platform.server.address().port}`;
  const password = 'local-test-password-14';
  const setup = await fetch(`${url}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bridge-admin', password }) });
  assert.equal(setup.status, 201);
  const login = await invoke(['login', '--url', url, '--username', 'bridge-admin'], directory, `${password}\n`);
  assert.equal(login.code, 0, login.stderr);
  const { token } = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  const created = await fetch(`${url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jiraKey: 'DEMO-14', title: '本地桥接验证任务' }) });
  assert.equal(created.status, 201);
  const { task } = await created.json();
  const synced = await invoke(['sync', '--task', task.id, '--tool', 'codex-cli', '--progress', '30', '--summary', '已验证真实本地 API 上报'], directory);
  assert.equal(synced.code, 0, synced.stderr);
  const context = await invoke(['context', '--task', task.id], directory);
  assert.equal(context.code, 0, context.stderr);
  assert.equal(JSON.parse(context.stdout).task.progress, 30);
  assert.equal(JSON.parse(context.stdout).task.jiraStatus, 'unverified');
  assert.ok(!`${login.stdout}${synced.stdout}${context.stdout}`.includes(token));
  assert.ok(!`${login.stdout}${synced.stdout}${context.stdout}`.includes(password));
  const logout = await invoke(['logout'], directory);
  assert.equal(logout.code, 0, logout.stderr);
  const revoked = await fetch(`${url}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(revoked.status, 401);
});

test('API error.message is displayed unchanged, including L codes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-error-bridge-'));
  const token = 'test-token-for-errors-883235';
  const password = 'test-password-for-errors-33';
  let status = 401;
  let message = 'L10001：任务仍待授权';
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* Consume input without logging it. */ }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/login') {
      res.end(JSON.stringify({ token, user: { username: 'dev', role: 'DEV' } }));
      return;
    }
    res.writeHead(status).end(JSON.stringify({ error: { message, code: 'NOT_FOR_DISPLAY' }, token, password }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await invoke(['login', '--url', url, '--username', 'dev'], directory, `${password}\n`);
  assert.equal(login.code, 0, login.stderr);
  for (const [httpStatus, apiMessage] of [[401, 'L10001：任务仍待授权'], [403, 'L20004'], [409, '保留接口原文 / conflict']]) {
    status = httpStatus;
    message = apiMessage;
    const result = await invoke(['tasks'], directory);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `${apiMessage}\n`);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(token));
    assert.ok(!result.stderr.includes(password));
    assert.ok(!result.stderr.includes('NOT_FOR_DISPLAY'));
  }
  status = 503;
  message = undefined;
  const fallback = await invoke(['tasks'], directory);
  assert.equal(fallback.stderr, '平台请求失败（HTTP 503）。\n');
});

test('real workflow: claim, asset versions, report snapshot and device heartbeat round trip', async (t) => {
  const { createPlatform } = await import('../platform-server/server.mjs');
  const platform = createPlatform({ dbPath: ':memory:', logger: { error() {} } });
  platform.server.listen(0, '127.0.0.1');
  await once(platform.server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-workflow-bridge-'));
  t.after(async () => { await platform.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const password = 'workflow-local-test-password-24';
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'workflow-admin', password }) });
  assert.equal(setup.status, 201);
  const login = await invoke(['login', '--url', base, '--username', 'workflow-admin'], directory, `${password}\n`);
  assert.equal(login.code, 0, login.stderr);
  const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  const api = async (path, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const { task } = await api('/api/tasks', { jiraKey: 'CLI-21', title: '真实本地评审协同' });
  const claimed = await invoke(['claim', '--task', task.id, '--version', String(task.version)], directory);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(JSON.parse(claimed.stdout).task.assigneeId, task.assigneeId);
  const stale = await invoke(['claim', '--task', task.id, '--version', String(task.version)], directory);
  assert.equal(stale.code, 1, 'old task version must not claim again');
  for (const kind of ['PRD', 'TECH_SPEC', 'CODE']) await api(`/api/tasks/${task.id}/assets`, { kind, title: `${kind} 输入`, content: `L10001 保留 ${kind} 输入原文` });
  const assets = await invoke(['assets', '--task', task.id], directory);
  assert.equal(assets.code, 0, assets.stderr);
  assert.equal(JSON.parse(assets.stdout).assets.length, 3);
  assert.match(assets.stdout, /L10001 保留 CODE 输入原文/);
  const { job } = await api('/api/reviews', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'LOCAL_REPORT' });
  const reviews = await invoke(['reviews', '--task', task.id], directory);
  assert.equal(reviews.code, 0, reviews.stderr);
  assert.equal(JSON.parse(reviews.stdout).jobs[0].id, job.id);
  const context = await invoke(['review-context', '--job', job.id], directory);
  assert.equal(context.code, 0, context.stderr);
  assert.ok(JSON.parse(context.stdout).job.snapshot);
  const beat = await invoke(['heartbeat', '--task', task.id, '--tool', 'codex-cli', '--status', 'WORKING'], directory);
  assert.equal(beat.code, 0, beat.stderr);
  assert.equal(JSON.parse(beat.stdout).device.deviceId, session.deviceId);
  const synced = await invoke(['sync', '--task', task.id, '--tool', 'codex-cli', '--progress', '35', '--summary', '报告已在本地形成，待独立审批'], directory);
  assert.equal(synced.code, 0, synced.stderr);
  const taskContext = await invoke(['context', '--task', task.id], directory);
  assert.equal(taskContext.code, 0, taskContext.stderr);
  const actual = JSON.parse(taskContext.stdout);
  assert.equal(actual.task.progress, 35);
  assert.ok(actual.progressEvents.some(event => event.progress === 35));
  assert.ok(actual.devices.some(device => device.deviceId === session.deviceId && device.status === 'WORKING' && device.online));
  const report = { summary: ' L20004 本地工具自报，待人工审核 ', source: 'LOCAL_TOOL', tool: 'codex-cli', evidence: '明确提交的本地证据', findings: [{ severity: 'WARN', title: '仍需评审', detail: '人工确认接口空值约定', location: 'src/task.ts:12' }] };
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report));
  const submitted = await invoke(['submit-report', '--job', job.id, '--file', reportPath], directory);
  assert.equal(submitted.code, 0, submitted.stderr);
  const reviewed = await api(`/api/jobs/${job.id}`);
  assert.equal(reviewed.job.report.summary, report.summary);
  assert.equal(reviewed.job.report.source, 'LOCAL_TOOL');
  assert.equal(reviewed.job.status, 'REPORT_SUBMITTED');
  assert.equal(reviewed.job.executor, 'UNCONFIGURED');
  const duplicate = await invoke(['submit-report', '--job', job.id, '--file', reportPath], directory);
  assert.equal(duplicate.code, 1, 'a submitted report cannot be overwritten');
  const { job: cloud } = await api('/api/reviews', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'CLOUD_AI' });
  assert.equal((await invoke(['submit-report', '--job', cloud.id, '--file', reportPath], directory)).code, 1);
  assert.equal((await api(`/api/jobs/${cloud.id}`)).job.status, 'AWAITING_CONFIGURATION');
  const offline = await invoke(['heartbeat', '--task', task.id, '--tool', 'codex-cli', '--status', 'OFFLINE'], directory);
  assert.equal(offline.code, 0, offline.stderr);
  assert.equal(JSON.parse(offline.stdout).device.online, false);
  for (const result of [login, claimed, stale, assets, reviews, context, beat, synced, taskContext, submitted, duplicate, offline]) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(session.token));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
  }
});

test('start resolves Jira key, reads bound workspace git state, records WORKING heartbeat, and falls back to host bridge session when default state has no session', async (t) => {
  const { createPlatform } = await import('../platform-server/server.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-start-bridge-'));
  const hostBridgeDir = join(directory, 'host-bridge');
  const repoDir = join(directory, 'service-repo');
  execFileSync('git', ['init', '-b', 'feature/START-1', repoDir]);
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test']);
  await writeFile(join(repoDir, 'README.md'), '# demo\n');
  execFileSync('git', ['-C', repoDir, 'add', 'README.md']);
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init repo']);

  let platform;
  platform = createPlatform({
    dbPath: ':memory:',
    hostBridgeStateDir: hostBridgeDir,
    logger: { error() {} },
  });
  platform.server.listen(0, '127.0.0.1');
  await once(platform.server, 'listening');
  t.after(async () => { await platform.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const password = 'start-local-test-password-32';
  await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'start-admin', password }) });
  const loginRes = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'start-admin', password }) });
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const { token } = await loginRes.json();

  await fetch(`${base}/api/projects/default/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ repoPath: repoDir, defaultTarget: 'antigravity' }),
  });
  const created = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jiraKey: 'START-1', title: '测试 start 伴随协同', assigneeId: null }),
  });
  const { task } = await created.json();

  const authRes = await fetch(`${base}/api/local-devices/host-bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
    body: JSON.stringify({ deviceName: '测试本机桥接', tool: 'custom', projectIds: ['default'] }),
  });
  assert.equal(authRes.status, 201);
  const hostSessionFile = join(hostBridgeDir, 'session.json');
  const savedHostSession = JSON.parse(await readFile(hostSessionFile, 'utf8'));
  savedHostSession.url = base;
  await writeFile(hostSessionFile, JSON.stringify(savedHostSession), { mode: 0o600 });
  await chmod(hostSessionFile, 0o600);

  const started = await invoke(
    ['start', '--task', 'START-1', '--tool', 'custom', '--claim', 'yes', '--mode', 'once'],
    hostBridgeDir,
  );
  assert.equal(started.code, 0, started.stderr);
  const summary = JSON.parse(started.stdout);
  assert.equal(summary.taskId, task.id);
  assert.equal(summary.jiraKey, 'START-1');
  assert.equal(summary.taskStatus, 'IN_PROGRESS');
  assert.equal(summary.branch, 'feature/START-1');
  assert.ok(summary.headCommit);
  assert.equal(summary.heartbeat, 'WORKING');
  assert.ok(!started.stdout.includes(savedHostSession.token));

  const defaultSessionExists = await access(join(dirname(cliPath), '.local', 'session.json')).then(() => true, () => false);
  if (!defaultSessionExists) {
    const fallbackTasks = await invoke(['tasks'], null, '', { TASKFLOW_HOST_BRIDGE_STATE_DIR: hostBridgeDir });
    assert.equal(fallbackTasks.code, 0, fallbackTasks.stderr);
    assert.equal(JSON.parse(fallbackTasks.stdout).tasks[0].id, task.id);
  }
});

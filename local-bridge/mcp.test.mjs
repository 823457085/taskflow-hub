import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const script = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const names = ['task_list', 'context', 'assets', 'reviews', 'review_context', 'knowledge_search', 'knowledge_doc', 'task_claim', 'progress_report', 'heartbeat', 'report_submit'];
const token = 'test-mcp-token-9382237-private';
const deviceId = 'test-mcp-device';
const localReport = { summary: ' L10001 保留本地报告原文 ', source: 'LOCAL_TOOL', tool: 'codex-cli', evidence: '  已核对接口定义\n', findings: [{ severity: 'WARN', title: '边界待确认', detail: 'L10002 按接口文案显示', location: 'src/task.ts:12' }] };
const dataOf = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
const errorOf = result => { assert.equal(result.isError, true); return result.content[0].text; };

async function state(t, session) {
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (session) await writeFile(join(directory, 'session.json'), JSON.stringify({ deviceId, ...session }), { mode: 0o600 });
  return directory;
}
async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function connect(t, directory) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], env: { RD_HUB_STATE_DIR: directory }, stderr: 'pipe' });
  let stderr = '';
  const wire = [];
  const protocolErrors = [];
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'taskflow-mcp-integration-test', version: '1.0.0' });
  await client.connect(transport);
  const receive = transport.onmessage;
  const onerror = transport.onerror;
  transport.onmessage = message => { wire.push(message); receive?.(message); };
  transport.onerror = error => { protocolErrors.push(error.message); onerror?.(error); };
  t.after(() => client.close());
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, call, output: () => JSON.stringify(wire) + stderr, stderr: () => stderr, protocolErrors };
}

test('official SDK client initializes, lists tools and calls all allowed API operations over stdio', async t => {
  const requests = [];
  const url = await listen(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    requests.push({ path: req.url, method: req.method, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, body, label: `L009 原文 ${token}`, token, nested: { password: 'test-password-secret', access_token: 'test-access-secret', api_key: 'test-api-secret', authorization: 'Bearer test-auth-secret' } }));
  });
  const directory = await state(t, { url, token });
  const mcp = await connect(t, directory);
  assert.equal(mcp.client.getServerVersion().name, 'taskflow-local-bridge');
  const listed = await mcp.client.listTools();
  assert.deepEqual(listed.tools.map(item => item.name), names);
  assert.ok(listed.tools.slice(0, 7).every(item => item.annotations.readOnlyHint));
  assert.ok(listed.tools.slice(7).every(item => !item.annotations.readOnlyHint && !item.annotations.openWorldHint));
  for (const [name, args, path] of [
    ['task_list', {}, '/api/tasks'],
    ['context', { taskId: 'task-1' }, '/api/tasks/task-1/context'],
    ['assets', { taskId: 'task-1' }, '/api/tasks/task-1/assets'],
    ['reviews', { taskId: 'task-1' }, '/api/jobs?taskId=task-1'],
    ['review_context', { jobId: 'job-1' }, '/api/jobs/job-1'],
    ['knowledge_search', { projectId: 'default', q: '支付 回调' }, '/api/knowledge?projectId=default&q=%E6%94%AF%E4%BB%98+%E5%9B%9E%E8%B0%83&limit=20'],
    ['knowledge_doc', { docId: 'doc-1' }, '/api/knowledge/doc-1'],
    ['task_claim', { taskId: 'task-1', expectedVersion: 2 }, '/api/tasks/task-1/claim'],
    ['progress_report', { taskId: 'task-1', tool: 'cursor', progress: 45, summary: 'L005 完成接口核对', branch: 'feature/MCP-1' }, '/api/tasks/task-1/progress'],
    ['heartbeat', { taskId: 'task-1', tool: 'cursor', status: 'WORKING' }, '/api/tasks/task-1/heartbeat'],
    ['report_submit', { jobId: 'job-1', report: localReport }, '/api/jobs/job-1/report'],
  ]) {
    const data = dataOf(await mcp.call(name, args));
    assert.equal(data.path, path);
    assert.equal(data.label, 'L009 原文 [REDACTED]');
    assert.equal(data.token, undefined);
    assert.deepEqual(data.nested, {});
  }
  assert.deepEqual(requests[7], { path: '/api/tasks/task-1/claim', method: 'POST', body: { expectedVersion: 2 } });
  assert.deepEqual(requests[8].body, { tool: 'cursor', progress: 45, summary: 'L005 完成接口核对', branch: 'feature/MCP-1', deviceId });
  assert.deepEqual(requests[9].body, { tool: 'cursor', status: 'WORKING', deviceId });
  assert.deepEqual(requests[10].body, localReport);
  for (const secret of [token, 'test-password-secret', 'test-access-secret', 'test-api-secret', 'test-auth-secret']) assert.ok(!mcp.output().includes(secret));
  assert.equal(mcp.stderr(), '');
  assert.deepEqual(mcp.protocolErrors, [], 'stdout must contain valid JSON-RPC messages only');
});

test('missing, public or symlinked session files return tool errors without blocking MCP discovery', async t => {
  const directory = await state(t);
  const mcp = await connect(t, directory);
  assert.equal((await mcp.client.listTools()).tools.length, 11);
  assert.match(errorOf(await mcp.call('task_list')), /尚未登录.*rd\.mjs connect.*网页确认/);
  const sessionPath = join(directory, 'session.json');
  await writeFile(sessionPath, JSON.stringify({ url: 'http://127.0.0.1:1', token, deviceId }), { mode: 0o644 });
  await chmod(sessionPath, 0o644);
  assert.match(errorOf(await mcp.call('task_list')), /本地会话无效/);
  await rm(sessionPath);
  const otherPath = join(directory, 'other.json');
  await writeFile(otherPath, JSON.stringify({ url: 'http://127.0.0.1:1', token, deviceId }), { mode: 0o600 });
  await symlink(otherPath, sessionPath);
  assert.match(errorOf(await mcp.call('task_list')), /本地会话无效/);
  assert.ok(!mcp.output().includes(token));
});

test('custom source passes the same official MCP schemas and fixed API routes as builtin clients', async t => {
  const requests = [];
  const url = await listen(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  const mcp = await connect(t, await state(t, { url, token }));
  const listed = await mcp.client.listTools();
  assert.deepEqual(listed.tools.map(item => item.name), names);
  for (const name of ['progress_report', 'heartbeat']) assert.deepEqual(listed.tools.find(item => item.name === name).inputSchema.properties.tool.enum, ['codex', 'codex-cli', 'claude-code', 'cursor', 'antigravity', 'custom']);
  dataOf(await mcp.call('progress_report', { taskId: 'task-1', tool: 'custom', progress: 30, summary: '自定义客户端自报进度' }));
  dataOf(await mcp.call('heartbeat', { taskId: 'task-1', tool: 'custom', status: 'WORKING' }));
  dataOf(await mcp.call('report_submit', { jobId: 'job-1', report: { ...localReport, tool: 'custom' } }));
  assert.deepEqual(requests.map(item => item.path), ['/api/tasks/task-1/progress', '/api/tasks/task-1/heartbeat', '/api/jobs/job-1/report']);
  assert.ok(requests.every(item => item.body.tool === 'custom'));
  assert.ok(requests.slice(0, 2).every(item => item.body.deviceId === deviceId));
  assert.equal((await mcp.call('heartbeat', { taskId: 'task-1', tool: 'unknown-client', status: 'WORKING' })).isError, true);
  assert.equal(requests.length, 3);
  assert.equal(mcp.stderr(), ''); assert.deepEqual(mcp.protocolErrors, []);
  assert.ok(!mcp.output().includes(token));
});

test('HTTP 401/403 display original API messages including L codes, without error-body secrets', async t => {
  let status = 401;
  let message = 'L10001：任务仍待授权';
  const url = await listen(t, async (req, res) => {
    for await (const chunk of req) { /* Consume explicit input only. */ }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message, code: 'NOT_FOR_DISPLAY' }, token, password: 'test-error-password-secret' }));
  });
  const mcp = await connect(t, await state(t, { url, token }));
  for (const [http, text] of [[401, 'L10001：任务仍待授权'], [403, 'L20004'], [409, '保留接口原文 / conflict']]) {
    status = http; message = text;
    assert.equal(errorOf(await mcp.call('progress_report', { taskId: 'task-1', tool: 'codex-cli', progress: 10, summary: '等待权限' })), text);
  }
  status = 403; message = `L20004 ${token}`;
  assert.equal(errorOf(await mcp.call('task_list')), 'L20004 [REDACTED]');
  message = undefined;
  assert.equal(errorOf(await mcp.call('task_list')), '当前账号没有此操作权限。');
  assert.ok(!mcp.output().includes(token));
  assert.ok(!mcp.output().includes('test-error-password-secret'));
  assert.ok(!mcp.output().includes('NOT_FOR_DISPLAY'));
});

test('schemas reject arbitrary paths, forged actor/approval/source and oversized reports before HTTP', async t => {
  let requests = 0;
  const url = await listen(t, (_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); });
  const mcp = await connect(t, await state(t, { url, token }));
  for (const [name, args] of [
    ['context', { taskId: '../../api/audit' }],
    ['task_claim', { taskId: 'task-1', expectedVersion: 0 }],
    ['progress_report', { taskId: 'task-1', tool: 'cursor', progress: 25, summary: '正常进度', actorId: 'forged', deviceId: 'forged' }],
    ['report_submit', { jobId: 'job-1', report: { ...localReport, source: 'CLOUD_AI' } }],
    ['report_submit', { jobId: 'job-1', report: { ...localReport, actorId: 'forged', decision: 'APPROVE' } }],
    ['report_submit', { jobId: 'job-1', report: { ...localReport, findings: [{ ...localReport.findings[0], waiver: true }] } }],
    ['report_submit', { jobId: 'job-1', report: { ...localReport, tool: undefined } }],
    ['report_submit', { jobId: 'job-1', report: { ...localReport, findings: Array(20).fill({ severity: 'INFO', title: 'x', detail: 'x'.repeat(4000) }) } }],
    ['approve', { jobId: 'job-1', decision: 'APPROVE' }],
    ['external_write', { path: '/api/tasks' }],
  ]) assert.equal((await mcp.call(name, args)).isError, true, name);
  assert.equal(requests, 0);
});

test('SDK → stdio → real random-port platform enforces assignees, report provenance and revoked sessions', async t => {
  const { createPlatform } = await import('../platform-server/server.mjs');
  const platform = createPlatform({ dbPath: ':memory:', logger: { error() {} } });
  platform.server.listen(0, '127.0.0.1');
  await once(platform.server, 'listening');
  t.after(() => platform.close());
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const password = 'mcp-test-only-password-24';
  const api = async (path, body, bearer, status = 200) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
  await api('/api/setup', { username: 'mcp-admin', password }, undefined, 201);
  const admin = await api('/api/login', { username: 'mcp-admin', password });
  for (const [username, role] of [['mcp-dev', 'DEV'], ['mcp-qa', 'QA']]) await api('/api/users', { username, role, password }, admin.token, 201);
  const dev = await api('/api/login', { username: 'mcp-dev', password });
  const qa = await api('/api/login', { username: 'mcp-qa', password });
  const { task } = await api('/api/tasks', { jiraKey: 'MCP-1', title: 'MCP 真实本地协同验证', assigneeId: null }, admin.token, 201);
  for (const kind of ['PRD', 'TECH_SPEC', 'CODE']) await api(`/api/tasks/${task.id}/assets`, { kind, title: `${kind} 输入`, content: `L009 保留 ${kind} 原文` }, admin.token, 201);
  const mcp = await connect(t, await state(t, { url: base, token: dev.token }));
  const before = dataOf(await mcp.call('context', { taskId: task.id }));
  assert.equal(dataOf(await mcp.call('task_list')).tasks[0].id, task.id);
  assert.equal(dataOf(await mcp.call('assets', { taskId: task.id })).assets.length, 3);
  const claimed = dataOf(await mcp.call('task_claim', { taskId: task.id, expectedVersion: before.task.version }));
  assert.equal(claimed.task.assigneeId, dev.user.id);
  assert.equal((await mcp.call('task_claim', { taskId: task.id, expectedVersion: before.task.version })).isError, true);
  const progress = dataOf(await mcp.call('progress_report', { taskId: task.id, tool: 'codex-cli', progress: 40, summary: 'L010 验证实际任务进度' }));
  assert.equal(progress.progress.actorId, dev.user.id);
  assert.equal(progress.progress.source, 'self_reported');
  const beat = dataOf(await mcp.call('heartbeat', { taskId: task.id, tool: 'codex-cli', status: 'WORKING' }));
  assert.equal(beat.device.deviceId, deviceId);
  const after = dataOf(await mcp.call('context', { taskId: task.id }));
  assert.equal(after.task.progress, 40);
  assert.ok(after.devices.some(device => device.deviceId === deviceId && device.online));
  const { job } = await api('/api/reviews', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'LOCAL_REPORT' }, dev.token, 201);
  assert.equal(dataOf(await mcp.call('reviews', { taskId: task.id })).jobs[0].id, job.id);
  assert.ok(dataOf(await mcp.call('review_context', { jobId: job.id })).job.snapshot);
  const wrongSource = await mcp.call('report_submit', { jobId: job.id, report: { summary: '不能改写执行模式', source: 'MANUAL', findings: [] } });
  assert.match(errorOf(wrongSource), /报告来源与评审执行模式不一致/);
  const submitted = dataOf(await mcp.call('report_submit', { jobId: job.id, report: localReport }));
  assert.equal(submitted.job.status, 'REPORT_SUBMITTED');
  assert.equal(submitted.job.report.actorId, dev.user.id);
  assert.equal(submitted.job.report.source, 'LOCAL_TOOL');
  assert.equal(submitted.job.report.summary, localReport.summary);
  assert.equal(submitted.job.report.evidence, localReport.evidence);
  assert.equal(submitted.job.executor, 'UNCONFIGURED');
  assert.equal(submitted.job.decision, null);
  assert.equal((await mcp.call('report_submit', { jobId: job.id, report: localReport })).isError, true);
  const qaMcp = await connect(t, await state(t, { url: base, token: qa.token }));
  assert.match(errorOf(await qaMcp.call('progress_report', { taskId: task.id, tool: 'cursor', progress: 90, summary: '没有受理人权限' })), /无权/);
  await api('/api/logout', {}, dev.token, 204);
  assert.match(errorOf(await mcp.call('task_list')), /登录已失效/);
  for (const secret of [password, admin.token, dev.token, qa.token]) { assert.ok(!mcp.output().includes(secret)); assert.ok(!qaMcp.output().includes(secret)); }
  assert.equal(mcp.stderr(), '');
  assert.deepEqual(mcp.protocolErrors, []);
});

test('--print-config produces three copyable command/path snippets without session or environment secrets', async t => {
  const directory = await state(t, { url: 'http://127.0.0.1:1', token });
  const child = spawn(process.execPath, [script, '--print-config'], { env: { ...process.env, RD_HUB_STATE_DIR: directory, SECRET_FOR_TEST: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.match(output, /\[mcp_servers\.taskflow\]/);
  assert.match(output, /Claude Code（项目 \.mcp\.json）/);
  assert.match(output, /Cursor（项目 \.cursor\/mcp\.json）/);
  assert.equal(output.split(JSON.stringify(script)).length - 1, 3);
  assert.ok(!output.includes(token));
  assert.ok(!output.includes('session.json'));
  assert.equal(stderr, '');
});

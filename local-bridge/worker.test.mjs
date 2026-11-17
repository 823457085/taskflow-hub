import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateRoot = mkdtempSync(join(tmpdir(), 'taskflow-worker-state-'));
process.env.RD_HUB_STATE_DIR = stateRoot;
const { createPlatform } = await import('../platform-server/server.mjs');
const { saveSession } = await import('./api-client.mjs');
const { runWorker, loadWorkerConfig, cliExecutor } = await import('./worker.mjs');

const password = 'bridge-worker-passphrase';
const setupToken = 'bridge-worker-setup-token';
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'taskflow-worker-repo-')));
const configPath = join(stateRoot, 'worker.json');
const writeConfig = config => { rmSync(configPath, { force: true }); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); };

async function startHub(bridgeModes = ['read', 'review', 'develop']) {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-worker-hub-'));
  let offset = 0;
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, deployment: 'server', setupToken, bridgeModes, deviceClock: () => Date.now() + offset });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? undefined : await response.json() };
  };
  await call('/api/setup', { method: 'POST', body: { username: 'admin', password, setupToken } });
  const login = await call('/api/login', { method: 'POST', body: { username: 'admin', password } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const browser = { get: { Cookie: cookie }, post: { Cookie: cookie, Origin: base } };
  const task = (await call('/api/tasks', { method: 'POST', body: { jiraKey: 'WRK-1', title: 'worker task' }, token: login.body.token })).body.task;
  const start = await call('/api/device-authorizations', { method: 'POST', body: { deviceName: 'worker-test', tool: 'custom' } });
  await call('/api/device-authorizations/decision', { method: 'POST', body: { userCode: start.body.userCode, decision: 'APPROVE', projectIds: ['default'] }, headers: browser.post });
  offset += 3100;
  const paired = (await call('/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: start.body.deviceCode } })).body;
  rmSync(join(stateRoot, 'session.json'), { force: true });
  await saveSession({ url: base, token: paired.token, deviceId: paired.deviceId, projectIds: paired.projectIds, expiresAt: paired.expiresAt });
  const dispatch = body => call(`/api/tasks/${task.id}/ai-runs`, { method: 'POST', body: { deviceId: paired.deviceId, ...body }, headers: browser.post });
  const run = async id => (await call(`/api/ai-runs/${id}`, { headers: browser.get })).body.run;
  return { call, browser, task, dispatch, run, deviceToken: paired.token, close: async () => { await platform.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const quiet = { log: () => {}, sleep: async () => {} };

test.after(() => { rmSync(stateRoot, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });

test('worker claims its own dispatch, writes a private context file, substitutes placeholders and reports success', async () => {
  const hub = await startHub();
  try {
    writeConfig({ projects: { default: repo } });
    const queued = (await hub.dispatch({ mode: 'read', engine: 'codex', customInstruction: '只看接口' })).body.run;
    let seen;
    const fake = { start: async ({ prompt, cwd, runDir, repo: mapped, mode, engine, onOutput }) => {
      const contextFile = prompt.match(/运行目录文件：(\S+context\.json)/)[1];
      seen = { prompt, cwd, runDir, mapped, mode, engine, contextMode: readFileSync(contextFile) && (await import('node:fs')).statSync(contextFile).mode & 0o777, context: JSON.parse(readFileSync(contextFile, 'utf8')) };
      onOutput('分析中…\n');
      return { wait: Promise.resolve({ exitCode: 0, output: '结论：材料缺少 TECH_SPEC' }), stop() {} };
    } };
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { cli: fake } });
    assert.equal(seen.cwd, seen.runDir);
    assert.equal(seen.mapped, repo);
    assert.equal(seen.mode, 'read');
    assert.equal(seen.contextMode, 0o600);
    assert.equal(seen.context.task.id, hub.task.id);
    assert.doesNotMatch(seen.prompt, /\{\{TASKFLOW_/);
    assert.match(seen.prompt, /只看接口/);
    assert.equal(existsSync(seen.runDir), false);
    const final = await hub.run(queued.id);
    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.output, '结论：材料缺少 TECH_SPEC');
  } finally { await hub.close(); }
});

test('worker stops the local executor when the member cancels from the web page', async () => {
  const hub = await startHub();
  try {
    writeConfig({ projects: {} });
    const queued = (await hub.dispatch({ mode: 'read' })).body.run;
    let stopped = false;
    const fake = { start: async () => {
      let finish;
      const wait = new Promise(resolve => { finish = resolve; });
      await hub.call(`/api/ai-runs/${queued.id}/stop`, { method: 'POST', body: {}, headers: hub.browser.post });
      return { wait, stop: () => { stopped = true; finish({ exitCode: null, output: 'partial' }); } };
    } };
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { cli: fake } });
    assert.equal(stopped, true);
    const final = await hub.run(queued.id);
    assert.equal(final.status, 'CANCELLED');
    assert.equal(final.output, 'partial');
  } finally { await hub.close(); }
});

test('develop runs need allowDevelop, a mapped repository and explicit local confirmation, and then run inside that repository', async () => {
  const hub = await startHub();
  try {
    const neverRuns = { start: async () => { throw new Error('executor must not start'); } };
    writeConfig({ projects: { default: repo } });
    let queued = (await hub.dispatch({ mode: 'develop' })).body.run;
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { cli: neverRuns } });
    assert.match((await hub.run(queued.id)).error, /allowDevelop/);

    writeConfig({ projects: {}, allowDevelop: true });
    queued = (await hub.dispatch({ mode: 'develop' })).body.run;
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { cli: neverRuns } });
    assert.match((await hub.run(queued.id)).error, /未映射该项目的代码仓库/);

    writeConfig({ projects: { default: repo }, allowDevelop: true });
    queued = (await hub.dispatch({ mode: 'develop' })).body.run;
    const asked = [];
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, confirm: async request => { asked.push(request); return false; }, executors: { cli: neverRuns } });
    assert.equal((await hub.run(queued.id)).status, 'CANCELLED');
    assert.equal(asked[0].repo, repo);

    queued = (await hub.dispatch({ mode: 'develop' })).body.run;
    let cwd;
    const fake = { start: async options => { cwd = options.cwd; assert.match(options.prompt, new RegExp(`业务代码仓库：${repo}`)); return { wait: Promise.resolve({ exitCode: 0, output: 'done' }), stop() {} }; } };
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, confirm: async () => true, executors: { cli: fake } });
    assert.equal(cwd, repo);
    assert.equal((await hub.run(queued.id)).status, 'SUCCEEDED');
  } finally { await hub.close(); }
});

test('real CLI executor runs codex read-only with the repository as an extra readable directory and returns the last message', async () => {
  const hub = await startHub();
  const bin = mkdtempSync(join(tmpdir(), 'taskflow-fake-codex-'));
  try {
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\ninput=$(cat)\necho "progress line"\ncase "$input" in *"TaskFlow"*) seen=yes;; *) seen=no;; esac\nprintf "final args=[%s] prompt=%s" "$*" "$seen" > "$out"\nexit 0\n', { mode: 0o755 });
    writeConfig({ projects: { default: repo }, engines: { codex } });
    const queued = (await hub.dispatch({ mode: 'review', stage: 'PRD' })).body;
    assert.equal(queued.error?.code, 'MISSING_INPUT');
    const read = (await hub.dispatch({ mode: 'read', engine: 'codex' })).body.run;
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { cli: cliExecutor() } });
    const final = await hub.run(read.id);
    assert.equal(final.status, 'SUCCEEDED');
    assert.match(final.output, /^final args=\[exec --skip-git-repo-check --ephemeral --color never -s read-only --add-dir /);
    assert.ok(final.output.includes(`--add-dir ${repo} -o `));
    assert.match(final.output, /prompt=yes$/);
    assert.equal(final.exitCode, 0);
  } finally { await hub.close(); rmSync(bin, { recursive: true, force: true }); }
});

test('delivery executor hands read and develop runs to Delivery with inline context, streams output and stops on cancel', async () => {
  const { createServer } = await import('node:http');
  const hub = await startHub();
  const tokenDir = mkdtempSync(join(tmpdir(), 'taskflow-delivery-token-'));
  const token = 'd'.repeat(43);
  const tokenFile = join(tokenDir, 'token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const sessions = new Map();
  const commands = [];
  const delivery = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    commands.push(body);
    const reply = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url !== '/api/taskflow/bridge' || req.headers.authorization !== `Bearer ${token}` || req.headers['content-type'] !== 'application/json') return reply(401, { error: { message: 'bad token' } });
    const allowed = body.action === 'start' ? ['action', 'runId', 'key', 'provider', 'mode', 'title', 'objective', 'workspacePath', 'taskFlowUrl'] : ['action', 'runId', 'key'];
    if (Object.keys(body).some(key => !allowed.includes(key)) || !/^[a-f0-9]{64}$/.test(body.key)) return reply(400, { error: { message: 'bad command' } });
    let session = sessions.get(body.runId);
    if (body.action === 'start') { session ||= { key: body.key, status: 'running', polls: 0, input: body }; sessions.set(body.runId, session); }
    if (!session || session.key !== body.key) return reply(404, { error: { message: 'missing' } });
    if (body.action === 'read') session.polls += 1;
    if (body.action === 'stop') session.status = 'cancelled';
    const output = session.polls >= 2 ? '第一段\n第二段' : '第一段';
    if (['read', 'develop'].includes(session.input.mode) && session.polls >= 2 && session.status === 'running') session.status = 'completed';
    reply(200, { run: { id: body.runId, status: session.status, output, error: '', updatedAt: new Date().toISOString() } });
  });
  await new Promise(resolve => delivery.listen(0, '127.0.0.1', resolve));
  const { deliveryExecutor } = await import('./worker.mjs');
  try {
    writeConfig({ projects: { default: repo }, executor: 'delivery', delivery: { url: `http://127.0.0.1:${delivery.address().port}`, tokenFile } });
    const read = (await hub.dispatch({ mode: 'read', engine: 'cursor' })).body.run;
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { delivery: deliveryExecutor({ pollMs: 10 }) } });
    const started = sessions.get(read.id).input;
    assert.equal(started.provider, 'cursor');
    assert.equal(started.workspacePath, repo);
    assert.match(started.taskFlowUrl, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/#view=tasks&task=${hub.task.id}$`));
    assert.match(started.objective, /本提示末尾附带的 JSON 快照/);
    assert.match(started.objective, /```json\n\{/);
    assert.ok(started.objective.includes(hub.task.id));
    let final = await hub.run(read.id);
    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.output, '第一段\n第二段');

    writeConfig({ projects: { default: repo }, executor: 'delivery', allowDevelop: true, delivery: { url: `http://127.0.0.1:${delivery.address().port}`, tokenFile } });
    const develop = (await hub.dispatch({ mode: 'develop', engine: 'codex' })).body.run;
    const confirmations = [];
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, {
      ...quiet,
      confirm: async request => { confirmations.push(request); return true; },
      executors: { delivery: deliveryExecutor({ pollMs: 10 }) },
    });
    const developInput = sessions.get(develop.id).input;
    assert.deepEqual(confirmations, [{ title: 'WRK-1 · worker task', mode: 'develop', repo, engine: 'codex' }]);
    assert.equal(developInput.runId, develop.id);
    assert.equal(developInput.provider, 'codex');
    assert.equal(developInput.mode, 'develop');
    assert.equal(developInput.workspacePath, repo);
    assert.ok(developInput.objective.includes(`业务代码仓库：${repo}`));
    assert.doesNotMatch(developInput.objective, /\{\{TASKFLOW_/);
    const developContext = JSON.parse(developInput.objective.match(/```json\n([\s\S]+)\n```$/)[1]);
    assert.equal(developContext.task.id, hub.task.id);
    final = await hub.run(develop.id);
    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.exitCode, 0);
    assert.equal(final.output, '第一段\n第二段');

    const longRun = (await hub.dispatch({ mode: 'read' })).body.run;
    const original = deliveryExecutor({ pollMs: 20 });
    const cancelling = { inlineContext: true, start: async options => {
      const handle = await original.start(options);
      sessions.get(longRun.id).input.mode = 'hold';
      await hub.call(`/api/ai-runs/${longRun.id}/stop`, { method: 'POST', body: {}, headers: hub.browser.post });
      return handle;
    } };
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { delivery: cancelling } });
    final = await hub.run(longRun.id);
    assert.equal(final.status, 'CANCELLED');
    assert.ok(commands.some(command => command.action === 'stop' && command.runId === longRun.id));

    writeFileSync(tokenFile, `${token}\n`); chmodSync(tokenFile, 0o644);
    const insecure = (await hub.dispatch({ mode: 'read' })).body.run;
    await runWorker({ config: configPath, once: true, waitSeconds: 1 }, { ...quiet, executors: { delivery: deliveryExecutor({ pollMs: 10 }) } });
    assert.match((await hub.run(insecure.id)).error, /私有文件/);
  } finally {
    await new Promise(resolve => delivery.close(resolve));
    await hub.close();
    rmSync(tokenDir, { recursive: true, force: true });
  }
});

test('worker config rejects unsafe files, unknown fields and relative repository paths', async () => {
  writeConfig({ projects: { default: 'relative/repo' } });
  await assert.rejects(loadWorkerConfig(configPath), /绝对路径/);
  writeConfig({ projects: {}, shell: 'rm -rf /' });
  await assert.rejects(loadWorkerConfig(configPath), /仅支持字段/);
  writeConfig({ projects: {}, executor: 'delivery', delivery: { url: 'http://192.168.1.2:5288', tokenFile: '/tmp/token' } });
  await assert.rejects(loadWorkerConfig(configPath), /本机回环地址/);
  writeConfig({ projects: {}, executor: 'delivery', delivery: { url: 'http://127.0.0.1:5288' } });
  await assert.rejects(loadWorkerConfig(configPath), /tokenFile/);
  writeConfig({ projects: { default: repo } });
  chmodSync(configPath, 0o666);
  await assert.rejects(loadWorkerConfig(configPath), /不可被他人写入/);
  chmodSync(configPath, 0o600);
  const nested = join(repo, 'nested'); mkdirSync(nested);
  writeConfig({ projects: { default: nested }, executor: 'cli', maxMinutes: 5 });
  assert.equal((await loadWorkerConfig(configPath)).projects.default, nested);
});

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadSession, request, stateDir } from './api-client.mjs';
import { syncDelivery } from './delivery-sync.mjs';
import { syncSkills } from './skills-sync.mjs';
import { runWorkbenchTunnel } from './workbench-tunnel.mjs';
import { runRemoteAgent } from './remote-agent.mjs';
import { fetchRelease, installWorkbench, installedRoot, updateBridge, workbenchVersion } from './updater.mjs';

export const workerConfigPath = join(stateDir, 'worker.json');
export const deliverySyncStatePath = join(stateDir, 'delivery-sync.json');
const OUTPUT_MAX = 64_000;
const PROGRESS_MS = 3000;
const RETRY_MS = 5000;
const CONFIRM_MS = 120_000;
const INLINE_CONTEXT_MAX = 190_000;
const UPDATE_FIRST_MS = 2 * 60_000;
const UPDATE_EVERY_MS = 6 * 60 * 60_000;
const CONFIG_KEYS = ['projects', 'executor', 'engines', 'allowDevelop', 'maxMinutes', 'delivery', 'deliverySync', 'skillSync', 'workbench', 'autoUpdate', 'remoteAgent'];
const EXECUTORS = ['cli', 'delivery'];
const ENGINE_BINARIES = { codex: 'codex', cursor: 'cursor-agent' };
const isModelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@+,\[\]=\-]{0,119}$/.test(value);

export function workerConfigTemplate() {
  return {
    projects: { '<平台项目ID>': '/绝对路径/业务代码仓库' },
    executor: 'cli',
    allowDevelop: false,
    maxMinutes: 60,
    delivery: { url: 'http://127.0.0.1:5288', tokenFile: '/绝对路径/Delivery数据目录/taskflow-bridge/token（executor 为 delivery 时必填）' },
    deliverySync: { dataDir: '/绝对路径/Delivery/.local/data（可选：定时同步 Agent 记录与部署记录，不需要可删除此项）', deployments: { '<平台项目ID>': ['Delivery 部署项目名，* 表示全部'] }, intervalMinutes: 10 },
    skillSync: { targets: ['/绝对路径/.codex/skills（可选：定时把团队 Skill 同步到本机，不需要可删除此项）'], intervalMinutes: 30 },
    workbench: { url: 'http://127.0.0.1:5288（可选：让你在网页工作台访问本机工作台，不需要可删除此项）' },
  };
}

export function memberWorkerConfig() {
  return { projects: {}, executor: 'cli', allowDevelop: false, maxMinutes: 60, workbench: { url: 'http://127.0.0.1:5288' }, remoteAgent: true };
}

/** Bring the installed Bridge and workbench to the server's published release. Returns whether the Bridge must restart. */
export async function checkForUpdates({ url, root = installedRoot(), log = () => {}, fetchImpl = fetch }) {
  if (!root) return { status: 'SKIPPED', message: '当前 Bridge 不是通过一键安装运行的，不自动更新' };
  const release = await fetchRelease(url, fetchImpl);
  const bridge = await updateBridge({ root, hub: url, release, fetchImpl, log });
  if (bridge.updated) log(`Bridge 已更新到 ${bridge.version}`);
  let workbench = null;
  if (release.workbench && (await workbenchVersion(root)).current) {
    try {
      workbench = await installWorkbench({ root, hub: url, release, fetchImpl, log });
      if (workbench.changed) log(`工作台新版本 ${workbench.version} 已下载，下次重启工作台时生效`);
    } catch (error) { log(`工作台更新失败：${error.message}`); }
  }
  return { status: 'CHECKED', bridge, workbench, restart: bridge.updated };
}

function loopbackOrigin(value, label) {
  let url;
  try { url = new URL(value || 'http://127.0.0.1:5288'); } catch { throw new Error(`${label} 不正确。`); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error(`${label} 必须是带端口的本机回环地址，例如 http://127.0.0.1:5288`);
  return url.origin;
}

export function workbenchConfig(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'url')) throw new Error('workbench 仅支持字段 url。');
  return { url: loopbackOrigin(value.url, 'workbench.url') };
}

function realDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00\r\n]/.test(value)) throw new Error(`${label} 必须是本机绝对路径。`);
  let real;
  try { real = realpathSync(value); } catch { throw new Error(`${label} 不存在：${value}`); }
  if (!statSync(real).isDirectory()) throw new Error(`${label} 不是目录：${value}`);
  return real;
}

export async function loadWorkerConfig(path = workerConfigPath) {
  let info;
  try { info = await lstat(path); } catch { throw new Error(`未找到 Bridge 配置 ${path}，请先运行 worker-init 并填写项目仓库映射。`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw new Error('Bridge 配置文件必须是当前用户所有、不可被他人写入的普通文件。');
  let raw;
  try { raw = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Bridge 配置文件不是合法 JSON。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !CONFIG_KEYS.includes(key))) throw new Error(`Bridge 配置仅支持字段：${CONFIG_KEYS.join('、')}`);
  const projects = {};
  for (const [projectId, repo] of Object.entries(raw.projects || {})) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error(`项目 ID 格式不正确：${projectId}`);
    projects[projectId] = realDirectory(repo, `项目 ${projectId} 的仓库`);
  }
  const executor = raw.executor ?? 'cli';
  if (!EXECUTORS.includes(executor)) throw new Error('executor 仅支持 cli 或 delivery。');
  const engines = {};
  for (const [engine, binary] of Object.entries(raw.engines || {})) {
    if (!ENGINE_BINARIES[engine]) throw new Error(`engines 仅支持 ${Object.keys(ENGINE_BINARIES).join('、')}。`);
    if (typeof binary !== 'string' || !isAbsolute(binary)) throw new Error(`engines.${engine} 必须是可执行文件的绝对路径。`);
    engines[engine] = binary;
  }
  if (raw.allowDevelop !== undefined && typeof raw.allowDevelop !== 'boolean') throw new Error('allowDevelop 必须是 true 或 false。');
  const maxMinutes = raw.maxMinutes ?? 60;
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 240) throw new Error('maxMinutes 必须是 1..240 的整数。');
  let delivery = null;
  if (raw.delivery !== undefined || executor === 'delivery') {
    const value = raw.delivery || {};
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['url', 'tokenFile'].includes(key))) throw new Error('delivery 仅支持字段 url、tokenFile。');
    const url = loopbackOrigin(value.url, 'delivery.url');
    if (typeof value.tokenFile !== 'string' || !isAbsolute(value.tokenFile)) throw new Error('delivery.tokenFile 必须是 Delivery 数据目录下 taskflow-bridge/token 的绝对路径。');
    delivery = { url, tokenFile: value.tokenFile };
  }
  if (raw.autoUpdate !== undefined && typeof raw.autoUpdate !== 'boolean') throw new Error('autoUpdate 必须是 true 或 false。');
  if (raw.remoteAgent !== undefined && typeof raw.remoteAgent !== 'boolean') throw new Error('remoteAgent 必须是 true 或 false。');
  return { projects, executor, engines, allowDevelop: raw.allowDevelop === true, maxMinutes, delivery, deliverySync: deliverySyncConfig(raw.deliverySync), skillSync: skillSyncConfig(raw.skillSync), workbench: workbenchConfig(raw.workbench), autoUpdate: raw.autoUpdate !== false, remoteAgent: raw.remoteAgent === true };
}

export function deliverySyncConfig(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['dataDir', 'deployments', 'intervalMinutes'].includes(key))) throw new Error('deliverySync 仅支持字段 dataDir、deployments、intervalMinutes。');
  const dataDir = realDirectory(value.dataDir, 'deliverySync.dataDir');
  const deployments = {};
  for (const [projectId, names] of Object.entries(value.deployments || {})) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error(`deliverySync.deployments 项目 ID 格式不正确：${projectId}`);
    if (!Array.isArray(names) || !names.length || names.length > 50 || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 200)) throw new Error(`deliverySync.deployments.${projectId} 需要 1 至 50 个 Delivery 部署项目名。`);
    deployments[projectId] = names.map(name => name.trim());
  }
  const intervalMinutes = value.intervalMinutes ?? 10;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('deliverySync.intervalMinutes 必须是 1..1440 的整数。');
  return { dataDir, deployments, intervalMinutes };
}

export function skillSyncConfig(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['targets', 'intervalMinutes'].includes(key))) throw new Error('skillSync 仅支持字段 targets、intervalMinutes。');
  if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 10 || value.targets.some(target => typeof target !== 'string' || !isAbsolute(target))) throw new Error('skillSync.targets 需要 1 至 10 个绝对路径目录。');
  const intervalMinutes = value.intervalMinutes ?? 30;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('skillSync.intervalMinutes 必须是 1..1440 的整数。');
  return { targets: [...new Set(value.targets.map(target => join(realDirectory(dirname(target), 'skillSync.targets 的上级目录'), basename(target))))], intervalMinutes };
}

async function readDeliveryToken(file) {
  let info;
  try { info = await lstat(file); } catch { throw new Error(`未找到 Delivery Bridge 令牌 ${file}，请确认 Delivery 已更新并启动过一次。`); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Delivery Bridge 令牌文件必须是当前用户私有文件。');
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Delivery Bridge 令牌文件内容无效。');
  return token;
}

const DELIVERY_DONE = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

export function deliveryExecutor({ fetchImpl = fetch, pollMs = 2000 } = {}) {
  return {
    inlineContext: true,
    async start({ engine, mode, prompt, repo, onOutput, config, title, taskFlowUrl, runId }) {
      const token = await readDeliveryToken(config.delivery.tokenFile);
      const key = randomBytes(32).toString('hex');
      const send = async command => {
        let response;
        try {
          response = await fetchImpl(new URL('/api/taskflow/bridge', config.delivery.url), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(command.action === 'start' ? 20_000 : 8000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ...command, runId, key }),
          });
        } catch { throw new Error(`无法连接本机 Delivery（${config.delivery.url}），请确认已启动且已包含 TaskFlow Bridge 入口。`); }
        const value = await response.json().catch(() => null);
        if (!response.ok) throw new Error(value?.error?.message || `Delivery 返回 HTTP ${response.status}`);
        if (value?.run?.id !== runId || typeof value.run.status !== 'string') throw new Error('Delivery 返回了无效的会话状态。');
        return value.run;
      };
      let current = await send({ action: 'start', provider: engine, mode, title: title.slice(0, 240), objective: prompt, workspacePath: repo || '', taskFlowUrl });
      let seen = '';
      const emit = output => {
        if (output === seen) return;
        onOutput(output.startsWith(seen) ? output.slice(seen.length) : `\n${output}`);
        seen = output;
      };
      emit(current.output || '');
      let stopped = false;
      const wait = (async () => {
        while (!DELIVERY_DONE.has(current.status)) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
          try { current = await send({ action: 'read' }); emit(current.output || ''); }
          catch (error) { if (stopped) break; throw error; }
        }
        return { exitCode: current.status === 'completed' ? 0 : 1, output: current.output || seen, ...(current.status === 'completed' ? {} : { error: current.error || `Delivery 会话状态：${current.status}` }) };
      })();
      return { wait, stop: () => { stopped = true; void send({ action: 'stop' }).then(run => { current = run; }).catch(() => {}); } };
    },
  };
}

function searchPath(env = process.env) {
  return [...new Set([join(homedir(), '.local/bin'), dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', ...(env.PATH || '').split(':').filter(Boolean)])];
}

export function findBinary(name, override, env = process.env) {
  for (const candidate of override ? [override] : searchPath(env).map(dir => join(dir, name))) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

export function cliExecutor({ spawnImpl = spawn, env = process.env } = {}) {
  return {
    async start({ engine, mode, model, prompt, cwd, runDir, repo, onOutput, config }) {
      const binary = findBinary(ENGINE_BINARIES[engine], config.engines[engine], env);
      if (!binary) throw new Error(`本机未找到 ${ENGINE_BINARIES[engine]}，请安装或在 worker.json 的 engines 中指定绝对路径。`);
      const lastMessage = join(runDir, 'last-message.txt');
      const childEnv = { ...env, PATH: searchPath(env).join(':'), CI: '1', NO_COLOR: '1' };
      if (model && !isModelId(model)) throw new Error('模型标识无效。');
      const modelArgs = model ? ['--model', model] : [];
      const args = engine === 'codex'
        ? ['exec', '--skip-git-repo-check', '--color', 'never', '-s', mode === 'develop' ? 'workspace-write' : 'read-only',
          ...(mode !== 'develop' && repo && repo !== cwd ? ['--add-dir', repo] : []),
          ...(runDir && runDir !== cwd ? ['--add-dir', runDir] : []),
          ...modelArgs, '-o', lastMessage, '-']
        : ['--print', ...(mode === 'develop' ? ['--force'] : ['--plan']), ...modelArgs, prompt];
      const child = spawnImpl(binary, args, { cwd, env: childEnv, stdio: [engine === 'codex' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      if (engine === 'codex') child.stdin.end(prompt, 'utf8');
      let combined = '';
      const collect = chunk => { const text = chunk.toString('utf8'); combined = (combined + text).slice(-OUTPUT_MAX); onOutput(text); };
      child.stdout.on('data', collect);
      let startup = '';
      child.stderr.on('data', chunk => {
        if (engine === 'codex' && startup.length < 8192) startup = (startup + chunk.toString('utf8')).slice(0, 8192);
        collect(chunk);
      });
      const wait = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', async code => {
          let final = '';
          if (engine === 'codex') { try { final = (await readFile(lastMessage, 'utf8')).trim(); } catch { final = ''; } }
          const banner = /^OpenAI Codex v[^\n]*\n-+\r?\nworkdir:[^\n]*\nmodel:[ \t]*([^\r\n]+)\r?\n/m.exec(startup);
          const model = banner?.[1].trim();
          resolve({ exitCode: code, output: final || combined, ...(isModelId(model) ? { effectiveModel: model } : {}) });
        });
      });
      return { wait, stop: () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref(); } };
    },
  };
}

export async function defaultConfirm({ title, repo, engine, model, dispatchedBy }, { input = process.stdin, output = process.stderr, platform = process.platform, execFileImpl = execFile } = {}) {
  const message = `TaskFlow 请求在本机执行开发任务\n\n任务：${title}\n${dispatchedBy ? `派发人：${dispatchedBy}\n` : ''}仓库：${repo}\n引擎：${engine}${model ? `\n模型：${model}` : ''}\n\n允许后 AI 可修改该仓库文件（不会自动 push）。`;
  if (input.isTTY) {
    const rl = createInterface({ input, output });
    try {
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), CONFIRM_MS);
        rl.question(`${message}\n允许执行？[y/N] `, answer => { clearTimeout(timer); resolve(/^y(es)?$/i.test(answer.trim())); });
      });
    } finally { rl.close(); }
  }
  if (platform !== 'darwin') return false;
  return new Promise(resolve => {
    execFileImpl('osascript', ['-e', 'on run argv', '-e', `display dialog (item 1 of argv) with title "TaskFlow Bridge" buttons {"拒绝", "允许"} default button "拒绝" giving up after ${CONFIRM_MS / 1000}`, '-e', 'end run', message],
      { timeout: CONFIRM_MS + 10_000 }, (error, stdout) => resolve(!error && /button returned:允许/.test(stdout) && !/gave up:true/.test(stdout)));
  });
}

export async function runWorker(options = {}, deps = {}) {
  const {
    log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    confirm = defaultConfirm,
    now = Date.now,
    executors = { cli: cliExecutor(), delivery: deliveryExecutor() },
    signal,
    update = checkForUpdates,
    supervised = process.env.TASKFLOW_SERVICE === '1',
  } = deps;
  const waitSeconds = options.waitSeconds ?? 25;
  const config = await loadWorkerConfig(options.config || workerConfigPath);
  const executor = executors[config.executor];
  if (!executor) throw new Error(`执行器 ${config.executor} 不可用。`);
  const session = await loadSession();
  const call = (path, body, timeoutMs) => request(session.url, path, { token: session.token, ...(body ? { method: 'POST', body } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  log(`Bridge 已启动：平台 ${session.url}，项目映射 ${Object.keys(config.projects).length} 个，执行器 ${config.executor}，开发类任务${config.allowDevelop ? '需本机确认' : '已关闭'}${config.deliverySync ? `，每 ${config.deliverySync.intervalMinutes} 分钟同步 Delivery 记录` : ''}${config.skillSync ? `，每 ${config.skillSync.intervalMinutes} 分钟同步团队 Skill` : ''}`);
  if (config.workbench && !options.once) {
    void runWorkbenchTunnel({ apiUrl: session.url, token: session.token, target: config.workbench.url, log, signal, ...deps.tunnel }).catch(error => log(`工作台转发异常退出：${error.message}`));
  }
  if (config.remoteAgent && !options.once) {
    void (deps.remoteAgent || runRemoteAgent)({ apiUrl: session.url, token: session.token, log, signal }).catch(error => log(`个人 Agent 异常退出：${error.message}`));
  }
  let nextSyncAt = 0, nextSkillSyncAt = 0, nextUpdateAt = now() + UPDATE_FIRST_MS;
  async function maybeUpdate() {
    if (!supervised || !config.autoUpdate || options.once || now() < nextUpdateAt) return false;
    nextUpdateAt = now() + UPDATE_EVERY_MS;
    try { return (await update({ url: session.url, log })).restart === true; }
    catch (error) { log(`检查更新失败：${error.message}`); return false; }
  }
  async function maybeSync() {
    if (!config.deliverySync || now() < nextSyncAt) return;
    nextSyncAt = now() + config.deliverySync.intervalMinutes * 60_000;
    try {
      const result = await syncDelivery({ ...config.deliverySync, statePath: deliverySyncStatePath }, (path, body) => call(path, body));
      if (result.agents.created || result.agents.updated || Object.values(result.deployments).some(item => item.created || item.updated)) log(`已同步 Delivery 记录：Agent 会话新增 ${result.agents.created}、更新 ${result.agents.updated}；部署 ${Object.entries(result.deployments).map(([id, item]) => `${id} 新增 ${item.created}、更新 ${item.updated}`).join('，') || '未配置'}`);
    } catch (error) { log(`同步 Delivery 记录失败：${error.message}`); }
  }
  async function maybeSyncSkills() {
    if (!config.skillSync || now() < nextSkillSyncAt) return;
    nextSkillSyncAt = now() + config.skillSync.intervalMinutes * 60_000;
    try {
      const result = await syncSkills(config.skillSync, path => call(path));
      for (const item of result.targets) {
        if (item.written.length || item.removed.length) log(`已同步团队 Skill 到 ${item.target}：更新 ${item.written.length}、移除 ${item.removed.length}`);
        if (item.conflicts.length) log(`团队 Skill 与本机同名目录冲突，已跳过：${item.conflicts.join('、')}`);
      }
    } catch (error) { log(`同步团队 Skill 失败：${error.message}`); }
  }

  const availableModelEngines = () => config.executor === 'cli'
    ? Object.keys(ENGINE_BINARIES).filter(engine => findBinary(ENGINE_BINARIES[engine], config.engines[engine]))
    : [];

  async function handleRun(summary, modelEngines) {
    let claim;
    try { claim = await call(`/api/bridge/runs/${encodeURIComponent(summary.id)}/claim`, modelEngines.includes(summary.engine) ? { supportsModel: true } : {}); }
    catch (error) { log(`领取派发 ${summary.id} 失败：${error.message}`); return; }
    const { run, payload, placeholders } = claim;
    const finish = async (status, output = '', error, exitCode, effectiveModel) => {
      try {
        await call(`/api/bridge/runs/${encodeURIComponent(run.id)}/result`, { status, output: output.slice(-OUTPUT_MAX), ...(error ? { error: error.slice(0, 1000) } : {}), ...(Number.isInteger(exitCode) ? { exitCode } : {}), ...(isModelId(effectiveModel) ? { effectiveModel } : {}) });
        log(`派发 ${run.id}（${payload.title}）结束：${status}${error ? `，${error}` : ''}`);
      } catch (reportError) { log(`回传派发 ${run.id} 结果失败：${reportError.message}`); }
    };
    log(`领取派发 ${run.id}：${payload.title} · ${run.mode} · ${run.engine}${payload.dispatchedBy ? ` · 派发人 ${payload.dispatchedBy}` : ''}`);
    if (run.model && !modelEngines.includes(run.engine)) return finish('FAILED', '', '本机 Bridge 暂不支持指定模型');
    const repo = config.projects[run.projectId] || null;
    if (run.mode === 'develop') {
      if (!config.allowDevelop) return finish('FAILED', '', '本机 Bridge 未开启开发类任务（worker.json 中 allowDevelop 为 false）');
      if (!repo) return finish('FAILED', '', '本机未映射该项目的代码仓库，请在 worker.json 的 projects 中配置');
      if (!await confirm({ title: payload.title, mode: run.mode, repo, engine: run.engine, ...(run.model ? { model: run.model } : {}), ...(payload.dispatchedBy ? { dispatchedBy: payload.dispatchedBy } : {}) })) return finish('CANCELLED', '', '本机用户拒绝或未在 2 分钟内确认开发任务');
    }
    const runDir = join(stateDir, 'runs', run.id);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await chmod(runDir, 0o700);
    const contextFile = join(runDir, 'context.json');
    const contextJson = JSON.stringify(payload.context, null, 2);
    await writeFile(contextFile, contextJson, { mode: 0o600 });
    const inline = executor.inlineContext && payload.objective.length + contextJson.length < INLINE_CONTEXT_MAX;
    const prompt = (inline
      ? `${payload.objective.replaceAll(placeholders.contextFile, '本提示末尾附带的 JSON 快照')}\n\n任务上下文与材料快照（JSON）：\n\`\`\`json\n${contextJson}\n\`\`\``
      : payload.objective.replaceAll(placeholders.contextFile, contextFile)).replaceAll(placeholders.repoPath, repo || '（本机未映射该项目仓库）');
    let tail = '';
    let stopReason = null;
    let handle;
    try {
      handle = await executor.start({
        engine: run.engine, mode: run.mode, model: run.model, prompt, cwd: run.mode === 'develop' ? repo : runDir, runDir, repo, config,
        title: payload.title, taskFlowUrl: payload.taskFlowUrl, runId: run.id,
        onOutput: text => { tail = (tail + text).slice(-OUTPUT_MAX); },
      });
    } catch (error) {
      await rm(runDir, { recursive: true, force: true });
      return finish('FAILED', '', error.message);
    }
    let reporting = false;
    const progressTimer = setInterval(async () => {
      if (reporting || stopReason) return;
      reporting = true;
      try {
        const state = await call(`/api/bridge/runs/${encodeURIComponent(run.id)}/progress`, { output: tail });
        if (state.cancelRequested && !stopReason) { stopReason = 'CANCELLED'; handle.stop(); }
      } catch (error) {
        if (error.code === 'BRIDGE_RUN_CLOSED' || error.status === 404 || error.status === 401) { stopReason = 'CLOSED'; handle.stop(); }
      } finally { reporting = false; }
    }, PROGRESS_MS);
    const deadline = setTimeout(() => { if (!stopReason) { stopReason = 'TIMEOUT'; handle.stop(); } }, config.maxMinutes * 60_000);
    let outcome;
    try { outcome = await handle.wait; } catch (error) { outcome = { exitCode: null, output: tail, error: error.message }; }
    finally { clearInterval(progressTimer); clearTimeout(deadline); }
    await rm(runDir, { recursive: true, force: true });
    const output = outcome.output || tail;
    if (stopReason === 'CLOSED') return log(`派发 ${run.id} 已在平台侧结束，已停止本机执行`);
    if (stopReason === 'CANCELLED') return finish('CANCELLED', output, '已按网页请求停止', undefined, outcome.effectiveModel);
    if (stopReason === 'TIMEOUT') return finish('FAILED', output, `超过 ${config.maxMinutes} 分钟未完成，已停止`, undefined, outcome.effectiveModel);
    if (outcome.exitCode === 0) return finish('SUCCEEDED', output, undefined, 0, outcome.effectiveModel);
    return finish('FAILED', output, outcome.error || `执行器退出码 ${outcome.exitCode}`, outcome.exitCode, outcome.effectiveModel);
  }

  for (;;) {
    if (signal?.aborted) return;
    if (await maybeUpdate()) { log('Bridge 已更新，正在重启以加载新版本'); return { restart: true }; }
    await maybeSync();
    await maybeSyncSkills();
    const modelEngines = availableModelEngines();
    const query = new URLSearchParams({ wait: waitSeconds });
    for (const engine of modelEngines) query.append('modelEngine', engine);
    let next;
    try { next = await call(`/api/bridge/runs/next?${query}`, undefined, (waitSeconds + 15) * 1000); }
    catch (error) {
      if (error.status === 401) throw new Error('设备会话已失效或已被撤销，请运行 logout 后重新 pair 配对。');
      log(`连接平台失败：${error.message}，${RETRY_MS / 1000} 秒后重试`);
      if (options.once) return;
      await sleep(RETRY_MS);
      continue;
    }
    if (next?.run) await handleRun(next.run, modelEngines);
    if (options.once) return;
  }
}

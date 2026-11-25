import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path/posix';
import { fail } from './common.mjs';

const PING_MS = 15_000;
const FS_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 90_000;
const EXEC_PICKUP_MS = 20_000;
const BODY_MAX = 96 * 1024 * 1024;
const HTTP_BODY_MAX = 32 * 1024 * 1024;
const RESULTS_MAX = 512;
const USER_CALLS_MAX = 256;
const REPO_SCAN_TIMEOUT_MS = 10_000;
const REPO_SCAN_DIR_LIMIT = 96;
const REPO_SCAN_BATCH_SIZE = 6;
const REPO_SCAN_ROOTS = [
  ['Desktop/工作', 2], ['Desktop/工作台', 2], ['workspace', 2], ['projects', 2],
  ['workplace', 2], ['code', 2], ['Developer', 2], ['Documents/Codex', 4],
];
const REPO_SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor']);

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
const json = (res, status, value) => { if (res.headersSent || res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

async function readBody(req, max = BODY_MAX) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) fail(413, 'BODY_TOO_LARGE', '请求内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function parseJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8') || 'null'); } catch { fail(400, 'INVALID_JSON', '请求不是合法 JSON'); }
}
export function parseAgentInfo(value) {
  let info;
  try { info = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8')); } catch { return null; }
  if (!info || typeof info.home !== 'string' || !info.home.startsWith('/') || info.home.length > 512 || /[\x00-\x1f]|\/\.\.?(\/|$)/.test(info.home) || info.home === '/') return null;
  return { home: info.home.replace(/\/+$/, ''), platform: String(info.platform || '').slice(0, 20), version: String(info.version || '').slice(0, 40) };
}

/**
 * Relays file-system calls and processes from a user's server-side workbench instance to that user's own computer.
 * Personal agents (paired Bridge devices) hold one streaming connection; instances authenticate with a per-instance token.
 */
export function createRemoteBroker({ db, now = Date.now, logger = console, instanceUser = () => null, onAgent = () => {} }) {
  const agents = new Map();
  const calls = new Map();

  const liveDevice = device => db.prepare(`SELECT d.id,d.project_ids FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash
    WHERE d.id=? AND d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>?`).get(device.id, device.user_id, now(), now());
  const agentFor = (userId, projectId) => {
    const list = [...agents.values()].filter(agent => agent.userId === userId).sort((a, b) => b.connectedAt - a.connectedAt);
    for (const agent of list) {
      const device = liveDevice({ id: agent.deviceId, user_id: userId });
      if (!device) agent.res.destroy();
      else if (!agent.res.destroyed && (projectId === undefined || JSON.parse(device.project_ids).includes(projectId))) return agent;
    }
    return null;
  };
  const push = (agent, message) => agent.res.write(`${JSON.stringify(message)}\n`);
  const userCalls = userId => [...calls.values()].filter(call => call.userId === userId).length;

  function settle(call, error, value) {
    if (call.done) return;
    call.done = true;
    clearTimeout(call.timer);
    calls.delete(call.id);
    if (call.kind === 'fs') return error ? call.reject(error) : call.resolve(value);
    if (error) call.frame({ t: 'err', message: error.message, code: error.code });
    if (!call.res.writableEnded) call.res.end();
    call.output?.destroy();
  }
  const hostDown = message => Object.assign(new Error(message), { code: 'EHOSTDOWN' });

  function connect(req, res, device, url) {
    const info = parseAgentInfo(url.searchParams.get('info'));
    if (!info) fail(400, 'INVALID_INPUT', '个人 Agent 信息不正确');
    const previous = agents.get(device.id);
    if (previous) previous.res.destroy();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const agent = { deviceId: device.id, userId: device.user_id, res, connectedAt: now(), ...info };
    agents.set(device.id, agent);
    push(agent, { type: 'hello' });
    const ping = setInterval(() => push(agent, { type: 'ping' }), PING_MS);
    onAgent(device.user_id, info);
    const closed = () => {
      clearInterval(ping);
      if (agents.get(device.id) === agent) agents.delete(device.id);
      for (const call of [...calls.values()]) if (call.deviceId === device.id) settle(call, hostDown('与你电脑的连接已断开'));
    };
    req.once('close', closed);
    res.once('close', closed);
  }

  async function results(req, device) {
    const list = parseJson(await readBody(req));
    if (!Array.isArray(list) || list.length > RESULTS_MAX) fail(400, 'INVALID_INPUT', 'results格式不正确');
    for (const item of list) {
      const call = item && calls.get(item.id);
      if (!call || call.kind !== 'fs' || call.deviceId !== device.id) continue;
      if (item.ok) settle(call, null, item.value);
      else settle(call, Object.assign(new Error(String(item.error?.message || '电脑端操作失败').slice(0, 2000)), { code: String(item.error?.code || 'EIO').slice(0, 40), remote: item.error || {} }));
    }
  }

  function output(req, res, device, id) {
    const call = calls.get(id);
    if (!call || call.kind !== 'exec' || call.deviceId !== device.id || call.output) fail(404, 'REMOTE_EXEC_NOT_FOUND', '远程进程不存在或已结束');
    clearTimeout(call.timer);
    call.output = req;
    return new Promise(resolve => {
      let exited = false; let tail = '';
      const end = () => {
        if (!call.done) settle(call, exited ? null : hostDown('电脑端进程输出意外中断'));
        if (!res.headersSent && !res.destroyed) { res.writeHead(204); res.end(); }
        resolve();
      };
      req.on('data', chunk => {
        if (call.done) return;
        const text = tail + chunk.toString('utf8');
        const lines = text.split('\n');
        tail = lines.pop();
        for (const line of lines) if (line.startsWith('{"t":"x"')) exited = true;
        if (lines.length && !call.res.write(lines.map(line => `${line}\n`).join(''))) { req.pause(); call.res.once('drain', () => req.resume()); }
      });
      req.once('end', end);
      req.once('close', end);
      req.once('error', end);
    });
  }

  async function bridgeRoutes({ req, res, method, path, url, user }) {
    if (!path.startsWith('/api/bridge/remote/')) return false;
    if (!user?.localDevice) fail(403, 'BRIDGE_DEVICE_REQUIRED', '仅已配对的本机 Bridge 可使用个人 Agent');
    const device = user.localDevice;
    if (method === 'GET' && path === '/api/bridge/remote/stream') { connect(req, res, device, url); return true; }
    if (method === 'POST' && path === '/api/bridge/remote/results') { await results(req, device); res.writeHead(204); res.end(); return true; }
    const match = path.match(/^\/api\/bridge\/remote\/exec\/([0-9a-f-]{36})$/);
    if (match && method === 'POST') { await output(req, res, device, match[1]); return true; }
    fail(404, 'NOT_FOUND', '接口不存在');
  }

  function fsCallOn(agent, op, args, timeoutMs = FS_TIMEOUT_MS) {
    if (!agent || agent.res.destroyed || agents.get(agent.deviceId) !== agent) return Promise.reject(hostDown('你的电脑未连接'));
    if (userCalls(agent.userId) >= USER_CALLS_MAX) return Promise.reject(Object.assign(new Error('同时进行的电脑端操作过多'), { code: 'EAGAIN' }));
    return new Promise((resolve, reject) => {
      const call = { id: randomUUID(), kind: 'fs', userId: agent.userId, deviceId: agent.deviceId, resolve, reject, done: false };
      call.timer = setTimeout(() => settle(call, Object.assign(new Error('电脑端操作超时'), { code: 'ETIMEDOUT' })), timeoutMs);
      calls.set(call.id, call);
      push(agent, { type: 'fs', id: call.id, op, args });
    });
  }

  async function scanRepositories(userId, projectId) {
    const agent = agentFor(userId, projectId);
    const unavailable = () => fail(409, 'BRIDGE_REPO_SCAN_UNAVAILABLE', '当前项目没有已连接且获授权的本机 Bridge，可手动填写仓库路径。');
    if (!agent) unavailable();
    const verifyAgent = () => {
      const device = liveDevice({ id: agent.deviceId, user_id: userId });
      if (!device || !JSON.parse(device.project_ids).includes(projectId) || agent.res.destroyed || agents.get(agent.deviceId) !== agent) unavailable();
    };
    const timedOut = () => fail(504, 'BRIDGE_REPO_SCAN_TIMEOUT', '扫描本机仓库超时，请重试或直接填写路径。');
    const deadline = Date.now() + REPO_SCAN_TIMEOUT_MS;
    const cachedEntries = new Map();
    let tccProtected = false;
    const readEntries = async path => {
      verifyAgent();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) timedOut();
      let entries;
      try {
        entries = await fsCallOn(agent, 'readdir', [path, { withFileTypes: true }], remainingMs);
      } catch (error) {
        if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
          if (error.code === 'EACCES' || error.code === 'EPERM') tccProtected = true;
          return [];
        }
        if (error.code === 'EHOSTDOWN') unavailable();
        if (error.code === 'ETIMEDOUT') timedOut();
        if (error.code === 'EAGAIN') fail(429, 'BRIDGE_REPO_SCAN_BUSY', '本机正在处理较多请求，请稍后重试。');
        fail(502, 'BRIDGE_REPO_SCAN_FAILED', '本机目录读取失败，请重试。');
      }
      if (!Array.isArray(entries)) fail(502, 'BRIDGE_REPO_SCAN_FAILED', '本机返回的目录数据无效，请重试。');
      return entries;
    };
    // Resolve the fixed roots through real directory entries so symlinked roots are skipped as well.
    const roots = await Promise.all(REPO_SCAN_ROOTS.map(async ([relativePath, depth]) => {
      let path = agent.home;
      for (const name of relativePath.split('/')) {
        if (!cachedEntries.has(path)) cachedEntries.set(path, readEntries(path));
        const entries = await cachedEntries.get(path);
        if (!entries.some(entry => entry?.name === name && entry.kind === 'dir')) return null;
        path = join(path, name);
      }
      return { path, depth };
    }));
    const queue = roots.filter(Boolean);
    const scheduled = new Set(queue.map(entry => entry.path));
    const repositories = [];
    while (queue.length) {
      await Promise.all(queue.splice(0, REPO_SCAN_BATCH_SIZE).map(async ({ path, depth }) => {
        const entries = await readEntries(path);
        if (entries.some(entry => entry?.name === '.git' && ['dir', 'file'].includes(entry.kind))) {
          repositories.push({ name: basename(path), path, group: basename(dirname(path)) });
          return;
        }
        if (!depth) return;
        for (const entry of entries) {
          if (scheduled.size >= REPO_SCAN_DIR_LIMIT) break;
          if (entry?.kind !== 'dir' || typeof entry.name !== 'string' || !entry.name ||
              entry.name.startsWith('.') || /[\/\x00-\x1f\x7f]/.test(entry.name) || REPO_SCAN_SKIP.has(entry.name)) continue;
          const child = join(path, entry.name);
          if (child.length > 1024 || scheduled.has(child)) continue;
          scheduled.add(child);
          queue.push({ path: child, depth: depth - 1 });
        }
      }));
    }
    verifyAgent();
    return { repositories: repositories.sort((a, b) => a.path.localeCompare(b.path)), tccProtected };
  }

  function httpCall(userId, request) {
    const agent = agentFor(userId);
    if (!agent) return Promise.reject(hostDown('你的电脑未连接'));
    if (userCalls(userId) >= USER_CALLS_MAX) return Promise.reject(Object.assign(new Error('同时进行的电脑端操作过多'), { code: 'EAGAIN' }));
    return new Promise((resolve, reject) => {
      const call = { id: randomUUID(), kind: 'fs', userId, deviceId: agent.deviceId, resolve, reject, done: false };
      call.timer = setTimeout(() => settle(call, Object.assign(new Error('电脑端网络请求超时'), { code: 'ETIMEDOUT' })), HTTP_TIMEOUT_MS);
      calls.set(call.id, call);
      push(agent, { type: 'http', id: call.id, request });
    });
  }

  function execCall(req, res, userId) {
    let spec;
    try { spec = JSON.parse(Buffer.from(String(req.headers['x-remote-spec'] || ''), 'base64').toString('utf8')); } catch { spec = null; }
    if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args)) return json(res, 400, { error: { message: '远程进程参数不正确' } });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const call = { id: randomUUID(), kind: 'exec', userId, res, done: false, output: null };
    call.frame = frame => { if (!res.writableEnded) res.write(`${JSON.stringify(frame)}\n`); };
    const agent = agentFor(userId);
    if (!agent) { call.frame({ t: 'err', message: '你的电脑未连接', code: 'EHOSTDOWN' }); return res.end(); }
    if (userCalls(userId) >= USER_CALLS_MAX) { call.frame({ t: 'err', message: '同时进行的电脑端操作过多', code: 'EAGAIN' }); return res.end(); }
    call.deviceId = agent.deviceId;
    calls.set(call.id, call);
    call.frame({ t: 'id', id: call.id });
    call.timer = setTimeout(() => settle(call, hostDown('电脑端 20 秒内没有启动进程')), EXEC_PICKUP_MS);
    push(agent, { type: 'exec', id: call.id, spec });
    req.on('data', chunk => {
      if (call.done) return;
      if (!agent.res.write(`${JSON.stringify({ type: 'stdin', id: call.id, data: chunk.toString('base64') })}\n`)) { req.pause(); agent.res.once('drain', () => req.resume()); }
    });
    req.once('end', () => { if (!call.done) push(agent, { type: 'stdin-end', id: call.id }); });
    res.once('close', () => {
      if (call.done) return;
      push(agent, { type: 'kill', id: call.id, signal: 'SIGKILL' });
      settle(call, null);
    });
  }

  async function instanceRoutes(req, res, path, method) {
    if (!path.startsWith('/internal/remote/')) return false;
    if (!isLoopback(req)) { res.writeHead(404); res.end(); return true; }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const userId = token ? instanceUser(token) : null;
    if (!userId) return json(res, 401, { error: { message: '实例凭据无效' } }), true;
    if (method === 'GET' && path === '/internal/remote/status') {
      const agent = agentFor(userId);
      json(res, 200, { online: !!agent, home: agent?.home || null, platform: agent?.platform || null });
      return true;
    }
    if (method === 'POST' && path === '/internal/remote/fs') {
      let request;
      try { request = parseJson(await readBody(req)); } catch (error) { return json(res, error.status || 400, { ok: false, error: { code: 'EINVAL', message: error.message } }), true; }
      if (!request || typeof request.op !== 'string' || !Array.isArray(request.args)) return json(res, 400, { ok: false, error: { code: 'EINVAL', message: '参数不正确' } }), true;
      try { json(res, 200, { ok: true, value: await fsCallOn(agentFor(userId), request.op, request.args) }); }
      catch (error) { json(res, 200, { ok: false, error: { ...(error.remote || {}), code: error.code || 'EIO', message: error.message } }); }
      return true;
    }
    if (method === 'POST' && path === '/internal/remote/http') {
      let request;
      try { request = parseJson(await readBody(req, HTTP_BODY_MAX)); } catch (error) { return json(res, error.status || 400, { ok: false, error: { code: 'EINVAL', message: error.message } }), true; }
      if (!request || typeof request.url !== 'string' || !Array.isArray(request.hosts)) return json(res, 400, { ok: false, error: { code: 'EINVAL', message: '参数不正确' } }), true;
      try { json(res, 200, { ok: true, value: await httpCall(userId, request) }); }
      catch (error) { json(res, 200, { ok: false, error: { ...(error.remote || {}), code: error.code || 'EIO', message: error.message } }); }
      return true;
    }
    if (method === 'POST' && path === '/internal/remote/exec') { execCall(req, res, userId); return true; }
    if (method === 'POST' && path === '/internal/remote/kill') {
      let request;
      try { request = parseJson(await readBody(req, 4096)); } catch { request = null; }
      const call = request && calls.get(request.id);
      if (call && call.kind === 'exec' && call.userId === userId && ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(request.signal)) {
        const agent = [...agents.values()].find(item => item.deviceId === call.deviceId);
        if (agent) push(agent, { type: 'kill', id: call.id, signal: request.signal });
      }
      res.writeHead(204); res.end();
      return true;
    }
    json(res, 404, { error: { message: '接口不存在' } });
    return true;
  }

  return {
    bridgeRoutes, instanceRoutes, scanRepositories,
    active: userId => userCalls(userId) > 0,
    status: userId => { const agent = agentFor(userId); return agent ? { online: true, home: agent.home, platform: agent.platform } : { online: false }; },
    close: () => { for (const call of [...calls.values()]) settle(call, hostDown('服务正在重启')); for (const agent of agents.values()) agent.res.destroy(); },
  };
}

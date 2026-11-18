import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fail, sha } from './common.mjs';

const COOKIE = '__Host-tfwb';
const TASKFLOW_COOKIE = 'taskflow_session';
const CODE_MS = 60_000;
const ONLINE_MS = 45_000;
const WAIT_MAX_S = 25;
const PICKUP_MS = 20_000;
const HEAD_MS = 120_000;
const BODY_MAX = 32 * 1024 * 1024;
const USER_PENDING_MAX = 96;
const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding', 'proxy-authorization', 'proxy-connection',
  'authorization', 'content-length', 'accept-encoding', 'forwarded', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'upgrade', 'trailer', 'strict-transport-security']);

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeReturn = value => typeof value === 'string' && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && !/[\r\n]/.test(value) ? value : '/';
const cookieValue = (req, name) => req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
const isGatewayCookie = value => [COOKIE, TASKFLOW_COOKIE].some(name => value.trimStart().startsWith(`${name}=`));

export function workbenchPublicUrl(host) {
  const authority = /^[a-z0-9.-]+(?::([0-9]{1,5}))?$/i.exec(host || '');
  if (!authority) throw new Error('TASKFLOW_WORKBENCH_HOST must be a host with an optional port');
  const port = Number(authority[1] ?? 443);
  if (port < 1 || port > 65535) throw new Error('TASKFLOW_WORKBENCH_HOST port must be 1..65535');
  return new URL(`https://${host}`);
}

function page(res, status, title, body, publicOrigin, { refreshSec = 0 } = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', ...(refreshSec ? { 'Retry-After': String(refreshSec) } : {}) });
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ''}<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f6f7f9;color:#1f2329}main{max-width:520px;padding:32px;background:#fff;border:1px solid #e5e6eb;border-radius:12px}h1{font-size:20px;margin:0 0 12px}code{background:#f2f3f5;padding:1px 6px;border-radius:4px}a,button{color:#1664ff}button{border:1px solid #1664ff;background:#fff;border-radius:6px;padding:4px 14px;cursor:pointer;margin-right:12px}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}<p><button onclick="location.reload()">重新连接</button><a href="${escapeHtml(publicOrigin)}/">返回任务中心</a></p></main></body></html>`);
}

/**
 * Multi-user workbench: the browser talks to a dedicated HTTPS origin; each relay request goes only to a Bridge device
 * owned by the signed-in TaskFlow user, which forwards it to that person's own local workbench.
 */
export function createWorkbenchGateway({ db, audit, host, publicOrigin, now = Date.now, logger = console, instances = null }) {
  const { origin, host: authority } = workbenchPublicUrl(host);
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),parent_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workbench_session_parent_idx ON workbench_sessions(parent_hash);`);
  const codes = new Map();
  const online = new Map();
  const waiters = new Map();
  const queues = new Map();
  const pending = new Map();

  const liveDevice = (deviceId, userId) => db.prepare(`SELECT d.id FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash
    WHERE d.id=? AND d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>?`).get(deviceId, userId, now(), now());
  const deviceFor = userId => {
    const candidates = [...online.entries()].filter(([, item]) => item.userId === userId && (item.polling > 0 || now() - item.lastPoll <= ONLINE_MS))
      .sort((a, b) => b[1].lastPoll - a[1].lastPoll);
    for (const [deviceId] of candidates) if (liveDevice(deviceId, userId)) return deviceId;
    return null;
  };
  const sessionUser = req => {
    const token = cookieValue(req, COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.prepare(`SELECT u.id,u.username,u.role FROM workbench_sessions w JOIN sessions s ON s.token_hash=w.parent_hash JOIN users u ON u.id=w.user_id
      WHERE w.token_hash=? AND w.expires_at>? AND s.expires_at>?`).get(sha(token), now(), now()) || null;
  };

  function issueCode(req, user, body) {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备不能登录网页工作台');
    if (user.authTransport !== 'COOKIE' || !req.headers.origin) fail(403, 'BROWSER_SESSION_REQUIRED', '请在已登录的任务中心网页中打开工作台');
    if (!body || Object.keys(body).some(key => key !== 'return')) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
    for (const [key, item] of codes) if (item.expiresAt <= now()) codes.delete(key);
    const code = randomBytes(32).toString('base64url');
    const returnTo = safeReturn(body.return);
    codes.set(sha(code), { userId: user.id, parentHash: user.token_hash, returnTo, expiresAt: now() + CODE_MS });
    return { url: `${origin}/__taskflow/callback?code=${code}` };
  }

  function callback(req, res, url) {
    const code = url.searchParams.get('code') || '';
    const item = /^[A-Za-z0-9_-]{43}$/.test(code) ? codes.get(sha(code)) : null;
    if (item) codes.delete(sha(code));
    const parent = item && item.expiresAt > now() ? db.prepare('SELECT expires_at FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?').get(item.parentHash, item.userId, now()) : null;
    if (!parent) return page(res, 400, '登录链接已失效', '<p>请回到任务中心重新打开「我的工作台」。</p>', publicOrigin);
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM workbench_sessions WHERE expires_at<=?').run(now());
    db.prepare('INSERT INTO workbench_sessions VALUES (?,?,?,?,?)').run(sha(token), item.userId, item.parentHash, now(), parent.expires_at);
    audit(item.userId, 'WORKBENCH_LOGIN', item.userId);
    const maxAge = Math.max(1, Math.floor((parent.expires_at - now()) / 1000));
    res.writeHead(302, { Location: item.returnTo, 'Cache-Control': 'no-store', 'Set-Cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` });
    res.end();
  }

  const enqueue = (deviceId, item) => {
    const list = waiters.get(deviceId);
    const waiter = list?.shift();
    if (waiter) return waiter(item);
    if (!queues.has(deviceId)) queues.set(deviceId, []);
    queues.get(deviceId).push(item);
  };
  const dropQueued = item => {
    const list = queues.get(item.deviceId);
    const index = list ? list.indexOf(item) : -1;
    if (index >= 0) list.splice(index, 1);
  };
  const finish = (item, status, title, html) => {
    if (item.done) return;
    item.done = true;
    clearTimeout(item.timer);
    dropQueued(item);
    pending.delete(item.id);
    if (status && !item.res.headersSent && !item.res.destroyed) {
      if (item.wantsHtml) page(item.res, status, title, html, publicOrigin);
      else { item.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); item.res.end(JSON.stringify({ error: { code: 'WORKBENCH_RELAY', message: title } })); }
    } else if (!item.res.writableEnded) item.res.destroy();
    item.upstream?.destroy();
  };

  async function readBrowserBody(req) {
    if (['GET', 'HEAD'].includes(req.method)) return '';
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > BODY_MAX) fail(413, 'BODY_TOO_LARGE', '请求内容超过 32 MiB');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > BODY_MAX) fail(413, 'BODY_TOO_LARGE', '请求内容超过 32 MiB'); chunks.push(chunk); }
    return Buffer.concat(chunks).toString('base64');
  }

  async function relay(req, res, user) {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { code: 'ORIGIN_REJECTED', message: '请求来源不受支持' } }));
    }
    const wantsHtml = req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
    const deviceId = deviceFor(user.id);
    if (!deviceId) {
      return page(res, 503, '你的电脑未连接', `<p>${escapeHtml(user.username)}，网页工作台需要你电脑上的本机工作台和 TaskFlow Bridge 都在运行，并已开启工作台转发。</p>
<p>请确认本机工作台已启动，然后在终端运行 <code>~/.taskflow/bin/taskflow-bridge service --action status</code> 检查 Bridge。接通后本页会自动重试。</p>`, publicOrigin, { refreshSec: 5 });
    }
    if ([...pending.values()].filter(item => item.userId === user.id).length >= USER_PENDING_MAX) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { code: 'TOO_MANY_REQUESTS', message: '同时进行的请求过多，请稍后重试' } }));
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (DROP_REQUEST_HEADERS.has(name) || value === undefined) continue;
      if (name === 'cookie') {
        const rest = String(value).split(';').map(item => item.trim()).filter(item => item && !isGatewayCookie(item));
        if (rest.length) headers.cookie = rest.join('; ');
        continue;
      }
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const body = await readBrowserBody(req);
    const item = { id: randomUUID(), deviceId, userId: user.id, res, wantsHtml, done: false, phase: 'queued', upstream: null,
      request: { method: req.method, path: req.url, headers, body } };
    pending.set(item.id, item);
    res.on('close', () => { if (!item.done) finish(item); });
    item.timer = setTimeout(() => finish(item, 504, '本机工作台没有响应', '<p>Bridge 在线，但 20 秒内没有领取请求。请检查本机网络，或重启 Bridge 后重试。</p>'), PICKUP_MS);
    enqueue(deviceId, item);
  }

  function startingPage(res, wantsHtml, phase, message) {
    if (!wantsHtml) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
      return res.end(JSON.stringify({ error: { code: phase === 'starting' ? 'WORKBENCH_STARTING' : 'WORKBENCH_UNAVAILABLE', message: message || '服务器工作台正在启动' } }));
    }
    if (phase === 'starting') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3', 'X-Frame-Options': 'DENY' });
      return res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>工作台启动中</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#f6f7f9;color:#1f2329}main{padding:32px;background:#fff;border:1px solid #e5e6eb;border-radius:12px}</style></head>
<body><main><h1>你的工作台正在服务器上启动…</h1><p>首次启动约需 20–60 秒，页面会自动刷新。</p></main></body></html>`);
    }
    return page(res, 503, phase === 'offline' ? '你的电脑未连接' : '服务器工作台暂不可用', `<p>${escapeHtml(message || '')}</p>`, publicOrigin, { refreshSec: 5 });
  }

  async function proxy(req, res, user) {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { code: 'ORIGIN_REJECTED', message: '请求来源不受支持' } }));
    }
    const wantsHtml = req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
    const state = await instances.ensure(user.id);
    if (state.phase !== 'ready') {
      const who = user.username ? `${user.username}：` : '';
      const detail = state.message ? `${who}${state.message}` : state.message;
      return startingPage(res, wantsHtml, state.phase, detail);
    }
    const target = `127.0.0.1:${state.port}`;
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (DROP_REQUEST_HEADERS.has(name) && !['content-length', 'transfer-encoding', 'accept-encoding'].includes(name) || value === undefined) continue;
      if (name === 'cookie') {
        const rest = String(value).split(';').map(item => item.trim()).filter(item => item && !isGatewayCookie(item));
        if (rest.length) headers.cookie = rest.join('; ');
        continue;
      }
      headers[name] = value;
    }
    headers.host = target;
    if (headers.origin) headers.origin = `http://${target}`;
    if (typeof headers.referer === 'string' && headers.referer.startsWith(`${origin}/`)) headers.referer = `http://${target}${headers.referer.slice(origin.length)}`;
    const release = instances.hold(user.id);
    res.once('close', release);
    const upstream = http.request({ host: '127.0.0.1', port: state.port, method: req.method, path: req.url, headers }, response => {
      const out = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (['connection', 'keep-alive', 'upgrade', 'trailer', 'strict-transport-security'].includes(name)) continue;
        if (name === 'set-cookie') {
          const cookies = value.filter(cookie => !isGatewayCookie(cookie));
          if (cookies.length) out[name] = cookies;
          continue;
        }
        out[name] = name === 'location' && typeof value === 'string' ? value.replace(/^https?:\/\/(127\.0\.0\.1|localhost):\d+/, origin) : value;
      }
      res.writeHead(response.statusCode || 502, out);
      res.flushHeaders();
      response.pipe(res);
      response.once('error', () => res.destroy());
    });
    upstream.once('error', () => {
      if (!res.headersSent) startingPage(res, wantsHtml, 'failed', '服务器工作台暂时没有响应，请稍后重试');
      else res.destroy();
    });
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  const requireDevice = user => {
    if (!user.localDevice) fail(403, 'BRIDGE_DEVICE_REQUIRED', '仅已配对的本机 Bridge 可使用工作台转发');
    return user.localDevice;
  };
  const touch = device => db.prepare('UPDATE local_device_sessions SET last_seen_at=? WHERE id=?').run(new Date(now()).toISOString(), device.id);

  async function next(req, device, waitSeconds) {
    const state = online.get(device.id) || { userId: device.user_id, lastPoll: 0, polling: 0 };
    state.lastPoll = now(); state.userId = device.user_id; online.set(device.id, state);
    touch(device);
    const take = item => {
      if (item.done) return null;
      clearTimeout(item.timer);
      item.phase = 'dispatched';
      item.timer = setTimeout(() => finish(item, 504, '本机工作台响应超时', '<p>本机工作台 2 分钟内没有返回响应。</p>'), HEAD_MS);
      return { id: item.id, ...item.request };
    };
    const queue = queues.get(device.id);
    while (queue?.length) { const ready = take(queue.shift()); if (ready) return { request: ready }; }
    const wait = Math.min(Math.max(waitSeconds, 0), WAIT_MAX_S) * 1000;
    if (!wait) return { request: null };
    state.polling += 1;
    try {
      for (;;) {
        const item = await new Promise(resolve => {
          const list = waiters.get(device.id) || [];
          waiters.set(device.id, list);
          const done = value => { clearTimeout(timer); req.off('close', closed); const index = list.indexOf(done); if (index >= 0) list.splice(index, 1); resolve(value); };
          const closed = () => done(null);
          const timer = setTimeout(() => done(null), wait);
          req.once('close', closed);
          list.push(done);
        });
        if (!item) return { request: null };
        if (req.destroyed) { enqueue(device.id, item); return { request: null }; }
        const ready = take(item);
        if (ready) return { request: ready };
      }
    } finally { state.polling -= 1; state.lastPoll = now(); }
  }

  const parseHead = text => {
    let head;
    try { head = JSON.parse(text); } catch { return null; }
    const { status, headers: pairs } = head || {};
    if (!Number.isInteger(status) || status < 100 || status > 599) return null;
    if (!Array.isArray(pairs) || pairs.length > 200 || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== 'string' || /[\r\n]/.test(part)))) return null;
    const headers = {};
    for (const [name, value] of pairs) {
      const key = name.toLowerCase();
      if (DROP_RESPONSE_HEADERS.has(key)) continue;
      if (key === 'set-cookie') {
        if (!isGatewayCookie(value)) (headers[key] ||= []).push(value);
      }
      else headers[key] = value;
    }
    return { status, headers };
  };

  // The Bridge posts one JSON line ({status, headers}) followed by the raw response body.
  function respond(req, res, device, id) {
    const item = pending.get(id);
    if (!item || item.deviceId !== device.id || item.phase !== 'dispatched') fail(404, 'TUNNEL_REQUEST_NOT_FOUND', '转发请求不存在或已结束');
    item.phase = 'streaming';
    item.upstream = req;
    return new Promise(resolve => {
      let settled = false; let buffered = Buffer.alloc(0); let started = false;
      const end = ok => {
        if (settled) return;
        settled = true;
        if (!item.done) {
          if (!started) { finish(item, 502, '本机工作台返回了无效响应', '<p>请升级 TaskFlow Bridge 后重试。</p>'); reply(ok ? 400 : 499); return resolve(); }
          item.done = true; clearTimeout(item.timer); pending.delete(item.id);
          if (ok) item.res.end(); else item.res.destroy();
        }
        reply(ok ? 204 : 499);
        resolve();
      };
      const reply = status => { if (!res.headersSent && !res.destroyed) { res.writeHead(status); res.end(); } };
      const write = chunk => { if (chunk.length && !item.res.write(chunk)) { req.pause(); item.res.once('drain', () => req.resume()); } };
      req.on('data', chunk => {
        if (item.done) return;
        if (started) return write(chunk);
        buffered = Buffer.concat([buffered, chunk]);
        const newline = buffered.indexOf(10);
        if (newline < 0) { if (buffered.length > 262_144) { req.destroy(); end(false); } return; }
        const head = parseHead(buffered.subarray(0, newline).toString('utf8'));
        if (!head) { req.destroy(); return end(false); }
        try { item.res.writeHead(head.status, head.headers); } catch { req.destroy(); return end(false); }
        started = true; clearTimeout(item.timer);
        item.res.flushHeaders();
        write(buffered.subarray(newline + 1));
        buffered = null;
      });
      req.once('end', () => end(true));
      req.once('close', () => end(false));
      req.once('error', () => end(false));
      item.res.once('close', () => { if (!settled) { req.destroy(); end(false); } });
    });
  }

  async function tunnelRoutes({ req, res, method, path, url, user, send }) {
    if (method === 'GET' && path === '/api/bridge/tunnel/next') {
      const device = requireDevice(user);
      const wait = Number(url.searchParams.get('wait') || 0);
      if (!Number.isFinite(wait)) fail(400, 'INVALID_INPUT', 'wait格式不正确');
      send(200, await next(req, device, wait));
      return true;
    }
    const match = path.match(/^\/api\/bridge\/tunnel\/responses\/([0-9a-f-]{36})$/);
    if (match && method === 'POST') {
      const device = requireDevice(user);
      touch(device);
      await respond(req, res, device, match[1]);
      return true;
    }
    return false;
  }

  function apiRoutes({ req, method, path, user, body, send }) {
    if (method === 'POST' && path === '/api/workbench/codes') { send(200, issueCode(req, user, body)); return true; }
    if (method === 'GET' && path === '/api/workbench/status') {
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权查看');
      send(200, { url: `${origin}/`, online: instances ? instances.agentOnline(user.id) : !!deviceFor(user.id), mode: instances ? 'server' : 'relay' });
      return true;
    }
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (req.headers.host?.toLowerCase() !== authority) { res.writeHead(421); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/__taskflow/callback') return callback(req, res, url);
      const user = sessionUser(req);
      if (req.method === 'POST' && url.pathname === '/__taskflow/logout') {
        if (req.headers.origin !== origin) { res.writeHead(403); return res.end(); }
        const token = cookieValue(req, COOKIE);
        if (token) db.prepare('DELETE FROM workbench_sessions WHERE token_hash=?').run(sha(token));
        res.writeHead(204, { 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
        return res.end();
      }
      if (!user) {
        if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
          res.writeHead(302, { Location: `${publicOrigin}/?workbench=1&return=${encodeURIComponent(safeReturn(url.pathname + url.search))}`, 'Cache-Control': 'no-store' });
          return res.end();
        }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '请先在任务中心登录' } }));
      }
      await (instances ? proxy(req, res, user) : relay(req, res, user));
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const status = error?.status || 500;
      if (status === 500) logger.error('Workbench gateway request failed');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: error?.code || 'INTERNAL_ERROR', message: status === 500 ? '工作台网关处理失败' : error.message } }));
    }
  });
  server.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'); });

  return { server, tunnelRoutes, apiRoutes, close: () => { for (const item of pending.values()) finish(item); } };
}

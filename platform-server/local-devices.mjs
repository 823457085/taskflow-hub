import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, sha, textField, publicUser, TOOLS } from './common.mjs';

const PAIR_MS = 10 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const HOST_SESSION_MS = 7 * 24 * 60 * 60_000;
const INTERVAL_MS = 3000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const hostBridgeRequest = req => isLoopback(req.socket.remoteAddress) && loopbackHost.test(req.headers.host || '') &&
  !Object.keys(req.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'));
const keys = (body, allowed) => { if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const codeHash = code => {
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i.test(code.trim())) fail(400, 'INVALID_USER_CODE', '请输入终端显示的8位配对码');
  return sha(code.trim().replace('-', '').toUpperCase());
};

function readHostSession(dir) {
  if (!dir) return null;
  const filePath = join(dir, 'session.json');
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) return { unsafe: true };
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    if (typeof parsed?.token !== 'string' || parsed.token.length < 16 || parsed.token.length > 4096 || typeof parsed?.deviceId !== 'string') return { unsafe: true };
    const tokenHash = sha(parsed.token);
    const bindingRevision = sha(`host-bridge:${parsed.deviceId}:${tokenHash}`);
    return { tokenHash, deviceId: parsed.deviceId, filePath, bindingRevision };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { unsafe: true };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function writeHostSession(dir, payload, expectedRevision) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) fail(500, 'UNSAFE_BRIDGE_STATE', '本机桥接目录状态不安全');
  chmodSync(dir, 0o700);
  const filePath = join(dir, 'session.json');
  const current = readHostSession(dir);
  if (current?.unsafe) fail(500, 'UNSAFE_BRIDGE_STATE', '本机桥接登录文件状态不安全');
  if (current?.bindingRevision !== expectedRevision) fail(409, 'HOST_BRIDGE_BINDING_CHANGED', '本机连接已变化，请刷新后再确认');
  const temporary = join(dir, `.session-${randomUUID()}.tmp`);
  const backup = current ? temporary + '.previous' : null;
  try {
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    if (backup) linkSync(filePath, backup);
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    if (backup) try { unlinkSync(backup); } catch {}
    fail(500, 'BRIDGE_WRITE_FAILED', '无法写入本机桥接会话文件');
  }
  return committed => {
    if (!committed && readHostSession(dir)?.tokenHash === sha(payload.token)) {
      if (backup) renameSync(backup, filePath);
      else unlinkSync(filePath);
    } else if (backup) try { unlinkSync(backup); } catch {}
  };
}

function removeHostSessionIfMatching(dir, deviceId) {
  const current = readHostSession(dir);
  if (!current || current.unsafe || current.deviceId !== deviceId) return;
  try { unlinkSync(current.filePath); } catch {}
}

export function createLocalDevices({ db, transaction, audit, projectRole, visibleProjects, now = Date.now, hostBridgeStateDir = null, hostBridgeApiUrl = 'http://127.0.0.1:5187', clientIp = req => req.socket.remoteAddress || 'unknown', sessionMs = SESSION_MS }) {
  const limits = new Map();
  const rate = (key, maximum) => {
    const time = now();
    if (limits.size >= 1024) for (const [id, entry] of limits) if (entry.until <= time) limits.delete(id);
    const old = limits.get(key);
    if (!old && limits.size >= 1024 || old?.until > time && old.count >= maximum) fail(429, 'TRY_LATER', '配对请求过于频繁，请稍后重试');
    limits.set(key, { count: old?.until > time ? old.count + 1 : 1, until: old?.until > time ? old.until : time + 60_000 });
  };
  const liveRequest = row => {
    if (!row) fail(404, 'PAIRING_NOT_FOUND', '配对申请不存在');
    if (row.expires_at <= now()) fail(410, 'PAIRING_EXPIRED', '配对申请已过期，请在终端重新发起');
    return row;
  };
  const browser = (req, user, mutate = false) => {
    if (user.localDevice || user.authTransport !== 'COOKIE' || mutate && !req.headers.origin) fail(403, 'BROWSER_SESSION_REQUIRED', '请在已登录的平台网页中管理本地设备');
  };
  const hostSessionRow = stored => stored && db.prepare(
    'SELECT d.*,s.expires_at AS active_until FROM local_device_sessions d LEFT JOIN sessions s ON d.token_hash=s.token_hash AND d.user_id=s.user_id WHERE d.token_hash=? AND d.id=?',
  ).get(stored.tokenHash, stored.deviceId);
  const hostSessionStatus = row => {
    if (!row) return 'EXPIRED';
    if (row.revoked_at) return 'REVOKED';
    const time = now();
    if (row.expires_at <= time) return 'EXPIRED';
    if (!row.active_until) return 'REVOKED';
    return row.active_until <= time ? 'EXPIRED' : 'ACTIVE';
  };
  const hasActiveBridgeRuns = deviceId => !!db.prepare("SELECT 1 FROM local_ai_runs WHERE runner='bridge' AND device_id=? AND status='RUNNING' LIMIT 1").get(deviceId);
  const requireBridgeIdle = (deviceId, workbenchOwnerId) => {
    const workbenchBusy = workbenchOwnerId && db.prepare("SELECT 1 FROM local_ai_runs WHERE runner='workbench' AND actor_id=? AND status='RUNNING' LIMIT 1").get(workbenchOwnerId);
    if (workbenchBusy || hasActiveBridgeRuns(deviceId)) fail(409, 'BRIDGE_DEVICE_BUSY', '原连接还有排队或运行中的任务，请待任务结束后再切换');
  };
  const publicRoutes = ({ req, path, method, body, send }) => {
    if (method !== 'POST' || !['/api/device-authorizations', '/api/device-authorizations/poll'].includes(path)) return false;
    const ip = clientIp(req);
    if (path === '/api/device-authorizations') {
      rate('start:' + ip, 10); keys(body, ['deviceName', 'tool']);
      const deviceName = textField(body.deviceName, 'deviceName', { max: 80 });
      if (/[\r\n\t]/.test(deviceName) || !TOOLS.includes(body.tool)) fail(400, 'INVALID_DEVICE', '请提供有效的设备名称与客户端标记');
      db.prepare('DELETE FROM local_authorizations WHERE expires_at<=?').run(now());
      if (db.prepare('SELECT COUNT(*) AS count FROM local_authorizations').get().count >= 1000) fail(429, 'TRY_LATER', '当前配对申请较多，请稍后重试');
      const deviceCode = randomBytes(32).toString('base64url');
      const rawCode = [...randomBytes(8)].map(value => alphabet[value & 31]).join('');
      const expires = now() + PAIR_MS;
      db.prepare('INSERT INTO local_authorizations (device_hash,user_hash,device_name,tool,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(sha(deviceCode), sha(rawCode), deviceName, body.tool, expires, new Date(now()).toISOString());
      send(201, { deviceCode, userCode: rawCode.slice(0, 4) + '-' + rawCode.slice(4), expiresAt: new Date(expires).toISOString(), interval: INTERVAL_MS / 1000 });
      return true;
    }
    rate('poll:' + ip, 240); keys(body, ['deviceCode']);
    if (typeof body.deviceCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.deviceCode)) fail(400, 'INVALID_DEVICE_CODE', '设备配对凭据无效，请重新发起');
    const result = transaction(() => {
      const row = liveRequest(db.prepare('SELECT * FROM local_authorizations WHERE device_hash=?').get(sha(body.deviceCode)));
      if (row.status === 'CONSUMED') fail(409, 'PAIRING_CONSUMED', '配对申请已使用，请重新发起');
      if (row.last_poll_at && now() - row.last_poll_at < INTERVAL_MS) fail(429, 'SLOW_DOWN', '请按终端提示的间隔等待配对结果');
      db.prepare('UPDATE local_authorizations SET last_poll_at=? WHERE device_hash=?').run(now(), row.device_hash);
      if (row.status !== 'APPROVED') return { status: row.status };
      const user = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(row.user_id);
      if (!user) fail(410, 'PAIRING_REVOKED', '授权成员已不可用，请重新发起');
      const projectIds = JSON.parse(row.project_ids);
      for (const id of projectIds) projectRole(user, id);
      const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expires = now() + sessionMs;
      db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), user.id, expires);
      db.prepare('INSERT INTO local_device_sessions (id,token_hash,user_id,device_name,tool,project_ids,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, sha(token), user.id, row.device_name, row.tool, row.project_ids, expires, new Date(now()).toISOString());
      db.prepare("UPDATE local_authorizations SET status='CONSUMED' WHERE device_hash=?").run(row.device_hash);
      audit(user.id, 'LOCAL_DEVICE_CONNECTED', id);
      return { status: 'AUTHORIZED', token, user: publicUser(user), deviceId: id, projectIds, expiresAt: new Date(expires).toISOString() };
    });
    send(200, result);
    return true;
  };
  const session = hash => db.prepare('SELECT * FROM local_device_sessions WHERE token_hash=?').get(hash);
  const authorizeRequest = ({ method, path, body, user }) => {
    const device = user.localDevice; if (!device) return;
    const read = method === 'GET' && (/^\/api\/(?:me|projects|tasks|jobs)$/.test(path) || /^\/api\/tasks\/[^/]+(?:\/(?:context|assets|gates|bundle))?$/.test(path) || /^\/api\/jobs\/[^/]+$/.test(path) || path === '/api/bridge/runs/next' || /^\/api\/knowledge(?:\/[^/]+)?$/.test(path) && path !== '/api/knowledge/import' || path === '/api/skills');
    const write = method === 'POST' && (path === '/api/logout' || /^\/api\/tasks\/[^/]+\/(?:claim|progress|heartbeat)$/.test(path) || /^\/api\/jobs\/[^/]+\/report$/.test(path) || /^\/api\/bridge\/runs\/[^/]+\/(?:claim|progress|result)$/.test(path) || ['/api/agent-sessions/sync', '/api/deployments/sync'].includes(path));
    const todo = path === '/api/todos' && ['GET', 'POST'].includes(method) || path === '/api/todos/import' && method === 'POST' || /^\/api\/todos\/[0-9a-f-]{36}$/i.test(path) && ['PATCH', 'DELETE'].includes(method);
    if (!read && !write && !todo) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备仅可读取已授权项目任务，提交认领、进度、心跳和报告，领取派发，同步 Agent 与部署记录，管理个人待办，以及读取知识库和团队 Skill');
    if (/^\/api\/tasks\/[^/]+\/(progress|heartbeat)$/.test(path) && body?.deviceId !== device.id) fail(403, 'DEVICE_ID_MISMATCH', '设备标识与当前配对会话不一致');
    db.prepare('UPDATE local_device_sessions SET last_seen_at=? WHERE id=?').run(new Date(now()).toISOString(), device.id);
  };
  const authenticatedRoutes = ({ req, path, method, body, user, send }) => {
    if (method === 'POST' && ['/api/device-authorizations/inspect', '/api/device-authorizations/decision'].includes(path)) {
      browser(req, user, true); rate('inspect:' + user.id, 30);
      keys(body, path.endsWith('/inspect') ? ['userCode'] : ['userCode', 'decision', 'projectIds']);
      const row = liveRequest(db.prepare('SELECT * FROM local_authorizations WHERE user_hash=?').get(codeHash(body.userCode)));
      if (row.user_id && row.user_id !== user.id) fail(404, 'PAIRING_NOT_FOUND', '配对申请不存在');
      if (path.endsWith('/inspect')) { send(200, { request: { deviceName: row.device_name, tool: row.tool, status: row.status, expiresAt: new Date(row.expires_at).toISOString() } }); return true; }
      if (!['APPROVE', 'DENY'].includes(body.decision)) fail(400, 'INVALID_DECISION', '请选择批准或拒绝');
      if (row.status !== 'PENDING') fail(409, 'PAIRING_DECIDED', '配对申请已处理，请勿重复批准或拒绝');
      let projectIds = [];
      if (body.decision === 'APPROVE') {
        if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.length > 100 || body.projectIds.some(id => typeof id !== 'string' || id.length > 80)) fail(400, 'PROJECT_SCOPE_REQUIRED', '请明确选择至少一个可访问项目');
        projectIds = [...new Set(body.projectIds)]; for (const id of projectIds) projectRole(user, id);
      }
      const status = body.decision === 'APPROVE' ? 'APPROVED' : 'DENIED';
      transaction(() => {
        const current = liveRequest(db.prepare('SELECT * FROM local_authorizations WHERE device_hash=?').get(row.device_hash));
        if (current.status !== 'PENDING') fail(409, 'PAIRING_DECIDED', '配对申请已处理，请勿重复批准或拒绝');
        db.prepare('UPDATE local_authorizations SET status=?,user_id=?,project_ids=? WHERE device_hash=?').run(status, user.id, JSON.stringify(projectIds), row.device_hash);
        audit(user.id, 'LOCAL_DEVICE_' + (status === 'APPROVED' ? 'APPROVE' : 'DENY'), 'pairing');
      });
      send(200, { status }); return true;
    }
    if (method === 'GET' && path === '/api/local-devices/host-bridge') {
      browser(req, user);
      const accessible = visibleProjects ? visibleProjects(user) : [];
      const accessibleIds = new Set(accessible.map(project => project.id));
      const latest = db.prepare('SELECT project_ids FROM local_device_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user.id);
      let suggestedProjectIds = [];
      if (latest?.project_ids) {
        try { suggestedProjectIds = JSON.parse(latest.project_ids).filter(id => accessibleIds.has(id)); } catch { suggestedProjectIds = []; }
      }
      if (!suggestedProjectIds.length) {
        const jiraBound = accessible.filter(project => project.jira).map(project => project.id);
        suggestedProjectIds = jiraBound.length ? jiraBound : accessible.map(project => project.id);
      }
      const supported = !!hostBridgeStateDir && hostBridgeRequest(req);
      if (!supported) { send(200, { supported: false, connected: false, status: 'UNSUPPORTED', device: null, suggestedProjectIds }); return true; }
      const stored = readHostSession(hostBridgeStateDir);
      if (!stored) { send(200, { supported: true, connected: false, status: 'DISCONNECTED', device: null, suggestedProjectIds }); return true; }
      if (stored.unsafe) { send(200, { supported: true, connected: false, status: 'INVALID', device: null, suggestedProjectIds }); return true; }
      const { bindingRevision } = stored;
      const row = hostSessionRow(stored);
      const status = hostSessionStatus(row);
      if (!row || row.user_id !== user.id) {
        send(200, { supported: true, connected: false, status: status === 'ACTIVE' ? 'OTHER_USER' : status, device: null, suggestedProjectIds, bindingRevision });
        return true;
      }
      const projectIds = JSON.parse(row.project_ids).filter(id => accessibleIds.has(id));
      send(200, {
        supported: true, connected: status === 'ACTIVE', status, bindingRevision, suggestedProjectIds: projectIds.length ? projectIds : suggestedProjectIds,
        device: {
          id: row.id, deviceName: row.device_name, tool: row.tool, projectIds: JSON.parse(row.project_ids),
          createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: new Date(row.expires_at).toISOString(), scope: 'LOCAL_BRIDGE', status,
        },
      });
      return true;
    }
    if (method === 'POST' && path === '/api/local-devices/host-bridge') {
      browser(req, user, true); rate('host:' + user.id, 20);
      if (!hostBridgeStateDir || !hostBridgeRequest(req)) fail(403, 'HOST_BRIDGE_UNAVAILABLE', '当前仅支持在本机回环网页中一键授权本机桥接');
      keys(body, ['deviceName', 'tool', 'projectIds', 'replaceBindingRevision']);
      const revision = body.replaceBindingRevision;
      if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) {
        fail(400, 'INVALID_HOST_BRIDGE_BINDING', '本机连接标识无效，请刷新后再确认');
      }
      const deviceName = body.deviceName === undefined ? '工作台与本地 AI' : textField(body.deviceName, 'deviceName', { max: 80 });
      const tool = body.tool === undefined ? 'custom' : body.tool;
      if (/[\r\n\t]/.test(deviceName) || !TOOLS.includes(tool)) fail(400, 'INVALID_DEVICE', '请提供有效的设备名称与客户端标记');
      if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.length > 100 || body.projectIds.some(id => typeof id !== 'string' || id.length > 80)) fail(400, 'PROJECT_SCOPE_REQUIRED', '请明确选择至少一个可访问项目');
      const projectIds = [...new Set(body.projectIds)];
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const createdAt = new Date(now()).toISOString();
      const expires = now() + HOST_SESSION_MS;
      const expiresAt = new Date(expires).toISOString();
      let finishHostSession;
      try {
        transaction(() => {
          for (const projectId of projectIds) projectRole(user, projectId);
          const existing = readHostSession(hostBridgeStateDir);
          if (existing?.unsafe) fail(500, 'UNSAFE_BRIDGE_STATE', '本机桥接登录文件状态不安全');
          if (revision !== undefined && revision !== existing?.bindingRevision) {
            fail(409, 'HOST_BRIDGE_BINDING_CHANGED', '本机连接已变化，请刷新后再确认');
          }
          const previousRow = hostSessionRow(existing);
          const previousActive = hostSessionStatus(previousRow) === 'ACTIVE';
          if (previousActive && previousRow.user_id !== user.id && revision === undefined) {
            fail(409, 'HOST_BRIDGE_OCCUPIED', '本机已有其他成员的有效桥接会话，请确认切换后再继续');
          }
          if (previousRow && !previousRow.revoked_at && (previousRow.user_id === user.id || revision !== undefined)) {
            if (previousActive) requireBridgeIdle(previousRow.id, previousRow.user_id);
            db.prepare('DELETE FROM sessions WHERE token_hash=?').run(previousRow.token_hash);
            db.prepare('UPDATE local_device_sessions SET revoked_at=? WHERE id=?').run(createdAt, previousRow.id);
            db.prepare("UPDATE devices SET status='OFFLINE' WHERE actor_id=? AND device_id=?").run(previousRow.user_id, previousRow.id);
            if (revision !== undefined) audit(user.id, 'LOCAL_DEVICE_HOST_REPLACED', previousRow.id);
          }
          db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), user.id, expires);
          db.prepare('INSERT INTO local_device_sessions (id,token_hash,user_id,device_name,tool,project_ids,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, sha(token), user.id, deviceName, tool, JSON.stringify(projectIds), expires, createdAt);
          audit(user.id, 'LOCAL_DEVICE_HOST_CONNECTED', id);
          finishHostSession = writeHostSession(hostBridgeStateDir, { url: hostBridgeApiUrl, token, deviceId: id, projectIds, expiresAt }, existing?.bindingRevision);
        });
      } catch (error) {
        finishHostSession?.(false);
        throw error;
      }
      finishHostSession?.(true);
      send(201, {
        status: 'AUTHORIZED', connected: true, replaced: revision !== undefined,
        device: { id, deviceName, tool, projectIds, createdAt, lastSeenAt: null, expiresAt, scope: 'LOCAL_BRIDGE', status: 'ACTIVE' },
      });
      return true;
    }
    if (method === 'GET' && path === '/api/local-devices') {
      browser(req, user);
      const devices = db.prepare('SELECT d.*,s.token_hash AS active_hash FROM local_device_sessions d LEFT JOIN sessions s ON d.token_hash=s.token_hash WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 100').all(user.id).map(row => ({
        id: row.id, deviceName: row.device_name, tool: row.tool, projectIds: JSON.parse(row.project_ids), createdAt: row.created_at,
        lastSeenAt: row.last_seen_at, expiresAt: new Date(row.expires_at).toISOString(), scope: 'LOCAL_BRIDGE', teamDispatch: !!row.team_dispatch,
        status: row.revoked_at ? 'REVOKED' : row.expires_at <= now() ? 'EXPIRED' : !row.active_hash ? 'REVOKED' : 'ACTIVE',
      }));
      send(200, { devices }); return true;
    }
    const projectScope = path.match(/^\/api\/local-devices\/([a-zA-Z0-9_-]{1,80})\/projects$/);
    if (method === 'PATCH' && projectScope) {
      browser(req, user, true);
      keys(body, ['projectIds']);
      if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.length > 100 ||
        body.projectIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) {
        fail(400, 'PROJECT_SCOPE_REQUIRED', '请明确选择至少一个可访问项目');
      }
      const requested = new Set(body.projectIds);
      const device = transaction(() => {
        const time = now();
        const row = db.prepare(`SELECT d.id,d.project_ids,d.team_dispatch FROM local_device_sessions d
          JOIN sessions s ON s.token_hash=d.token_hash AND s.user_id=d.user_id
          WHERE d.id=? AND d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>?`)
          .get(projectScope[1], user.id, time, time);
        if (!row) fail(404, 'DEVICE_NOT_FOUND', '本机设备授权已失效或不存在，请重新配对');
        for (const id of requested) projectRole(user, id);
        const current = new Set(JSON.parse(row.project_ids));
        const projectIds = [...new Set([...current, ...requested])];
        const teamDispatch = Boolean(row.team_dispatch);
        if (projectIds.length > current.size) {
          if (teamDispatch) fail(409, 'BRIDGE_TEAM_DISPATCH_SCOPE_CONFLICT', '请先在设备管理中关闭「允许团队派发」，再添加授权项目');
          if (projectIds.length > 100) fail(400, 'PROJECT_SCOPE_LIMIT', '每台设备最多可授权 100 个项目');
          db.prepare('UPDATE local_device_sessions SET project_ids=? WHERE id=?').run(JSON.stringify(projectIds), row.id);
          audit(user.id, 'LOCAL_DEVICE_PROJECTS_ADDED', row.id);
        }
        return { id: row.id, projectIds, teamDispatch };
      });
      send(200, { device });
      return true;
    }
    const revoke = path.match(/^\/api\/local-devices\/([a-zA-Z0-9_-]{1,80})$/);
    if (method === 'PATCH' && revoke) {
      browser(req, user, true); keys(body || {}, ['teamDispatch']);
      if (typeof body?.teamDispatch !== 'boolean') fail(400, 'INVALID_INPUT', 'teamDispatch必须为布尔值');
      const row = db.prepare('SELECT * FROM local_device_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL').get(revoke[1], user.id);
      if (!row) fail(404, 'DEVICE_NOT_FOUND', '本地设备连接不存在');
      transaction(() => {
        db.prepare('UPDATE local_device_sessions SET team_dispatch=? WHERE id=?').run(body.teamDispatch ? 1 : 0, row.id);
        audit(user.id, body.teamDispatch ? 'LOCAL_DEVICE_TEAM_DISPATCH_ON' : 'LOCAL_DEVICE_TEAM_DISPATCH_OFF', row.id);
      });
      send(200, { device: { id: row.id, teamDispatch: body.teamDispatch } }); return true;
    }
    if (method === 'DELETE' && revoke) {
      browser(req, user, true);
      const row = db.prepare('SELECT * FROM local_device_sessions WHERE id=? AND user_id=?').get(revoke[1], user.id);
      if (!row) fail(404, 'DEVICE_NOT_FOUND', '本地设备连接不存在');
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
        db.prepare('UPDATE local_device_sessions SET revoked_at=? WHERE id=?').run(new Date(now()).toISOString(), row.id);
        db.prepare("UPDATE devices SET status='OFFLINE' WHERE actor_id=? AND device_id=?").run(user.id, row.id);
        audit(user.id, 'LOCAL_DEVICE_REVOKE', row.id);
      });
      removeHostSessionIfMatching(hostBridgeStateDir, row.id);
      send(204); return true;
    }
    return false;
  };
  const logout = user => {
    if (!user.localDevice) return;
    db.prepare('UPDATE local_device_sessions SET revoked_at=? WHERE id=?').run(new Date(now()).toISOString(), user.localDevice.id);
    db.prepare("UPDATE devices SET status='OFFLINE' WHERE actor_id=? AND device_id=?").run(user.id, user.localDevice.id);
  };
  function canUseHostBridge(user, projectId) {
    const stored = readHostSession(hostBridgeStateDir);
    if (!stored?.tokenHash || stored.unsafe) return false;
    const row = db.prepare(`SELECT d.project_ids FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash
      WHERE d.token_hash=? AND d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>?`)
      .get(stored.tokenHash, user.id, now(), now());
    return !!row && JSON.parse(row.project_ids).includes(projectId);
  }

  return { publicRoutes, authenticatedRoutes, session, authorizeRequest, logout, canUseHostBridge, hasActiveBridgeRuns, requireBridgeIdle };
}

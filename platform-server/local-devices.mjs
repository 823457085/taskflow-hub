import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, sha, textField, publicUser, TOOLS } from './common.mjs';

const PAIR_MS = 10 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const HOST_SESSION_MS = 7 * 24 * 60 * 60_000;
const INTERVAL_MS = 3000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');
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
    return { tokenHash: sha(parsed.token), deviceId: parsed.deviceId, filePath };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { unsafe: true };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function writeHostSession(dir, payload) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) fail(500, 'UNSAFE_BRIDGE_STATE', '本机桥接目录状态不安全');
  chmodSync(dir, 0o700);
  const filePath = join(dir, 'session.json');
  try {
    const existing = lstatSync(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) fail(500, 'UNSAFE_BRIDGE_STATE', '本机桥接登录文件状态不安全');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = join(dir, `.session-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    fail(500, 'BRIDGE_WRITE_FAILED', '无法写入本机桥接会话文件');
  }
}

function removeHostSessionIfMatching(dir, deviceId) {
  const current = readHostSession(dir);
  if (!current || current.unsafe || current.deviceId !== deviceId) return;
  try { unlinkSync(current.filePath); } catch {}
}

export function createLocalDevices({ db, transaction, audit, projectRole, visibleProjects, now = Date.now, hostBridgeStateDir = null, hostBridgeApiUrl = 'http://127.0.0.1:5187' }) {
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
  const publicRoutes = ({ req, path, method, body, send }) => {
    if (method !== 'POST' || !['/api/device-authorizations', '/api/device-authorizations/poll'].includes(path)) return false;
    const ip = req.socket.remoteAddress || 'unknown';
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
      const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expires = now() + SESSION_MS;
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
    const read = method === 'GET' && (/^\/api\/(?:me|projects|tasks|jobs)$/.test(path) || /^\/api\/tasks\/[^/]+(?:\/(?:context|assets|gates|bundle))?$/.test(path) || /^\/api\/jobs\/[^/]+$/.test(path));
    const write = method === 'POST' && (path === '/api/logout' || /^\/api\/tasks\/[^/]+\/(?:claim|progress|heartbeat)$/.test(path) || /^\/api\/jobs\/[^/]+\/report$/.test(path));
    if (!read && !write) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备仅可读取已授权项目任务并提交认领、进度、心跳和报告');
    if (/\/(progress|heartbeat)$/.test(path) && body?.deviceId !== device.id) fail(403, 'DEVICE_ID_MISMATCH', '设备标识与当前配对会话不一致');
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
      const supported = !!hostBridgeStateDir && isLoopback(req.socket.remoteAddress);
      if (!supported) { send(200, { supported: false, connected: false, status: 'UNSUPPORTED', device: null, suggestedProjectIds }); return true; }
      const stored = readHostSession(hostBridgeStateDir);
      if (!stored) { send(200, { supported: true, connected: false, status: 'DISCONNECTED', device: null, suggestedProjectIds }); return true; }
      if (stored.unsafe) { send(200, { supported: true, connected: false, status: 'INVALID', device: null, suggestedProjectIds }); return true; }
      const row = db.prepare('SELECT d.*,s.token_hash AS active_hash FROM local_device_sessions d LEFT JOIN sessions s ON d.token_hash=s.token_hash WHERE d.token_hash=?').get(stored.tokenHash);
      if (!row) { send(200, { supported: true, connected: false, status: 'EXPIRED', device: null, suggestedProjectIds }); return true; }
      if (row.user_id !== user.id) { send(200, { supported: true, connected: false, status: 'OTHER_USER', device: null, suggestedProjectIds }); return true; }
      const status = row.revoked_at ? 'REVOKED' : row.expires_at <= now() ? 'EXPIRED' : !row.active_hash ? 'REVOKED' : 'ACTIVE';
      const projectIds = JSON.parse(row.project_ids).filter(id => accessibleIds.has(id));
      send(200, {
        supported: true, connected: status === 'ACTIVE', status, suggestedProjectIds: projectIds.length ? projectIds : suggestedProjectIds,
        device: {
          id: row.id, deviceName: row.device_name, tool: row.tool, projectIds: JSON.parse(row.project_ids),
          createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: new Date(row.expires_at).toISOString(), scope: 'LOCAL_BRIDGE', status,
        },
      });
      return true;
    }
    if (method === 'POST' && path === '/api/local-devices/host-bridge') {
      browser(req, user, true); rate('host:' + user.id, 20);
      if (!hostBridgeStateDir || !isLoopback(req.socket.remoteAddress)) fail(403, 'HOST_BRIDGE_UNAVAILABLE', '当前仅支持在本机回环网页中一键授权本机桥接');
      keys(body, ['deviceName', 'tool', 'projectIds']);
      const deviceName = body.deviceName === undefined ? '工作台与本地 AI' : textField(body.deviceName, 'deviceName', { max: 80 });
      const tool = body.tool === undefined ? 'custom' : body.tool;
      if (/[\r\n\t]/.test(deviceName) || !TOOLS.includes(tool)) fail(400, 'INVALID_DEVICE', '请提供有效的设备名称与客户端标记');
      if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.length > 100 || body.projectIds.some(id => typeof id !== 'string' || id.length > 80)) fail(400, 'PROJECT_SCOPE_REQUIRED', '请明确选择至少一个可访问项目');
      const projectIds = [...new Set(body.projectIds)];
      for (const id of projectIds) projectRole(user, id);
      const existing = readHostSession(hostBridgeStateDir);
      if (existing?.unsafe) fail(500, 'UNSAFE_BRIDGE_STATE', '本机桥接登录文件状态不安全');
      let previousRow = null;
      if (existing?.tokenHash) {
        previousRow = db.prepare('SELECT d.*,s.token_hash AS active_hash FROM local_device_sessions d LEFT JOIN sessions s ON d.token_hash=s.token_hash WHERE d.token_hash=?').get(existing.tokenHash);
        if (previousRow && previousRow.user_id !== user.id && !previousRow.revoked_at && previousRow.expires_at > now() && previousRow.active_hash) {
          fail(409, 'HOST_BRIDGE_OCCUPIED', '本机已有其他成员的有效桥接会话，请先注销原会话');
        }
      }
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const createdAt = new Date(now()).toISOString();
      const expires = now() + HOST_SESSION_MS;
      const expiresAt = new Date(expires).toISOString();
      transaction(() => {
        for (const projectId of projectIds) projectRole(user, projectId);
        if (previousRow && previousRow.user_id === user.id && !previousRow.revoked_at) {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(previousRow.token_hash);
          db.prepare('UPDATE local_device_sessions SET revoked_at=? WHERE id=?').run(createdAt, previousRow.id);
          db.prepare("UPDATE devices SET status='OFFLINE' WHERE actor_id=? AND device_id=?").run(user.id, previousRow.id);
        }
        db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), user.id, expires);
        db.prepare('INSERT INTO local_device_sessions (id,token_hash,user_id,device_name,tool,project_ids,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, sha(token), user.id, deviceName, tool, JSON.stringify(projectIds), expires, createdAt);
        writeHostSession(hostBridgeStateDir, { url: hostBridgeApiUrl, token, deviceId: id, projectIds, expiresAt });
        audit(user.id, 'LOCAL_DEVICE_HOST_CONNECTED', id);
      });
      send(201, {
        status: 'AUTHORIZED', connected: true,
        device: { id, deviceName, tool, projectIds, createdAt, lastSeenAt: null, expiresAt, scope: 'LOCAL_BRIDGE', status: 'ACTIVE' },
      });
      return true;
    }
    if (method === 'GET' && path === '/api/local-devices') {
      browser(req, user);
      const devices = db.prepare('SELECT d.*,s.token_hash AS active_hash FROM local_device_sessions d LEFT JOIN sessions s ON d.token_hash=s.token_hash WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 100').all(user.id).map(row => ({
        id: row.id, deviceName: row.device_name, tool: row.tool, projectIds: JSON.parse(row.project_ids), createdAt: row.created_at,
        lastSeenAt: row.last_seen_at, expiresAt: new Date(row.expires_at).toISOString(), scope: 'LOCAL_BRIDGE',
        status: row.revoked_at ? 'REVOKED' : row.expires_at <= now() ? 'EXPIRED' : !row.active_hash ? 'REVOKED' : 'ACTIVE',
      }));
      send(200, { devices }); return true;
    }
    const revoke = path.match(/^\/api\/local-devices\/([a-zA-Z0-9_-]{1,80})$/);
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

  return { publicRoutes, authenticatedRoutes, session, authorizeRequest, logout, canUseHostBridge };
}

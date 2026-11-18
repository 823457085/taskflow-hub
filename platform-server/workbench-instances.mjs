import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { sha } from './common.mjs';

const run = promisify(execFile);
const INSTANCE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const READY_MS = 120_000;
const SWEEP_MS = 60_000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Starts and stops systemd template units `taskflow-workbench@<slot>.service`; the API user is allowed via polkit. */
export function systemdControl({ unit = 'taskflow-workbench' } = {}) {
  const name = slot => `${unit}@${Number(slot)}.service`;
  const call = async (...args) => { await run('systemctl', ['--no-ask-password', ...args], { timeout: 60_000 }); };
  return {
    start: slot => call('start', name(slot)),
    stop: slot => call('stop', name(slot)),
    restart: slot => call('restart', name(slot)),
    active: async slot => { try { await run('systemctl', ['is-active', '--quiet', name(slot)], { timeout: 10_000 }); return true; } catch { return false; } },
  };
}

const portOpen = (port, host = '127.0.0.1') => new Promise(resolve => {
  const socket = net.connect({ port, host });
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(1000, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

const envLine = (key, value) => {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error(`invalid env value for ${key}`);
  return `${key}=${/^[A-Za-z0-9_./:@,+=-]*$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, '\\$1')}"`}`;
};

/**
 * One server-side workbench per TaskFlow user. File access and AI command lines inside the instance are relayed to the
 * user's own computer by the remote broker; credentials, data and the instance itself stay on the server.
 */
export function createWorkbenchInstances({
  db, audit = () => {}, now = Date.now, logger = console, control = systemdControl(), broker,
  envDir, stateRoot = '/var/lib/taskflow-wb', preload, apiUrl = 'http://127.0.0.1:5187',
  basePort = 5300, maxSlots = 8, idleMs = IDLE_MS, readyMs = READY_MS, portCheck = portOpen,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_instances (user_id TEXT PRIMARY KEY REFERENCES users(id),slot INTEGER NOT NULL UNIQUE,token_hash TEXT,
    session_hash TEXT,local_home TEXT,last_used_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);`);
  const states = new Map();
  const tokens = new Map();

  const row = userId => db.prepare('SELECT * FROM workbench_instances WHERE user_id=?').get(userId);
  const portOf = slot => basePort + slot;
  const stateOf = userId => { if (!states.has(userId)) states.set(userId, { phase: 'stopped', starting: null, lastUsed: 0, error: null, failedAt: 0, holds: 0, checkedAt: 0 }); return states.get(userId); };

  function allocate(userId) {
    const existing = row(userId);
    if (existing) return existing;
    const used = new Set(db.prepare('SELECT slot FROM workbench_instances').all().map(item => item.slot));
    let slot = 1;
    while (used.has(slot)) slot += 1;
    if (slot > maxSlots) throw Object.assign(new Error('服务器工作台名额已满，请联系管理员扩容'), { code: 'WORKBENCH_CAPACITY' });
    db.prepare('INSERT INTO workbench_instances (user_id,slot,created_at) VALUES (?,?,?)').run(userId, slot, now());
    return row(userId);
  }

  function instanceUser(token) {
    if (!SECRET.test(token || '')) return null;
    const hash = sha(token);
    if (tokens.has(hash)) return tokens.get(hash);
    const found = db.prepare('SELECT user_id FROM workbench_instances WHERE token_hash=?').get(hash);
    if (found) tokens.set(hash, found.user_id);
    return found?.user_id || null;
  }

  function writeEnv(item, home, instanceToken, sessionToken) {
    const api = typeof apiUrl === 'function' ? apiUrl() : apiUrl;
    const state = path.join(stateRoot, String(item.slot));
    const lines = [
      envLine('PORT', portOf(item.slot)),
      envLine('HOME', home),
      envLine('USER', path.basename(home)),
      envLine('LOGNAME', path.basename(home)),
      envLine('TMPDIR', '/tmp'),
      envLine('NODE_ENV', 'production'),
      envLine('DELIVERY_DATA_DIR', path.join(state, 'data')),
      envLine('DELIVERY_SOURCE_DATA_DIR', path.join(state, 'source')),
      envLine('DELIVERY_CREDENTIALS_FILE', path.join(state, 'credentials', 'jira.env')),
      envLine('DELIVERY_WECOM_CONFIG_FILE', path.join(state, 'credentials', 'wecom-integration.json')),
      envLine('DELIVERY_CODEX_BIN', 'codex'),
      envLine('DELIVERY_TASKFLOW_API_URL', api),
      envLine('TASKFLOW_URL', api),
      envLine('TASKFLOW_TOKEN', sessionToken),
      envLine('TF_REMOTE_URL', api),
      envLine('TF_REMOTE_TOKEN', instanceToken),
      envLine('TF_REMOTE_PREFIXES', JSON.stringify([home])),
      envLine('TF_UPLOAD_ROOTS', JSON.stringify([state])),
      ...(preload ? [envLine('NODE_OPTIONS', `--import=${preload}`)] : []),
    ];
    fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
    const file = path.join(envDir, `${item.slot}.env`);
    fs.writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  function issueCredentials(item, home) {
    const instanceToken = randomBytes(32).toString('base64url');
    const sessionToken = randomBytes(32).toString('base64url');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (item.session_hash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(item.session_hash);
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(sessionToken), item.user_id, now() + INSTANCE_SESSION_MS);
      db.prepare('UPDATE workbench_instances SET token_hash=?,session_hash=?,local_home=? WHERE user_id=?').run(sha(instanceToken), sha(sessionToken), home, item.user_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (item.token_hash) tokens.delete(item.token_hash);
    writeEnv(item, home, instanceToken, sessionToken);
  }

  async function waitReady(port) {
    const deadline = now() + readyMs;
    while (now() < deadline) {
      if (await portCheck(port)) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  async function boot(userId, home, { restart = false } = {}) {
    const item = allocate(userId);
    issueCredentials(item, home);
    if (restart) await control.restart(item.slot); else await control.start(item.slot);
    audit(userId, restart ? 'WORKBENCH_INSTANCE_RESTART' : 'WORKBENCH_INSTANCE_START', userId);
    if (!await waitReady(portOf(item.slot))) throw Object.assign(new Error('服务器工作台启动超时'), { code: 'WORKBENCH_START_TIMEOUT' });
  }

  /** Returns {phase:'ready', port} or {phase:'starting'|'offline'|'failed', message}; never blocks on startup. */
  async function ensure(userId) {
    const state = stateOf(userId);
    state.lastUsed = now();
    if (state.starting) return { phase: 'starting' };
    const item = row(userId);
    if (item && state.phase === 'ready') {
      if (now() - state.checkedAt < 5000 || await portCheck(portOf(item.slot))) { state.checkedAt = now(); return { phase: 'ready', port: portOf(item.slot) }; }
      state.phase = 'stopped';
    }
    if (item && await portCheck(portOf(item.slot)) && await control.active(item.slot)) {
      state.phase = 'ready';
      return { phase: 'ready', port: portOf(item.slot) };
    }
    if (state.phase === 'failed' && now() - state.failedAt < 30_000) return { phase: 'failed', message: state.error };
    // Agent 只负责 AI/git；工作台本身可以先启动。电脑从未连过（没有 local_home）才整页提示未连接。
    const agent = broker.status(userId);
    const home = agent.online ? agent.home : item?.local_home;
    if (!home) {
      const paired = db.prepare(`SELECT 1 AS ok FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash
        WHERE d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>?`).get(userId, now(), now());
      return {
        phase: 'offline',
        message: paired
          ? '本机 Bridge 已配对，但个人 Agent 未在线：请在这台已配对的电脑执行 ~/.taskflow/bin/taskflow-bridge service --action restart，接通后本页会自动重试。'
          : '当前账号还没有配对的本机 Bridge。请用该账号打开任务中心「本地 AI」完成设备授权并在本机运行 Bridge；其他账号已连接的 Bridge 不能共用。',
      };
    }
    state.error = null;
    state.phase = 'starting';
    state.starting = boot(userId, home).then(() => { state.phase = 'ready'; state.lastUsed = now(); }, error => {
      state.phase = 'failed'; state.failedAt = now();
      state.error = error.code === 'WORKBENCH_CAPACITY' || error.code === 'WORKBENCH_START_TIMEOUT' ? error.message : '服务器工作台启动失败';
      logger.error(`Workbench instance start failed (${error.code || 'ERROR'})`);
    }).finally(() => { state.starting = null; });
    return { phase: 'starting' };
  }

  function lastError(userId) { return stateOf(userId).error; }

  /** A changed local home directory (new computer, renamed account) needs a restart so paths map correctly. */
  async function agentConnected(userId, info) {
    const item = row(userId);
    if (!item || item.local_home === info.home) return;
    const state = stateOf(userId);
    if (state.phase !== 'ready' || state.starting) { db.prepare('UPDATE workbench_instances SET local_home=? WHERE user_id=?').run(info.home, userId); return; }
    state.starting = boot(userId, info.home, { restart: true }).catch(() => { state.phase = 'failed'; }).finally(() => { state.starting = null; });
  }

  async function sweep() {
    for (const item of db.prepare('SELECT * FROM workbench_instances').all()) {
      const state = stateOf(item.user_id);
      if (state.phase !== 'ready' || state.starting) continue;
      if (state.holds > 0 || now() - state.lastUsed < idleMs || broker.active?.(item.user_id)) continue;
      state.phase = 'stopped';
      try { await control.stop(item.slot); audit(item.user_id, 'WORKBENCH_INSTANCE_IDLE_STOP', item.user_id); }
      catch { logger.error('Workbench instance stop failed'); }
    }
  }
  const timer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
  timer.unref();

  return {
    ensure, instanceUser, agentConnected, lastError, sweep, agentOnline: userId => !!broker.status(userId).online,
    hold: userId => {
      const state = stateOf(userId);
      state.holds += 1; state.lastUsed = now();
      let released = false;
      return () => { if (released) return; released = true; state.holds -= 1; state.lastUsed = now(); };
    },
    status: userId => { const item = row(userId); return { phase: stateOf(userId).phase, slot: item?.slot ?? null }; },
    close: () => clearInterval(timer),
  };
}

import { constants } from 'node:fs';
import { open, lstat, mkdir, chmod, writeFile, rename, unlink, link } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = dirname(fileURLToPath(import.meta.url));
const defaultStateDir = join(bridgeDir, '.local');
const hostSuffix = createHash('sha256').update(resolve(bridgeDir, '..')).digest('hex').slice(0, 12);
export const stateDir = process.env.RD_HUB_STATE_DIR || defaultStateDir;
export const sessionPath = join(stateDir, 'session.json');
export const usesDefaultState = !process.env.RD_HUB_STATE_DIR || resolve(process.env.RD_HUB_STATE_DIR) === resolve(defaultStateDir);
export const hostBridgeStateDir = process.env.TASKFLOW_HOST_BRIDGE_STATE_DIR || join(homedir(), 'Library/Application Support/TaskFlow', hostSuffix, '.bridge-state');
export const hostSessionPath = join(hostBridgeStateDir, 'session.json');

export async function ensureNoSession() {
  try { await lstat(sessionPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('无法检查本地会话，请检查目录权限。'); }
  throw new Error('已有本地登录文件，请先运行 logout；配对不会覆盖现有登录。');
}

export async function saveSession(session, { exclusive = false } = {}) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) throw new Error('本地会话目录不安全。');
  await chmod(stateDir, 0o700);
  const temporary = join(stateDir, `.session-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    if (exclusive) { await link(temporary, sessionPath); await unlink(temporary); }
    else await rename(temporary, sessionPath);
    await chmod(sessionPath, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error.code === 'EEXIST') throw new Error('已有本地登录文件，请先运行 logout；配对不会覆盖现有登录。');
    throw new Error('无法安全保存本地会话，请检查目录权限。');
  }
}

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('服务地址不正确。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw new Error('服务地址仅支持无认证参数的 HTTP(S) origin。');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程服务必须使用 HTTPS。');
  return url.origin;
}

const sessionError = () => new Error('尚未登录或本地会话无效，请在已登录网页一键授权，或运行 node local-bridge/rd.mjs connect --name 我的开发电脑 --tool custom，在已登录网页确认接入。');

async function readSessionCandidate(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16_384 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw sessionError();
    const session = JSON.parse(await handle.readFile('utf8'));
    session.url = validateUrl(session.url);
    if (typeof session.token !== 'string' || session.token.length < 16 || session.token.length > 4096 || /[\r\n]/.test(session.token) || !/^[A-Za-z0-9_-]{1,80}$/.test(session.deviceId || '')) throw sessionError();
    return {
      path: filePath,
      mtimeMs: info.mtimeMs,
      session: {
        url: session.url, token: session.token, deviceId: session.deviceId,
        ...(Array.isArray(session.projectIds) && session.projectIds.every(id => typeof id === 'string') ? { projectIds: session.projectIds } : {}),
        ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
      },
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw sessionError();
  } finally { await handle?.close(); }
}

export async function loadSessionWithPath() {
  const primary = await readSessionCandidate(sessionPath);
  if (!usesDefaultState || resolve(hostSessionPath) === resolve(sessionPath)) {
    if (!primary) throw sessionError();
    return primary;
  }
  let fallback = null;
  try { fallback = await readSessionCandidate(hostSessionPath); } catch { fallback = null; }
  const candidates = [primary, fallback].filter(Boolean);
  if (!candidates.length) throw sessionError();
  const now = Date.now();
  const active = candidates.filter(item => item.session.expiresAt === undefined || Date.parse(item.session.expiresAt) > now);
  const chosen = (active.length ? active : candidates).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return chosen;
}

export async function loadSession() {
  return (await loadSessionWithPath()).session;
}

export function redactSecrets(value, secrets = [], omitFields = false) {
  const sensitive = /^(?:(?:access|refresh|id)[_-]?)?token$|^(?:password|authorization|cookie|set[_-]?cookie|secret|client[_-]?secret|api[_-]?key|auth[_-]?header|credentials|device[_-]?code)$/i;
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (sensitive.test(key)) return omitFields ? undefined : '[REDACTED]';
    if (typeof item === 'string') for (const secret of secrets) if (secret) item = item.replaceAll(secret, '[REDACTED]');
    return item;
  }));
}

export async function request(url, path, { token, method = 'GET', body, timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('无法连接平台服务，请检查地址与服务状态。'); }
  if (!response.ok) {
    let errorBody;
    try { errorBody = await response.json(); } catch { /* Preserve only the display message from JSON responses. */ }
    const error = new Error(typeof errorBody?.error?.message === 'string' ? redactSecrets(errorBody.error.message, [token, body?.password, body?.deviceCode]) : response.status === 401 ? '登录已失效或用户名密码错误，请重新登录。' : response.status === 403 ? '当前账号没有此操作权限。' : `平台请求失败（HTTP ${response.status}）。`);
    error.status = response.status;
    if (typeof errorBody?.error?.code === 'string') error.code = errorBody.error.code;
    throw error;
  }
  if (response.status === 204) return null;
  try { return await response.json(); } catch { throw new Error('平台响应格式不正确。'); }
}

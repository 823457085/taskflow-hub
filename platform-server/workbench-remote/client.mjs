import http from 'node:http';

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export function remoteConfig(env = process.env) {
  let prefixes = [];
  try { prefixes = JSON.parse(env.TF_REMOTE_PREFIXES || '[]').filter(item => typeof item === 'string' && item.startsWith('/') && item.length > 1).map(item => item.replace(/\/+$/, '')); } catch {}
  let uploads = [];
  try { uploads = JSON.parse(env.TF_UPLOAD_ROOTS || '[]').filter(item => typeof item === 'string' && item.startsWith('/')); } catch {}
  return { url: env.TF_REMOTE_URL || '', token: env.TF_REMOTE_TOKEN || '', prefixes, uploads };
}

export const encode = value => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $b: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function' && !(item instanceof AbortSignal)).map(([key, item]) => [key, encode(item)]));
  return value;
};
export const decode = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$b === 'string' && Object.keys(value).length === 1) return Buffer.from(value.$b, 'base64');
  if (Array.isArray(value)) return value.map(decode);
  return value;
};

export function remoteError(error, syscall, path) {
  const code = error?.code || 'EIO';
  const message = error?.message || '电脑端操作失败';
  const result = new Error(/^E[A-Z]+:/.test(message) ? message : `${code}: ${message}${syscall ? `, ${syscall}` : ''}${path ? ` '${path}'` : ''}`);
  result.code = code;
  result.errno = typeof error?.errno === 'number' ? error.errno : -5;
  if (syscall || error?.syscall) result.syscall = error?.syscall || syscall;
  if (path || error?.path) result.path = error?.path || path;
  return result;
}

function post(config, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, config.url);
    const request = http.request(target, { method: 'POST', agent, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } });
    request.on('error', reject);
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.end(body);
  });
}

export async function fsRequest(config, op, args) {
  let response;
  try { response = await post(config, '/internal/remote/fs', JSON.stringify({ op, args: encode(args) })); }
  catch { return { ok: false, error: { code: 'EHOSTDOWN', message: '工作台服务暂时无法连接任务中心' } }; }
  try { return JSON.parse(response.text); } catch { return { ok: false, error: { code: 'EIO', message: `任务中心返回 ${response.status}` } }; }
}

/** Relays an HTTP request to the owner's computer (corporate Jira / Confluence that the server cannot reach). */
export async function httpRequest(config, request) {
  let response;
  try { response = await post(config, '/internal/remote/http', JSON.stringify(request)); }
  catch { return { ok: false, error: { code: 'EHOSTDOWN', message: '工作台服务暂时无法连接任务中心' } }; }
  try { return JSON.parse(response.text); } catch { return { ok: false, error: { code: 'EIO', message: `任务中心返回 ${response.status}` } }; }
}

export function killRequest(config, id, signal) {
  return post(config, '/internal/remote/kill', JSON.stringify({ id, signal })).catch(() => {});
}

/** Streams stdin to the remote process and calls onFrame for each output frame ({t:'id'|'s'|'o'|'e'|'x'|'err'}). */
export function execRequest(config, spec, onFrame) {
  const request = http.request(new URL('/internal/remote/exec', config.url), {
    method: 'POST', agent, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/octet-stream', 'X-Remote-Spec': Buffer.from(JSON.stringify(spec)).toString('base64') },
  });
  let tail = '', finished = false;
  const done = frame => { if (finished) return; if (frame.t === 'x' || frame.t === 'err') finished = true; onFrame(frame); };
  request.on('error', error => done({ t: 'err', code: 'EHOSTDOWN', message: error.message || '工作台服务暂时无法连接任务中心' }));
  request.on('response', response => {
    response.on('data', chunk => {
      const lines = (tail + chunk.toString('utf8')).split('\n');
      tail = lines.pop();
      for (const line of lines) { if (!line) continue; let frame; try { frame = JSON.parse(line); } catch { continue; } done(frame); }
    });
    response.on('end', () => done({ t: 'err', code: 'EPIPE', message: '远程进程连接已结束' }));
    response.on('error', () => done({ t: 'err', code: 'EPIPE', message: '远程进程连接已中断' }));
  });
  request.flushHeaders();
  return { request, write: chunk => request.write(chunk), end: () => request.end(), destroy: () => request.destroy() };
}

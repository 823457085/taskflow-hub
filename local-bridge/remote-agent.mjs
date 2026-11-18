import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

const RETRY_MS = 5000;
const SILENCE_MS = 45_000;
const READ_MAX = 64 * 1024 * 1024;
const HTTP_BODY_MAX = 32 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 90_000;
const PROCESS_MAX = 32;
const HEADER_DROP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer']);

/** Paths under home the server-side workbench must never read or change, even with the user's own credentials. */
const DENIED = ['.ssh', '.gnupg', '.taskflow/state', 'Library/Keychains', 'Library/Cookies', '.aws', '.netrc', '.git-credentials', '.kube', '.docker/config.json',
  '.config/gh/hosts.yml', '.codex/auth.json', '.npmrc', '.pypirc', '.password-store', 'Library/Application Support/Google/Chrome', 'Library/Application Support/com.apple.TCC'];
export const REMOTE_COMMANDS = new Set(['codex', 'cursor-agent', 'claude', 'kiro-cli', 'agy', 'dsh', 'gemini', 'grok', 'deepseek', 'workbuddy', 'sandbox-exec', 'open', 'osascript',
  'cursor', 'code', 'pbcopy', 'pbpaste', 'mdfind', 'sw_vers', 'git', 'rg', 'grep', 'find', 'ls', 'cat', 'du', 'wc', 'head', 'tail', 'sed', 'awk', 'diff', 'patch', 'tar', 'zip', 'unzip',
  'sh', 'bash', 'zsh', 'env', 'xargs', 'node', 'npm', 'pnpm', 'npx', 'yarn', 'corepack', 'make', 'go', 'python3', 'java', 'mvn', 'gradle', 'jq', 'curl', 'which', 'test', 'true', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'ps', 'lsof', 'pm2', 'kill', 'pgrep', 'sleep', 'date', 'uname', 'whoami']);
const BLOCKED_COMMANDS = new Set(['security', 'sudo', 'su', 'ssh', 'scp', 'launchctl', 'defaults', 'dscl']);
const OPS = new Set(['access', 'appendFile', 'chmod', 'lstat', 'mkdir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'truncate', 'unlink', 'utimes',
  'writeFile', 'rename', 'copyFile', 'cp', 'link', 'symlink', 'mkdtemp', 'exists', 'lchown', 'chown']);
const TWO_PATH = new Set(['rename', 'copyFile', 'cp', 'link', 'symlink']);

const policyError = (path, message = '服务器工作台无权访问此路径') => Object.assign(new Error(`EACCES: ${message}, '${path}'`), { code: 'EACCES', path });

export function pathPolicy(home = homedir()) {
  const root = resolve(home);
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* keep lexical home */ }
  const denied = DENIED.map(item => join(root, item));
  const inside = (base, target) => { const rel = relative(base, target); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  const blocked = target => denied.some(item => inside(item, target) || inside(item, target.replace(realRoot, root)));
  function realOfExisting(target) {
    let current = target;
    for (;;) {
      try { return join(realpathSync(current), relative(current, target)); }
      catch { const parent = dirname(current); if (parent === current) return target; current = parent; }
    }
  }
  return {
    home: root,
    check(value) {
      if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw policyError(String(value), '路径必须是绝对路径');
      const target = resolve(value);
      if (!inside(root, target) && !inside(realRoot, target)) throw policyError(target, '只允许访问你的用户目录');
      if (blocked(target)) throw policyError(target);
      const real = realOfExisting(target);
      if (!inside(root, real) && !inside(realRoot, real)) throw policyError(target, '链接指向了用户目录以外的位置');
      if (blocked(real)) throw policyError(target);
      return target;
    },
    allows(value) { try { this.check(value); return true; } catch { return false; } },
  };
}

const encode = value => {
  if (Buffer.isBuffer(value)) return { $b: value.toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  return value;
};
const decode = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$b === 'string' && Object.keys(value).length === 1) return Buffer.from(value.$b, 'base64');
  if (Array.isArray(value)) return value.map(decode);
  return value;
};
const statValue = stats => {
  const out = {};
  for (const key of ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']) out[key] = Number(stats[key]);
  return out;
};
const kindOf = entry => entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other';
const plainOptions = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Relays HTTPS/HTTP to an allowlisted corporate host (Jira / Confluence) from the owner's computer. */
export async function runHttpOp(request, fetchImpl = fetch) {
  if (!request || typeof request.url !== 'string' || !Array.isArray(request.hosts) || !request.hosts.length) {
    throw Object.assign(new Error('EINVAL: 网络请求参数不正确'), { code: 'EINVAL' });
  }
  const hosts = [...new Set(request.hosts.filter(item => typeof item === 'string' && item.length <= 253 && /^[a-z0-9.-]+$/i.test(item)).map(item => item.toLowerCase()))];
  let url;
  try { url = new URL(request.url); } catch { throw Object.assign(new Error('EINVAL: URL 无效'), { code: 'EINVAL' }); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('EACCES: 仅允许不含账号密码的 HTTP(S) 地址'), { code: 'EACCES' });
  }
  if (!hosts.includes(url.hostname.toLowerCase())) {
    throw Object.assign(new Error(`EACCES: 不允许访问 ${url.hostname}`), { code: 'EACCES' });
  }
  const method = typeof request.method === 'string' && /^[A-Z]{3,10}$/.test(request.method) ? request.method : 'GET';
  const headers = {};
  if (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers)) {
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof key !== 'string' || typeof value !== 'string' || HEADER_DROP.has(key.toLowerCase()) || key.length > 128 || value.length > 16_384) continue;
      headers[key] = value;
    }
  }
  const body = typeof request.body === 'string' && request.body
    ? Buffer.from(request.body, 'base64')
    : undefined;
  if (body && body.length > HTTP_BODY_MAX) throw Object.assign(new Error('EFBIG: 请求体过大'), { code: 'EFBIG' });
  const response = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > HTTP_BODY_MAX) throw Object.assign(new Error('EFBIG: 响应体过大'), { code: 'EFBIG' });
  const outHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    if (HEADER_DROP.has(key.toLowerCase()) || key.toLowerCase() === 'set-cookie') continue;
    outHeaders[key] = value;
  }
  return { status: response.status, headers: outHeaders, body: buffer.toString('base64') };
}

/** Executes one relayed file-system call; every path is checked against the policy first. */
export async function runFsOp(policy, op, rawArgs) {
  if (!OPS.has(op)) throw Object.assign(new Error(`ENOSYS: 不支持的文件操作 ${op}`), { code: 'ENOSYS' });
  const args = decode(Array.isArray(rawArgs) ? rawArgs : []);
  const target = op === 'symlink' ? null : policy.check(args[0]);
  if (TWO_PATH.has(op)) policy.check(args[1]);
  const options = plainOptions(args[1]);
  switch (op) {
    case 'exists': return existsSync(target);
    case 'stat': return statValue(await fsp.stat(target));
    case 'lstat': return statValue(await fsp.lstat(target));
    case 'access': return void await fsp.access(target, typeof args[1] === 'number' ? args[1] : undefined);
    case 'readFile': {
      const info = await fsp.stat(target);
      if (info.size > READ_MAX) throw Object.assign(new Error(`EFBIG: 文件超过 64 MiB，'${target}'`), { code: 'EFBIG' });
      return encode(await fsp.readFile(target));
    }
    case 'readdir': {
      if (!options.withFileTypes) return (await fsp.readdir(target, { recursive: !!options.recursive })).filter(name => policy.allows(join(target, name)));
      const entries = await fsp.readdir(target, { withFileTypes: true, recursive: !!options.recursive });
      return entries.filter(entry => policy.allows(join(entry.parentPath || target, entry.name))).map(entry => ({ name: entry.name, kind: kindOf(entry), parent: entry.parentPath || target }));
    }
    case 'readlink': return await fsp.readlink(target);
    case 'realpath': { const real = await fsp.realpath(target); policy.check(real); return real; }
    case 'mkdir': return await fsp.mkdir(target, typeof args[1] === 'number' ? { mode: args[1] } : { recursive: !!options.recursive, ...(options.mode ? { mode: options.mode } : {}) }) ?? undefined;
    case 'mkdtemp': return await fsp.mkdtemp(target);
    case 'writeFile': return void await fsp.writeFile(target, Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(String(args[1] ?? '')), { ...(args[2]?.mode ? { mode: args[2].mode } : {}), ...(args[2]?.flag ? { flag: args[2].flag } : {}) });
    case 'appendFile': return void await fsp.appendFile(target, Buffer.isBuffer(args[1]) ? args[1] : Buffer.from(String(args[1] ?? '')));
    case 'chmod': return void await fsp.chmod(target, args[1]);
    case 'truncate': return void await fsp.truncate(target, args[1] ?? 0);
    case 'utimes': return void await fsp.utimes(target, args[1], args[2]);
    case 'rm': return void await fsp.rm(target, { recursive: !!options.recursive, force: !!options.force });
    case 'rmdir': return void await fsp.rmdir(target);
    case 'unlink': return void await fsp.unlink(target);
    case 'rename': return void await fsp.rename(target, resolve(args[1]));
    case 'copyFile': return void await fsp.copyFile(target, resolve(args[1]), typeof args[2] === 'number' ? args[2] : undefined);
    case 'cp': return void await fsp.cp(target, resolve(args[1]), { recursive: !!plainOptions(args[2]).recursive, force: plainOptions(args[2]).force !== false });
    case 'link': return void await fsp.link(target, resolve(args[1]));
    case 'symlink': {
      const link = resolve(args[1]);
      const pointed = isAbsolute(String(args[0])) ? String(args[0]) : resolve(dirname(link), String(args[0]));
      policy.check(pointed);
      return void await fsp.symlink(String(args[0]), link);
    }
    case 'lchown': case 'chown': return undefined;
  }
}

function executable(file) { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } }

export function commandResolver({ home = homedir(), env = process.env } = {}) {
  const extra = [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const searchPath = [...new Set([...(env.PATH || '').split(delimiter).filter(Boolean), ...extra])];
  const special = {
    codex: [join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'), '/Applications/ChatGPT.app/Contents/Resources/codex'],
    claude: [join(home, '.local/share/delivery-ai-clis/node_modules/.bin/claude')],
  };
  return {
    path: searchPath.join(delimiter),
    resolve(command) {
      if (isAbsolute(command)) return executable(command) ? command : null;
      if (command.includes('/')) return null;
      for (const dir of searchPath) { const file = join(dir, command); if (executable(file)) return file; }
      for (const file of special[command] || []) if (executable(file)) return file;
      return null;
    },
  };
}

/**
 * Personal agent: keeps one streaming connection to the platform and serves the owner's server-side workbench —
 * file access under the user's home (minus credential stores) and AI / developer command lines.
 */
export function runRemoteAgent({ apiUrl, token, log = () => {}, signal, version = '', fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  home = homedir(), spawnImpl = spawn }) {
  const policy = pathPolicy(home);
  const resolver = commandResolver({ home });
  const workRoot = join(home, '.taskflow', 'remote-work');
  const auth = { Authorization: `Bearer ${token}` };
  const info = Buffer.from(JSON.stringify({ home: policy.home, platform: platform(), version })).toString('base64url');
  const children = new Map();
  let pendingResults = [], flushing = false, stopped = false;

  async function flush() {
    if (flushing || !pendingResults.length) return;
    flushing = true;
    while (pendingResults.length) {
      const batch = pendingResults.splice(0, 256);
      try {
        const response = await fetchImpl(`${apiUrl}/api/bridge/remote/results`, { method: 'POST', redirect: 'error', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
        await response.body?.cancel();
      } catch (error) { log(`个人 Agent 回传结果失败：${error.message}`); }
    }
    flushing = false;
  }
  const reply = item => { pendingResults.push(item); setImmediate(flush); };

  async function handleFs(message) {
    try { reply({ id: message.id, ok: true, value: await runFsOp(policy, message.op, message.args) }); }
    catch (error) { reply({ id: message.id, ok: false, error: { code: error.code || 'EIO', message: String(error.message || '').slice(0, 1000), ...(typeof error.errno === 'number' ? { errno: error.errno } : {}) } }); }
  }

  async function handleHttp(message) {
    try { reply({ id: message.id, ok: true, value: await runHttpOp(message.request, fetchImpl) }); }
    catch (error) { reply({ id: message.id, ok: false, error: { code: error.code || 'EIO', message: String(error.message || '').slice(0, 1000) } }); }
  }

  function workDir(cwd) {
    if (typeof cwd === 'string' && policy.allows(cwd)) { try { if (statSync(cwd).isDirectory()) return cwd; } catch { /* missing remote dir */ } }
    const dir = join(workRoot, createHash('sha256').update(String(cwd || 'default')).digest('hex').slice(0, 16));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function handleExec(message) {
    const { id, spec } = message;
    const out = new PassThrough();
    const frame = value => out.write(`${JSON.stringify(value)}\n`);
    let finished = false;
    const finish = value => { if (finished) return; finished = true; frame(value); out.end(); };
    const controller = new AbortController();
    fetchImpl(`${apiUrl}/api/bridge/remote/exec/${id}`, { method: 'POST', redirect: 'error', duplex: 'half', signal: controller.signal, headers: { ...auth, 'Content-Type': 'application/x-ndjson' }, body: out })
      .then(response => { response.body?.cancel(); if (response.status === 404) children.get(id)?.kill('SIGKILL'); })
      .catch(() => children.get(id)?.kill('SIGKILL'));
    const fail = (code, text) => finish({ t: 'err', code, message: text });
    if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string')) return fail('EINVAL', '远程进程参数不正确');
    if (children.size >= PROCESS_MAX) return fail('EAGAIN', '电脑端同时运行的进程过多');
    const name = basename(spec.command);
    const allowed = isAbsolute(spec.command) ? policy.allows(spec.command) || REMOTE_COMMANDS.has(name) : REMOTE_COMMANDS.has(name);
    if (!allowed || BLOCKED_COMMANDS.has(name)) return fail('EACCES', `个人 Agent 不允许执行 ${name}`);
    const file = resolver.resolve(spec.command) || (isAbsolute(spec.command) ? null : resolver.resolve(name));
    if (!file) return fail('ENOENT', `电脑上找不到命令 ${name}`);
    const cwd = workDir(spec.cwd);
    const args = [...spec.args];
    let uploadDir = null;
    for (const item of Array.isArray(spec.files) ? spec.files.slice(0, 20) : []) {
      if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= args.length || typeof item.data !== 'string') continue;
      uploadDir ||= join(workRoot, 'uploads', randomUUID());
      mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
      const target = join(uploadDir, `${item.index}-${basename(String(item.name || 'file')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`);
      writeFileSync(target, Buffer.from(item.data, 'base64'), { mode: 0o600 });
      args[item.index] = target;
    }
    const env = { ...process.env, PATH: resolver.path };
    for (const [key, value] of Object.entries(spec.env || {})) if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !['PATH', 'HOME', 'USER', 'SHELL', 'NODE_OPTIONS'].includes(key) && !key.startsWith('TASKFLOW_') && !key.startsWith('RD_HUB_')) env[key] = value;
    delete env.TASKFLOW_SERVICE;
    let child;
    try { child = spawnImpl(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { return fail(error.code || 'ENOENT', error.message); }
    const entry = { child, kill: sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } } };
    children.set(id, entry);
    child.stdin.on('error', () => {});
    child.once('spawn', () => frame({ t: 's', pid: child.pid }));
    const pipe = (stream, t) => stream.on('data', chunk => { if (!out.write(`${JSON.stringify({ t, d: chunk.toString('base64') })}\n`)) { stream.pause(); out.once('drain', () => stream.resume()); } });
    pipe(child.stdout, 'o'); pipe(child.stderr, 'e');
    child.once('error', error => { children.delete(id); fail(error.code || 'ENOENT', error.message); });
    child.once('close', (code, sig) => {
      children.delete(id);
      finish({ t: 'x', code, signal: sig });
      if (uploadDir) fsp.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    });
  }

  function dispatch(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'fs') return void handleFs(message);
    if (message.type === 'http') return void handleHttp(message);
    if (message.type === 'exec') return handleExec(message);
    const entry = children.get(message.id);
    if (!entry) return;
    if (message.type === 'stdin' && typeof message.data === 'string') entry.child.stdin.write(Buffer.from(message.data, 'base64'));
    else if (message.type === 'stdin-end') entry.child.stdin.end();
    else if (message.type === 'kill' && ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(message.signal)) entry.kill(message.signal);
  }

  const killAll = () => { for (const entry of children.values()) entry.kill('SIGKILL'); children.clear(); };

  async function loop() {
    let announced = false;
    while (!stopped && !signal?.aborted) {
      const controller = new AbortController();
      const onStop = () => controller.abort();
      signal?.addEventListener('abort', onStop, { once: true });
      let watchdog;
      const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), SILENCE_MS); };
      try {
        arm();
        const response = await fetchImpl(`${apiUrl}/api/bridge/remote/stream?info=${info}`, { headers: auth, redirect: 'error', signal: controller.signal });
        if (response.status === 401) { stopped = true; log('个人 Agent 已停止：设备会话已失效或已被撤销，请重新配对'); return; }
        if (response.status === 404) { await response.body?.cancel(); clearTimeout(watchdog); await sleep(60_000); continue; }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        if (!announced) { log('个人 Agent 已连接：服务器工作台可以在这台电脑上运行 AI 命令和读写你用户目录下的代码'); announced = true; }
        let tail = '';
        for await (const chunk of response.body) {
          arm();
          const lines = (tail + Buffer.from(chunk).toString('utf8')).split('\n');
          tail = lines.pop();
          for (const line of lines) { if (!line) continue; let message; try { message = JSON.parse(line); } catch { continue; } dispatch(message); }
        }
        throw new Error('连接已结束');
      } catch (error) {
        if (signal?.aborted) break;
        killAll();
        log(`个人 Agent 连接中断：${error.message}，${RETRY_MS / 1000} 秒后重连`);
        announced = false;
        await sleep(RETRY_MS);
      } finally {
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', onStop);
      }
    }
    killAll();
  }

  return loop();
}

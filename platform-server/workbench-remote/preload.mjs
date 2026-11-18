// Loaded into every server-side workbench process (--import / NODE_OPTIONS). Paths under the user's own home directory
// and AI command lines are served by that user's computer through the personal agent; everything else stays on the server.
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MessageChannel, Worker, isMainThread, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { decode, execRequest, fsRequest, httpRequest, killRequest, remoteConfig, remoteError } from './client.mjs';

const PRELOAD = fileURLToPath(import.meta.url);
const config = remoteConfig();
const REMOTE_COMMANDS = new Set(['codex', 'cursor-agent', 'claude', 'kiro-cli', 'agy', 'dsh', 'sandbox-exec', 'open', 'osascript', 'cursor', 'code', 'pbcopy', 'pbpaste', 'mdfind', 'sw_vers']);
const PATH_TOOLS = new Set(['git', 'rg', 'grep', 'find', 'ls', 'cat', 'du', 'wc', 'head', 'tail', 'sed', 'awk', 'diff', 'patch', 'tar', 'zip', 'unzip', 'sh', 'bash', 'zsh', 'env', 'xargs', 'npm', 'pnpm', 'npx', 'yarn', 'make', 'go', 'python3', 'java', 'mvn', 'gradle']);
const UPLOAD_MAX = 20 * 1024 * 1024;
const UPLOAD_TOTAL = 40 * 1024 * 1024;
const FAKE_PID_BASE = 1 << 30;
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE|_KEY$|^AUTH|AUTH_HEADER/i;
const DROP_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'PWD', 'OLDPWD', 'NODE_OPTIONS', 'SHLVL', '_']);

function toPath(value) {
  if (typeof value === 'string') return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString('utf8'));
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  return null;
}
export const isRemote = value => {
  const target = toPath(value);
  return !!target && config.prefixes.some(prefix => target === prefix || target.startsWith(`${prefix}/`));
};

// ---- synchronous bridge (worker thread + Atomics) ----
let syncState = null;
function syncCall(message, timeoutMs = 120_000) {
  if (!syncState) {
    const shared = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL('./sync-worker.mjs', import.meta.url), { workerData: { tfRemoteSync: true, port: port2, shared, config }, transferList: [port2], execArgv: [], env: {} });
    worker.unref();
    syncState = { flag: new Int32Array(shared), port: port1, worker };
  }
  Atomics.store(syncState.flag, 0, 0);
  syncState.port.postMessage(message);
  if (Atomics.wait(syncState.flag, 0, 0, timeoutMs) === 'timed-out') return { ok: false, error: { code: 'ETIMEDOUT', message: '电脑端操作超时' } };
  return receiveMessageOnPort(syncState.port)?.message || { ok: false, error: { code: 'EIO', message: '同步调用无结果' } };
}

// ---- value shaping ----
function makeStats(value) {
  const stats = Object.create(fs.Stats.prototype);
  for (const key of ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']) stats[key] = value[key] ?? 0;
  for (const key of ['atime', 'mtime', 'ctime', 'birthtime']) stats[key] = new Date(stats[`${key}Ms`]);
  return stats;
}
const DIRENT_TYPES = { file: fs.constants.UV_DIRENT_FILE ?? 1, dir: fs.constants.UV_DIRENT_DIR ?? 2, link: fs.constants.UV_DIRENT_LINK ?? 3, other: fs.constants.UV_DIRENT_UNKNOWN ?? 0 };
function makeDirent(entry, parent) {
  try { return new fs.Dirent(entry.name, DIRENT_TYPES[entry.kind] ?? 0, parent); }
  catch {
    return { name: entry.name, parentPath: parent, path: parent, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => entry.kind === 'link',
      isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
  }
}
const encodingOf = options => typeof options === 'string' ? options : options?.encoding || null;
const shape = {
  stat: value => makeStats(value), lstat: value => makeStats(value),
  readFile: (value, args) => { const buffer = decode(value); const encoding = encodingOf(args[1]); return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer; },
  readdir: (value, args) => args[1]?.withFileTypes ? value.map(entry => makeDirent(entry, entry.parent || toPath(args[0]))) : (encodingOf(args[1]) === 'buffer' ? value.map(name => Buffer.from(name)) : value),
};
function prepare(op, args) {
  const out = [...args];
  if (['writeFile', 'appendFile'].includes(op)) {
    const options = typeof out[2] === 'string' ? { encoding: out[2] } : out[2] || {};
    out[1] = typeof out[1] === 'string' ? Buffer.from(out[1], options.encoding || 'utf8') : Buffer.from(out[1].buffer ? new Uint8Array(out[1].buffer, out[1].byteOffset, out[1].byteLength) : out[1]);
    out[2] = { mode: options.mode, flag: options.flag };
  }
  if (op === 'readdir') out[1] = { withFileTypes: !!out[1]?.withFileTypes, recursive: !!out[1]?.recursive };
  if (op === 'readFile') out[1] = {};
  return out.map((item, index) => index === 0 || (['rename', 'copyFile', 'cp', 'symlink', 'link'].includes(op) && index === 1) ? (toPath(item) ?? item) : item);
}
function result(op, args, response) {
  if (!response.ok) throw remoteError(response.error, op, toPath(args[0]));
  return shape[op] ? shape[op](response.value, args) : decode(response.value);
}
const remoteAsync = async (op, args) => result(op, args, await fsRequest(config, op, prepare(op, args)));
const remoteSync = (op, args) => result(op, args, syncCall({ kind: 'fs', op, args: prepare(op, args) }));

// ---- fs patches ----
const ONE_PATH = ['access', 'appendFile', 'chmod', 'lstat', 'mkdir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'truncate', 'unlink', 'utimes', 'writeFile', 'lchown', 'chown'];
const TWO_PATH = ['rename', 'copyFile', 'cp', 'link'];
const original = { fsp: { ...fsp }, fs: { ...fs } };

async function crossCopy(from, to, recursive) {
  const read = isRemote(from) ? remoteAsync : (op, args) => original.fsp[op](...args);
  const write = isRemote(to) ? remoteAsync : (op, args) => original.fsp[op](...args);
  const info = await read('lstat', [from]);
  if (info.isDirectory()) {
    if (!recursive) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, copy '${from}'`), { code: 'EISDIR' });
    await write('mkdir', [to, { recursive: true }]);
    for (const name of await read('readdir', [from])) await crossCopy(path.join(from, name), path.join(to, name), true);
  } else await write('writeFile', [to, await read('readFile', [from])]);
}

function patchPromises() {
  for (const op of ONE_PATH) {
    if (!original.fsp[op]) continue;
    fsp[op] = function patched(target, ...rest) { return isRemote(target) ? remoteAsync(op, [target, ...rest]) : original.fsp[op].call(this, target, ...rest); };
  }
  for (const op of TWO_PATH) {
    if (!original.fsp[op]) continue;
    fsp[op] = async function patched(from, to, ...rest) {
      const a = isRemote(from), b = isRemote(to);
      if (!a && !b) return original.fsp[op].call(this, from, to, ...rest);
      if (a && b) return remoteAsync(op, [from, to, ...rest]);
      await crossCopy(toPath(from), toPath(to), op === 'cp' ? !!rest[0]?.recursive : false);
      if (op === 'rename') await (a ? remoteAsync('rm', [from, { recursive: true, force: true }]) : original.fsp.rm(from, { recursive: true, force: true }));
    };
  }
  fsp.symlink = function patched(target, link, ...rest) { return isRemote(link) ? remoteAsync('symlink', [toPath(target) ?? target, link, ...rest]) : original.fsp.symlink.call(this, target, link, ...rest); };
  fsp.mkdtemp = function patched(prefix, ...rest) { return isRemote(prefix) ? remoteAsync('mkdtemp', [prefix]) : original.fsp.mkdtemp.call(this, prefix, ...rest); };
  fsp.opendir = async function patched(target, ...rest) {
    if (!isRemote(target)) return original.fsp.opendir.call(this, target, ...rest);
    const entries = await remoteAsync('readdir', [target, { withFileTypes: true }]);
    let index = 0;
    return { path: toPath(target), read: async () => entries[index++] ?? null, readSync: () => entries[index++] ?? null, close: async () => {}, closeSync: () => {},
      async *[Symbol.asyncIterator]() { while (index < entries.length) yield entries[index++]; } };
  };
  fsp.open = async function patched(target, flags = 'r', mode) {
    if (!isRemote(target)) return original.fsp.open.call(this, target, flags, mode);
    const file = toPath(target);
    const writing = /[wa+]/.test(String(flags));
    let content = /^[ra]/.test(String(flags)) || String(flags).includes('+') ? await remoteAsync('readFile', [file]).catch(error => { if (error.code === 'ENOENT' && writing) return Buffer.alloc(0); throw error; }) : Buffer.alloc(0);
    if (String(flags).startsWith('w')) content = Buffer.alloc(0);
    let dirty = String(flags).startsWith('w'), position = 0;
    return {
      fd: -1,
      stat: () => remoteAsync('stat', [file]),
      readFile: options => { const encoding = encodingOf(options); return Promise.resolve(encoding ? content.toString(encoding) : Buffer.from(content)); },
      read: async (buffer, offset = 0, length = buffer?.length ?? 0, at = null) => {
        const start = at ?? position; const bytes = content.copy(buffer, offset, start, Math.min(content.length, start + length));
        if (at === null) position += bytes;
        return { bytesRead: bytes, buffer };
      },
      write: async (data, ...rest) => {
        const chunk = typeof data === 'string' ? Buffer.from(data, typeof rest[1] === 'string' ? rest[1] : 'utf8') : Buffer.from(data);
        content = String(flags).startsWith('a') ? Buffer.concat([content, chunk]) : Buffer.concat([content.subarray(0, position), chunk, content.subarray(position + chunk.length)]);
        position += chunk.length; dirty = true;
        return { bytesWritten: chunk.length, buffer: data };
      },
      writeFile: async (data, options) => { content = typeof data === 'string' ? Buffer.from(data, encodingOf(options) || 'utf8') : Buffer.from(data); dirty = true; },
      appendFile: async (data, options) => { content = Buffer.concat([content, typeof data === 'string' ? Buffer.from(data, encodingOf(options) || 'utf8') : Buffer.from(data)]); dirty = true; },
      truncate: async (length = 0) => { content = content.subarray(0, length); dirty = true; },
      sync: async () => {}, datasync: async () => {},
      close: async () => { if (dirty && writing) await remoteAsync('writeFile', [file, content, { mode }]); dirty = false; },
      async [Symbol.asyncDispose]() { await this.close(); },
    };
  };
}

function patchCallbacks() {
  const callbackify = (name, impl) => function patched(...args) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    if (!isRemote(args[0]) && !(TWO_PATH.includes(name) && isRemote(args[1])) && !(name === 'symlink' && isRemote(args[1]))) return original.fs[name].call(this, ...args, ...(callback ? [callback] : []));
    impl(...args).then(value => callback?.(null, value), error => callback?.(error));
  };
  for (const op of [...ONE_PATH, ...TWO_PATH, 'symlink', 'mkdtemp']) if (original.fs[op] && fsp[op]) fs[op] = callbackify(op, (...args) => fsp[op](...args));
  if (original.fs.realpath) fs.realpath.native = callbackify('realpath', (...args) => fsp.realpath(...args));
  fs.exists = function patched(target, callback) {
    if (!isRemote(target)) return original.fs.exists.call(this, target, callback);
    remoteAsync('exists', [target]).then(value => callback?.(!!value), () => callback?.(false));
  };
}

function patchSync() {
  const sync = (name, op = name.replace(/Sync$/, '')) => {
    if (!original.fs[name]) return;
    fs[name] = function patched(target, ...rest) {
      if (TWO_PATH.includes(op) && (isRemote(target) || isRemote(rest[0]))) {
        if (isRemote(target) && isRemote(rest[0])) return remoteSync(op, [target, ...rest]);
        throw Object.assign(new Error(`EXDEV: cross-device ${op} is not supported synchronously, ${op} '${target}'`), { code: 'EXDEV' });
      }
      return isRemote(target) ? remoteSync(op, [target, ...rest]) : original.fs[name].call(this, target, ...rest);
    };
  };
  for (const op of [...ONE_PATH, ...TWO_PATH, 'mkdtemp']) sync(`${op}Sync`);
  if (original.fs.realpathSync) fs.realpathSync.native = function patched(target, ...rest) { return isRemote(target) ? remoteSync('realpath', [target]) : original.fs.realpathSync.native.call(this, target, ...rest); };
  fs.existsSync = function patched(target) {
    if (!isRemote(target)) return original.fs.existsSync.call(this, target);
    try { return !!remoteSync('exists', [target]); } catch { return false; }
  };
  fs.symlinkSync = function patched(target, link, ...rest) { return isRemote(link) ? remoteSync('symlink', [toPath(target) ?? target, link]) : original.fs.symlinkSync.call(this, target, link, ...rest); };
}

function patchStreams() {
  fs.createReadStream = function patched(target, options) {
    if (!isRemote(target)) return original.fs.createReadStream.call(this, target, options);
    const opts = typeof options === 'string' ? { encoding: options } : options || {};
    const stream = new Readable({ read() {} });
    if (opts.encoding) stream.setEncoding(opts.encoding);
    remoteAsync('readFile', [target]).then(buffer => {
      const slice = buffer.subarray(opts.start ?? 0, opts.end === undefined ? undefined : opts.end + 1);
      stream.emit('open', -1); stream.emit('ready');
      stream.push(slice); stream.push(null);
    }, error => stream.destroy(error));
    stream.path = toPath(target);
    return stream;
  };
  fs.createWriteStream = function patched(target, options) {
    if (!isRemote(target)) return original.fs.createWriteStream.call(this, target, options);
    const opts = typeof options === 'string' ? { encoding: options } : options || {};
    const chunks = [];
    const stream = new Writable({
      write(chunk, encoding, callback) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)); callback(); },
      final(callback) { remoteAsync(String(opts.flags || 'w').startsWith('a') ? 'appendFile' : 'writeFile', [target, Buffer.concat(chunks), { mode: opts.mode }]).then(() => callback(), callback); },
    });
    stream.path = toPath(target);
    queueMicrotask(() => { stream.emit('open', -1); stream.emit('ready'); });
    return stream;
  };
  const quiet = () => Object.assign(new EventEmitter(), { close() {}, ref() { return this; }, unref() { return this; } });
  fs.watch = function patched(target, ...rest) { return isRemote(target) ? quiet() : original.fs.watch.call(this, target, ...rest); };
  fs.watchFile = function patched(target, ...rest) { return isRemote(target) ? quiet() : original.fs.watchFile.call(this, target, ...rest); };
  fs.unwatchFile = function patched(target, ...rest) { return isRemote(target) ? undefined : original.fs.unwatchFile.call(this, target, ...rest); };
}

// ---- child processes ----
const originalCp = { ...childProcess };
const originalKill = process.kill.bind(process);
const remoteChildren = new Map();
let nextFakePid = FAKE_PID_BASE;

function normalize(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  return { file: String(file), args: (args || []).map(String), options: options || {} };
}
function remoteCwd(options) {
  const cwd = options.cwd ? toPath(options.cwd) : (process.env.TF_REMOTE_CWD || null);
  return cwd;
}
function routeOf(file, args, options) {
  const cwd = remoteCwd(options);
  const base = path.basename(file);
  const nodeChild = file === process.execPath || base === 'node';
  if (nodeChild) return cwd && isRemote(cwd) ? 'node-remote-cwd' : 'node';
  if (options.shell) return cwd && isRemote(cwd) ? 'remote' : 'local';
  if (isRemote(file) || REMOTE_COMMANDS.has(base)) return 'remote';
  if (cwd && isRemote(cwd) && !path.isAbsolute(file)) return 'remote';
  if (cwd && isRemote(cwd) && PATH_TOOLS.has(base)) return 'remote';
  if (PATH_TOOLS.has(base) && args.some(arg => isRemote(arg) || /^--?[\w-]+=\//.test(arg) && isRemote(arg.slice(arg.indexOf('=') + 1)))) return 'remote';
  return 'local';
}
function nodeEnv(options, cwdRemote) {
  const env = { ...(options.env || process.env) };
  const flag = `--import=${PRELOAD}`;
  if (!String(env.NODE_OPTIONS || '').includes(flag)) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} ${flag}`.trim();
  for (const key of ['TF_REMOTE_URL', 'TF_REMOTE_TOKEN', 'TF_REMOTE_PREFIXES', 'TF_UPLOAD_ROOTS']) if (process.env[key]) env[key] = process.env[key];
  if (cwdRemote) env.TF_REMOTE_CWD = cwdRemote; else if (!options.cwd && process.env.TF_REMOTE_CWD) env.TF_REMOTE_CWD = process.env.TF_REMOTE_CWD; else delete env.TF_REMOTE_CWD;
  return env;
}
function localOptions(route, options) {
  if (route === 'node-remote-cwd') return { ...options, cwd: process.cwd(), env: nodeEnv(options, remoteCwd(options)) };
  if (route === 'node') return { ...options, env: nodeEnv(options, null) };
  if (!options.cwd && process.env.TF_REMOTE_CWD) return { ...options, cwd: process.cwd() };
  return options;
}
function remoteSpec(file, args, options) {
  let command = file, list = args;
  if (options.shell) { command = typeof options.shell === 'string' ? options.shell : '/bin/sh'; list = ['-c', [file, ...args].join(' ')]; }
  const env = {};
  for (const [key, value] of Object.entries(options.env || {})) {
    if (typeof value !== 'string' || DROP_ENV.has(key) || key.startsWith('TF_') || key.startsWith('npm_') || SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  const files = []; let total = 0;
  list.forEach((arg, index) => {
    if (!path.isAbsolute(arg) || isRemote(arg) || !config.uploads.some(root => arg.startsWith(`${root}/`))) return;
    try {
      const info = original.fs.statSync(arg);
      if (!info.isFile() || info.size > UPLOAD_MAX || total + info.size > UPLOAD_TOTAL) return;
      total += info.size;
      files.push({ index, name: path.basename(arg), data: original.fs.readFileSync(arg).toString('base64') });
    } catch {}
  });
  const cwd = remoteCwd(options);
  return { command, args: list, cwd, env, files };
}

class RemoteChild extends EventEmitter {
  constructor(spec, stdio) {
    super();
    this.pid = nextFakePid++;
    this.spawnfile = spec.command; this.spawnargs = [spec.command, ...spec.args];
    this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false;
    const modes = (Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]).map(mode => mode ?? 'pipe');
    this.stdin = modes[0] === 'pipe' ? new Writable({ write: (chunk, encoding, callback) => { this.remote.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)); callback(); }, final: callback => { this.remote.end(); callback(); } }) : null;
    this.stdout = modes[1] === 'pipe' ? new Readable({ read() {} }) : null;
    this.stderr = modes[2] === 'pipe' ? new Readable({ read() {} }) : null;
    this.stdio = [this.stdin, this.stdout, this.stderr];
    const sink = (mode, stream, target) => data => { if (stream) stream.push(data); else if (mode === 'inherit') target.write(data); };
    const out = sink(modes[1], this.stdout, process.stdout), err = sink(modes[2], this.stderr, process.stderr);
    remoteChildren.set(this.pid, this);
    let started = false;
    this.remote = execRequest(config, spec, frame => {
      if (frame.t === 'id') this.remoteId = frame.id;
      else if (frame.t === 's') { started = true; this.remotePid = frame.pid; this.emit('spawn'); }
      else if (frame.t === 'o') out(Buffer.from(frame.d, 'base64'));
      else if (frame.t === 'e') err(Buffer.from(frame.d, 'base64'));
      else if (frame.t === 'x') this.finish(frame.code ?? null, frame.signal ?? null);
      else if (frame.t === 'err') {
        if (!started) { const error = remoteError({ code: frame.code || 'ENOENT', message: frame.message }, `spawn ${spec.command}`, spec.command); error.spawnargs = spec.args; this.emit('error', error); this.finish(frame.code === 'ENOENT' ? -2 : 1, null); }
        else { err(Buffer.from(`${frame.message}\n`)); this.finish(1, null); }
      }
    });
    if (modes[0] !== 'pipe') this.remote.end();
  }
  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null || this.finished) return;
    this.finished = true;
    this.exitCode = code; this.signalCode = signal;
    remoteChildren.delete(this.pid);
    this.stdout?.push(null); this.stderr?.push(null);
    queueMicrotask(() => { this.emit('exit', code, signal); setImmediate(() => this.emit('close', code, signal)); });
  }
  kill(signal = 'SIGTERM') {
    if (this.finished) return false;
    const name = typeof signal === 'number' ? (signal === 9 ? 'SIGKILL' : signal === 2 ? 'SIGINT' : 'SIGTERM') : String(signal);
    this.killed = true;
    if (this.remoteId) killRequest(config, this.remoteId, ['SIGKILL', 'SIGINT'].includes(name) ? name : 'SIGTERM');
    else this.remote.destroy();
    return true;
  }
  ref() { return this; } unref() { return this; } disconnect() {}
  send() { return false; }
  [Symbol.dispose]() { this.kill(); }
}

function patchChildProcess() {
  childProcess.spawn = function spawn(file, args, options) {
    const call = normalize(file, args, options);
    const route = routeOf(call.file, call.args, call.options);
    if (route !== 'remote') return originalCp.spawn.call(this, call.file, call.args, localOptions(route, call.options));
    return new RemoteChild(remoteSpec(call.file, call.args, call.options), call.options.stdio);
  };
  const execFile = function execFile(file, args, options, callback) {
    if (typeof args === 'function') { callback = args; args = []; options = {}; }
    else if (typeof options === 'function') { callback = options; if (!Array.isArray(args)) { options = args || {}; args = []; } else options = {}; }
    const call = normalize(file, args, options);
    const route = routeOf(call.file, call.args, call.options);
    if (route !== 'remote') return originalCp.execFile.call(this, call.file, call.args, localOptions(route, call.options), callback);
    const child = new RemoteChild(remoteSpec(call.file, call.args, call.options), ['pipe', 'pipe', 'pipe']);
    const encoding = call.options.encoding === undefined ? 'utf8' : call.options.encoding;
    const maxBuffer = call.options.maxBuffer ?? 1024 * 1024;
    const stdout = [], stderr = []; let size = 0, overflow = false;
    const collect = list => chunk => { size += chunk.length; if (size > maxBuffer) { overflow = true; child.kill(); return; } list.push(chunk); };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    const timer = call.options.timeout > 0 ? setTimeout(() => child.kill(call.options.killSignal || 'SIGTERM'), call.options.timeout) : null;
    const text = list => encoding && encoding !== 'buffer' ? Buffer.concat(list).toString(encoding) : Buffer.concat(list);
    let errored = null;
    child.on('error', error => { errored = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = text(stdout), errText = text(stderr);
      let error = null;
      if (errored) error = errored;
      else if (overflow) error = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      else if (code !== 0 || signal) error = Object.assign(new Error(`Command failed: ${[call.file, ...call.args].join(' ')}\n${errText}`), { code, killed: child.killed, signal, cmd: [call.file, ...call.args].join(' ') });
      if (error) { error.stdout = out; error.stderr = errText; }
      callback?.(error, out, errText);
    });
    if (call.options.input !== undefined) child.stdin.end(call.options.input); else child.stdin.end();
    return child;
  };
  execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    void child;
  });
  childProcess.execFile = execFile;
  const exec = function exec(command, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    if (!(remoteCwd(options) && isRemote(remoteCwd(options)))) return originalCp.exec.call(this, command, localOptions('local', options), callback);
    return execFile('/bin/sh', ['-c', command], options, callback);
  };
  exec[promisify.custom] = (command, options) => new Promise((resolve, reject) => { exec(command, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })); });
  childProcess.exec = exec;

  const remoteSync = (file, args, options) => {
    const spec = remoteSpec(file, args, options);
    const response = syncCall({ kind: 'exec', spec, input: options.input === undefined ? null : Buffer.from(options.input), maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024 }, options.timeout > 0 ? options.timeout + 5000 : 30 * 60_000);
    const value = response.ok ? response.value : { error: response.error, status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const encoding = options.encoding && options.encoding !== 'buffer' ? options.encoding : null;
    const stdout = encoding ? Buffer.from(value.stdout).toString(encoding) : Buffer.from(value.stdout);
    const stderr = encoding ? Buffer.from(value.stderr).toString(encoding) : Buffer.from(value.stderr);
    return { pid: 0, status: value.status, signal: value.signal, stdout, stderr, output: [null, stdout, stderr], ...(value.error ? { error: remoteError(value.error, `spawnSync ${file}`, file) } : {}) };
  };
  childProcess.spawnSync = function spawnSync(file, args, options) {
    const call = normalize(file, args, options);
    const route = routeOf(call.file, call.args, call.options);
    if (route !== 'remote') return originalCp.spawnSync.call(this, call.file, call.args, localOptions(route, call.options));
    return remoteSync(call.file, call.args, call.options);
  };
  const checked = (file, args, options) => {
    const value = remoteSync(file, args, options);
    if (value.error) throw value.error;
    if (value.status !== 0 || value.signal) throw Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}\n${value.stderr}`), { status: value.status, signal: value.signal, stdout: value.stdout, stderr: value.stderr, output: value.output });
    return value.stdout;
  };
  childProcess.execFileSync = function execFileSync(file, args, options) {
    const call = normalize(file, args, options);
    const route = routeOf(call.file, call.args, call.options);
    if (route !== 'remote') return originalCp.execFileSync.call(this, call.file, call.args, localOptions(route, call.options));
    return checked(call.file, call.args, { encoding: 'buffer', ...call.options });
  };
  childProcess.execSync = function execSync(command, options = {}) {
    if (!(remoteCwd(options) && isRemote(remoteCwd(options)))) return originalCp.execSync.call(this, command, localOptions('local', options));
    return checked('/bin/sh', ['-c', command], { encoding: 'buffer', ...options });
  };
  childProcess.fork = function fork(modulePath, args, options) {
    const call = normalize(modulePath, args, options);
    const cwd = remoteCwd(call.options);
    return originalCp.fork.call(this, call.file, call.args, { ...call.options, ...(cwd && isRemote(cwd) ? { cwd: process.cwd() } : {}), env: nodeEnv(call.options, cwd && isRemote(cwd) ? cwd : null) });
  };
  process.kill = (pid, signal) => {
    const child = remoteChildren.get(Math.abs(Number(pid)));
    if (child) { if (signal !== 0) child.kill(signal); return true; }
    if (Math.abs(Number(pid)) >= FAKE_PID_BASE) { if (signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); return true; }
    return originalKill(pid, signal);
  };
}

function remoteHosts() {
  const hosts = new Set();
  try {
    for (const item of JSON.parse(process.env.TF_REMOTE_HOSTS || '[]')) {
      if (typeof item === 'string' && item) hosts.add(item.toLowerCase());
    }
  } catch { /* ignore bad TF_REMOTE_HOSTS */ }
  for (const [key, value] of Object.entries(process.env)) {
    if (!/_BASE_URL$/.test(key) || typeof value !== 'string' || !value) continue;
    try { hosts.add(new URL(value).hostname.toLowerCase()); } catch { /* skip */ }
  }
  return hosts;
}

function patchFetch() {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let url;
    try { url = new URL(rawUrl, 'http://127.0.0.1'); } catch { return original.call(this, input, init); }
    const hosts = remoteHosts();
    if (!hosts.has(url.hostname.toLowerCase()) || !['http:', 'https:'].includes(url.protocol)) {
      return original.call(this, input, init);
    }
    const method = (init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const headers = {};
    const source = init.headers || (typeof input === 'object' && input?.headers) || undefined;
    if (source) {
      const list = source instanceof Headers ? [...source.entries()] : Array.isArray(source) ? source : Object.entries(source);
      for (const [key, value] of list) if (typeof key === 'string' && typeof value === 'string') headers[key] = value;
    }
    let body;
    const rawBody = init.body !== undefined ? init.body : (typeof input === 'object' && input?.body !== undefined ? input.body : undefined);
    if (rawBody != null) {
      if (Buffer.isBuffer(rawBody)) body = rawBody.toString('base64');
      else if (rawBody instanceof Uint8Array) body = Buffer.from(rawBody).toString('base64');
      else if (typeof rawBody === 'string') body = Buffer.from(rawBody).toString('base64');
      else return original.call(this, input, init);
    }
    const result = await httpRequest(config, { url: url.href, method, headers, body, hosts: [...hosts] });
    if (!result.ok) throw remoteError(result.error, 'fetch', url.href);
    const payload = result.value || {};
    return new Response(Buffer.from(payload.body || '', 'base64'), { status: payload.status || 502, headers: payload.headers || {} });
  };
}

if (config.url && config.token && !(workerData && workerData.tfRemoteSync) && (isMainThread || true)) {
  patchPromises();
  patchCallbacks();
  patchSync();
  patchStreams();
  patchChildProcess();
  patchFetch();
  syncBuiltinESMExports();
}

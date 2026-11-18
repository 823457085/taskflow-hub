import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const RELEASE_FILE = 'taskflow-release.json';
export const WORKBENCH_PORT = 5288;
const PACKAGE_MAX = { bridge: 20 * 1024 * 1024, workbench: 400 * 1024 * 1024 };
const VERSION = /^[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILES = { bridge: 'taskflow-bridge.tgz', workbench: 'taskflow-workbench.tgz' };

/** ~/.taskflow when this code runs from the installed layout ~/.taskflow/app/local-bridge, otherwise null. */
export function installedRoot(moduleUrl = import.meta.url) {
  const app = dirname(dirname(fileURLToPath(moduleUrl)));
  return basename(app) === 'app' && existsSync(join(dirname(app), 'state')) ? dirname(app) : null;
}

export function installedVersion(appDir) {
  try { return JSON.parse(readFileSync(join(appDir, 'local-bridge', 'release.json'), 'utf8')).version || null; } catch { return null; }
}

export function parseRelease(value) {
  const part = (item, name, required) => {
    if (item === undefined && !required) return null;
    if (!item || typeof item !== 'object' || !VERSION.test(item.version) || !SHA256.test(item.sha256) || !Number.isInteger(item.size) || item.size < 1 || item.size > PACKAGE_MAX[name]) throw new Error(`发布清单中的 ${name} 信息不正确`);
    return { version: item.version, sha256: item.sha256, size: item.size };
  };
  if (!value || typeof value !== 'object') throw new Error('发布清单不是 JSON 对象');
  return { bridge: part(value.bridge, 'bridge', true), workbench: part(value.workbench, 'workbench', false) };
}

export async function fetchRelease(hub, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(`/${RELEASE_FILE}`, hub), { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`读取发布清单失败：HTTP ${response.status}`);
  let value;
  try { value = await response.json(); } catch { throw new Error('服务器尚未发布客户端清单'); }
  return parseRelease(value);
}

async function download(hub, name, expected, target, fetchImpl) {
  const response = await fetchImpl(new URL(`/${FILES[name]}`, hub), { cache: 'no-store', signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`下载 ${FILES[name]} 失败：HTTP ${response.status}`);
  const hash = createHash('sha256');
  let size = 0;
  const counted = Readable.fromWeb(response.body).map(chunk => {
    size += chunk.length;
    if (size > expected.size) throw new Error(`${FILES[name]} 大小与发布清单不一致`);
    hash.update(chunk);
    return chunk;
  });
  await pipeline(counted, createWriteStream(target, { mode: 0o600 }));
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(`${FILES[name]} 校验失败，已放弃更新`);
}

const execute = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout)));
});

async function extract(archive, directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const entry of (await execute('tar', ['-tzf', archive])).split('\n').filter(Boolean)) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error(`安装包包含不安全路径：${entry}`);
  }
  await execute('tar', ['-xzf', archive, '-C', directory]);
}

async function sameDependencies(left, right) {
  try {
    const read = async dir => JSON.stringify(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies || {});
    return await read(left) === await read(right);
  } catch { return false; }
}

/** Replace ~/.taskflow/app with the published Bridge when its version differs; the caller restarts the process. */
export async function updateBridge({ root, hub, release, fetchImpl = fetch, run = execute, log = () => {} }) {
  const app = join(root, 'app'), current = installedVersion(app);
  if (current === release.bridge.version) return { updated: false, version: current };
  const work = join(root, 'update.tmp');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    await download(hub, 'bridge', release.bridge, join(work, 'bridge.tgz'), fetchImpl);
    const next = join(work, 'app');
    await extract(join(work, 'bridge.tgz'), next);
    if (!existsSync(join(next, 'local-bridge', 'rd.mjs')) || installedVersion(next) !== release.bridge.version) throw new Error('下载的 Bridge 安装包不完整');
    const modules = join(app, 'local-bridge', 'node_modules');
    if (existsSync(modules) && await sameDependencies(join(app, 'local-bridge'), join(next, 'local-bridge'))) await cp(modules, join(next, 'local-bridge', 'node_modules'), { recursive: true, verbatimSymlinks: true });
    else await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: join(next, 'local-bridge'), timeout: 10 * 60_000 }).catch(() => log('Bridge 的 MCP 依赖未能自动安装，不影响 worker'));
    await rm(join(root, 'app.old'), { recursive: true, force: true });
    if (existsSync(app)) await rename(app, join(root, 'app.old'));
    await rename(next, app);
    return { updated: true, from: current, version: release.bridge.version };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function workbenchPaths(root) {
  const base = join(root, 'workbench');
  return { base, releases: join(base, 'releases'), current: join(base, 'current'), next: join(base, 'next'), env: join(base, '.env'), data: join(base, 'data'), log: join(base, 'workbench.log') };
}

async function linkTarget(path) { try { return await readlink(path); } catch { return null; } }
export async function workbenchVersion(root) {
  const paths = workbenchPaths(root);
  return { current: (await linkTarget(paths.current))?.split('/').pop() || null, next: (await readFile(paths.next, 'utf8').catch(() => '')).trim() || null };
}

export function portInUse(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = connect({ port, host });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

export function workbenchEnv(example, { port, data }) {
  const values = { PORT: String(port), DELIVERY_DATA_DIR: data, DELIVERY_SOURCE_DATA_DIR: join(data, 'source') };
  const seen = new Set();
  const lines = example.split('\n').map(line => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
    if (!key || !(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  return lines.join('\n');
}

async function pnpmCommand(run) {
  for (const [file, args] of [['pnpm', []], ['corepack', ['pnpm']]]) {
    try { await run(file, [...args, '--version'], { timeout: 60_000 }); return [file, args]; } catch {}
  }
  return ['npx', ['--yes', 'pnpm@12.3.4']];
}

async function setActive(paths, version) {
  const temporary = `${paths.current}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await symlink(join('releases', version), temporary);
  await rename(temporary, paths.current);
  await rm(paths.next, { force: true });
}

async function prune(paths) {
  const keep = new Set(Object.values(await workbenchVersion(dirname(paths.base))).filter(Boolean));
  for (const name of await readdir(paths.releases).catch(() => [])) if (!keep.has(name)) await rm(join(paths.releases, name), { recursive: true, force: true });
}

/**
 * Download, verify and prepare the published workbench in its own release directory.
 * The first install activates immediately; later versions are staged and activate on the next workbench start.
 */
export async function installWorkbench({ root, hub, release, port = WORKBENCH_PORT, fetchImpl = fetch, run = execute, log = () => {} }) {
  if (!release.workbench) throw new Error('服务器尚未发布工作台安装包');
  const paths = workbenchPaths(root), { version } = release.workbench;
  const state = await workbenchVersion(root);
  if (state.current === version || state.next === version) return { changed: false, version, active: state.current === version };
  await mkdir(paths.releases, { recursive: true, mode: 0o700 });
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const target = join(paths.releases, version), archive = join(paths.base, 'workbench.tgz.tmp');
  try {
    log('正在下载工作台…');
    await download(hub, 'workbench', release.workbench, archive, fetchImpl);
    await extract(archive, target);
    if (!existsSync(join(target, 'dist', 'index.html')) || !existsSync(join(target, 'server', 'index.ts'))) throw new Error('下载的工作台安装包不完整');
    if (!existsSync(paths.env)) {
      const example = await readFile(join(target, '.env.example'), 'utf8').catch(() => '');
      await writeFile(paths.env, `${workbenchEnv(example, { port, data: paths.data })}\n`, { mode: 0o600, flag: 'wx' });
    }
    log('正在安装工作台依赖（首次可能需要几分钟）…');
    const [pnpm, prefix] = await pnpmCommand(run);
    await run(pnpm, [...prefix, 'install', '--frozen-lockfile'], { cwd: target, timeout: 30 * 60_000, env: { ...process.env, CI: '1' } });
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  } finally { await rm(archive, { force: true }); }
  const first = !state.current || !existsSync(paths.current);
  if (first) await setActive(paths, version);
  else await writeFile(paths.next, `${version}\n`, { mode: 0o600 });
  await prune(paths);
  return { changed: true, version, active: first };
}

export async function activateStagedWorkbench(root) {
  const paths = workbenchPaths(root), { next } = await workbenchVersion(root);
  if (next && VERSION.test(next) && existsSync(join(paths.releases, next, 'dist', 'index.html'))) { await setActive(paths, next); await prune(paths); return next; }
  if (next) await rm(paths.next, { force: true });
  return null;
}

/** Foreground process for the workbench service: activate a staged release, then run the server from the active release. */
export async function runWorkbench(root, { node = process.execPath } = {}) {
  const paths = workbenchPaths(root);
  await activateStagedWorkbench(root);
  const info = await lstat(paths.current).catch(() => null);
  if (!info) throw new Error('尚未安装工作台，请先运行 workbench --action install');
  const child = spawn(node, [`--env-file-if-exists=${paths.env}`, '--import', './server/plugins/bootstrap.mjs', '--import', 'tsx', 'server/index.ts'], {
    cwd: paths.current, stdio: 'inherit', env: { ...process.env, DELIVERY_CREDENTIALS_FILE: paths.env },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  return new Promise(resolve => child.once('close', code => resolve(code ?? 1)));
}

/** Add the local workbench to worker.json so the Bridge relays the web workbench to it. */
export async function enableWorkbenchRelay(configPath, port = WORKBENCH_PORT) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  if (raw.workbench) return false;
  raw.workbench = { url: `http://127.0.0.1:${port}` };
  const temporary = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  return true;
}

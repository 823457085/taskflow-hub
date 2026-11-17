import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile, link } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stateDir, loadSession, redactSecrets } from './api-client.mjs';
import { parseClientAdapter } from '../shared/local-client-adapter.mjs';

const run = promisify(execFile);
const bridgeDir = dirname(fileURLToPath(import.meta.url));
const mcpScript = join(bridgeDir, 'mcp.mjs');
const clients = ['codex', 'claude', 'cursor'];
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const stdioEntry = client => ({ ...(client === 'claude' || (typeof client === 'object' && client.includeType) ? { type: 'stdio' } : {}), command: process.execPath, args: [mcpScript], env: { RD_HUB_STATE_DIR: resolve(stateDir) } });
export function adapterMcpConfig(adapter) {
  const parsed = parseClientAdapter(adapter);
  return { [parsed.serversKey]: { taskflow: stdioEntry(parsed) } };
}
function clientTarget(client, adapter) {
  if (adapter !== undefined) {
    if (client !== undefined) throw new Error('需要且只能指定 --client 或 --adapter。');
    return parseClientAdapter(adapter);
  }
  if (!clients.includes(client)) throw new Error('--client 必须是 codex、claude 或 cursor。');
  return client;
}
const targetLabel = target => typeof target === 'object' ? { client: 'custom', adapterId: target.id } : { client: target };
const serversKey = target => typeof target === 'object' ? target.serversKey : 'mcpServers';

async function binaryPath(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, name);
    try { await access(path, constants.X_OK); const info = await lstat(path); if (info.isFile() || info.isSymbolicLink()) return path; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}
async function projectDirectory(project) {
  const path = resolve(project);
  let info;
  try { info = await lstat(path); } catch { throw new Error('指定项目目录不存在。'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('项目必须是普通目录，不能是符号链接。');
  return realpath(path);
}
function location(client, project) {
  if (typeof client === 'object') return join(project, client.configPath);
  if (!clients.includes(client)) throw new Error('不支持该客户端。');
  return client === 'codex' ? join(project, '.codex', 'config.toml') : client === 'claude' ? join(project, '.mcp.json') : join(project, '.cursor', 'mcp.json');
}
async function ensureParent(path, create, project) {
  const nested = relative(project, dirname(path));
  if (nested === '..' || nested.startsWith(`..${sep}`)) throw new Error('MCP 配置必须位于指定项目内。');
  let current = project;
  for (const segment of ['', ...nested.split(sep).filter(Boolean)]) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('MCP 配置目录必须属于当前用户，不能是符号链接或非目录文件。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      await mkdir(current, { mode: 0o700 });
    }
  }
}
async function snapshot(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_048_576 || (process.getuid && info.uid !== process.getuid())) throw new Error('MCP 配置必须是当前用户所有、最大 1 MiB 的普通文件。');
    return { text: await handle.readFile('utf8'), info };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new Error('MCP 配置不能是符号链接。');
    throw error;
  } finally { await handle?.close(); }
}
function sameJsonEntry(value, client) {
  if (!plainObject(value) || Object.keys(value).some(key => !['type', 'command', 'args', 'env'].includes(key))) return false;
  if (typeof client === 'object') return isDeepStrictEqual(value, stdioEntry(client));
  if (value.type !== undefined && value.type !== 'stdio') return false;
  const { type, ...rest } = value;
  const { type: ignored, ...expected } = stdioEntry(client);
  return isDeepStrictEqual(rest, expected);
}
function jsonConfig(text, client) {
  let data;
  try { data = text === undefined ? {} : JSON.parse(text); } catch { throw new Error('现有 MCP JSON 配置格式不正确，未修改文件。'); }
  const key = serversKey(client);
  if (!plainObject(data) || (Object.hasOwn(data, key) && !plainObject(data[key]))) throw new Error('现有 MCP JSON 配置结构不正确，未修改文件。');
  const servers = Object.hasOwn(data, key) ? data[key] : {};
  if (Object.hasOwn(servers, 'taskflow')) {
    if (!sameJsonEntry(servers.taskflow, client)) throw new Error('已有不同的 taskflow MCP 配置，拒绝覆盖。');
    return { unchanged: true, text };
  }
  return { unchanged: false, text: `${JSON.stringify({ ...data, [key]: { ...servers, taskflow: stdioEntry(client) } }, null, 2)}\n` };
}
async function codexConfig(text, add) {
  const binary = await binaryPath('codex');
  if (!binary) throw new Error('需要已安装的 Codex CLI 来安全解析和合并 TOML。');
  const temporary = await mkdtemp(join(tmpdir(), 'taskflow-codex-config-'));
  await chmod(temporary, 0o700);
  const file = join(temporary, 'config.toml');
  const options = { cwd: temporary, timeout: 10000, maxBuffer: 2_097_152, env: { HOME: temporary, CODEX_HOME: temporary, PATH: process.env.PATH || '', LANG: 'C.UTF-8' } };
  try {
    if (text !== undefined) await writeFile(file, text, { mode: 0o600 });
    let list;
    try { list = JSON.parse((await run(binary, ['mcp', 'list', '--json'], options)).stdout); }
    catch { throw new Error('Codex 无法解析现有 TOML 配置，未修改文件。'); }
    if (!Array.isArray(list)) throw new Error('Codex MCP 配置响应格式不正确。');
    const existing = list.find(item => item.name === 'taskflow');
    if (existing) {
      const transport = existing.transport;
      const expected = stdioEntry('codex');
      const same = existing.enabled === true && transport?.type === 'stdio' && transport.command === expected.command &&
        isDeepStrictEqual(transport.args, expected.args) && isDeepStrictEqual(transport.env, expected.env) &&
        (!transport.env_vars || transport.env_vars.length === 0) && (transport.cwd == null || transport.cwd === bridgeDir);
      if (!same) throw new Error('已有不同的 taskflow MCP 配置，拒绝覆盖。');
      return { unchanged: true, text };
    }
    if (!add) return { missing: true };
    try {
      await run(binary, ['mcp', 'add', 'taskflow', '--env', `RD_HUB_STATE_DIR=${resolve(stateDir)}`, '--', expectedNode(), mcpScript], options);
      return { unchanged: false, text: await readFile(file, 'utf8') };
    } catch { throw new Error('Codex 无法合并 taskflow MCP 配置，未修改文件。'); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
const expectedNode = () => process.execPath;
async function unchangedSnapshot(path, original) {
  const latest = await snapshot(path);
  return original === null ? latest === null : latest !== null && latest.info.ino === original.info.ino && latest.info.dev === original.info.dev && latest.text === original.text;
}

export async function installMcp({ client, project, adapter }) {
  client = clientTarget(client, adapter);
  if (typeof project !== 'string' || !project.trim()) throw new Error('需要明确的 --project。');
  const directory = await projectDirectory(project);
  const path = location(client, directory);
  await ensureParent(path, false, directory);
  const original = await snapshot(path);
  const merged = client === 'codex' ? await codexConfig(original?.text, true) : jsonConfig(original?.text, client);
  if (merged.unchanged) return { ...targetLabel(client), status: 'ALREADY_CONFIGURED', project: directory, configPath: path };
  await ensureParent(path, true, directory);
  const lock = `${path}.taskflow-lock`;
  let lockHandle;
  try { lockHandle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error('配置正在安装或存在锁文件，未修改配置。'); }
  const temporary = join(dirname(path), `.taskflow-${randomUUID()}.tmp`);
  let backupPath;
  try {
    await ensureParent(path, false, directory);
    if (!await unchangedSnapshot(path, original)) throw new Error('配置已被其他程序修改，请重新运行安装。');
    if (original) {
      backupPath = `${path}.taskflow-backup-${randomUUID()}`;
      await writeFile(backupPath, original.text, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(temporary, merged.text, { flag: 'wx', mode: original ? original.info.mode & 0o777 : 0o600 });
    await ensureParent(path, false, directory);
    if (!await unchangedSnapshot(path, original)) throw new Error('配置已被其他程序修改，请重新运行安装。');
    if (original) await rename(temporary, path);
    else { await link(temporary, path); await unlink(temporary); }
    return { ...targetLabel(client), status: 'CONFIGURED', project: directory, configPath: path, ...(backupPath ? { backupPath } : {}), nextStep: '重载对应软件的 MCP，再运行 doctor；配置写入不代表软件已加载。' };
  } finally {
    await unlink(temporary).catch(() => {});
    await lockHandle.close();
    await unlink(lock).catch(() => {});
  }
}

async function configStatus(client, directory) {
  const path = location(client, directory);
  const label = targetLabel(client);
  try {
    await ensureParent(path, false, directory);
    const original = await snapshot(path);
    if (!original) return { ...label, status: 'MISSING', configPath: path };
    if (client === 'codex') {
      const parsed = await codexConfig(original.text, false);
      return { ...label, status: parsed.missing ? 'MISSING' : 'MATCHED', configPath: path };
    }
    let parsed;
    try { parsed = JSON.parse(original.text); } catch { return { ...label, status: 'INVALID', configPath: path }; }
    const root = plainObject(parsed) && Object.hasOwn(parsed, serversKey(client)) ? parsed[serversKey(client)] : undefined;
    if (!plainObject(parsed) || (root !== undefined && !plainObject(root))) return { ...label, status: 'INVALID', configPath: path };
    const entry = root && Object.hasOwn(root, 'taskflow') ? root.taskflow : undefined;
    return { ...label, status: entry === undefined ? 'MISSING' : sameJsonEntry(entry, client) ? 'MATCHED' : 'CONFLICT', configPath: path };
  } catch { return { ...label, status: 'INVALID_OR_CONFLICT', configPath: path }; }
}
async function softwareStatus(name) {
  const path = await binaryPath(name);
  if (!path) return { name, installed: false };
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 5000, maxBuffer: 16_384 });
    const version = stdout.trim().split('\n')[0].replace(/[^\p{L}\p{N}\s()._+-]/gu, '').slice(0, 120);
    return { name, installed: true, path, version };
  } catch { return { name, installed: true, path, version: 'UNKNOWN' }; }
}
async function bounded(promise, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP 检查超时。')), timeout); })]); }
  finally { clearTimeout(timer); }
}
export async function runDoctor({ project = process.cwd(), adapter } = {}) {
  const custom = adapter === undefined ? null : clientTarget(undefined, adapter);
  const directory = await projectDirectory(project);
  const software = await Promise.all(['codex', 'agy', 'claude', 'cursor', 'cursor-agent'].map(softwareStatus));
  const configurations = await Promise.all([...clients, ...(custom ? [custom] : [])].map(client => configStatus(client, directory)));
  const result = { ok: false, software, configurations, mcp: { status: 'NOT_CHECKED' }, authentication: { status: 'NOT_CHECKED' }, note: '直接检查本地桥接 MCP；软件是否已重载须在对应软件内确认。' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpScript], env: { RD_HUB_STATE_DIR: resolve(stateDir) }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {}); // Never forward child stderr or credentials.
  const client = new Client({ name: 'taskflow-local-doctor', version: '1.0.0' });
  try {
    await bounded(client.connect(transport), 10000);
    const listed = await bounded(client.listTools(), 10000);
    result.mcp = { status: 'CONNECTED', toolCount: listed.tools.length };
    const tasks = await bounded(client.callTool({ name: 'task_list', arguments: {} }), 20000);
    if (tasks.isError) {
      result.authentication = { status: 'FAILED', message: tasks.content?.find(item => item.type === 'text')?.text || '平台认证检查失败。' };
      return result;
    }
    let data;
    try { data = JSON.parse(tasks.content.find(item => item.type === 'text').text); } catch { throw new Error('任务响应格式不正确。'); }
    if (!Array.isArray(data.tasks)) throw new Error('任务响应格式不正确。');
    const session = await loadSession();
    const projectCount = session.projectIds?.length ?? new Set(data.tasks.map(task => task.projectId).filter(Boolean)).size;
    result.authentication = { status: 'AUTHORIZED', taskCount: data.tasks.length, projectCount };
    result.ok = true;
    return result;
  } catch {
    if (result.mcp.status !== 'CONNECTED') result.mcp = { status: 'FAILED', message: 'MCP 无法完成初始化或工具发现。' };
    else result.authentication = { status: 'FAILED', message: '平台任务读取失败，请检查服务与登录状态。' };
    return result;
  } finally { await client.close().catch(() => {}); }
}

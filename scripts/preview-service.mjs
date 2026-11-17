import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import http from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const domain = `gui/${process.getuid()}`;
const suffix = createHash('sha256').update(root).digest('hex').slice(0, 12);
const mirror = resolve(homedir(), 'Library/Application Support/TaskFlow', suffix);
const runtime = resolve(mirror, 'runtime');
// Pass only explicitly configured URLs and private file references to launchd.
function connectorProfileReferences() {
  return Object.fromEntries([
    'TASKFLOW_JIRA_BASE_URL', 'TASKFLOW_JIRA_PROFILE',
    'TASKFLOW_CONFLUENCE_BASE_URL', 'TASKFLOW_CONFLUENCE_PROFILE',
    'TASKFLOW_JENKINS_PROFILE', 'TASKFLOW_YUNXIAO_PROFILE', 'TASKFLOW_YUNXIAO_ORGANIZATION_ID',
    'TASKFLOW_LOCAL_REPOS_FILE',
  ].filter(name => process.env[name]).map(name => [name, process.env[name]]));
}
const services = [
  { name: 'api', entry: resolve(mirror, 'api/server.mjs'), url: 'http://127.0.0.1:5187/health' },
  { name: 'ui', entry: resolve(mirror, 'preview-http.mjs'), url: 'http://127.0.0.1:5186/' },
].map(service => ({ ...service, label: `com.taskflow.${suffix}.${service.name}`, plist: resolve(runtime, `${service.name}.plist`), log: resolve(runtime, `${service.name}.log`) }));
const run = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const loaded = service => run(['print', `${domain}/${service.label}`]).status === 0;
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const string = value => `<string>${xml(value)}</string>`;
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
function readHttp(url, json = false) {
  return new Promise(resolveResult => {
    const request = http.get(url, { agent: false, timeout: 1000 }, response => {
      if (!json) { response.resume(); resolveResult(response.statusCode >= 200 && response.statusCode < 300); return; }
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 1_048_576) request.destroy(); });
      response.on('error', () => resolveResult(null));
      response.on('end', () => { try { resolveResult(JSON.parse(body)); } catch { resolveResult(null); } });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveResult(json ? null : false));
  });
}
const healthy = service => readHttp(service.url);
async function stop() {
  for (const service of [...services].reverse()) {
    if (loaded(service)) {
      const result = run(['bootout', `${domain}/${service.label}`]);
      if (result.status !== 0) throw new Error(`停止 ${service.name} 失败：${result.stderr.trim()}`);
    }
    for (let i = 0; i < 50; i++) {
      if (!loaded(service) && !await healthy(service)) break;
      await pause(100);
    }
    if (loaded(service)) throw new Error(`${service.name} 后台作业尚未卸载，请稍后重试。`);
    if (await healthy(service)) throw new Error(`${service.name} 端口仍由其他进程占用，未操作该进程。`);
    console.log(`${service.name}: 已停止`);
  }
}
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    if (item.name.startsWith('.') || item.name === 'node_modules') return [];
    const path = resolve(directory, item.name);
    return item.isDirectory() ? sourceFiles(path) : /\.(mjs|sql)$/.test(item.name) && !item.name.endsWith('.test.mjs') ? [path] : [];
  });
}
async function snapshotDatabase(source, destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(source, { readOnly: true });
  try { await backup(database, destination); chmodSync(destination, 0o600); }
  finally { database.close(); }
}
async function copyCandidate() {
  if (!existsSync(resolve(root, 'preview-app/dist/index.html'))) throw new Error('缺少前端产物，请先运行 npm run build。');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const files = sourceFiles(resolve(root, 'platform-server'));
  for (const path of files) {
    const destination = resolve(mirror, 'api', relative(resolve(root, 'platform-server'), path));
    mkdirSync(dirname(destination), { recursive: true }); cpSync(path, destination);
  }
  cpSync(resolve(root, 'scripts/preview-http.mjs'), resolve(mirror, 'preview-http.mjs'));
  cpSync(resolve(root, 'preview-app/dist'), resolve(mirror, 'public'), { recursive: true });
  const originalData = resolve(root, 'platform-server/.data');
  if (!existsSync(resolve(mirror, '.data/platform.sqlite')) && existsSync(resolve(originalData, 'platform.sqlite'))) await snapshotDatabase(resolve(originalData, 'platform.sqlite'), resolve(mirror, '.data/platform.sqlite'));
  const publicFiles = function walk(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(resolve(directory, item.name)) : [resolve(directory, item.name)]); }(resolve(root, 'preview-app/dist'));
  const hashes = [...files, resolve(root, 'scripts/preview-http.mjs'), ...publicFiles].sort().map(path => ({ path: relative(root, path).split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const revision = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  writeFileSync(resolve(mirror, 'build.json'), JSON.stringify({ revision, createdAt: new Date().toISOString(), files: hashes }, null, 2), { mode: 0o600 });
  console.log(`运行镜像: ${revision.slice(0, 16)}`);
}
async function backupData() {
  const data = resolve(mirror, '.data');
  if (!existsSync(data)) return;
  const backup = resolve(mirror, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  await snapshotDatabase(resolve(data, 'platform.sqlite'), resolve(backup, '.data/platform.sqlite'));
  const key = resolve(data, 'connectors.key');
  if (existsSync(key)) { cpSync(key, resolve(backup, '.data/connectors.key')); chmodSync(resolve(backup, '.data/connectors.key'), 0o600); }
  console.log(`运行数据已备份: ${backup}`);
}
async function start() {
  const started = [];
  try {
    for (const service of services) {
      if (!loaded(service)) {
        writeFileSync(service.log, '', { flag: 'a', mode: 0o600 }); chmodSync(service.log, 0o600);
        const env = { PATH: `${resolve(homedir(), '.local/bin')}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, TASKFLOW_HOST: '127.0.0.1', TASKFLOW_PORT: '5187', TASKFLOW_DB_PATH: resolve(mirror, '.data/platform.sqlite'), ...(service.name === 'api' ? { TASKFLOW_HOST_BRIDGE_STATE_DIR: resolve(mirror, '.bridge-state'), TASKFLOW_RUNS_DIR: resolve(mirror, '.runs'), TASKFLOW_PUBLIC_API_URL: 'http://127.0.0.1:5187', ...connectorProfileReferences() } : {}) };
        writeFileSync(service.plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key>${string(service.label)}
<key>ProgramArguments</key><array>${[process.execPath, service.entry].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(mirror)}
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key>${string(value)}`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key>${string(service.log)}<key>StandardErrorPath</key>${string(service.log)}</dict></plist>`, { mode: 0o600 });
        const result = run(['bootstrap', domain, service.plist]);
        if (result.status !== 0) throw new Error(`启动 ${service.name} 失败：${result.stderr.trim()}`);
        started.push(service);
        run(['kickstart', `${domain}/${service.label}`]);
      }
      let ready = false;
      for (let i = 0; i < 100; i++) { if (await healthy(service)) { ready = true; break; } await pause(300); }
      if (!ready) throw new Error(`${service.name} 未就绪，请检查 ${service.log}`);
      console.log(`${service.name}: 后台托管 ${service.url}`);
    }
  } catch (error) {
    for (const service of started.reverse()) run(['bootout', `${domain}/${service.label}`]);
    throw error;
  }
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('后台托管适用于macOS；其他系统请用dev:ui和dev:api。');
  const command = process.argv[2];
  if (!['start', 'stop', 'status', 'refresh'].includes(command)) throw new Error('用法：preview-service.mjs start|stop|status|refresh');
  if (command === 'stop') return stop();
  if (command === 'status') {
    for (const service of services) {
      const result = run(['print', `${domain}/${service.label}`]);
      const pid = result.stdout?.match(/\bpid = (\d+)/)?.[1];
      const ok = await healthy(service);
      console.log(`${service.name}: ${result.status === 0 && ok ? '运行中' : '未就绪'}${pid ? ` (PID ${pid})` : ''} ${service.url}`);
      if (!ok || result.status !== 0) process.exitCode = 1;
    }
    const version = await readHttp('http://127.0.0.1:5186/__taskflow/version', true);
    if (version?.revision) console.log(`在线版本: ${version.revision.slice(0,16)}`);
    return;
  }
  if (command === 'refresh') {
    if (!existsSync(resolve(root, 'preview-app/dist/index.html'))) throw new Error('缺少前端产物，请先运行 npm run build。');
    for (const path of [...sourceFiles(resolve(root, 'platform-server')), resolve(root, 'scripts/preview-http.mjs')]) {
      if (spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' }).status !== 0) throw new Error(`源码语法检查失败：${relative(root, path)}，服务未停止。`);
    }
    await backupData(); await stop();
  }
  else if (services.some(loaded)) {
    if (!services.every(loaded)) throw new Error('服务部分运行，请用preview:refresh统一更新。');
    return start();
  }
  await copyCandidate();
  await start();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

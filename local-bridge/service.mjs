import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './api-client.mjs';

export const SERVICE_LABEL = 'com.taskflow.bridge-worker';
export const WORKBENCH_LABEL = 'com.taskflow.workbench';
const RD_SCRIPT = fileURLToPath(new URL('./rd.mjs', import.meta.url));

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildPlist({ label = SERVICE_LABEL, node, script, command = 'worker', args = [], env = {}, logPath }) {
  const strings = items => items.map(item => `    <string>${xml(item)}</string>`).join('\n');
  const vars = Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings([node, script, command, ...args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export async function manageService(action, options = {}, deps = {}) {
  const {
    platform = process.platform, home = homedir(), env = process.env, node = process.execPath, uid = process.getuid?.(),
    run = (file, args) => new Promise(done => execFile(file, args, { timeout: 15_000 }, (error, stdout, stderr) => done({ ok: !error, stdout: String(stdout), stderr: String(stderr) }))),
    state = stateDir,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = deps;
  const workbench = options.kind === 'workbench';
  if (platform !== 'darwin') throw new Error(`后台常驻目前只支持 macOS（launchd）；其他系统请用 pm2 或 systemd 运行 \`rd.mjs ${workbench ? 'workbench --action run' : 'worker'}\`。`);
  const label = workbench ? WORKBENCH_LABEL : SERVICE_LABEL;
  const plistPath = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const logPath = workbench ? join(dirname(state), 'workbench', 'workbench.log') : join(state, 'worker.log');

  if (action === 'status') {
    const printed = await run('launchctl', ['print', target]);
    if (!printed.ok) return { status: 'NOT_INSTALLED', label, plist: plistPath };
    const pid = printed.stdout.match(/\bpid = (\d+)/)?.[1];
    return { status: pid ? 'RUNNING' : 'STOPPED', label, pid: pid ? Number(pid) : null, plist: plistPath, log: logPath };
  }
  if (action === 'uninstall') {
    await run('launchctl', ['bootout', target]);
    try { await unlink(plistPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { status: 'UNINSTALLED', label };
  }
  if (action === 'restart') {
    const restarted = await run('launchctl', ['kickstart', '-k', target]);
    if (!restarted.ok) throw new Error(`重启失败：${restarted.stderr.trim() || '服务未安装'}`);
    return { status: 'RESTARTED', label };
  }
  if (action !== 'install') throw new Error('--action 只能是 install、uninstall、restart 或 status。');

  const config = options.config ? resolve(options.config) : join(state, 'worker.json');
  const required = workbench ? [[join(dirname(state), 'workbench', 'current'), '请先运行 workbench --action install 安装工作台']]
    : [[join(state, 'session.json'), '请先运行 pair 完成设备配对'], [config, '请先运行 worker-init 并填写项目仓库映射']];
  for (const [file, hint] of required) {
    try { await access(file, constants.R_OK); } catch { throw new Error(`缺少 ${file}，${hint}。`); }
  }
  const vars = { PATH: [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'), RD_HUB_STATE_DIR: state, TASKFLOW_SERVICE: '1' };
  if (env.NODE_EXTRA_CA_CERTS) {
    if (!isAbsolute(env.NODE_EXTRA_CA_CERTS)) throw new Error('NODE_EXTRA_CA_CERTS 必须是绝对路径，后台服务不会继承当前目录。');
    vars.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
  }
  await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const args = workbench ? ['--action', 'run'] : options.config ? ['--config', config] : [];
  await writeFile(plistPath, buildPlist({ label, node, script: RD_SCRIPT, command: workbench ? 'workbench' : 'worker', args, env: vars, logPath }), { mode: 0o600 });
  await run('launchctl', ['bootout', target]);
  // bootout returns before launchd finishes unloading; bootstrap fails with EIO until then.
  let loaded;
  for (let attempt = 0; attempt < 10; attempt++) {
    loaded = await run('launchctl', ['bootstrap', domain, plistPath]);
    if (loaded.ok) break;
    await wait(500);
  }
  if (!loaded.ok) throw new Error(`launchctl 加载失败：${loaded.stderr.trim() || '未知错误'}`);
  return { status: 'INSTALLED', label, plist: plistPath, log: logPath };
}

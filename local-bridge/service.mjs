import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './api-client.mjs';

export const SERVICE_LABEL = 'com.taskflow.bridge-worker';
const RD_SCRIPT = fileURLToPath(new URL('./rd.mjs', import.meta.url));

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildPlist({ label = SERVICE_LABEL, node, script, args = [], env = {}, logPath }) {
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
${strings([node, script, 'worker', ...args])}
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
  <string>Background</string>
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
  } = deps;
  if (platform !== 'darwin') throw new Error('后台常驻目前只支持 macOS（launchd）；其他系统请用 pm2 或 systemd 运行 `rd.mjs worker`。');
  const plistPath = join(home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const logPath = join(state, 'worker.log');

  if (action === 'status') {
    const printed = await run('launchctl', ['print', target]);
    if (!printed.ok) return { status: 'NOT_INSTALLED', label: SERVICE_LABEL, plist: plistPath };
    const pid = printed.stdout.match(/\bpid = (\d+)/)?.[1];
    return { status: pid ? 'RUNNING' : 'STOPPED', label: SERVICE_LABEL, pid: pid ? Number(pid) : null, plist: plistPath, log: logPath };
  }
  if (action === 'uninstall') {
    await run('launchctl', ['bootout', target]);
    try { await unlink(plistPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { status: 'UNINSTALLED', label: SERVICE_LABEL };
  }
  if (action !== 'install') throw new Error('--action 只能是 install、uninstall 或 status。');

  const config = options.config ? resolve(options.config) : join(state, 'worker.json');
  for (const [file, hint] of [[join(state, 'session.json'), '请先运行 pair 完成设备配对'], [config, '请先运行 worker-init 并填写项目仓库映射']]) {
    try { await access(file, constants.R_OK); } catch { throw new Error(`缺少 ${file}，${hint}。`); }
  }
  const vars = { PATH: [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':'), RD_HUB_STATE_DIR: state };
  if (env.NODE_EXTRA_CA_CERTS) {
    if (!isAbsolute(env.NODE_EXTRA_CA_CERTS)) throw new Error('NODE_EXTRA_CA_CERTS 必须是绝对路径，后台服务不会继承当前目录。');
    vars.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
  }
  await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(plistPath, buildPlist({ node, script: RD_SCRIPT, args: options.config ? ['--config', config] : [], env: vars, logPath }), { mode: 0o600 });
  await run('launchctl', ['bootout', target]);
  const loaded = await run('launchctl', ['bootstrap', domain, plistPath]);
  if (!loaded.ok) throw new Error(`launchctl 加载失败：${loaded.stderr.trim() || '未知错误'}`);
  return { status: 'INSTALLED', label: SERVICE_LABEL, plist: plistPath, log: logPath };
}

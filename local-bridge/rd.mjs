#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, unlink, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { sessionPath, hostSessionPath, usesDefaultState, validateUrl, loadSession, loadSessionWithPath, saveSession, request, redactSecrets } from './api-client.mjs';
import { pairDevice, connectDevice, DEFAULT_API_URL, DEFAULT_WEB_URL } from './device-pair.mjs';
import { DEFAULT_CLIENT_ADAPTER } from '../shared/local-client-adapter.mjs';
import { loadClientAdapter } from './client-adapter.mjs';
const execFileAsync = promisify(execFile);
const allowed = {
  login: ['url', 'username'], tasks: [], context: ['task'],
  sync: ['task', 'tool', 'progress', 'summary', 'branch'], logout: [],
  assets: ['task'], reviews: ['task'], 'review-context': ['job'],
  'submit-report': ['job', 'file'], claim: ['task', 'version'],
  heartbeat: ['task', 'tool', 'status'],
  start: ['task', 'tool', 'repo', 'mode', 'claim'],
  pair: ['url', 'web-url', 'name', 'tool'], doctor: ['project', 'adapter'],
  connect: ['url', 'web-url', 'name', 'tool', 'projects'],
  'install-mcp': ['client', 'adapter', 'project'], 'adapter-template': [], 'export-mcp': ['adapter'],
};
export const TOOLS = ['codex', 'codex-cli', 'claude-code', 'cursor', 'custom'];
const HEARTBEAT_STATUSES = ['IDLE', 'WORKING', 'WAITING', 'OFFLINE'];
const MAX_REPORT_BYTES = 65_536;
const usage = `TaskFlow 本地进度桥接（Node.js 24）
  connect --name <设备名称> --tool <codex|codex-cli|claude-code|cursor|custom> [--url <API地址>] [--web-url <网页地址>] [--projects <建议项目ID,ID>]  打开日常Chrome读取配对申请并确认
  pair --url http://127.0.0.1:5187 --web-url http://127.0.0.1:5186 --name <设备名称> --tool <codex|codex-cli|claude-code|cursor|custom>
  login --url http://127.0.0.1:5187 --username <用户名>  密码从隐藏输入或 stdin 读取
  doctor [--project <项目目录>] [--adapter <适配器JSON文件>]
  install-mcp --client <codex|claude|cursor> --project <明确项目目录>
  install-mcp --adapter <适配器JSON文件> --project <明确项目目录>
  adapter-template
  export-mcp --adapter <适配器JSON文件>
  tasks
  start --task <任务UUID或Jira号> --tool <codex|codex-cli|claude-code|cursor|custom> [--repo <代码目录>] [--mode <watch|once>] [--claim <yes|no>]
  context --task <任务 UUID>
  assets --task <任务 UUID>
  reviews --task <任务 UUID>
  review-context --job <评审 UUID>
  submit-report --job <评审 UUID> --file <报告 JSON 文件>
  claim --task <任务 UUID> --version <当前任务版本>
  sync --task <任务 UUID> --tool <codex|codex-cli|claude-code|cursor|custom> --progress <0..100> --summary <摘要> [--branch <分支>]
  heartbeat --task <任务 UUID> --tool <codex|codex-cli|claude-code|cursor|custom> --status <IDLE|WORKING|WAITING|OFFLINE>
  logout
仅 install-mcp 写入指定项目的 taskflow MCP 配置；不会安装 Git Hook 或启动 AI。`;

function fail(message) { throw new Error(message); }
export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') return { command: 'help', options: {} };
  if (!allowed[command]) fail('未知命令；运行 --help 查看用法。');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, '');
    if (!rest[i]?.startsWith('--') || !allowed[command].includes(name) || !rest[i + 1] || rest[i + 1].startsWith('--') || name in options) fail('命令参数不正确；密码不能通过参数传入。');
    options[name] = rest[i + 1];
  }
  if (command === 'login') {
    if (!options.username?.trim() || options.username.length > 80) fail('需要有效的 --username。');
    options.url = validateUrl(options.url || 'http://127.0.0.1:5187');
  }
  if (command === 'pair' || command === 'connect') {
    options.url = validateUrl(options.url || DEFAULT_API_URL);
    options['web-url'] = validateUrl(options['web-url'] || (options.url === DEFAULT_API_URL ? DEFAULT_WEB_URL : options.url));
    if (!options.name?.trim() || options.name.length > 80 || /[\x00-\x1f\x7f]/.test(options.name)) fail('需要 1 至 80 字符的 --name 设备名称。');
    options.name = options.name.trim();
    if (!TOOLS.includes(options.tool)) fail('需要支持的 --tool。');
    if (options.projects !== undefined) {
      const ids = options.projects.split(',');
      if (!ids.length || ids.length > 100 || ids.some(id => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) fail('--projects 需要1至100个有效项目ID，以逗号分隔。');
      options.projects = [...new Set(ids)];
    }
  }
  if (command === 'install-mcp') {
    if (!!options.client === !!options.adapter) fail('需要且只能指定 --client 或 --adapter。');
    if (options.client && !['codex', 'claude', 'cursor'].includes(options.client)) fail('--client 必须是 codex、claude 或 cursor。');
    if (!options.project?.trim() || /[\x00\r\n]/.test(options.project)) fail('需要明确的 --project 项目目录。');
  }
  if (command === 'doctor' && options.project !== undefined && (!options.project.trim() || /[\x00\r\n]/.test(options.project))) fail('--project 项目目录不正确。');
  if ((command === 'export-mcp' && !options.adapter) || (options.adapter !== undefined && (!options.adapter.trim() || /[\x00\r\n]/.test(options.adapter)))) fail('需要有效的 --adapter JSON 文件路径。');
  if (['context', 'sync', 'assets', 'reviews', 'claim', 'heartbeat', 'start'].includes(command)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.task || '')) fail('需要有效的 --task 任务 ID。');
  }
  if (command === 'start') {
    if (!TOOLS.includes(options.tool)) fail('需要支持的 --tool。');
    if (options.repo !== undefined && (!options.repo.trim() || /[\x00\r\n]/.test(options.repo))) fail('需要有效的 --repo 代码目录。');
    options.mode = options.mode || 'watch';
    if (!['watch', 'once'].includes(options.mode)) fail('--mode 必须是 watch 或 once。');
    options.claim = options.claim || 'no';
    if (!['yes', 'no'].includes(options.claim)) fail('--claim 必须是 yes 或 no。');
  }
  if (['review-context', 'submit-report'].includes(command) && !/^[A-Za-z0-9_-]{1,80}$/.test(options.job || '')) fail('需要有效的 --job 评审 ID。');
  if (command === 'submit-report' && (!options.file?.trim() || /[\x00\r\n]/.test(options.file))) fail('需要有效的 --file 报告文件路径。');
  if (command === 'claim' && (!/^[1-9]\d*$/.test(options.version || '') || !Number.isSafeInteger(Number(options.version)))) fail('--version 必须是当前任务的正整数版本。');
  if (command === 'heartbeat') {
    if (!TOOLS.includes(options.tool)) fail('需要支持的 --tool。');
    if (!HEARTBEAT_STATUSES.includes(options.status)) fail('--status 必须是 IDLE、WORKING、WAITING 或 OFFLINE。');
  }
  if (command === 'sync') {
    if (!TOOLS.includes(options.tool)) fail('需要支持的 --tool。');
    if (!/^(?:100|[1-9]?\d)$/.test(options.progress || '')) fail('--progress 必须是 0 到 100 的整数。');
    if (!options.summary?.trim() || options.summary.length > 1000) fail('--summary 需要 1 到 1000 个字符。');
    if (options.branch && (options.branch.length > 200 || /[\r\n\x00]/.test(options.branch))) fail('--branch 不正确。');
  }
  return { command, options };
}

export function validateReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 8000) fail('报告 summary 必须是 1 至 8000 字符的字符串。');
  if (!['MANUAL', 'LOCAL_TOOL'].includes(value.source)) fail('报告 source 必须是 MANUAL 或 LOCAL_TOOL，不能声明云端 AI 已执行。');
  if (value.source === 'LOCAL_TOOL' && !TOOLS.includes(value.tool)) fail('LOCAL_TOOL 报告需要支持的 tool。');
  if (value.tool !== undefined && !TOOLS.includes(value.tool)) fail('报告 tool 不受支持。');
  if (value.evidence !== undefined && (typeof value.evidence !== 'string' || value.evidence.length > 8000)) fail('报告 evidence 必须是不超过 8000 字符的字符串。');
  if (!Array.isArray(value.findings) || value.findings.length > 50) fail('报告 findings 必须是最多 50 项的数组。');
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding) ||
        !['CRITICAL', 'WARN', 'INFO'].includes(finding.severity) ||
        typeof finding.title !== 'string' || !finding.title.trim() || finding.title.length > 200 ||
        typeof finding.detail !== 'string' || !finding.detail.trim() || finding.detail.length > 4000 ||
        (finding.location !== undefined && (typeof finding.location !== 'string' || finding.location.length > 500))) {
      fail('报告 findings 格式不正确。');
    }
  }
  return {
    summary: value.summary, source: value.source,
    ...(value.tool === undefined ? {} : { tool: value.tool }),
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
    findings: value.findings.map(finding => ({ severity: finding.severity, title: finding.title, detail: finding.detail, ...(finding.location === undefined ? {} : { location: finding.location }) })),
  };
}

async function readReport(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REPORT_BYTES) fail('报告必须是最大 64 KiB 的普通 JSON 文件。');
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_REPORT_BYTES) fail('报告必须是最大 64 KiB 的普通 JSON 文件。');
    let value;
    try { value = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { fail('报告文件不是有效 JSON。'); }
    return validateReport(value);
  } catch (error) {
    if (error.code) fail('无法读取指定报告文件。');
    throw error;
  } finally { await handle?.close(); }
}
async function passwordInput() {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 1024) fail('密码输入过长。');
    }
    return value.replace(/\r?\n$/, '');
  }
  process.stderr.write('密码（输入不回显）：');
  emitKeypressEvents(process.stdin);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const done = (error) => {
        process.stdin.removeListener('keypress', onKey);
        error ? reject(error) : resolve(value);
      };
      const onKey = (text, key = {}) => {
        if (key.ctrl && key.name === 'c') return done(new Error('已取消登录。'));
        if (key.name === 'return' || key.name === 'enter') return done();
        if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
        else if (text && !key.ctrl && !key.meta && !/[\r\n\x00-\x1f\x7f]/.test(text)) value += text;
        if (value.length > 1024) done(new Error('密码输入过长。'));
      };
      process.stdin.on('keypress', onKey);
    });
  } finally {
    process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
    process.stderr.write('\n');
  }
}
async function inspectGitRepo(repoPath) {
  if (!repoPath) return null;
  const dir = resolve(repoPath);
  let info;
  try { info = await lstat(dir); } catch { fail('指定代码仓库目录不存在。'); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('代码仓库必须是普通目录，不能是符号链接。');
  try {
    const opts = { cwd: dir, timeout: 4000, maxBuffer: 65_536 };
    const branch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts)).stdout.trim();
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], opts)).stdout.trim();
    const subject = (await execFileAsync('git', ['log', '-1', '--pretty=%s'], opts)).stdout.trim().slice(0, 200);
    return { repoPath: dir, isGitRepo: true, branch: branch && branch !== 'HEAD' ? branch.slice(0, 200) : null, head, shortHead: head.slice(0, 8), subject };
  } catch {
    return { repoPath: dir, isGitRepo: false, branch: null, head: null, shortHead: null, subject: '' };
  }
}
async function resolveTaskTarget(session, identifier) {
  if (/^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/.test(identifier)) {
    const listed = await request(session.url, '/api/tasks', { token: session.token });
    const match = listed?.tasks?.find(item => typeof item.jiraKey === 'string' && item.jiraKey.toUpperCase() === identifier.toUpperCase());
    if (match) return match.id;
  }
  return identifier;
}
function printData(value) {
  // Server output is untrusted. Known secret fields are never printed.
  process.stdout.write(`${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}
export async function main(args) {
  const { command, options } = parseArgs(args);
  if (command === 'help') { process.stdout.write(`${usage}\n`); return; }
  if (command === 'adapter-template') { printData(DEFAULT_CLIENT_ADAPTER); return; }
  if (command === 'export-mcp') {
    const { adapterMcpConfig } = await import('./mcp-setup.mjs');
    // Generated config contains only fixed executable/script and state-directory paths.
    process.stdout.write(`${JSON.stringify(adapterMcpConfig(await loadClientAdapter(options.adapter)), null, 2)}\n`);
    return;
  }
  if (command === 'pair') { await pairDevice(options); return; }
  if (command === 'connect') { await connectDevice(options); return; }
  if (command === 'doctor') {
    const { runDoctor } = await import('./mcp-setup.mjs');
    const result = await runDoctor({ project: options.project, ...(options.adapter ? { adapter: await loadClientAdapter(options.adapter) } : {}) });
    printData(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'install-mcp') {
    const { installMcp } = await import('./mcp-setup.mjs');
    printData(await installMcp({ client: options.client, project: options.project, ...(options.adapter ? { adapter: await loadClientAdapter(options.adapter) } : {}) }));
    return;
  }
  if (command === 'login') {
    const password = await passwordInput();
    if (!password || /[\r\n]/.test(password)) fail('密码不能为空或包含换行。');
    const data = await request(options.url, '/api/login', { method: 'POST', body: { username: options.username, password } });
    if (typeof data?.token !== 'string' || data.token.length < 16 || data.token.length > 4096 || /[\r\n]/.test(data.token)) fail('平台未返回有效会话。');
    await saveSession({ url: options.url, token: data.token, deviceId: randomUUID() });
    printData({ status: '已登录', username: data.user?.username, role: data.user?.role });
    return;
  }
  const activeSession = await loadSessionWithPath();
  const session = activeSession.session;
  if (command === 'logout') {
    let revoked = true;
    try { await request(session.url, '/api/logout', { token: session.token, method: 'POST' }); } catch { revoked = false; }
    await unlink(activeSession.path).catch(() => {});
    if (usesDefaultState) {
      for (const candidate of [sessionPath, hostSessionPath]) if (candidate !== activeSession.path) await unlink(candidate).catch(() => {});
    }
    printData({ status: '本地会话已清除', serverRevoked: revoked });
    return;
  }
  if (command === 'start') {
    const taskId = await resolveTaskTarget(session, options.task);
    let context = await request(session.url, `/api/tasks/${encodeURIComponent(taskId)}/context`, { token: session.token });
    if (options.claim === 'yes' && !context.task?.assigneeId) {
      const claimed = await request(session.url, `/api/tasks/${encodeURIComponent(taskId)}/claim`, { token: session.token, method: 'POST', body: { expectedVersion: context.task.version } });
      context = { ...context, task: claimed.task };
    }
    const repoTarget = options.repo || context.workspace?.repoPath || null;
    let git = await inspectGitRepo(repoTarget);
    await request(session.url, `/api/tasks/${encodeURIComponent(taskId)}/heartbeat`, { token: session.token, method: 'POST', body: { deviceId: session.deviceId, tool: options.tool, status: 'WORKING' } });
    printData({
      status: options.mode === 'watch' ? '本地开发协同已启动（持续心跳与提交同步中，按 Ctrl+C 结束）' : '本地任务上下文与工作心跳已同步',
      taskId, jiraKey: context.task?.jiraKey, title: context.task?.title, taskStatus: context.task?.status,
      progress: context.task?.progress ?? 0, assetCount: Array.isArray(context.assets) ? context.assets.length : 0,
      repoPath: git?.repoPath || null, branch: git?.branch || null, headCommit: git?.shortHead || null, heartbeat: 'WORKING',
    });
    if (options.mode === 'once') return;
    let lastHead = git?.head || null;
    let currentProgress = Number.isInteger(context.task?.progress) ? context.task.progress : 0;
    let stopping = false;
    await new Promise(resolveDone => {
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        clearInterval(timer);
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        await request(session.url, `/api/tasks/${encodeURIComponent(taskId)}/heartbeat`, { token: session.token, method: 'POST', body: { deviceId: session.deviceId, tool: options.tool, status: 'OFFLINE' } }).catch(() => {});
        printData({ status: '本地开发协同已结束', taskId, jiraKey: context.task?.jiraKey, heartbeat: 'OFFLINE' });
        resolveDone();
      };
      const tick = async () => {
        if (stopping) return;
        try {
          const freshSession = await loadSession();
          await request(freshSession.url, `/api/tasks/${encodeURIComponent(taskId)}/heartbeat`, { token: freshSession.token, method: 'POST', body: { deviceId: freshSession.deviceId, tool: options.tool, status: 'WORKING' } });
          if (repoTarget) {
            git = await inspectGitRepo(repoTarget);
            if (git?.head && git.head !== lastHead) {
              lastHead = git.head;
              currentProgress = Math.min(95, Math.max(currentProgress, 20));
              const summary = `本地提交 ${git.shortHead}${git.subject ? `：${git.subject}` : ''}`.slice(0, 1000);
              await request(freshSession.url, `/api/tasks/${encodeURIComponent(taskId)}/progress`, {
                token: freshSession.token, method: 'POST', body: {
                  tool: options.tool, deviceId: freshSession.deviceId, progress: currentProgress, summary,
                  ...(git.branch ? { branch: git.branch } : {}),
                },
              });
              printData({ status: '已同步本地提交进度', taskId, jiraKey: context.task?.jiraKey, branch: git.branch, commit: git.shortHead, progress: currentProgress });
            }
          }
        } catch (error) {
          if (error.status === 401 || error.status === 403) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; await stop(); }
        }
      };
      const timer = setInterval(() => { void tick(); }, 30_000);
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    });
    return;
  }
  if (command === 'tasks') printData(await request(session.url, '/api/tasks', { token: session.token }));
  if (command === 'context') printData(await request(session.url, `/api/tasks/${encodeURIComponent(options.task)}/context`, { token: session.token }));
  if (command === 'assets') printData(await request(session.url, `/api/tasks/${encodeURIComponent(options.task)}/assets`, { token: session.token }));
  if (command === 'reviews') printData(await request(session.url, `/api/jobs?taskId=${encodeURIComponent(options.task)}`, { token: session.token }));
  if (command === 'review-context') printData(await request(session.url, `/api/jobs/${encodeURIComponent(options.job)}`, { token: session.token }));
  if (command === 'submit-report') printData(await request(session.url, `/api/jobs/${encodeURIComponent(options.job)}/report`, { token: session.token, method: 'POST', body: await readReport(options.file) }));
  if (command === 'claim') printData(await request(session.url, `/api/tasks/${encodeURIComponent(options.task)}/claim`, { token: session.token, method: 'POST', body: { expectedVersion: Number(options.version) } }));
  if (command === 'heartbeat') printData(await request(session.url, `/api/tasks/${encodeURIComponent(options.task)}/heartbeat`, { token: session.token, method: 'POST', body: { deviceId: session.deviceId, tool: options.tool, status: options.status } }));
  if (command === 'sync') printData(await request(session.url, `/api/tasks/${encodeURIComponent(options.task)}/progress`, {
    token: session.token, method: 'POST', body: {
      tool: options.tool, deviceId: session.deviceId, progress: Number(options.progress),
      summary: options.summary.trim(), ...(options.branch ? { branch: options.branch } : {}),
    },
  }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

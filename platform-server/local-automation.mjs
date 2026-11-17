import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ApiError, ASSET_ROLES, REVIEW_ROLES, STAGES, fail, sha, textField, publicGitRemote } from './common.mjs';
import { projectPermissions } from './permissions.mjs';
import { buildAiPrompt } from './ai-prompt.mjs';

const execFileAsync = promisify(execFile);
const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Downloads', 'Public', 'Documents', 'dist', 'build', 'target', 'vendor', '.git', '.Trash']);

export const AI_ENGINES = [
  { id: 'codex', label: 'Codex', binary: 'codex', tool: 'codex-cli' },
  { id: 'antigravity', label: 'Gemini / Antigravity', binary: 'agy', tool: 'custom' },
  { id: 'cursor', label: 'Cursor Agent', binary: 'cursor-agent', tool: 'cursor' },
  { id: 'claude', label: 'Claude Code', binary: 'claude', tool: 'claude-code' },
];

function enrichedPath(baseEnv = process.env) {
  const extra = [
    resolve(homedir(), '.local/bin'),
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const existing = (baseEnv.PATH || '').split(':').filter(Boolean);
  return [...new Set([...extra, ...existing])].join(':');
}

function findExecutable(name, pathValue) {
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function cleanRepoPath(value, field = 'repoPath') {
  const path = textField(value, field, { min: 2, max: 1024 });
  const segments = path.split('/');
  if (!path.startsWith('/') || /[\r\n\t\x00\x7f]/.test(path) || segments.includes('..') || segments.includes('.git')) {
    fail(400, 'INVALID_REPO_PATH', '请输入有效的本机代码仓库绝对路径');
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function stripRemoteCredentials(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return trimmed.replace(/\/\/[^@/]+@/, '//');
  }
}

const CONSTITUTION_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.clinerules',
];

export function detectConstitutionFiles(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') return [];
  const found = [];
  for (const rel of CONSTITUTION_CANDIDATES) {
    try {
      const full = join(repoRoot, rel);
      const st = lstatSync(full);
      if (st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= 524_288) {
        found.push(rel);
      }
    } catch { /* ignore missing or inaccessible */ }
  }
  return found;
}

export function extractReviewDraft(rawText, { allowPlainText = true } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;
  const fenced = rawText.match(/```(?:taskflow-review-draft|json)\s*([\s\S]*?)```/i);
  const parseCandidate = candidate => {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.slice(0, 50).filter(item => item && ['CRITICAL', 'WARN', 'INFO'].includes(item.severity) && typeof item.title === 'string' && item.title.trim() && typeof item.detail === 'string' && item.detail.trim()).map(item => ({
          severity: item.severity,
          title: item.title.trim().slice(0, 200),
          detail: item.detail.trim().slice(0, 4000),
          ...(typeof item.location === 'string' && item.location.trim() ? { location: item.location.trim().slice(0, 500) } : {}),
        }))
        : [];
      if (!allowPlainText && (!Array.isArray(parsed.findings) || parsed.findings.length !== findings.length)) return null;
      return {
        summary: parsed.summary.trim().slice(0, 8000),
        ...(typeof parsed.evidence === 'string' && parsed.evidence.trim() ? { evidence: parsed.evidence.trim().slice(0, 8000) } : {}),
        findings,
      };
    } catch {
      return null;
    }
  };
  if (fenced?.[1]) {
    const parsed = parseCandidate(fenced[1].trim());
    if (parsed) return parsed;
  }
  const direct = parseCandidate(rawText.trim());
  if (direct) return direct;
  const cleaned = rawText.trim();
  if (allowPlainText && cleaned.length >= 12) {
    return { summary: cleaned.slice(0, 8000), findings: [] };
  }
  return null;
}

export function scanGitDirectoryTree(roots, { maxRepos = 80 } = {}) {
  const found = new Map();
  let tccProtected = false;
  const visit = (dir, depth, maxDepth, groupHint) => {
    if (found.size >= maxRepos || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') tccProtected = true;
      return;
    }
    if (entries.some(entry => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      const normalized = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
      if (!found.has(normalized)) {
        found.set(normalized, {
          name: basename(normalized),
          path: normalized,
          group: groupHint || basename(dirname(normalized)),
        });
      }
      return;
    }
    if (depth === maxDepth) return;
    for (const entry of entries) {
      if (found.size >= maxRepos) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const nextGroup = depth === 0 ? entry.name : groupHint;
      visit(join(dir, entry.name), depth + 1, maxDepth, nextGroup);
    }
  };
  for (const spec of roots) {
    const rootPath = typeof spec === 'string' ? spec : spec.path;
    const maxDepth = typeof spec === 'object' && Number.isInteger(spec.maxDepth) ? spec.maxDepth : 3;
    const group = typeof spec === 'object' ? spec.group : undefined;
    if (!rootPath) continue;
    visit(rootPath, 0, maxDepth, group);
  }
  return { repositories: [...found.values()], tccProtected };
}

export function createLocalAutomation({
  db, transaction, audit, projectRole, visibleProjects, getTask, taskRole, assertWritable, assertAncestorsOpen,
  workflow, workspaceFor, hostBridgeStateDir = null, hostBridgeApiUrl = 'http://127.0.0.1:5187',
  runsDir = null, localReposFile = null, repoScanRoots = null, runnerOverride = null, appOpener = null,
  workbenchBridge, canUseHostBridge,
}) {
  const activeProcesses = new Map();
  const workbenchStarting = new Set();
  const baseRunsDir = runsDir || resolve(tmpdir(), 'taskflow-ai-runs-' + process.pid);
  const pathEnv = enrichedPath();
  let cachedEngineAvailability = null;
  let cachedEngineAt = 0;
  let cachedRepoScan = null;
  let cachedRepoScanAt = 0;

  const requireBrowser = (req, user, mutate = false) => {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权调用本机自动化执行接口');
    if (user.authTransport !== 'COOKIE' || mutate && !req.headers.origin) fail(403, 'BROWSER_SESSION_REQUIRED', '请在已登录的平台网页中执行此操作');
    if (!isLoopback(req.socket.remoteAddress)) fail(403, 'LOOPBACK_REQUIRED', '仅允许在本机回环网页中调用本地自动化功能');
  };

  const runRow = (row, workbenchLinked = false) => {
    if (!row) return null;
    let draft = null;
    if (row.draft_json) { try { draft = JSON.parse(row.draft_json); } catch { draft = null; } }
    return {
      id: row.id, taskId: row.task_id, projectId: row.project_id, jobId: row.job_id || null,
      actorId: row.actor_id, mode: row.mode, engine: row.engine, tool: row.tool, repoPath: row.repo_path || null,
      status: row.status, exitCode: row.exit_code ?? null, output: row.output || '', draft,
      error: row.error || null, startedAt: row.started_at, finishedAt: row.finished_at || null, updatedAt: row.updated_at,
      ...(row.runner === 'workbench' ? {
        runner: 'workbench',
        ...(workbenchLinked ? { workbenchUrl: `${workbenchBridge.origin}/agent?session=${encodeURIComponent(row.id)}` } : {}),
      } : {}),
    };
  };

  function requireWorkbenchOwner(user, projectId) {
    if (!canUseHostBridge(user, projectId)) {
      fail(403, 'WORKBENCH_MEMBER_REQUIRED', '请先在「本地 AI 接入」用当前成员授权该项目，再打开本机工作台');
    }
  }

  function exposeRun(row, user) {
    return runRow(row, row.runner === 'workbench' && row.actor_id === user.id && canUseHostBridge(user, row.project_id));
  }

  function requireRunOwner(row, user) {
    getTask(row.task_id, user);
    if (row.runner === 'workbench' && row.actor_id !== user.id) {
      fail(404, 'AI_RUN_NOT_FOUND', '本地 AI 执行记录不存在');
    }
  }

  function syncWorkbenchResult(row, remote) {
    const status = { queued: 'RUNNING', running: 'RUNNING', completed: 'SUCCEEDED',
      failed: 'FAILED', interrupted: 'INTERRUPTED', cancelled: 'CANCELLED' }[remote.status];
    const output = typeof remote.output === 'string' ? remote.output.slice(-64_000) : '';
    const draft = status === 'SUCCEEDED' && row.mode === 'review'
      ? extractReviewDraft(output, { allowPlainText: false }) : null;
    const updatedAt = typeof remote.updatedAt === 'string' && Number.isFinite(Date.parse(remote.updatedAt))
      ? remote.updatedAt : new Date().toISOString();
    const error = typeof remote.error === 'string' && remote.error ? remote.error.slice(0, 1000) : null;
    db.prepare(`UPDATE local_ai_runs SET status=?,output=?,draft_json=?,error=?,finished_at=?,updated_at=?
      WHERE id=? AND (status='RUNNING' OR updated_at<=?)`)
      .run(status, output, draft ? JSON.stringify(draft) : null, error, status === 'RUNNING' ? null : updatedAt, updatedAt, row.id, updatedAt);
    return db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(row.id);
  }

  async function readWorkbenchRun(row, user, reauthorize, action = 'read') {
    if (row.runner !== 'workbench') return row;
    if (workbenchStarting.has(row.id)) {
      if (action === 'stop') fail(409, 'WORKBENCH_STARTING', '工作台正在接收任务，请稍后停止');
      return row;
    }
    if (action === 'read' && !canUseHostBridge(user, row.project_id)) return row;
    const authorize = () => {
      const fresh = reauthorize ? reauthorize() : user;
      requireRunOwner(row, fresh);
      requireWorkbenchOwner(fresh, row.project_id);
    };
    authorize();
    try {
      const remote = await workbenchBridge.call({ action, runId: row.id, key: row.workbench_key }, authorize);
      return syncWorkbenchResult(row, remote);
    } catch (error) {
      if (action === 'stop') throw error;
      // A lost start response can race a late Workbench acceptance. Reconcile by the same id.
      if (row.status === 'RUNNING' && error.code === 'WORKBENCH_RUN_NOT_FOUND' && Date.now() - Date.parse(row.started_at) > 60_000) {
        return syncWorkbenchResult(row, { status: 'interrupted', output: row.output, error: error.message });
      }
      return db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(row.id) || row;
    }
  }

  const defaultRoots = () => repoScanRoots || [
    { path: resolve(homedir(), 'Desktop/工作'), maxDepth: 2 },
    { path: resolve(homedir(), 'workspace'), maxDepth: 2 },
    { path: resolve(homedir(), 'projects'), maxDepth: 2 },
    { path: resolve(homedir(), 'workplace'), maxDepth: 2 },
    { path: resolve(homedir(), 'code'), maxDepth: 2 },
    { path: resolve(homedir(), 'Developer'), maxDepth: 2 },
    { path: homedir(), maxDepth: 1, group: '主目录' },
  ];

  const readCachedRepos = () => {
    const file = localReposFile || process.env.TASKFLOW_LOCAL_REPOS_FILE;
    if (!file || !existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(item => item && typeof item.path === 'string' && item.path.startsWith('/') && !item.path.split('/').includes('..') && typeof item.name === 'string').map(item => ({
        name: item.name.slice(0, 120),
        path: item.path.length > 1 ? item.path.replace(/\/+$/, '') : item.path,
        group: typeof item.group === 'string' ? item.group.slice(0, 80) : basename(dirname(item.path)),
        ...(typeof item.branch === 'string' ? { branch: item.branch.slice(0, 120) } : {}),
        ...(typeof item.remoteUrl === 'string' ? { remoteUrl: stripRemoteCredentials(item.remoteUrl) } : {}),
      }));
    } catch {
      return [];
    }
  };

  async function runGit(repoPath, args, maxBuffer = 2_097_152) {
    const result = await execFileAsync('git', ['-C', repoPath, ...args], {
      env: { ...process.env, PATH: pathEnv, GIT_TERMINAL_PROMPT: '0' },
      timeout: 8000,
      maxBuffer,
    });
    return result.stdout;
  }

  async function inspectGitStatus(repoPath) {
    try {
      statSync(repoPath);
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        return {
          configured: true, accessible: false, tccProtected: true, repoPath,
          reason: 'macOS 桌面隐私策略限制后台托管服务直接读取桌面目录；可点击「在 Cursor 打开」或在终端使用 taskflow-hub 处理。',
        };
      }
      return { configured: true, accessible: false, tccProtected: false, repoPath, reason: '本地代码目录不存在，请重新选择或核对路径。' };
    }
    try {
      const top = (await runGit(repoPath, ['rev-parse', '--show-toplevel'], 65_536)).trim();
      if (!top) throw new Error('not-git');
      const [branchRaw, headRaw, shortRaw, subjectRaw, porcelainRaw, logRaw, remoteRaw] = await Promise.all([
        runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 16_384).catch(() => ''),
        runGit(repoPath, ['rev-parse', 'HEAD'], 16_384).catch(() => ''),
        runGit(repoPath, ['rev-parse', '--short', 'HEAD'], 16_384).catch(() => ''),
        runGit(repoPath, ['log', '-1', '--pretty=%s'], 32_768).catch(() => ''),
        runGit(repoPath, ['status', '--porcelain'], 262_144).catch(() => ''),
        runGit(repoPath, ['log', '-n', '5', '--pretty=format:%h\t%s\t%ci'], 65_536).catch(() => ''),
        runGit(repoPath, ['remote', 'get-url', 'origin'], 16_384).catch(() => ''),
      ]);
      const dirtyLines = porcelainRaw.split(/\r?\n/).filter(Boolean);
      const recentCommits = logRaw.split(/\r?\n/).filter(Boolean).map(line => {
        const [hash = '', subject = '', committedAt = ''] = line.split('\t');
        return { hash, subject, committedAt };
      });
      return {
        configured: true, accessible: true, tccProtected: false, repoPath,
        branch: branchRaw.trim() || null,
        head: headRaw.trim() || null,
        shortHead: shortRaw.trim() || null,
        subject: subjectRaw.trim() || '',
        remoteUrl: stripRemoteCredentials(remoteRaw),
        dirtyCount: dirtyLines.length,
        dirtyFiles: dirtyLines.slice(0, 20),
        recentCommits,
        constitutionFiles: detectConstitutionFiles(top),
      };
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || /operation not permitted/i.test(String(error?.stderr || error?.message || ''))) {
        return {
          configured: true, accessible: false, tccProtected: true, repoPath,
          reason: 'macOS 桌面隐私策略限制后台托管服务直接读取该仓库；可点击「在 Cursor 打开」或在终端运行提取命令。',
        };
      }
      return { configured: true, accessible: false, tccProtected: false, repoPath, reason: '该目录不是有效的 Git 仓库。' };
    }
  }

  async function captureGitAsset(task, user, role, body) {
    assertWritable(task, user);
    if (!ASSET_ROLES.CODE.includes(role)) fail(403, 'FORBIDDEN', '当前角色无权登记代码材料');
    const allowedKeys = ['repoPath', 'source', 'commit', 'logicalKey', 'title'];
    if (body && Object.keys(body).some(key => !allowedKeys.includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
    const bound = workspaceFor(user.id, task.projectId);
    const repoPath = body?.repoPath ? cleanRepoPath(body.repoPath) : bound?.repoPath;
    if (!repoPath) fail(409, 'WORKSPACE_REQUIRED', '请先为本项目绑定本地 Git 代码仓库');
    const source = body?.source || 'auto';
    if (!['auto', 'working', 'head', 'commit'].includes(source)) fail(400, 'INVALID_GIT_SOURCE', '不支持的 Git 提取模式');
    const commit = body?.commit !== undefined ? textField(body.commit, 'commit', { min: 7, max: 40 }) : null;
    if (source === 'commit' && (!commit || !/^[0-9a-fA-F]{7,40}$/.test(commit))) fail(400, 'INVALID_COMMIT', '请输入有效的 Git Commit SHA');
    if (commit && !/^[0-9a-fA-F]{7,40}$/.test(commit)) fail(400, 'INVALID_COMMIT', '请输入有效的 Git Commit SHA');

    const statusInfo = await inspectGitStatus(repoPath);
    if (!statusInfo.accessible) {
      if (statusInfo.tccProtected) fail(409, 'REPO_TCC_PROTECTED', statusInfo.reason);
      fail(409, 'REPO_UNAVAILABLE', statusInfo.reason);
    }

    let diffText = '';
    let statText = '';
    let usedMode = source;
    let capturedCommit = null;
    if (source === 'working' || (source === 'auto' && statusInfo.dirtyCount > 0)) {
      usedMode = 'working';
      statText = (await runGit(repoPath, ['status', '--short'], 131_072)).trim();
      diffText = (await runGit(repoPath, ['diff', 'HEAD'], 2_097_152)).trim();
      if (!diffText && statusInfo.dirtyCount > 0) {
        // Untracked files only: include status summary so user sees new files clearly.
        diffText = `# 检测到未跟踪新增文件（尚未 git add）：\n${statText}`;
      }
    }
    if (!diffText && (source === 'head' || source === 'auto')) {
      if (!statusInfo.head) fail(409, 'GIT_DIFF_EMPTY', '当前仓库尚无提交记录或工作区改动');
      usedMode = 'head';
      capturedCommit = statusInfo.head;
    } else if (source === 'commit') {
      usedMode = 'commit';
      capturedCommit = (await runGit(repoPath, ['rev-parse', '--verify', commit + '^{commit}'], 16_384).catch(() => fail(404, 'COMMIT_NOT_FOUND', '未在仓库中找到指定 Commit'))).trim();
    }
    if (capturedCommit) {
      statText = (await runGit(repoPath, ['show', '--stat', '--format=commit %H%nAuthor: %an%nDate:   %ci%n%n    %s', capturedCommit], 262_144)).trim();
      diffText = (await runGit(repoPath, ['show', '--format=', '--patch', capturedCommit], 2_097_152)).trim();
    }
    if (!diffText && !statText) fail(409, 'GIT_DIFF_EMPTY', '当前仓库没有可提取的工作区改动或提交 Diff');

    const gitRemote = capturedCommit ? publicGitRemote(statusInfo.remoteUrl) : null;
    const headerLines = [
      `# 本地 Git 代码快照（${basename(repoPath)}）`,
      `- 仓库目录：${repoPath}`,
      ...(gitRemote ? ['- Git 仓库：`' + gitRemote + '`', '- Commit SHA：`' + capturedCommit + '`'] : []),
      statusInfo.branch ? `- 当前分支：${statusInfo.branch}` : '',
      statusInfo.shortHead ? `- 基准提交：${statusInfo.shortHead}${statusInfo.subject ? ` (${statusInfo.subject})` : ''}` : '',
      `- 提取范围：${usedMode === 'working' ? '当前工作区未提交改动 (git diff HEAD)' : usedMode === 'commit' ? `指定提交 (${commit})` : '最新提交 (HEAD)'}`,
      '',
      statText ? `## 变更概览\n${statText}\n` : '',
      '## Patch Diff',
    ].filter(Boolean).join('\n');

    const budget = Math.max(4000, 62_000 - headerLines.length);
    const truncated = diffText.length > budget;
    const bodyPatch = truncated
      ? `${diffText.slice(0, budget)}\n\n# [提示：Diff 超过单份材料长度上限，已截断展示前 ${budget} 字符；完整改动请核对本地仓库]`
      : diffText;
    const content = `${headerLines}\n${bodyPatch}`.slice(0, 65_536);
    const defaultTitle = usedMode === 'working'
      ? `${basename(repoPath)} · 工作区改动 (${statusInfo.branch || 'HEAD'})`
      : `${basename(repoPath)} · Commit ${usedMode === 'commit' ? commit.slice(0, 8) : (statusInfo.shortHead || 'HEAD')}`;
    const title = body?.title ? textField(body.title, 'title', { max: 200, preserve: true }) : defaultTitle.slice(0, 200);
    const logicalKey = body?.logicalKey ? textField(body.logicalKey, 'logicalKey', { max: 100 }) : 'CODE';
    const id = randomUUID();
    const now = new Date().toISOString();
    transaction(() => {
      const currentTask = getTask(task.id, user);
      assertWritable(currentTask, user);
      const revision = db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM assets WHERE task_id=? AND kind=? AND logical_key=?').get(task.id, 'CODE', logicalKey).revision;
      db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, task.id, task.projectId, 'CODE', logicalKey, title, content, null, revision, sha(content), user.id, now);
      db.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(now, task.id);
      audit(user.id, 'ASSET_GIT_CAPTURE', id, task.projectId);
    });
    return {
      asset: workflow.assetsFor(task.id).find(item => item.id === id),
      branch: statusInfo.branch,
      head: statusInfo.shortHead,
      usedMode,
      truncated,
    };
  }

  async function openLocalRepo(user, body) {
    const allowed = ['projectId', 'app', 'repoPath'];
    if (!body || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
    const projectId = textField(body.projectId, 'projectId', { max: 64 });
    projectRole(user, projectId);
    const app = body.app || 'cursor';
    if (!['cursor', 'terminal', 'finder'].includes(app)) fail(400, 'INVALID_APP', '不支持的目标本地应用');
    const bound = workspaceFor(user.id, projectId);
    const repoPath = body.repoPath ? cleanRepoPath(body.repoPath) : bound?.repoPath;
    if (!repoPath) fail(409, 'WORKSPACE_REQUIRED', '请先选择并绑定本地代码仓库目录');
    if (appOpener) {
      await appOpener({ app, repoPath, projectId, userId: user.id });
    } else if (process.platform === 'darwin') {
      const args = app === 'cursor' ? ['-a', 'Cursor', repoPath] : app === 'terminal' ? ['-a', 'Terminal', repoPath] : [repoPath];
      await execFileAsync('/usr/bin/open', args, { timeout: 5000 }).catch(() => fail(409, 'OPEN_APP_FAILED', `无法在 macOS 上打开 ${app}，请确认应用已安装且目录存在`));
    } else {
      fail(409, 'OPEN_APP_UNSUPPORTED', '当前操作系统仅支持手动打开代码仓库');
    }
    audit(user.id, 'LOCAL_REPO_OPEN', projectId, projectId);
    return { opened: true, app, repoPath };
  }

  function spawnEngineProcess({ engineInfo, executable, mode, prompt, cwd, runDir, repoAccessiblePath }) {
    const env = {
      ...process.env,
      PATH: pathEnv,
      CI: '1',
      NO_COLOR: '1',
      ...(hostBridgeStateDir ? { TASKFLOW_HOST_BRIDGE_STATE_DIR: hostBridgeStateDir } : {}),
      TASKFLOW_API_URL: hostBridgeApiUrl,
    };
    const lastMessageFile = join(runDir, 'last-message.txt');
    if (engineInfo.id === 'codex') {
      const args = [
        'exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
        '-s', mode === 'develop' ? 'workspace-write' : 'read-only',
        ...(mode !== 'develop' && repoAccessiblePath ? ['--add-dir', repoAccessiblePath] : []),
        '-o', lastMessageFile,
        '-',
      ];
      const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(prompt, 'utf8');
      return { child, lastMessageFile };
    }
    if (engineInfo.id === 'antigravity') {
      const args = [
        '--print',
        '--mode', mode === 'develop' ? 'accept-edits' : 'plan',
        ...(mode !== 'develop' && repoAccessiblePath ? ['--add-dir', repoAccessiblePath] : []),
        prompt,
      ];
      const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      return { child, lastMessageFile: null };
    }
    if (engineInfo.id === 'cursor') {
      const args = ['--print', ...(mode === 'develop' ? ['--force'] : ['--plan']), prompt];
      const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      return { child, lastMessageFile: null };
    }
    const args = [
      '--print',
      ...(mode !== 'develop' && repoAccessiblePath ? ['--add-dir', repoAccessiblePath] : []),
      prompt,
    ];
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { child, lastMessageFile: null };
  }

  async function startAiRun(user, task, body, reauthorize) {
    const allowed = ['mode', 'engine', 'jobId', 'stage', 'autoCreateReview', 'autoClaim', 'autoSubmitReport', 'customInstruction', 'runner'];
    if (!body || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
    const runner = body.runner || 'local';
    if (!['local', 'workbench'].includes(runner)) fail(400, 'INVALID_AI_RUNNER', '当前执行位置不受支持');
    const workbench = runner === 'workbench';
    if (workbench) requireWorkbenchOwner(user, task.projectId);
    const mode = body.mode || 'read';
    if (!['read', 'develop', 'review'].includes(mode)) fail(400, 'INVALID_AI_MODE', '不支持的 AI 执行模式');
    const engineInfo = AI_ENGINES.find(item => item.id === (body.engine || 'codex'));
    if (!engineInfo) fail(400, 'INVALID_AI_ENGINE', '不支持的本地 AI 引擎');
    if (workbench && !['codex', 'cursor'].includes(engineInfo.id)) fail(400, 'INVALID_AI_ENGINE', '工作台接入支持 Codex 与 Cursor Agent');
    const executable = workbench || runnerOverride ? 'managed' : findExecutable(engineInfo.binary, pathEnv);
    if (!executable) fail(409, 'AI_ENGINE_UNAVAILABLE', `未在本机检测到 ${engineInfo.label} (${engineInfo.binary}) 命令`);

    const runningCount = db.prepare("SELECT COUNT(*) AS count FROM local_ai_runs WHERE actor_id=? AND status='RUNNING'").get(user.id).count;
    if (!workbench && runningCount >= 2) fail(429, 'AI_RUN_BUSY', '当前已有 2 个本地 AI 任务正在运行，请等待完成或停止后再发起');

    let currentTask = getTask(task.id, user);
    const role = taskRole(currentTask, user);
    if (mode !== 'read') assertWritable(currentTask, user);

    if (mode === 'develop') {
      if (!currentTask.assigneeId && body.autoClaim === true) {
        assertAncestorsOpen(currentTask, user);
        transaction(() => {
          const fresh = getTask(currentTask.id, user);
          if (!fresh.assigneeId) {
            db.prepare("UPDATE tasks SET assignee_id=?,status='IN_PROGRESS',version=version+1,context_version=context_version+1,updated_at=? WHERE id=?").run(user.id, new Date().toISOString(), fresh.id);
            audit(user.id, 'TASK_CLAIM', fresh.id, fresh.projectId);
          }
        });
        currentTask = getTask(currentTask.id, user);
      }
      if (currentTask.assigneeId !== user.id && !projectPermissions(user, role).assignTasks) {
        fail(403, 'FORBIDDEN', '请先认领该任务后再启动开发协作');
      }
    }

    const bound = workspaceFor(user.id, currentTask.projectId);
    let repoStatus = bound?.repoPath ? await inspectGitStatus(bound.repoPath) : null;
    if (mode === 'develop') {
      if (!bound?.repoPath) fail(409, 'WORKSPACE_REQUIRED', '开发协作需要先绑定本机业务 Git 仓库目录');
      if (!repoStatus?.accessible) {
        if (repoStatus?.tccProtected) fail(409, 'REPO_TCC_PROTECTED', repoStatus.reason);
        fail(409, 'REPO_UNAVAILABLE', repoStatus?.reason || '绑定的本地仓库不可访问');
      }
    }

    let targetJob = null;
    if (mode === 'review') {
      if (body.jobId) {
        const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(textField(body.jobId, 'jobId', { max: 64 }));
        if (!row || row.task_id !== currentTask.id) fail(404, 'JOB_NOT_FOUND', '指定的本地评审申请不存在');
        const hydrated = workflow.jobRow(row, currentTask);
        if (hydrated.executionMode !== 'LOCAL_REPORT' || hydrated.report || hydrated.decision || hydrated.stale) {
          fail(409, 'JOB_NOT_ELIGIBLE', '该评审申请已过期或已提交报告，请重新发起本地评审');
        }
        if (!REVIEW_ROLES[role]?.includes(hydrated.stage)) fail(403, 'FORBIDDEN', '当前角色无权执行该阶段评审');
        targetJob = hydrated;
      } else {
        const stage = body.stage;
        if (!STAGES.includes(stage)) fail(400, 'STAGE_REQUIRED', '请选择要执行的评审阶段或已有本地评审申请');
        const created = workflow.createReview(currentTask, user, role, { stage, executionMode: 'LOCAL_REPORT' });
        targetJob = created.job;
      }
    }

    const customInstruction = body.customInstruction ? textField(body.customInstruction, 'customInstruction', { min: 0, max: 2000, preserve: true }) : '';
    const autoSubmitReport = !workbench && mode === 'review' && body.autoSubmitReport === true;
    const repoAccessiblePath = repoStatus?.accessible ? bound.repoPath : null;
    const usedRepoPath = mode === 'develop' ? bound.repoPath : repoAccessiblePath;
    const workbenchKey = workbench ? sha(JSON.stringify([
      user.id, currentTask.projectId, currentTask.id, mode, engineInfo.id, usedRepoPath, customInstruction,
      targetJob ? [targetJob.id, targetJob.inputHash] : currentTask.version,
    ])) : null;
    if (workbench) {
      const existing = db.prepare(`SELECT * FROM local_ai_runs WHERE workbench_key=? AND actor_id=?
        AND runner='workbench' AND status IN ('RUNNING','SUCCEEDED') ORDER BY rowid DESC LIMIT 1`)
        .get(workbenchKey, user.id);
      if (existing) {
        const reconciled = await readWorkbenchRun(existing, user, reauthorize);
        return { run: exposeRun(reconciled, user), task: getTask(currentTask.id, user), ...(targetJob ? { job: targetJob } : {}) };
      }
      const active = db.prepare("SELECT COUNT(*) AS count FROM local_ai_runs WHERE actor_id=? AND status='RUNNING'").get(user.id);
      if (active.count >= 2) fail(429, 'AI_RUN_BUSY', '当前已有 2 个本地 AI 任务正在运行，请等待完成或停止后再发起');
    }
    const runId = randomUUID();
    const runDir = resolve(baseRunsDir, runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    const contextFilePath = join(runDir, 'context.json');
    const contextPayload = {
      task: currentTask,
      assets: workflow.assetsFor(currentTask.id),
      gates: workflow.gates(currentTask),
      workspace: bound,
      ...(repoStatus?.constitutionFiles?.length ? { constitutionFiles: repoStatus.constitutionFiles } : {}),
      ...(targetJob ? { reviewJob: { id: targetJob.id, stage: targetJob.stage, inputHash: targetJob.inputHash }, reviewSnapshot: targetJob.snapshot } : {}),
    };
    writeFileSync(contextFilePath, JSON.stringify(contextPayload, null, 2), { mode: 0o600 });
    chmodSync(contextFilePath, 0o600);

    const cwd = mode === 'develop' ? bound.repoPath : runDir;
    const prompt = buildAiPrompt({ mode, task: currentTask, job: targetJob, repoPath: bound?.repoPath || null, constitutionFiles: repoStatus?.constitutionFiles || [], contextFilePath, customInstruction });
    const now = new Date().toISOString();

    transaction(() => {
      if (reauthorize) reauthorize();
      db.prepare(`INSERT INTO local_ai_runs (id,task_id,project_id,job_id,actor_id,mode,engine,tool,repo_path,status,output,started_at,updated_at,runner,workbench_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        runId, currentTask.id, currentTask.projectId, targetJob?.id || null, user.id, mode, engineInfo.id,
        engineInfo.tool, usedRepoPath || null, 'RUNNING', '', now, now, runner, workbenchKey,
      );
      if (!workbench && mode === 'develop' && currentTask.assigneeId === user.id) {
        db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,device_id,actor_id) DO UPDATE SET tool=excluded.tool,status=excluded.status,last_seen=excluded.last_seen').run(
          currentTask.id, `local-ai:${engineInfo.id}`, user.id, engineInfo.tool, 'WORKING', now,
        );
      }
      audit(user.id, 'LOCAL_AI_RUN_START', runId, currentTask.projectId);
    });

    if (workbench) {
      const row = db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(runId);
      const authorize = () => {
        const fresh = reauthorize ? reauthorize() : user;
        requireRunOwner(row, fresh);
        requireWorkbenchOwner(fresh, currentTask.projectId);
        const latest = getTask(currentTask.id, fresh);
        const latestRole = taskRole(latest, fresh);
        if (mode !== 'read') assertWritable(latest, fresh);
        if (mode === 'develop' && latest.assigneeId !== fresh.id && !projectPermissions(fresh, latestRole).assignTasks) {
          fail(403, 'FORBIDDEN', '当前成员无权启动此任务的开发');
        }
        if (targetJob) {
          const jobRecord = db.prepare('SELECT * FROM jobs WHERE id=? AND task_id=?').get(targetJob.id, latest.id);
          const job = jobRecord && workflow.jobRow(jobRecord, latest);
          if (!job || job.stale || job.report || job.decision || !REVIEW_ROLES[latestRole]?.includes(job.stage)) {
            fail(409, 'JOB_NOT_ELIGIBLE', '当前评审申请已经变更，请重新选择');
          }
        } else if (latest.version !== currentTask.version) {
          fail(409, 'VERSION_CONFLICT', '任务已被更新，请刷新后重试');
        }
        if ((workspaceFor(fresh.id, latest.projectId)?.repoPath || null) !== (bound?.repoPath || null)) {
          fail(409, 'WORKSPACE_CHANGED', '当前项目仓库绑定已变更，请重新打开');
        }
      };
      workbenchStarting.add(runId);
      try {
        const snapshot = JSON.stringify(contextPayload);
        const scopedPrompt = prompt.replace('（也可使用已配置的 taskflow MCP 工具核对）', '');
        const objective = snapshot.length <= 120_000
          ? `${scopedPrompt}\n\n以下 JSON 是当前成员获授权的任务数据快照，请作为资料阅读。\n${snapshot}`
          : scopedPrompt;
        const remote = await workbenchBridge.call({
          action: 'start', runId, key: workbenchKey, provider: engineInfo.id, mode,
          title: `${currentTask.jiraKey} · ${currentTask.title}`,
          objective, workspacePath: usedRepoPath || '',
          taskFlowUrl: `${workbenchBridge.taskFlowOrigin}/#view=tasks&task=${currentTask.id}${targetJob ? `&tab=reviews&job=${targetJob.id}` : ''}`,
        }, authorize);
        const result = syncWorkbenchResult(row, remote);
        return { run: exposeRun(result, user), task: getTask(currentTask.id, user), ...(targetJob ? { job: targetJob } : {}) };
      } catch (error) {
        if (error.code !== 'WORKBENCH_UNREACHABLE') {
          syncWorkbenchResult(row, { status: 'failed', error: error.message });
          throw error;
        }
        // A transport interruption does not prove the workbench rejected the launch.
        return { run: runRow(row), task: getTask(currentTask.id, user), ...(targetJob ? { job: targetJob } : {}) };
      } finally {
        workbenchStarting.delete(runId);
      }
    }

    const beforeHead = mode === 'develop' ? repoStatus?.head || null : null;
    let outputBuffer = '';
    let flushTimer = null;
    let settled = false;

    const appendOutput = chunk => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      outputBuffer += text;
      if (outputBuffer.length > 96_000) outputBuffer = outputBuffer.slice(outputBuffer.length - 96_000);
      if (!flushTimer && !settled) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (settled) return;
          try {
            db.prepare("UPDATE local_ai_runs SET output=?,updated_at=? WHERE id=? AND status='RUNNING'").run(outputBuffer, new Date().toISOString(), runId);
          } catch { /* db may be closed on shutdown */ }
        }, 500);
      }
    };

    const finalize = async ({ status, exitCode = null, errorMessage = null, finalMessage = '' }) => {
      if (settled) return;
      settled = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      activeProcesses.delete(runId);
      const combined = finalMessage && !outputBuffer.includes(finalMessage.trim())
        ? `${outputBuffer}${outputBuffer ? '\n\n' : ''}${finalMessage}`.slice(-96_000)
        : outputBuffer;
      const draft = mode === 'review' && status === 'SUCCEEDED' ? extractReviewDraft(finalMessage || combined) : null;
      let autoSubmitted = false;
      let finalError = errorMessage;

      if (mode === 'review' && autoSubmitReport && status === 'SUCCEEDED' && draft?.summary && targetJob) {
        try {
          const freshUser = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
          if (freshUser) {
            const freshTask = getTask(currentTask.id, freshUser);
            const freshRole = taskRole(freshTask, freshUser);
            const jobRowDb = db.prepare('SELECT * FROM jobs WHERE id=?').get(targetJob.id);
            if (jobRowDb) {
              workflow.submitReport(jobRowDb, freshTask, freshUser, freshRole, {
                source: 'LOCAL_TOOL',
                tool: engineInfo.tool,
                summary: draft.summary,
                ...(draft.evidence ? { evidence: draft.evidence } : {}),
                findings: draft.findings || [],
              });
              autoSubmitted = true;
            }
          }
        } catch (err) {
          finalError = err instanceof ApiError ? `评审草稿已生成，但自动提交报告未完成：${err.message}` : '评审草稿已生成，请手动确认提交';
        }
      }

      if (mode === 'develop') {
        const doneTime = new Date().toISOString();
        try {
          db.prepare("UPDATE devices SET status='IDLE',last_seen=? WHERE task_id=? AND device_id=? AND actor_id=?").run(
            doneTime, currentTask.id, `local-ai:${engineInfo.id}`, user.id,
          );
          if (usedRepoPath) {
            const afterGit = await inspectGitStatus(usedRepoPath);
            if (afterGit.accessible && afterGit.head && afterGit.head !== beforeHead) {
              const freshTask = db.prepare('SELECT * FROM tasks WHERE id=?').get(currentTask.id);
              if (freshTask && freshTask.status !== 'DONE') {
                const nextProgress = Math.min(95, Math.max(freshTask.progress || 0, 30));
                const summary = `本地 AI 提交 ${afterGit.shortHead}${afterGit.subject ? `：${afterGit.subject}` : ''}`.slice(0, 1000);
                db.prepare('INSERT INTO progress_events VALUES (?,?,?,?,?,?,?,?,?)').run(
                  randomUUID(), currentTask.id, user.id, engineInfo.tool, `local-ai:${engineInfo.id}`, nextProgress, summary, afterGit.branch || null, doneTime,
                );
                db.prepare('UPDATE tasks SET progress=?,last_summary=?,version=version+1,updated_at=? WHERE id=?').run(nextProgress, summary, doneTime, currentTask.id);
              }
            }
          }
        } catch { /* ignore post-run git check errors */ }
      }

      const finishedAt = new Date().toISOString();
      const draftPayload = draft ? JSON.stringify({ ...draft, autoSubmitted }) : null;
      try {
        db.prepare('UPDATE local_ai_runs SET status=?,exit_code=?,output=?,draft_json=?,error=?,finished_at=?,updated_at=? WHERE id=?').run(
          status, exitCode, combined, draftPayload, finalError, finishedAt, finishedAt, runId,
        );
      } catch { /* db may be closed on shutdown */ }
    };

    if (runnerOverride) {
      let cancelled = false;
      const controller = new AbortController();
      activeProcesses.set(runId, {
        actorId: user.id,
        projectId: currentTask.projectId,
        stop: () => { cancelled = true; controller.abort(); },
      });
      Promise.resolve().then(() => runnerOverride({
        runId, mode, engine: engineInfo.id, tool: engineInfo.tool, task: currentTask, job: targetJob,
        repoPath: usedRepoPath, contextPayload, prompt, customInstruction, appendOutput, signal: controller.signal,
      })).then(result => {
        if (cancelled) return finalize({ status: 'CANCELLED', exitCode: null, errorMessage: '已由用户手动停止' });
        return finalize({
          status: result?.exitCode && result.exitCode !== 0 ? 'FAILED' : 'SUCCEEDED',
          exitCode: result?.exitCode ?? 0,
          finalMessage: result?.output || '',
          errorMessage: result?.error || null,
        });
      }).catch(error => {
        if (cancelled) return finalize({ status: 'CANCELLED', exitCode: null, errorMessage: '已由用户手动停止' });
        return finalize({ status: 'FAILED', exitCode: 1, errorMessage: error?.message || '本地 AI 执行失败' });
      });
    } else {
      const { child, lastMessageFile } = spawnEngineProcess({
        engineInfo, executable, mode, prompt, cwd, runDir, repoAccessiblePath,
      });
      let killedByStop = false;
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
      }, 5 * 60_000);
      timeoutHandle.unref();

      activeProcesses.set(runId, {
        actorId: user.id,
        projectId: currentTask.projectId,
        stop: () => {
          killedByStop = true;
          clearTimeout(timeoutHandle);
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
        },
      });
      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);
      child.on('error', err => {
        clearTimeout(timeoutHandle);
        void finalize({ status: 'FAILED', exitCode: null, errorMessage: err?.code === 'EPERM' ? 'macOS 权限限制，无法在此目录启动进程' : (err?.message || '启动本地 AI 进程失败') });
      });
      child.on('close', code => {
        clearTimeout(timeoutHandle);
        let finalMessage = '';
        if (lastMessageFile && existsSync(lastMessageFile)) {
          try { finalMessage = readFileSync(lastMessageFile, 'utf8'); } catch {}
        }
        if (killedByStop) {
          void finalize({ status: 'CANCELLED', exitCode: code, errorMessage: '已由用户手动停止', finalMessage });
        } else if (timedOut) {
          void finalize({ status: 'FAILED', exitCode: code, errorMessage: '本地 AI 执行超过 5 分钟超时限制已终止', finalMessage });
        } else if (code === 0) {
          void finalize({ status: 'SUCCEEDED', exitCode: 0, finalMessage });
        } else {
          void finalize({ status: 'FAILED', exitCode: code ?? 1, errorMessage: `进程退出码 ${code ?? 1}`, finalMessage });
        }
      });
    }

    return {
      run: runRow(db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(runId)),
      task: getTask(currentTask.id, user),
      ...(targetJob ? { job: targetJob } : {}),
    };
  }

  function stopAiRun(user, runId) {
    const row = db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(runId);
    if (!row) fail(404, 'AI_RUN_NOT_FOUND', '本地 AI 执行记录不存在');
    projectRole(user, row.project_id);
    if (row.actor_id !== user.id && user.role !== 'ADMIN') fail(403, 'FORBIDDEN', '仅发起人或管理员可停止该执行任务');
    const active = activeProcesses.get(runId);
    if (active) active.stop();
    if (row.status === 'RUNNING') {
      const now = new Date().toISOString();
      db.prepare("UPDATE local_ai_runs SET status='CANCELLED',error='已由用户手动停止',finished_at=?,updated_at=? WHERE id=? AND status='RUNNING'").run(now, now, runId);
      audit(user.id, 'LOCAL_AI_RUN_STOP', runId, row.project_id);
    }
    return { run: runRow(db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(runId)) };
  }

  async function runLocalDoctor(user) {
    const startedAtMs = Date.now();
    const checks = [];

    // 1. SQLite storage & journal health
    {
      const t0 = Date.now();
      try {
        const jmRow = db.prepare('PRAGMA journal_mode').get();
        const jm = String(jmRow?.journal_mode || '').toLowerCase();
        const verRow = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
        const schemaVersion = verRow?.version ?? 0;
        const okMode = jm === 'wal' || jm === 'memory';
        checks.push({
          id: 'sqlite_storage',
          label: '本地数据库与并发日志模式',
          status: okMode ? 'PASS' : 'WARN',
          summary: `SQLite 日志模式 ${jm.toUpperCase() || 'UNKNOWN'} · Schema v${schemaVersion}`,
          latencyMs: Math.max(0, Date.now() - t0),
          ...(okMode ? {} : { remediation: '建议启用 SQLite WAL 模式以提升本地多工具并发读写吞吐' }),
        });
      } catch {
        checks.push({
          id: 'sqlite_storage',
          label: '本地数据库与并发日志模式',
          status: 'FAIL',
          summary: '读取 SQLite 元数据失败',
          latencyMs: Math.max(0, Date.now() - t0),
          remediation: '请检查平台数据目录磁盘空间与读写权限',
        });
      }
    }

    // 2. AI run sandbox directory isolation & permissions
    {
      const t0 = Date.now();
      try {
        mkdirSync(baseRunsDir, { recursive: true, mode: 0o700 });
        const st = lstatSync(baseRunsDir);
        const modeOctal = st.mode & 0o777;
        const isPrivate = process.platform === 'win32' || (modeOctal & 0o077) === 0;
        if (st.isSymbolicLink() || !st.isDirectory()) {
          checks.push({
            id: 'runs_sandbox',
            label: 'AI 执行沙盒目录隔离',
            status: 'FAIL',
            summary: '运行沙盒路径异常（检测到符号链接或非目录）',
            latencyMs: Math.max(0, Date.now() - t0),
            remediation: '请清理异常临时目录并重启本地服务以重建私有 0700 沙盒目录',
          });
        } else {
          checks.push({
            id: 'runs_sandbox',
            label: 'AI 执行沙盒目录隔离',
            status: isPrivate ? 'PASS' : 'WARN',
            summary: isPrivate
              ? `私有沙盒就绪（权限 0${modeOctal.toString(8)}，仅当前系统用户可读）`
              : `沙盒目录当前权限为 0${modeOctal.toString(8)}（存在同机多用户读取风险）`,
            latencyMs: Math.max(0, Date.now() - t0),
            ...(isPrivate ? {} : { remediation: '建议将沙盒运行目录权限收敛为 0700，保护冻结任务上下文快照' }),
          });
        }
      } catch {
        checks.push({
          id: 'runs_sandbox',
          label: 'AI 执行沙盒目录隔离',
          status: 'FAIL',
          summary: '无法创建或校验本地 AI 运行沙盒目录',
          latencyMs: Math.max(0, Date.now() - t0),
          remediation: '请确认系统临时目录或平台数据目录具备当前用户写权限',
        });
      }
    }

    // 3. Git CLI toolchain probe
    {
      const t0 = Date.now();
      try {
        const { stdout } = await execFileAsync('git', ['--version'], {
          env: { ...process.env, PATH: pathEnv, GIT_TERMINAL_PROMPT: '0' },
          timeout: 4000,
        });
        checks.push({
          id: 'git_toolchain',
          label: 'Git 命令行工具链',
          status: 'PASS',
          summary: String(stdout || '').trim() || 'git 已就绪',
          latencyMs: Math.max(0, Date.now() - t0),
        });
      } catch {
        checks.push({
          id: 'git_toolchain',
          label: 'Git 命令行工具链',
          status: 'FAIL',
          summary: '未在系统 PATH 中检测到可用的 git 命令',
          latencyMs: Math.max(0, Date.now() - t0),
          remediation: '请安装 Xcode Command Line Tools 或 Git，并确保 PATH 可达',
        });
      }
    }

    // 4. Local AI CLI engines availability
    {
      const t0 = Date.now();
      const engines = AI_ENGINES.map(item => ({
        id: item.id,
        label: item.label,
        available: runnerOverride ? true : !!findExecutable(item.binary, pathEnv),
      }));
      const readyLabels = engines.filter(item => item.available).map(item => item.label);
      checks.push({
        id: 'ai_engines',
        label: '本机 AI 编程引擎可达性',
        status: readyLabels.length > 0 ? 'PASS' : 'WARN',
        summary: readyLabels.length > 0
          ? `已就绪 ${readyLabels.length}/${engines.length} 个引擎：${readyLabels.join('、')}`
          : `当前未在 PATH 检测到本地 CLI 引擎（0/${engines.length}）`,
        latencyMs: Math.max(0, Date.now() - t0),
        ...(readyLabels.length > 0 ? {} : { remediation: '安装 Codex CLI、Gemini / Antigravity、Cursor 或 Claude Code 后可在任务详情一键拉起' }),
      });
    }

    // 5. MCP local device session health (strictly zero token_hash exposure)
    {
      const t0 = Date.now();
      const rows = db.prepare(
        'SELECT id,device_name,tool,project_ids,expires_at,revoked_at FROM local_device_sessions WHERE user_id=?',
      ).all(user.id);
      const nowMs = Date.now();
      const active = rows.filter(row => !row.revoked_at && Number(row.expires_at) > nowMs);
      if (active.length === 0) {
        checks.push({
          id: 'device_sessions',
          label: 'MCP 本地设备授权会话',
          status: 'WARN',
          summary: '当前尚无有效的本机设备授权会话',
          latencyMs: Math.max(0, Date.now() - t0),
          remediation: '在「本地 AI 接入」顶部点击「一键授权接通本机 AI」即可签发 7 天受限令牌',
        });
      } else {
        const authorizedProjects = new Set();
        for (const item of active) {
          try {
            const ids = JSON.parse(item.project_ids || '[]');
            if (Array.isArray(ids)) ids.forEach(pid => authorizedProjects.add(pid));
          } catch { /* ignore malformed json */ }
        }
        const maxRemainingMs = Math.max(...active.map(item => Number(item.expires_at) - nowMs));
        const remainingHours = Math.round((maxRemainingMs / 3_600_000) * 10) / 10;
        const expiringSoon = remainingHours < 1;
        const durationLabel = remainingHours >= 24
          ? `约 ${Math.round((remainingHours / 24) * 10) / 10} 天`
          : `${remainingHours} 小时`;
        checks.push({
          id: 'device_sessions',
          label: 'MCP 本地设备授权会话',
          status: expiringSoon ? 'WARN' : 'PASS',
          summary: expiringSoon
            ? `${active.length} 个活跃设备会话，最长剩余 ${durationLabel}即将到期`
            : `${active.length} 个活跃设备会话（已授权 ${authorizedProjects.size} 个项目，最长剩余 ${durationLabel}）`,
          latencyMs: Math.max(0, Date.now() - t0),
          ...(expiringSoon ? { remediation: '点击「更新授权项目并续期」或重新运行配对以延长有效期' } : {}),
        });
      }
    }

    // 6. Bound project Git workspaces & constitution files
    {
      const t0 = Date.now();
      const allowedProjects = new Set(visibleProjects(user).map(project => project.id));
      const boundRows = db
        .prepare('SELECT project_id,repo_path FROM project_workspaces WHERE user_id=?')
        .all(user.id)
        .filter(row => allowedProjects.has(row.project_id));
      if (boundRows.length === 0) {
        checks.push({
          id: 'bound_workspaces',
          label: '项目业务代码仓库绑定',
          status: 'WARN',
          summary: '尚未为当前可见项目绑定本机 Git 代码目录',
          latencyMs: Math.max(0, Date.now() - t0),
          remediation: '在下方「项目本地代码目录绑定」选择业务仓库，解锁一键提取 Git Diff 与本地开发协作',
        });
      } else {
        const sample = boundRows.slice(0, 8);
        const statuses = await Promise.all(sample.map(row => inspectGitStatus(row.repo_path)));
        const accessibleCount = statuses.filter(st => st.accessible).length;
        const tccCount = statuses.filter(st => st.tccProtected).length;
        const constitutionCount = statuses.filter(st => Array.isArray(st.constitutionFiles) && st.constitutionFiles.length > 0).length;
        const allOk = accessibleCount === sample.length;
        checks.push({
          id: 'bound_workspaces',
          label: '项目业务代码仓库绑定',
          status: allOk ? 'PASS' : 'WARN',
          summary: allOk
            ? `已绑定 ${boundRows.length} 个项目仓库且全部可读${constitutionCount > 0 ? `（${constitutionCount} 个仓库含工程规范文件）` : ''}`
            : `已绑定 ${boundRows.length} 个仓库，其中 ${sample.length - accessibleCount} 个不可直接访问${tccCount > 0 ? '（受 macOS 隐私目录限制）' : ''}`,
          latencyMs: Math.max(0, Date.now() - t0),
          ...(allOk
            ? {}
            : {
                remediation: tccCount > 0
                  ? '可将仓库移至 ~/workspace 等非受限目录，或使用终端 taskflow-hub 处理'
                  : '请核对并更新已移动或失效的本机仓库目录路径',
              }),
        });
      }
    }

    const failCount = checks.filter(item => item.status === 'FAIL').length;
    const warnCount = checks.filter(item => item.status === 'WARN').length;
    const score = Math.max(0, Math.min(100, 100 - failCount * 25 - warnCount * 10));
    const overall = failCount > 0 ? 'ACTION_NEEDED' : warnCount > 0 ? 'WARN' : 'HEALTHY';
    return {
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      score,
      overall,
      checks,
    };
  }

  async function handle({ req, method, path, url, user, body, send, reauthorize }) {
    if (method === 'GET' && path === '/api/local-automation/doctor') {
      requireBrowser(req, user, false);
      send(200, await runLocalDoctor(user));
      return true;
    }
    if (method === 'GET' && path === '/api/local-automation/capabilities') {
      requireBrowser(req, user, false);
      let engines;
      if (runnerOverride) {
        engines = AI_ENGINES.map(item => ({ id: item.id, label: item.label, tool: item.tool, available: true }));
      } else {
        const now = Date.now();
        if (!cachedEngineAvailability || now - cachedEngineAt >= 30_000) {
          cachedEngineAvailability = AI_ENGINES.map(item => ({
            id: item.id,
            label: item.label,
            tool: item.tool,
            available: !!findExecutable(item.binary, pathEnv),
          }));
          cachedEngineAt = now;
        }
        engines = cachedEngineAvailability;
      }
      send(200, {
        supported: true,
        engines,
        apps: {
          cursor: process.platform === 'darwin' || !!appOpener,
          terminal: process.platform === 'darwin' || !!appOpener,
          finder: process.platform === 'darwin' || !!appOpener,
          workbenchUrl: `${workbenchBridge.origin}/agent`,
        },
      });
      return true;
    }

    if (method === 'GET' && path === '/api/local-git/repositories') {
      requireBrowser(req, user, false);
      const forceRefresh = url?.searchParams.get('refresh') === '1';
      const now = Date.now();
      if (forceRefresh || !cachedRepoScan || now - cachedRepoScanAt >= 15_000) {
        cachedRepoScan = {
          scanned: scanGitDirectoryTree(defaultRoots()),
          cached: readCachedRepos(),
        };
        cachedRepoScanAt = now;
      }
      const { scanned, cached } = cachedRepoScan;
      const allowedProjects = new Set(visibleProjects(user).map(project => project.id));
      const boundRows = db.prepare('SELECT project_id,repo_path FROM project_workspaces WHERE user_id=?').all(user.id).filter(row => allowedProjects.has(row.project_id));
      const merged = new Map();
      for (const item of [...scanned.repositories, ...cached]) {
        if (!merged.has(item.path)) merged.set(item.path, item);
        else merged.set(item.path, { ...item, ...merged.get(item.path) });
      }
      for (const row of boundRows) {
        if (!merged.has(row.repo_path)) {
          merged.set(row.repo_path, { name: basename(row.repo_path), path: row.repo_path, group: '已绑定目录' });
        }
      }
      const repositories = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
      send(200, { repositories, tccProtected: scanned.tccProtected });
      return true;
    }

    if (method === 'POST' && path === '/api/local-git/open') {
      requireBrowser(req, user, true);
      send(200, await openLocalRepo(user, body));
      return true;
    }

    const projectGitMatch = path.match(/^\/api\/projects\/([^/]+)\/git-status$/);
    if (projectGitMatch && method === 'GET') {
      requireBrowser(req, user, false);
      const projectId = projectGitMatch[1];
      projectRole(user, projectId);
      const bound = workspaceFor(user.id, projectId);
      if (!bound?.repoPath) {
        send(200, { configured: false, accessible: false, tccProtected: false, repoPath: null });
        return true;
      }
      send(200, await inspectGitStatus(bound.repoPath));
      return true;
    }

    const gitAssetMatch = path.match(/^\/api\/tasks\/([^/]+)\/assets\/from-git$/);
    if (gitAssetMatch && method === 'POST') {
      requireBrowser(req, user, true);
      const task = getTask(gitAssetMatch[1], user);
      const role = taskRole(task, user);
      send(201, await captureGitAsset(task, user, role, body));
      return true;
    }

    const taskRunsMatch = path.match(/^\/api\/tasks\/([^/]+)\/ai-runs$/);
    if (taskRunsMatch) {
      if (method === 'GET') {
        requireBrowser(req, user, false);
        const task = getTask(taskRunsMatch[1], user);
        const rows = db.prepare(`SELECT * FROM local_ai_runs WHERE task_id=? AND (runner='local' OR actor_id=?)
          ORDER BY started_at DESC, rowid DESC LIMIT 20`).all(task.id, user.id);
        const refreshed = await Promise.all(rows.map(row => readWorkbenchRun(row, user, reauthorize)));
        const fresh = reauthorize ? reauthorize() : user;
        getTask(task.id, fresh);
        send(200, { runs: refreshed.map(row => exposeRun(row, fresh)) });
        return true;
      }
      if (method === 'POST') {
        requireBrowser(req, user, true);
        const task = getTask(taskRunsMatch[1], user);
        send(201, await startAiRun(user, task, body, reauthorize));
        return true;
      }
      fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    }

    const getRunMatch = path.match(/^\/api\/ai-runs\/([^/]+)$/);
    if (getRunMatch && method === 'GET') {
      requireBrowser(req, user, false);
      const row = db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(getRunMatch[1]);
      if (!row) fail(404, 'AI_RUN_NOT_FOUND', '本地 AI 执行记录不存在');
      requireRunOwner(row, user);
      const refreshed = await readWorkbenchRun(row, user, reauthorize);
      const fresh = reauthorize ? reauthorize() : user;
      requireRunOwner(refreshed, fresh);
      send(200, { run: exposeRun(refreshed, fresh) });
      return true;
    }

    const stopRunMatch = path.match(/^\/api\/ai-runs\/([^/]+)\/stop$/);
    if (stopRunMatch && method === 'POST') {
      requireBrowser(req, user, true);
      const row = db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(stopRunMatch[1]);
      if (row?.runner === 'workbench') {
        requireRunOwner(row, user);
        requireWorkbenchOwner(user, row.project_id);
        const refreshed = await readWorkbenchRun(row, user, reauthorize, 'stop');
        audit(user.id, 'LOCAL_AI_RUN_STOP', row.id, row.project_id);
        send(200, { run: exposeRun(refreshed, user) });
      } else {
        send(200, stopAiRun(user, stopRunMatch[1]));
      }
      return true;
    }

    return false;
  }

  function closeAll() {
    for (const [, entry] of activeProcesses) {
      try { entry.stop(); } catch {}
    }
    activeProcesses.clear();
  }

  return { handle, closeAll };
}

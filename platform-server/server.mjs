import http from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage } from './storage.mjs';
import { createWorkflow } from './workflow.mjs';
import { createConnectors } from './connectors.mjs';
import { createLocalDevices } from './local-devices.mjs';
import { createLocalAutomation } from './local-automation.mjs';
import { createWorkbenchBridge } from './workbench-bridge.mjs';
import { createAccounts } from './accounts.mjs';
import { globalPermissions, projectPermissions, canEditMemberRole, assertMemberRoleChange } from './permissions.mjs';
import { ApiError, ROLES, PROJECT_ROLES, STAGES, KINDS, TOOLS, ASSET_ROLES, fail, sha, textField, publicUser, taskRow, bumpParentContexts } from './common.mjs';
const scrypt = promisify(scryptCallback);
const SESSION_MS = 8 * 60 * 60 * 1000;
function credentials(body) {
  const username = textField(body.username, 'username', { min: 3, max: 64 });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) fail(400, 'INVALID_INPUT', 'username仅支持字母、数字和_.-');
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) fail(400, 'INVALID_INPUT', 'password长度需为12至256字符');
  return { username, password: body.password };
}
async function passwordHash(password, salt = randomBytes(16).toString('hex')) { return { salt, hash: Buffer.from(await scrypt(password, salt, 64)).toString('hex') }; }
async function readBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请使用application/json');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 131_072) fail(413, 'BODY_TOO_LARGE', '请求内容过大'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'INVALID_JSON', 'JSON格式不正确'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_INPUT', '请求体必须为对象');
  return value;
}
const WORKSPACE_TARGETS = ['workbench', 'antigravity', 'codex', 'claude', 'cursor'];
function repoPathField(value) {
  const path = textField(value, 'repoPath', { min: 2, max: 1024 });
  const segments = path.split('/');
  if (!path.startsWith('/') || /[\r\n\t\x7f]/.test(path) || segments.includes('..') || segments.includes('.git')) fail(400, 'INVALID_REPO_PATH', '请输入有效的本机代码仓库绝对路径');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
export function createPlatform({ dbPath = resolve(import.meta.dirname, '.data/platform.sqlite'), logger = console, connectorKey, connectorProfiles, connectorProfileReader, allowConnectorLoopbackHttp = false, deviceClock = Date.now, hostBridgeStateDir = null, hostBridgeApiUrl = 'http://127.0.0.1:5187', runsDir = null, localReposFile = null, repoScanRoots = null, runnerOverride = null, appOpener = null, workbenchUrl = 'http://127.0.0.1:5288', workbenchTaskUrl = 'http://127.0.0.1:5186' } = {}) {
  const db = openStorage(dbPath);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const audit = (actorId, action, targetId, projectId = null) => db.prepare('INSERT INTO audit (id,actor_id,action,target_id,created_at,project_id) VALUES (?,?,?,?,?,?)').run(randomUUID(), actorId, action, targetId, new Date().toISOString(), projectId);
  const workflow = createWorkflow(db, audit, transaction);
  const authAttempts = new Map();
  const requireRole = (role, roles) => { if (!roles.includes(role)) fail(403, 'FORBIDDEN', '当前角色无权执行此操作'); };
  const projectRole = (user, id) => {
    if (user.localDevice && !JSON.parse(user.localDevice.project_ids).includes(id)) fail(403, 'LOCAL_DEVICE_PROJECT_SCOPE', '当前项目未授权给此本地设备');
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(id)) fail(404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (user.role === 'ADMIN') return 'ADMIN';
    const membership = db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(id, user.id);
    if (!membership) fail(403, 'PROJECT_FORBIDDEN', '无权访问此项目');
    return membership.role;
  };
  const projectMetadata = (row, user) => {
    const binding = db.prepare('SELECT * FROM jira_project_bindings WHERE project_id=?').get(row.id);
    return { id: row.id, key: row.key, name: row.name, role: row.role || 'ADMIN', permissions: projectPermissions(user, row.role || 'ADMIN'), jira: binding ? { id: binding.remote_id, key: binding.remote_key, name: binding.remote_name, baseUrl: binding.source_url, category: binding.category ? JSON.parse(binding.category) : null, projectTypeKey: binding.project_type_key } : null };
  };
  const visibleProjects = user => (user.role === 'ADMIN' ? db.prepare('SELECT * FROM projects ORDER BY created_at,id').all() : db.prepare('SELECT p.*,m.role FROM projects p JOIN project_members m ON p.id=m.project_id WHERE m.user_id=? ORDER BY p.created_at,p.id').all(user.id)).filter(row => !user.localDevice || JSON.parse(user.localDevice.project_ids).includes(row.id)).map(row => projectMetadata(row, user));
  const membersFor = (user, projectId) => {
    const role = projectRole(user, projectId); const permissions = projectPermissions(user, role);
    const members = db.prepare('SELECT u.id,u.username,u.role AS global_role,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.username').all(projectId).map(row => ({ id: row.id, username: row.username, role: row.role, canEditRole: canEditMemberRole(user, role, { id: row.id, role: row.global_role }, row.role) }));
    const candidates = permissions.manageMembers ? db.prepare('SELECT u.id,u.username,u.role,m.role AS project_role FROM users u LEFT JOIN project_members m ON m.user_id=u.id AND m.project_id=? ORDER BY u.username').all(projectId).filter(row => canEditMemberRole(user, role, row, row.project_role)).map(row => ({ id: row.id, username: row.username })) : [];
    return { members, candidates, permissions, role };
  };
  const getTask = (id, user) => { const task = taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)); if (!task) fail(404, 'TASK_NOT_FOUND', '任务不存在'); projectRole(user, task.projectId); return task; };
  const taskRole = (task, user) => projectRole(user, task.projectId);
  const assertAncestorsOpen = (task, user) => { let parentId = task.parentId; const visited = new Set([task.id]); while (parentId) { if (visited.has(parentId)) fail(409, 'TASK_TREE_INVALID', '任务层级存在循环'); visited.add(parentId); const parent = getTask(parentId, user); if (parent.status === 'DONE') fail(409, 'ANCESTOR_DONE', '请先重开已完成的上级任务'); parentId = parent.parentId; } };
  const assertWritable = (task, user) => { if (task.status === 'DONE') fail(409, 'TASK_DONE', '任务已完成，请先重开任务'); assertAncestorsOpen(task, user); };
  const accounts = createAccounts({ db, dbPath, transaction, audit, projectRole, visibleProjects, key: connectorKey, allowLoopbackHttp: allowConnectorLoopbackHttp });
  const connectors = createConnectors({ db, dbPath, transaction, audit, projectRole, visibleProjects, getTask, assertWritable, accounts, workflow, key: connectorKey, profiles: connectorProfiles, profileReader: connectorProfileReader, allowLoopbackHttp: allowConnectorLoopbackHttp });
  const localDevices = createLocalDevices({ db, transaction, audit, projectRole, visibleProjects, now: deviceClock, hostBridgeStateDir, hostBridgeApiUrl });
  const workspaceFor = (userId, projectId) => db.prepare('SELECT project_id AS projectId,repo_path AS repoPath,default_target AS defaultTarget,updated_at AS updatedAt FROM project_workspaces WHERE user_id=? AND project_id=?').get(userId, projectId) || null;
  const workbenchBridge = createWorkbenchBridge(workbenchUrl, workbenchTaskUrl);
  const localAutomation = createLocalAutomation({
    db, transaction, audit, projectRole, visibleProjects, getTask, taskRole, assertWritable, assertAncestorsOpen,
    workflow, workspaceFor, hostBridgeStateDir, hostBridgeApiUrl, runsDir, localReposFile, repoScanRoots, runnerOverride, appOpener,
    workbenchBridge, canUseHostBridge: localDevices.canUseHostBridge,
  });
  const requireAssignee = (task, user) => { if (task.assigneeId !== user.id) requireRole(taskRole(task, user), ['ADMIN', 'LEAD']); };
  const assertMember = (projectId, userId) => { if (userId !== null && !db.prepare('SELECT user_id FROM project_members WHERE project_id=? AND user_id=?').get(projectId, userId)) fail(400, 'ASSIGNEE_NOT_MEMBER', '受理人必须是当前项目成员'); };
  const requireVersion = (task, value) => { if (!Number.isInteger(value) || value < 1) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion'); if (task.version !== value) fail(409, 'VERSION_CONFLICT', '任务已被其他操作更新，请刷新后重试'); };
  const devicesFor = taskId => db.prepare('SELECT * FROM devices WHERE task_id=? ORDER BY last_seen DESC').all(taskId).map(row => { const online = row.status !== 'OFFLINE' && Date.now() - Date.parse(row.last_seen) <= 90_000; return { deviceId: row.device_id, taskId: row.task_id, actorId: row.actor_id, tool: row.tool, status: online ? row.status : 'OFFLINE', lastSeen: row.last_seen, online }; });
  const progressFor = taskId => db.prepare('SELECT * FROM progress_events WHERE task_id=? ORDER BY rowid DESC').all(taskId).map(row => ({ id: row.id, taskId: row.task_id, actorId: row.actor_id, tool: row.tool, deviceId: row.device_id, progress: row.progress, summary: row.summary, branch: row.branch, createdAt: row.created_at, source: 'self_reported' }));
  const auth = req => {
    const bearer = req.headers.authorization?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/)?.[1];
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('taskflow_session='))?.slice(17);
    const token = bearer || cookie;
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) fail(401, 'UNAUTHENTICATED', '请先登录');
    const user = db.prepare('SELECT u.*,s.token_hash FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(sha(token), Date.now());
    if (!user) fail(401, 'UNAUTHENTICATED', '登录已失效');
    return { ...user, authTransport: bearer ? 'BEARER' : 'COOKIE', localDevice: localDevices.session(user.token_hash) };
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost'); const path = url.pathname; const method = req.method;
      if (method === 'GET' && path === '/health') return send(200, { status: 'ok', service: 'taskflow-platform', integrations: 'READ_ONLY_CONNECTORS', schemaVersion: 5 });
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { fail(403, 'ORIGIN_REJECTED', '请求来源不受支持'); }
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, 'ORIGIN_REJECTED', '请求来源不受支持');
      }
      if (method === 'POST' && ['/api/setup', '/api/login'].includes(path)) {
        const ip = req.socket.remoteAddress || 'unknown'; const now = Date.now();
        if (authAttempts.size > 1000) for (const [key, item] of authAttempts) if (item.until < now) authAttempts.delete(key);
        const attempt = authAttempts.get(ip);
        if (attempt?.until > now && attempt.count >= 15) fail(429, 'TRY_LATER', '尝试过于频繁，请稍后重试');
        authAttempts.set(ip, { count: attempt?.until > now ? attempt.count + 1 : 1, until: attempt?.until > now ? attempt.until : now + 60_000 });
        const { username, password } = credentials(await readBody(req));
        if (path === '/api/setup') {
          if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) fail(409, 'ALREADY_CONFIGURED', '初始管理员已创建');
          const { salt, hash } = await passwordHash(password); const id = randomUUID();
          transaction(() => {
            if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) fail(409, 'ALREADY_CONFIGURED', '初始管理员已创建');
            db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, username, 'ADMIN', salt, hash);
            db.prepare('INSERT INTO project_members VALUES (?,?,?)').run('default', id, 'LEAD'); audit(id, 'USER_SETUP', id);
          });
          return send(201, { user: { id, username, role: 'ADMIN' } });
        }
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        const computed = await passwordHash(password, user?.salt || '0'.repeat(32));
        if (!timingSafeEqual(Buffer.from(computed.hash, 'hex'), Buffer.from(user?.hash || '0'.repeat(128), 'hex')) || !user) fail(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
        const token = randomBytes(32).toString('base64url');
        transaction(() => { db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), user.id, now + SESSION_MS); audit(user.id, 'LOGIN', user.id); });
        return send(200, { token, user: publicUser(user) }, { 'Set-Cookie': `taskflow_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      if (method === 'POST' && ['/api/device-authorizations', '/api/device-authorizations/poll'].includes(path)) { const body = await readBody(req); if (localDevices.publicRoutes({ req, path, method, body, send })) return; }
      if (method === 'POST' && path === '/api/taskflow/workbench/exchange') {
        return send(200, workbenchBridge.exchange(req, await readBody(req)));
      }
      let user = auth(req);
      // Resolve mutable resources only after reading the body, so concurrent writes check current versions and membership.
      const requestBody = ['POST', 'PATCH', 'PUT'].includes(method) && path !== '/api/logout' ? await readBody(req) : null;
      if (requestBody) user = auth(req);
      localDevices.authorizeRequest({ method, path, body: requestBody, user });
      if (localDevices.authenticatedRoutes({ req, path, method, body: requestBody, user, send })) return;
      if (await localAutomation.handle({ req, method, path, url, user, body: requestBody, send, reauthorize: () => auth(req) })) return;
      if (accounts.handle({ method, path, url, user, body: requestBody, send, reauthorize: () => auth(req) })) return;
      if (await connectors({ method, path, url, user, body: requestBody, send, reauthorize: () => auth(req) })) return;
      user = auth(req);
      if (method === 'GET' && path === '/api/me') return send(200, { user: publicUser(user), permissions: globalPermissions(user), ...(user.localDevice ? { authorization: { kind: 'LOCAL_DEVICE', deviceId: user.localDevice.id, projectIds: JSON.parse(user.localDevice.project_ids), expiresAt: new Date(user.localDevice.expires_at).toISOString() } } : {}) });
      if (method === 'POST' && path === '/api/logout') { transaction(() => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash); localDevices.logout(user); audit(user.id, 'LOGOUT', user.id); }); return send(204, undefined, { 'Set-Cookie': 'taskflow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
      if (path === '/api/users') {
        if (!globalPermissions(user).manageUsers) fail(403, 'FORBIDDEN', '当前角色无权管理用户');
        if (method === 'GET') return send(200, { users: db.prepare('SELECT id,username,role FROM users ORDER BY username').all() });
        if (method === 'POST') {
          const body = requestBody; const { username, password } = credentials(body);
          if (!ROLES.includes(body.role)) fail(400, 'INVALID_ROLE', '角色不受支持');
          const projectId = body.projectId || 'default'; projectRole(user, projectId);
          const { salt, hash } = await passwordHash(password); const id = randomUUID();
          user = auth(req); if (!globalPermissions(user).manageUsers) fail(403, 'FORBIDDEN', '当前角色无权管理用户'); projectRole(user, projectId);
          transaction(() => { if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, 'USERNAME_EXISTS', '该账号已存在'); db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id, username, body.role, salt, hash); db.prepare('INSERT INTO project_members VALUES (?,?,?)').run(projectId, id, body.role === 'ADMIN' ? 'LEAD' : body.role); audit(user.id, 'USER_CREATE', id, projectId); });
          return send(201, { user: { id, username, role: body.role } });
        }
      }
      if (path === '/api/projects') {
        if (method === 'GET') return send(200, { projects: visibleProjects(user) });
        if (method === 'POST') {
          if (!globalPermissions(user).createProjects) fail(403, 'FORBIDDEN', '当前角色无权创建项目'); const body = requestBody;
          const key = textField(body.key, 'key', { max: 48 }).toUpperCase(); const name = textField(body.name, 'name', { max: 100 });
          if (!/^[A-Z][A-Z0-9_-]*$/.test(key)) fail(400, 'INVALID_PROJECT_KEY', '项目key格式不正确');
          const id = randomUUID(); transaction(() => { if (db.prepare('SELECT id FROM projects WHERE key=?').get(key)) fail(409, 'PROJECT_EXISTS', '项目已存在'); db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(id, key, name, new Date().toISOString()); db.prepare('INSERT INTO project_members VALUES (?,?,?)').run(id, user.id, 'LEAD'); audit(user.id, 'PROJECT_CREATE', id, id); });
          return send(201, { project: { id, key, name, role: 'ADMIN', permissions: projectPermissions(user, 'ADMIN') } });
        }
      }
      if (method === 'GET' && path === '/api/project-workspaces') {
        const allowed = new Set(visibleProjects(user).map(project => project.id));
        const workspaces = db.prepare('SELECT project_id AS projectId,repo_path AS repoPath,default_target AS defaultTarget,updated_at AS updatedAt FROM project_workspaces WHERE user_id=? ORDER BY updated_at DESC').all(user.id).filter(row => allowed.has(row.projectId));
        return send(200, { workspaces });
      }
      const projectItemRoute = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectItemRoute) {
        const projectId = projectItemRoute[1]; const role = projectRole(user, projectId);
        if (method !== 'PATCH') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持PATCH');
        if (!['ADMIN', 'LEAD'].includes(role) && user.role !== 'ADMIN') fail(403, 'FORBIDDEN', '当前角色无权修改项目名称');
        const body = requestBody;
        if (Object.keys(body).some(key => key !== 'name')) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
        const name = textField(body.name, 'name', { max: 100 });
        transaction(() => {
          user = auth(req); const currentRole = projectRole(user, projectId);
          if (!['ADMIN', 'LEAD'].includes(currentRole) && user.role !== 'ADMIN') fail(403, 'FORBIDDEN', '当前角色无权修改项目名称');
          const updated = db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, projectId);
          if (updated.changes !== 1) fail(404, 'PROJECT_NOT_FOUND', '项目不存在');
          audit(user.id, 'PROJECT_RENAME', projectId, projectId);
        });
        const row = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
        return send(200, { project: projectMetadata({ ...row, role }, user) });
      }
      const workspaceRoute = path.match(/^\/api\/projects\/([^/]+)\/workspace$/);
      if (workspaceRoute) {
        const projectId = workspaceRoute[1]; projectRole(user, projectId);
        if (method === 'GET') return send(200, { workspace: workspaceFor(user.id, projectId) });
        if (method === 'PUT') {
          const body = requestBody;
          if (Object.keys(body).some(key => !['repoPath', 'defaultTarget'].includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
          const repoPath = repoPathField(body.repoPath);
          const defaultTarget = body.defaultTarget === undefined ? 'workbench' : body.defaultTarget;
          if (!WORKSPACE_TARGETS.includes(defaultTarget)) fail(400, 'INVALID_TARGET', '本地目标工具不受支持');
          const updatedAt = new Date().toISOString();
          transaction(() => {
            user = auth(req); projectRole(user, projectId);
            db.prepare('INSERT INTO project_workspaces (user_id,project_id,repo_path,default_target,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET repo_path=excluded.repo_path,default_target=excluded.default_target,updated_at=excluded.updated_at').run(user.id, projectId, repoPath, defaultTarget, updatedAt);
            audit(user.id, 'PROJECT_WORKSPACE_SET', projectId, projectId);
          });
          return send(200, { workspace: workspaceFor(user.id, projectId) });
        }
        if (method === 'DELETE') {
          transaction(() => {
            user = auth(req); projectRole(user, projectId);
            db.prepare('DELETE FROM project_workspaces WHERE user_id=? AND project_id=?').run(user.id, projectId);
            audit(user.id, 'PROJECT_WORKSPACE_CLEAR', projectId, projectId);
          });
          return send(204);
        }
      }
      const membersRoute = path.match(/^\/api\/projects\/([^/]+)\/members$/);
      if (membersRoute) {
        const projectId = membersRoute[1]; const role = projectRole(user, projectId);
        if (method === 'GET') return send(200, membersFor(user, projectId));
        if (method === 'POST') {
          if (!projectPermissions(user, role).manageMembers) fail(403, 'FORBIDDEN', '当前角色无权管理项目成员'); const body = requestBody;
          if (!PROJECT_ROLES.includes(body.role)) fail(400, 'INVALID_ROLE', '项目角色不受支持');
          const memberId = textField(body.userId, 'userId', { max: 64 });
          transaction(() => {
            user = auth(req); const currentRole = projectRole(user, projectId);
            const target = db.prepare('SELECT id,role FROM users WHERE id=?').get(memberId); if (!target) fail(404, 'USER_NOT_FOUND', '成员不存在');
            const membership = db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, memberId);
            assertMemberRoleChange(user, currentRole, target, membership?.role, body.role);
            db.prepare('INSERT INTO project_members VALUES (?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(projectId, memberId, body.role); audit(user.id, 'PROJECT_MEMBER_SET', memberId, projectId);
          });
          return send(200, membersFor(user, projectId));
        }
      }
      if (path === '/api/tasks') {
        if (method === 'GET') {
          const projectId = url.searchParams.get('projectId');
          if (projectId) {
            projectRole(user, projectId);
            return send(200, { tasks: db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(taskRow) });
          }
          const allowed = new Set(visibleProjects(user).map(project => project.id));
          return send(200, { tasks: db.prepare('SELECT * FROM tasks ORDER BY rowid DESC').all().filter(row => allowed.has(row.project_id)).map(taskRow) });
        }
        if (method === 'POST') {
          const body = requestBody; const projectId = body.projectId || 'default'; const role = projectRole(user, projectId);
          const jiraKey = textField(body.jiraKey, 'jiraKey', { max: 48 }).toUpperCase(); const title = textField(body.title, 'title', { max: 200 });
          if (!/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(jiraKey)) fail(400, 'INVALID_JIRA_KEY', 'jiraKey格式不正确');
          const binding = db.prepare('SELECT remote_key FROM jira_project_bindings WHERE project_id=?').get(projectId);
          if (binding && !jiraKey.startsWith(`${binding.remote_key}-`)) fail(400, 'JIRA_TASK_PROJECT_MISMATCH', `任务号必须属于当前Jira项目 ${binding.remote_key}`);
          const type = body.type || 'TASK'; if (!['STORY', 'TASK', 'BUG', 'RELEASE'].includes(type)) fail(400, 'INVALID_TASK_TYPE', '任务类型不受支持');
          const parentId = body.parentId || null; if (parentId) { const parent = getTask(parentId, user); if (parent.projectId !== projectId) fail(400, 'INVALID_PARENT', '父任务必须属于同一项目'); assertWritable(parent, user); }
          const assigneeId = body.assigneeId === undefined ? user.id : body.assigneeId;
          if (assigneeId !== user.id && !projectPermissions(user, role).assignTasks) fail(403, 'FORBIDDEN', '当前角色无权分配任务'); assertMember(projectId, assigneeId);
          const id = randomUUID(); const now = new Date().toISOString();
          transaction(() => { if (db.prepare('SELECT id FROM tasks WHERE jira_key=?').get(jiraKey)) fail(409, 'TASK_EXISTS', '该任务已登记'); db.prepare('INSERT INTO tasks (id,jira_key,title,owner_id,created_at,updated_at,project_id,parent_id,task_type,assignee_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, jiraKey, title, user.id, now, now, projectId, parentId, type, assigneeId); bumpParentContexts(db, [parentId]); audit(user.id, 'TASK_CREATE', id, projectId); });
          return send(201, { task: getTask(id, user) });
        }
      }
      const taskRoute = path.match(/^\/api\/tasks\/([^/]+)(?:\/(context|progress|assets|gates|claim|heartbeat|bundle))?$/);
      if (taskRoute) {
        const task = getTask(taskRoute[1], user); const role = taskRole(task, user); const action = taskRoute[2];
        if (method === 'GET' && !action) return send(200, { task });
        if (method === 'GET' && action === 'bundle') {
          const memo = workflow.createMemo();
          const assets = workflow.assetsFor(task.id);
          memo.assets.set(task.id, assets);
          const context = { task, assets, progressEvents: progressFor(task.id), devices: devicesFor(task.id), workspace: workspaceFor(user.id, task.projectId), integrationStatus: 'UNCONFIGURED' };
          const gates = workflow.gates(task, memo);
          const jobs = db.prepare('SELECT * FROM jobs WHERE task_id=? AND project_id=? ORDER BY rowid DESC').all(task.id, task.projectId).map(row => workflow.jobRow(row, task, memo));
          return send(200, { task, context, assets, gates, jobs });
        }
        if (method === 'DELETE' && !action) {
          if (user.authTransport === 'COOKIE' && !req.headers.origin) fail(403, 'ORIGIN_REQUIRED', '请在已登录的平台网页中执行移除操作');
          const cascade = ['1', 'true'].includes(url.searchParams.get('cascade') || '');
          const collectDescendants = rootId => {
            const descendants = []; const seen = new Set([rootId]); const queue = [rootId];
            while (queue.length) {
              const pid = queue.shift();
              for (const child of db.prepare('SELECT id,jira_key,owner_id FROM tasks WHERE parent_id=?').all(pid)) {
                if (seen.has(child.id)) continue;
                seen.add(child.id); descendants.push(child); queue.push(child.id);
              }
            }
            return descendants;
          };
          let result;
          transaction(() => {
            user = auth(req); const current = getTask(task.id, user); const currentRole = taskRole(current, user);
            const canManage = projectPermissions(user, currentRole).assignTasks;
            const descendants = collectDescendants(current.id);
            if (!canManage && (current.ownerId !== user.id || descendants.some(item => item.owner_id !== user.id))) fail(403, 'FORBIDDEN', '当前角色无权移除该任务');
            if (descendants.length && !cascade) fail(409, 'HAS_CHILD_TASKS', '该任务包含子任务，请确认连同子任务一并移除');
            const targetIds = [current.id, ...descendants.map(item => item.id)];
            const targetKeys = [current.jiraKey, ...descendants.map(item => item.jira_key)];
            const ph = targetIds.map(() => '?').join(',');
            if (db.prepare(`SELECT 1 FROM local_ai_runs WHERE task_id IN (${ph}) AND status='RUNNING' LIMIT 1`).get(...targetIds)) fail(409, 'AI_RUN_ACTIVE', '任务有正在运行的本地 AI 执行，请先停止后再移除');
            const jobIds = db.prepare(`SELECT id FROM jobs WHERE task_id IN (${ph})`).all(...targetIds).map(item => item.id);
            if (jobIds.length) {
              const jph = jobIds.map(() => '?').join(',');
              db.prepare(`DELETE FROM waivers WHERE finding_id IN (SELECT id FROM findings WHERE job_id IN (${jph}))`).run(...jobIds);
              db.prepare(`DELETE FROM findings WHERE job_id IN (${jph})`).run(...jobIds);
              db.prepare(`DELETE FROM decisions WHERE job_id IN (${jph})`).run(...jobIds);
              db.prepare(`DELETE FROM reports WHERE job_id IN (${jph})`).run(...jobIds);
              db.prepare(`DELETE FROM local_ai_runs WHERE job_id IN (${jph})`).run(...jobIds);
              db.prepare(`DELETE FROM jobs WHERE id IN (${jph})`).run(...jobIds);
            }
            db.prepare(`DELETE FROM local_ai_runs WHERE task_id IN (${ph})`).run(...targetIds);
            db.prepare(`DELETE FROM external_imports WHERE task_id IN (${ph}) OR local_id IN (SELECT id FROM assets WHERE task_id IN (${ph}))`).run(...targetIds, ...targetIds);
            db.prepare(`DELETE FROM account_external_imports WHERE task_id IN (${ph}) OR local_id IN (SELECT id FROM assets WHERE task_id IN (${ph}))`).run(...targetIds, ...targetIds);
            db.prepare(`DELETE FROM assets WHERE task_id IN (${ph})`).run(...targetIds);
            db.prepare(`DELETE FROM progress_events WHERE task_id IN (${ph})`).run(...targetIds);
            db.prepare(`DELETE FROM devices WHERE task_id IN (${ph})`).run(...targetIds);
            db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...targetIds);
            if (current.parentId && !targetIds.includes(current.parentId)) bumpParentContexts(db, [current.parentId]);
            for (const removedKey of targetKeys) audit(user.id, 'TASK_DELETE', removedKey, current.projectId);
            result = { deletedCount: targetIds.length, deletedIds: targetIds, deletedKeys: targetKeys };
          });
          return send(200, result);
        }
        if (method === 'PATCH' && !action) {
          assertAncestorsOpen(task, user);
          if (task.assigneeId !== user.id && !projectPermissions(user, role).assignTasks) fail(403, 'FORBIDDEN', '当前角色仅可编辑自己受理的任务');
          const body = requestBody; requireVersion(task, body.expectedVersion);
          const title = body.title === undefined ? task.title : textField(body.title, 'title', { max: 200 });
          const assigneeId = body.assigneeId === undefined ? task.assigneeId : body.assigneeId;
          if (body.assigneeId !== undefined) { if (!projectPermissions(user, role).assignTasks) fail(403, 'FORBIDDEN', '当前角色无权分配任务'); assertMember(task.projectId, assigneeId); }
          const status = body.status === undefined ? task.status : body.status;
          if (!['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].includes(status)) fail(400, 'INVALID_STATUS', '任务状态不受支持');
          if (status === 'DONE') {
            if (title !== task.title || assigneeId !== task.assigneeId) fail(409, 'REVIEW_INPUT_CHANGED', '请先保存任务变更并重新评审');
            if (workflow.gates(task).overall !== 'PASS') fail(409, 'GATES_BLOCKED', '全部五项门禁通过后才能完成任务');
            if (db.prepare('SELECT * FROM tasks WHERE parent_id=?').all(task.id).some(row => row.status !== 'DONE' || workflow.gates(taskRow(row)).overall !== 'PASS')) fail(409, 'CHILD_TASKS_OPEN', '子任务状态与门禁尚未全部完成');
          }
          transaction(() => { const current = getTask(task.id, user); requireVersion(current, body.expectedVersion); if (current.assigneeId !== user.id && !projectPermissions(user, taskRole(current, user)).assignTasks) fail(403, 'FORBIDDEN', '当前角色仅可编辑自己受理的任务'); const changed = db.prepare('UPDATE tasks SET title=?,assignee_id=?,status=?,version=version+1,context_version=context_version+?,updated_at=? WHERE id=? AND version=?').run(title, assigneeId, status, title !== task.title || assigneeId !== task.assigneeId || (task.status === 'DONE' && status !== 'DONE') ? 1 : 0, new Date().toISOString(), task.id, body.expectedVersion); if (changed.changes !== 1) fail(409, 'VERSION_CONFLICT', '任务已被其他操作更新，请刷新后重试'); audit(user.id, 'TASK_UPDATE', task.id, task.projectId); });
          return send(200, { task: getTask(task.id, user) });
        }
        if (method === 'GET' && action === 'context') return send(200, { task, assets: workflow.assetsFor(task.id), progressEvents: progressFor(task.id), devices: devicesFor(task.id), workspace: workspaceFor(user.id, task.projectId), integrationStatus: 'UNCONFIGURED' });
        if (method === 'GET' && action === 'gates') return send(200, workflow.gates(task));
        if (action === 'assets') {
          if (method === 'GET') return send(200, { assets: workflow.assetsFor(task.id) });
          if (method === 'POST') {
            assertWritable(task, user);
            const body = requestBody; if (!KINDS.includes(body.kind)) fail(400, 'INVALID_ASSET_KIND', '资产类型不受支持'); requireRole(role, ASSET_ROLES[body.kind]);
            const logicalKey = body.logicalKey === undefined ? body.kind : textField(body.logicalKey, 'logicalKey', { max: 100 });
            const title = textField(body.title, 'title', { max: 200, preserve: true }); const content = textField(body.content, 'content', { max: 65_536, preserve: true });
            const sourceUrl = body.sourceUrl === undefined || body.sourceUrl === '' ? null : textField(body.sourceUrl, 'sourceUrl', { max: 2000, preserve: true });
            if (sourceUrl) { let parsed; try { parsed = new URL(sourceUrl); } catch { fail(400, 'INVALID_SOURCE_URL', 'sourceUrl必须为HTTP(S)链接'); } if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(400, 'INVALID_SOURCE_URL', 'sourceUrl必须为无认证信息的HTTP(S)链接'); }
            const id = randomUUID(); transaction(() => { const revision = db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM assets WHERE task_id=? AND kind=? AND logical_key=?').get(task.id, body.kind, logicalKey).revision; db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, task.id, task.projectId, body.kind, logicalKey, title, content, sourceUrl, revision, sha(content), user.id, new Date().toISOString()); db.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(), task.id); audit(user.id, 'ASSET_VERSION_CREATE', id, task.projectId); });
            return send(201, { asset: workflow.assetsFor(task.id).find(item => item.id === id) });
          }
        }
        if (method === 'POST' && action === 'claim') {
          assertWritable(task, user);
          const body = requestBody; requireVersion(task, body.expectedVersion);
          if (task.assigneeId && task.assigneeId !== user.id) fail(409, 'TASK_ASSIGNED', '任务已指派给其他成员');
          transaction(() => { const current = getTask(task.id, user); requireVersion(current, body.expectedVersion); if (current.assigneeId && current.assigneeId !== user.id) fail(409, 'TASK_ASSIGNED', '任务已指派给其他成员'); const changed = db.prepare("UPDATE tasks SET assignee_id=?,status='IN_PROGRESS',version=version+1,context_version=context_version+?,updated_at=? WHERE id=? AND version=?").run(user.id, task.assigneeId !== user.id ? 1 : 0, new Date().toISOString(), task.id, body.expectedVersion); if (changed.changes !== 1) fail(409, 'VERSION_CONFLICT', '任务已被其他操作更新，请刷新后重试'); audit(user.id, 'TASK_CLAIM', task.id, task.projectId); });
          return send(200, { task: getTask(task.id, user) });
        }
        if (method === 'POST' && action === 'progress') {
          assertWritable(task, user);
          requireAssignee(task, user); const body = requestBody;
          if (!Number.isInteger(body.progress) || body.progress < 0 || body.progress > 100) fail(400, 'INVALID_PROGRESS', 'progress必须是0至100的整数');
          if (!TOOLS.includes(body.tool)) fail(400, 'INVALID_TOOL', 'tool不受支持');
          const deviceId = textField(body.deviceId, 'deviceId', { max: 100 }); const summary = textField(body.summary, 'summary', { max: 2000, preserve: true }); const branch = body.branch === undefined ? null : textField(body.branch, 'branch', { max: 200, preserve: true }); const id = randomUUID(); const now = new Date().toISOString();
          transaction(() => { db.prepare('INSERT INTO progress_events VALUES (?,?,?,?,?,?,?,?,?)').run(id, task.id, user.id, body.tool, deviceId, body.progress, summary, branch, now); db.prepare('UPDATE tasks SET progress=?,last_summary=?,version=version+1,updated_at=? WHERE id=?').run(body.progress, summary, now, task.id); audit(user.id, 'PROGRESS_REPORT', task.id, task.projectId); });
          return send(201, { task: getTask(task.id, user), progress: { id, taskId: task.id, actorId: user.id, tool: body.tool, deviceId, progress: body.progress, summary, branch, createdAt: now, source: 'self_reported' } });
        }
        if (method === 'POST' && action === 'heartbeat') {
          requireAssignee(task, user); const body = requestBody;
          const deviceId = textField(body.deviceId, 'deviceId', { max: 100 }); if (!TOOLS.includes(body.tool) || !['IDLE', 'WORKING', 'WAITING', 'OFFLINE'].includes(body.status)) fail(400, 'INVALID_DEVICE', '工具或会话状态不受支持');
          db.prepare('INSERT INTO devices VALUES (?,?,?,?,?,?) ON CONFLICT(task_id,device_id,actor_id) DO UPDATE SET tool=excluded.tool,status=excluded.status,last_seen=excluded.last_seen').run(task.id, deviceId, user.id, body.tool, body.status, new Date().toISOString());
          return send(200, { device: devicesFor(task.id).find(item => item.deviceId === deviceId && item.actorId === user.id) });
        }
      }
      if (method === 'GET' && path === '/api/overview-summary') {
        const quantileHours = (sortedNums, q) => {
          if (!sortedNums.length) return null;
          const pos = (sortedNums.length - 1) * q;
          const base = Math.floor(pos);
          const rest = pos - base;
          const val = sortedNums[base + 1] !== undefined
            ? sortedNums[base] + rest * (sortedNums[base + 1] - sortedNums[base])
            : sortedNums[base];
          return Math.round(val * 10) / 10;
        };
        const emptyFlowTelemetry = {
          completedTasksTotal: 0,
          medianLeadTimeHours: null,
          p90LeadTimeHours: null,
          decidedReviewsCount: 0,
          approvedReviewsCount: 0,
          reworkReviewsCount: 0,
          firstTimePassRate: null,
          medianReviewTurnaroundHours: null,
          p90ReviewTurnaroundHours: null,
          throughput7d: { tasksDone: 0, gatesApproved: 0, assetsVersioned: 0 },
        };
        const projectId = url.searchParams.get('projectId');
        if (projectId) projectRole(user, projectId);
        const projectIds = projectId ? [projectId] : visibleProjects(user).map(project => project.id);
        if (!projectIds.length) return send(200, { reviewCount: 0, assetCount: 0, openBlockersCount: 0, stageBreakdown: {}, flowTelemetry: emptyFlowTelemetry, pendingJobs: [] });
        const ph = projectIds.map(() => '?').join(',');
        const reviewCount = db.prepare(`SELECT COUNT(*) AS count FROM jobs j JOIN tasks t ON t.id=j.task_id AND t.project_id=j.project_id WHERE j.project_id IN (${ph})`).get(...projectIds).count;
        const assetCount = db.prepare(`SELECT COUNT(*) AS count FROM assets a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id WHERE a.project_id IN (${ph})`).get(...projectIds).count;
        const openBlockersCount = db.prepare(`SELECT COUNT(*) AS count FROM findings f JOIN jobs j ON j.id=f.job_id JOIN tasks t ON t.id=j.task_id AND t.project_id=j.project_id LEFT JOIN waivers w ON w.finding_id=f.id LEFT JOIN decisions d ON d.job_id=j.id WHERE j.project_id IN (${ph}) AND j.rowid=(SELECT MAX(j2.rowid) FROM jobs j2 WHERE j2.task_id=j.task_id AND j2.stage=j.stage) AND t.status!='DONE' AND f.severity='CRITICAL' AND w.finding_id IS NULL AND (d.decision IS NULL OR d.decision!='APPROVE')`).get(...projectIds).count;
        const stageBreakdown = {};
        for (const row of db.prepare(`SELECT j.stage, SUM(CASE WHEN d.decision='APPROVE' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN r.job_id IS NOT NULL AND d.job_id IS NULL THEN 1 ELSE 0 END) AS pendingApproval, SUM(CASE WHEN r.job_id IS NULL AND d.job_id IS NULL THEN 1 ELSE 0 END) AS awaitingReport, SUM(CASE WHEN d.decision='REQUEST_CHANGES' THEN 1 ELSE 0 END) AS changesRequested FROM jobs j JOIN tasks t ON t.id=j.task_id AND t.project_id=j.project_id LEFT JOIN reports r ON r.job_id=j.id LEFT JOIN decisions d ON d.job_id=j.id WHERE j.project_id IN (${ph}) AND j.rowid=(SELECT MAX(j2.rowid) FROM jobs j2 WHERE j2.task_id=j.task_id AND j2.stage=j.stage) GROUP BY j.stage`).all(...projectIds)) {
          stageBreakdown[row.stage] = {
            approved: Number(row.approved || 0),
            pendingApproval: Number(row.pendingApproval || 0),
            awaitingReport: Number(row.awaitingReport || 0),
            changesRequested: Number(row.changesRequested || 0),
          };
        }
        const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const doneTaskRows = db.prepare(`SELECT created_at, updated_at FROM tasks WHERE project_id IN (${ph}) AND status='DONE'`).all(...projectIds);
        const leadHoursList = doneTaskRows
          .map(r => {
            const c = Date.parse(r.created_at);
            const u = Date.parse(r.updated_at);
            return Number.isFinite(c) && Number.isFinite(u) ? Math.max(0, (u - c) / 3_600_000) : null;
          })
          .filter(v => v !== null)
          .sort((a, b) => a - b);
        const decisionRows = db.prepare(`SELECT j.created_at AS job_created, d.decision, d.created_at AS dec_created FROM decisions d JOIN jobs j ON j.id=d.job_id JOIN tasks t ON t.id=j.task_id AND t.project_id=j.project_id WHERE j.project_id IN (${ph})`).all(...projectIds);
        const turnaroundHoursList = decisionRows
          .map(r => {
            const c = Date.parse(r.job_created);
            const d = Date.parse(r.dec_created);
            return Number.isFinite(c) && Number.isFinite(d) ? Math.max(0, (d - c) / 3_600_000) : null;
          })
          .filter(v => v !== null)
          .sort((a, b) => a - b);
        const decidedReviewsCount = decisionRows.length;
        const approvedReviewsCount = decisionRows.filter(r => r.decision === 'APPROVE').length;
        const reworkReviewsCount = decisionRows.filter(r => r.decision === 'REQUEST_CHANGES').length;
        const assetsVersioned7d = db.prepare(`SELECT COUNT(*) AS count FROM assets a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id WHERE a.project_id IN (${ph}) AND a.created_at >= ?`).get(...projectIds, sevenDaysAgoIso).count;
        const flowTelemetry = {
          completedTasksTotal: doneTaskRows.length,
          medianLeadTimeHours: quantileHours(leadHoursList, 0.5),
          p90LeadTimeHours: quantileHours(leadHoursList, 0.9),
          decidedReviewsCount,
          approvedReviewsCount,
          reworkReviewsCount,
          firstTimePassRate: decidedReviewsCount > 0 ? Math.round((approvedReviewsCount / decidedReviewsCount) * 100) : null,
          medianReviewTurnaroundHours: quantileHours(turnaroundHoursList, 0.5),
          p90ReviewTurnaroundHours: quantileHours(turnaroundHoursList, 0.9),
          throughput7d: {
            tasksDone: doneTaskRows.filter(r => r.updated_at >= sevenDaysAgoIso).length,
            gatesApproved: decisionRows.filter(r => r.decision === 'APPROVE' && r.dec_created >= sevenDaysAgoIso).length,
            assetsVersioned: Number(assetsVersioned7d || 0),
          },
        };
        const pendingRows = db.prepare(`SELECT j.* FROM jobs j JOIN tasks t ON t.id=j.task_id AND t.project_id=j.project_id JOIN reports r ON r.job_id=j.id LEFT JOIN decisions d ON d.job_id=j.id WHERE d.job_id IS NULL AND j.project_id IN (${ph}) ORDER BY j.rowid DESC`).all(...projectIds);
        const summaryTaskCache = new Map();
        const memo = workflow.createMemo();
        const pendingJobs = pendingRows.map(row => {
          let task = summaryTaskCache.get(row.task_id);
          if (!task) { task = getTask(row.task_id, user); summaryTaskCache.set(row.task_id, task); }
          const full = workflow.jobRow(row, task, memo);
          const hasBlockingFindings = full.findings.some(item => item.severity === 'CRITICAL' && !item.waiver);
          let prerequisitesBlocked = false;
          if (full.stage === 'RELEASE') {
            const taskGates = workflow.gates(task, memo);
            prerequisitesBlocked = taskGates.gates.slice(0, 4).some(item => item.status !== 'PASS');
          }
          return {
            id: full.id,
            taskId: full.taskId,
            projectId: full.projectId,
            stage: full.stage,
            executionMode: full.executionMode,
            status: full.status,
            actorId: full.actorId,
            createdAt: full.createdAt,
            stale: full.stale,
            soloMode: full.soloMode,
            hasBlockingFindings,
            prerequisitesBlocked,
            report: full.report ? { id: full.report.id, actorId: full.report.actorId, source: full.report.source, tool: full.report.tool, createdAt: full.report.createdAt } : null,
            decision: null,
          };
        });
        return send(200, { reviewCount, assetCount, openBlockersCount, stageBreakdown, flowTelemetry, pendingJobs });
      }
      if (method === 'GET' && path === '/api/assets') {
        const projectId = url.searchParams.get('projectId');
        if (projectId) projectRole(user, projectId);
        const projectIds = projectId ? [projectId] : visibleProjects(user).map(project => project.id);
        if (!projectIds.length) return send(200, { assets: [] });
        const assets = db.prepare(`SELECT a.id,a.task_id AS taskId,a.project_id AS projectId,a.kind,a.logical_key AS logicalKey,a.title,a.source_url AS sourceUrl,a.revision,a.sha256,a.actor_id AS actorId,a.created_at AS createdAt,t.jira_key AS taskKey,t.title AS taskTitle
          FROM assets a JOIN tasks t ON t.id=a.task_id
          WHERE a.project_id IN (${projectIds.map(() => '?').join(',')})
          ORDER BY a.created_at DESC,a.rowid DESC`).all(...projectIds);
        return send(200, { assets });
      }
      if (method === 'GET' && path === '/api/jobs') {
        const taskId = url.searchParams.get('taskId');
        const singleTask = taskId ? getTask(taskId, user) : null;
        const projectId = url.searchParams.get('projectId');
        if (projectId) projectRole(user, projectId);
        let rows;
        if (taskId && projectId) {
          rows = db.prepare('SELECT * FROM jobs WHERE task_id=? AND project_id=? ORDER BY rowid DESC').all(taskId, projectId);
        } else if (taskId) {
          const allowed = new Set(visibleProjects(user).map(project => project.id));
          rows = db.prepare('SELECT * FROM jobs WHERE task_id=? ORDER BY rowid DESC').all(taskId).filter(row => allowed.has(row.project_id));
        } else if (projectId) {
          rows = db.prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY rowid DESC').all(projectId);
        } else {
          const allowed = new Set(visibleProjects(user).map(project => project.id));
          rows = db.prepare('SELECT * FROM jobs ORDER BY rowid DESC').all().filter(row => allowed.has(row.project_id));
        }
        const taskCache = new Map(singleTask ? [[singleTask.id, singleTask]] : []);
        const memo = workflow.createMemo();
        const getCachedTask = id => {
          if (!taskCache.has(id)) taskCache.set(id, getTask(id, user));
          return taskCache.get(id);
        };
        return send(200, { jobs: rows.map(row => workflow.jobRow(row, getCachedTask(row.task_id), memo)) });
      }
      if (method === 'POST' && path === '/api/reviews') { const body = requestBody; const task = getTask(textField(body.taskId, 'taskId', { max: 64 }), user); assertWritable(task, user); const result = workflow.createReview(task, user, taskRole(task, user), body); return send(result.status, { job: result.job }); }
      const jobRoute = path.match(/^\/api\/jobs\/([^/]+)(?:\/(report|decision|findings\/([^/]+)\/waiver))?$/);
      if (jobRoute) {
        const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobRoute[1]); if (!row) fail(404, 'JOB_NOT_FOUND', '评审任务不存在');
        const task = getTask(row.task_id, user); const role = taskRole(task, user);
        if (method === 'GET' && !jobRoute[2]) return send(200, { job: workflow.jobRow(row, task) });
        if (method === 'POST' && jobRoute[2]) {
          assertWritable(task, user);
          const body = requestBody; let job;
          if (jobRoute[2] === 'report') job = workflow.submitReport(row, task, user, role, body);
          else if (jobRoute[2] === 'decision') job = workflow.decide(row, task, user, role, body);
          else job = workflow.waive(row, task, jobRoute[3], user, role, body);
          return send(201, { job });
        }
      }
      if (path === '/api/plugins') {
        if (method === 'GET') { const projectId = url.searchParams.get('projectId'); if (projectId) projectRole(user, projectId); const allowed = new Set(visibleProjects(user).map(item => item.id)); return send(200, { plugins: db.prepare('SELECT * FROM plugins').all().filter(row => allowed.has(row.project_id) && (!projectId || row.project_id === projectId)).map(row => ({ ...JSON.parse(row.manifest), projectId: row.project_id })) }); }
        if (method === 'POST') {
          const body = requestBody; const projectId = body.projectId || 'default'; if (!projectPermissions(user, projectRole(user, projectId)).registerPlugins) fail(403, 'FORBIDDEN', '当前角色无权登记项目插件');
          const id = textField(body.id, 'id', { max: 64 }); const name = textField(body.name, 'name', { max: 100 }); const version = textField(body.version, 'version', { max: 32 });
          if (!/^[a-z][a-z0-9-]*$/.test(id) || !/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(body.stages) || !body.stages.length || body.stages.length > 5 || body.stages.some(stage => !STAGES.includes(stage))) fail(400, 'INVALID_PLUGIN', '插件声明格式不正确');
          const plugin = { id, name, version, stages: [...new Set(body.stages)], status: 'REGISTERED_NOT_EXECUTABLE' };
          transaction(() => { if (db.prepare('SELECT id FROM plugins WHERE id=?').get(id)) fail(409, 'PLUGIN_EXISTS', '该插件已登记'); db.prepare('INSERT INTO plugins (id,manifest,created_by,project_id) VALUES (?,?,?,?)').run(id, JSON.stringify(plugin), user.id, projectId); audit(user.id, 'PLUGIN_REGISTER', id, projectId); });
          return send(201, { plugin: { ...plugin, projectId } });
        }
      }
      if (method === 'GET' && path === '/api/audit') {
        const projectId = url.searchParams.get('projectId'); if (projectId && !projectPermissions(user, projectRole(user, projectId)).viewAudit) fail(403, 'FORBIDDEN', '当前角色无权查看审计');
        const projects = visibleProjects(user).filter(item => item.permissions.viewAudit); if (!projects.length) fail(403, 'FORBIDDEN', '当前角色无权查看审计');
        if (projectId) {
          return send(200, { audit: db.prepare('SELECT id,actor_id AS actorId,action,target_id AS targetId,created_at AS createdAt,project_id AS projectId FROM audit WHERE project_id=? ORDER BY rowid DESC LIMIT 200').all(projectId) });
        }
        const allowed = new Set(projects.map(item => item.id));
        return send(200, { audit: db.prepare('SELECT id,actor_id AS actorId,action,target_id AS targetId,created_at AS createdAt,project_id AS projectId FROM audit ORDER BY rowid DESC').all().filter(row => row.projectId ? allowed.has(row.projectId) : user.role === 'ADMIN').slice(0, 200) });
      }
      fail(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      logger.error('TaskFlow request failed'); send(500, { error: { code: 'INTERNAL_ERROR', message: '服务处理失败' } });
    }
  });
  return { server, db, close: () => new Promise((resolveClose, reject) => { localAutomation.closeAll(); server.close(error => { db.close(); error ? reject(error) : resolveClose(); }); }) };
}
export function runtimeOptions(env = process.env) { const port = Number(env.TASKFLOW_PORT || 5187); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TASKFLOW_PORT must be 1..65535'); return { port, host: env.TASKFLOW_HOST || '127.0.0.1' }; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, host } = runtimeOptions(); const platform = createPlatform({ dbPath: process.env.TASKFLOW_DB_PATH || undefined, hostBridgeStateDir: process.env.TASKFLOW_HOST_BRIDGE_STATE_DIR || null, hostBridgeApiUrl: process.env.TASKFLOW_PUBLIC_API_URL || `http://${host}:${port}`, runsDir: process.env.TASKFLOW_RUNS_DIR || null, localReposFile: process.env.TASKFLOW_LOCAL_REPOS_FILE || null, workbenchUrl: process.env.TASKFLOW_WORKBENCH_URL || undefined, workbenchTaskUrl: process.env.TASKFLOW_WEB_ORIGIN || undefined });
  platform.server.once('error', error => { console.error(`TaskFlow API 启动失败 (${error.code || 'LISTEN_ERROR'})`); platform.db.close(); process.exitCode = 1; });
  platform.server.listen(port, host, () => console.log(`TaskFlow API http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => platform.close().then(() => process.exit(0)));
}

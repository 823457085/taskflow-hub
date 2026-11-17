import { randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';

const SOURCES = ['delivery'];
const SYNC_MAX = 100;
const LIST_MAX = 200;
const ITEM_FIELDS = ['id', 'title', 'objective', 'provider', 'model', 'mode', 'status', 'result', 'error', 'workspace', 'branch', 'turns', 'inputTokens', 'outputTokens', 'costUsd', 'jiraKeys', 'startedAt', 'updatedAt', 'projectId', 'shared'];
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
  [/(?:\/Users|\/home)\/[^/\s"'`]+/g, '~'],
  [/(\b(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*)["']?[^\s"',;]{4,}/gi, '$1[REDACTED]'],
];

export function redactText(value) {
  let text = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

const known = (body, fields) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !fields.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const optionalText = (value, name, max) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, 'INVALID_INPUT', `${name}格式不正确`);
  return redactText(value.length > max ? `${value.slice(0, max - 1)}…` : value);
};
const count = (value, name) => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) fail(400, 'INVALID_INPUT', `${name}格式不正确`);
  return value;
};
const stamp = (value, name) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(400, 'INVALID_INPUT', `${name}需要有效时间`);
  return new Date(value).toISOString();
};

export function createAgentSessions({ db, transaction, audit, projectRole }) {
  const iso = () => new Date().toISOString();
  const browserOnly = user => { if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能同步 Agent 记录'); };
  const isMember = (user, projectId) => { try { projectRole(user, projectId); return true; } catch { return false; } };
  const linkTask = (projectId, jiraKeys) => {
    if (!projectId || !jiraKeys.length) return null;
    for (const key of jiraKeys) { const task = db.prepare('SELECT id FROM tasks WHERE project_id=? AND jira_key=?').get(projectId, key); if (task) return task.id; }
    return null;
  };
  const summary = row => ({
    id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, projectId: row.project_id, taskId: row.task_id, taskKey: row.task_key || null,
    source: row.source, title: row.title, provider: row.provider, model: row.model, mode: row.mode, status: row.status,
    excerpt: (row.result || row.error || '').slice(0, 300), workspace: row.workspace, branch: row.branch, turns: row.turns,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsd: row.cost_usd, jiraKeys: JSON.parse(row.jira_keys),
    shared: !!row.shared, startedAt: row.started_at, updatedAt: row.updated_at, syncedAt: row.synced_at, comments: row.comment_count ?? 0,
  });
  const select = `SELECT s.*,u.username AS owner_name,t.jira_key AS task_key,(SELECT COUNT(*) FROM agent_session_comments c WHERE c.session_id=s.id) AS comment_count
    FROM agent_sessions s JOIN users u ON u.id=s.owner_id LEFT JOIN tasks t ON t.id=s.task_id`;
  const load = (user, id) => {
    const row = typeof id === 'string' && id.length <= 64 ? db.prepare(`${select} WHERE s.id=?`).get(id) : null;
    if (!row || (row.owner_id !== user.id && !(row.shared && row.project_id && isMember(user, row.project_id)))) fail(404, 'AGENT_SESSION_NOT_FOUND', 'Agent 记录不存在或未共享给你');
    return row;
  };
  const detail = (user, row) => ({
    ...summary(row), objective: row.objective, result: row.result, error: row.error, canManage: row.owner_id === user.id,
    commentList: db.prepare('SELECT c.id,c.body,c.created_at,u.id AS author_id,u.username FROM agent_session_comments c JOIN users u ON u.id=c.author_id WHERE c.session_id=? ORDER BY c.created_at').all(row.id)
      .map(comment => ({ id: comment.id, body: comment.body, createdAt: comment.created_at, authorId: comment.author_id, authorName: comment.username })),
  });

  function sync(user, body) {
    known(body, ['source', 'items']);
    if (!SOURCES.includes(body.source)) fail(400, 'INVALID_INPUT', 'source不受支持');
    if (!Array.isArray(body.items) || body.items.length > SYNC_MAX) fail(400, 'INVALID_INPUT', `items需为最多${SYNC_MAX}条的数组`);
    const rows = body.items.map(item => {
      known(item, ITEM_FIELDS);
      const jiraKeys = item.jiraKeys === undefined ? [] : Array.isArray(item.jiraKeys) && item.jiraKeys.length <= 5 && item.jiraKeys.every(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/.test(key)) ? [...new Set(item.jiraKeys)] : fail(400, 'INVALID_INPUT', 'jiraKeys格式不正确');
      let projectId = null;
      if (item.projectId !== undefined && item.projectId !== null) {
        projectId = textField(item.projectId, 'projectId', { max: 80 });
        projectRole(user, projectId);
      }
      if (item.shared !== undefined && typeof item.shared !== 'boolean') fail(400, 'INVALID_INPUT', 'shared需为布尔值');
      return {
        source_id: textField(item.id, 'id', { max: 120 }), title: redactText(textField(item.title, 'title', { max: 200 })),
        objective: optionalText(item.objective, 'objective', 2000), provider: optionalText(item.provider, 'provider', 40), model: optionalText(item.model, 'model', 80),
        mode: optionalText(item.mode, 'mode', 40), status: textField(item.status, 'status', { max: 40 }), result: optionalText(item.result, 'result', 4000),
        error: optionalText(item.error, 'error', 1000), workspace: optionalText(item.workspace, 'workspace', 120).split(/[\\/]/).pop(), branch: optionalText(item.branch, 'branch', 200),
        turns: Math.round(count(item.turns, 'turns')), input_tokens: Math.round(count(item.inputTokens, 'inputTokens')), output_tokens: Math.round(count(item.outputTokens, 'outputTokens')),
        cost_usd: count(item.costUsd, 'costUsd'), jira_keys: JSON.stringify(jiraKeys), jiraKeys, started_at: stamp(item.startedAt, 'startedAt'), updated_at: stamp(item.updatedAt, 'updatedAt'),
        project_id: projectId, shared: projectId && item.shared ? 1 : 0,
      };
    });
    let created = 0, updated = 0, unchanged = 0;
    transaction(() => {
      const now = iso();
      for (const row of rows) {
        const existing = db.prepare('SELECT id,updated_at,project_id,task_id FROM agent_sessions WHERE owner_id=? AND source=? AND source_id=?').get(user.id, body.source, row.source_id);
        if (!existing) {
          db.prepare(`INSERT INTO agent_sessions (id,owner_id,project_id,task_id,source,source_id,title,objective,provider,model,mode,status,result,error,workspace,branch,turns,input_tokens,output_tokens,cost_usd,jira_keys,shared,started_at,updated_at,synced_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), user.id, row.project_id, linkTask(row.project_id, row.jiraKeys), body.source, row.source_id, row.title, row.objective, row.provider, row.model, row.mode, row.status,
            row.result, row.error, row.workspace, row.branch, row.turns, row.input_tokens, row.output_tokens, row.cost_usd, row.jira_keys, row.shared, row.started_at, row.updated_at, now);
          created++;
        } else if (row.updated_at > existing.updated_at) {
          db.prepare(`UPDATE agent_sessions SET title=?,objective=?,provider=?,model=?,mode=?,status=?,result=?,error=?,workspace=?,branch=?,turns=?,input_tokens=?,output_tokens=?,cost_usd=?,jira_keys=?,updated_at=?,synced_at=?,task_id=COALESCE(task_id,?) WHERE id=?`)
            .run(row.title, row.objective, row.provider, row.model, row.mode, row.status, row.result, row.error, row.workspace, row.branch, row.turns, row.input_tokens, row.output_tokens, row.cost_usd, row.jira_keys, row.updated_at, now, linkTask(existing.project_id, row.jiraKeys), existing.id);
          updated++;
        } else unchanged++;
      }
      if (created || updated) audit(user.id, 'AGENT_SESSION_SYNC', user.id, null);
    });
    return { created, updated, unchanged };
  }

  function list(user, url) {
    const scope = url.searchParams.get('scope') || 'mine';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, LIST_MAX);
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const where = [], args = [];
    if (scope === 'project') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
      projectRole(user, projectId);
      where.push('s.project_id=? AND s.shared=1'); args.push(projectId);
    } else if (scope === 'mine') { where.push('s.owner_id=?'); args.push(user.id); }
    else fail(400, 'INVALID_INPUT', 'scope不受支持');
    if (query) { where.push("(s.title LIKE ? ESCAPE '\\' OR s.objective LIKE ? ESCAPE '\\' OR s.jira_keys LIKE ? ESCAPE '\\')"); const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like); }
    const rows = db.prepare(`${select} WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ?`).all(...args, limit);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions s WHERE ${where.join(' AND ')}`).get(...args).n;
    return { sessions: rows.map(summary), total };
  }

  function update(user, id, body) {
    const row = load(user, id);
    if (row.owner_id !== user.id) fail(403, 'FORBIDDEN', '只有记录所有人可以修改共享设置');
    known(body, ['projectId', 'shared', 'taskId']);
    let projectId = row.project_id;
    if (body.projectId !== undefined) {
      projectId = body.projectId === null || body.projectId === '' ? null : textField(body.projectId, 'projectId', { max: 80 });
      if (projectId) projectRole(user, projectId);
    }
    if (body.shared !== undefined && typeof body.shared !== 'boolean') fail(400, 'INVALID_INPUT', 'shared需为布尔值');
    const shared = body.shared === undefined ? !!row.shared && !!projectId : body.shared;
    if (shared && !projectId) fail(400, 'AGENT_SESSION_PROJECT_REQUIRED', '请先选择要共享到的项目');
    let taskId = projectId === row.project_id ? row.task_id : null;
    if (body.taskId !== undefined) {
      taskId = body.taskId === null || body.taskId === '' ? null : textField(body.taskId, 'taskId', { max: 64 });
      if (taskId && !db.prepare('SELECT id FROM tasks WHERE id=? AND project_id=?').get(taskId, projectId)) fail(400, 'AGENT_SESSION_TASK_INVALID', '关联任务不存在或不属于该项目');
    }
    if (taskId === null && body.taskId === undefined) taskId = linkTask(projectId, JSON.parse(row.jira_keys));
    transaction(() => {
      db.prepare('UPDATE agent_sessions SET project_id=?,shared=?,task_id=? WHERE id=?').run(projectId, shared ? 1 : 0, taskId, row.id);
      if (shared !== !!row.shared) audit(user.id, shared ? 'AGENT_SESSION_SHARE' : 'AGENT_SESSION_UNSHARE', row.id, projectId || row.project_id);
    });
    return detail(user, load(user, row.id));
  }

  function shareMany(user, body) {
    known(body, ['ids', 'projectId', 'shared']);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > LIST_MAX || body.ids.some(id => typeof id !== 'string')) fail(400, 'INVALID_INPUT', 'ids格式不正确');
    if (typeof body.shared !== 'boolean') fail(400, 'INVALID_INPUT', 'shared需为布尔值');
    const projectId = textField(body.projectId, 'projectId', { max: 80 });
    projectRole(user, projectId);
    let changed = 0;
    transaction(() => {
      for (const id of new Set(body.ids)) {
        const row = db.prepare('SELECT id,project_id,jira_keys,task_id FROM agent_sessions WHERE id=? AND owner_id=?').get(id, user.id);
        if (!row) continue;
        const taskId = row.project_id === projectId && row.task_id ? row.task_id : linkTask(projectId, JSON.parse(row.jira_keys));
        changed += db.prepare('UPDATE agent_sessions SET project_id=?,shared=?,task_id=? WHERE id=?').run(projectId, body.shared ? 1 : 0, taskId, row.id).changes;
      }
      if (changed) audit(user.id, body.shared ? 'AGENT_SESSION_SHARE' : 'AGENT_SESSION_UNSHARE', projectId, projectId);
    });
    return { changed };
  }

  function comment(user, id, body) {
    const row = load(user, id);
    known(body, ['body']);
    const text = redactText(textField(body.body, 'body', { max: 2000, preserve: true }));
    transaction(() => {
      db.prepare('INSERT INTO agent_session_comments (id,session_id,author_id,body,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), row.id, user.id, text, iso());
      audit(user.id, 'AGENT_SESSION_COMMENT', row.id, row.project_id);
    });
    return detail(user, load(user, row.id));
  }

  function remove(user, id) {
    const row = load(user, id);
    if (row.owner_id !== user.id) fail(403, 'FORBIDDEN', '只有记录所有人可以删除');
    transaction(() => {
      db.prepare('DELETE FROM agent_session_comments WHERE session_id=?').run(row.id);
      db.prepare('DELETE FROM agent_sessions WHERE id=?').run(row.id);
      audit(user.id, 'AGENT_SESSION_DELETE', row.id, row.project_id);
    });
  }

  return function handle({ method, path, url, user, body, send }) {
    if (path === '/api/agent-sessions/sync') {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(200, sync(user, body)); return true;
    }
    if (path === '/api/agent-sessions/share') {
      browserOnly(user);
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(200, shareMany(user, body)); return true;
    }
    if (path === '/api/agent-sessions') {
      browserOnly(user);
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
      send(200, list(user, url)); return true;
    }
    const match = path.match(/^\/api\/agent-sessions\/([^/]+)(\/comments)?$/);
    if (!match) return false;
    browserOnly(user);
    if (match[2]) {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(201, { session: comment(user, match[1], body) }); return true;
    }
    if (method === 'GET') { send(200, { session: detail(user, load(user, match[1])) }); return true; }
    if (method === 'PATCH') { send(200, { session: update(user, match[1], body) }); return true; }
    if (method === 'DELETE') { remove(user, match[1]); send(204); return true; }
    fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
  };
}

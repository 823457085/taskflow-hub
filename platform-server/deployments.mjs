import { randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';
import { projectPermissions } from './permissions.mjs';

const PROVIDERS = ['manual', 'yunxiao', 'jenkins', 'other'];
const STATUSES = ['running', 'success', 'failed', 'cancelled', 'unknown'];
const SYNC_MAX = 200;
const LIST_MAX = 300;
const RECORD_FIELDS = ['projectId', 'environment', 'service', 'version', 'status', 'url', 'notes', 'startedAt', 'finishedAt'];
const SYNC_FIELDS = ['externalId', 'provider', 'environment', 'service', 'version', 'status', 'url', 'notes', 'startedAt', 'finishedAt'];

const known = (body, fields) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !fields.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const optional = (value, name, max) => value === undefined || value === null || value === '' ? '' : textField(value, name, { min: 0, max, preserve: name === 'notes' });
const status = value => { if (!STATUSES.includes(value)) fail(400, 'INVALID_INPUT', 'status不受支持'); return value; };
const stamp = (value, name, fallback = null) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(400, 'INVALID_INPUT', `${name}需要有效时间`);
  return new Date(value).toISOString();
};
const link = value => {
  const text = optional(value, 'url', 500);
  if (!text) return '';
  try { const parsed = new URL(text); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); return parsed.href; }
  catch { fail(400, 'INVALID_INPUT', 'url需为 http(s) 链接'); }
};

export function createDeployments({ db, transaction, audit, projectRole }) {
  const iso = () => new Date().toISOString();
  const browserOnly = user => { if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能同步部署记录'); };
  const view = (user, row) => {
    const permissions = projectPermissions(user, projectRole(user, row.project_id));
    const own = row.actor_id === user.id;
    return {
      id: row.id, projectId: row.project_id, provider: row.provider, externalId: row.external_id, environment: row.environment, service: row.service,
      version: row.version, status: row.status, url: row.url, notes: row.notes, actorId: row.actor_id, actorName: row.actor_name,
      startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at, updatedAt: row.updated_at,
      canEdit: own || permissions.assignTasks, canDelete: row.provider === 'manual' && (own || permissions.manageMembers),
    };
  };
  const select = 'SELECT d.*,u.username AS actor_name FROM deployments d JOIN users u ON u.id=d.actor_id';
  const load = (user, id) => {
    const row = typeof id === 'string' && id.length <= 64 ? db.prepare(`${select} WHERE d.id=?`).get(id) : null;
    if (!row) fail(404, 'DEPLOYMENT_NOT_FOUND', '部署记录不存在');
    projectRole(user, row.project_id);
    return row;
  };

  function list(user, url) {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
    projectRole(user, projectId);
    const where = ['d.project_id=?'], args = [projectId];
    const environment = url.searchParams.get('environment');
    if (environment) { where.push('d.environment=?'); args.push(environment); }
    const state = url.searchParams.get('status');
    if (state) { where.push('d.status=?'); args.push(status(state)); }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, LIST_MAX);
    const rows = db.prepare(`${select} WHERE ${where.join(' AND ')} ORDER BY d.started_at DESC LIMIT ?`).all(...args, limit);
    const environments = db.prepare('SELECT environment,COUNT(*) AS total FROM deployments WHERE project_id=? GROUP BY environment ORDER BY environment').all(projectId)
      .map(row => {
        const latest = db.prepare(`${select} WHERE d.project_id=? AND d.environment=? ORDER BY d.started_at DESC LIMIT 1`).get(projectId, row.environment);
        return { environment: row.environment, total: row.total, latest: view(user, latest) };
      });
    return { deployments: rows.map(row => view(user, row)), environments };
  }

  function record(user, body) {
    known(body, RECORD_FIELDS);
    const projectId = textField(body.projectId, 'projectId', { max: 80 });
    projectRole(user, projectId);
    const now = iso();
    const row = {
      id: randomUUID(), environment: textField(body.environment, 'environment', { max: 40 }), service: textField(body.service, 'service', { max: 120 }),
      version: optional(body.version, 'version', 200), status: body.status === undefined ? 'running' : status(body.status), url: link(body.url), notes: optional(body.notes, 'notes', 2000),
      started_at: stamp(body.startedAt, 'startedAt', now), finished_at: stamp(body.finishedAt, 'finishedAt'),
    };
    transaction(() => {
      db.prepare(`INSERT INTO deployments (id,project_id,provider,external_id,environment,service,version,status,url,notes,actor_id,started_at,finished_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, projectId, 'manual', null, row.environment, row.service, row.version, row.status, row.url, row.notes, user.id, row.started_at, row.finished_at, now, now);
      audit(user.id, 'DEPLOYMENT_RECORD', row.id, projectId);
    });
    return view(user, load(user, row.id));
  }

  function update(user, id, body) {
    const row = load(user, id);
    if (!view(user, row).canEdit) fail(403, 'FORBIDDEN', '只有记录人或项目负责人、PM 可以修改部署记录');
    const fields = row.provider === 'manual' ? ['status', 'notes', 'version', 'url', 'finishedAt'] : ['notes'];
    known(body, fields);
    const next = {
      status: body.status === undefined ? row.status : status(body.status), notes: body.notes === undefined ? row.notes : optional(body.notes, 'notes', 2000),
      version: body.version === undefined ? row.version : optional(body.version, 'version', 200), url: body.url === undefined ? row.url : link(body.url),
      finished_at: body.finishedAt === undefined ? row.finished_at || (body.status && body.status !== 'running' ? iso() : null) : stamp(body.finishedAt, 'finishedAt'),
    };
    transaction(() => {
      db.prepare('UPDATE deployments SET status=?,notes=?,version=?,url=?,finished_at=?,updated_at=? WHERE id=?').run(next.status, next.notes, next.version, next.url, next.finished_at, iso(), row.id);
      audit(user.id, 'DEPLOYMENT_UPDATE', row.id, row.project_id);
    });
    return view(user, load(user, row.id));
  }

  function remove(user, id) {
    const row = load(user, id);
    if (!view(user, row).canDelete) fail(403, 'FORBIDDEN', '只能删除自己手动登记的部署记录');
    transaction(() => { db.prepare('DELETE FROM deployments WHERE id=?').run(row.id); audit(user.id, 'DEPLOYMENT_DELETE', row.id, row.project_id); });
  }

  function sync(user, body) {
    known(body, ['projectId', 'items']);
    const projectId = textField(body.projectId, 'projectId', { max: 80 });
    projectRole(user, projectId);
    if (!Array.isArray(body.items) || body.items.length > SYNC_MAX) fail(400, 'INVALID_INPUT', `items需为最多${SYNC_MAX}条的数组`);
    const rows = body.items.map(item => {
      known(item, SYNC_FIELDS);
      if (!PROVIDERS.includes(item.provider) || item.provider === 'manual') fail(400, 'INVALID_INPUT', 'provider不受支持');
      return {
        provider: item.provider, external_id: textField(item.externalId, 'externalId', { max: 200 }), environment: textField(item.environment, 'environment', { max: 40 }),
        service: textField(item.service, 'service', { max: 120 }), version: optional(item.version, 'version', 200), status: status(item.status), url: link(item.url),
        notes: optional(item.notes, 'notes', 2000), started_at: stamp(item.startedAt, 'startedAt') || fail(400, 'INVALID_INPUT', 'startedAt需要有效时间'), finished_at: stamp(item.finishedAt, 'finishedAt'),
      };
    });
    let created = 0, updated = 0;
    transaction(() => {
      const now = iso();
      for (const row of rows) {
        const existing = db.prepare('SELECT id,status,finished_at FROM deployments WHERE project_id=? AND provider=? AND external_id=?').get(projectId, row.provider, row.external_id);
        if (!existing) {
          db.prepare(`INSERT INTO deployments (id,project_id,provider,external_id,environment,service,version,status,url,notes,actor_id,started_at,finished_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), projectId, row.provider, row.external_id, row.environment, row.service, row.version, row.status, row.url, row.notes, user.id, row.started_at, row.finished_at, now, now);
          created++;
        } else if (existing.status !== row.status || existing.finished_at !== row.finished_at) {
          db.prepare('UPDATE deployments SET status=?,finished_at=?,version=?,url=?,updated_at=? WHERE id=?').run(row.status, row.finished_at, row.version, row.url, now, existing.id);
          updated++;
        }
      }
      if (created || updated) audit(user.id, 'DEPLOYMENT_SYNC', projectId, projectId);
    });
    return { created, updated, unchanged: rows.length - created - updated };
  }

  return function handle({ method, path, url, user, body, send }) {
    if (path === '/api/deployments/sync') {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(200, sync(user, body)); return true;
    }
    if (path === '/api/deployments') {
      browserOnly(user);
      if (method === 'GET') { send(200, list(user, url)); return true; }
      if (method === 'POST') { send(201, { deployment: record(user, body) }); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    const match = path.match(/^\/api\/deployments\/([^/]+)$/);
    if (!match) return false;
    browserOnly(user);
    if (method === 'PATCH') { send(200, { deployment: update(user, match[1], body) }); return true; }
    if (method === 'DELETE') { remove(user, match[1]); send(204); return true; }
    fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
  };
}

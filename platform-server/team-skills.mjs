import { randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';
import { projectPermissions } from './permissions.mjs';

const CONTENT_MAX = 30_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const known = (body, fields) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !fields.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const contentField = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > CONTENT_MAX || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, 'INVALID_INPUT', `Skill 正文需为1至${CONTENT_MAX}字的文本`);
  return value;
};
const descriptionField = value => {
  const text = textField(value, 'description', { max: 500 });
  if (/[\r\n]/.test(text)) fail(400, 'INVALID_INPUT', 'description不能换行');
  return text;
};

export function createTeamSkills({ db, transaction, audit, projectRole }) {
  const iso = () => new Date().toISOString();
  const select = 'SELECT s.*,u.username AS editor_name FROM team_skills s JOIN users u ON u.id=s.updated_by';
  const canManage = (user, projectId) => projectPermissions(user, projectRole(user, projectId)).manageMembers;
  const requireManager = (user, projectId) => { if (!canManage(user, projectId)) fail(403, 'FORBIDDEN', '只有项目负责人和管理员可以发布或修改团队 Skill'); };
  const view = (user, row, withContent) => ({
    id: row.id, projectId: row.project_id, name: row.name, description: row.description, version: row.version, enabled: !!row.enabled,
    updatedByName: row.editor_name, createdAt: row.created_at, updatedAt: row.updated_at, canManage: canManage(user, row.project_id),
    ...(withContent ? { content: row.content } : {}),
  });
  const load = (user, id) => {
    const row = typeof id === 'string' && id.length <= 64 ? db.prepare(`${select} WHERE s.id=?`).get(id) : null;
    if (!row) fail(404, 'SKILL_NOT_FOUND', 'Skill 不存在');
    projectRole(user, row.project_id);
    return row;
  };

  function list(user, url) {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
    projectRole(user, projectId);
    const withContent = url.searchParams.get('include') === 'content';
    const onlyEnabled = user.localDevice || url.searchParams.get('enabled') === '1';
    const rows = db.prepare(`${select} WHERE s.project_id=?${onlyEnabled ? ' AND s.enabled=1' : ''} ORDER BY s.name`).all(projectId);
    return { skills: rows.map(row => view(user, row, withContent)), canManage: canManage(user, projectId) };
  }

  function create(user, body) {
    known(body, ['projectId', 'name', 'description', 'content', 'enabled']);
    const projectId = textField(body.projectId, 'projectId', { max: 80 });
    requireManager(user, projectId);
    const name = textField(body.name, 'name', { max: 63 });
    if (!NAME.test(name)) fail(400, 'INVALID_SKILL_NAME', 'Skill 名称只能用小写字母、数字和连字符');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled需为布尔值');
    if (db.prepare('SELECT id FROM team_skills WHERE project_id=? AND name=?').get(projectId, name)) fail(409, 'SKILL_EXISTS', '该项目已有同名 Skill');
    const id = randomUUID(), now = iso();
    transaction(() => {
      db.prepare('INSERT INTO team_skills (id,project_id,name,description,content,version,enabled,author_id,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, name, descriptionField(body.description), contentField(body.content), 1, body.enabled === false ? 0 : 1, user.id, user.id, now, now);
      audit(user.id, 'SKILL_PUBLISH', id, projectId);
    });
    return view(user, load(user, id), true);
  }

  function update(user, id, body) {
    const row = load(user, id);
    requireManager(user, row.project_id);
    known(body, ['expectedVersion', 'description', 'content', 'enabled']);
    if (!Number.isInteger(body.expectedVersion)) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled需为布尔值');
    const next = {
      description: body.description === undefined ? row.description : descriptionField(body.description),
      content: body.content === undefined ? row.content : contentField(body.content),
      enabled: body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
    };
    transaction(() => {
      const now = iso();
      const current = db.prepare('SELECT * FROM team_skills WHERE id=?').get(row.id);
      if (current.version !== body.expectedVersion) fail(409, 'SKILL_CHANGED', 'Skill 已被他人修改，请刷新后重试');
      if (next.description === current.description && next.content === current.content && next.enabled === current.enabled) return;
      db.prepare('INSERT INTO team_skill_revisions (id,skill_id,version,description,content,enabled,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), current.id, current.version, current.description, current.content, current.enabled, current.updated_by, current.updated_at);
      db.prepare('UPDATE team_skills SET description=?,content=?,enabled=?,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(next.description, next.content, next.enabled, user.id, now, row.id);
      audit(user.id, next.enabled !== current.enabled && next.content === current.content ? (next.enabled ? 'SKILL_ENABLE' : 'SKILL_DISABLE') : 'SKILL_UPDATE', row.id, row.project_id);
    });
    return view(user, load(user, row.id), true);
  }

  function remove(user, id) {
    const row = load(user, id);
    requireManager(user, row.project_id);
    transaction(() => {
      db.prepare('DELETE FROM team_skill_revisions WHERE skill_id=?').run(row.id);
      db.prepare('DELETE FROM team_skills WHERE id=?').run(row.id);
      audit(user.id, 'SKILL_DELETE', row.id, row.project_id);
    });
  }

  function revisions(user, id) {
    const row = load(user, id);
    return db.prepare('SELECT r.version,r.description,r.content,r.enabled,r.created_at,u.username FROM team_skill_revisions r JOIN users u ON u.id=r.actor_id WHERE r.skill_id=? ORDER BY r.version DESC LIMIT 50').all(row.id)
      .map(item => ({ version: item.version, description: item.description, content: item.content, enabled: !!item.enabled, editedBy: item.username, editedAt: item.created_at }));
  }

  return function handle({ method, path, url, user, body, send }) {
    if (path === '/api/skills') {
      if (method === 'GET') { send(200, list(user, url)); return true; }
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取团队 Skill');
      if (method === 'POST') { send(201, { skill: create(user, body) }); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    const match = path.match(/^\/api\/skills\/([^/]+)(\/revisions)?$/);
    if (!match) return false;
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取团队 Skill 列表');
    if (match[2]) {
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
      send(200, { revisions: revisions(user, match[1]) }); return true;
    }
    if (method === 'GET') { send(200, { skill: view(user, load(user, match[1]), true) }); return true; }
    if (method === 'PATCH') { send(200, { skill: update(user, match[1], body) }); return true; }
    if (method === 'DELETE') { remove(user, match[1]); send(204); return true; }
    fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
  };
}

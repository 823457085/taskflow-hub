import { randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';
import { projectPermissions } from './permissions.mjs';

const BODY_MAX = 30_000;
const IMPORT_MAX = 50;
const LIST_MAX = 200;

const known = (body, fields) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !fields.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const bodyField = value => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > BODY_MAX || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, 'INVALID_INPUT', `正文需为不超过${BODY_MAX}字的文本`);
  return value;
};
const tagsField = value => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10 || value.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 30 || /[\x00-\x1f,]/.test(tag))) fail(400, 'INVALID_INPUT', '标签最多10个，每个不超过30字且不含逗号');
  return [...new Set(value.map(tag => tag.trim()))];
};
const like = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export function createKnowledge({ db, transaction, audit, projectRole }) {
  const iso = () => new Date().toISOString();
  const browserOnly = user => { if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取知识库'); };
  const select = 'SELECT k.*,a.username AS author_name,u.username AS editor_name FROM knowledge_docs k JOIN users a ON a.id=k.author_id JOIN users u ON u.id=k.updated_by';
  const view = (user, row, full) => {
    const permissions = projectPermissions(user, projectRole(user, row.project_id));
    return {
      id: row.id, projectId: row.project_id, title: row.title, tags: JSON.parse(row.tags), source: row.source, sourceRef: row.source_ref, version: row.version,
      authorId: row.author_id, authorName: row.author_name, updatedByName: row.editor_name, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(full ? { body: row.body } : { excerpt: row.body.replace(/\s+/g, ' ').slice(0, 200) }),
      canEdit: !user.localDevice, canDelete: !user.localDevice && (row.author_id === user.id || permissions.manageMembers),
    };
  };
  const load = (user, id) => {
    const row = typeof id === 'string' && id.length <= 64 ? db.prepare(`${select} WHERE k.id=?`).get(id) : null;
    if (!row) fail(404, 'KNOWLEDGE_NOT_FOUND', '知识文档不存在');
    projectRole(user, row.project_id);
    return row;
  };
  const revise = (row, actorId, now) => db.prepare('INSERT INTO knowledge_revisions (id,doc_id,version,title,body,tags,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), row.id, row.version, row.title, row.body, row.tags, row.updated_by || actorId, row.updated_at || now);

  function list(user, url) {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
    projectRole(user, projectId);
    const where = ['k.project_id=?'], args = [projectId];
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (query) { where.push("(k.title LIKE ? ESCAPE '\\' OR k.body LIKE ? ESCAPE '\\' OR k.tags LIKE ? ESCAPE '\\')"); args.push(like(query), like(query), like(query)); }
    const tag = (url.searchParams.get('tag') || '').trim();
    if (tag) { where.push("k.tags LIKE ? ESCAPE '\\'"); args.push(like(JSON.stringify(tag))); }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, LIST_MAX);
    const rows = db.prepare(`${select} WHERE ${where.join(' AND ')} ORDER BY k.updated_at DESC LIMIT ?`).all(...args, limit);
    const tags = [...new Set(db.prepare('SELECT tags FROM knowledge_docs WHERE project_id=?').all(projectId).flatMap(row => JSON.parse(row.tags)))].sort();
    return { docs: rows.map(row => view(user, row, false)), tags };
  }

  function create(user, body) {
    known(body, ['projectId', 'title', 'body', 'tags']);
    const projectId = textField(body.projectId, 'projectId', { max: 80 });
    projectRole(user, projectId);
    const now = iso(), id = randomUUID();
    transaction(() => {
      db.prepare('INSERT INTO knowledge_docs (id,project_id,title,body,tags,source,source_ref,version,author_id,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, textField(body.title, 'title', { max: 200 }), bodyField(body.body), JSON.stringify(tagsField(body.tags)), 'manual', null, 1, user.id, user.id, now, now);
      audit(user.id, 'KNOWLEDGE_CREATE', id, projectId);
    });
    return view(user, load(user, id), true);
  }

  function update(user, id, body) {
    const row = load(user, id);
    known(body, ['expectedVersion', 'title', 'body', 'tags']);
    if (!Number.isInteger(body.expectedVersion)) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion');
    const next = {
      title: body.title === undefined ? row.title : textField(body.title, 'title', { max: 200 }),
      body: body.body === undefined ? row.body : bodyField(body.body),
      tags: body.tags === undefined ? row.tags : JSON.stringify(tagsField(body.tags)),
    };
    transaction(() => {
      const now = iso();
      const current = db.prepare('SELECT * FROM knowledge_docs WHERE id=?').get(row.id);
      if (current.version !== body.expectedVersion) fail(409, 'KNOWLEDGE_CHANGED', '文档已被他人修改，请刷新后重试');
      if (next.title === current.title && next.body === current.body && next.tags === current.tags) return;
      revise(current, user.id, now);
      db.prepare('UPDATE knowledge_docs SET title=?,body=?,tags=?,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(next.title, next.body, next.tags, user.id, now, row.id);
      audit(user.id, 'KNOWLEDGE_UPDATE', row.id, row.project_id);
    });
    return view(user, load(user, row.id), true);
  }

  function remove(user, id) {
    const row = load(user, id);
    if (!view(user, row, false).canDelete) fail(403, 'FORBIDDEN', '只有作者或项目负责人可以删除文档');
    transaction(() => {
      db.prepare('DELETE FROM knowledge_revisions WHERE doc_id=?').run(row.id);
      db.prepare('DELETE FROM knowledge_docs WHERE id=?').run(row.id);
      audit(user.id, 'KNOWLEDGE_DELETE', row.id, row.project_id);
    });
  }

  function revisions(user, id) {
    const row = load(user, id);
    return db.prepare('SELECT r.version,r.title,r.body,r.tags,r.created_at,u.username FROM knowledge_revisions r JOIN users u ON u.id=r.actor_id WHERE r.doc_id=? ORDER BY r.version DESC LIMIT 50').all(row.id)
      .map(item => ({ version: item.version, title: item.title, body: item.body, tags: JSON.parse(item.tags), editedBy: item.username, editedAt: item.created_at }));
  }

  function importDocs(user, body) {
    known(body, ['projectId', 'docs']);
    const projectId = textField(body.projectId, 'projectId', { max: 80 });
    projectRole(user, projectId);
    if (!Array.isArray(body.docs) || !body.docs.length || body.docs.length > IMPORT_MAX) fail(400, 'INVALID_INPUT', `docs需为1至${IMPORT_MAX}条的数组`);
    const docs = body.docs.map(doc => {
      known(doc, ['sourceRef', 'title', 'body', 'tags']);
      return { sourceRef: textField(doc.sourceRef, 'sourceRef', { max: 200 }), title: textField(doc.title, 'title', { max: 200 }), body: bodyField(doc.body), tags: JSON.stringify(tagsField(doc.tags)) };
    });
    let created = 0, updated = 0, unchanged = 0;
    transaction(() => {
      const now = iso();
      for (const doc of docs) {
        const existing = db.prepare('SELECT * FROM knowledge_docs WHERE project_id=? AND source_ref=?').get(projectId, doc.sourceRef);
        if (!existing) {
          db.prepare('INSERT INTO knowledge_docs (id,project_id,title,body,tags,source,source_ref,version,author_id,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), projectId, doc.title, doc.body, doc.tags, 'import', doc.sourceRef, 1, user.id, user.id, now, now);
          created++;
        } else if (existing.title !== doc.title || existing.body !== doc.body || existing.tags !== doc.tags) {
          revise(existing, user.id, now);
          db.prepare('UPDATE knowledge_docs SET title=?,body=?,tags=?,version=version+1,updated_by=?,updated_at=? WHERE id=?').run(doc.title, doc.body, doc.tags, user.id, now, existing.id);
          updated++;
        } else unchanged++;
      }
      if (created || updated) audit(user.id, 'KNOWLEDGE_IMPORT', projectId, projectId);
    });
    return { created, updated, unchanged };
  }

  return function handle({ method, path, url, user, body, send }) {
    if (path === '/api/knowledge') {
      if (method === 'GET') { send(200, list(user, url)); return true; }
      browserOnly(user);
      if (method === 'POST') { send(201, { doc: create(user, body) }); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    if (path === '/api/knowledge/import') {
      browserOnly(user);
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(200, importDocs(user, body)); return true;
    }
    const match = path.match(/^\/api\/knowledge\/([^/]+)(\/revisions)?$/);
    if (!match) return false;
    if (match[2]) {
      browserOnly(user);
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
      send(200, { revisions: revisions(user, match[1]) }); return true;
    }
    if (method === 'GET') { send(200, { doc: view(user, load(user, match[1]), true) }); return true; }
    browserOnly(user);
    if (method === 'PATCH') { send(200, { doc: update(user, match[1], body) }); return true; }
    if (method === 'DELETE') { remove(user, match[1]); send(204); return true; }
    fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
  };
}

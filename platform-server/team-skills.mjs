import { randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';
import { globalPermissions, projectPermissions } from './permissions.mjs';
import {
  discoverLocalSkills,
  extractSkillsFromZip,
  normalizeScopes,
  sanitizeAttachmentFiles,
  sanitizeSkillName,
  SKILL_CONTENT_MAX,
  SKILL_PRESETS,
  SKILL_SCOPES,
} from './skill-bundles.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SOURCES = ['manual', 'preset', 'local', 'file', 'json', 'zip'];

const known = (body, fields) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => !fields.includes(name))) {
    fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
  }
};
const contentField = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > SKILL_CONTENT_MAX || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    fail(400, 'INVALID_INPUT', `Skill 正文需为1至${SKILL_CONTENT_MAX}字的文本`);
  }
  return value;
};
const descriptionField = value => {
  const text = textField(value, 'description', { max: 500 });
  if (/[\r\n]/.test(text)) fail(400, 'INVALID_INPUT', 'description不能换行');
  return text;
};
const parseJsonArray = (raw, fallback = []) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};
const sourceField = value => {
  if (value === undefined || value === null || value === '') return 'manual';
  const s = String(value).trim().toLowerCase();
  return SOURCES.includes(s) ? s : 'manual';
};
const visibilityField = value => {
  if (value === undefined || value === null || value === '') return 'TEAM';
  const v = String(value).trim().toUpperCase();
  if (!['TEAM', 'PERSONAL'].includes(v)) fail(400, 'INVALID_INPUT', 'visibility 需为 TEAM 或 PERSONAL');
  return v;
};

export function projectSkillRows(db, projectId, { ownerId = null, onlyEnabled = false } = {}) {
  return db.prepare(`SELECT s.*,u.username AS editor_name
    FROM project_skill_links link JOIN skill_catalog s ON s.id=link.skill_id
    JOIN users u ON u.id=s.updated_by
    WHERE link.project_id=? AND (s.visibility='TEAM' OR s.owner_id=?)
    ${onlyEnabled ? ' AND s.enabled=1' : ''} ORDER BY s.updated_at DESC`).all(projectId, ownerId);
}

const titleField = value => {
  const title = textField(value, 'title', { max: 120 });
  if (/[\r\n]/.test(title)) fail(400, 'INVALID_INPUT', 'Skill 标题不能换行');
  return title;
};
const sorted = rows => rows.sort((a, b) => a.name.localeCompare(b.name) || b.visibility.localeCompare(a.visibility));

export function createTeamSkills({ db, transaction, audit, projectRole, visibleProjects, workspaceFor = null, serverMode = false }) {
  const iso = () => new Date().toISOString();
  const select = 'SELECT s.*,u.username AS editor_name FROM skill_catalog s JOIN users u ON u.id=s.updated_by';
  const globalManager = user => globalPermissions(user).manageUsers;
  const projectManager = (user, projectId) => projectPermissions(user, projectRole(user, projectId)).manageMembers;
  const requireManager = (user, projectId) => {
    if (!(projectId ? projectManager(user, projectId) : globalManager(user))) {
      fail(403, 'FORBIDDEN', projectId ? '只有项目负责人和管理员可以添加团队共享 Skill' : '只有管理员可以添加共享 Skill');
    }
  };
  const get = id => db.prepare(`${select} WHERE s.id=?`).get(id);
  const canManageSkill = (user, row, projects) => row.visibility === 'PERSONAL'
    ? row.owner_id === user.id
    : globalManager(user) || !!projects.get(row.source_project_id)?.permissions.manageMembers;
  const allProjects = user => new Map(visibleProjects(user).map(project => [project.id, project]));

  function canReadSkill(user, row, projects) {
    if (row.visibility === 'PERSONAL') return row.owner_id === user.id;
    if (globalManager(user) || !row.source_project_id || projects.has(row.source_project_id)) return true;
    return db.prepare('SELECT project_id FROM project_skill_links WHERE skill_id=?').all(row.id)
      .some(link => projects.has(link.project_id));
  }

  function load(user, id, projects, missingMessage = 'Skill 不存在') {
    const row = typeof id === 'string' && id.length <= 64 ? get(id) : null;
    if (!row || !canReadSkill(user, row, projects)) fail(404, 'SKILL_NOT_FOUND', missingMessage);
    return row;
  }

  function view(user, row, projects, { withContent = false, projectId = null, canManageTeam = false } = {}) {
    const files = parseJsonArray(row.files);
    return {
      id: row.id, projectId: projectId || row.source_project_id,
      name: row.name, title: row.title, description: row.description,
      scopes: parseJsonArray(row.scopes), source: row.source || 'manual', visibility: row.visibility,
      fileCount: files.length, version: row.version, enabled: !!row.enabled, updatedByName: row.editor_name,
      createdAt: row.created_at, updatedAt: row.updated_at,
      canManage: !user.localDevice && canManageSkill(user, row, projects),
      ...(projectId ? { canUnlink: !user.localDevice && (row.visibility === 'PERSONAL' ? row.owner_id === user.id : canManageTeam) } : {}),
      ...(withContent ? { content: row.content, files } : {}),
    };
  }

  function catalogRows(user, projects) {
    return db.prepare(`${select} WHERE s.visibility='TEAM' OR s.owner_id=?`).all(user.id)
      .filter(row => canReadSkill(user, row, projects));
  }

  function list(user, url, library = false) {
    const projectId = library ? null : url.searchParams.get('projectId');
    if (!library && !projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
    const canManage = projectId ? projectManager(user, projectId) : globalManager(user);
    const projects = user.localDevice ? new Map() : allProjects(user);
    const withContent = url.searchParams.get('include') === 'content';
    const onlyEnabled = user.localDevice || url.searchParams.get('enabled') === '1';
    const scopeFilter = url.searchParams.get('scope')?.trim().toUpperCase() || '';
    const rows = projectId
      ? projectSkillRows(db, projectId, { ownerId: user.localDevice ? null : user.id, onlyEnabled })
      : catalogRows(user, projects);
    const items = rows.filter(row => !onlyEnabled || row.enabled)
      .map(row => view(user, row, projects, { projectId, withContent, canManageTeam: canManage }));
    return {
      skills: sorted(scopeFilter ? items.filter(item => !item.scopes.length || item.scopes.includes(scopeFilter)) : items),
      canManage,
      scopes: SKILL_SCOPES,
      localDiscoverEnabled: !serverMode && !user.localDevice,
    };
  }

  function conflict(projectId, name, visibility, ownerId) {
    if (projectId) {
      return db.prepare(`SELECT s.* FROM project_skill_links link JOIN skill_catalog s ON s.id=link.skill_id
        WHERE link.project_id=? AND s.name=? AND s.visibility=? AND (s.visibility='TEAM' OR s.owner_id=?)`)
        .get(projectId, name, visibility, ownerId);
    }
    return db.prepare(`SELECT * FROM skill_catalog WHERE source_project_id IS NULL AND name=? AND visibility=?
      AND (visibility='TEAM' OR owner_id=?)`).get(name, visibility, ownerId);
  }

  function fields(raw, name, importing = false) {
    return {
      title: raw.title === undefined ? name : titleField(raw.title),
      description: descriptionField(importing ? raw.description || name : raw.description),
      content: contentField(raw.content),
      enabled: raw.enabled === false ? 0 : 1,
      scopes: JSON.stringify(normalizeScopes(raw.scopes)),
      files: JSON.stringify(sanitizeAttachmentFiles(raw.files)),
      source: sourceField(importing ? raw.source || 'file' : raw.source),
    };
  }

  const addLink = (projectId, id) => db.prepare('INSERT INTO project_skill_links (project_id,skill_id) VALUES (?,?)').run(projectId, id);
  function insert(user, projectId, visibility, name, value) {
    const id = randomUUID();
    const now = iso();
    db.prepare(`INSERT INTO skill_catalog (id,source_project_id,owner_id,visibility,name,title,description,content,enabled,scopes,files,source,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, user.id, visibility, name, value.title, value.description, value.content, value.enabled, value.scopes, value.files, value.source, user.id, now, now);
    if (projectId) addLink(projectId, id);
    audit(user.id, 'SKILL_PUBLISH', id, projectId);
    return id;
  }

  function replace(user, current, next) {
    if (Object.keys(next).every(key => next[key] === current[key])) return;
    if (current.visibility === 'TEAM') {
      db.prepare(`INSERT INTO skill_catalog_revisions (id,skill_id,version,title,description,content,enabled,scopes,files,actor_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), current.id, current.version, current.title, current.description, current.content,
          current.enabled, current.scopes, current.files, current.updated_by, current.updated_at);
    }
    db.prepare(`UPDATE skill_catalog SET title=?,description=?,content=?,enabled=?,scopes=?,files=?,source=?,version=version+1,updated_by=?,updated_at=? WHERE id=?`)
      .run(next.title, next.description, next.content, next.enabled, next.scopes, next.files, next.source, user.id, iso(), current.id);
    const onlyToggle = next.enabled !== current.enabled && Object.keys(next).every(key => key === 'enabled' || next[key] === current[key]);
    audit(user.id, onlyToggle ? (next.enabled ? 'SKILL_ENABLE' : 'SKILL_DISABLE') : 'SKILL_UPDATE', current.id, current.source_project_id);
  }

  function create(user, body, library = false) {
    known(body, ['name', 'title', 'description', 'content', 'enabled', 'scopes', 'files', 'visibility', 'source', ...(library ? [] : ['projectId'])]);
    const projectId = library ? null : textField(body.projectId, 'projectId', { max: 80 });
    const visibility = visibilityField(body.visibility);
    if (visibility === 'TEAM') requireManager(user, projectId);
    else if (projectId) projectRole(user, projectId);
    const name = textField(body.name, 'name', { max: 63 });
    if (!NAME.test(name)) fail(400, 'INVALID_SKILL_NAME', 'Skill 标识只能用小写字母、数字和连字符');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled需为布尔值');
    const value = fields(body, name);
    const id = transaction(() => {
      if (conflict(projectId, name, visibility, user.id)) fail(409, 'SKILL_EXISTS', '已经有相同标识的 Skill');
      return insert(user, projectId, visibility, name, value);
    });
    return view(user, get(id), allProjects(user), { withContent: true });
  }

  function update(user, id, body) {
    known(body, ['expectedVersion', 'title', 'description', 'content', 'enabled', 'scopes', 'files']);
    if (!Number.isInteger(body.expectedVersion)) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled需为布尔值');
    const projects = allProjects(user);
    transaction(() => {
      const current = load(user, id, projects);
      if (!canManageSkill(user, current, projects)) fail(403, 'FORBIDDEN', '当前账号无权修改此 Skill');
      if (current.version !== body.expectedVersion) fail(409, 'SKILL_CHANGED', 'Skill 已被他人修改，请刷新后重试');
      replace(user, current, {
        title: body.title === undefined ? current.title : titleField(body.title),
        description: body.description === undefined ? current.description : descriptionField(body.description),
        content: body.content === undefined ? current.content : contentField(body.content),
        enabled: body.enabled === undefined ? current.enabled : body.enabled ? 1 : 0,
        scopes: body.scopes === undefined ? current.scopes : JSON.stringify(normalizeScopes(body.scopes)),
        files: body.files === undefined ? current.files : JSON.stringify(sanitizeAttachmentFiles(body.files)),
        source: current.source,
      });
    });
    return view(user, get(id), projects, { withContent: true });
  }

  function remove(user, id) {
    const projects = allProjects(user);
    transaction(() => {
      const row = load(user, id, projects);
      if (!canManageSkill(user, row, projects)) fail(403, 'FORBIDDEN', '当前账号无权删除此 Skill');
      db.prepare('DELETE FROM skill_catalog WHERE id=?').run(id);
      audit(user.id, 'SKILL_DELETE', id, row.source_project_id);
    });
  }

  function revisions(user, id) {
    load(user, id, allProjects(user));
    return db.prepare(`SELECT r.version,r.title,r.description,r.content,r.enabled,r.scopes,r.created_at,u.username
      FROM skill_catalog_revisions r JOIN users u ON u.id=r.actor_id WHERE r.skill_id=? ORDER BY r.version DESC LIMIT 50`).all(id)
      .map(item => ({
        version: item.version, title: item.title, description: item.description, content: item.content,
        scopes: parseJsonArray(item.scopes), enabled: !!item.enabled, editedBy: item.username, editedAt: item.created_at,
      }));
  }

  function batchImport(user, body, library = false) {
    known(body, ['visibility', 'mode', 'items', ...(library ? [] : ['projectId'])]);
    const projectId = library ? null : textField(body.projectId, 'projectId', { max: 80 });
    const visibility = visibilityField(body.visibility);
    if (visibility === 'TEAM') requireManager(user, projectId);
    else if (projectId) projectRole(user, projectId);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
      fail(400, 'INVALID_INPUT', '请提供 1 至 50 条待导入的 Skill');
    }

    const imported = [], updated = [], skipped = [];
    transaction(() => {
      for (const raw of body.items) {
        if (!raw || typeof raw !== 'object') fail(400, 'INVALID_INPUT', '导入项格式不正确');
        const name = sanitizeSkillName(raw.name, '');
        if (!NAME.test(name)) fail(400, 'INVALID_SKILL_NAME', `Skill 标识无效：${String(raw.name || '')}`);
        const value = fields(raw, name, true);
        const current = conflict(projectId, name, visibility, user.id);
        if (current) {
          if (body.mode !== 'overwrite') { skipped.push(name); continue; }
          if (current.source_project_id !== projectId) fail(409, 'SKILL_LINKED', '同名 Skill 来自 Skills 库，请在库中编辑');
          if (raw.title === undefined) value.title = current.title;
          replace(user, current, value);
          updated.push(name);
        } else {
          insert(user, projectId, visibility, name, value);
          imported.push(name);
        }
      }
    });
    return { imported, updated, skipped, count: imported.length + updated.length };
  }

  function existingNames(user, projectId, library) {
    const rows = projectId ? projectSkillRows(db, projectId, { ownerId: user.id })
      : library ? catalogRows(user, allProjects(user)).filter(row => row.source_project_id === null) : [];
    return new Set(rows.map(row => row.name));
  }

  function localDiscover(user, url) {
    if (serverMode) fail(403, 'LOCAL_ONLY', '服务器部署模式下不支持扫描本机 Skill 目录，请使用上传 .zip / .md / JSON 配置导入');
    const library = url.searchParams.get('library') === '1';
    const projectId = library ? null : url.searchParams.get('projectId');
    if (projectId) projectRole(user, projectId);
    const repoPath = projectId ? workspaceFor?.(user.id, projectId)?.repoPath || null : null;
    const names = existingNames(user, projectId, library);
    return { skills: discoverLocalSkills(repoPath).map(item => ({ ...item, alreadyExists: names.has(item.name) })) };
  }

  function parseZip(user, body) {
    known(body, ['projectId', 'library', 'filename', 'zipBase64']);
    if (body.library !== undefined && typeof body.library !== 'boolean') fail(400, 'INVALID_INPUT', 'library需为布尔值');
    const projectId = !body.library && body.projectId ? textField(body.projectId, 'projectId', { max: 80 }) : null;
    if (projectId) projectRole(user, projectId);
    const names = existingNames(user, projectId, body.library);
    const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim().slice(0, 200) : 'skill-bundle.zip';
    if (typeof body.zipBase64 !== 'string' || !body.zipBase64.trim()) fail(400, 'INVALID_INPUT', '请提供 ZIP 文件内容');
    const cleaned = body.zipBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    return { skills: extractSkillsFromZip(Buffer.from(cleaned, 'base64'), filename).map(item => ({
      ...item, alreadyExists: names.has(item.name),
    })) };
  }

  function exportConfig(user, url, library = false) {
    const projectId = library ? null : url.searchParams.get('projectId');
    if (!library && !projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
    if (projectId) projectRole(user, projectId);
    const rows = projectId ? projectSkillRows(db, projectId, { ownerId: user.id }) : catalogRows(user, allProjects(user));
    return {
      format: 'taskflow-skills-v1',
      exportedAt: iso(),
      ...(projectId ? { projectId } : {}),
      skills: sorted(rows).map(row => ({
        name: row.name, title: row.title, description: row.description,
        scopes: parseJsonArray(row.scopes), enabled: !!row.enabled, visibility: row.visibility,
        content: row.content, files: parseJsonArray(row.files),
      })),
    };
  }

  function projectSettings(user, projectId) {
    const canManageTeam = projectManager(user, projectId);
    const projects = allProjects(user);
    const rows = projectSkillRows(db, projectId, { ownerId: user.id });
    const key = row => `${row.visibility}:${row.name}`;
    const linked = new Set(rows.map(key));
    const available = catalogRows(user, projects).filter(row =>
      !linked.has(key(row)) && (row.visibility === 'PERSONAL' || canManageTeam && (!row.source_project_id || canManageSkill(user, row, projects))));
    return {
      skills: sorted(rows.map(row => view(user, row, projects, { projectId, canManageTeam }))),
      available: sorted(available.map(row => view(user, row, projects))),
      canManageTeam,
    };
  }

  function changeProjectLink(user, projectId, row, attach, { projects, canManageTeam }) {
    if (row.visibility === 'TEAM' && (!canManageTeam || attach && row.source_project_id && !canManageSkill(user, row, projects))) {
      fail(403, 'FORBIDDEN', `当前账号无权在该项目管理共享 Skill「${row.title}」`);
    }
    const linked = db.prepare('SELECT 1 FROM project_skill_links WHERE project_id=? AND skill_id=?').get(projectId, row.id);
    if (attach && !linked) {
      if (conflict(projectId, row.name, row.visibility, row.owner_id)) {
        fail(409, 'SKILL_EXISTS', `同一项目只能关联一个标识为「${row.name}」的同类 Skill`);
      }
      addLink(projectId, row.id);
      audit(user.id, 'SKILL_LINK', row.id, projectId);
      return true;
    }
    if (!attach && linked) {
      db.prepare('DELETE FROM project_skill_links WHERE project_id=? AND skill_id=?').run(projectId, row.id);
      audit(user.id, 'SKILL_UNLINK', row.id, projectId);
    }
    return false;
  }

  function setProjectLink(user, projectId, id, attach) {
    return transaction(() => {
      const canManageTeam = projectManager(user, projectId);
      const projects = allProjects(user);
      const row = load(user, id, projects);
      changeProjectLink(user, projectId, row, attach, { projects, canManageTeam });
      return view(user, row, projects, { projectId, canManageTeam });
    });
  }

  function addProjectLinks(user, projectId, body) {
    known(body, ['skillIds']);
    const { skillIds } = body;
    if (!Array.isArray(skillIds) || !skillIds.length || skillIds.length > 100) {
      fail(400, 'INVALID_INPUT', '请选择 1 至 100 个 Skill');
    }
    const selected = new Map();
    for (const [index, id] of skillIds.entries()) {
      if (typeof id !== 'string' || !id.length || id.length > 64 || /[\s\x00-\x1f\x7f]/.test(id)) {
        fail(400, 'INVALID_INPUT', `第 ${index + 1} 个 Skill 标识无效`);
      }
      if (!selected.has(id)) selected.set(id, index + 1);
    }
    return transaction(() => {
      const canManageTeam = projectManager(user, projectId);
      const projects = allProjects(user);
      let linkedCount = 0;
      for (const [id, position] of selected) {
        const row = load(user, id, projects, `第 ${position} 个 Skill 不存在或不可访问`);
        if (changeProjectLink(user, projectId, row, true, { projects, canManageTeam })) linkedCount++;
      }
      return { ...projectSettings(user, projectId), linkedCount };
    });
  }

  function resolveActiveSkills(user, projectId, targetScopes = [], explicitSkillIds = null) {
    if (!projectId) return [];
    const all = projectSkillRows(db, projectId, { ownerId: user?.localDevice ? null : user?.id, onlyEnabled: true })
      .map(row => ({ ...row, scopes: parseJsonArray(row.scopes), files: parseJsonArray(row.files) }));
    const scopeSet = new Set(Array.isArray(targetScopes) ? targetScopes : []);
    const idSet = new Set(Array.isArray(explicitSkillIds) ? explicitSkillIds : []);
    const filtered = idSet.size ? all.filter(s => idSet.has(s.id) || idSet.has(s.name))
      : all.filter(s => !scopeSet.size || !s.scopes.length || s.scopes.some(scope => scopeSet.has(scope)));
    const byName = new Map();
    for (const skill of filtered) {
      const previous = byName.get(skill.name);
      if (!previous || previous.visibility === 'TEAM' && skill.visibility === 'PERSONAL') byName.set(skill.name, skill);
    }
    return [...byName.values()]
      .sort((a, b) => Number(!a.scopes.length) - Number(!b.scopes.length) || b.updated_at.localeCompare(a.updated_at))
      .slice(0, 6);
  }

  function handle({ method, path, url, user, body, send }) {
    const projectRoute = path.match(/^\/api\/projects\/([^/]+)\/skills(?:\/([^/]+))?$/);
    if (projectRoute) {
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取团队 Skill');
      const [, projectId, skillId] = projectRoute;
      if (!skillId && method === 'GET') { send(200, projectSettings(user, projectId)); return true; }
      if (!skillId && method === 'POST') { send(200, addProjectLinks(user, projectId, body)); return true; }
      if (skillId && method === 'POST') { send(200, { skill: setProjectLink(user, projectId, skillId, true) }); return true; }
      if (skillId && method === 'DELETE') { setProjectLink(user, projectId, skillId, false); send(204); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    const library = path === '/api/skills/library' || path.startsWith('/api/skills/library/');
    const route = library ? path.replace('/api/skills/library', '/api/skills') : path;
    if (library && user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取团队 Skill');
    if (route === '/api/skills') {
      if (method === 'GET') { send(200, list(user, url, library)); return true; }
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取团队 Skill');
      if (method === 'POST') { send(201, { skill: create(user, body, library) }); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    if (route === '/api/skills/import' || route === '/api/skills/export') {
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备不支持导入或导出');
      if (route.endsWith('/import') && method === 'POST') { send(200, batchImport(user, body, library)); return true; }
      if (route.endsWith('/export') && method === 'GET') { send(200, exportConfig(user, url, library)); return true; }
      fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
    }
    if (library) return false;
    if (path === '/api/skills/presets') {
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
      send(200, { presets: SKILL_PRESETS, scopes: SKILL_SCOPES });
      return true;
    }
    if (path === '/api/skills/local-discover') {
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备不支持扫描导入');
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
      send(200, localDiscover(user, url));
      return true;
    }
    if (path === '/api/skills/parse-zip') {
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备不支持导入');
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      send(200, parseZip(user, body));
      return true;
    }
    const match = path.match(/^\/api\/skills\/([^/]+)(\/revisions)?$/);
    if (!match) return false;
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备只能读取团队 Skill 列表');
    if (match[2]) {
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
      send(200, { revisions: revisions(user, match[1]) });
      return true;
    }
    if (method === 'GET') {
      const projects = allProjects(user);
      send(200, { skill: view(user, load(user, match[1], projects), projects, { withContent: true }) });
      return true;
    }
    if (method === 'PATCH') { send(200, { skill: update(user, match[1], body) }); return true; }
    if (method === 'DELETE') { remove(user, match[1]); send(204); return true; }
    fail(405, 'METHOD_NOT_ALLOWED', '该操作不支持');
  }

  handle.resolveActiveSkills = resolveActiveSkills;
  return handle;
}

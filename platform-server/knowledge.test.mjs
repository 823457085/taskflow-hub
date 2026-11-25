import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';

const password = 'knowledge-test-passphrase';
const setupToken = 'knowledge-setup-token';

async function startHub() {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-knowledge-'));
  let offset = 0;
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), logger: { error() {} }, deployment: 'server', setupToken, deviceClock: () => Date.now() + offset });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => {
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const body = await response.json();
    return { token: body.token, user: body.user, post: { Cookie: response.headers.get('set-cookie').split(';')[0], Origin: base } };
  };
  const pair = async (member, projectIds) => {
    const start = await call('/api/device-authorizations', 'POST', { deviceName: 'mac', tool: 'custom' });
    await call('/api/device-authorizations/decision', 'POST', { userCode: start.body.userCode, decision: 'APPROVE', projectIds }, undefined, member.post);
    offset += 3100;
    return (await call('/api/device-authorizations/poll', 'POST', { deviceCode: start.body.deviceCode })).body.token;
  };
  await call('/api/setup', 'POST', { username: 'admin', password, setupToken });
  const admin = await login('admin');
  for (const [username, role] of [['dev', 'DEV'], ['peer', 'DEV']]) await call('/api/users', 'POST', { username, password, role }, admin.token);
  const secret = (await call('/api/projects', 'POST', { key: 'SECRET', name: 'Secret' }, admin.token)).body.project;
  return { call, pair, admin, secret, dev: await login('dev'), peer: await login('peer'), close: async () => { await platform.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('project knowledge base supports versioned collaborative edits, search, idempotent import and read-only device access', async () => {
  const hub = await startHub();
  const { call, dev, peer, admin, secret } = hub;
  try {
    assert.equal((await call('/api/knowledge?projectId=default')).status, 401);
    assert.equal((await call(`/api/knowledge?projectId=${secret.id}`, 'GET', undefined, dev.token)).status, 403);
    assert.equal((await call('/api/knowledge', 'POST', { projectId: 'default', title: 'x', tags: ['a,b'] }, dev.token)).status, 400);
    const doc = (await call('/api/knowledge', 'POST', { projectId: 'default', title: '支付回调排查手册', body: '# 步骤\n先看 notify 日志', tags: ['支付', 'SOP'] }, dev.token)).body.doc;
    assert.deepEqual([doc.version, doc.authorName, doc.canDelete, doc.tags], [1, 'dev', true, ['支付', 'SOP']]);

    const edited = (await call(`/api/knowledge/${doc.id}`, 'PATCH', { expectedVersion: 1, body: '# 步骤\n先看 notify 日志\n再核对签名' }, peer.token)).body.doc;
    assert.deepEqual([edited.version, edited.updatedByName, edited.canDelete], [2, 'peer', false]);
    assert.equal((await call(`/api/knowledge/${doc.id}`, 'PATCH', { expectedVersion: 1, title: '冲突' }, dev.token)).body.error.code, 'KNOWLEDGE_CHANGED');
    assert.equal((await call(`/api/knowledge/${doc.id}`, 'PATCH', { expectedVersion: 2, body: edited.body }, dev.token)).body.doc.version, 2);
    const history = (await call(`/api/knowledge/${doc.id}/revisions`, 'GET', undefined, dev.token)).body.revisions;
    assert.deepEqual(history.map(item => [item.version, item.editedBy, item.body]), [[1, 'dev', '# 步骤\n先看 notify 日志']]);

    const listed = (await call('/api/knowledge?projectId=default&q=签名', 'GET', undefined, dev.token)).body;
    assert.deepEqual(listed.docs.map(item => item.title), ['支付回调排查手册']);
    assert.equal(listed.docs[0].body, undefined);
    assert.deepEqual(listed.tags, ['SOP', '支付']);
    assert.equal((await call('/api/knowledge?projectId=default&tag=SOP', 'GET', undefined, dev.token)).body.docs.length, 1);
    assert.equal((await call('/api/knowledge?projectId=default&tag=SO', 'GET', undefined, dev.token)).body.docs.length, 0);

    const docs = [{ sourceRef: 'catalog:sample', title: 'SAMPLE 系统', body: '仓库：example-web', tags: ['系统目录'] }, { sourceRef: 'catalog:shop', title: '商城', body: '', tags: [] }];
    assert.deepEqual((await call('/api/knowledge/import', 'POST', { projectId: 'default', docs }, dev.token)).body, { created: 2, updated: 0, unchanged: 0 });
    assert.deepEqual((await call('/api/knowledge/import', 'POST', { projectId: 'default', docs: [{ ...docs[0], body: '仓库：example-web\n环境：pre' }, docs[1]] }, dev.token)).body, { created: 0, updated: 1, unchanged: 1 });

    const device = await hub.pair(dev, ['default']);
    assert.equal((await call('/api/knowledge?projectId=default&q=SAMPLE', 'GET', undefined, device)).body.docs.length, 1);
    const fromDevice = (await call(`/api/knowledge/${doc.id}`, 'GET', undefined, device)).body.doc;
    assert.deepEqual([fromDevice.canEdit, fromDevice.body.includes('签名')], [false, true]);
    assert.equal((await call('/api/knowledge', 'POST', { projectId: 'default', title: 'x' }, device)).status, 403);
    assert.equal((await call('/api/knowledge/import', 'POST', { projectId: 'default', docs }, device)).status, 403);
    assert.equal((await call(`/api/knowledge/${doc.id}/revisions`, 'GET', undefined, device)).status, 403);
    assert.equal((await call(`/api/knowledge?projectId=${secret.id}`, 'GET', undefined, device)).status, 403);

    assert.equal((await call(`/api/knowledge/${doc.id}`, 'DELETE', undefined, peer.token)).status, 403);
    assert.equal((await call(`/api/knowledge/${doc.id}`, 'DELETE', undefined, admin.token)).status, 204);
    assert.equal((await call(`/api/knowledge/${doc.id}`, 'GET', undefined, dev.token)).status, 404);
    const actions = (await call('/api/audit', 'GET', undefined, admin.token)).body.audit.map(row => row.action);
    for (const action of ['KNOWLEDGE_CREATE', 'KNOWLEDGE_UPDATE', 'KNOWLEDGE_IMPORT', 'KNOWLEDGE_DELETE']) assert.ok(actions.includes(action), action);
  } finally { await hub.close(); }
});

test('team skills are published by project leads, versioned, and only enabled skills reach paired devices', async () => {
  const hub = await startHub();
  const { call, dev, admin } = hub;
  try {
    const skill = { projectId: 'default', name: 'pay-review', description: '支付代码评审清单', content: '# 支付评审\n- 金额用整数分' };
    assert.equal((await call('/api/skills', 'POST', skill, dev.token)).status, 403);
    assert.equal((await call('/api/skills', 'POST', { ...skill, name: 'Bad Name' }, admin.token)).body.error.code, 'INVALID_SKILL_NAME');
    assert.equal((await call('/api/skills', 'POST', { ...skill, description: '多行\n描述' }, admin.token)).status, 400);
    const created = (await call('/api/skills', 'POST', skill, admin.token)).body.skill;
    assert.deepEqual([created.version, created.enabled], [1, true]);
    assert.equal((await call('/api/skills', 'POST', skill, admin.token)).body.error.code, 'SKILL_EXISTS');
    const draft = (await call('/api/skills', 'POST', { ...skill, name: 'draft-skill', enabled: false }, admin.token)).body.skill;

    const memberView = (await call('/api/skills?projectId=default', 'GET', undefined, dev.token)).body;
    assert.deepEqual([memberView.canManage, memberView.skills.map(item => item.name), memberView.skills[0].content], [false, ['draft-skill', 'pay-review'], undefined]);
    assert.equal((await call(`/api/skills/${created.id}`, 'PATCH', { expectedVersion: 1, content: 'x' }, dev.token)).status, 403);

    const updated = (await call(`/api/skills/${created.id}`, 'PATCH', { expectedVersion: 1, content: '# 支付评审\n- 金额用整数分\n- 幂等键必填' }, admin.token)).body.skill;
    assert.equal(updated.version, 2);
    assert.equal((await call(`/api/skills/${created.id}`, 'PATCH', { expectedVersion: 1, enabled: false }, admin.token)).body.error.code, 'SKILL_CHANGED');
    assert.deepEqual((await call(`/api/skills/${created.id}/revisions`, 'GET', undefined, dev.token)).body.revisions.map(item => item.version), [1]);

    const device = await hub.pair(dev, ['default']);
    const synced = (await call('/api/skills?projectId=default&include=content', 'GET', undefined, device)).body.skills;
    assert.deepEqual(synced.map(item => [item.name, item.version, item.content.includes('幂等键')]), [['pay-review', 2, true]]);
    assert.equal((await call(`/api/skills/${created.id}`, 'GET', undefined, device)).status, 403);
    assert.equal((await call('/api/skills', 'POST', skill, device)).status, 403);

    assert.equal((await call(`/api/skills/${draft.id}`, 'DELETE', undefined, dev.token)).status, 403);
    assert.equal((await call(`/api/skills/${draft.id}`, 'DELETE', undefined, admin.token)).status, 204);
    const actions = (await call('/api/audit', 'GET', undefined, admin.token)).body.audit.map(row => row.action);
    for (const action of ['SKILL_PUBLISH', 'SKILL_UPDATE', 'SKILL_DELETE']) assert.ok(actions.includes(action), action);
  } finally { await hub.close(); }
});

test('skills support scene scopes, personal visibility, zip bundle parsing with references, batch import/export and presets', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const makeZip = entries => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, content } of entries) {
      const nameBuf = Buffer.from(name, 'utf8');
      const raw = Buffer.from(content, 'utf8');
      const comp = deflateRawSync(raw);
      const local = Buffer.alloc(30 + nameBuf.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(comp.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(local, 30);
      locals.push(local, comp);

      const cd = Buffer.alloc(46 + nameBuf.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(comp.length, 20);
      cd.writeUInt32LE(raw.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);
      nameBuf.copy(cd, 46);
      centrals.push(cd);
      offset += local.length + comp.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
  };

  const hub = await startHub();
  const { call, dev, admin } = hub;
  try {
    const presetsRes = await call('/api/skills/presets', 'GET', undefined, dev.token);
    assert.equal(presetsRes.status, 200);
    assert.ok(presetsRes.body.presets.some(p => p.scopes.includes('TECH_SPEC_GEN')));
    assert.ok(presetsRes.body.presets.some(p => p.scopes.includes('JIRA_GEN')));

    const zipBuf = makeZip([
      {
        name: 'frontend-review-share/frontend-code-review/SKILL.md',
        content: '---\nname: frontend-code-review\ndescription: 审查前端代码、PR/MR 质量与门禁；纯需求/技术方案评审不自动触发。\n---\n# 前端代码 Review\n读取 references/quality-rules.md。',
      },
      {
        name: 'frontend-review-share/frontend-code-review/references/quality-rules.md',
        content: '# 通用质量规则\n- 禁止重复实现',
      },
    ]);
    const parsed = await call('/api/skills/parse-zip', 'POST', {
      projectId: 'default',
      filename: 'frontend-review-share.zip',
      zipBase64: zipBuf.toString('base64'),
    }, dev.token);
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.skills.length, 1);
    assert.equal(parsed.body.skills[0].name, 'frontend-code-review');
    assert.deepEqual(parsed.body.skills[0].scopes, ['CODE_REVIEW']);
    assert.equal(parsed.body.skills[0].files.length, 1);
    assert.equal(parsed.body.skills[0].files[0].path, 'references/quality-rules.md');

    // DEV cannot batch-import TEAM skills, but CAN batch-import PERSONAL skills
    const deniedTeam = await call('/api/skills/import', 'POST', {
      projectId: 'default',
      visibility: 'TEAM',
      items: parsed.body.skills,
    }, dev.token);
    assert.equal(deniedTeam.status, 403);

    const personalImp = await call('/api/skills/import', 'POST', {
      projectId: 'default',
      visibility: 'PERSONAL',
      items: parsed.body.skills,
    }, dev.token);
    assert.equal(personalImp.status, 200);
    assert.deepEqual(personalImp.body.imported, ['frontend-code-review']);

    // Personal skill is visible to DEV, hidden from ADMIN and paired devices
    const devList = await call('/api/skills?projectId=default&scope=CODE_REVIEW', 'GET', undefined, dev.token);
    assert.deepEqual(devList.body.skills.map(s => [s.name, s.visibility, s.fileCount]), [['frontend-code-review', 'PERSONAL', 1]]);
    const adminList = await call('/api/skills?projectId=default', 'GET', undefined, admin.token);
    assert.equal(adminList.body.skills.length, 0);

    // ADMIN batch-imports presets into TEAM, then exports portable config
    const teamImp = await call('/api/skills/import', 'POST', {
      projectId: 'default',
      visibility: 'TEAM',
      items: presetsRes.body.presets.slice(0, 3),
    }, admin.token);
    assert.equal(teamImp.status, 200);
    assert.equal(teamImp.body.imported.length, 3);

    const exported = await call('/api/skills/export?projectId=default', 'GET', undefined, dev.token);
    assert.equal(exported.status, 200);
    assert.equal(exported.body.format, 'taskflow-skills-v1');
    assert.equal(exported.body.skills.length, 4); // 3 TEAM + 1 DEV PERSONAL
  } finally { await hub.close(); }
});

test('skills library keeps titles and identities independent from project links', async () => {
  const hub = await startHub();
  const { call, dev, peer, admin, secret } = hub;
  try {
    const input = { name: 'shared-review', title: '代码评审规范', description: '验证范围', content: '# 规则', scopes: ['CODE_REVIEW'] };
    const legacy = (await call('/api/skills', 'POST', { ...input, projectId: secret.id }, admin.token)).body.skill;
    assert.equal((await call('/api/skills/library', 'GET', undefined, dev.token)).body.skills.length, 0);
    assert.equal((await call('/api/skills/library', 'POST', input, dev.token)).status, 403);
    const created = (await call('/api/skills/library', 'POST', input, admin.token)).body.skill;
    assert.deepEqual([created.name, created.title, created.projectId], ['shared-review', '代码评审规范', null]);
    assert.deepEqual((await call('/api/projects/default/skills', 'GET', undefined, admin.token)).body.available.map(item => item.id).sort(),
      [created.id, legacy.id].sort());
    assert.deepEqual((await call('/api/skills?projectId=default', 'GET', undefined, dev.token)).body.skills, []);
    assert.equal((await call(`/api/projects/default/skills/${created.id}`, 'POST', {}, dev.token)).status, 403);
    assert.equal((await call(`/api/projects/default/skills/${created.id}`, 'POST', {}, admin.token)).status, 200);
    assert.equal((await call(`/api/projects/${secret.id}/skills/${created.id}`, 'POST', {}, admin.token)).body.error.code, 'SKILL_EXISTS');
    assert.equal((await call(`/api/projects/${secret.id}/skills/${legacy.id}`, 'DELETE', undefined, admin.token)).status, 204);
    assert.equal((await call(`/api/projects/${secret.id}/skills/${created.id}`, 'POST', {}, admin.token)).status, 200);

    const renamed = (await call(`/api/skills/${created.id}`, 'PATCH', { expectedVersion: 1, title: '新评审标题' }, admin.token)).body.skill;
    assert.deepEqual([renamed.id, renamed.name, renamed.title, renamed.version], [created.id, input.name, '新评审标题', 2]);
    const projectList = (await call('/api/projects/default/skills', 'GET', undefined, dev.token)).body;
    assert.deepEqual(projectList.skills.map(s => [s.id, s.title, s.canUnlink]), [[created.id, '新评审标题', false]]);
    assert.deepEqual((await call(`/api/skills?projectId=${secret.id}&include=content`, 'GET', undefined, admin.token)).body.skills.map(s => [s.id, s.title, s.content]),
      [[created.id, '新评审标题', '# 规则']]);

    const personal = (await call('/api/skills/library', 'POST', { ...input, visibility: 'PERSONAL' }, dev.token)).body.skill;
    assert.equal((await call(`/api/projects/default/skills/${personal.id}`, 'POST', {}, dev.token)).status, 200);
    assert.equal((await call(`/api/projects/${secret.id}/skills/${personal.id}`, 'POST', {}, dev.token)).status, 403);
    assert.equal((await call('/api/skills/library', 'GET', undefined, peer.token)).body.skills.some(s => s.id === personal.id), false);
    const device = await hub.pair(dev, ['default']);
    assert.equal((await call('/api/skills/library', 'GET', undefined, device)).status, 403);
    assert.deepEqual((await call('/api/skills?projectId=default&include=content', 'GET', undefined, device)).body.skills.map(s => s.id), [created.id]);

    assert.equal((await call(`/api/projects/default/skills/${created.id}`, 'DELETE', undefined, admin.token)).status, 204);
    assert.deepEqual((await call('/api/skills?projectId=default', 'GET', undefined, dev.token)).body.skills.map(s => s.id), [personal.id]);
    assert.equal((await call(`/api/skills/${created.id}`, 'GET', undefined, admin.token)).body.skill.title, '新评审标题');
    assert.equal((await call(`/api/skills/${legacy.id}`, 'GET', undefined, admin.token)).body.skill.id, legacy.id);

    const bulk = await call('/api/skills/library/import', 'POST', {
      visibility: 'PERSONAL',
      items: ['import-review-a', 'import-review-b'].map(name => ({ ...input, name, content: '规'.repeat(23_000) })),
    }, dev.token);
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body.imported, ['import-review-a', 'import-review-b']);
  } finally { await hub.close(); }
});

test('project Skills can be linked in an additive, atomic batch', async () => {
  const hub = await startHub();
  const { call, admin, dev, peer, secret } = hub;
  const projectSkills = '/api/projects/default/skills';
  const input = { name: 'review-a', description: '检查规则', content: '# 检查规则' };
  try {
    const teamA = (await call('/api/skills/library', 'POST', input, admin.token)).body.skill;
    const teamB = (await call('/api/skills/library', 'POST', { ...input, name: 'review-b' }, admin.token)).body.skill;
    const sameName = (await call('/api/skills', 'POST', { ...input, projectId: secret.id }, admin.token)).body.skill;
    const personal = (await call('/api/skills/library', 'POST', { ...input, visibility: 'PERSONAL' }, dev.token)).body.skill;
    const otherPersonal = (await call('/api/skills/library', 'POST', { ...input, visibility: 'PERSONAL' }, peer.token)).body.skill;

    const invalid = await call(projectSkills, 'POST', { skillIds: [personal.id, 42] }, dev.token);
    assert.deepEqual([invalid.status, invalid.body.error.code], [400, 'INVALID_INPUT']);
    assert.match(invalid.body.error.message, /第 2 个/);
    const tooMany = await call(projectSkills, 'POST', { skillIds: Array(101).fill(personal.id) }, dev.token);
    assert.deepEqual([tooMany.status, tooMany.body.error.code], [400, 'INVALID_INPUT']);

    const forbidden = await call(projectSkills, 'POST', { skillIds: [personal.id, teamA.id] }, dev.token);
    assert.deepEqual([forbidden.status, forbidden.body.error.code], [403, 'FORBIDDEN']);
    const privateSkill = await call(projectSkills, 'POST', { skillIds: [personal.id, otherPersonal.id] }, dev.token);
    assert.deepEqual([privateSkill.status, privateSkill.body.error.code], [404, 'SKILL_NOT_FOUND']);
    assert.match(privateSkill.body.error.message, /第 2 个/);
    assert.deepEqual((await call(projectSkills, 'GET', undefined, dev.token)).body.skills, []);

    const collision = await call(projectSkills, 'POST', { skillIds: [teamB.id, teamA.id, sameName.id] }, admin.token);
    assert.deepEqual([collision.status, collision.body.error.code], [409, 'SKILL_EXISTS']);
    assert.match(collision.body.error.message, /review-a/);
    assert.deepEqual((await call(projectSkills, 'GET', undefined, admin.token)).body.skills, []);

    const batches = await Promise.all([
      call(projectSkills, 'POST', { skillIds: [teamA.id, teamB.id, teamA.id] }, admin.token),
      call(projectSkills, 'POST', { skillIds: [teamA.id, teamB.id] }, admin.token),
    ]);
    assert.deepEqual(batches.map(({ body }) => body.linkedCount).sort(), [0, 2]);
    for (const result of batches) {
      assert.equal(result.status, 200);
      assert.equal(result.body.canManageTeam, true);
      assert.deepEqual(result.body.skills.map(skill => skill.id), [teamA.id, teamB.id]);
      assert.deepEqual(result.body.available, []);
    }

    const own = await call(projectSkills, 'POST', { skillIds: [personal.id] }, dev.token);
    assert.deepEqual([own.status, own.body.linkedCount, own.body.canManageTeam], [200, 1, false]);
    assert.deepEqual(own.body.skills.map(skill => skill.id), [teamA.id, personal.id, teamB.id]);
    assert.deepEqual((await call(projectSkills, 'GET', undefined, peer.token)).body.skills.map(skill => skill.id), [teamA.id, teamB.id]);
    const device = await hub.pair(dev, ['default']);
    assert.equal((await call(projectSkills, 'POST', { skillIds: [teamA.id] }, device)).status, 403);
  } finally { await hub.close(); }
});

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

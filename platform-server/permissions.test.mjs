import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform } from './server.mjs';

const password = 'isolated-permission-test-password';
async function fixture() {
  const logs = []; const app = createPlatform({ dbPath: ':memory:', connectorProfiles: {}, logger: { error: (...args) => logs.push(args.join(' ')) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(path, method = 'GET', body, token, headers = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  async function expect(path, method, body, token, status = 200, headers) {
    const result = await call(path, method, body, token, headers); assert.equal(result.status, status, `${path}: ${JSON.stringify(result.data)}`); return result;
  }
  await expect('/api/setup', 'POST', { username: 'administrator', password }, undefined, 201);
  const login = await expect('/api/login', 'POST', { username: 'administrator', password });
  const admin = { ...login.data.user, token: login.data.token, cookie: login.headers.get('set-cookie').split(';')[0] };
  async function account(username, role, projectId = 'default') {
    const created = await expect('/api/users', 'POST', { username, password, role, projectId }, admin.token, 201);
    const login = await expect('/api/login', 'POST', { username, password });
    return { ...created.data.user, token: login.data.token };
  }
  const project = async key => (await expect('/api/projects', 'POST', { key, name: key }, admin.token, 201)).data.project;
  const member = async (projectId, user, role, actor = admin) => expect(`/api/projects/${projectId}/members`, 'POST', { userId: user.id, role }, actor.token);
  return { app, base, logs, admin, call, expect, account, project, member, close: () => app.close() };
}

test('global labels cannot replace live project roles or grant management permissions', async () => {
  const f = await fixture(); const { admin, expect } = f;
  try {
    const lead = await f.account('leader', 'LEAD'); const dev = await f.account('developer', 'DEV'); const qa = await f.account('quality', 'QA'); const pm = await f.account('product', 'PM');
    const other = await f.project('OTHER'); await f.member(other.id, lead, 'DEV');
    const me = (await expect('/api/me', 'GET', undefined, lead.token)).data;
    assert.equal(me.user.role, 'LEAD'); assert.ok(Object.values(me.permissions).every(value => value === false));
    assert.ok(Object.values((await expect('/api/me', 'GET', undefined, admin.token)).data.permissions).every(value => value === true));
    const projects = (await expect('/api/projects', 'GET', undefined, lead.token)).data.projects;
    assert.equal(projects.find(item => item.id === 'default').permissions.manageMembers, true);
    assert.deepEqual(projects.find(item => item.id === 'default').permissions.grantRoles, ['DEV', 'QA', 'PM']);
    assert.equal(projects.find(item => item.id === other.id).role, 'DEV');
    assert.ok(Object.entries(projects.find(item => item.id === other.id).permissions).filter(([key]) => key !== 'grantRoles').every(([, value]) => value === false));
    await expect('/api/users', 'GET', undefined, lead.token, 403);
    await expect('/api/users', 'POST', { username: 'forgedadmin', password, role: 'ADMIN' }, lead.token, 403, { 'X-Role': 'ADMIN' });
    await expect('/api/projects', 'POST', { key: 'FORGED', name: 'Forged', role: 'ADMIN' }, dev.token, 403);
    await expect(`/api/projects/${other.id}/members`, 'POST', { userId: dev.id, role: 'DEV', actorRole: 'ADMIN' }, lead.token, 403, { 'X-Role': 'ADMIN' });
    const manifest = { id: 'allowed-plugin', name: 'Original plugin', version: '1.0.0', stages: ['PRD'] };
    await expect('/api/plugins', 'POST', manifest, lead.token, 201);
    await expect('/api/plugins', 'POST', { ...manifest, id: 'forged-plugin', projectId: other.id }, lead.token, 403);
    await expect('/api/audit?projectId=default', 'GET', undefined, lead.token);
    await expect(`/api/audit?projectId=${other.id}`, 'GET', undefined, lead.token, 403);
    await expect('/api/connectors/jira/config', 'POST', { projectId: other.id, baseUrl: 'https://example.invalid', authMode: 'BEARER', token: 'fixture-only' }, lead.token, 403);
    for (const user of [dev, qa, pm]) {
      const project = (await expect('/api/projects', 'GET', undefined, user.token)).data.projects[0];
      assert.equal(project.permissions.manageMembers, false); assert.deepEqual(project.permissions.grantRoles, []); assert.equal(project.permissions.assignTasks, user.id === pm.id);
      const members = (await expect('/api/projects/default/members', 'GET', undefined, user.token)).data;
      assert.deepEqual(members.candidates, []); assert.ok(members.members.every(item => item.canEditRole === false));
      await expect('/api/projects/default/members', 'POST', { userId: user.id, role: 'LEAD' }, user.token, 403, { 'X-Role': 'ADMIN' });
    }
    assert.deepEqual((await expect('/api/projects', 'GET', undefined, admin.token)).data.projects[0].permissions.grantRoles, ['DEV', 'QA', 'LEAD', 'SRE', 'PM']);
    assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

test('project leaders manage ordinary accounts without self elevation or modifying protected members', async () => {
  const f = await fixture(); const { admin, expect } = f;
  try {
    const lead = await f.account('leader', 'LEAD'); const peer = await f.account('peerleader', 'LEAD'); const sre = await f.account('operations', 'SRE'); const dev = await f.account('developer', 'DEV'); const secondAdmin = await f.account('otheradmin', 'ADMIN');
    const other = await f.project('OTHER'); const outsider = await f.account('outsider', 'DEV', other.id);
    const metadata = (await expect('/api/projects/default/members', 'GET', undefined, lead.token)).data;
    for (const user of [lead, peer, sre, admin, secondAdmin]) assert.equal(metadata.members.find(item => item.id === user.id).canEditRole, false);
    assert.equal(metadata.members.find(item => item.id === dev.id).canEditRole, true);
    assert.ok(metadata.candidates.some(item => item.id === outsider.id)); assert.ok(!metadata.candidates.some(item => item.id === secondAdmin.id));
    await f.member('default', dev, 'PM', lead); await f.member('default', outsider, 'QA', lead);
    for (const nextRole of ['LEAD', 'SRE']) await expect('/api/projects/default/members', 'POST', { userId: dev.id, role: nextRole }, lead.token, 403);
    await expect('/api/projects/default/members', 'POST', { userId: dev.id, role: 'ADMIN' }, lead.token, 400);
    for (const user of [lead, peer, sre, admin, secondAdmin]) await expect('/api/projects/default/members', 'POST', { userId: user.id, role: 'QA' }, lead.token, 403);
    assert.equal(f.app.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get('default', dev.id).role, 'PM');
    await f.member('default', dev, 'SRE');
    await expect('/api/projects/default/members', 'POST', { userId: dev.id, role: 'DEV' }, lead.token, 403);
    await f.member('default', peer, 'DEV'); await f.member('default', sre, 'LEAD');
    await f.member('default', lead, 'DEV');
    const downgraded = (await expect('/api/projects', 'GET', undefined, lead.token)).data.projects.find(item => item.id === 'default');
    assert.equal(downgraded.role, 'DEV'); assert.equal(downgraded.permissions.manageMembers, false);
    await expect('/api/projects/default/members', 'POST', { userId: outsider.id, role: 'PM' }, lead.token, 403);
    assert.deepEqual((await expect('/api/projects/default/members', 'GET', undefined, lead.token)).data.candidates, []);
    await f.member('default', lead, 'LEAD'); await f.member('default', outsider, 'PM', lead);
    assert.equal((await expect('/api/me', 'GET', undefined, lead.token)).data.user.role, 'LEAD');
    assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

test('task ownership editing preserves PM assignment and cross-person professional review collaboration', async () => {
  const f = await fixture(); const { admin, expect } = f;
  try {
    const dev = await f.account('developer', 'DEV'); const qa = await f.account('quality', 'QA'); const pm = await f.account('product', 'PM'); const lead = await f.account('leader', 'LEAD');
    let task = (await expect('/api/tasks', 'POST', { jiraKey: 'TASK-1', title: 'Original task', assigneeId: dev.id }, admin.token, 201)).data.task;
    await expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Forged edit', role: 'ADMIN' }, qa.token, 403, { 'X-Role': 'ADMIN' });
    task = (await expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Developer edit' }, dev.token)).data.task;
    await expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, assigneeId: qa.id }, dev.token, 403);
    task = (await expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'PM cross-person edit', assigneeId: qa.id }, pm.token)).data.task;
    await expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Former assignee edit' }, dev.token, 403);
    task = (await expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'QA own edit' }, qa.token)).data.task;
    await expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: 'Product input', content: 'L_ORIGINAL_PRD' }, pm.token, 201);
    await expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'TECH_SPEC', title: 'Developer input', content: 'L_ORIGINAL_SPEC' }, dev.token, 201);
    await expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'CODE', title: 'Cross-person code', content: 'L_ORIGINAL_CODE' }, dev.token, 201);
    const job = (await expect('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'HUMAN_REVIEW' }, dev.token, 201)).data.job;
    const findings = [{ severity: 'WARN', title: 'Warning', detail: 'Original warning' }, { severity: 'CRITICAL', title: 'Blocking', detail: 'Original blocker' }];
    const reported = (await expect(`/api/jobs/${job.id}/report`, 'POST', { source: 'MANUAL', summary: 'Cross-person original report', findings }, dev.token, 201)).data.job;
    await expect(`/api/jobs/${job.id}/findings/${reported.findings[0].id}/waiver`, 'POST', { reason: 'Cannot waive warning' }, lead.token, 400);
    await expect(`/api/jobs/${job.id}/findings/${reported.findings[1].id}/waiver`, 'POST', { reason: 'Independent evidence' }, lead.token, 201);
    await expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'REQUEST_CHANGES', reason: 'Return the report' }, lead.token, 201);
    assert.equal((await expect(`/api/jobs/${job.id}/findings/${reported.findings[1].id}/waiver`, 'POST', { reason: 'Cannot alter decided review' }, admin.token, 409)).data.error.code, 'DECISION_EXISTS');
    assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

test('ADMIN local device metadata exposes no management capability', async () => {
  const f = await fixture(); const { admin, expect } = f;
  try {
    const pair = (await expect('/api/device-authorizations', 'POST', { deviceName: 'Fixture device', tool: 'codex-cli' }, undefined, 201)).data;
    await expect('/api/device-authorizations/decision', 'POST', { userCode: pair.userCode, decision: 'APPROVE', projectIds: ['default'] }, undefined, 200, { Cookie: admin.cookie, Origin: f.base });
    const device = (await expect('/api/device-authorizations/poll', 'POST', { deviceCode: pair.deviceCode })).data;
    assert.equal(device.user.role, 'ADMIN');
    assert.ok(Object.values((await expect('/api/me', 'GET', undefined, device.token)).data.permissions).every(value => value === false));
    const project = (await expect('/api/projects', 'GET', undefined, device.token)).data.projects[0];
    assert.deepEqual(project.permissions.grantRoles, []); assert.ok(Object.entries(project.permissions).filter(([key]) => key !== 'grantRoles').every(([, value]) => value === false));
    await expect('/api/projects/default/members', 'POST', { userId: admin.id, role: 'SRE' }, device.token, 403);
    assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

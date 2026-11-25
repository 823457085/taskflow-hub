import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createPlatform } from './server.mjs';
import { sha } from './common.mjs';

async function fixture() {
  const password = randomBytes(24).toString('base64url');
  const secret = randomBytes(24).toString('base64url');
  const state = { requests: [], issues: new Map(), response: null, error: null, gate: null, jql: '' };
  const remote = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    state.requests.push({ method: req.method, path: url.pathname });
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    if (state.gate?.path === url.pathname) {
      const gate = state.gate; state.gate = null; gate.started.resolve(); await gate.resume.promise;
    }
    res.setHeader('Content-Type', 'application/json');
    if (state.error) { res.writeHead(403); res.end(JSON.stringify({ message: state.error })); return; }
    let value;
    if (url.pathname === '/rest/api/2/myself') value = { key: 'fixture-account', active: true };
    else if (url.pathname === '/rest/api/2/project') value = [{ id: '101', key: 'TEST', name: 'L_PROJECT' }, { id: '102', key: 'OTHER', name: 'Other project' }];
    else if (url.pathname === '/rest/api/2/search') {
      state.jql = url.searchParams.get('jql');
      if (state.customSearch) value = state.customSearch(url);
      else {
        assert.equal(url.searchParams.get('maxResults'), '30');
        assert.equal(url.searchParams.get('startAt'), null);
        value = { issues: state.response || [issue('TEST-1')], total: 1 };
      }
    } else if (url.pathname.startsWith('/rest/api/2/issue/')) value = state.response || issue(decodeURIComponent(url.pathname.split('/').at(-1)));
    else { res.writeHead(404); value = { message: 'L_NOT_FOUND' }; }
    res.end(JSON.stringify(value));
  });
  function issue(key) {
    return state.issues.get(key) || { id: key, key, fields: { summary: 'L_TITLE', description: 'L_BODY', status: { name: '' }, issuetype: { id: '9', name: 'L_TYPE', subtask: false }, project: { id: key.startsWith('OTHER-') ? '102' : '101', key: key.split('-')[0], name: 'L_PROJECT' }, updated: '2026-11-13T00:00:00Z', assignee: { name: 'remote-owner', displayName: 'L_ASSIGNEE' } } };
  }
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const upstream = `http://127.0.0.1:${remote.address().port}`;
  const app = createPlatform({ dbPath: ':memory:', allowConnectorLoopbackHttp: true, logger: { error() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let admin = {};
  const call = async (path, body, actor = admin, expected = 200, code) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(actor?.cookie ? { Cookie: actor.cookie, Origin: base } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); const data = text ? JSON.parse(text) : null;
    assert.equal(response.status, expected, `${path} expected ${expected}, received ${response.status}: ${data?.error?.code || ''}`);
    if (code) assert.equal(data.error.code, code);
    return { data, text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  await call('/api/setup', { username: 'fixture-admin', password }, {}, 201);
  const signedIn = await call('/api/login', { username: 'fixture-admin', password }, {}); admin = { ...signedIn.data, cookie: signedIn.cookie };
  await call('/api/connectors/jira/config', { projectId: 'default', baseUrl: upstream, authMode: 'BEARER', token: secret });
  const synced = (await call('/api/connectors/jira/sync-projects', { projectId: 'default', projectIds: ['101', '102'] })).data.projects;
  const project = synced.find(item => item.key === 'TEST'); const other = synced.find(item => item.key === 'OTHER');
  const member = async (username = 'fixture-dev', projectId = project.id) => {
    await call('/api/users', { username, password, role: 'DEV', projectId }, admin, 201);
    const loggedIn = await call('/api/login', { username, password }, {});
    return { ...loggedIn.data, cookie: loggedIn.cookie };
  };
  const hold = path => {
    const gate = { path, started: Promise.withResolvers(), resume: Promise.withResolvers() };
    state.gate = gate; return { started: gate.started.promise, release: gate.resume.resolve };
  };
  return { app, upstream, state, project, other, admin, member, call, hold, issue, secret, async close() { await app.close(); await new Promise(resolve => remote.close(resolve)); } };
}

test('Jira intake reads a link or picker in a member project without connector-management privileges', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  const before = f.app.db.prepare('SELECT status,last_checked_at,version FROM connector_configs WHERE project_id=?').get(f.project.id);
  const lookup = (await f.call('/api/jira/tasks/lookup', { reference: `${f.upstream}/browse/TEST-1` }, member)).data;
  assert.equal(lookup.project.id, f.project.id); assert.equal(lookup.project.permissions.manageConnections, false);
  assert.equal(lookup.issue.title, 'L_TITLE'); assert.equal(lookup.issue.type, 'L_TYPE'); assert.equal(lookup.issue.status, '');
  assert.equal(lookup.issue.assignee.displayName, 'L_ASSIGNEE'); assert.equal(lookup.existingTask, null);
  const inferred = (await f.call('/api/jira/tasks/lookup', { reference: 'test-1', projectId: 'default' })).data;
  assert.equal(inferred.project.id, f.project.id);
  const search = (await f.call('/api/jira/tasks/search', { projectId: f.project.id, query: 'needle") OR project = OTHER' }, member)).data;
  assert.equal(search.items[0].title, 'L_TITLE'); assert.equal(search.project.id, f.project.id); assert.equal(search.total, 1);
  assert.match(f.state.jql, /^project = 101 AND \(summary ~ /); assert.match(f.state.jql, /ORDER BY updated DESC$/);
  assert.deepEqual(f.app.db.prepare('SELECT status,last_checked_at,version FROM connector_configs WHERE project_id=?').get(f.project.id), before);
  await f.call('/api/connectors/jira/read', { projectId: f.project.id, resource: 'jira_issue', issueKey: 'TEST-1' }, member, 403, 'CONNECTOR_FORBIDDEN');
  assert.ok(f.state.requests.every(request => request.method === 'GET'));
});

test('Jira requirement picker scopes and pages main issues without offering linked children', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  const parent = (await f.call('/api/jira/tasks/import', { reference: 'TEST-1' }, member)).data.task;
  await f.call('/api/jira/tasks/import', { reference: 'TEST-2', parentTaskId: parent.id }, member);
  const issue = (key, fields) => ({ ...f.issue(key), fields: { ...f.issue(key).fields, ...fields } });
  const remoteChild = issue('TEST-3', { issuetype: { id: '10', name: '子任务', subtask: true }, parent: { key: 'TEST-1' } });
  const linkedParent = issue('TEST-4', { parent: { key: 'TEST-1' } });
  f.state.customSearch = url => {
    assert.equal(url.searchParams.get('maxResults'), '8');
    assert.equal(url.searchParams.get('startAt'), '8');
    assert.equal(url.searchParams.get('jql'), 'project = 101 AND (summary ~ "Needle words" AND issuetype in standardIssueTypes()) ORDER BY updated DESC, key DESC');
    return { issues: [f.issue('TEST-2'), remoteChild, linkedParent, f.issue('TEST-5')], total: 22 };
  };
  const path = '/api/jira/tasks/search';
  const result = (await f.call(path, { projectId: f.project.id, requireMainTask: true, page: 2, query: 'Needle words' }, member)).data;
  assert.deepEqual(result.items.map(item => item.key), ['TEST-5']);
  assert.equal(result.project.id, f.project.id);
  assert.deepEqual([result.page, result.pageSize, result.total], [2, 8, 22]);
  const count = f.state.requests.length;
  await f.call(path, { projectId: f.project.id, requireMainTask: 'true' }, member, 400, 'INVALID_INPUT');
  await f.call(path, { projectId: f.project.id, requireMainTask: true, page: 0 }, member, 400, 'INVALID_INPUT');
  await f.call(path, { projectId: f.project.id, requireMainTask: true, page: 10001 }, member, 400, 'INVALID_INPUT');
  assert.equal(f.state.requests.length, count);
});

test('link admission rejects foreign sources, invisible projects, injected fields and anonymous connections before remote calls', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  const count = f.state.requests.length;
  await f.call('/api/jira/tasks/lookup', { reference: 'https://foreign.invalid/browse/TEST-1' }, member, 400, 'JIRA_SOURCE_MISMATCH');
  await f.call('/api/jira/tasks/lookup', { reference: 'OTHER-1' }, member, 404, 'JIRA_PROJECT_NOT_AVAILABLE');
  await f.call('/api/jira/tasks/search', { projectId: f.other.id }, member, 403, 'PROJECT_FORBIDDEN');
  await f.call('/api/jira/tasks/search', { projectId: f.project.id, jql: 'project=OTHER' }, member, 400, 'INVALID_INPUT');
  await f.call('/api/jira/tasks/import', { reference: 'TEST-1', assigneeId: f.admin.user.id }, member, 400, 'INVALID_INPUT');
  await f.call('/api/jira/tasks/lookup', { reference: `${f.upstream}/browse/TEST-1?token=forbidden` }, member, 400, 'INVALID_JIRA_REFERENCE');
  f.app.db.prepare("UPDATE connector_configs SET auth_mode='NONE' WHERE project_id=? AND provider='jira'").run(f.project.id);
  await f.call('/api/jira/tasks/lookup', { reference: 'TEST-1' }, member, 409, 'REMOTE_AUTH_REQUIRED');
  assert.equal(f.state.requests.length, count);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});

test('local projects and tasks can be used while Jira is unavailable', async t => {
  const f = await fixture(); t.after(() => f.close());
  const member = await f.member();
  f.state.error = 'Jira unavailable';
  const requestsBefore = f.state.requests.length;
  const { project } = (await f.call('/api/projects', { key: 'OFFLINE', name: 'Offline project' }, f.admin, 201)).data;
  const { task } = (await f.call('/api/tasks', { projectId: project.id, title: 'Local task' }, f.admin, 201)).data;
  assert.match(task.jiraKey, /^LOCAL-T[0-9A-F]{32}$/);
  assert.equal(task.externalRef, null);
  const { task: parent } = (await f.call('/api/tasks', { projectId: f.project.id, title: 'Offline work in bound project' }, member, 201)).data;
  const { task: child } = (await f.call('/api/tasks', { projectId: f.project.id, parentId: parent.id, title: 'Offline subtask' }, member, 201)).data;
  assert.equal(child.parentId, parent.id);
  assert.match(child.jiraKey, /^LOCAL-T[0-9A-F]{32}$/);
  assert.notEqual(child.jiraKey, parent.jiraKey);
  await f.call('/api/tasks', { projectId: f.project.id, title: 'Wrong project', jiraKey: 'OTHER-5' }, member, 400, 'JIRA_TASK_PROJECT_MISMATCH');
  await f.call('/api/jira/tasks/import', { reference: parent.jiraKey }, member, 400, 'INVALID_JIRA_REFERENCE');
  assert.ok((await f.call('/api/projects', undefined, member)).data.projects.some(item => item.id === f.project.id));
  assert.equal(f.state.requests.length, requestsBefore);
  f.state.error = null;
  f.state.response = [f.issue(parent.jiraKey)];
  await f.call('/api/jira/tasks/search', { projectId: f.project.id }, member, 502, 'REMOTE_RESOURCE_INVALID');
  assert.equal((await f.call(`/api/tasks/${parent.id}`, undefined, member)).data.task.externalRef, null);
});

test('Jira import reads again, creates verified original metadata and opens an existing task without overwriting it', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  await f.call('/api/jira/tasks/lookup', { reference: 'TEST-1' }, member);
  f.state.issues.set('TEST-1', { ...f.issue('TEST-1'), fields: { ...f.issue('TEST-1').fields, summary: 'L_CURRENT_TITLE' } });
  const imported = (await f.call('/api/jira/tasks/import', { reference: 'TEST-1' }, member)).data;
  assert.equal(imported.task.title, 'L_CURRENT_TITLE'); assert.equal(imported.task.externalRef.title, 'L_CURRENT_TITLE');
  assert.equal(imported.task.externalRef.status, ''); assert.equal(imported.task.jiraStatus, 'verified');
  assert.equal(imported.task.assigneeId, member.user.id); assert.equal(imported.task.projectId, f.project.id); assert.equal(imported.existing, false);
  assert.ok(!JSON.stringify(imported).includes(f.secret));
  f.app.db.prepare("UPDATE tasks SET title='Local edited title',assignee_id=?,status='DONE' WHERE id=?").run(f.admin.user.id, imported.task.id);
  const before = f.app.db.prepare('SELECT * FROM tasks WHERE id=?').get(imported.task.id);
  const existing = (await f.call('/api/jira/tasks/import', { reference: `${f.upstream}/browse/TEST-1` }, member)).data;
  assert.equal(existing.task.id, imported.task.id); assert.equal(existing.existing, true); assert.equal(existing.imported, false);
  assert.equal(existing.task.title, 'Local edited title'); assert.equal(existing.task.status, 'DONE');
  assert.deepEqual(f.app.db.prepare('SELECT * FROM tasks WHERE id=?').get(imported.task.id), before);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  const duplicate = await Promise.all([f.call('/api/jira/tasks/import', { reference: 'TEST-9' }, member), f.call('/api/jira/tasks/import', { reference: 'TEST-9' }, member)]);
  assert.equal(duplicate[0].data.task.id, duplicate[1].data.task.id);
  assert.deepEqual(duplicate.map(item => item.data.existing).sort(), [false, true]);
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE jira_key='TEST-9'").get().n, 1);
  assert.ok(f.state.requests.every(request => request.method === 'GET'));
});

test('Jira intake infers a verified parent, rejects frozen parents, and never assigns a nonmember administrator', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  const parent = (await f.call('/api/jira/tasks/import', { reference: 'TEST-1' }, member)).data.task;
  for (const key of ['TEST-2', 'TEST-3']) f.state.issues.set(key, { ...f.issue(key), fields: { ...f.issue(key).fields, parent: { key: 'TEST-1' } } });
  const child = (await f.call('/api/jira/tasks/import', { reference: 'TEST-2' }, member)).data.task;
  assert.equal(child.parentId, parent.id); assert.equal(child.externalRef.parentKey, 'TEST-1');
  f.app.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(parent.id);
  await f.call('/api/jira/tasks/import', { reference: 'TEST-3' }, member, 409, 'TASK_DONE');
  assert.equal(f.app.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE jira_key='TEST-3'").get().n, 0);
  f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.other.id, f.admin.user.id);
  const adminImport = (await f.call('/api/jira/tasks/import', { reference: 'OTHER-1' })).data.task;
  assert.equal(adminImport.assigneeId, null);
});

test('Jira parent intake and scoped sync fetch direct children without replacing local work or main task context', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  const makeChild = (key, parentKey, status, statusCategory) => ({
    ...f.issue(key), fields: {
      ...f.issue(key).fields,
      summary: `Jira ${key}`, parent: { key: parentKey }, issuetype: { id: '10', name: '子任务', subtask: true },
      status: { name: status, statusCategory: { key: statusCategory } },
    },
  });
  const old = (await f.call('/api/jira/tasks/import', { reference: 'TEST-2' }, member)).data.task;
  const otherParent = (await f.call('/api/jira/tasks/import', { reference: 'TEST-9' }, member)).data.task;
  const conflicting = (await f.call('/api/jira/tasks/import', { reference: 'TEST-4', parentTaskId: otherParent.id }, member)).data.task;
  f.app.db.prepare("UPDATE tasks SET title='Local edited title',status='IN_PROGRESS' WHERE id=?").run(old.id);
  await f.call(`/api/tasks/${old.id}/assets`, { kind: 'PRD', title: 'Local PRD', content: 'Keep history' }, member, 201);

  const parent = f.issue('TEST-1');
  f.state.issues.set(parent.key, { ...parent, fields: { ...parent.fields, subtasks: ['TEST-2', 'TEST-3', 'TEST-4', 'TEST-5'].map(key => ({ key })) } });
  f.state.issues.set('TEST-2', makeChild('TEST-2', parent.key, '测试中', 'indeterminate'));
  f.state.issues.set('TEST-3', makeChild('TEST-3', parent.key, '已完成', 'done'));
  f.state.issues.set('TEST-4', makeChild('TEST-4', parent.key, '开发中', 'indeterminate'));
  f.state.customSearch = url => {
    const keys = [...url.searchParams.get('jql').matchAll(/"(TEST-[1-9]\d*)"/g)].map(match => match[1]);
    const rows = keys.map(key => f.state.issues.get(key)).filter(Boolean);
    return { issues: rows, total: rows.length };
  };
  const result = (await f.call('/api/jira/tasks/import', { reference: parent.key }, member)).data;
  assert.deepEqual(result.linkedKeys, ['TEST-2', 'TEST-3']);
  assert.deepEqual(result.skippedChildren, [
    { jiraKey: 'TEST-4', reason: 'JIRA_SUBTASK_CONFLICT' },
    { jiraKey: 'TEST-5', reason: 'JIRA_SUBTASK_UNAVAILABLE' },
  ]);
  assert.match(f.state.jql, /^project = 101 AND \(key in/);
  const path = '/api/jira/tasks/sync-children';
  const first = (await f.call(path, { taskId: result.task.id }, member)).data;
  assert.equal(first.linkedCount, 0);
  assert.equal(first.updatedCount, 0);
  const [retained, completed] = first.children;
  assert.equal(retained.id, old.id);
  assert.equal(retained.assigneeId, member.user.id);
  assert.equal(retained.title, 'Local edited title');
  assert.equal(retained.status, 'IN_PROGRESS');
  assert.equal(retained.externalRef.status, '测试中');
  assert.equal(retained.externalRef.issueType.subtask, true);
  assert.equal(completed.assigneeId, null);
  assert.equal(completed.status, 'DONE');
  assert.equal(f.app.db.prepare('SELECT parent_id FROM tasks WHERE id=?').get(conflicting.id).parent_id, otherParent.id);

  // Absence from this read is not a request to remove local rows or assets.
  f.state.issues.delete('TEST-3');
  f.state.issues.set('TEST-2', makeChild('TEST-2', parent.key, '已完成', 'done'));
  const after = (await f.call(path, { taskId: result.task.id }, member)).data;
  assert.deepEqual(after.children.map(task => task.jiraKey), ['TEST-2', 'TEST-3']);
  assert.equal(after.children[0].externalRef.status, '已完成');
  assert.equal(after.children[0].status, 'IN_PROGRESS');
  assert.equal(after.updatedCount, 1);
  assert.equal(after.task.contextVersion, first.task.contextVersion);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM assets WHERE task_id=?').get(old.id).n, 1);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  await f.call(path, { taskId: old.id }, member, 409, 'JIRA_PARENT_REQUIRED');
  const outsider = await f.member('other-project-user', f.other.id);
  await f.call(path, { taskId: result.task.id }, outsider, 403, 'PROJECT_FORBIDDEN');
  assert.ok(f.state.requests.every(request => request.method === 'GET'));
});

test('remote project mismatches and reflected credential text stay contained', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  f.state.response = f.issue('OTHER-1');
  await f.call('/api/jira/tasks/lookup', { reference: 'TEST-1' }, member, 403, 'JIRA_PROJECT_SCOPE_MISMATCH');
  f.state.response = null; f.state.error = `L_REMOTE_FAILURE ${f.secret}`;
  const failed = await f.call('/api/jira/tasks/lookup', { reference: 'TEST-1' }, member, 502, 'REMOTE_REQUEST_FAILED');
  assert.equal(failed.data.error.message, 'L_REMOTE_FAILURE [凭据已隐藏]'); assert.ok(!failed.text.includes(f.secret));
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});

test('existing local task conflicts are reported without moving or overwriting tasks', async t => {
  const f = await fixture(); t.after(() => f.close());
  const manual = (await f.call('/api/tasks', { jiraKey: 'TEST-1', title: 'Original local task', projectId: 'default' }, f.admin, 201)).data.task;
  const before = f.app.db.prepare('SELECT * FROM tasks WHERE id=?').get(manual.id);
  await f.call('/api/jira/tasks/lookup', { reference: 'TEST-1' }, f.admin, 409, 'JIRA_TASK_CONFLICT');
  await f.call('/api/jira/tasks/import', { reference: 'TEST-1' }, f.admin, 409, 'JIRA_TASK_CONFLICT');
  assert.deepEqual(f.app.db.prepare('SELECT * FROM tasks WHERE id=?').get(manual.id), before);
});

test('a task-scoped local device cannot reuse Jira account reads or imports', async t => {
  const f = await fixture(); t.after(() => f.close()); const member = await f.member();
  const paired = (await f.call('/api/device-authorizations', { deviceName: 'Fixture device', tool: 'custom' }, {}, 201)).data;
  await f.call('/api/device-authorizations/decision', { userCode: paired.userCode, decision: 'APPROVE', projectIds: [f.project.id] }, { cookie: member.cookie });
  const device = (await f.call('/api/device-authorizations/poll', { deviceCode: paired.deviceCode }, {})).data;
  const before = f.state.requests.length;
  for (const [action, body] of [
    ['lookup', { reference: 'TEST-1' }], ['search', { projectId: f.project.id }],
    ['import', { reference: 'TEST-1' }], ['sync-children', { taskId: 'not-checked' }],
  ]) await f.call(`/api/jira/tasks/${action}`, body, device, 403, 'LOCAL_DEVICE_SCOPE');
  assert.equal(f.state.requests.length, before);
});

test('all intake actions reauthorize delayed reads before returning data or importing', async () => {
  for (const action of ['lookup', 'search', 'import']) {
    for (const change of ['membership', 'session', 'configuration', 'binding']) {
      const f = await fixture(); const member = await f.member();
      const gate = f.hold(action === 'search' ? '/rest/api/2/search' : '/rest/api/2/issue/TEST-1');
      const expected = change === 'session' ? 401 : change === 'membership' ? 403 : 409;
      const code = { session: 'UNAUTHENTICATED', membership: 'PROJECT_FORBIDDEN', configuration: 'CONNECTOR_CHANGED', binding: 'JIRA_PROJECT_CHANGED' }[change];
      const pending = f.call(`/api/jira/tasks/${action}`, action === 'search' ? { projectId: f.project.id } : { reference: 'TEST-1' }, member, expected, code);
      try {
        await gate.started;
        if (change === 'membership') f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.project.id, member.user.id);
        if (change === 'session') f.app.db.prepare('UPDATE sessions SET expires_at=0 WHERE token_hash=?').run(sha(member.token));
        if (change === 'configuration') f.app.db.prepare('UPDATE connector_configs SET version=version+1 WHERE project_id=?').run(f.project.id);
        if (change === 'binding') f.app.db.prepare("UPDATE jira_project_bindings SET remote_key='RENAMED' WHERE project_id=?").run(f.project.id);
        gate.release(); await pending;
        assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
      } finally { gate.release(); await pending.catch(() => {}); await f.close(); }
    }
  }
});

test('sync-mine imports latest currentUser tasks, links parents, removes untouched reassigned/done tasks, and preserves tasks with local assets', async t => {
  const f = await fixture(); t.after(() => f.close());
  const member = await f.member('lizirui', f.project.id);
  const makeIssue = (key, { summary, status = '待开始', statusCat = 'new', assigneeKey = 'fixture-account', assigneeName = 'lizirui', parentKey = null }) => ({
    id: key,
    key,
    fields: {
      summary,
      description: `${key} desc`,
      status: { name: status, statusCategory: { key: statusCat } },
      issuetype: { id: parentKey ? '10' : '9', name: parentKey ? '子任务' : '任务', subtask: !!parentKey },
      project: { id: '101', key: 'TEST', name: 'L_PROJECT' },
      updated: '2026-11-14T10:00:00.000+0800',
      parent: parentKey ? { key: parentKey } : undefined,
      assignee: assigneeKey ? { key: assigneeKey, name: assigneeName, displayName: assigneeName } : null,
    },
  });

  // Seed 3 initial local tasks via Jira import before Jira changes
  for (const [k, s] of [['TEST-10', 'Reassigned untouched'], ['TEST-11', 'Completed untouched'], ['TEST-12', 'Reassigned with local PRD']]) {
    f.state.issues.set(k, makeIssue(k, { summary: s }));
    await f.call('/api/jira/tasks/import', { reference: k }, member);
  }
  const keptTask = f.app.db.prepare("SELECT id FROM tasks WHERE jira_key='TEST-12'").get();
  // Add a local PRD asset to TEST-12 so it must NOT be deleted when reassigned
  await f.call(`/api/tasks/${keptTask.id}/assets`, { kind: 'PRD', title: 'Local PRD', content: '# PRD' }, f.admin, 201);

  // Now simulate latest Jira state:
  // - TEST-10 & TEST-12 reassigned to someone else ('liangshilong')
  // - TEST-11 marked Done ('已完成', statusCat: 'done')
  // - Brand new TEST-20 (parent, 开发中) & TEST-21 (subtask of TEST-20) assigned to currentUser ('fixture-account')
  const liveByKey = new Map([
    ['TEST-10', makeIssue('TEST-10', { summary: 'Reassigned untouched', assigneeKey: 'other-user', assigneeName: 'liangshilong' })],
    ['TEST-11', makeIssue('TEST-11', { summary: 'Completed untouched', status: '已完成', statusCat: 'done' })],
    ['TEST-12', makeIssue('TEST-12', { summary: 'Reassigned with local PRD', assigneeKey: 'other-user', assigneeName: 'liangshilong' })],
    ['TEST-20', makeIssue('TEST-20', { summary: 'Active parent', status: '开发中', statusCat: 'indeterminate' })],
    ['TEST-21', makeIssue('TEST-21', { summary: 'Active subtask', parentKey: 'TEST-20' })],
    ['TEST-22', makeIssue('TEST-22', { summary: 'Completed subtask assigned to a teammate', parentKey: 'TEST-20', status: '已完成', statusCat: 'done', assigneeKey: 'teammate' })],
  ]);
  liveByKey.get('TEST-20').fields.subtasks = [{ key: 'TEST-21' }, { key: 'TEST-22' }];
  let childActive = true;
  f.state.customSearch = url => {
    const jql = url.searchParams.get('jql') || '';
    const keys = jql.includes('assignee = currentUser()')
      ? childActive ? ['TEST-21', 'TEST-20'] : ['TEST-20']
      : [...jql.matchAll(/"(TEST-[1-9]\d*)"/g)].map(match => match[1]);
    const issues = keys.map(key => liveByKey.get(key)).filter(Boolean);
    return { issues, total: issues.length };
  };

  const syncRes = (await f.call('/api/jira/tasks/sync-mine', {}, member)).data;
  assert.deepEqual(syncRes.importedKeys.sort(), ['TEST-20', 'TEST-21', 'TEST-22']);
  assert.deepEqual(syncRes.removedKeys.sort(), ['TEST-10', 'TEST-11']);
  assert.deepEqual(syncRes.unassignedKeys, ['TEST-12']);

  const remaining = (await f.call('/api/tasks', undefined, member)).data.tasks;
  assert.deepEqual(remaining.map(r => r.jiraKey).sort(), ['TEST-12', 'TEST-20', 'TEST-21', 'TEST-22']);
  const parentRow = remaining.find(r => r.jiraKey === 'TEST-20');
  const childRow = remaining.find(r => r.jiraKey === 'TEST-21');
  const unassignedRow = remaining.find(r => r.jiraKey === 'TEST-12');
  assert.equal(parentRow.status, 'IN_PROGRESS');
  assert.equal(childRow.parentId, parentRow.id);
  assert.equal(unassignedRow.assigneeId, null);
  const sibling = remaining.find(r => r.jiraKey === 'TEST-22');
  assert.equal(sibling.parentId, parentRow.id);
  assert.equal(sibling.assigneeId, null);
  assert.equal(sibling.externalRef.status, '已完成');

  childActive = false;
  liveByKey.set('TEST-21', makeIssue('TEST-21', { summary: 'Finished subtask', parentKey: 'TEST-20', status: '已完成', statusCat: 'done', assigneeKey: 'teammate' }));
  const nextSync = (await f.call('/api/jira/tasks/sync-mine', {}, member)).data;
  assert.ok(!nextSync.removedKeys.includes('TEST-21'));
  const after = (await f.call(`/api/tasks/${childRow.id}`, undefined, member)).data.task;
  assert.equal(after.parentId, parentRow.id);
  assert.equal(after.assigneeId, member.user.id);
  assert.equal(after.externalRef.status, '已完成');
});

test('sync-mine deduplicates concurrent requests and sync-projects preserves locally customized project names', async t => {
  const f = await fixture(); t.after(() => f.close());
  const member = await f.member('dedup-dev', f.project.id);

  // Rename Jira-bound project locally and verify sync-projects preserves custom name
  const renameRes = await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/projects/${f.project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.admin.token}` },
    body: JSON.stringify({ name: '本地自定义项目简称' }),
  });
  assert.equal(renameRes.status, 200);
  const resynced = (await f.call('/api/connectors/jira/sync-projects', { projectId: 'default', projectIds: ['101'] })).data.projects;
  assert.equal(resynced.find(p => p.id === f.project.id).name, '本地自定义项目简称');
  assert.equal(resynced.find(p => p.id === f.project.id).jira.name, 'L_PROJECT');

  // Concurrent sync-mine calls share 1 upstream /rest/api/2/myself + /rest/api/2/search round-trip
  const baseIssue = f.issue('TEST-1');
  f.state.customSearch = () => ({
    issues: [{ ...baseIssue, fields: { ...baseIssue.fields, assignee: { key: 'fixture-account', name: 'dedup-dev', displayName: 'dedup-dev' } } }],
    total: 1,
  });
  const gate = f.hold('/rest/api/2/search');
  const beforeCount = f.state.requests.length;
  const c1 = f.call('/api/jira/tasks/sync-mine', { projectId: f.project.id }, member);
  const c2 = f.call('/api/jira/tasks/sync-mine', { projectId: f.project.id }, member);
  await gate.started;
  gate.release();
  const [r1, r2] = await Promise.all([c1, c2]);
  assert.deepEqual(r1.data.importedKeys, ['TEST-1']);
  assert.deepEqual(r2.data.importedKeys, ['TEST-1']);
  const searchCalls = f.state.requests.slice(beforeCount).filter(r => r.path === '/rest/api/2/search');
  assert.equal(searchCalls.length, 1);
});

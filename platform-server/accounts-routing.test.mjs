import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createPlatform } from './server.mjs';

async function fixture() {
  const password = randomBytes(24).toString('base64url');
  const credentials = new Map();
  const state = { requests: [], gate: null, headerFailures: 0, catalog: [{ id: '101', key: 'TEST', name: 'L_PROJECT' }, { id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT' }] };
  const register = (label, provider, authMode = 'BEARER') => {
    const token = randomBytes(24).toString('base64url');
    credentials.set(token, { label, provider, authMode, username: 'fixture-user' });
    return token;
  };
  const legacy = register('legacy', 'jira');
  const remote = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const provider = url.pathname.startsWith('/rest/api/2/') ? 'jira'
      : url.pathname.startsWith('/rest/api/') ? 'confluence'
        : url.pathname.startsWith('/api/v4/') ? 'gitlab'
          : url.pathname.startsWith('/oapi/') ? 'yunxiao' : 'jenkins';
    let identity;
    for (const [token, candidate] of credentials) {
      const actual = candidate.authMode === 'PRIVATE_TOKEN'
        ? req.headers[provider === 'yunxiao' ? 'x-yunxiao-token' : 'private-token']
        : req.headers.authorization;
      const expected = candidate.authMode === 'PRIVATE_TOKEN' ? token
        : candidate.authMode === 'BASIC' ? `Basic ${Buffer.from(`${candidate.username}:${token}`).toString('base64')}` : `Bearer ${token}`;
      if (candidate.provider === provider && actual === expected) identity = candidate.label;
    }
    state.requests.push({ provider, identity: identity || 'unexpected', method: req.method, path: url.pathname });
    res.setHeader('Content-Type', 'application/json');
    if (!identity) { state.headerFailures += 1; res.writeHead(401); res.end(JSON.stringify({ message: 'L_AUTH_MISMATCH' })); return; }
    if (state.gate?.path === url.pathname) {
      const gate = state.gate; state.gate = null; gate.started.resolve(); await gate.resume.promise;
    }
    let value;
    if (url.pathname === '/rest/api/2/myself') value = { name: identity, key: identity, displayName: identity, active: true };
    else if (url.pathname === '/rest/api/2/project') value = typeof state.catalog === 'function' ? state.catalog(identity) : state.catalog;
    else if (url.pathname === '/rest/api/2/search') value = { issues: [issue('TEST-1', identity)], total: 1 };
    else if (url.pathname.startsWith('/rest/api/2/issue/')) value = issue(decodeURIComponent(url.pathname.split('/').at(-1)), identity);
    else if (url.pathname === '/rest/api/user/current') value = { type: 'known', username: identity, displayName: identity };
    else if (url.pathname === '/rest/api/content/123') value = { id: '123', title: 'L_DOC_TITLE', body: { storage: { value: `<p>L_DOC_${identity}</p>` } }, version: { number: 1 } };
    else if (url.pathname === '/api/v4/user') value = { id: 7, username: identity, name: identity };
    else if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/merge_requests/7/diffs')) value = [{ old_path: 'app.js', new_path: 'app.js', diff: `+L_CODE_${identity}` }];
    else if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/merge_requests/7')) value = { iid: 7, title: 'L_MR_TITLE', state: 'opened', sha: 'fixture-sha', web_url: `${upstream}/team/repo/-/merge_requests/7` };
    else if (url.pathname === '/whoAmI/api/json') value = { name: identity, authenticated: true };
    else if (url.pathname.includes('/pipelines')) value = [{ pipelineId: 17, pipelineName: 'L_PIPELINE' }];
    else { res.writeHead(404); value = { message: 'L_NOT_FOUND' }; }
    res.end(JSON.stringify(value));
  });
  const issue = (key, identity) => ({ id: key, key, fields: { summary: `L_TITLE_${identity}`, description: 'L_BODY', status: { name: 'L_STATUS' }, issuetype: { id: '9', name: 'L_TYPE' }, project: { id: key.startsWith('OTHER-') ? '102' : '101', key: key.split('-')[0], name: 'L_PROJECT' }, updated: '2026-11-13T00:00:00Z' } });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const upstream = `http://127.0.0.1:${remote.address().port}`;
  const app = createPlatform({ dbPath: ':memory:', connectorKey: randomBytes(32), allowConnectorLoopbackHttp: true, logger: { error() {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let admin = {};
  const call = async (path, method = 'GET', body, actor = admin) => {
    const response = await fetch(base + path, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...(actor?.cookie ? { Cookie: actor.cookie, Origin: base } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); const data = text ? JSON.parse(text) : null;
    return { status: response.status, data, text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const expect = (result, status = 200) => {
    assert.equal(result.status, status, `HTTP ${result.status}, code ${result.data?.error?.code || 'none'}`);
    return result.data;
  };
  expect(await call('/api/setup', 'POST', { username: 'fixture-admin', password }, {}), 201);
  const login = await call('/api/login', 'POST', { username: 'fixture-admin', password }, {});
  admin = { ...expect(login), cookie: login.cookie };
  expect(await call('/api/connectors/jira/config', 'POST', { projectId: 'default', baseUrl: upstream, authMode: 'BEARER', token: legacy }));
  const projects = expect(await call('/api/connectors/jira/sync-projects', 'POST', { projectId: 'default', projectIds: ['101', '102'] })).projects;
  const project = projects.find(item => item.key === 'TEST'); const other = projects.find(item => item.key === 'OTHER');
  const member = async (name = 'fixture-dev', role = 'DEV') => {
    expect(await call('/api/users', 'POST', { username: name, password, role, projectId: project.id }), 201);
    const login = await call('/api/login', 'POST', { username: name, password }, {});
    return { ...expect(login), cookie: login.cookie };
  };
  const account = async (actor, label, provider = 'jira', options = {}) => {
    const authMode = options.authMode || (['gitlab', 'yunxiao'].includes(provider) ? 'PRIVATE_TOKEN' : provider === 'jenkins' ? 'BASIC' : 'BEARER');
    const token = register(label, provider, authMode);
    const result = await call('/api/accounts', 'POST', { provider, name: label, scope: 'PERSONAL', baseUrl: upstream, authMode, token, ...(authMode === 'BASIC' ? { username: 'fixture-user' } : {}), ...(provider === 'yunxiao' ? { organizationId: 'org' } : {}), ...options }, actor);
    const value = expect(result, 201).account;
    assert.ok(!result.text.includes(token), 'Account API must not echo credentials');
    return value;
  };
  const select = async (actor, provider, accountId) => expect(await call('/api/accounts/select', 'POST', { projectId: project.id, provider, accountId }, actor));
  const configure = async provider => {
    const authMode = ['gitlab', 'yunxiao'].includes(provider) ? 'PRIVATE_TOKEN' : provider === 'jenkins' ? 'BASIC' : 'BEARER';
    const token = register(`legacy-${provider}`, provider, authMode);
    expect(await call(`/api/connectors/${provider}/config`, 'POST', { projectId: project.id, baseUrl: upstream, authMode, token, ...(authMode === 'BASIC' ? { username: 'fixture-user' } : {}), ...(provider === 'yunxiao' ? { organizationId: 'org' } : {}) }));
  };
  const gates = [];
  const hold = path => {
    const gate = { path, started: Promise.withResolvers(), resume: Promise.withResolvers() }; state.gate = gate; gates.push(gate);
    return { started: gate.started.promise, release: gate.resume.resolve };
  };
  const waitForStart = async (gate, pending) => {
    let timer;
    try { await Promise.race([gate.started, pending.then(result => { throw new Error(`Operation did not reach gated upstream (HTTP ${result.status}, ${result.data?.error?.code || 'none'})`); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gated upstream was not reached')), 2500); })]); }
    finally { clearTimeout(timer); }
  };
  const auditCount = () => app.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  return { app, admin, project, other, upstream, state, call, expect, member, account, select, configure, register, hold, waitForStart, auditCount,
    async close() { for (const gate of gates) gate.resume.resolve(); await app.close(); await new Promise(resolve => remote.close(resolve)); } };
}

test('Jira intake consumes the exact personal preference or explicit account and keeps legacy default explicit', async t => {
  const f = await fixture(); t.after(() => f.close()); const owner = await f.member();
  const first = await f.account(owner, 'personal-first'); const second = await f.account(owner, 'personal-second');
  await f.select(owner, 'jira', first.id);
  const read = body => f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1', ...body }, owner);
  assert.equal(f.expect(await read({})).issue.title, 'L_TITLE_personal-first');
  assert.equal(f.expect(await read({ accountId: second.id })).issue.title, 'L_TITLE_personal-second');
  assert.equal(f.expect(await read({ accountId: null })).issue.title, 'L_TITLE_legacy');
  assert.equal(f.expect(await f.call('/api/jira/tasks/search', 'POST', { projectId: f.project.id }, owner)).items[0].title, 'L_TITLE_personal-first');
  const imported = f.expect(await f.call('/api/jira/tasks/import', 'POST', { reference: 'TEST-2', accountId: second.id }, owner));
  assert.equal(imported.task.externalRef.title, 'L_TITLE_personal-second'); assert.equal(imported.task.assigneeId, owner.user.id);
  await f.select(owner, 'jira', null);
  assert.equal(f.expect(await read({})).issue.title, 'L_TITLE_legacy');
  assert.equal(f.state.headerFailures, 0); assert.ok(f.state.requests.every(item => item.method === 'GET'));
});

test('Jira lookup and search identify the account actually used and import can pin that identity after preference changes', async t => {
  const f = await fixture(); t.after(() => f.close()); const owner = await f.member();
  const first = await f.account(owner, 'read-identity'); const second = await f.account(owner, 'later-preference');
  await f.select(owner, 'jira', first.id);
  const lookup = f.expect(await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-30' }, owner));
  const search = f.expect(await f.call('/api/jira/tasks/search', 'POST', { projectId: f.project.id }, owner));
  for (const response of [lookup, search]) {
    assert.equal(response.usedAccount.id, first.id); assert.equal(response.usedAccount.name, first.name); assert.equal(response.usedAccount.scope, 'PERSONAL');
    assert.ok(!['token', 'credential', 'authorization', 'username'].some(field => Object.hasOwn(response.usedAccount, field)), 'Used-account metadata must not contain authentication data');
  }
  await f.select(owner, 'jira', second.id);
  const currentSearch = f.expect(await f.call('/api/jira/tasks/search', 'POST', { projectId: f.project.id }, owner));
  assert.equal(currentSearch.usedAccount.id, second.id);
  const imported = f.expect(await f.call('/api/jira/tasks/import', 'POST', { reference: 'TEST-30', accountId: lookup.usedAccount.id }, owner));
  assert.equal(imported.task.externalRef.title, 'L_TITLE_read-identity'); assert.equal(f.state.requests.at(-1).identity, 'read-identity');
  const legacy = f.expect(await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-31', accountId: null }, owner));
  assert.equal(legacy.usedAccount, null);
  await f.select(owner, 'jira', first.id);
  const defaultImport = f.expect(await f.call('/api/jira/tasks/import', 'POST', { reference: 'TEST-31', accountId: legacy.usedAccount }, owner));
  assert.equal(defaultImport.task.externalRef.title, 'L_TITLE_legacy'); assert.equal(f.state.requests.at(-1).identity, 'legacy');
  assert.equal(f.state.headerFailures, 0);
});

test('Jira project sync using a personal or scoped shared account creates no legacy credential copies', async t => {
  const f = await fixture(); t.after(() => f.close());
  const existingChoice = await f.account(f.admin, 'existing-jira-choice');
  await f.select(f.admin, 'jira', existingChoice.id);
  const selectedJiraAccount = async projectId => f.expect(await f.call(`/api/accounts?projectId=${projectId}&provider=jira`)).selectedAccountId;
  for (const [index, scope] of ['PERSONAL', 'PROJECT'].entries()) {
    const selected = await f.account(f.admin, `directory-${scope.toLowerCase()}`, 'jira', scope === 'PROJECT' ? { scope, projectId: f.project.id } : { scope });
    const remoteId = String(103 + index); const remoteKey = scope === 'PERSONAL' ? 'PRIVATE' : 'SHARED';
    f.state.catalog.push({ id: remoteId, key: remoteKey, name: `L_${remoteKey}_PROJECT` });
    const response = f.expect(await f.call('/api/connectors/jira/sync-projects', 'POST', { projectId: f.project.id, accountId: selected.id, projectIds: [remoteId, '101', '102'] }));
    const created = response.projects.find(project => project.key === remoteKey);
    assert.ok(created, 'Selected Jira project must be synchronized'); assert.equal(response.created, 1);
    const connector = f.app.db.prepare('SELECT auth_mode,credential,base_url FROM connector_configs WHERE project_id=? AND provider=?').get(created.id, 'jira');
    assert.ok(connector, 'New project retains a service-address placeholder');
    assert.equal(connector.auth_mode, 'NONE'); assert.equal(connector.base_url, f.upstream);
    assert.ok(connector.credential === null, 'Directory sync must not copy a private or scoped shared credential into a legacy connector');
    assert.equal(await selectedJiraAccount(created.id), scope === 'PERSONAL' ? selected.id : null, 'Only the operator’s personal account may be selected on the new project');
    assert.equal(await selectedJiraAccount(f.project.id), existingChoice.id, 'Re-sync must preserve an existing account preference');
    assert.equal(await selectedJiraAccount(f.other.id), null, 'Re-sync must leave existing projects on their default connection');
    const before = f.state.requests.length;
    const uncredentialed = await f.call('/api/jira/tasks/lookup', 'POST', { projectId: created.id, reference: `${remoteKey}-1`, accountId: null });
    assert.equal(uncredentialed.status, 409); assert.equal(uncredentialed.data.error.code, 'REMOTE_AUTH_REQUIRED');
    assert.equal(f.state.requests.length, before, 'Explicit legacy selection must not reuse the directory-sync account');
  }
  assert.equal(f.state.headerFailures, 0); assert.ok(f.state.requests.every(request => request.method === 'GET'));
});

test('account test uses each provider credential internally and never updates the legacy connector identity', async t => {
  const f = await fixture(); t.after(() => f.close()); const owner = await f.member();
  for (const provider of ['jira', 'confluence', 'gitlab', 'jenkins', 'yunxiao']) {
    if (provider !== 'jira') await f.configure(provider);
    const selected = await f.account(owner, `own-${provider}`, provider);
    const before = f.app.db.prepare('SELECT status,last_checked_at,version FROM connector_configs WHERE project_id=? AND provider=?').get(f.project.id, provider);
    const response = await f.call(`/api/accounts/${selected.id}/test`, 'POST', { projectId: f.project.id, expectedVersion: selected.version }, owner);
    assert.equal(response.status, 200, `Provider ${provider} failed account test (${response.data?.error?.code || 'none'})`);
    assert.equal(f.state.requests.at(-1).identity, `own-${provider}`);
    const saved = f.expect(await f.call(`/api/accounts/${selected.id}`, 'GET', undefined, owner)).account;
    assert.equal(saved.status, 'CONNECTED'); assert.ok(saved.lastCheckedAt);
    assert.deepEqual(f.app.db.prepare('SELECT status,last_checked_at,version FROM connector_configs WHERE project_id=? AND provider=?').get(f.project.id, provider), before);
  }
  assert.equal(f.state.headerFailures, 0);
});

test('private, unavailable and foreign-source account choices never fall back to a shared credential', async t => {
  const f = await fixture(); t.after(() => f.close()); const alice = await f.member('fixture-alice'); const bob = await f.member('fixture-bob');
  const own = await f.account(alice, 'alice-private'); const count = () => f.state.requests.length;
  let before = count();
  assert.equal((await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1', accountId: own.id }, bob)).status, 404);
  assert.equal((await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1', accountId: own.id }, f.admin)).status, 404);
  assert.equal(count(), before);
  await f.select(alice, 'jira', own.id);
  const disabled = f.expect(await f.call(`/api/accounts/${own.id}`, 'PATCH', { expectedVersion: own.version, enabled: false }, alice)).account;
  before = count();
  assert.equal((await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1' }, alice)).status, 409);
  assert.equal(count(), before);
  f.expect(await f.call(`/api/accounts/${own.id}?expectedVersion=${disabled.version}`, 'DELETE', undefined, alice), 204);
  assert.equal((await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1' }, alice)).status, 404);
  assert.equal(count(), before);
  const foreign = await f.account(alice, 'wrong-source', 'jira', { baseUrl: 'http://127.0.0.1:65530' });
  const rejected = await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1', accountId: foreign.id }, alice);
  assert.ok(rejected.status >= 400 && rejected.status < 500, 'Foreign-source account must be rejected before remote access');
  assert.equal(count(), before);
  const paired = f.expect(await f.call('/api/device-authorizations', 'POST', { deviceName: 'account-scope-fixture', tool: 'custom' }, {}), 201);
  f.expect(await f.call('/api/device-authorizations/decision', 'POST', { userCode: paired.userCode, decision: 'APPROVE', projectIds: [f.project.id] }, { cookie: alice.cookie }));
  const device = f.expect(await f.call('/api/device-authorizations/poll', 'POST', { deviceCode: paired.deviceCode }, {}));
  assert.equal((await f.call('/api/accounts', 'GET', undefined, device)).status, 403);
  assert.equal((await f.call('/api/accounts/select', 'POST', { projectId: f.project.id, provider: 'jira', accountId: foreign.id }, device)).status, 403);
});

test('changing a selected Jira account source keeps it manageable but unavailable in its bound project without legacy fallback', async t => {
  const f = await fixture(); t.after(() => f.close()); const owner = await f.member();
  const selected = await f.account(owner, 'selected-original-source');
  await f.select(owner, 'jira', selected.id);
  const before = f.state.requests.length;
  const baseUrl = 'http://127.0.0.1:65530';
  const updated = f.expect(await f.call(`/api/accounts/${selected.id}`, 'PATCH', {
    expectedVersion: selected.version, baseUrl, token: f.register('selected-new-source', 'jira'),
  }, owner)).account;
  assert.equal(updated.baseUrl, baseUrl); assert.equal(updated.enabled, true);
  const saved = f.expect(await f.call(`/api/accounts/${selected.id}`, 'GET', undefined, owner)).account;
  assert.equal(saved.baseUrl, baseUrl); assert.equal(saved.canManage, true); assert.equal(saved.id, selected.id);
  const catalog = f.expect(await f.call(`/api/accounts?projectId=${f.project.id}&provider=jira`, 'GET', undefined, owner));
  assert.equal(catalog.accounts.find(item => item.id === selected.id)?.canUse, false);
  assert.equal(catalog.selectedAccountId, selected.id); assert.equal(catalog.selectionUnavailable, true);
  const connection = f.expect(await f.call(`/api/connectors?projectId=${f.project.id}`, 'GET', undefined, owner)).connectors.find(item => item.provider === 'jira');
  assert.equal(connection.status, 'ACCOUNT_UNAVAILABLE'); assert.equal(connection.hasCredential, false);
  assert.equal(connection.selectionUnavailable, true);
  const legacy = f.expect(await f.call(`/api/connectors?projectId=${f.project.id}&defaults=1`, 'GET', undefined, owner)).connectors.find(item => item.provider === 'jira');
  assert.equal(legacy.hasCredential, true);
  const rejected = f.expect(await f.call('/api/jira/tasks/lookup', 'POST', { reference: 'TEST-1' }, owner), 409);
  assert.equal(rejected.error.code, 'JIRA_PROJECT_SOURCE_MISMATCH');
  assert.equal(f.state.requests.length, before, 'Invalid source must not call either the account or legacy upstream');
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
});

test('rotated credentials, revoked membership and expired sessions invalidate delayed account tests without stale writes', async t => {
  for (const change of ['rotate', 'membership', 'session']) await t.test(change, async () => {
    const f = await fixture(); try {
      const owner = await f.member(); const account = await f.account(owner, 'gated-personal'); const gate = f.hold('/rest/api/2/myself');
      const pending = f.call(`/api/accounts/${account.id}/test`, 'POST', { projectId: f.project.id, expectedVersion: account.version }, owner);
      await f.waitForStart(gate, pending);
      if (change === 'rotate') f.expect(await f.call(`/api/accounts/${account.id}`, 'PATCH', { expectedVersion: account.version, token: f.register('rotated-personal', 'jira') }, owner));
      else if (change === 'membership') f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.project.id, owner.user.id);
      else f.app.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(owner.user.id);
      const audits = f.auditCount(); gate.release(); const result = await pending;
      assert.equal(result.status, change === 'rotate' ? 409 : change === 'membership' ? 403 : 401);
      const saved = f.app.db.prepare('SELECT status,last_checked_at FROM external_accounts WHERE id=?').get(account.id);
      assert.equal(saved.status, 'CONFIGURED'); assert.equal(saved.last_checked_at, null); assert.equal(f.auditCount(), audits);
    } finally { await f.close(); }
  });
});

test('members reuse personal Confluence and GitLab accounts across projects and stale preferences cannot finish imports', async t => {
  const f = await fixture(); t.after(() => f.close()); const owner = await f.member();
  f.expect(await f.call(`/api/projects/${f.other.id}/members`, 'POST', { userId: owner.user.id, role: 'DEV' }));
  const task = f.expect(await f.call('/api/tasks', 'POST', { projectId: f.project.id, jiraKey: 'TEST-20', title: 'Local fixture task' }, owner), 201).task;
  const otherTask = f.expect(await f.call('/api/tasks', 'POST', { projectId: f.other.id, jiraKey: 'OTHER-20', title: 'Second project fixture task' }, owner), 201).task;
  const docs = await f.account(owner, 'private-docs', 'confluence'); const code = await f.account(owner, 'private-code', 'gitlab');
  for (const currentTask of [task, otherTask]) {
    const { id: taskId, projectId } = currentTask;
    for (const account of [docs, code]) {
      f.expect(await f.call('/api/accounts/select', 'POST', { projectId, provider: account.provider, accountId: account.id }, owner));
    }
    const { connectors } = f.expect(await f.call(`/api/connectors?projectId=${projectId}`, 'GET', undefined, owner));
    assert.equal(connectors.find(connector => connector.provider === 'confluence').accountId, docs.id);
    assert.equal(connectors.find(connector => connector.provider === 'gitlab').accountId, code.id);
    const importedDoc = f.expect(await f.call('/api/connectors/confluence/import', 'POST', { projectId, resource: 'confluence_page', pageId: '123', taskId, kind: 'TECH_SPEC' }, owner));
    assert.equal(importedDoc.asset.content, '<p>L_DOC_private-docs</p>');
    const importedCode = f.expect(await f.call('/api/connectors/gitlab/import', 'POST', { projectId, resource: 'gitlab_mr', repositoryId: 'team/repo', mrIid: '7', taskId, kind: 'CODE' }, owner));
    assert.match(importedCode.asset.content, /L_CODE_private-code/);
  }
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM connector_configs WHERE provider IN ('confluence', 'gitlab')").get().n, 0);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM assets').get().n, 4);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM external_imports').get().n, 0);
  assert.deepEqual(new Set(f.app.db.prepare('SELECT account_id FROM account_external_imports').all().map(row => row.account_id)), new Set([docs.id, code.id]));
  assert.deepEqual(f.app.db.prepare('PRAGMA foreign_key_check').all(), []);
  const replacement = await f.account(owner, 'other-docs', 'confluence'); const gate = f.hold('/rest/api/content/123');
  const pending = f.call('/api/connectors/confluence/import', 'POST', { projectId: f.project.id, resource: 'confluence_page', pageId: '123', taskId: task.id, kind: 'TECH_SPEC' }, owner);
  await f.waitForStart(gate, pending); await f.select(owner, 'confluence', replacement.id);
  const before = { assets: f.app.db.prepare('SELECT count(*) AS n FROM assets').get().n, audit: f.auditCount() };
  gate.release(); const result = await pending;
  assert.equal(result.status, 409); assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM assets').get().n, before.assets); assert.equal(f.auditCount(), before.audit);
  assert.equal(f.state.headerFailures, 0); assert.ok(f.state.requests.every(item => item.method === 'GET'));
});

test('a delayed GitLab MR read cannot fetch diffs or import after membership, session or implicit account selection changes', async t => {
  for (const change of ['membership', 'session', 'preference']) await t.test(change, async () => {
    const f = await fixture(); try {
      const owner = await f.member(); await f.configure('gitlab');
      const first = await f.account(owner, 'gated-code', 'gitlab');
      const replacement = change === 'preference' ? await f.account(owner, 'replacement-code', 'gitlab') : null;
      await f.select(owner, 'gitlab', first.id);
      const task = f.expect(await f.call('/api/tasks', 'POST', { projectId: f.project.id, jiraKey: 'TEST-77', title: 'Delayed code fixture' }, owner), 201).task;
      const gate = f.hold(`/api/v4/projects/${encodeURIComponent('team/repo')}/merge_requests/7`);
      const pending = f.call('/api/connectors/gitlab/import', 'POST', { projectId: f.project.id, resource: 'gitlab_mr', repositoryId: 'team/repo', mrIid: '7', taskId: task.id, kind: 'CODE' }, owner);
      await f.waitForStart(gate, pending);
      if (change === 'membership') f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.project.id, owner.user.id);
      else if (change === 'session') f.app.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(owner.user.id);
      else await f.select(owner, 'gitlab', replacement.id);
      const audits = f.auditCount(); const requestsBeforeRelease = f.state.requests.length;
      gate.release(); const result = await pending;
      assert.equal(result.status, change === 'membership' ? 403 : change === 'session' ? 401 : 409);
      assert.equal(f.state.requests.length, requestsBeforeRelease, 'A stale MR response must not dispatch another authenticated GET');
      assert.ok(!f.state.requests.some(item => item.path.endsWith('/diffs')), 'GitLab diffs must not be read after scope loss');
      assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM assets').get().n, 0);
      assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM account_external_imports').get().n, 0);
      assert.equal(f.auditCount(), audits);
    } finally { await f.close(); }
  });
});

test('personal Jira project sync joins only Jira-visible bound projects with base roles and auto-selects personal credentials', async t => {
  const f = await fixture(); t.after(f.close);
  const alice = await f.member('jira-sync-alice', 'DEV');
  const lead = await f.member('jira-sync-lead', 'LEAD');
  const qa = await f.member('jira-sync-qa', 'QA');
  f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(f.project.id, qa.user.id);
  f.state.catalog = identity => {
    if (identity === 'alice-jira') return [
      { id: '101', key: 'TEST', name: 'L_PROJECT' },
      { id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT' },
      { id: '109', key: 'UNBOUND', name: 'L_UNBOUND_PROJECT' },
    ];
    if (identity === 'lead-jira') return [{ id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT' }];
    if (identity === 'qa-jira') return [{ id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT' }];
    return [{ id: '101', key: 'TEST', name: 'L_PROJECT' }, { id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT' }];
  };

  assert.equal((await f.call(`/api/projects/${f.other.id}/members`, 'GET', undefined, alice)).status, 403);
  const aliceAccount = await f.account(alice, 'alice-jira', 'jira');
  const existingPrefAccount = await f.account(alice, 'alice-existing-pref', 'jira');
  await f.select(alice, 'jira', existingPrefAccount.id);

  const synced = f.expect(await f.call(`/api/accounts/${aliceAccount.id}/sync-jira-projects`, 'POST', { expectedVersion: aliceAccount.version }, alice));
  assert.equal(synced.account.status, 'CONNECTED');
  assert.equal(synced.identity.displayName, 'alice-jira');
  assert.equal(synced.joinedCount, 1);
  assert.equal(synced.matchedCount, 2);
  assert.equal(synced.unmatchedRemoteCount, 1);
  assert.equal(synced.joinedProjects[0].key, 'OTHER');
  assert.equal(synced.joinedProjects[0].role, 'DEV');
  assert.ok(synced.projects.some(p => p.id === f.other.id && p.role === 'DEV'));
  assert.equal(f.app.db.prepare("SELECT account_id FROM account_preferences WHERE user_id=? AND project_id=? AND provider='jira'").get(alice.user.id, f.project.id)?.account_id, existingPrefAccount.id, 'existing account preference must not be overwritten');
  assert.equal(f.app.db.prepare("SELECT account_id FROM account_preferences WHERE user_id=? AND project_id=? AND provider='jira'").get(alice.user.id, f.other.id)?.account_id, aliceAccount.id, 'newly joined Jira project auto-selects personal Jira account');

  // Alice can immediately read/lookup Jira tasks in OTHER using her personal Jira account.
  const lookup = f.expect(await f.call('/api/jira/tasks/lookup', 'POST', { projectId: f.other.id, reference: 'OTHER-1' }, alice));
  assert.equal(lookup.issue.key, 'OTHER-1');
  assert.equal(lookup.issue.title, 'L_TITLE_alice-jira');

  // Global LEAD joining via Jira must only receive non-privileged DEV role and retain existing LEAD in TEST.
  const leadAccount = await f.account(lead, 'lead-jira', 'jira');
  const leadSync = f.expect(await f.call(`/api/accounts/${leadAccount.id}/sync-jira-projects`, 'POST', { expectedVersion: leadAccount.version }, lead));
  assert.equal(leadSync.joinedProjects[0].role, 'DEV');
  const leadOther = leadSync.projects.find(p => p.id === f.other.id);
  const leadTest = leadSync.projects.find(p => p.id === f.project.id);
  assert.equal(leadOther.role, 'DEV');
  assert.equal(leadOther.permissions.manageMembers, false);
  assert.equal(leadTest.role, 'LEAD');

  // A zero-project QA user can both test and sync personal Jira account and joins as QA.
  assert.equal(f.expect(await f.call('/api/projects', 'GET', undefined, qa)).projects.length, 0);
  const qaAccount = await f.account(qa, 'qa-jira', 'jira');
  f.expect(await f.call(`/api/accounts/${qaAccount.id}/test`, 'POST', { expectedVersion: qaAccount.version }, qa));
  const qaSync = f.expect(await f.call(`/api/accounts/${qaAccount.id}/sync-jira-projects`, 'POST', { expectedVersion: qaAccount.version }, qa));
  assert.equal(qaSync.joinedCount, 1);
  assert.equal(qaSync.joinedProjects[0].role, 'QA');
  assert.equal(qaSync.projects.length, 1);
  assert.equal(qaSync.projects[0].key, 'OTHER');

  // Security isolation: foreign user, shared PROJECT account, non-Jira account, localDevice, wrong source, and mid-flight invalidation.
  assert.equal((await f.call(`/api/accounts/${aliceAccount.id}/sync-jira-projects`, 'POST', { expectedVersion: aliceAccount.version }, lead)).status, 404);
  const shared = await f.account(lead, 'shared-jira', 'jira', { scope: 'PROJECT', projectId: f.project.id });
  assert.equal((await f.call(`/api/accounts/${shared.id}/sync-jira-projects`, 'POST', { expectedVersion: shared.version }, alice)).data.error.code, 'PERSONAL_ACCOUNT_REQUIRED');
  const conf = await f.account(alice, 'alice-conf', 'confluence');
  assert.equal((await f.call(`/api/accounts/${conf.id}/sync-jira-projects`, 'POST', { expectedVersion: conf.version }, alice)).status, 400);

  const paired = f.expect(await f.call('/api/device-authorizations', 'POST', { deviceName: 'sync-scope-device', tool: 'custom' }, {}), 201);
  f.expect(await f.call('/api/device-authorizations/decision', 'POST', { userCode: paired.userCode, decision: 'APPROVE', projectIds: [f.project.id] }, { cookie: alice.cookie }));
  const device = f.expect(await f.call('/api/device-authorizations/poll', 'POST', { deviceCode: paired.deviceCode }, {}));
  assert.equal((await f.call(`/api/accounts/${aliceAccount.id}/sync-jira-projects`, 'POST', { expectedVersion: aliceAccount.version }, device)).status, 403);

  // Mid-flight credential rotation must not grant membership or update status.
  const dave = await f.member('jira-sync-dave', 'DEV');
  const daveAccount = await f.account(dave, 'alice-jira', 'jira');
  const gate = f.hold('/rest/api/2/project');
  const pending = f.call(`/api/accounts/${daveAccount.id}/sync-jira-projects`, 'POST', { expectedVersion: daveAccount.version }, dave);
  await f.waitForStart(gate, pending);
  f.expect(await f.call(`/api/accounts/${daveAccount.id}`, 'PATCH', { expectedVersion: daveAccount.version, token: f.register('dave-rotated', 'jira') }, dave));
  gate.release();
  assert.equal((await pending).status, 409);
  assert.equal(f.app.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(f.other.id, dave.user.id), undefined);
  assert.equal(f.state.headerFailures, 0);
});

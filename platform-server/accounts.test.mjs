import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlatform } from './server.mjs';
import { createAccounts } from './accounts.mjs';
import { sha } from './common.mjs';

async function fixture({ dbPath = ':memory:', connectorKey = dbPath === ':memory:' ? randomBytes(32) : undefined, initialize = true } = {}) {
  const app = createPlatform({ dbPath, connectorKey, connectorProfiles: {}, logger: { error() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const password = randomBytes(32).toString('base64url');
  const request = async (path, { method = 'GET', body, token } = {}, status = 200) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, `${method} ${path} status`); return data;
  };
  let admin;
  if (initialize) {
    await request('/api/setup', { method: 'POST', body: { username: 'account-admin', password } }, 201);
    admin = await request('/api/login', { method: 'POST', body: { username: 'account-admin', password } });
  }
  const member = async (username, role = 'DEV', projectId = 'default') => {
    const created = await request('/api/users', { method: 'POST', token: admin.token, body: { username, password, role, projectId } }, 201);
    const login = await request('/api/login', { method: 'POST', body: { username, password } }); return { ...created.user, token: login.token };
  };
  const role = (user, id) => {
    if (!app.db.prepare('SELECT id FROM projects WHERE id=?').get(id)) throw Object.assign(new Error('missing project'), { status: 404 });
    if (user.role === 'ADMIN') return 'ADMIN';
    const row = app.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(id, user.id);
    if (!row) throw Object.assign(new Error('forbidden project'), { status: 403 }); return row.role;
  };
  const internal = createAccounts({ db: app.db, dbPath, key: connectorKey, projectRole: role,
    visibleProjects: user => app.db.prepare('SELECT id FROM projects').all().filter(project => { try { role(user, project.id); return true; } catch { return false; } }),
    transaction: action => { app.db.exec('BEGIN IMMEDIATE'); try { const result = action(); app.db.exec('COMMIT'); return result; } catch (error) { app.db.exec('ROLLBACK'); throw error; } }, audit() {} });
  const create = async (actor, override = {}) => {
    const token = randomBytes(24).toString('base64url');
    const response = await request('/api/accounts', { method: 'POST', token: actor.token, body: { provider: 'jira', name: '我的 Jira', scope: 'PERSONAL', baseUrl: 'https://jira.example.invalid', authMode: 'BEARER', token, ...override } }, 201);
    return { account: response.account, secret: token };
  };
  return { app, request, password, admin, member, internal, create, close: () => app.close() };
}

test('personal multiple accounts persist as encrypted metadata and remain private even from ADMIN', async t => {
  const f = await fixture(); t.after(f.close);
  const alice = await f.member('account-alice'); const bob = await f.member('account-bob');
  const first = await f.create(alice); const second = await f.create(alice, { name: '另一个 Jira', authMode: 'BASIC', username: 'private-login-name' });
  const own = await f.request('/api/accounts?provider=jira', { token: alice.token });
  assert.equal(own.accounts.length, 2); assert.ok(own.accounts.every(account => account.canManage && account.canUse && account.status === 'CONFIGURED'));
  const visible = JSON.stringify(own); assert.equal(visible.includes(first.secret), false); assert.equal(visible.includes(second.secret), false); assert.equal(visible.includes('private-login-name'), false); assert.equal(visible.includes('credential'), false);
  for (const other of [bob, f.admin]) {
    assert.equal((await f.request('/api/accounts', { token: other.token })).accounts.length, 0);
    await f.request(`/api/accounts/${first.account.id}`, { token: other.token }, 404);
    await f.request(`/api/accounts/${first.account.id}`, { method: 'PATCH', token: other.token, body: { expectedVersion: 1, name: 'forged' } }, 404);
  }
  const stored = f.app.db.prepare('SELECT credential FROM external_accounts WHERE id=?').get(first.account.id).credential;
  assert.equal(stored.includes(first.secret), false); assert.equal(JSON.parse(stored).v, 1);
  const resolved = f.internal.resolveAccount(alice, first.account.id, 'default', 'jira');
  assert.equal(f.internal.getCredential(resolved).token, first.secret);
  f.internal.recordCheck(alice, resolved, 'default', 'jira', { status: 'ERROR', error: `L100 ${first.secret}` });
  const failed = await f.request(`/api/accounts/${first.account.id}`, { token: alice.token });
  assert.equal(failed.account.lastError.includes(first.secret), false); assert.ok(failed.account.lastError.startsWith('L100 '));
  await f.request('/api/accounts', { method: 'POST', token: alice.token, body: { provider: 'jira', name: 'forged', scope: 'PERSONAL', baseUrl: 'https://jira.example.invalid', authMode: 'BEARER', token: first.secret, ownerId: bob.id } }, 400);
});

test('project shared account management and use follow current project membership and roles', async t => {
  const f = await fixture(); t.after(f.close);
  const leader = await f.member('account-leader', 'LEAD'); const dev = await f.member('account-member');
  const other = (await f.request('/api/projects', { method: 'POST', token: f.admin.token, body: { key: 'OTHER', name: 'Other' } }, 201)).project;
  const outsider = await f.member('account-outsider', 'DEV', other.id);
  const shared = await f.create(leader, { scope: 'PROJECT', projectId: 'default', name: '团队 Jira' });
  const list = await f.request('/api/accounts?projectId=default&provider=jira', { token: dev.token });
  assert.equal(list.accounts.length, 1); assert.equal(list.accounts[0].canManage, false); assert.equal(list.accounts[0].canUse, true);
  f.internal.resolveAccount(dev, shared.account.id, 'default', 'jira');
  await f.request(`/api/accounts/${shared.account.id}`, { method: 'PATCH', token: dev.token, body: { expectedVersion: 1, name: 'forged' } }, 403);
  await f.request(`/api/accounts/${shared.account.id}?expectedVersion=1`, { method: 'DELETE', token: dev.token }, 403);
  await f.request('/api/accounts', { method: 'POST', token: dev.token, body: { scope: 'PROJECT', projectId: 'default', provider: 'jira', name: 'forged', baseUrl: 'https://jira.example.invalid', authMode: 'BEARER', token: 'fixture-value' } }, 403);
  await f.request('/api/accounts?projectId=default', { token: outsider.token }, 403);
  f.app.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run('default', dev.id);
  assert.throws(() => f.internal.resolveAccount(dev, shared.account.id, 'default', 'jira'), error => error.status === 403);
  f.app.db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?').run('DEV', 'default', leader.id);
  await f.request(`/api/accounts/${shared.account.id}`, { method: 'PATCH', token: leader.token, body: { expectedVersion: 1, enabled: false } }, 403);
});

test('account selection is per-user/project/provider and never falls back after disable or delete', async t => {
  const f = await fixture(); t.after(f.close);
  const alice = await f.member('select-alice'); const bob = await f.member('select-bob');
  const first = await f.create(alice); const second = await f.create(alice, { name: 'Secondary' });
  const body = { projectId: 'default', provider: 'jira', accountId: first.account.id };
  await f.request('/api/accounts/select', { method: 'POST', token: alice.token, body });
  assert.equal(f.internal.resolveSelection(alice, { projectId: 'default', provider: 'jira' }).id, first.account.id);
  assert.equal(f.internal.resolveSelection(alice, { projectId: 'default', provider: 'jira', accountId: second.account.id }).id, second.account.id);
  assert.equal(f.internal.resolveSelection(alice, { projectId: 'default', provider: 'jira', accountId: null }), null);
  assert.equal(f.internal.resolveSelection(bob, { projectId: 'default', provider: 'jira' }), null);
  await f.request('/api/accounts/select', { method: 'POST', token: bob.token, body }, 404);
  const disabled = await f.request(`/api/accounts/${first.account.id}`, { method: 'PATCH', token: alice.token, body: { expectedVersion: 1, enabled: false } });
  assert.equal(disabled.account.status, 'DISABLED');
  assert.throws(() => f.internal.resolveSelection(alice, { projectId: 'default', provider: 'jira' }), error => error.code === 'ACCOUNT_DISABLED');
  await f.request(`/api/accounts/${first.account.id}?expectedVersion=2`, { method: 'DELETE', token: alice.token }, 204);
  const deleted = f.app.db.prepare('SELECT credential,deleted_at FROM external_accounts WHERE id=?').get(first.account.id);
  assert.equal(deleted.credential, ''); assert.ok(deleted.deleted_at);
  const stale = await f.request('/api/accounts?projectId=default&provider=jira', { token: alice.token });
  assert.equal(stale.selectedAccountId, first.account.id); assert.equal(stale.selectionUnavailable, true);
  assert.throws(() => f.internal.resolveSelection(alice, { projectId: 'default', provider: 'jira' }), error => error.code === 'ACCOUNT_NOT_FOUND');
  await f.request('/api/accounts/selection', { method: 'POST', token: alice.token, body: { ...body, accountId: null } });
  assert.equal(f.internal.resolveSelection(alice, { projectId: 'default', provider: 'jira' }), null);
});

test('editing and revalidation enforce version, credential origin and immutable ownership', async t => {
  const f = await fixture(); t.after(f.close); const alice = await f.member('version-alice'); const own = await f.create(alice);
  const row = f.internal.resolveAccount(alice, own.account.id, 'default', 'jira');
  await f.request(`/api/accounts/${own.account.id}`, { method: 'PATCH', token: alice.token, body: { expectedVersion: 1, baseUrl: 'https://other.example.invalid' } }, 400);
  await f.request(`/api/accounts/${own.account.id}`, { method: 'PATCH', token: alice.token, body: { expectedVersion: 1, scope: 'PROJECT', projectId: 'default' } }, 400);
  const edited = await f.request(`/api/accounts/${own.account.id}`, { method: 'PATCH', token: alice.token, body: { expectedVersion: 1, name: 'Renamed' } });
  assert.equal(edited.account.version, 2); assert.equal(edited.account.hasCredential, true);
  assert.throws(() => f.internal.revalidateSelection(alice, row, 'default', 'jira'), error => error.code === 'ACCOUNT_CHANGED');
  await f.request(`/api/accounts/${own.account.id}`, { method: 'PATCH', token: alice.token, body: { expectedVersion: 1, enabled: false } }, 409);
  assert.throws(() => f.internal.resolveAccount(alice, own.account.id, 'default', 'gitlab'), error => error.code === 'ACCOUNT_PROVIDER_MISMATCH');
  for (const baseUrl of ['http://example.invalid', 'https://name:private@example.invalid', 'https://example.invalid?token=private']) await f.request('/api/accounts', { method: 'POST', token: alice.token, body: { provider: 'jira', scope: 'PERSONAL', name: 'Invalid', baseUrl, authMode: 'BEARER', token: 'fixture-value' } }, 400);
});

test('Jira project preferences reject other instances without changing the saved choice', async t => {
  const f = await fixture(); t.after(f.close); const alice = await f.member('source-alice');
  const matching = await f.create(alice); const other = await f.create(alice, { name: 'Other instance', baseUrl: 'https://other.example.invalid' });
  f.app.db.prepare('INSERT INTO jira_project_bindings VALUES(?,?,?,?,?,?,?,?)').run('default', 'https://jira.example.invalid', '1', 'PROJ', 'Remote project', 'software', null, new Date().toISOString());
  await f.request('/api/accounts/select', { method: 'POST', token: alice.token, body: { projectId: 'default', provider: 'jira', accountId: matching.account.id } });
  await f.request('/api/accounts/select', { method: 'POST', token: alice.token, body: { projectId: 'default', provider: 'jira', accountId: other.account.id } }, 409);
  const selected = await f.request('/api/accounts?projectId=default&provider=jira', { token: alice.token });
  assert.equal(selected.selectedAccountId, matching.account.id);
  // The other instance remains a valid personal vault account; only project use
  // is restricted, so it can be independently verified or used in another project.
  assert.equal(f.internal.resolveAccount(alice, other.account.id, 'default', 'jira').id, other.account.id);
});

test('AI API accounts are durable configuration, with no fake execution or verification capability', async t => {
  const f = await fixture(); t.after(f.close); const alice = await f.member('ai-alice');
  const ai = await f.create(alice, { provider: 'openai', name: 'API Alias', baseUrl: 'https://api.example.invalid' });
  assert.equal(ai.account.kind, 'AI_API'); assert.equal(ai.account.status, 'CONFIGURED'); assert.deepEqual(ai.account.capabilities, { canVerify: false, canRead: false, canExecute: false });
  await f.request('/api/accounts/select', { method: 'POST', token: alice.token, body: { projectId: 'default', provider: 'openai', accountId: ai.account.id } });
  const row = f.internal.resolveAccount(alice, ai.account.id, 'default', 'openai');
  assert.throws(() => f.internal.recordCheck(alice, row, 'default', 'openai', { status: 'CONNECTED' }), error => error.code === 'ACCOUNT_VERIFICATION_UNSUPPORTED');
  await f.request('/api/accounts', { method: 'POST', token: alice.token, body: { provider: 'anthropic', scope: 'PERSONAL', name: 'Invalid mode', baseUrl: 'https://api.example.invalid', authMode: 'BASIC', username: 'fixture', token: 'fixture-value' } }, 400);
});

test('local device tokens cannot manage or select accounts even for an ADMIN owner', async t => {
  const f = await fixture(); t.after(f.close); const own = await f.create(f.admin);
  const token = randomBytes(32).toString('base64url'); const tokenHash = sha(token); const expires = Date.now() + 60_000;
  f.app.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash, f.admin.user.id, expires);
  f.app.db.prepare('INSERT INTO local_device_sessions(id,token_hash,user_id,device_name,tool,project_ids,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run('fixture-device', tokenHash, f.admin.user.id, 'Fixture device', 'custom', '["default"]', expires, new Date().toISOString());
  for (const [path, method, body] of [
    ['/api/accounts', 'GET'], [`/api/accounts/${own.account.id}`, 'GET'],
    ['/api/accounts/select', 'POST', { projectId: 'default', provider: 'jira', accountId: own.account.id }],
    [`/api/accounts/${own.account.id}`, 'PATCH', { expectedVersion: 1, enabled: false }],
    [`/api/accounts/${own.account.id}?expectedVersion=1`, 'DELETE'],
    [`/api/accounts/${own.account.id}/test`, 'POST', { projectId: 'default' }],
  ]) await f.request(path, { method, body, token }, 403);
  assert.throws(() => f.internal.resolveAccount({ ...f.admin.user, localDevice: {} }, own.account.id, 'default', 'jira'), error => error.code === 'LOCAL_DEVICE_SCOPE');
});

test('deleting an account clears its credential while retaining imported material provenance', async t => {
  const f = await fixture(); t.after(f.close); const own = await f.create(f.admin);
  const task = (await f.request('/api/tasks', { method: 'POST', token: f.admin.token, body: { jiraKey: 'PROVENANCE-1', title: 'Preserved work' } }, 201)).task;
  const asset = (await f.request(`/api/tasks/${task.id}/assets`, { method: 'POST', token: f.admin.token, body: { kind: 'PRD', title: 'Original input', content: 'Original material' } }, 201)).asset;
  f.app.db.prepare('INSERT INTO account_external_imports VALUES(?,?,?,?,?,?,?,?,?,?)').run('fixture-import', own.account.id, 'confluence_page', '1', task.id, 'PRD', '1', asset.sha256, asset.id, new Date().toISOString());
  await f.request(`/api/accounts/${own.account.id}?expectedVersion=1`, { method: 'DELETE', token: f.admin.token }, 204);
  assert.equal(f.app.db.prepare('SELECT local_id FROM account_external_imports WHERE id=?').get('fixture-import').local_id, asset.id);
  assert.equal(f.app.db.prepare('SELECT content FROM assets WHERE id=?').get(asset.id).content, 'Original material');
  assert.equal(f.app.db.prepare('SELECT credential FROM external_accounts WHERE id=?').get(own.account.id).credential, '');
  await f.request(`/api/accounts/${own.account.id}`, { token: f.admin.token }, 404);
});

test('accounts and choices survive a file-backed restart without changing legacy rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-account-persist-')); const dbPath = join(directory, 'fixture.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let f = await fixture({ dbPath, connectorKey: undefined });
  const password = f.password; const owner = f.admin.user; const created = await f.create(f.admin);
  await f.request('/api/accounts/select', { method: 'POST', token: f.admin.token, body: { projectId: 'default', provider: 'jira', accountId: created.account.id } });
  await f.request('/api/connectors/jira/config', { method: 'POST', token: f.admin.token, body: { projectId: 'default', baseUrl: 'https://jira.example.invalid', authMode: 'BEARER', token: randomBytes(24).toString('base64url') } });
  const legacy = f.app.db.prepare('SELECT id,version,credential FROM connector_configs').all();
  await f.close();
  f = await fixture({ dbPath, connectorKey: undefined, initialize: false });
  try {
    const login = await f.request('/api/login', { method: 'POST', body: { username: owner.username, password } });
    const list = await f.request('/api/accounts?projectId=default&provider=jira', { token: login.token });
    assert.equal(list.accounts[0].id, created.account.id); assert.equal(list.selectedAccountId, created.account.id);
    const selected = f.internal.resolveSelection(login.user, { projectId: 'default', provider: 'jira' });
    assert.equal(f.internal.getCredential(selected).token, created.secret);
    assert.deepEqual(f.app.db.prepare('SELECT id,version,credential FROM connector_configs').all(), legacy);
    assert.equal(f.app.db.prepare('SELECT max(version) AS n FROM schema_migrations').get().n, 5);
    assert.equal((await stat(join(directory, 'connectors.key'))).mode & 0o777, 0o600);
    assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

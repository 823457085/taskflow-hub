import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPlatform } from './server.mjs';
import { sha } from './common.mjs';

const password = 'Initial8';
const tooShort = 'Short07';
const nextPassword = 'Changed8';

test('users change their own password and admins reset member passwords', async () => {
  const platform = createPlatform({ dbPath: ':memory:', logger: { error: () => {} } });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async (username, secret) => (await call('/api/login', 'POST', { username, password: secret })).body;
  const pairDevice = userId => {
    const token = randomBytes(32).toString('base64url'); const expires = Date.now() + 3_600_000;
    platform.db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), userId, expires);
    platform.db.prepare('INSERT INTO local_device_sessions (id,token_hash,user_id,device_name,tool,project_ids,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), sha(token), userId, 'test-mac', 'codex-cli', '["default"]', expires, new Date().toISOString());
    return token;
  };
  try {
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password: tooShort })).status, 400);
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password })).status, 201);
    const admin = await login('admin', password);
    assert.equal((await call('/api/users', 'POST', { username: 'developer', password: tooShort, role: 'DEV' }, admin.token)).status, 400);
    assert.equal((await call('/api/users', 'POST', { username: 'developer', password, role: 'DEV' }, admin.token)).status, 201);
    const dev = await login('developer', password);
    const devOther = await login('developer', password);
    const devDevice = pairDevice(dev.user.id);

    assert.equal((await call('/api/me/password', 'POST', { currentPassword: password, newPassword: nextPassword })).status, 401);
    assert.equal((await call('/api/me/password', 'POST', { currentPassword: password, newPassword: tooShort }, dev.token)).status, 400);
    assert.equal((await call('/api/me/password', 'POST', { currentPassword: password, newPassword: password }, dev.token)).body.error.code, 'PASSWORD_UNCHANGED');
    assert.equal((await call('/api/me/password', 'POST', { currentPassword: password, newPassword: nextPassword, userId: admin.user.id }, dev.token)).status, 400);
    assert.equal((await call('/api/me/password', 'POST', { currentPassword: 'wrong-password-value', newPassword: nextPassword }, dev.token)).body.error.code, 'CURRENT_PASSWORD_INVALID');
    assert.equal((await call('/api/me/password', 'POST', { currentPassword: password, newPassword: nextPassword }, devDevice)).body.error.code, 'LOCAL_DEVICE_SCOPE');

    assert.equal((await call('/api/me/password', 'POST', { currentPassword: password, newPassword: nextPassword }, dev.token)).status, 204);
    assert.equal((await call('/api/me', 'GET', undefined, dev.token)).status, 200);
    assert.equal((await call('/api/me', 'GET', undefined, devOther.token)).status, 401);
    assert.equal((await call('/api/me', 'GET', undefined, devDevice)).status, 200);
    assert.equal((await call('/api/login', 'POST', { username: 'developer', password })).status, 401);
    assert.equal((await call('/api/login', 'POST', { username: 'developer', password: nextPassword })).status, 200);

    for (let i = 0; i < 5; i += 1) await call('/api/me/password', 'POST', { currentPassword: 'wrong-password-value', newPassword: password }, dev.token);
    assert.equal((await call('/api/me/password', 'POST', { currentPassword: nextPassword, newPassword: password }, dev.token)).status, 429);

    assert.equal((await call(`/api/users/${admin.user.id}/password`, 'POST', { password: nextPassword }, dev.token)).status, 403);
    assert.equal((await call(`/api/users/${admin.user.id}/password`, 'POST', { password: nextPassword }, admin.token)).body.error.code, 'RESET_SELF_FORBIDDEN');
    assert.equal((await call('/api/users/missing-user/password', 'POST', { password: nextPassword }, admin.token)).status, 404);
    assert.equal((await call(`/api/users/${dev.user.id}/password`, 'POST', { password: tooShort }, admin.token)).status, 400);
    const resetTo = 'Reset008';
    assert.equal((await call(`/api/users/${dev.user.id}/password`, 'POST', { password: resetTo }, admin.token)).status, 204);
    assert.equal((await call('/api/me', 'GET', undefined, dev.token)).status, 401);
    assert.equal((await call('/api/me', 'GET', undefined, devDevice)).status, 401);
    assert.ok(platform.db.prepare('SELECT revoked_at FROM local_device_sessions WHERE user_id=?').all(dev.user.id).every(row => row.revoked_at));
    assert.equal((await call('/api/me', 'GET', undefined, admin.token)).status, 200);
    assert.equal((await call('/api/login', 'POST', { username: 'developer', password: resetTo })).status, 200);

    const audit = await call('/api/audit', 'GET', undefined, admin.token); const serialized = JSON.stringify(audit.body);
    assert.ok(audit.body.audit.some(row => row.action === 'PASSWORD_CHANGE' && row.actorId === dev.user.id));
    assert.ok(audit.body.audit.some(row => row.action === 'PASSWORD_RESET' && row.actorId === admin.user.id));
    for (const secret of [password, nextPassword, resetTo]) assert.ok(!serialized.includes(secret));
  } finally { await platform.close(); }
});

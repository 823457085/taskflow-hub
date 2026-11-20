import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail, textField } from './common.mjs';

export const ACCOUNT_PROVIDERS = ['jira', 'confluence', 'gitlab', 'jenkins', 'yunxiao', 'openai', 'anthropic', 'custom-ai'];
const AI_PROVIDERS = ['openai', 'anthropic', 'custom-ai'];
const AUTH_MODES = ['BEARER', 'BASIC', 'PRIVATE_TOKEN'];
const known = (body, fields) => { if (!body || Object.keys(body).some(name => !fields.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段'); };
const providerValue = value => { if (!ACCOUNT_PROVIDERS.includes(value)) fail(400, 'ACCOUNT_PROVIDER_INVALID', '账号平台不受支持'); return value; };
const expectedVersion = (value, row) => { if (!Number.isInteger(value) || value < 1) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion'); if (value !== row.version) fail(409, 'ACCOUNT_CHANGED', '账号配置已变化，请刷新后重试'); };

export function createAccounts({ db, dbPath, transaction, audit, projectRole, visibleProjects, key: injectedKey, allowLoopbackHttp = false }) {
  let encryptionKey = injectedKey;
  function key() {
    if (encryptionKey) { if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) fail(500, 'CONNECTOR_KEY_INVALID', '本机连接密钥不可用'); return encryptionKey; }
    if (dbPath === ':memory:') return encryptionKey = randomBytes(32);
    const path = resolve(dirname(dbPath), 'connectors.key'); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) { try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    chmodSync(path, 0o600); encryptionKey = readFileSync(path);
    if (encryptionKey.length !== 32) fail(500, 'CONNECTOR_KEY_INVALID', '本机连接密钥不可用'); return encryptionKey;
  }
  const aad = row => Buffer.from(JSON.stringify([row.id, row.provider, row.scope, row.owner_id, row.project_id]));
  function encrypt(row, credential) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(aad(row));
    const data = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  function decrypt(row) {
    try { const sealed = JSON.parse(row.credential); if (sealed.v !== 1) throw new Error(); const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(sealed.iv, 'base64')); cipher.setAAD(aad(row)); cipher.setAuthTag(Buffer.from(sealed.tag, 'base64')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.data, 'base64')), cipher.final()]).toString('utf8')); }
    catch { fail(500, 'ACCOUNT_CREDENTIAL_UNAVAILABLE', '账号凭据无法读取，请由账号管理人重新保存'); }
  }
  function baseUrl(value) {
    const text = textField(value, 'baseUrl', { max: 2000 }); let url;
    try { url = new URL(text); } catch { fail(400, 'INVALID_BASE_URL', '请输入有效的HTTPS服务地址'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || /[\\\x00-\x20\x7f]/.test(text)) fail(400, 'INVALID_BASE_URL', '服务地址需为HTTPS且不含认证信息、参数或片段');
    return url.href.replace(/\/$/, '');
  }
  const stored = id => db.prepare('SELECT * FROM external_accounts WHERE id=? AND deleted_at IS NULL').get(id);
  const assertDevice = user => { if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权管理或选择外部账号'); };
  function access(user, row, manage = false) {
    assertDevice(user);
    if (!row) fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在或无权访问');
    if (row.scope === 'PERSONAL') { if (row.owner_id !== user.id) fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在或无权访问'); }
    else { const role = projectRole(user, row.project_id); if (manage && !['ADMIN', 'LEAD'].includes(role)) fail(403, 'ACCOUNT_FORBIDDEN', '只有项目负责人或管理员可管理项目共享账号'); }
    return row;
  }
  function canManage(user, row) {
    if (row.scope === 'PERSONAL') return row.owner_id === user.id;
    return ['ADMIN', 'LEAD'].includes(projectRole(user, row.project_id));
  }
  function metadata(user, row) {
    return { id: row.id, provider: row.provider, name: row.name, scope: row.scope, ownerId: row.owner_id, projectId: row.project_id,
      baseUrl: row.base_url, authMode: row.auth_mode, organizationId: row.organization_id, enabled: row.enabled === 1,
      status: row.enabled === 1 ? row.status : 'DISABLED', hasCredential: !!row.credential, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at, lastCheckedAt: row.last_checked_at, lastError: row.last_error,
      canManage: canManage(user, row), canUse: row.enabled === 1,
      kind: AI_PROVIDERS.includes(row.provider) ? 'AI_API' : 'PLATFORM',
      capabilities: { canVerify: !AI_PROVIDERS.includes(row.provider), canRead: !AI_PROVIDERS.includes(row.provider), canExecute: false } };
  }
  function resolveAccount(user, id, projectId, provider) {
    assertDevice(user); projectRole(user, projectId); providerValue(provider);
    const row = access(user, stored(textField(id, 'accountId', { max: 64 })));
    if (row.provider !== provider) fail(400, 'ACCOUNT_PROVIDER_MISMATCH', '所选账号与当前平台不匹配');
    if (row.scope === 'PROJECT' && row.project_id !== projectId) fail(403, 'ACCOUNT_PROJECT_MISMATCH', '所选共享账号不属于当前项目');
    if (!row.enabled) fail(409, 'ACCOUNT_DISABLED', '所选账号已停用，请重新选择');
    return row;
  }
  function resolvePersonalAccount(user, id, provider) {
    assertDevice(user); providerValue(provider);
    const row = stored(textField(id, 'accountId', { max: 64 }));
    if (!row) fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在或无权访问');
    if (row.scope === 'PROJECT') {
      access(user, row);
      fail(403, 'PERSONAL_ACCOUNT_REQUIRED', '仅个人账号支持按本人平台权限同步可见项目');
    }
    if (row.owner_id !== user.id) fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在或无权访问');
    if (row.provider !== provider) fail(400, 'ACCOUNT_PROVIDER_MISMATCH', '所选账号与当前平台不匹配');
    if (!row.enabled) fail(409, 'ACCOUNT_DISABLED', '所选账号已停用，请重新选择');
    return row;
  }
  function revalidateSelection(user, row, projectId, provider) {
    const current = resolveAccount(user, row.id, projectId, provider);
    if (current.version !== row.version) fail(409, 'ACCOUNT_CHANGED', '账号配置已变化，请重新读取');
    return current;
  }
  function revalidatePersonalAccount(user, row, provider) {
    const current = resolvePersonalAccount(user, row.id, provider);
    if (current.version !== row.version) fail(409, 'ACCOUNT_CHANGED', '账号配置已变化，请重新读取');
    return current;
  }
  function resolveSelection(user, { accountId, projectId, provider }) {
    assertDevice(user); projectRole(user, projectId); providerValue(provider);
    if (accountId !== undefined && accountId !== null) return resolveAccount(user, accountId, projectId, provider);
    // Explicit null selects the existing project connector. An unusable saved ID
    // must fail closed rather than silently spend or authenticate another account.
    if (accountId === null) return null;
    const preference = db.prepare('SELECT account_id FROM account_preferences WHERE user_id=? AND project_id=? AND provider=?').get(user.id, projectId, provider);
    return preference?.account_id ? resolveAccount(user, preference.account_id, projectId, provider) : null;
  }
  function listAccounts(user, { projectId, provider } = {}) {
    assertDevice(user); if (provider !== undefined) providerValue(provider);
    if (projectId !== undefined) projectRole(user, projectId);
    const visible = new Set(visibleProjects(user).map(project => project.id));
    const rows = db.prepare('SELECT * FROM external_accounts WHERE deleted_at IS NULL ORDER BY created_at,id').all().filter(row =>
      (row.scope === 'PERSONAL' ? row.owner_id === user.id : visible.has(row.project_id) && (projectId === undefined || row.project_id === projectId)) && (provider === undefined || row.provider === provider));
    const selections = db.prepare('SELECT project_id AS projectId,provider,account_id AS accountId FROM account_preferences WHERE user_id=? ORDER BY project_id,provider').all(user.id).filter(row => visible.has(row.projectId) && (projectId === undefined || row.projectId === projectId) && (provider === undefined || row.provider === provider));
    const selectedAccountId = projectId && provider ? selections.find(item => item.projectId === projectId && item.provider === provider)?.accountId || null : null;
    const binding = projectId ? db.prepare('SELECT source_url FROM jira_project_bindings WHERE project_id=?').get(projectId) : null;
    const available = rows.map(row => ({ ...metadata(user, row), canUse: row.enabled === 1 && (row.provider !== 'jira' || !binding || row.base_url === binding.source_url) }));
    return { accounts: available, selections, selectedAccountId, selectionUnavailable: !!selectedAccountId && !available.some(row => row.id === selectedAccountId && row.canUse) };
  }
  function credentialValues(body, previous, nextBase, nextMode) {
    if (!AUTH_MODES.includes(nextMode)) fail(400, 'INVALID_AUTH_MODE', '账号认证方式不受支持');
    if (previous && body.token === undefined && (new URL(previous.base_url).origin !== new URL(nextBase).origin || previous.auth_mode !== nextMode)) fail(400, 'NEW_CREDENTIAL_REQUIRED', '修改服务来源或认证方式时请重新输入凭据');
    const old = previous ? decrypt(previous) : {};
    const token = body.token === undefined ? old.token : textField(body.token, 'token', { max: 8192, preserve: true });
    const username = body.username === undefined ? old.username || '' : textField(body.username, 'username', { min: 0, max: 256, preserve: true });
    if (!token || /[\r\n\x00]/.test(token)) fail(400, 'CREDENTIAL_REQUIRED', '请提供有效的账号访问令牌');
    if (nextMode === 'BASIC' && (!username || /[\r\n:\x00]/.test(username))) fail(400, 'USERNAME_REQUIRED', 'Basic认证需要有效用户名');
    return { username, token };
  }
  const accountMode = (provider, mode) => { if (AI_PROVIDERS.includes(provider) && mode !== 'BEARER') fail(400, 'INVALID_AUTH_MODE', 'AI API账号仅支持BEARER令牌保存'); };
  function organization(body, prior = '') {
    const value = body.organizationId === undefined ? prior : textField(body.organizationId, 'organizationId', { min: 0, max: 100 });
    if (value && !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'INVALID_ORGANIZATION', '云效组织标识格式不正确'); return value;
  }
  function getCredential(row) { const latest = stored(row.id); if (!latest || latest.version !== row.version || !latest.enabled) fail(409, 'ACCOUNT_CHANGED', '账号配置已变化，请重新读取'); return decrypt(latest); }
  function recordCheck(user, row, projectId, provider, { status, error = null } = {}) {
    if (AI_PROVIDERS.includes(provider)) fail(409, 'ACCOUNT_VERIFICATION_UNSUPPORTED', 'AI账号仅支持保存，执行器和验证尚未接入');
    if (!['CONNECTED', 'ERROR'].includes(status)) fail(400, 'INVALID_INPUT', '账号验证状态不受支持');
    transaction(() => {
      if (projectId) revalidateSelection(user, row, projectId, provider);
      else revalidatePersonalAccount(user, row, provider);
      let safeError = typeof error === 'string' ? error : null;
      if (safeError) {
        const credential = getCredential(row);
        const values = [credential.token, credential.username, credential.username && credential.token ? Buffer.from(`${credential.username}:${credential.token}`).toString('base64') : ''];
        for (const value of values.filter(Boolean)) safeError = safeError.split(value).join('[REDACTED]');
      }
      db.prepare('UPDATE external_accounts SET status=?,last_checked_at=?,last_error=? WHERE id=? AND version=?').run(status, new Date().toISOString(), safeError, row.id, row.version);
    });
  }
  function handle({ method, path, url, user, body, send, reauthorize }) {
    if (path !== '/api/accounts' && !path.startsWith('/api/accounts/')) return false;
    assertDevice(user); const actorId = user.id;
    const fresh = () => { if (reauthorize) user = reauthorize(); if (user.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效'); assertDevice(user); return user; };
    fresh();
    if (/^\/api\/accounts\/[A-Za-z0-9_-]{1,64}\/(?:test|sync-jira-projects)$/.test(path)) return false;
    if (path === '/api/accounts') {
      if (method === 'GET') { send(200, listAccounts(user, { projectId: url.searchParams.get('projectId') || undefined, provider: url.searchParams.get('provider') || undefined })); return true; }
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET或POST');
      known(body, ['provider', 'name', 'scope', 'projectId', 'baseUrl', 'authMode', 'username', 'token', 'organizationId']);
      const provider = providerValue(body.provider); const scope = body.scope;
      if (!['PERSONAL', 'PROJECT'].includes(scope)) fail(400, 'ACCOUNT_SCOPE_INVALID', '请选择个人或项目共享账号');
      if (scope === 'PERSONAL' && body.projectId !== undefined) fail(400, 'ACCOUNT_SCOPE_INVALID', '个人账号不绑定到共享项目');
      const projectId = scope === 'PROJECT' ? textField(body.projectId, 'projectId', { max: 64 }) : null;
      if (projectId && !['ADMIN', 'LEAD'].includes(projectRole(user, projectId))) fail(403, 'ACCOUNT_FORBIDDEN', '只有项目负责人或管理员可管理项目共享账号');
      const now = new Date().toISOString(); const row = { id: randomUUID(), provider, name: textField(body.name, 'name', { max: 100 }), scope, owner_id: user.id, project_id: projectId, base_url: baseUrl(body.baseUrl), auth_mode: body.authMode, organization_id: organization(body) };
      accountMode(provider, row.auth_mode);
      const credential = encrypt(row, credentialValues(body, null, row.base_url, row.auth_mode));
      transaction(() => { fresh(); if (projectId) access(user, row, true); db.prepare('INSERT INTO external_accounts (id,provider,name,scope,owner_id,project_id,base_url,auth_mode,credential,organization_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.provider, row.name, row.scope, row.owner_id, row.project_id, row.base_url, row.auth_mode, credential, row.organization_id, now, now); audit(user.id, 'ACCOUNT_CREATE', row.id, projectId); });
      send(201, { account: metadata(user, stored(row.id)) }); return true;
    }
    if (path === '/api/accounts/select' || path === '/api/accounts/selection') {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST'); known(body, ['projectId', 'provider', 'accountId']);
      const projectId = textField(body.projectId, 'projectId', { max: 64 }); const provider = providerValue(body.provider);
      if (body.accountId !== null && typeof body.accountId !== 'string') fail(400, 'INVALID_INPUT', '请选择账号或恢复项目默认连接');
      transaction(() => {
        fresh(); projectRole(user, projectId);
        if (body.accountId !== null) {
          const selected = resolveAccount(user, body.accountId, projectId, provider);
          const binding = provider === 'jira' ? db.prepare('SELECT source_url FROM jira_project_bindings WHERE project_id=?').get(projectId) : null;
          if (binding && selected.base_url !== binding.source_url) fail(409, 'JIRA_PROJECT_SOURCE_MISMATCH', '所选Jira账号与项目绑定的实例不一致');
        }
        db.prepare('INSERT INTO account_preferences(user_id,project_id,provider,account_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,project_id,provider) DO UPDATE SET account_id=excluded.account_id,updated_at=excluded.updated_at').run(user.id, projectId, provider, body.accountId, new Date().toISOString()); audit(user.id, 'ACCOUNT_SELECT', body.accountId || provider, projectId);
      });
      send(200, listAccounts(user, { projectId, provider })); return true;
    }
    const match = path.match(/^\/api\/accounts\/([A-Za-z0-9_-]{1,64})$/);
    if (!match) fail(404, 'NOT_FOUND', '账号接口不存在');
    const row = access(user, stored(match[1]), method !== 'GET');
    if (method === 'GET') { send(200, { account: metadata(user, row) }); return true; }
    if (method === 'DELETE') {
      const version = Number(url.searchParams.get('expectedVersion'));
      transaction(() => { fresh(); const current = access(user, stored(row.id), true); expectedVersion(version, current); const now = new Date().toISOString(); db.prepare("UPDATE external_accounts SET credential='',enabled=0,status='DELETED',version=version+1,deleted_at=?,updated_at=?,last_error=NULL WHERE id=?").run(now, now, row.id); audit(user.id, 'ACCOUNT_DELETE', row.id, row.project_id); });
      // Keep saved IDs as unavailable choices; never silently switch credentials.
      send(204); return true;
    }
    if (method !== 'PATCH') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET、PATCH或DELETE');
    known(body, ['expectedVersion', 'name', 'baseUrl', 'authMode', 'username', 'token', 'organizationId', 'enabled']); expectedVersion(body.expectedVersion, row);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled必须是布尔值');
    const nextBase = body.baseUrl === undefined ? row.base_url : baseUrl(body.baseUrl); const nextMode = body.authMode === undefined ? row.auth_mode : body.authMode;
    accountMode(row.provider, nextMode);
    const credentialChanged = ['token', 'username', 'baseUrl', 'authMode', 'organizationId'].some(name => body[name] !== undefined);
    const sealed = credentialChanged ? encrypt(row, credentialValues(body, row, nextBase, nextMode)) : row.credential;
    const nextName = body.name === undefined ? row.name : textField(body.name, 'name', { max: 100 }); const nextOrg = organization(body, row.organization_id);
    transaction(() => { fresh(); const current = access(user, stored(row.id), true); expectedVersion(body.expectedVersion, current); db.prepare('UPDATE external_accounts SET name=?,base_url=?,auth_mode=?,credential=?,organization_id=?,enabled=?,version=version+1,status=?,updated_at=?,last_checked_at=?,last_error=? WHERE id=?').run(nextName, nextBase, nextMode, sealed, nextOrg, body.enabled === undefined ? row.enabled : Number(body.enabled), credentialChanged ? 'CONFIGURED' : row.status, new Date().toISOString(), credentialChanged ? null : row.last_checked_at, credentialChanged ? null : row.last_error, row.id); audit(user.id, 'ACCOUNT_UPDATE', row.id, row.project_id); });
    send(200, { account: metadata(user, stored(row.id)) }); return true;
  }
  return { handle, listAccounts, resolveAccount, resolvePersonalAccount, resolveSelection, revalidateSelection, revalidatePersonalAccount, getCredential, recordCheck };
}

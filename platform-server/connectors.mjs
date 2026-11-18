import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, ASSET_ROLES, KINDS, fail, sha, textField, taskRow, assetRow, bumpParentContexts, fullGitSha, publicGitRemote } from './common.mjs';
import { parseJiraReference, jiraReferenceMatchesSource } from './jira-reference.mjs';
import { createMergeRequests, mergeRequestPath, mergeSnapshot, sameMergeSnapshot } from './merge-requests.mjs';
const executeFile = promisify(execFile);
const PROVIDERS = {
  jira: { name: 'Jira', capabilities: ['jira_projects', 'jira_issues', 'jira_issue'] },
  confluence: { name: 'Confluence', capabilities: ['confluence_page'] },
  gitlab: { name: 'GitLab', capabilities: ['gitlab_mr'] },
  jenkins: { name: 'Jenkins', capabilities: ['jenkins_jobs', 'jenkins_build'] },
  yunxiao: { name: '云效', capabilities: ['yunxiao_pipelines', 'yunxiao_run', 'yunxiao_repos', 'yunxiao_mrs', 'yunxiao_mr', 'yunxiao_commit'] },
};
function profileEnvironment() {
  const env = process.env;
  return {
    jira: { file: env.TASKFLOW_JIRA_PROFILE, baseUrl: env.TASKFLOW_JIRA_BASE_URL || env.JIRA_BASE_URL, header: env.JIRA_AUTH_HEADER, service: env.TASKFLOW_JIRA_KEYCHAIN_SERVICE, account: env.TASKFLOW_JIRA_KEYCHAIN_ACCOUNT },
    confluence: { file: env.TASKFLOW_CONFLUENCE_PROFILE, baseUrl: env.TASKFLOW_CONFLUENCE_BASE_URL || env.CONFLUENCE_BASE_URL, header: env.CONFLUENCE_AUTH_HEADER, service: env.TASKFLOW_CONFLUENCE_KEYCHAIN_SERVICE, account: env.TASKFLOW_CONFLUENCE_KEYCHAIN_ACCOUNT },
    jenkins: { file: env.TASKFLOW_JENKINS_PROFILE },
    yunxiao: { file: env.TASKFLOW_YUNXIAO_PROFILE, baseUrl: 'https://openapi-rdc.aliyuncs.com', organizationId: env.TASKFLOW_YUNXIAO_ORGANIZATION_ID },
  };
}
function envFields(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value); } catch { fail(409, 'LOCAL_PROFILE_INVALID', '本机连接配置格式不正确'); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}
const positive = (value, name) => { const text = String(value ?? ''); if (!/^[1-9]\d{0,15}$/.test(text)) fail(400, 'INVALID_INPUT', `${name}格式不正确`); return text; };
const cleanProvider = value => { if (!Object.hasOwn(PROVIDERS, value)) fail(404, 'CONNECTOR_NOT_FOUND', '连接器不存在'); return value; };
export function createConnectors({ db, dbPath, transaction, audit, projectRole, visibleProjects, getTask, assertWritable, accounts, workflow, key: injectedKey, profiles = profileEnvironment(), profileReader = readFile, allowLoopbackHttp = false }) {
  let encryptionKey = injectedKey;
  const profileReads = new Map();
  const inFlightSyncMine = new Map();
  async function readProfile(path) {
    let pending = profileReads.get(path);
    if (!pending) {
      pending = profileReader(path, 'utf8'); profileReads.set(path, pending);
      // A blocked OS open cannot always be cancelled. Share it until settlement so retries do not exhaust the file worker pool.
      pending.then(() => profileReads.delete(path), () => profileReads.delete(path));
    }
    let timeout;
    try { return await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new ApiError(409, 'LOCAL_PROFILE_TIMEOUT', '本机连接配置读取超时，请检查凭据文件访问权限')), 3000); })]); }
    finally { clearTimeout(timeout); }
  }
  function key() {
    if (encryptionKey) { if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) fail(500, 'CONNECTOR_KEY_INVALID', '本机连接密钥不可用'); return encryptionKey; }
    if (dbPath === ':memory:') return encryptionKey = randomBytes(32);
    const path = resolve(dirname(dbPath), 'connectors.key');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) { try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    chmodSync(path, 0o600); encryptionKey = readFileSync(path);
    if (encryptionKey.length !== 32) fail(500, 'CONNECTOR_KEY_INVALID', '本机连接密钥不可用');
    return encryptionKey;
  }
  function encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]); return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }); }
  function decrypt(row) { if (row.account) return accounts.getCredential(row.account); if (!row.credential) return { username: '', token: '' }; try { const stored = JSON.parse(row.credential); const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(stored.iv, 'base64')); cipher.setAuthTag(Buffer.from(stored.tag, 'base64')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(stored.data, 'base64')), cipher.final()]).toString('utf8')); } catch { fail(500, 'CONNECTOR_CREDENTIAL_UNAVAILABLE', '连接凭据无法读取，请由管理员重新保存'); } }
  function baseUrl(input) {
    const value = textField(input, 'baseUrl', { max: 2000 }); let url;
    try { url = new URL(value); } catch { fail(400, 'INVALID_BASE_URL', '请输入有效的 HTTPS 服务地址'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || /[\\\x00-\x20\x7f]/.test(value)) fail(400, 'INVALID_BASE_URL', '服务地址需为HTTPS且不含认证信息、参数或片段');
    return url.href.replace(/\/$/, '');
  }
  const configured = (projectId, provider) => { const row = db.prepare('SELECT * FROM connector_configs WHERE project_id=? AND provider=?').get(projectId, provider); if (!row) fail(409, 'CONNECTOR_UNCONFIGURED', '请先保存连接配置'); return row; };
  const profileAvailable = provider => { const profile = profiles[provider]; return !!profile && (!!profile.header || !!profile.file || !!profile.service && !!profile.account && !!profile.baseUrl); };
  const metadata = (provider, row) => ({ provider, name: PROVIDERS[provider].name, status: row?.status || 'UNCONFIGURED', baseUrl: row?.base_url || '', authMode: row?.auth_mode || '', organizationId: row?.organization_id || '', hasCredential: !!row?.credential && row.auth_mode !== 'NONE', lastCheckedAt: row?.last_checked_at || null, lastError: row?.last_error || null, capabilities: PROVIDERS[provider].capabilities, readOnly: true, localProfileAvailable: profileAvailable(provider), ...(row?.account ? { accountId: row.account.id, accountName: row.account.name, accountScope: row.account.scope } : {}) });
  const role = (user, projectId, manage = false) => { const result = projectRole(user, projectId); if (manage && !['ADMIN', 'LEAD'].includes(result)) fail(403, 'CONNECTOR_FORBIDDEN', '连接配置与共享账号读取仅限项目负责人或管理员'); return result; };
  const accountRow = (account, user, projectId) => ({ ...account, project_id: projectId, account, accountActorId: user.id });
  function selectedRow(user, projectId, provider, accountId) {
    const account = accounts?.resolveSelection(user, { projectId, provider, accountId });
    const row = account ? accountRow(account, user, projectId) : configured(projectId, provider);
    if (provider === 'jira') projectBinding(row);
    return row;
  }
  function validateSelected(user, row, accountId) {
    const selected = selectedRow(user, row.project_id, row.provider, accountId);
    if (!!selected.account !== !!row.account || selected.id !== row.id || selected.version !== row.version) fail(409, 'ACCOUNT_CHANGED', '使用账号已变化，请重新读取');
    return selected;
  }
  const mergeRequests = createMergeRequests({ db, workflow, remote, selectedRow, validateSelected, getTask, projectRole, assertWritable, audit });
  function projectBinding(row) {
    const binding = db.prepare('SELECT * FROM jira_project_bindings WHERE project_id=?').get(row.project_id);
    if (binding && binding.source_url !== row.base_url) fail(409, 'JIRA_PROJECT_SOURCE_MISMATCH', 'Jira连接来源与项目绑定不一致，请使用已绑定的Jira实例');
    return binding;
  }
  function saveConfig(provider, user, projectId, body, beforeWrite = () => {}) {
    role(user, projectId, true);
    const base = baseUrl(body.baseUrl); const old = db.prepare('SELECT * FROM connector_configs WHERE project_id=? AND provider=?').get(projectId, provider);
    const binding = provider === 'jira' ? db.prepare('SELECT source_url FROM jira_project_bindings WHERE project_id=?').get(projectId) : null;
    if (binding && binding.source_url !== base) fail(409, 'JIRA_PROJECT_SOURCE_MISMATCH', '不能更换已绑定项目的Jira实例来源');
    const authMode = body.authMode;
    if (!['BEARER', 'BASIC', 'PRIVATE_TOKEN', 'NONE'].includes(authMode)) fail(400, 'INVALID_AUTH_MODE', '认证方式不受支持');
    const prior = old ? decrypt(old) : {};
    if (body.token === undefined && old && authMode !== 'NONE' && (new URL(old.base_url).origin !== new URL(base).origin || old.auth_mode !== authMode)) fail(400, 'NEW_CREDENTIAL_REQUIRED', '修改服务来源或认证方式时请重新输入凭据');
    const token = authMode === 'NONE' ? '' : body.token === undefined ? prior.token : textField(body.token, 'token', { max: 8192, preserve: true });
    const username = body.username === undefined ? prior.username || '' : textField(body.username, 'username', { min: 0, max: 256, preserve: true });
    if (authMode !== 'NONE' && (!token || /[\r\n\x00]/.test(token))) fail(400, 'CREDENTIAL_REQUIRED', '请提供有效的连接令牌');
    if (authMode === 'BASIC' && (!username || /[\r\n:\x00]/.test(username))) fail(400, 'USERNAME_REQUIRED', 'Basic认证需要有效用户名');
    const organizationId = body.organizationId === undefined ? old?.organization_id || '' : textField(body.organizationId, 'organizationId', { min: 0, max: 100 });
    if (organizationId && !/^[A-Za-z0-9_-]+$/.test(organizationId)) fail(400, 'INVALID_ORGANIZATION', '云效组织标识格式不正确');
    const id = old?.id || randomUUID(); const sealed = authMode === 'NONE' ? null : encrypt({ username, token });
    transaction(() => { beforeWrite(); db.prepare(`INSERT INTO connector_configs(id,project_id,provider,base_url,auth_mode,credential,organization_id,status,version,updated_at) VALUES(?,?,?,?,?,?,?,'CONFIGURED',1,?) ON CONFLICT(project_id,provider) DO UPDATE SET base_url=excluded.base_url,auth_mode=excluded.auth_mode,credential=excluded.credential,organization_id=excluded.organization_id,status='CONFIGURED',last_checked_at=NULL,last_error=NULL,version=connector_configs.version+1,updated_at=excluded.updated_at`).run(id, projectId, provider, base, authMode, sealed, organizationId, new Date().toISOString()); audit(user.id, 'CONNECTOR_CONFIGURE', id, projectId); });
    return metadata(provider, configured(projectId, provider));
  }
  async function localConfig(provider) {
    const profile = profiles[provider]; if (!profileAvailable(provider)) fail(409, 'LOCAL_PROFILE_UNAVAILABLE', '本机尚无可复用的已授权连接配置');
    try {
      if (provider === 'jenkins') { const stored = JSON.parse(await readProfile(profile.file)); return { baseUrl: stored.baseUrl, authMode: 'BASIC', username: stored.username, token: stored.token }; }
      if (provider === 'yunxiao') { const stored = JSON.parse(await readProfile(profile.file)); return { baseUrl: profile.baseUrl || 'https://openapi-rdc.aliyuncs.com', authMode: 'PRIVATE_TOKEN', token: stored.token, organizationId: profile.organizationId || '' }; }
      const fields = profile.file ? envFields(await readProfile(profile.file)) : {};
      const prefix = provider.toUpperCase(); let header = profile.header || fields[`${prefix}_AUTH_HEADER`];
      if (!header && profile.service && profile.account) { const result = await executeFile('/usr/bin/security', ['find-generic-password', '-w', '-s', profile.service, '-a', profile.account], { timeout: 5000, maxBuffer: 16384 }); header = result.stdout.trim(); if (!/^(Bearer|Basic) /i.test(header)) header = `Bearer ${header}`; }
      const url = profile.baseUrl || fields[`${prefix}_BASE_URL`];
      if (/^Bearer /i.test(header || '')) return { baseUrl: url, authMode: 'BEARER', token: header.slice(7) };
      if (/^Basic /i.test(header || '')) { const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); const divider = decoded.indexOf(':'); if (divider > 0) return { baseUrl: url, authMode: 'BASIC', username: decoded.slice(0, divider), token: decoded.slice(divider + 1) }; }
      fail(409, 'LOCAL_PROFILE_INVALID', '本机连接配置缺少受支持的认证信息');
    } catch (error) { if (error instanceof ApiError) throw error; fail(409, 'LOCAL_PROFILE_UNAVAILABLE', '本机连接配置无法读取，请确认凭据引用和本机访问权限'); }
  }
  function headers(provider, row, credentials) {
    const result = { Accept: 'application/json' };
    if (row.auth_mode === 'BASIC') result.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}`;
    else if (row.auth_mode === 'BEARER') result.Authorization = `Bearer ${credentials.token}`;
    else if (row.auth_mode === 'PRIVATE_TOKEN') result[provider === 'yunxiao' ? 'x-yunxiao-token' : 'PRIVATE-TOKEN'] = credentials.token;
    return result;
  }
  function redact(message, credentials) {
    let result = String(message);
    for (const value of [credentials.token, credentials.token && encodeURIComponent(credentials.token), credentials.token && Buffer.from(`${credentials.username || ''}:${credentials.token}`).toString('base64')]) if (value) result = result.split(value).join('[凭据已隐藏]');
    return result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [凭据已隐藏]').slice(0, 2000);
  }
  function protectValue(value, credentials, depth = 0) {
    if (depth > 100) fail(502, 'REMOTE_RESPONSE_TOO_DEEP', '远端JSON层级超过支持范围');
    if (typeof value === 'string') {
      let result = value;
      for (const secret of [credentials.token, credentials.token && encodeURIComponent(credentials.token), credentials.token && Buffer.from(`${credentials.username || ''}:${credentials.token}`).toString('base64')]) if (secret) result = result.split(secret).join('[凭据已隐藏]');
      return result;
    }
    if (Array.isArray(value)) return value.map(item => protectValue(item, credentials, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [protectValue(name, credentials, depth + 1), protectValue(item, credentials, depth + 1)]));
    return value;
  }
  async function remote(provider, row, suffix, { method = 'GET', body } = {}) {
    const credentials = decrypt(row); const url = new URL(`${row.base_url}${suffix}`);
    if (url.origin !== new URL(row.base_url).origin) fail(400, 'REMOTE_ORIGIN_REJECTED', '远端地址来源不一致');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = headers(provider, row, credentials);
    if (payload) Object.assign(requestHeaders, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    return new Promise((resolveResult, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers: requestHeaders, agent: false, timeout: 15_000 }, response => {
        const chunks = []; let size = 0;
        if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); reject(new ApiError(502, 'REMOTE_REDIRECT', '远端发生重定向，未向新地址发送凭据')); return; }
        response.on('data', chunk => { size += chunk.length; if (size > 2_097_152) { request.destroy(); reject(new ApiError(502, 'REMOTE_RESPONSE_TOO_LARGE', '远端返回内容超过2MB')); } else chunks.push(chunk); });
        response.on('error', () => reject(new ApiError(502, 'REMOTE_CONNECTION_FAILED', '远端连接中断')));
        response.on('end', () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new ApiError(502, 'REMOTE_INVALID_JSON', `远端未返回有效JSON（HTTP ${response.statusCode}）`)); return; }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = typeof value?.message === 'string' ? value.message : typeof value?.errorMessage === 'string' ? value.errorMessage : Array.isArray(value?.errorMessages) ? value.errorMessages.filter(item => typeof item === 'string').join('\n') : `远端请求失败（HTTP ${response.statusCode}）`;
            reject(new ApiError(502, 'REMOTE_REQUEST_FAILED', redact(message, credentials))); return;
          }
          try { resolveResult({ data: protectValue(value, credentials), nextPage: response.headers['x-next-page'] || '' }); } catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => { request.destroy(); reject(new ApiError(504, 'REMOTE_TIMEOUT', '远端请求超时')); });
      request.on('error', () => reject(new ApiError(502, 'REMOTE_CONNECTION_FAILED', '无法连接远端服务，请检查地址和网络')));
      request.end(payload);
    });
  }
  function current(row) {
    if (row.account) {
      const actor = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(row.accountActorId);
      if (!actor) fail(401, 'UNAUTHENTICATED', '登录已失效');
      return accountRow(accounts.revalidateSelection(actor, row.account, row.project_id, row.provider), actor, row.project_id);
    }
    const now = configured(row.project_id, row.provider); if (now.id !== row.id || now.version !== row.version) fail(409, 'CONNECTOR_CHANGED', '连接配置已变化，请重新执行操作'); return now;
  }
  async function probe(provider, row) {
    if (row.auth_mode === 'NONE') fail(502, 'REMOTE_AUTH_REQUIRED', '连接需要身份认证，匿名响应不能作为接入成功');
    let data; let identity;
    if (provider === 'yunxiao') {
      if (!row.organization_id) fail(409, 'ORGANIZATION_REQUIRED', '请填写云效组织标识后再测试');
      data = (await remote(provider, row, `/oapi/v1/flow/organizations/${encodeURIComponent(row.organization_id)}/pipelines?perPage=1&page=1`)).data;
      if (!Array.isArray(data)) fail(502, 'REMOTE_IDENTITY_INVALID', '云效未返回受保护流水线列表');
      return { verifiedResource: { resource: 'yunxiao_pipelines', organizationId: row.organization_id, count: data.length } };
    }
    const suffix = { jira: '/rest/api/2/myself', confluence: '/rest/api/user/current', gitlab: '/api/v4/user', jenkins: '/whoAmI/api/json' }[provider];
    data = (await remote(provider, row, suffix)).data;
    if (provider === 'jira' && (data?.accountId || data?.name || data?.key) && data.active !== false) identity = { id: String(data.accountId || data.key || data.name), displayName: data.displayName || data.name || data.accountId };
    if (provider === 'confluence' && data?.type !== 'anonymous' && (data?.accountId || data?.username || data?.userKey) && data?.displayName) identity = { id: String(data.accountId || data.userKey || data.username), displayName: data.displayName };
    if (provider === 'gitlab' && Number.isInteger(data?.id) && data?.username && data?.state !== 'blocked') identity = { id: String(data.id), displayName: data.name || data.username };
    if (provider === 'jenkins' && data?.authenticated === true && typeof data.name === 'string' && data.name !== 'anonymous') identity = { id: data.name, name: data.name };
    if (!identity) fail(502, 'REMOTE_IDENTITY_INVALID', '远端未返回已认证身份，不能判定连接成功');
    return { identity };
  }
  async function checked(provider, row, revalidate) {
    let value;
    try { value = await probe(provider, row); }
    catch (error) {
      if (row.account) {
        const user = revalidate();
        if (error instanceof ApiError) accounts.recordCheck(user, row.account, row.project_id, provider, { status: 'ERROR', error: error.message });
      } else transaction(() => {
        revalidate();
        if (error instanceof ApiError) db.prepare("UPDATE connector_configs SET status='ERROR',last_checked_at=?,last_error=? WHERE id=? AND version=?").run(new Date().toISOString(), error.message, row.id, row.version);
      });
      throw error;
    }
    if (row.account) {
      const user = revalidate(); accounts.recordCheck(user, row.account, row.project_id, provider, { status: 'CONNECTED' });
      audit(user.id, 'ACCOUNT_TEST', row.id, row.project_id || null);
    } else transaction(() => {
      const user = revalidate();
      db.prepare("UPDATE connector_configs SET status='CONNECTED',last_checked_at=?,last_error=NULL WHERE id=? AND version=?").run(new Date().toISOString(), row.id, row.version);
      audit(user.id, 'CONNECTOR_TEST', row.id, row.project_id);
    });
    return value;
  }
  const named = value => value && value.id !== undefined && typeof value.name === 'string' ? { id: String(value.id), name: value.name } : null;
  const namedArray = value => Array.isArray(value) ? value.map(named).filter(Boolean) : [];
  function issueValue(row, issue) {
    if (typeof issue?.key !== 'string' || /^LOCAL-T[0-9A-F]{32}$/i.test(issue.key) || typeof issue?.fields?.summary !== 'string') fail(502, 'REMOTE_RESOURCE_INVALID', 'Jira未返回有效事项');
    const fields = issue.fields; const project = fields.project && named(fields.project) && typeof fields.project.key === 'string' ? { ...named(fields.project), key: fields.project.key } : null;
    const binding = projectBinding(row);
    if (binding && (!project || project.id !== binding.remote_id)) fail(403, 'JIRA_PROJECT_SCOPE_MISMATCH', 'Jira返回的事项不属于当前绑定项目');
    const issueType = named(fields.issuetype);
    return { id: String(issue.id || issue.key), key: issue.key, title: fields.summary, summary: fields.summary, status: fields.status?.name || '', description: fields.description ?? '', type: fields.issuetype?.name || '', issueType: issueType ? { ...issueType, subtask: fields.issuetype.subtask === true } : null, project, priority: named(fields.priority), components: namedArray(fields.components), fixVersions: Array.isArray(fields.fixVersions) ? fields.fixVersions.map(value => { const version = named(value); return version ? { ...version, ...(typeof value.released === 'boolean' ? { released: value.released } : {}) } : null; }).filter(Boolean) : [], labels: Array.isArray(fields.labels) ? fields.labels.filter(value => typeof value === 'string') : [], assignee: fields.assignee ? { id: String(fields.assignee.accountId || fields.assignee.key || fields.assignee.name || ''), name: fields.assignee.name || '', displayName: fields.assignee.displayName || '' } : null, parentKey: fields.parent?.key || null, updatedAt: fields.updated || '', externalUrl: `${row.base_url}/browse/${encodeURIComponent(issue.key)}` };
  }
  function scopedJql(jql, binding) {
    if (!binding) return jql;
    let quote = null; let depth = 0; let sortAt = -1;
    for (let index = 0; index < jql.length; index++) {
      const char = jql[index];
      if (quote) { if (char === '\\') index++; else if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') depth++;
      else if (char === ')' && --depth < 0) fail(400, 'INVALID_JQL', 'JQL括号不平衡');
      if (depth === 0 && sortAt < 0 && (index === 0 || /\s/.test(jql[index - 1])) && /^ORDER\s+BY\b/i.test(jql.slice(index))) sortAt = index;
    }
    if (quote || depth !== 0) fail(400, 'INVALID_JQL', 'JQL引号或括号不平衡');
    const condition = (sortAt < 0 ? jql : jql.slice(0, sortAt)).trim(); const order = sortAt < 0 ? '' : jql.slice(sortAt);
    return `project = ${positive(binding.remote_id, 'Jira项目ID')}${condition ? ` AND (${condition})` : ''}${order ? ` ${order}` : ''}`;
  }
  async function jiraProjects(row) {
    const items = (await remote('jira', row, '/rest/api/2/project')).data;
    if (!Array.isArray(items) || items.some(item => !item || !/^\d+$/.test(String(item.id)) || typeof item.key !== 'string' || typeof item.name !== 'string' || item.projectCategory != null && (!named(item.projectCategory)))) fail(502, 'REMOTE_RESOURCE_INVALID', 'Jira未返回有效项目目录');
    return items.map(item => ({ id: String(item.id), key: item.key, name: item.name, projectTypeKey: typeof item.projectTypeKey === 'string' ? item.projectTypeKey : '', category: item.projectCategory ? { ...named(item.projectCategory), ...(typeof item.projectCategory.description === 'string' ? { description: item.projectCategory.description } : {}) } : null, baseUrl: row.base_url }));
  }
  async function syncProjects(row, user, body, revalidate) {
    if (user.role !== 'ADMIN') fail(403, 'PROJECT_SYNC_ADMIN_ONLY', '同步Jira项目目录仅限平台管理员');
    if (!Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.length > 200 || body.projectIds.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) fail(400, 'INVALID_PROJECT_SELECTION', '请选择1至200个有效Jira项目');
    const ids = [...new Set(body.projectIds)]; const catalog = await jiraProjects(row); const selected = ids.map(id => catalog.find(item => item.id === id));
    if (selected.some(item => !item)) fail(404, 'JIRA_PROJECT_NOT_VISIBLE', '所选Jira项目不在当前账号可见目录中');
    let created = 0; let updated = 0; let unchanged = 0;
    transaction(() => {
      user = revalidate();
      role(user, row.project_id, true); current(row);
      for (const item of selected) {
        if (!/^[A-Z][A-Z0-9_-]{0,47}$/.test(item.key) || !item.name.trim() || item.name.length > 100) fail(409, 'JIRA_PROJECT_UNSUPPORTED', 'Jira项目标识或名称超出本地支持范围');
        const binding = db.prepare('SELECT * FROM jira_project_bindings WHERE source_url=? AND remote_id=?').get(row.base_url, item.id);
        const collision = db.prepare('SELECT id FROM projects WHERE key=?').get(item.key);
        if (collision && collision.id !== binding?.project_id) fail(409, 'PROJECT_KEY_CONFLICT', `本地已存在项目 ${item.key}，不能覆盖其他项目或绑定`);
        const now = new Date().toISOString(); const projectId = binding?.project_id || randomUUID(); const category = item.category ? JSON.stringify(item.category) : null;
        if (!binding) {
          db.prepare('INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)').run(projectId, item.key, item.name, now);
          db.prepare('INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,?)').run(projectId, user.id, 'LEAD');
          db.prepare('INSERT INTO jira_project_bindings VALUES(?,?,?,?,?,?,?,?)').run(projectId, row.base_url, item.id, item.key, item.name, item.projectTypeKey, category, now); created++;
        } else {
          const changed = binding.remote_key !== item.key || binding.remote_name !== item.name || binding.project_type_key !== item.projectTypeKey || binding.category !== category;
          if (changed) {
            const currentProject = db.prepare('SELECT name FROM projects WHERE id=?').get(projectId);
            const nextName = currentProject && currentProject.name !== binding.remote_name ? currentProject.name : item.name;
            db.prepare('UPDATE projects SET key=?,name=? WHERE id=?').run(item.key, nextName, projectId);
            db.prepare('UPDATE jira_project_bindings SET remote_key=?,remote_name=?,project_type_key=?,category=?,synced_at=? WHERE project_id=?').run(item.key, item.name, item.projectTypeKey, category, now, projectId);
            updated++;
          } else unchanged++;
        }
        // A private or scoped account is never copied into a new shared connector.
        if (!db.prepare("SELECT id FROM connector_configs WHERE project_id=? AND provider='jira'").get(projectId)) db.prepare(`INSERT INTO connector_configs(id,project_id,provider,base_url,auth_mode,credential,organization_id,status,version,updated_at) VALUES(?,?,'jira',?,?,?,?,'CONFIGURED',1,?)`).run(randomUUID(), projectId, row.base_url, row.account ? 'NONE' : row.auth_mode, row.account ? null : row.credential, row.organization_id, now);
        audit(user.id, 'JIRA_PROJECT_SYNC', projectId, projectId);
      }
    });
    return { projects: visibleProjects(user), created, updated, unchanged };
  }
  async function readResource(provider, row, body, user, revalidate) {
    const resource = body.resource;
    if (!PROVIDERS[provider].capabilities.includes(resource)) fail(400, 'RESOURCE_UNSUPPORTED', '该连接器不支持所选资源');
    if (resource === 'jira_projects') {
      const binding = projectBinding(row);
      if (!binding && user.role !== 'ADMIN') fail(403, 'JIRA_CATALOG_ADMIN_ONLY', '未绑定项目的完整Jira目录仅限平台管理员读取');
      const items = await jiraProjects(row);
      user = revalidate();
      if (!binding && user.role !== 'ADMIN') fail(403, 'JIRA_CATALOG_ADMIN_ONLY', '未绑定项目的完整Jira目录仅限平台管理员读取');
      return { resource, items: binding && user.role !== 'ADMIN' ? items.filter(item => item.id === binding.remote_id) : items, externalUrl: `${row.base_url}/plugins/servlet/project-config` };
    }
    if (resource === 'jira_issues') {
      const jql = textField(body.jql, 'jql', { max: 4000, preserve: true }); const limit = body.limit === undefined ? 20 : body.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'INVALID_LIMIT', 'limit必须为1至50的整数');
      const appliedJql = scopedJql(jql, projectBinding(row));
      const data = (await remote(provider, row, `/rest/api/2/search?${new URLSearchParams({ jql: appliedJql, maxResults: String(limit), fields: 'summary,status,description,issuetype,parent,updated,project,priority,components,fixVersions,labels,assignee' })}`)).data;
      if (!Array.isArray(data?.issues)) fail(502, 'REMOTE_RESOURCE_INVALID', 'Jira未返回事项列表');
      return { resource, items: data.issues.map(issue => issueValue(row, issue)), total: typeof data.total === 'number' ? data.total : data.issues.length, appliedJql, externalUrl: `${row.base_url}/issues/?${new URLSearchParams({ jql: appliedJql })}` };
    }
    if (resource === 'jira_issue') {
      const issueKey = textField(body.issueKey, 'issueKey', { max: 48 }); if (!/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(issueKey)) fail(400, 'INVALID_ISSUE_KEY', 'Jira事项号格式不正确');
      const issue = issueValue(row, (await remote(provider, row, `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=summary,status,description,issuetype,parent,updated,project,priority,components,fixVersions,labels,assignee`)).data);
      if (issue.key !== issueKey) fail(502, 'REMOTE_RESOURCE_INVALID', 'Jira返回的事项与请求不一致');
      return { resource, ...issue, content: typeof issue.description === 'string' ? issue.description : JSON.stringify(issue.description, null, 2), version: issue.updatedAt || sha(JSON.stringify(issue)), externalId: issue.id };
    }
    if (resource === 'confluence_page') {
      const pageId = positive(body.pageId, 'pageId'); const page = (await remote(provider, row, `/rest/api/content/${pageId}?expand=body.storage,version,space`)).data;
      if (String(page?.id) !== pageId || typeof page?.title !== 'string' || typeof page?.body?.storage?.value !== 'string' || !page?.version?.number) fail(502, 'REMOTE_RESOURCE_INVALID', 'Confluence未返回指定页面正文与版本');
      return { resource, externalId: pageId, title: page.title, content: page.body.storage.value, format: 'confluence-storage', version: String(page.version.number), externalUrl: `${row.base_url}/pages/viewpage.action?pageId=${pageId}` };
    }
    if (resource === 'gitlab_mr') {
      const repositoryId = textField(String(body.repositoryId ?? ''), 'repositoryId', { max: 300 }); const iid = positive(body.mrIid, 'mrIid');
      if (['.', '..'].includes(repositoryId)) fail(400, 'INVALID_INPUT', 'GitLab 仓库标识格式不正确');
      const ref = { repositoryId, number: iid };
      const prefix = mergeRequestPath(provider, ref);
      const { data: mr, mr: details } = await mergeRequests.read(row, ref);
      user = revalidate();
      const diffs = await remote(provider, row, `${prefix}/diffs?per_page=100`);
      if (!Array.isArray(diffs.data) || diffs.data.some(diff => typeof diff?.diff !== 'string')) fail(502, 'REMOTE_RESOURCE_INVALID', 'GitLab未返回指定MR的Diff');
      const truncated = !!diffs.nextPage || diffs.data.some(diff => diff.collapsed === true || diff.too_large === true);
      const selected = { iid: mr.iid, title: mr.title, description: mr.description || '', state: mr.state, sha: mr.sha || mr.diff_refs?.head_sha || '', diffs: diffs.data.map(diff => ({ old_path: diff.old_path, new_path: diff.new_path, diff: diff.diff })) };
      const snapshot = mr.state === 'opened' && !truncated && diffs.data.length && fullGitSha(mr.diff_refs?.head_sha) &&
        mr.diff_refs.head_sha.toLowerCase() === details.headSha ? mergeSnapshot(details, details.headSha) : null;
      if (snapshot) {
        user = revalidate();
        const { data: after, mr: latest } = await mergeRequests.read(row, ref);
        if (after.state !== 'opened' || !sameMergeSnapshot(snapshot, mergeSnapshot(latest, latest.headSha)) ||
            ['base_sha', 'head_sha', 'start_sha'].some(key => after.diff_refs?.[key] !== mr.diff_refs[key])) {
          fail(409, 'MR_HEAD_CHANGED', '读取代码差异时合并请求已变化，请重新导入');
        }
      }
      const externalUrl = details.url || `${row.base_url}/${repositoryId.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/${iid}`;
      return { resource, externalId: `${repositoryId}!${iid}`, title: mr.title, content: JSON.stringify({ ...selected, ...(snapshot || {}) }, null, 2),
        version: selected.sha || sha(JSON.stringify(selected)), truncated, externalUrl, mergeSnapshot: snapshot };
    }
    if (resource === 'jenkins_jobs') {
      const data = (await remote(provider, row, '/api/json?tree=jobs[name,fullName,_class]')).data;
      if (!Array.isArray(data?.jobs) || data.jobs.some(job => typeof job?.name !== 'string' || job.fullName !== undefined && typeof job.fullName !== 'string')) fail(502, 'REMOTE_RESOURCE_INVALID', 'Jenkins未返回有效任务列表');
      return { resource, items: data.jobs.map(job => ({ id: job.fullName || job.name, name: job.name, jobName: job.fullName || job.name, isFolder: typeof job._class === 'string' && /(?:Folder|MultiBranchProject)$/.test(job._class) })), externalUrl: `${row.base_url}/` };
    }
    if (resource === 'jenkins_build') {
      const name = textField(body.jobName, 'jobName', { max: 500 }); const parts = name.split('/'); if (parts.some(part => !part || part === '.' || part === '..' || /[?#\\\x00-\x1f]/.test(part))) fail(400, 'INVALID_JOB_NAME', 'Jenkins任务名称格式不正确');
      const number = body.buildNumber === undefined ? 'lastSuccessfulBuild' : String(body.buildNumber); if (!['lastBuild', 'lastSuccessfulBuild'].includes(number)) positive(number, 'buildNumber');
      const jobPath = parts.map(part => `/job/${encodeURIComponent(part)}`).join('');
      const tree = 'number,result,building,timestamp,duration,fullDisplayName,actions[_class,remoteUrls,lastBuiltRevision[SHA1]]';
      const value = (await remote(provider, row, `${jobPath}/${number}/api/json?${new URLSearchParams({ tree })}`)).data;
      if (!Number.isInteger(value?.number) || /^\d+$/.test(number) && String(value.number) !== number || typeof value.building !== 'boolean' || typeof value.fullDisplayName !== 'string') fail(502, 'REMOTE_RESOURCE_INVALID', 'Jenkins未返回指定构建记录');
      const gitCheckouts = [];
      const checkoutKeys = new Set();
      for (const action of Array.isArray(value.actions) ? value.actions : []) {
        if (action?._class !== 'hudson.plugins.git.util.BuildData' || !fullGitSha(action.lastBuiltRevision?.SHA1)) continue;
        const commit = action.lastBuiltRevision.SHA1.toLowerCase();
        const repositories = Array.isArray(action.remoteUrls) ? action.remoteUrls.map(publicGitRemote).filter(Boolean) : [];
        for (const repository of repositories.length ? repositories : [null]) {
          const key = JSON.stringify([repository, commit]);
          if (checkoutKeys.has(key)) continue;
          checkoutKeys.add(key);
          gitCheckouts.push({ repository, commit });
        }
      }
      const selected = { number: value.number, result: value.result, building: value.building, timestamp: value.timestamp, duration: value.duration, fullDisplayName: value.fullDisplayName, ...(gitCheckouts.length ? { gitCheckouts } : {}) };
      return { resource, externalId: `${name}#${value.number}`, title: value.fullDisplayName, content: JSON.stringify(selected, null, 2), version: `${value.number}:${sha(JSON.stringify(selected))}`, externalUrl: `${row.base_url}${jobPath}/${value.number}/` };
    }
    if (!row.organization_id) fail(409, 'ORGANIZATION_REQUIRED', '请填写云效组织标识');
    const organization = encodeURIComponent(row.organization_id); const prefix = `/oapi/v1/flow/organizations/${organization}/pipelines`;
    if (resource === 'yunxiao_pipelines') {
      const pipelines = (await remote(provider, row, `${prefix}?perPage=30&page=1`)).data;
      if (!Array.isArray(pipelines) || pipelines.some(item => !Number.isInteger(item?.pipelineId) || typeof item?.pipelineName !== 'string')) fail(502, 'REMOTE_RESOURCE_INVALID', '云效未返回有效流水线列表');
      return { resource, items: pipelines.map(item => ({ id: item.pipelineId, name: item.pipelineName })), externalUrl: 'https://flow.aliyun.com/' };
    }
    const codeupPrefix = `/oapi/v1/codeup/organizations/${organization}`;
    const safeCodeupUrl = rawUrl => {
      if (typeof rawUrl !== 'string') return 'https://codeup.aliyun.com/';
      try {
        const link = new URL(rawUrl);
        if (link.protocol === 'https:' && link.hostname === 'codeup.aliyun.com' && !link.username && !link.password && !link.search && !link.hash) return link.href;
      } catch { /* fallback */ }
      return 'https://codeup.aliyun.com/';
    };
    const resolveCodeupRepoId = async rawRepo => {
      const input = textField(String(rawRepo ?? ''), 'repositoryId', { max: 300 });
      if (/^[1-9]\d{0,15}$/.test(input)) return input;
      if (/(?:^|\/)\.{1,2}(?:\/|$)|[?#\\\x00-\x1f\x7f]/.test(input)) fail(400, 'INVALID_INPUT', 'Codeup仓库路径格式不正确');
      const normalized = input.startsWith(`${row.organization_id}/`) ? input : `${row.organization_id}/${input.replace(/^\/+/, '')}`;
      const repo = (await remote(provider, row, `${codeupPrefix}/repositories/${encodeURIComponent(normalized)}`)).data;
      user = revalidate();
      if (!repo || !/^[1-9]\d{0,15}$/.test(String(repo.id))) fail(502, 'REMOTE_RESOURCE_INVALID', '云效Codeup未返回有效仓库ID');
      return String(repo.id);
    };
    const formatCodeupDiffBundle = ({ headerLines, commits = [], diffs = [] }) => {
      const sections = [...headerLines];
      let omitted = 0;
      if (Array.isArray(commits) && commits.length) {
        sections.push('', `## 关联提交 (${commits.length})`);
        for (const item of commits.slice(0, 20)) {
          const shortSha = String(item.shortId || item.id || '').slice(0, 10);
          const subject = String(item.title || item.message || '').split(/\r?\n/)[0];
          sections.push(`- \`${shortSha}\` ${subject}${item.authorName ? ` (${item.authorName})` : ''}`);
        }
      }
      if (Array.isArray(diffs) && diffs.length) {
        sections.push('', `## 变更文件 (${diffs.length})`);
        for (const item of diffs.slice(0, 60)) {
          sections.push(`- \`${item.newPath || item.oldPath || 'unknown'}\`${item.newFile ? ' (新增)' : item.deletedFile ? ' (删除)' : item.renamedFile ? ` (重命名自 ${item.oldPath})` : ''}`);
        }
        sections.push('', '## Unified Diff');
        let totalLen = sections.join('\n').length;
        for (const item of diffs) {
          const fileHeader = `### ${item.newPath || item.oldPath || 'file'}`;
          const patch = typeof item.diff === 'string' && item.diff.trim() ? `\`\`\`diff\n${item.diff.trim()}\n\`\`\`` : '_(二进制或无文本差异)_';
          const block = `${fileHeader}\n${patch}`;
          if (totalLen + block.length + 200 > 62_000) { omitted++; continue; }
          sections.push(block);
          totalLen += block.length + 2;
        }
        if (omitted > 0) sections.push(`\n> 其余 ${omitted} 个文件的详细 Diff 已省略以适配本地评审快照上限。`);
      } else {
        sections.push('', '_(远端未返回文件级 Diff 明细)_');
      }
      const text = sections.join('\n');
      return { content: text.slice(0, 64_000), incomplete: omitted > 0 || text.length > 64_000 };
    };
    if (resource === 'yunxiao_repos') {
      const repos = (await remote(provider, row, `${codeupPrefix}/repositories?page=1&perPage=50`)).data;
      if (!Array.isArray(repos) || repos.some(item => !item || !/^[1-9]\d{0,15}$/.test(String(item.id)) || typeof item.name !== 'string')) fail(502, 'REMOTE_RESOURCE_INVALID', '云效Codeup未返回有效仓库列表');
      return {
        resource,
        items: repos.map(item => ({
          id: String(item.id),
          name: item.name,
          pathWithNamespace: typeof item.pathWithNamespace === 'string' ? item.pathWithNamespace : item.name,
          webUrl: safeCodeupUrl(item.webUrl),
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
        })),
        externalUrl: 'https://codeup.aliyun.com/',
      };
    }
    if (resource === 'yunxiao_mrs') {
      const search = body.search === undefined ? '' : textField(body.search, 'search', { min: 0, max: 100 });
      const params = new URLSearchParams({ page: '1', perPage: '30', orderBy: 'updated_at', sort: 'desc', ...(search ? { search } : {}) });
      const items = (await remote(provider, row, `${codeupPrefix}/changeRequests?${params}`)).data;
      if (!Array.isArray(items) || items.some(item => !item || !/^[1-9]\d{0,15}$/.test(String(item.localId)) || !/^[1-9]\d{0,15}$/.test(String(item.projectId)))) fail(502, 'REMOTE_RESOURCE_INVALID', '云效Codeup未返回有效合并请求列表');
      return {
        resource,
        items: items.map(item => ({
          id: `${item.projectId}!${item.localId}`,
          localId: String(item.localId),
          repositoryId: String(item.projectId),
          name: `#${item.localId} · ${typeof item.title === 'string' ? item.title : ''}`,
          title: typeof item.title === 'string' ? item.title : '',
          state: typeof item.state === 'string' ? item.state : typeof item.status === 'string' ? item.status : '',
          sourceBranch: typeof item.sourceBranch === 'string' ? item.sourceBranch : '',
          targetBranch: typeof item.targetBranch === 'string' ? item.targetBranch : '',
          repositoryName: typeof item.nameWithNamespace === 'string' ? item.nameWithNamespace.split('/').pop().trim() : String(item.projectId),
          authorName: typeof item.author?.name === 'string' ? item.author.name : '',
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
          detailUrl: safeCodeupUrl(item.detailUrl || item.webUrl),
        })),
        externalUrl: 'https://codeup.aliyun.com/',
      };
    }
    if (resource === 'yunxiao_mr') {
      const repoId = await resolveCodeupRepoId(body.repositoryId);
      const localId = positive(body.mrLocalId, 'mrLocalId');
      const ref = { organizationId: row.organization_id, repositoryId: repoId, number: localId };
      const { data: cr, mr: details } = await mergeRequests.read(row, ref);
      user = revalidate();
      let compare = { commits: [], diffs: [] };
      let reviewCommit;
      let snapshot = null;
      if (!details.merged && details.state !== 'CLOSED' && details.targetRepository === repoId && details.sourceRepository) {
        try {
          const [head, base] = await Promise.all([
            mergeRequests.branchHead(row, details.sourceRepository, details.sourceBranch),
            mergeRequests.branchHead(row, details.targetRepository, details.targetBranch),
          ]);
          user = revalidate();
          if (head && base) {
            const query = new URLSearchParams({ from: base, to: head });
            const pinned = await remote(provider, row, `${codeupPrefix}/repositories/${repoId}/compares?${query}`);
            user = revalidate();
            if (!pinned.nextPage && !pinned.data?.compareTimeout && !pinned.data?.compareSameRef &&
                pinned.data?.diffs?.length && Array.isArray(pinned.data.diffs) &&
                pinned.data.diffs.every(diff => typeof diff?.diff === 'string' && !diff.too_large && !diff.collapsed)) {
              compare = pinned.data;
              snapshot = mergeSnapshot(details, head);
              reviewCommit = head;
            }
          }
        } catch (error) {
          if (!(error instanceof ApiError) || [401, 403].includes(error.status)) throw error;
        }
      }
      if (fullGitSha(cr.mergedRevision)) {
        try {
          const mergeCommit = (await remote(provider, row, `${codeupPrefix}/repositories/${repoId}/commits/${encodeURIComponent(cr.mergedRevision)}`)).data;
          user = revalidate();
          const parentSha = Array.isArray(mergeCommit?.parentIds) ? mergeCommit.parentIds[0] : '';
          if (mergeCommit?.id === cr.mergedRevision && fullGitSha(parentSha)) {
            const query = new URLSearchParams({ from: parentSha, to: cr.mergedRevision, sourceType: 'commit', targetType: 'commit', straight: 'true' });
            const pinned = (await remote(provider, row, `${codeupPrefix}/repositories/${repoId}/compares?${query}`)).data;
            user = revalidate();
            if (Array.isArray(pinned?.diffs) && pinned.diffs.length && !pinned.compareTimeout && !pinned.compareSameRef) {
              compare = pinned;
              reviewCommit = cr.mergedRevision;
            }
          }
        } catch (error) {
          if (!(error instanceof ApiError) || [401, 403].includes(error.status)) throw error;
        }
      }
      if (!reviewCommit && typeof cr.targetBranch === 'string' && cr.targetBranch && typeof cr.sourceBranch === 'string' && cr.sourceBranch) {
        try {
          compare = (await remote(provider, row, `${codeupPrefix}/repositories/${repoId}/compares?from=${encodeURIComponent(cr.targetBranch)}&to=${encodeURIComponent(cr.sourceBranch)}&sourceType=branch&targetType=branch`)).data || compare;
          user = revalidate();
        } catch (error) {
          if (!(error instanceof ApiError) || [401, 403].includes(error.status)) throw error;
        }
      }
      const externalUrl = safeCodeupUrl(cr.detailUrl || cr.webUrl);
      const { content, incomplete } = formatCodeupDiffBundle({
        headerLines: [
          `# Codeup MR #${localId} · ${cr.title}`,
          `- 状态：${cr.status || cr.state || 'UNKNOWN'}`,
          cr.sourceBranch && cr.targetBranch ? `- 分支：\`${cr.sourceBranch}\` → \`${cr.targetBranch}\`` : '',
          cr.author?.name ? `- 作者：${cr.author.name}` : '',
          cr.mergedRevision ? `- 合并提交：\`${cr.mergedRevision}\`` : '',
          reviewCommit ? `- Commit SHA：\`${reviewCommit}\`` : '',
          `- 原始链接：${externalUrl}`,
          cr.description ? `\n## 变更说明\n${cr.description}` : '',
        ].filter(Boolean),
        commits: compare.commits,
        diffs: compare.diffs,
      });
      return {
        resource,
        externalId: `${row.organization_id}:${repoId}!${localId}`,
        title: `#${localId} · ${cr.title}`.slice(0, 200),
        content,
        version: String(cr.mergedRevision || cr.updateTime || sha(content)),
        externalUrl,
        mergeSnapshot: incomplete ? null : snapshot,
      };
    }
    if (resource === 'yunxiao_commit') {
      const repoId = await resolveCodeupRepoId(body.repositoryId);
      const commitSha = textField(body.commitSha, 'commitSha', { max: 64 });
      if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) fail(400, 'INVALID_INPUT', 'Commit SHA格式不正确');
      const commit = (await remote(provider, row, `${codeupPrefix}/repositories/${repoId}/commits/${encodeURIComponent(commitSha)}`)).data;
      user = revalidate();
      if (typeof commit?.id !== 'string' || typeof commit?.message !== 'string') fail(502, 'REMOTE_RESOURCE_INVALID', '云效Codeup未返回指定提交记录');
      let compare = { commits: [commit], diffs: [] };
      const parentSha = Array.isArray(commit.parentIds) && typeof commit.parentIds[0] === 'string' ? commit.parentIds[0] : '';
      if (/^[0-9a-f]{7,64}$/i.test(parentSha)) {
        try {
          compare = (await remote(provider, row, `${codeupPrefix}/repositories/${repoId}/compares?from=${encodeURIComponent(parentSha)}&to=${encodeURIComponent(commit.id)}`)).data || compare;
          user = revalidate();
        } catch { /* root or unavailable parent diff */ }
      }
      const externalUrl = safeCodeupUrl(commit.webUrl);
      const subject = String(commit.title || commit.message).split(/\r?\n/)[0];
      const { content } = formatCodeupDiffBundle({
        headerLines: [
          `# Codeup Commit \`${commit.shortId || commit.id.slice(0, 8)}\` · ${subject}`,
          `- Commit SHA：\`${commit.id}\``,
          commit.authorName ? `- 作者：${commit.authorName}` : '',
          commit.committedDate ? `- 提交时间：${commit.committedDate}` : '',
          `- 原始链接：${externalUrl}`,
          '',
          '## 提交信息',
          commit.message.trim(),
        ].filter(Boolean),
        commits: [],
        diffs: compare.diffs,
      });
      return {
        resource,
        externalId: `${row.organization_id}:${repoId}@${commit.id}`,
        title: `${commit.shortId || commit.id.slice(0, 8)} · ${subject}`.slice(0, 200),
        content,
        version: commit.id,
        externalUrl,
      };
    }
    const pipelineId = positive(body.pipelineId, 'pipelineId'); const runId = positive(body.runId, 'runId'); const run = (await remote(provider, row, `${prefix}/${pipelineId}/runs/${runId}`)).data;
    if (String(run?.pipelineId) !== pipelineId || String(run?.pipelineRunId) !== runId || typeof run.status !== 'string') fail(502, 'REMOTE_RESOURCE_INVALID', '云效返回的运行记录与请求不一致');
    const selected = { pipelineId: run.pipelineId, pipelineRunId: run.pipelineRunId, status: run.status, startTime: run.startTime, endTime: run.endTime, stages: run.stages || [] };
    return { resource, externalId: `${row.organization_id}/${pipelineId}/${runId}`, title: run.name || run.pipelineName, content: JSON.stringify(selected, null, 2), version: sha(JSON.stringify(selected)), externalUrl: `https://flow.aliyun.com/pipelines/${pipelineId}/current` };
  }
  const sameSource = (external, row) => external?.provider === 'jira' && (external.baseUrl ? external.baseUrl === row.base_url : typeof external.url === 'string' && external.url.startsWith(`${row.base_url}/browse/`));
  function jiraExternal(row, result, version) {
    const requirementFields = { title: result.title, description: result.description, project: result.project, type: result.type, issueType: result.issueType, priority: result.priority, components: result.components, fixVersions: result.fixVersions, labels: result.labels, parentKey: result.parentKey };
    return { provider: 'jira', baseUrl: row.base_url, id: result.externalId, key: result.key, ...requirementFields, status: result.status, assignee: result.assignee, url: result.externalUrl, version, requirementsHash: sha(JSON.stringify(requirementFields)) };
  }
  function linkParent(task, parent, user) {
    if (task.parentId === (parent?.id || null)) return false;
    assertWritable(task, user);
    if (parent) {
      assertWritable(parent, user); let ancestor = parent; const visited = new Set([task.id]);
      while (ancestor) { if (visited.has(ancestor.id)) fail(409, 'TASK_TREE_INVALID', 'Jira父子关系会形成循环，未更新本地任务'); visited.add(ancestor.id); ancestor = ancestor.parentId ? getTask(ancestor.parentId, user) : null; }
    }
    db.prepare('UPDATE tasks SET parent_id=?,version=version+1,context_version=context_version+1,updated_at=? WHERE id=?').run(parent?.id || null, new Date().toISOString(), task.id);
    bumpParentContexts(db, [task.parentId, parent?.id]);
    audit(user.id, 'JIRA_PARENT_LINK', task.id, task.projectId); return true;
  }
  function importResource(provider, row, user, body, result) {
    current(row); const projectId = row.project_id; const currentRole = role(user, projectId, !row.account);
    if (['jira_projects', 'jira_issues', 'yunxiao_pipelines', 'yunxiao_repos', 'yunxiao_mrs', 'jenkins_jobs'].includes(result.resource)) fail(400, 'IMPORT_RESOURCE_REQUIRED', '请选择具体事项、合并请求或运行记录后导入');
    if (result.truncated) fail(409, 'REMOTE_CONTENT_INCOMPLETE', '远端Diff未完整返回，不能作为完整代码资产导入');
    const contentHash = sha(result.content || ''); const version = String(result.version || contentHash);
    let response;
    transaction(() => {
      role(user, projectId, !row.account); current(row);
      if (provider === 'jira' && body.asAsset !== true) {
        if (row.account && !['ADMIN', 'LEAD', 'PM'].includes(currentRole)) fail(403, 'CONNECTOR_FORBIDDEN', '请通过任务接入入口登记本人任务');
        const binding = projectBinding(row);
        if (result.project && !binding) {
          const target = db.prepare('SELECT b.project_id,p.key FROM jira_project_bindings b JOIN projects p ON p.id=b.project_id WHERE b.source_url=? AND b.remote_id=?').get(row.base_url, result.project.id);
          if (target) { projectRole(user, target.project_id); throw new ApiError(409, 'PROJECT_MAPPING_REQUIRED', `请切换到 Jira 项目 ${target.key} 后导入该事项`, { targetProjectId: target.project_id, targetProjectKey: target.key }); }
          fail(409, 'PROJECT_MAPPING_REQUIRED', `请先同步 Jira 项目 ${result.project.key}，再在对应项目中导入事项`);
        }
        let task = body.taskId ? getTask(textField(body.taskId, 'taskId', { max: 64 }), user) : taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=?').get(result.key));
        if (task && (task.projectId !== projectId || task.jiraKey !== result.key)) fail(409, 'JIRA_TASK_CONFLICT', '该Jira事项已关联其他本地任务或项目');
        if (task?.externalRef && !sameSource(task.externalRef, row)) fail(409, 'JIRA_TASK_SOURCE_CONFLICT', '该任务已关联其他Jira实例，不能覆盖原始来源');
        if ((result.content || '').length > 65_536) fail(409, 'REMOTE_CONTENT_TOO_LARGE', 'Jira正文超出本地导入长度限制，请先查看原事项');
        const external = jiraExternal(row, result, version);
        let imported = false;
        const previous = task?.externalRef || null;
        if (task) {
          if (JSON.stringify(previous) !== JSON.stringify(external)) {
            assertWritable(task, user);
            const affectsInputs = previous?.requirementsHash !== external.requirementsHash;
            db.prepare('UPDATE tasks SET jira_verified=1,external_ref=?,version=version+1,context_version=context_version+?,updated_at=? WHERE id=?').run(JSON.stringify(external), affectsInputs ? 1 : 0, new Date().toISOString(), task.id); imported = true;
          }
        } else {
          if (!result.title.trim() || result.title.length > 200) fail(409, 'REMOTE_TITLE_TOO_LONG', 'Jira标题超出本地任务长度限制，请先查看原事项');
          const id = randomUUID(); const now = new Date().toISOString();
          db.prepare('INSERT INTO tasks (id,jira_key,title,owner_id,created_at,updated_at,project_id,parent_id,task_type,assignee_id,jira_verified,external_ref) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)').run(id, result.key, result.title, user.id, now, now, projectId, null, 'TASK', user.id, JSON.stringify(external));
          task = getTask(id, user); imported = true;
        }
        task = getTask(task.id, user);
        const parent = result.parentKey ? taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=? AND project_id=?').get(result.parentKey, projectId)) : null;
        if (parent && sameSource(parent.externalRef, row)) imported = linkParent(task, parent, user) || imported;
        else if (previous?.parentKey && previous.parentKey !== result.parentKey && task.parentId) imported = linkParent(task, null, user) || imported;
        const linkedChildren = []; const skippedChildren = [];
        for (const child of db.prepare('SELECT * FROM tasks WHERE project_id=? AND id<>? AND external_ref IS NOT NULL').all(projectId, task.id).map(taskRow)) {
          if (!sameSource(child.externalRef, row) || child.externalRef.parentKey !== task.jiraKey || child.parentId === task.id) continue;
          try { if (linkParent(child, getTask(task.id, user), user)) { linkedChildren.push(child.id); imported = true; } }
          catch (error) { if (error instanceof ApiError && ['TASK_DONE', 'ANCESTOR_DONE'].includes(error.code)) skippedChildren.push({ id: child.id, jiraKey: child.jiraKey, reason: error.code }); else throw error; }
        }
        if (imported) audit(user.id, 'JIRA_IMPORT', task.id, projectId);
        response = { imported, task: getTask(task.id, user), externalUrl: result.externalUrl, linkedChildren, skippedChildren }; return;
      }
      const task = getTask(textField(body.taskId, 'taskId', { max: 64 }), user); if (task.projectId !== projectId) fail(403, 'IMPORT_PROJECT_MISMATCH', '任务与连接器不属于同一项目');
      const codeupResource = provider === 'yunxiao' && ['yunxiao_mr', 'yunxiao_commit'].includes(result.resource);
      const kind = body.kind || (codeupResource ? 'CODE' : { jira: 'PRD', confluence: 'PRD', gitlab: 'CODE', jenkins: 'RELEASE_PLAN', yunxiao: 'RELEASE_PLAN' }[provider]);
      if (!KINDS.includes(kind) || ['jira', 'confluence'].includes(provider) && !['PRD', 'TECH_SPEC'].includes(kind) || provider === 'gitlab' && kind !== 'CODE' || provider === 'jenkins' && kind !== 'RELEASE_PLAN' || provider === 'yunxiao' && (codeupResource ? kind !== 'CODE' : kind !== 'RELEASE_PLAN')) fail(400, 'IMPORT_KIND_INVALID', '该资源不支持所选资产类型');
      if (!ASSET_ROLES[kind].includes(currentRole)) fail(403, 'ASSET_FORBIDDEN', '当前项目角色无权导入此类资产');
      const assetTitleRaw = provider === 'jira' ? `${result.key} · ${result.title}`.slice(0, 200) : result.title;
      const assetContent = provider === 'jira'
        ? [
          `# ${result.key} · ${result.title}`,
          result.type ? `- 类型：${result.type}` : '',
          result.status ? `- Jira 状态：${result.status}` : '',
          result.priority?.name ? `- 优先级：${result.priority.name}` : '',
          result.parentKey ? `- 父事项：${result.parentKey}` : '',
          result.externalUrl ? `- 原始链接：${result.externalUrl}` : '',
          '',
          '## 事项描述',
          result.content || '（无正文描述）',
        ].filter(Boolean).join('\n').slice(0, 65_536)
        : result.content;
      const effectiveContentHash = provider === 'jira' ? sha(assetContent) : contentHash;
      const logicalKey = `${provider}:${result.resource}:${sha(`${row.base_url}#${result.externalId}`).slice(0, 24)}`;
      const remoteVersion = JSON.stringify({ baseUrl: row.base_url, version, ...(result.mergeSnapshot ? { mergeSnapshot: result.mergeSnapshot } : {}) });
      const importsTable = row.account ? 'account_external_imports' : 'external_imports';
      const sourceColumn = row.account ? 'account_id' : 'connector_id';
      const existing = db.prepare(`SELECT local_id FROM ${importsTable} WHERE ${sourceColumn}=? AND resource=? AND external_id=? AND task_id=? AND kind=? AND remote_version=? AND content_hash=?`).get(row.id, result.resource, result.externalId, task.id, kind, remoteVersion, effectiveContentHash);
      if (existing) { response = { imported: false, asset: assetRow(db.prepare('SELECT * FROM assets WHERE id=?').get(existing.local_id)), externalUrl: result.externalUrl }; return; }
      assertWritable(task, user); const title = assetTitleRaw === undefined ? result.externalId : textField(assetTitleRaw, 'title', { max: 200, preserve: true }); textField(assetContent, 'content', { max: 65_536, preserve: true });
      const revision = db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM assets WHERE task_id=? AND kind=? AND logical_key=?').get(task.id, kind, logicalKey).revision;
      const id = randomUUID(); const now = new Date().toISOString();
      db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, task.id, projectId, kind, logicalKey, title, assetContent, result.externalUrl, revision, effectiveContentHash, user.id, now);
      db.prepare(`INSERT INTO ${importsTable} VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), row.id, result.resource, result.externalId, task.id, kind, remoteVersion, effectiveContentHash, id, now);
      db.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(now, task.id); audit(user.id, 'CONNECTOR_ASSET_IMPORT', id, projectId);
      response = { imported: true, asset: assetRow(db.prepare('SELECT * FROM assets WHERE id=?').get(id)), externalUrl: result.externalUrl };
    });
    return response;
  }
  function jiraIntakeTarget(user, reference, hint) {
    if (hint !== undefined) projectRole(user, textField(hint, 'projectId', { max: 64 }));
    const prefix = reference.key.split('-')[0];
    const projects = visibleProjects(user).filter(project => project.jira?.key === prefix);
    if (!projects.length) fail(404, 'JIRA_PROJECT_NOT_AVAILABLE', '没有可访问且已绑定的Jira项目，请先选择项目或联系项目负责人');
    const matching = projects.filter(project => jiraReferenceMatchesSource(reference, project.jira.baseUrl));
    if (!matching.length) fail(400, 'JIRA_SOURCE_MISMATCH', 'Jira链接与已配置的项目来源不一致');
    const preferred = matching.find(project => project.id === hint);
    if (!preferred && matching.length > 1) fail(409, 'JIRA_PROJECT_AMBIGUOUS', '多个Jira实例包含此任务号，请粘贴完整事项链接或选择对应项目');
    return preferred || matching[0];
  }
  function intakeExisting(row, key) {
    const task = taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=?').get(key));
    if (task && task.projectId !== row.project_id) fail(409, 'JIRA_TASK_CONFLICT', '该Jira事项已登记在其他本地项目，不能重复接入');
    if (task?.externalRef && (!sameSource(task.externalRef, row) || task.externalRef.key !== key)) fail(409, 'JIRA_TASK_SOURCE_CONFLICT', '该任务已关联其他Jira实例，不能覆盖原始来源');
    return task || null;
  }
  async function jiraIntake({ action, body, user, reauthorize }) {
    const allowed = action === 'search' ? ['projectId', 'query', 'accountId'] : action === 'import' ? ['reference', 'projectId', 'accountId', 'parentTaskId'] : ['reference', 'projectId', 'accountId'];
    if (Object.keys(body).some(name => !allowed.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
    let reference; let project;
    if (action === 'search') {
      const projectId = textField(body.projectId, 'projectId', { max: 64 }); projectRole(user, projectId);
      project = visibleProjects(user).find(item => item.id === projectId);
      if (!project?.jira) fail(409, 'JIRA_PROJECT_NOT_BOUND', '请先选择已绑定的Jira项目');
    } else {
      try { reference = parseJiraReference(body.reference); }
      catch { fail(400, 'INVALID_JIRA_REFERENCE', '请输入有效且不含认证信息的Jira事项链接或任务号'); }
      project = jiraIntakeTarget(user, reference, body.projectId);
    }
    const row = selectedRow(user, project.id, 'jira', body.accountId);
    const binding = projectBinding(row);
    if (!binding || binding.remote_id !== project.jira.id || binding.remote_key !== project.jira.key) fail(409, 'JIRA_PROJECT_CHANGED', 'Jira项目绑定已变化，请重新读取');
    if (row.auth_mode === 'NONE') fail(409, 'REMOTE_AUTH_REQUIRED', 'Jira事项读取需要已配置的身份认证，请联系项目负责人');
    const actorId = user.id;
    const validate = () => {
      if (reauthorize) user = reauthorize();
      if (user.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效');
      projectRole(user, project.id); current(row);
      validateSelected(user, row, body.accountId);
      const currentBinding = projectBinding(row);
      if (!currentBinding || currentBinding.remote_id !== binding.remote_id || currentBinding.remote_key !== binding.remote_key || currentBinding.source_url !== binding.source_url) fail(409, 'JIRA_PROJECT_CHANGED', 'Jira项目绑定已变化，请重新读取');
      return user;
    };
    validate();
    let result;
    try {
      if (action === 'search') {
        const query = body.query === undefined ? '' : textField(body.query, 'query', { min: 0, max: 100 });
        // This is a plain text picker query, never caller-supplied JQL.
        const escaped = query.replace(/[\\+\-&|!(){}\[\]^"~*?:/]/g, '\\$&');
        const condition = /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/.test(query) ? `key = ${JSON.stringify(query.toUpperCase())}` : query ? `summary ~ ${JSON.stringify(escaped)}` : '';
        result = await readResource('jira', row, { resource: 'jira_issues', jql: `${condition}${condition ? ' ' : ''}ORDER BY updated DESC`, limit: 30 }, user, validate);
      } else result = await readResource('jira', row, { resource: 'jira_issue', issueKey: reference.key }, user, validate);
    } finally { validate(); }
    const currentProject = () => visibleProjects(user).find(item => item.id === project.id);
    const usedAccount = row.account ? { id: row.account.id, name: row.account.name, scope: row.account.scope } : null;
    if (action === 'search') return { project: currentProject(), items: result.items, total: result.total, usedAccount };
    const existingTask = intakeExisting(row, reference.key);
    if (action === 'lookup') return { project: currentProject(), issue: result, existingTask, usedAccount };
    let task; let existing;
    transaction(() => {
      validate();
      task = intakeExisting(row, reference.key); existing = !!task;
      if (task) return;
      if (!result.title.trim() || result.title.length > 200) fail(409, 'REMOTE_TITLE_TOO_LONG', 'Jira标题超出本地任务长度限制，请先查看原事项');
      if ((result.content || '').length > 65_536) fail(409, 'REMOTE_CONTENT_TOO_LARGE', 'Jira正文超出本地导入长度限制，请先查看原事项');
      const parent = result.parentKey ? taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=? AND project_id=?').get(result.parentKey, project.id)) : null;
      const linkedParent = parent && sameSource(parent.externalRef, row) ? parent : null;
      if (linkedParent) assertWritable(linkedParent, user);
      const assignee = db.prepare('SELECT user_id FROM project_members WHERE project_id=? AND user_id=?').get(project.id, user.id) ? user.id : null;
      const id = randomUUID(); const now = new Date().toISOString(); const version = String(result.version || sha(result.content || ''));
      db.prepare('INSERT INTO tasks (id,jira_key,title,owner_id,created_at,updated_at,project_id,parent_id,task_type,assignee_id,jira_verified,external_ref) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)').run(id, result.key, result.title, user.id, now, now, project.id, linkedParent?.id || null, 'TASK', assignee, JSON.stringify(jiraExternal(row, result, version)));
      bumpParentContexts(db, [linkedParent?.id]); audit(user.id, 'JIRA_IMPORT', id, project.id); task = getTask(id, user);
    });
    // Delivery chain: link a Jira work item declared by the dev task (交付物 / 相关开发事项) as its child.
    let linkedToParent = false;
    if (body.parentTaskId !== undefined) {
      transaction(() => {
        validate();
        const parentTask = getTask(textField(body.parentTaskId, 'parentTaskId', { max: 64 }), user);
        const current = getTask(task.id, user);
        if (parentTask.projectId !== current.projectId) fail(400, 'INVALID_PARENT', '父任务必须属于同一项目');
        if (current.parentId === parentTask.id) return;
        if (current.parentId) fail(409, 'TASK_HAS_PARENT', `${current.jiraKey} 已关联其他父任务`);
        for (let cursor = parentTask; cursor; cursor = cursor.parentId ? getTask(cursor.parentId, user) : null) if (cursor.id === current.id) fail(409, 'TASK_TREE_INVALID', '不能把上级任务关联为子任务');
        assertWritable(parentTask, user); assertWritable(current, user);
        db.prepare('UPDATE tasks SET parent_id=?,version=version+1,updated_at=? WHERE id=?').run(parentTask.id, new Date().toISOString(), current.id);
        bumpParentContexts(db, [parentTask.id]); audit(user.id, 'TASK_LINK_PARENT', current.id, current.projectId);
        linkedToParent = true; task = getTask(current.id, user);
      });
    }
    return { task, existing, imported: !existing, linkedToParent, project: currentProject(), externalUrl: result.externalUrl };
  }
  async function syncMyJiraTasks({ body, user, reauthorize }) {
    const allowed = ['projectId', 'accountId', 'excludeRefactor'];
    if (Object.keys(body).some(name => !allowed.includes(name))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
    if (body.excludeRefactor !== undefined && typeof body.excludeRefactor !== 'boolean') fail(400, 'INVALID_INPUT', 'excludeRefactor必须为布尔值');
    const excludeRefactor = body.excludeRefactor !== false;
    let targetProjects;
    if (body.projectId !== undefined) {
      const pid = textField(body.projectId, 'projectId', { max: 64 }); projectRole(user, pid);
      const selectedProject = visibleProjects(user).find(item => item.id === pid);
      if (!selectedProject?.jira) fail(409, 'JIRA_PROJECT_NOT_BOUND', '请先选择已绑定的Jira项目');
      targetProjects = [selectedProject];
    } else {
      targetProjects = visibleProjects(user).filter(item => !!item.jira);
      if (!targetProjects.length) fail(409, 'JIRA_PROJECT_NOT_BOUND', '尚无已绑定的Jira项目');
    }
    const groups = new Map();
    for (const project of targetProjects) {
      let row; let binding;
      try {
        row = selectedRow(user, project.id, 'jira', body.accountId);
        binding = projectBinding(row);
      } catch (error) {
        if (body.projectId !== undefined) throw error;
        continue;
      }
      if (!binding || row.auth_mode === 'NONE') {
        if (body.projectId !== undefined) fail(409, 'REMOTE_AUTH_REQUIRED', 'Jira事项同步需要已配置的身份认证');
        continue;
      }
      const groupKey = row.account ? `account:${row.account.id}` : `connector:${row.base_url}#${sha(row.credential || '')}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ project, row, binding });
    }
    if (!groups.size) fail(409, 'REMOTE_AUTH_REQUIRED', '请先配置并选择可用的Jira账号');

    const actorId = user.id;
    const syncKey = `${actorId}:${body.projectId ?? '*'}::${body.accountId ?? ''}::${excludeRefactor ? '1' : '0'}`;
    const existingSync = inFlightSyncMine.get(syncKey);
    if (existingSync) {
      const shared = await existingSync;
      if (reauthorize) {
        const fresh = reauthorize();
        if (fresh.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效');
      }
      return shared;
    }

    const syncPromise = (async () => {
    const matchesJiraIdentity = (assignee, me) => {
      if (!assignee || !me) return false;
      if (me.accountId && assignee.accountId) return String(assignee.accountId) === String(me.accountId);
      if (me.key && assignee.key) return String(assignee.key) === String(me.key);
      if (me.name && assignee.name) return String(assignee.name) === String(me.name);
      const remoteId = assignee.accountId || assignee.key || assignee.name;
      return !!(me.id && remoteId && String(remoteId) === String(me.id));
    };
    const isRefactorIssue = (title, labels) => excludeRefactor && /【重构】|\brefactor\b/i.test(`${title || ''} ${JSON.stringify(labels || [])}`);
    const isJiraDone = (statusCategory, statusName) => statusCategory === 'done' || ['已完成', '已关闭', '已解决', '已取消', '取消', 'Done', 'Closed', 'Resolved'].includes(statusName || '');
    const jiraFields = 'summary,status,description,issuetype,parent,updated,project,priority,components,fixVersions,labels,assignee';

    const importedKeys = []; const updatedKeys = []; const unchangedKeys = []; const removedKeys = []; const unassignedKeys = [];
    let primaryIdentity = null;

    for (const groupEntries of groups.values()) {
      const validateGroup = () => {
        if (reauthorize) user = reauthorize();
        if (user.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效');
        for (const entry of groupEntries) {
          projectRole(user, entry.project.id); current(entry.row);
          validateSelected(user, entry.row, body.accountId);
          const cb = projectBinding(entry.row);
          if (!cb || cb.remote_id !== entry.binding.remote_id || cb.remote_key !== entry.binding.remote_key || cb.source_url !== entry.binding.source_url) fail(409, 'JIRA_PROJECT_CHANGED', 'Jira项目绑定已变化，请重新同步');
        }
        return user;
      };
      validateGroup();
      const sampleRow = groupEntries[0].row;
      let me; const activeItems = []; const liveStaleMap = new Map(); let staleCandidates = [];
      try {
        const meData = (await remote('jira', sampleRow, '/rest/api/2/myself')).data;
        if (!(meData?.accountId || meData?.key || meData?.name) || meData.active === false) fail(502, 'REMOTE_IDENTITY_INVALID', 'Jira未返回有效登录身份');
        me = { id: String(meData.accountId || meData.key || meData.name), accountId: meData.accountId || '', key: meData.key || '', name: meData.name || '', displayName: meData.displayName || meData.name || '' };
        if (!primaryIdentity) primaryIdentity = { id: me.id, name: me.name, displayName: me.displayName };

        const remoteProjectIds = groupEntries.map(entry => positive(entry.binding.remote_id, 'Jira项目ID'));
        const jql = `project in (${remoteProjectIds.join(',')}) AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
        const searchData = (await remote('jira', sampleRow, `/rest/api/2/search?${new URLSearchParams({ jql, maxResults: '100', fields: jiraFields })}`)).data;
        if (!Array.isArray(searchData?.issues)) fail(502, 'REMOTE_RESOURCE_INVALID', 'Jira未返回事项列表');

        const entryByRemoteId = new Map(groupEntries.map(entry => [entry.binding.remote_id, entry]));
        for (const rawIssue of searchData.issues) {
          const remotePid = String(rawIssue?.fields?.project?.id || '');
          const entry = entryByRemoteId.get(remotePid);
          if (!entry) continue;
          if (!matchesJiraIdentity(rawIssue.fields?.assignee, me)) continue;
          if (isJiraDone(rawIssue.fields?.status?.statusCategory?.key, rawIssue.fields?.status?.name)) continue;
          if (isRefactorIssue(rawIssue.fields?.summary, rawIssue.fields?.labels)) continue;
          const parsed = issueValue(entry.row, rawIssue);
          activeItems.push({
            entry,
            parsed: { ...parsed, externalId: parsed.id, version: parsed.updatedAt || sha(JSON.stringify(parsed)) },
            statusCategory: rawIssue.fields?.status?.statusCategory?.key || '',
          });
        }

        const activeKeySet = new Set(activeItems.map(item => item.parsed.key));
        const syncedProjectIds = groupEntries.map(entry => entry.project.id);
        const pph = syncedProjectIds.map(() => '?').join(',');
        staleCandidates = db.prepare(`SELECT * FROM tasks WHERE project_id IN (${pph}) AND assignee_id=? AND status<>'DONE' AND external_ref IS NOT NULL`).all(...syncedProjectIds, user.id)
          .map(taskRow)
          .filter(t => sameSource(t.externalRef, sampleRow) && !activeKeySet.has(t.jiraKey));

        if (staleCandidates.length) {
          const recordLiveIssue = rawIssue => {
            if (typeof rawIssue?.key !== 'string') return;
            const remotePid = String(rawIssue?.fields?.project?.id || '');
            const entry = entryByRemoteId.get(remotePid);
            const parsed = entry ? (() => { try { const v = issueValue(entry.row, rawIssue); return { ...v, externalId: v.id, version: v.updatedAt || sha(JSON.stringify(v)) }; } catch { return null; } })() : null;
            liveStaleMap.set(rawIssue.key, {
              rawAssignee: rawIssue.fields?.assignee || null,
              statusCategory: rawIssue.fields?.status?.statusCategory?.key || '',
              statusName: rawIssue.fields?.status?.name || '',
              summary: rawIssue.fields?.summary || '',
              labels: rawIssue.fields?.labels || [],
              entry,
              parsed,
            });
          };
          try {
            const staleJql = `key in (${staleCandidates.map(c => JSON.stringify(c.jiraKey)).join(',')})`;
            const staleRes = (await remote('jira', sampleRow, `/rest/api/2/search?${new URLSearchParams({ jql: staleJql, maxResults: '100', fields: jiraFields })}`)).data;
            for (const rawIssue of staleRes?.issues || []) recordLiveIssue(rawIssue);
          } catch {
            for (const cand of staleCandidates) {
              try {
                const single = (await remote('jira', sampleRow, `/rest/api/2/issue/${encodeURIComponent(cand.jiraKey)}?fields=${jiraFields}`)).data;
                recordLiveIssue(single);
              } catch { /* deleted or invisible in Jira -> stays absent in liveStaleMap */ }
            }
          }
        }
      } finally {
        validateGroup();
      }

      transaction(() => {
        validateGroup();
        const orderedActive = [...activeItems].sort((a, b) => {
          const aSub = a.parsed.parentKey ? 1 : 0;
          const bSub = b.parsed.parentKey ? 1 : 0;
          if (aSub !== bSub) return aSub - bSub;
          return (Date.parse(a.parsed.updatedAt) || 0) - (Date.parse(b.parsed.updatedAt) || 0);
        });

        for (const item of orderedActive) {
          const { entry, parsed, statusCategory } = item;
          if (!parsed.title.trim() || parsed.title.length > 200 || String(parsed.description ?? '').length > 65_536) continue;
          const existing = intakeExisting(entry.row, parsed.key);
          const isMember = !!db.prepare('SELECT user_id FROM project_members WHERE project_id=? AND user_id=?').get(entry.project.id, user.id);
          const external = jiraExternal(entry.row, parsed, parsed.version);
          const externalJson = JSON.stringify(external);
          const remoteUpdatedIso = parsed.updatedAt && !Number.isNaN(Date.parse(parsed.updatedAt)) ? new Date(parsed.updatedAt).toISOString() : new Date().toISOString();
          const inProgressInJira = statusCategory === 'indeterminate' || parsed.status === '开发中';

          if (!existing) {
            const id = randomUUID(); const now = new Date().toISOString();
            const initStatus = inProgressInJira ? 'IN_PROGRESS' : 'OPEN';
            const parent = parsed.parentKey ? taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=? AND project_id=?').get(parsed.parentKey, entry.project.id)) : null;
            const linkedParent = parent && sameSource(parent.externalRef, entry.row) && parent.status !== 'DONE' ? parent : null;
            db.prepare('INSERT INTO tasks (id,jira_key,title,owner_id,created_at,updated_at,project_id,parent_id,task_type,assignee_id,status,jira_verified,external_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)')
              .run(id, parsed.key, parsed.title, user.id, now, remoteUpdatedIso, entry.project.id, linkedParent?.id || null, 'TASK', isMember ? user.id : null, initStatus, externalJson);
            if (linkedParent) bumpParentContexts(db, [linkedParent.id]);
            audit(user.id, 'JIRA_IMPORT', id, entry.project.id);
            importedKeys.push(parsed.key);
          } else if (existing.status !== 'DONE') {
            const nextAssignee = isMember ? user.id : existing.assigneeId;
            const nextStatus = existing.status === 'OPEN' && inProgressInJira ? 'IN_PROGRESS' : existing.status;
            const changed = existing.title !== parsed.title || existing.assigneeId !== nextAssignee || existing.status !== nextStatus || JSON.stringify(existing.externalRef) !== externalJson;
            if (changed) {
              const affectsInputs = existing.title !== parsed.title || existing.assigneeId !== nextAssignee || existing.externalRef?.requirementsHash !== external.requirementsHash;
              db.prepare('UPDATE tasks SET title=?,assignee_id=?,status=?,jira_verified=1,external_ref=?,version=version+1,context_version=context_version+?,updated_at=? WHERE id=?')
                .run(parsed.title, nextAssignee, nextStatus, externalJson, affectsInputs ? 1 : 0, remoteUpdatedIso, existing.id);
              audit(user.id, 'JIRA_SYNC_UPDATE', existing.id, entry.project.id);
              updatedKeys.push(parsed.key);
            } else {
              unchangedKeys.push(parsed.key);
            }
          } else {
            unchangedKeys.push(parsed.key);
          }
        }

        for (const item of orderedActive) {
          const { entry, parsed } = item;
          const currentTask = taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=? AND project_id=?').get(parsed.key, entry.project.id));
          if (!currentTask || currentTask.status === 'DONE') continue;
          const parent = parsed.parentKey ? taskRow(db.prepare('SELECT * FROM tasks WHERE jira_key=? AND project_id=?').get(parsed.parentKey, entry.project.id)) : null;
          const linkedParent = parent && sameSource(parent.externalRef, entry.row) && parent.status !== 'DONE' ? parent : null;
          if (currentTask.parentId !== (linkedParent?.id || null)) {
            try { linkParent(currentTask, linkedParent, user); } catch { /* skip if ancestor frozen */ }
          }
        }

        const hasLocalWork = id => !!(
          db.prepare('SELECT 1 FROM assets WHERE task_id=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM jobs WHERE task_id=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM progress_events WHERE task_id=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM local_ai_runs WHERE task_id=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM tasks WHERE parent_id=? LIMIT 1').get(id)
        );
        const orderedStale = [...staleCandidates].sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0));
        for (const cand of orderedStale) {
          const fresh = taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(cand.id));
          if (!fresh || fresh.status === 'DONE' || fresh.assigneeId !== user.id) continue;
          const live = liveStaleMap.get(fresh.jiraKey) || null;
          const assignedToMe = live ? matchesJiraIdentity(live.rawAssignee, me) : false;
          const doneInJira = live ? isJiraDone(live.statusCategory, live.statusName) : false;
          const refactorTask = isRefactorIssue(live?.summary || fresh.title, live?.labels || fresh.externalRef?.labels);
          if (!assignedToMe || doneInJira || refactorTask) {
            if (!hasLocalWork(fresh.id)) {
              db.prepare('DELETE FROM devices WHERE task_id=?').run(fresh.id);
              db.prepare('DELETE FROM tasks WHERE id=?').run(fresh.id);
              if (fresh.parentId) bumpParentContexts(db, [fresh.parentId]);
              audit(user.id, 'JIRA_SYNC_PRUNE', fresh.jiraKey, fresh.projectId);
              removedKeys.push(fresh.jiraKey);
            } else {
              const extJson = live?.entry && live?.parsed && live.entry.project.id === fresh.projectId
                ? JSON.stringify(jiraExternal(live.entry.row, live.parsed, live.parsed.version))
                : JSON.stringify(fresh.externalRef);
              const nextAssignee = assignedToMe ? fresh.assigneeId : null;
              db.prepare('UPDATE tasks SET assignee_id=?,external_ref=?,version=version+1,context_version=context_version+?,updated_at=? WHERE id=?')
                .run(nextAssignee, extJson, nextAssignee !== fresh.assigneeId ? 1 : 0, new Date().toISOString(), fresh.id);
              if (!assignedToMe) unassignedKeys.push(fresh.jiraKey);
            }
          }
        }
      });
    }

    return {
      identity: primaryIdentity,
      importedCount: importedKeys.length,
      updatedCount: updatedKeys.length,
      unchangedCount: unchangedKeys.length,
      removedCount: removedKeys.length,
      unassignedCount: unassignedKeys.length,
      importedKeys,
      updatedKeys,
      removedKeys,
      unassignedKeys,
    };
    })();
    inFlightSyncMine.set(syncKey, syncPromise);
    try { return await syncPromise; }
    finally { if (inFlightSyncMine.get(syncKey) === syncPromise) inFlightSyncMine.delete(syncKey); }
  }
  return async function handle({ method, path, url, user, body, send, reauthorize }) {
    if (await mergeRequests.routes({ method, path, user, body, send, reauthorize })) return true;
    const accountTest = path.match(/^\/api\/accounts\/([A-Za-z0-9_-]{1,64})\/test$/);
    if (accountTest && accounts) {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      if (Object.keys(body).some(key => !['expectedVersion', 'projectId'].includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
      const info = accounts.listAccounts(user).accounts.find(account => account.id === accountTest[1]);
      if (!info) fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在或无权访问');
      if (!Object.hasOwn(PROVIDERS, info.provider)) fail(409, 'ACCOUNT_TEST_UNSUPPORTED', '该AI账号仅支持保存，执行器尚未接入，不能判定认证或执行成功');
      const projectId = body.projectId || info.projectId || visibleProjects(user)[0]?.id;
      if (!projectId) fail(400, 'PROJECT_REQUIRED', '请先选择可访问项目后验证账号');
      const account = accounts.resolveAccount(user, info.id, projectId, info.provider);
      if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) fail(400, 'EXPECTED_VERSION_REQUIRED', '请提供有效的expectedVersion');
      if (account.version !== body.expectedVersion) fail(409, 'ACCOUNT_CHANGED', '账号配置已变化，请重新读取');
      const actorId = user.id; const row = accountRow(account, user, projectId);
      const validate = () => {
        if (reauthorize) user = reauthorize();
        if (user.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效');
        accounts.revalidateSelection(user, account, projectId, info.provider); return user;
      };
      const verified = await checked(info.provider, row, validate); validate();
      send(200, { account: accounts.listAccounts(user).accounts.find(item => item.id === account.id), ...verified }); return true;
    }
    const intake = path.match(/^\/api\/jira\/tasks\/(lookup|search|import|sync-mine)$/);
    if (intake) {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备仅可访问已授权的任务接口');
      if (intake[1] === 'sync-mine') { send(200, await syncMyJiraTasks({ body, user, reauthorize })); return true; }
      send(200, await jiraIntake({ action: intake[1], body, user, reauthorize })); return true;
    }
    if (method === 'GET' && path === '/api/connectors') {
      const projectId = url.searchParams.get('projectId') || visibleProjects(user)[0]?.id || 'default'; role(user, projectId);
      send(200, { connectors: Object.keys(PROVIDERS).map(provider => {
        const legacy = db.prepare('SELECT * FROM connector_configs WHERE project_id=? AND provider=?').get(projectId, provider);
        if (url.searchParams.get('defaults') === '1') return metadata(provider, legacy);
        try {
          const selected = accounts?.resolveSelection(user, { projectId, provider });
          const row = selected ? accountRow(selected, user, projectId) : legacy;
          if (provider === 'jira' && row) projectBinding(row);
          return metadata(provider, row);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return { ...metadata(provider), status: 'ACCOUNT_UNAVAILABLE', lastError: error.message, selectionUnavailable: true };
        }
      }) }); return true;
    }
    const match = path.match(/^\/api\/connectors\/([^/]+)\/(config|reuse-local|test|read|import|sync-projects)$/); if (!match) return false;
    if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持POST');
    const provider = cleanProvider(match[1]); const projectId = textField(body.projectId || 'default', 'projectId', { max: 64 }); role(user, projectId); const action = match[2];
    const managementAction = ['config', 'reuse-local', 'sync-projects'].includes(action);
    if (managementAction) role(user, projectId, true);
    const actorId = user.id;
    const revalidate = row => {
      if (reauthorize) user = reauthorize();
      if (user.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效');
      role(user, projectId, managementAction || !row?.account);
      if (action === 'reuse-local' && user.role !== 'ADMIN') fail(403, 'LOCAL_PROFILE_ADMIN_ONLY', '复用本机凭据仅限平台管理员');
      if (action === 'sync-projects' && user.role !== 'ADMIN') fail(403, 'PROJECT_SYNC_ADMIN_ONLY', '同步Jira项目目录仅限平台管理员');
      if (row) { current(row); if (!['config', 'reuse-local'].includes(action)) validateSelected(user, row, body.accountId); }
      return user;
    };
    if (action === 'config') { send(200, { connector: saveConfig(provider, user, projectId, body) }); return true; }
    if (action === 'reuse-local') {
      revalidate();
      const previous = db.prepare('SELECT * FROM connector_configs WHERE project_id=? AND provider=?').get(projectId, provider);
      const unchanged = () => { revalidate(previous); if (!previous && db.prepare('SELECT id FROM connector_configs WHERE project_id=? AND provider=?').get(projectId, provider)) fail(409, 'CONNECTOR_CHANGED', '连接配置已变化，请重新执行操作'); };
      let config;
      try { config = await localConfig(provider); } finally { unchanged(); }
      const connector = saveConfig(provider, user, projectId, config, unchanged);
      audit(user.id, 'CONNECTOR_REUSE_LOCAL', configured(projectId, provider).id, projectId); send(200, { connector }); return true;
    }
    if (action === 'sync-projects' && (provider !== 'jira' || user.role !== 'ADMIN')) fail(403, 'PROJECT_SYNC_ADMIN_ONLY', '同步Jira项目目录仅限平台管理员');
    const row = selectedRow(user, projectId, provider, body.accountId);
    role(user, projectId, managementAction || !row.account);
    const validate = () => revalidate(row); const verified = await checked(provider, row, validate);
    validate();
    if (action === 'test') { send(200, { connector: metadata(provider, current(row)), ...verified }); return true; }
    if (action === 'sync-projects') { const result = await syncProjects(row, user, body, validate); validate(); send(200, result); return true; }
    let result;
    try { result = await readResource(provider, row, body, user, validate); } finally { validate(); }
    if (action === 'read') send(200, result);
    else send(200, importResource(provider, row, user, body, result));
    return true;
  };
}

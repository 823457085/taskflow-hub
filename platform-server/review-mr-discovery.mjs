import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, fail, fullGitSha, publicGitRemote } from './common.mjs';
import { declaredRepository, requirementKeys } from './delivery-chain.mjs';

const git = promisify(execFile);
const jiraKey = /^(?:[A-Z][A-Z0-9]*-[1-9][0-9]*)$/;
const jiraRefs = /(?<![A-Z0-9])[A-Z][A-Z0-9]*-[1-9][0-9]*(?![A-Z0-9])/gi;
const validId = /^[1-9][0-9]{0,15}$/;
const pageSize = 50;
const pageLimit = 4;
const providerNames = { yunxiao: '云效 Codeup', gitlab: 'GitLab', github: 'GitHub' };

function matchKeys(keys, ...fields) {
  const found = new Set(fields.flatMap(field => typeof field === 'string' ? (field.match(jiraRefs) || []).map(key => key.toUpperCase()) : []));
  return keys.filter(key => found.has(key));
}

function repository(value) {
  const safe = publicGitRemote(value?.trim());
  if (!safe) return null;
  const url = new URL(safe);
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!path || path.length > 400 || path.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null;
  return { url, path, name: path.split('/').at(-1) };
}

function explicitRepository(task) {
  return typeof task.externalRef?.description === 'string'
    ? task.externalRef.description.match(/^\s*(?:代码仓库|仓库|Repository|Repo)\s*[：:]\s*((?:https?:\/\/|ssh:\/\/|git@)[^\s<>"\]})]+)/im)?.[1]
    : null;
}

async function localGitEvidence(repoPath, keys) {
  if (!repoPath) return { repo: null, branches: [], read: false };
  const run = args => git('git', ['-C', repoPath, ...args], { timeout: 5000, maxBuffer: 524_288, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then(result => result.stdout.trim());
  const [remote, refs] = await Promise.allSettled([
    run(['remote', 'get-url', 'origin']),
    run(['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes/origin']),
  ]);
  const repo = remote.status === 'fulfilled' ? repository(remote.value) : null;
  const branches = new Map();
  if (refs.status === 'fulfilled') {
    for (const line of refs.value.split('\n')) {
      const [ref, commit] = line.split('\t');
      const name = ref.replace(/^refs\/(?:heads|remotes)\//, '');
      const taskKeys = matchKeys(keys, name);
      if (!taskKeys.length || !fullGitSha(commit) || branches.has(commit)) continue;
      branches.set(commit, { name, commit, taskKeys });
    }
  }
  return { repo, branches: [...branches.values()].slice(0, 20), read: refs.status === 'fulfilled' };
}

function apiRepoPath(provider, repo, row) {
  if (provider === 'github') return repo.path.split('/').length === 2 ? repo.path : null;
  if (provider === 'yunxiao') return row.organization_id && repo.path.startsWith(row.organization_id + '/') ? repo.path : null;
  const basePath = new URL(row.base_url).pathname.replace(/^\/+|\/+$/g, '');
  if (basePath && !repo.path.startsWith(basePath + '/')) return null;
  const path = basePath ? repo.path.slice(basePath.length + 1) : repo.path;
  return path.includes('/') ? path : null;
}

function candidateFrom(provider, row, apiPath, repo, codeupRepoId, item, keys) {
  if (!item || typeof item.title !== 'string') return null;
  const id = String(provider === 'yunxiao' ? item.localId : provider === 'gitlab' ? item.iid : item.number);
  if (!validId.test(id)) return null;
  if (provider === 'yunxiao' && String(item.projectId) !== codeupRepoId) return null;
  if (provider === 'github' && typeof item.base?.repo?.full_name === 'string' && item.base.repo.full_name.toLowerCase() !== apiPath.toLowerCase()) return null;
  const taskKeys = matchKeys(keys, item.title, item.description, item.body, item.source_branch, item.sourceBranch, item.head?.ref);
  if (!taskKeys.length) return null;
  const state = String(item.state || item.status || '');
  // Closed requests without a merge do not represent code delivered for review.
  if (state.toLowerCase() === 'closed' && !item.merged_at && !item.mergedRevision) return null;
  const url = provider === 'yunxiao' ? `https://codeup.aliyun.com/${repo.path}/change/${id}`
    : provider === 'github' ? `https://github.com/${apiPath}/pull/${id}`
      : `${row.base_url}/${apiPath}/-/merge_requests/${id}`;
  return { url, title: item.title.trim().slice(0, 240), provider, taskKeys, ...(state ? { state: item.merged_at ? 'merged' : state.slice(0, 32) } : {}) };
}

export async function discoverReviewMrs({ db, task, user, repoPath, connectorsInternal, projectRole, reauthorize }) {
  const authorize = () => {
    const current = reauthorize();
    if (current.id !== user.id) fail(401, 'UNAUTHENTICATED', '登录已失效');
    return { current, role: projectRole(current, task.projectId) };
  };
  authorize();
  const children = db.prepare(`WITH RECURSIVE related(id) AS (
    SELECT id FROM tasks WHERE id=?
    UNION SELECT t.id FROM tasks t JOIN related r ON t.parent_id=r.id WHERE t.project_id=?
  ) SELECT t.jira_key AS key FROM related r JOIN tasks t ON t.id=r.id LIMIT 101`).all(task.id, task.projectId);
  const keys = [...new Set([task.jiraKey, ...requirementKeys(task), ...children.slice(0, 100).map(child => child.key)])]
    .map(key => String(key).toUpperCase()).filter(key => jiraKey.test(key));
  if (!keys.length) return { candidates: [], branches: [], sources: [], incomplete: true, reason: '当前任务没有可用于扫描的 Jira 编号' };
  const local = await localGitEvidence(repoPath, keys);
  authorize();
  const sources = local.read ? ['local'] : [];
  const taskRepo = repository(explicitRepository(task));
  const declared = declaredRepository(task.externalRef?.description);
  const matchesBinding = !declared || local.repo?.name.toLowerCase() === declared.split('/').at(-1)?.replace(/\.git$/i, '').toLowerCase();
  const bound = matchesBinding ? local.repo : null;
  const repo = taskRepo || bound;
  const branches = repo && local.repo?.url.href === repo.url.href ? local.branches : [];
  if (!repo) return { candidates: [], branches, sources, incomplete: true, reason: '当前需求没有可扫描的已绑定仓库' };
  const providers = repo.url.hostname === 'codeup.aliyun.com' ? ['yunxiao'] : repo.url.hostname === 'github.com' ? ['github'] : ['gitlab'];
  const candidates = new Map();
  let incomplete = children.length > 100;
  let reason;
  for (const provider of providers) {
    const { current, role } = authorize();
    const label = providerNames[provider];
    try {
      const row = connectorsInternal.selectedRow(current, task.projectId, provider);
      if (!row.account && !['ADMIN', 'LEAD'].includes(role)) {
        incomplete = true;
        reason = `当前账号无权读取项目共享的${label}合并请求列表`;
        continue;
      }
      if (row.auth_mode === 'NONE') {
        incomplete = true;
        reason = `当前项目尚未启用${label}账号连接`;
        continue;
      }
      const base = new URL(row.base_url);
      const networkHost = ['http:', 'https:'].includes(repo.url.protocol) ? repo.url.host === base.host : repo.url.hostname === base.hostname;
      const apiPath = apiRepoPath(provider, repo, row);
      if (!apiPath || provider === 'gitlab' && !networkHost) {
        incomplete = true;
        reason = `已绑定仓库与${label}连接的组织或服务地址不匹配`;
        continue;
      }
      const read = async path => {
        const check = () => {
          const live = authorize();
          if (!row.account && !['ADMIN', 'LEAD'].includes(live.role)) fail(403, 'CONNECTOR_FORBIDDEN', '当前账号的共享连接权限已变化');
          connectorsInternal.validateSelected(live.current, row);
        };
        check();
        try { return await connectorsInternal.remote(provider, row, path); }
        finally { check(); }
      };
      let repoId = null;
      if (provider === 'yunxiao') {
        const repoResult = await read(`/oapi/v1/codeup/organizations/${encodeURIComponent(row.organization_id)}/repositories/${encodeURIComponent(apiPath)}`);
        repoId = String(repoResult.data?.id ?? '');
        if (!validId.test(repoId)) throw new ApiError(502, 'REMOTE_RESOURCE_INVALID', '云效未返回目标仓库');
      }
      const endpoint = provider === 'yunxiao' ? `/oapi/v1/codeup/organizations/${encodeURIComponent(row.organization_id)}/changeRequests`
        : provider === 'github' ? `/repos/${apiPath.split('/').map(encodeURIComponent).join('/')}/pulls`
          : `/api/v4/projects/${encodeURIComponent(apiPath)}/merge_requests`;
      sources.push(provider);
      for (let page = 1; page <= pageLimit; page += 1) {
        const params = new URLSearchParams(provider === 'yunxiao'
          ? { page: String(page), perPage: String(pageSize), projectIds: repoId, orderBy: 'updated_at', sort: 'desc' }
          : { page: String(page), per_page: String(pageSize), state: 'all', ...(provider === 'gitlab' ? { scope: 'all', order_by: 'updated_at', sort: 'desc' } : { sort: 'updated', direction: 'desc' }) });
        const result = await read(endpoint + '?' + params);
        if (!Array.isArray(result.data)) throw new ApiError(502, 'REMOTE_RESOURCE_INVALID', '平台未返回合并请求列表');
        for (const item of result.data) {
          const candidate = candidateFrom(provider, row, apiPath, repo, repoId, item, keys);
          if (candidate && candidate.title) candidates.set(candidate.url, candidate);
        }
        if (!result.nextPage && result.data.length < pageSize) break;
        if (page === pageLimit) {
          incomplete = true;
          reason = `已扫描${label}最近 ${pageLimit * pageSize} 条合并请求，列表还有更早的记录`;
        }
      }
    } catch (error) {
      authorize();
      if (!(error instanceof ApiError)) throw error;
      incomplete = true;
      reason = error.code === 'CONNECTOR_UNCONFIGURED'
        ? `当前项目未配置可用的${label}连接`
        : `当前账号未能读取${label}的合并请求列表`;
    }
  }
  authorize();
  return { candidates: [...candidates.values()].slice(0, 30), branches, sources, incomplete: incomplete || candidates.size > 30, ...(reason ? { reason } : {}) };
}

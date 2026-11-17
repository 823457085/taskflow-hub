import { ApiError, APPROVAL_ROLES, fail, fullGitSha, textField } from './common.mjs';

const numericId = /^[1-9]\d{0,15}$/;
const refName = value => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..';
const gitSha = value => fullGitSha(value) ? value.toLowerCase() : null;

export function mergeRequestPath(provider, { organizationId, repositoryId, number }) {
  if (provider === 'gitlab') return `/api/v4/projects/${encodeURIComponent(repositoryId)}/merge_requests/${number}`;
  return `${codeupRepoPath(organizationId, repositoryId)}/changeRequests/${number}`;
}

function codeupRepoPath(organizationId, repositoryId) {
  return `/oapi/v1/codeup/organizations/${encodeURIComponent(organizationId)}/repositories/${repositoryId}`;
}

export function mergeSnapshot(mr, headSha) {
  const { sourceBranch, targetBranch, sourceRepository, targetRepository } = mr;
  if (!gitSha(headSha) || !refName(sourceBranch) || !refName(targetBranch) || !numericId.test(sourceRepository) || !numericId.test(targetRepository)) return null;
  return { headSha: gitSha(headSha), sourceBranch, targetBranch, sourceRepository, targetRepository };
}

export function sameMergeSnapshot(left, right) {
  return !!left && !!right && Object.keys(left).every(key => left[key] === right[key]);
}

function externalLink(raw, base) {
  try {
    const url = new URL(raw);
    if (url.origin === base && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch { /* Missing or invalid provider link. */ }
  return null;
}

export function createMergeRequests({ db, workflow, remote, selectedRow, validateSelected, getTask, projectRole, assertWritable, audit }) {
  const inFlight = new Set();
  async function read(row, ref) {
    const provider = row.provider;
    const data = (await remote(provider, row, mergeRequestPath(provider, ref))).data;
    if (provider === 'gitlab') {
      if (String(data?.iid) !== ref.number || typeof data.title !== 'string' || typeof data.state !== 'string' ||
          numericId.test(ref.repositoryId) && data.project_id != null && String(data.project_id) !== ref.repositoryId) {
        fail(502, 'REMOTE_RESOURCE_INVALID', 'GitLab 未返回指定合并请求');
      }
      const headSha = gitSha(data.sha || data.diff_refs?.head_sha);
      const mergeStatus = data.detailed_merge_status || data.merge_status;
      return { data, mr: {
        title: data.title, state: data.state, sourceBranch: data.source_branch, targetBranch: data.target_branch,
        sourceRepository: String(data.source_project_id ?? ''), targetRepository: String(data.target_project_id ?? data.project_id ?? ''),
        headSha, mergeCommit: gitSha(data.merge_commit_sha) || gitSha(data.squash_commit_sha), mergedAt: data.merged_at,
        merged: data.state === 'merged', ready: data.state === 'opened' && !data.draft && !data.work_in_progress && !data.has_conflicts &&
          ['mergeable', 'can_be_merged'].includes(mergeStatus),
        url: externalLink(data.web_url, new URL(row.base_url).origin),
      } };
    }
    const state = data?.status || data?.state;
    if (String(data?.localId) !== ref.number || typeof data.title !== 'string' || typeof state !== 'string' ||
        data.projectId != null && String(data.projectId) !== ref.repositoryId) {
      fail(502, 'REMOTE_RESOURCE_INVALID', '云效 Codeup 未返回指定合并请求');
    }
    return { data, mr: {
      title: data.title, state, sourceBranch: data.sourceBranch, targetBranch: data.targetBranch,
      sourceRepository: String(data.sourceProjectId ?? ''), targetRepository: String(data.targetProjectId ?? data.projectId ?? ''),
      mergeCommit: gitSha(data.mergedRevision), mergedAt: data.mergedAt,
      merged: state === 'MERGED',
      ready: state === 'TO_BE_MERGED' && data.allRequirementsPass === true && data.conflictCheckStatus === 'NO_CONFLICT',
      url: externalLink(data.detailUrl || data.webUrl, 'https://codeup.aliyun.com'),
    } };
  }

  async function branchHead(row, repository, branch) {
    if (!numericId.test(repository) || !refName(branch)) return null;
    const path = `${codeupRepoPath(row.organization_id, repository)}/branches/${encodeURIComponent(branch)}`;
    return gitSha((await remote('yunxiao', row, path)).data?.commit?.id);
  }

  const importedRequests = taskId => {
    const rows = db.prepare(`
      SELECT a.id, a.title, a.source_url, i.resource, i.external_id, i.remote_version
      FROM assets a JOIN (
        SELECT local_id, resource, external_id, remote_version FROM external_imports
          WHERE task_id=? AND resource IN ('gitlab_mr', 'yunxiao_mr')
        UNION ALL
        SELECT local_id, resource, external_id, remote_version FROM account_external_imports
          WHERE task_id=? AND resource IN ('gitlab_mr', 'yunxiao_mr')
      ) i ON i.local_id=a.id WHERE a.task_id=? AND a.kind='CODE' ORDER BY a.rowid DESC
    `).all(taskId, taskId, taskId);
    const latest = new Map();
    for (const row of rows) {
      const provider = row.resource === 'gitlab_mr' ? 'gitlab' : 'yunxiao';
      const match = provider === 'gitlab' ? /^(.+)!([1-9]\d{0,15})$/.exec(row.external_id) :
        /^([\w-]+):([1-9]\d{0,15})!([1-9]\d{0,15})$/.exec(row.external_id);
      if (!match) continue;
      const { baseUrl, mergeSnapshot: snapshot } = JSON.parse(row.remote_version);
      const [repositoryId, number] = match.slice(-2);
      const key = JSON.stringify([provider, baseUrl, row.external_id]);
      if (!latest.has(key)) latest.set(key, {
        key, provider, baseUrl, repositoryId, number, organizationId: provider === 'yunxiao' ? match[1] : null,
        assetId: row.id, title: row.title, url: row.source_url, snapshot,
      });
    }
    return [...latest.values()];
  };

  const approvedCode = task => {
    const gate = workflow.gates(task).gates.find(item => item.stage === 'CODE_REVIEW');
    if (gate?.status !== 'PASS') return null;
    const row = db.prepare('SELECT snapshot FROM jobs WHERE id=? AND task_id=?').get(gate.jobId, task.id);
    return row ? { id: gate.jobId, assetIds: new Set(JSON.parse(row.snapshot).assets.filter(asset => asset.kind === 'CODE').map(asset => asset.id)) } : null;
  };
  const canUsePersonal = (row, actor) => row.account?.scope === 'PERSONAL' && row.account.owner_id === actor.id;
  const sameSource = (row, ref) => row.base_url === ref.baseUrl && (ref.provider === 'gitlab' || row.organization_id === ref.organizationId);

  async function routes({ method, path, user, body, reauthorize, send }) {
    const match = /^\/api\/tasks\/([^/]+)\/merge-requests(?:\/([^/]+)\/merge)?$/.exec(path);
    if (!match) return false;
    const [, taskId, assetId] = match;
    if (method !== (assetId ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式');
    const actorId = user.id;
    function checkAccess() {
      const actor = reauthorize();
      if (actor.id !== actorId) fail(401, 'UNAUTHENTICATED', '登录已失效');
      if (actor.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '请使用网页登录后操作合并请求');
      const task = getTask(taskId, actor);
      return { task, actor, role: projectRole(actor, task.projectId) };
    }
    const context = checkAccess();
    const refs = importedRequests(taskId);
    function connector(ref, ctx, write = false) {
      const row = selectedRow(ctx.actor, ctx.task.projectId, ref.provider);
      if (!row.account && !APPROVAL_ROLES.CODE_REVIEW.includes(ctx.role)) fail(403, 'CONNECTOR_FORBIDDEN', '请选择可用的平台账号');
      if (!sameSource(row, ref)) fail(409, 'MR_SOURCE_CHANGED', '当前账号与已关联的合并请求来源不一致');
      if (write && !canUsePersonal(row, ctx.actor)) fail(403, 'MR_PERSONAL_ACCOUNT_REQUIRED', '请选择具有远端合并权限的个人账号');
      return row;
    }
    if (!assetId) {
      const approval = APPROVAL_ROLES.CODE_REVIEW.includes(context.role) ? approvedCode(context.task) : null;
      const items = await Promise.all(refs.map(async ref => {
        const item = { assetId: ref.assetId, provider: ref.provider, repositoryId: ref.repositoryId, number: ref.number,
          title: ref.title, url: ref.url, reviewed: ref.snapshot || null };
        try {
          const row = connector(ref, context);
          const { mr } = await read(row, ref);
          const headSha = ref.provider === 'yunxiao' && ref.snapshot && !mr.merged && mr.ready
            ? await branchHead(row, mr.sourceRepository, mr.sourceBranch) : mr.headSha;
          const latest = checkAccess();
          validateSelected(latest.actor, row);
          const mergeRole = APPROVAL_ROLES.CODE_REVIEW.includes(latest.role);
          let reason = null;
          if (!mr.merged) {
            if (!ref.snapshot) reason = '请重新从平台导入完整代码差异并审核';
            else if (!approval?.assetIds.has(ref.assetId)) reason = '等待当前代码版本通过审核';
            else if (!canUsePersonal(row, latest.actor)) reason = '请选择具有远端合并权限的个人账号';
            else if (!mr.ready) reason = '等待代码平台允许合并';
            else if (!sameMergeSnapshot(ref.snapshot, mergeSnapshot(mr, headSha))) reason = '合并请求已变化，请重新导入并审核';
          }
          return { ...item, ...mr, headSha, url: mr.url || item.url, reason,
            reviewId: !mr.merged && !reason && mergeRole && latest.task.status !== 'DONE' ? approval?.id : null };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return { ...item, error: error.message };
        }
      }));
      checkAccess();
      send(200, { items }); return true;
    }

    const ref = refs.find(item => item.assetId === assetId);
    if (!ref) fail(404, 'MR_NOT_LINKED', '任务未关联此合并请求版本，请刷新后重试');
    const expectedReviewId = textField(body.expectedReviewId, 'expectedReviewId', { max: 64 });
    function validateMerge(ctx) {
      if (!APPROVAL_ROLES.CODE_REVIEW.includes(ctx.role)) fail(403, 'MR_MERGE_FORBIDDEN', '当前项目角色无权发起合并');
      assertWritable(ctx.task, ctx.actor);
      const approval = approvedCode(ctx.task);
      if (approval?.id !== expectedReviewId || !approval.assetIds.has(assetId) || !ref.snapshot) {
        fail(409, 'MR_REVIEW_REQUIRED', '请先审核当前合并请求的代码版本');
      }
    }
    validateMerge(context);
    const row = connector(ref, context, true);
    if (inFlight.has(ref.key)) fail(409, 'MR_MERGE_IN_PROGRESS', '此合并请求正在处理，请同步状态');
    inFlight.add(ref.key);
    try {
      const { mr } = await read(row, ref);
      if (mr.merged) {
        validateSelected(checkAccess().actor, row);
        send(200, { state: mr.state, mergeCommit: mr.mergeCommit, alreadyMerged: true });
        return true;
      }
      if (!mr.ready) fail(409, 'MR_NOT_MERGEABLE', '代码平台当前不允许合并，请检查远端审批、流水线与冲突状态');
      const headSha = ref.provider === 'gitlab' ? mr.headSha : await branchHead(row, mr.sourceRepository, mr.sourceBranch);
      if (!sameMergeSnapshot(ref.snapshot, mergeSnapshot(mr, headSha))) fail(409, 'MR_HEAD_CHANGED', '合并请求的提交或分支已变更，请重新导入并审核');
      const latest = checkAccess();
      validateMerge(latest);
      validateSelected(latest.actor, row);

      const mergePath = `${mergeRequestPath(ref.provider, ref)}/merge`;
      const options = ref.provider === 'gitlab'
        ? { method: 'PUT', body: { sha: headSha, should_remove_source_branch: false } }
        : { method: 'POST', body: { mergeType: 'no-fast-forward', removeSourceBranch: false } };
      audit(actorId, 'MR_MERGE_REQUEST', ref.assetId, context.task.projectId);
      let failure;
      try { await remote(ref.provider, row, mergePath, options); }
      catch (error) { failure = error; }
      let result;
      try { result = (await read(row, ref)).mr; }
      catch { /* A write can succeed without a readable response. Check again via the status endpoint. */ }
      validateSelected(checkAccess().actor, row);
      if (!result?.merged || !result.mergeCommit) {
        if (failure && result && !result.merged) throw failure;
        fail(502, 'MR_MERGE_UNCONFIRMED', '合并结果尚未确认，请先同步平台状态');
      }
      // The Codeup merge API has no expected-head argument. Verify the commit actually merged.
      if (ref.provider === 'yunxiao' && result.mergeCommit !== headSha) {
        let commit;
        try {
          const repository = codeupRepoPath(ref.organizationId, ref.repositoryId);
          commit = (await remote(ref.provider, row, `${repository}/commits/${result.mergeCommit}`)).data;
        } catch { /* The merge is visible but the merged source revision could not be verified. */ }
        validateSelected(checkAccess().actor, row);
        if (gitSha(commit?.id) !== result.mergeCommit || gitSha(commit?.parentIds?.[1]) !== headSha) {
          audit(actorId, 'MR_MERGE_SOURCE_UNVERIFIED', ref.assetId, context.task.projectId);
          fail(409, 'MR_MERGED_SOURCE_UNVERIFIED', '平台已合并，但合并提交的源版本未能核对，请查看平台记录');
        }
      }
      audit(actorId, 'MR_MERGE_CONFIRMED', ref.assetId, context.task.projectId);
      send(200, { state: result.state, mergeCommit: result.mergeCommit });
      return true;
    } finally { inFlight.delete(ref.key); }
  }
  return { read, branchHead, routes };
}

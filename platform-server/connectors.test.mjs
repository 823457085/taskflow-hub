import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from './server.mjs';
const password = 'connector-test-local-password';
const secret = 'private-fixture-token';
async function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-connectors-'));
  const state = { anonymous: false, error: false, redirect: false, title: 'L_JIRA_TITLE', description: 'Original Jira requirements', updated: '2026-11-12T00:00:00Z', pageVersion: 1, pageContent: '<p>L_PRD_BODY</p>', truncated: false, requests: [], targetHits: 0, projects: [{ id: '101', key: 'TEST', name: 'L_GROUP-L_PROJECT_NAME', projectTypeKey: 'software', projectCategory: { id: '10', name: 'L_CATEGORY', description: 'L_CATEGORY_DESCRIPTION' } }, { id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT', projectTypeKey: 'business' }], issues: {} };
  const target = http.createServer((_req, res) => { state.targetHits++; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const upstream = http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || req.headers['private-token'] || req.headers['x-yunxiao-token'] });
    if (state.hold?.path === new URL(req.url, 'http://local').pathname) {
      const hold = state.hold; state.hold = null; hold.started.resolve(); await hold.resume.promise;
    }
    if (state.redirect) { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/stolen` }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (state.error) { res.writeHead(403); res.end(JSON.stringify({ message: `L_ACCESS_DENIED ${secret}` })); return; }
    const url = new URL(req.url, 'http://local'); let value;
    const custom = await state.handle?.(req, url);
    if (custom) { res.statusCode = custom.status || 200; res.end(JSON.stringify(custom.value)); return; }
    if (url.pathname === '/rest/api/2/myself') value = { key: 'current-user', name: 'original-account', displayName: state.identity || 'L_IDENTITY', emailAddress: 'excluded@example.invalid', active: true };
    else if (url.pathname === '/rest/api/user/current') value = { type: 'known', userKey: 'confluence-user', username: 'original-account', displayName: 'L_CONFLUENCE_IDENTITY' };
    else if (url.pathname === '/api/v4/user') value = { id: 42, username: 'gitlab-user', name: 'L_GITLAB_IDENTITY', state: 'active' };
    else if (url.pathname === '/whoAmI/api/json') value = { authenticated: !state.anonymous, name: state.anonymous ? 'anonymous' : 'L_JENKINS_USER' };
    else if (url.pathname === '/rest/api/2/project') value = state.projects;
    else if (url.pathname === '/rest/api/2/search') value = { total: 1, issues: state.searchIssues || [issue()] };
    else if (url.pathname.startsWith('/rest/api/2/issue/')) value = state.issues[url.pathname.split('/').at(-1)] || issue();
    else if (url.pathname === '/rest/api/content/123') value = { id: '123', title: 'L_PRD_TITLE', body: { storage: { value: state.pageContent } }, version: { number: state.pageVersion } };
    else if (url.pathname === '/api/v4/projects/42/merge_requests/7') value = { iid: 7, title: 'L_MR_TITLE', description: 'L_MR_BODY', state: 'opened', sha: 'abc123', web_url: `${base}/team/repository/-/merge_requests/7` };
    else if (url.pathname === '/api/v4/projects/42/merge_requests/7/diffs') { if (state.truncated) res.setHeader('X-Next-Page', '2'); value = [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-old\n+new' }]; }
    else if (url.pathname === '/api/json') { assert.equal(url.searchParams.get('tree'), 'jobs[name,fullName,_class]'); value = { jobs: [{ name: 'L_FOLDER_NAME', fullName: 'L_FOLDER_NAME', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }, { name: 'L_JOB_NAME', fullName: 'L_JOB_NAME', _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob' }, { name: 'L_LEGACY_JOB' }] }; }
    else if (/^\/job\/team\/job\/app\/(?:lastSuccessfulBuild|16|17)\/api\/json$/.test(url.pathname)) {
      assert.match(url.searchParams.get('tree'), /lastBuiltRevision\[SHA1\]/);
      value = { number: 17, result: 'SUCCESS', building: false, timestamp: 1, duration: 2, fullDisplayName: 'L_BUILD_TITLE', actions: [
        { _class: 'hudson.plugins.git.util.BuildData', remoteUrls: ['https://fixture-user:fixture-password@git.example/team/app.git?token=fixture-secret'], lastBuiltRevision: { SHA1: 'a'.repeat(40) } },
        { _class: 'hudson.plugins.git.util.BuildData', remoteUrls: ['git@git.example:team/app.git'], lastBuiltRevision: { SHA1: 'abcdef0' } },
      ] };
    }
    else if (url.pathname === '/oapi/v1/flow/organizations/org/pipelines') value = [{ pipelineId: 1, pipelineName: 'L_PIPELINE_TITLE', createAccountId: 'excluded-user', createTime: 1 }];
    else if (url.pathname === '/oapi/v1/flow/organizations/org/pipelines/1/runs/2') value = { pipelineId: 1, pipelineRunId: 2, name: 'L_RUN_TITLE', status: 'SUCCESS', stages: [] };
    else if (url.pathname === '/oapi/v1/codeup/organizations/org/repositories') value = [{ id: 10001, name: 'example-web', pathWithNamespace: 'org/example-team/example-web', webUrl: 'https://codeup.aliyun.com/org/example-team/example-web', updatedAt: '2026-11-14T00:00:00Z' }];
    else if (url.pathname === `/oapi/v1/codeup/organizations/org/repositories/${encodeURIComponent('org/example-team/example-web')}`) value = { id: 10001, name: 'example-web', pathWithNamespace: 'org/example-team/example-web' };
    else if (url.pathname === '/oapi/v1/codeup/organizations/org/changeRequests') value = [{ localId: 42, projectId: 10001, nameWithNamespace: 'org / example-team / example-web', title: 'L_CODEUP_MR', state: 'MERGED', sourceBranch: 'feature/demo', targetBranch: 'master', author: { name: 'L_AUTHOR' }, detailUrl: 'https://codeup.aliyun.com/org/example-team/example-web/change/42' }];
    else if (url.pathname === '/oapi/v1/codeup/organizations/org/repositories/10001/changeRequests/42') value = { localId: 42, projectId: 10001, title: 'L_CODEUP_MR', status: 'MERGED', sourceBranch: 'feature/demo', targetBranch: 'master', mergedRevision: '0123456789abcdef0123456789abcdef01234567', author: { name: 'L_AUTHOR' }, detailUrl: 'https://codeup.aliyun.com/org/example-team/example-web/change/42' };
    else if (url.pathname === '/oapi/v1/codeup/organizations/org/repositories/10001/commits/0123456789abcdef0123456789abcdef01234567') value = { id: '0123456789abcdef0123456789abcdef01234567', shortId: '01234567', title: 'feat: show offline status', message: 'feat: show offline status\n\ndetails', authorName: 'L_AUTHOR', parentIds: ['45986a99c94b3a493800e203bd1175a9bb6901d6'], webUrl: 'https://codeup.aliyun.com/org/example-team/example-web/commit/0123456789abcdef0123456789abcdef01234567' };
    else if (url.pathname === '/oapi/v1/codeup/organizations/org/repositories/10001/compares') {
      if (url.searchParams.get('sourceType') === 'branch') value = { commits: [], diffs: [] };
      else value = { commits: [{ shortId: '01234567', title: 'feat: show offline status', authorName: 'L_AUTHOR' }], diffs: [{ oldPath: 'src/device.vue', newPath: 'src/device.vue', diff: '@@ -1 +1 @@\n-old\n+new' }] };
    }
    else { res.writeHead(404); value = { message: 'L_NOT_FOUND' }; }
    res.end(JSON.stringify(value));
    function issue() { return { id: '10010', key: 'TEST-10', fields: { summary: state.title, description: state.description, status: { name: 'L_REMOTE_STATUS' }, issuetype: { name: 'L_REMOTE_TYPE' }, updated: state.updated, ...(state.issueProject ? { project: state.issueProject } : {}), ...state.issueFields } }; }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const profile = join(dir, 'jenkins.json'); writeFileSync(profile, JSON.stringify({ baseUrl: base, username: 'jenkins', token: secret }), { mode: 0o600 });
  const logs = [];
  const platform = createPlatform({ dbPath: join(dir, 'platform.sqlite'), allowConnectorLoopbackHttp: true, connectorProfiles: { jenkins: { file: profile } }, logger: { error: (...args) => logs.push(args.join(' ')) }, ...options });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${platform.server.address().port}`;
  async function call(path, method = 'GET', body, token = admin.token) {
    const response = await fetch(local + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  }
  let admin = {};
  await call('/api/setup', 'POST', { username: 'admin', password }); admin = (await call('/api/login', 'POST', { username: 'admin', password })).body;
  async function member(username, role, projectId = 'default') { const created = await call('/api/users', 'POST', { username, role, password, projectId }); assert.equal(created.status, 201); return (await call('/api/login', 'POST', { username, password })).body; }
  async function config(provider, extra = {}) { const result = await call(`/api/connectors/${provider}/config`, 'POST', { projectId: 'default', baseUrl: base, authMode: 'BEARER', token: secret, ...extra }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result; }
  const holdNext = path => { const hold = { path, started: Promise.withResolvers(), resume: Promise.withResolvers() }; assert.ok(!state.hold, 'only one upstream gate at a time'); state.hold = hold; return { started: hold.started.promise, release: hold.resume.resolve }; };
  return { platform, state, base, dir, logs, admin, call, member, config, holdNext, async close() { await platform.close(); await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => target.close(resolve))]); rmSync(dir, { recursive: true, force: true }); } };
}
test('GitHub verifies the personal account and reads repository and PR metadata through its project selection', async t => {
  const f = await fixture();
  t.after(f.close);
  const dev = await f.member('github-reader', 'DEV');
  const other = await f.member('other-github-reader', 'DEV');
  const received = [];
  f.state.handle = (req, url) => {
    received.push({ accept: req.headers.accept, agent: req.headers['user-agent'] });
    if (url.pathname === '/user') return { value: { id: 42, login: 'github-reader', name: 'Developer', email: 'private@example.invalid' } };
    if (url.pathname === '/repos/team/app') return { value: { full_name: 'Team/App', private: true, default_branch: 'main' } };
    if (url.pathname === '/repos/team/app/pulls/7') return { value: {
      number: 7, title: 'L_PULL_TITLE', state: 'open', changed_files: 1, base: { ref: 'main', sha: 'c'.repeat(40), repo: { full_name: 'Team/App' } },
      head: { ref: 'feature/example', sha: 'e'.repeat(40) },
    } };
  };

  const input = { provider: 'github', name: 'GitHub', scope: 'PERSONAL', baseUrl: f.base, authMode: 'BEARER', token: secret };
  assert.equal((await f.call('/api/accounts', 'POST', { ...input, baseUrl: 'https://example.invalid' }, dev.token)).body.error.code, 'INVALID_BASE_URL');
  assert.equal((await f.call('/api/accounts', 'POST', { ...input, authMode: 'BASIC' }, dev.token)).body.error.code, 'INVALID_AUTH_MODE');
  assert.equal((await f.call('/api/connectors/github/config', 'POST', { ...input, baseUrl: 'https://api.github.com/elsewhere' })).body.error.code, 'INVALID_BASE_URL');
  const created = await f.call('/api/accounts', 'POST', input, dev.token);
  assert.equal(created.status, 201);
  const { id, version } = created.body.account;
  const verifyPath = '/api/accounts/' + id + '/test';
  const verifyInput = { expectedVersion: version, projectId: 'default' };
  assert.equal((await f.call(verifyPath, 'POST', verifyInput, other.token)).status, 404);
  const checked = await f.call(verifyPath, 'POST', verifyInput, dev.token);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.account.status, 'CONNECTED');
  assert.deepEqual(checked.body.identity, { id: '42', name: 'github-reader', displayName: 'Developer' });

  const selection = { projectId: 'default', provider: 'github', accountId: id };
  assert.equal((await f.call('/api/accounts/select', 'POST', selection, dev.token)).status, 200);
  const lookup = { projectId: 'default', repository: 'team/app' };
  const repo = await f.call('/api/connectors/github/read', 'POST', { ...lookup, resource: 'github_repo' }, dev.token);
  assert.equal(repo.status, 200);
  assert.equal(repo.body.externalUrl, 'https://github.com/team/app');
  assert.equal(JSON.parse(repo.body.content).defaultBranch, 'main');
  const pull = await f.call('/api/connectors/github/read', 'POST', { ...lookup, resource: 'github_pull', pullNumber: '7' }, dev.token);
  assert.equal(pull.status, 200);
  assert.equal(pull.body.externalUrl, 'https://github.com/team/app/pull/7');
  assert.equal(pull.body.title, 'L_PULL_TITLE');
  assert.equal(JSON.parse(pull.body.content).headSha, 'e'.repeat(40));
  const prohibited = await f.call('/api/connectors/github/import', 'POST', { ...lookup, resource: 'github_pull', pullNumber: '7' }, dev.token);
  assert.equal(prohibited.status, 405);
  assert.deepEqual(f.state.requests.map(({ method, url }) => [method, url]), [
    ['GET', '/user'], ['GET', '/user'], ['GET', '/repos/team/app'], ['GET', '/user'], ['GET', '/repos/team/app/pulls/7'],
  ]);
  assert.ok(f.state.requests.every(request => request.auth === 'Bearer ' + secret));
  assert.ok(received.every(({ accept, agent }) => accept === 'application/vnd.github+json' && agent === 'TaskFlow'));

  const { body: { task } } = await f.call('/api/tasks', 'POST', { projectId: 'default', title: 'Review GitHub PR' }, dev.token);
  const original = f.state.handle;
  const patch = '@@ -1 +1 @@\n-return 1;\n+return 2;';
  f.state.handle = (req, url) => url.pathname === '/repos/team/app/pulls/7/files'
    ? { value: [{ filename: 'main.ts', patch }] }
    : original(req, url);
  const request = { ...lookup, resource: 'github_pull', pullNumber: '7', taskId: task.id, kind: 'CODE', includeDiff: true };
  const imported = await f.call('/api/connectors/github/import', 'POST', request, dev.token);
  assert.equal(imported.status, 200);
  assert.equal(JSON.parse(imported.body.asset.content).diffs[0].diff, patch);
  f.state.handle = (req, url) => url.pathname === '/repos/team/app/pulls/7/files'
    ? { value: [{ filename: 'main.ts' }] }
    : original(req, url);
  assert.equal((await f.call('/api/connectors/github/import', 'POST', request, dev.token)).body.error.code, 'REMOTE_CONTENT_INCOMPLETE');
});

test('a personal Yunxiao account can verify and read Codeup without Flow permissions', async t => {
  const f = await fixture();
  t.after(f.close);
  const dev = await f.member('codeup-reader', 'DEV');
  const flow = '/oapi/v1/flow/organizations/org/pipelines';
  const repos = '/oapi/v1/codeup/organizations/org/repositories';
  const mrs = '/oapi/v1/codeup/organizations/org/changeRequests';
  f.state.handle = (_req, url) => {
    if (url.pathname === flow) return { status: 403, value: { message: 'L_FLOW_DENIED' } };
  };
  const created = await f.call('/api/accounts', 'POST', {
    provider: 'yunxiao', scope: 'PERSONAL', name: 'Codeup', baseUrl: f.base,
    authMode: 'PRIVATE_TOKEN', organizationId: 'org', token: secret,
  }, dev.token);
  assert.equal(created.status, 201);
  const { id, version } = created.body.account;
  const projectId = 'default';
  const verify = await f.call(`/api/accounts/${id}/test`, 'POST', { expectedVersion: version, projectId }, dev.token);
  assert.equal(verify.status, 200);
  assert.equal(verify.body.account.status, 'CONNECTED');
  assert.deepEqual(verify.body.verifiedResource, { resource: 'yunxiao_repos', organizationId: 'org', count: 1 });
  assert.equal((await f.call('/api/accounts/select', 'POST', { projectId, provider: 'yunxiao', accountId: id }, dev.token)).status, 200);
  const read = resource => f.call('/api/connectors/yunxiao/read', 'POST', { projectId, resource }, dev.token);
  const codeup = await read('yunxiao_mrs');
  assert.equal(codeup.status, 200);
  assert.equal(codeup.body.items[0].localId, '42');
  const denied = await read('yunxiao_pipelines');
  assert.equal(denied.status, 502);
  assert.equal(denied.body.error.message, 'L_FLOW_DENIED');
  assert.deepEqual(f.state.requests.map(({ method, url }) => [method, url.split('?')[0]]), [
    ['GET', flow], ['GET', repos], ['GET', repos], ['GET', mrs], ['GET', flow],
  ]);
});

for (const provider of ['gitlab', 'yunxiao']) {
  test(`${provider}: approved MR is merged through the operator account and read back without changing the reviewed asset`, async () => {
    const f = await fixture();
    const head = 'a'.repeat(40), target = 'b'.repeat(40), mergeCommit = 'c'.repeat(40);
    const repo = '/oapi/v1/codeup/organizations/org/repositories/42';
    const endpoint = provider === 'gitlab' ? '/api/v4/projects/42/merge_requests/7' : `${repo}/changeRequests/7`;
    const actual = { head, targetBranch: 'test', merged: false, writes: [], blocked: false };
    f.state.handle = async (req, url) => {
      const codeupDetails = { localId: 7, projectId: 42, sourceProjectId: 42, targetProjectId: 42, title: 'L_MR_TITLE',
        sourceBranch: 'feature/sample', targetBranch: actual.targetBranch, status: actual.merged ? 'MERGED' : 'TO_BE_MERGED',
        allRequirementsPass: !actual.blocked, conflictCheckStatus: 'NO_CONFLICT', mergedRevision: actual.merged ? mergeCommit : null };
      const gitlabDetails = { iid: 7, project_id: 42, source_project_id: 42, target_project_id: 42, title: 'L_MR_TITLE',
        source_branch: 'feature/sample', target_branch: actual.targetBranch, state: actual.merged ? 'merged' : 'opened',
        sha: actual.head, details: null, diff_refs: { head_sha: actual.head, base_sha: target, start_sha: target },
        detailed_merge_status: actual.blocked ? 'ci_must_pass' : 'mergeable', merge_commit_sha: actual.merged ? mergeCommit : null };
      if (url.pathname === endpoint || url.pathname === `${endpoint}/merge`) {
        if (req.method !== 'GET') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          actual.writes.push({ method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization || req.headers['x-yunxiao-token'] });
          if (actual.merged) return { status: 409, value: { message: 'L_ALREADY_MERGED' } };
          actual.merged = true;
          // A response lost after the write must be reconciled through GET.
          return { status: 502, value: { message: 'L_WRITE_RESPONSE_LOST' } };
        }
        return { value: provider === 'gitlab' ? gitlabDetails : codeupDetails };
      }
      if (url.pathname === `${repo}/branches/feature%2Fsample`) return { value: { commit: { id: actual.head } } };
      if (url.pathname === `${repo}/branches/test`) return { value: { commit: { id: target } } };
      if (url.pathname === `${repo}/compares`) {
        assert.equal(url.searchParams.get('from'), target);
        assert.equal(url.searchParams.get('to'), head);
        return { value: { diffs: [{ oldPath: 'a.js', newPath: 'a.js', diff: '@@ -1 +1 @@\n-old\n+new' }] } };
      }
      if (url.pathname === `${repo}/commits/${mergeCommit}`) return { value: { id: mergeCommit, parentIds: [target, head] } };
    };
    const { call } = f;
    try {
      const lead = await f.member('other-lead', 'LEAD');
      const dev = await f.member('a-developer', 'DEV');
      const authMode = provider === 'gitlab' ? 'BEARER' : 'PRIVATE_TOKEN';
      const organization = provider === 'yunxiao' ? { organizationId: 'org' } : {};
      await f.config(provider, { authMode, ...organization });
      const task = (await call('/api/tasks', 'POST', { jiraKey: 'MR-1', title: 'Remote merge test' })).body.task;
      const taskPath = `/api/tasks/${task.id}`;
      const statusPath = `${taskPath}/merge-requests`;
      for (const kind of ['PRD', 'TECH_SPEC']) {
        assert.equal((await call(`${taskPath}/assets`, 'POST', { kind, title: kind, content: 'Reviewed input' })).status, 201);
      }
      const manual = await call(`${taskPath}/assets`, 'POST', { kind: 'CODE', title: 'Manual', content: 'No verified MR' });
      assert.equal(manual.status, 201);
      assert.deepEqual((await call(statusPath)).body.items, []);
      const input = provider === 'gitlab' ? { resource: 'gitlab_mr', mrIid: 7 } : { resource: 'yunxiao_mr', mrLocalId: 7 };
      const imported = await call(`/api/connectors/${provider}/import`, 'POST', { taskId: task.id, repositoryId: 42, ...input });
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      const asset = imported.body.asset;
      const mergePath = `${statusPath}/${asset.id}/merge`;
      const job = (await call('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'HUMAN_REVIEW' })).body.job;
      const attempt = { expectedReviewId: job.id };
      assert.equal((await call(mergePath, 'POST', attempt)).body.error.code, 'MR_REVIEW_REQUIRED');
      assert.equal((await call(`/api/jobs/${job.id}/report`, 'POST', { source: 'MANUAL', summary: 'Reviewed diff', findings: [] })).status, 201);
      assert.equal((await call(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Reviewed current snapshot' }, lead.token)).status, 201);
      assert.equal((await call(mergePath, 'POST', attempt, dev.token)).body.error.code, 'MR_MERGE_FORBIDDEN');
      assert.equal((await call(mergePath, 'POST', attempt)).body.error.code, 'MR_PERSONAL_ACCOUNT_REQUIRED');
      const token = 'current-operator-fixture-token';
      const account = (await call('/api/accounts', 'POST', { provider, name: 'Operator', scope: 'PERSONAL', baseUrl: f.base, authMode, token, ...organization })).body.account;
      assert.equal((await call('/api/accounts/select', 'POST', { projectId: 'default', provider, accountId: account.id })).status, 200);
      const live = (await call(statusPath)).body.items[0];
      assert.equal(live.reviewId, job.id);
      assert.equal(live.reviewed.headSha, head);
      assert.equal(live.title, 'L_MR_TITLE');
      assert.equal(live.targetBranch, 'test');
      actual.head = 'd'.repeat(40);
      assert.equal((await call(mergePath, 'POST', attempt)).body.error.code, 'MR_HEAD_CHANGED');
      actual.head = head;
      actual.targetBranch = 'production';
      assert.equal((await call(mergePath, 'POST', attempt)).body.error.code, 'MR_HEAD_CHANGED');
      actual.targetBranch = 'test';
      actual.blocked = true;
      assert.equal((await call(mergePath, 'POST', attempt)).body.error.code, 'MR_NOT_MERGEABLE');
      actual.blocked = false;
      assert.deepEqual(actual.writes, []);

      const delayed = f.holdNext(endpoint);
      const first = call(mergePath, 'POST', attempt);
      await delayed.started;
      try { assert.equal((await call(mergePath, 'POST', attempt)).body.error.code, 'MR_MERGE_IN_PROGRESS'); }
      finally { delayed.release(); }
      assert.deepEqual(await first, { status: 200, body: { state: provider === 'gitlab' ? 'merged' : 'MERGED', mergeCommit } });
      assert.deepEqual(actual.writes, [provider === 'gitlab'
        ? { method: 'PUT', body: { sha: head, should_remove_source_branch: false }, auth: `Bearer ${token}` }
        : { method: 'POST', body: { mergeType: 'no-fast-forward', removeSourceBranch: false }, auth: token }]);
      const confirmed = await call(statusPath);
      assert.equal(confirmed.body.items[0].merged, true);
      assert.equal(confirmed.body.items[0].mergeCommit, mergeCommit);
      assert.equal(confirmed.body.items[0].reviewId, null);
      assert.equal((await call(mergePath, 'POST', attempt)).body.alreadyMerged, true);
      assert.equal(actual.writes.length, 1);
      assert.equal((await call(`${taskPath}/gates`)).body.gates.find(gate => gate.stage === 'CODE_REVIEW').jobId, job.id);
      assert.equal(f.platform.db.prepare('SELECT COUNT(*) AS count FROM assets WHERE logical_key=?').get(asset.logicalKey).count, 1);
    } finally { await f.close(); }
  });
}

test('connector authentication, encrypted credentials, role isolation and safe remote failures', async () => {
  const f = await fixture(); const { call, config, state, platform } = f;
  try {
    const dev = await f.member('developer', 'DEV'); const lead = await f.member('leader', 'LEAD');
    const other = (await call('/api/projects', 'POST', { key: 'OTHER', name: 'Other' })).body.project;
    assert.equal((await call(`/api/connectors?projectId=${other.id}`, 'GET', undefined, dev.token)).status, 403);
    assert.equal((await call('/api/connectors/jira/config', 'POST', { baseUrl: f.base, authMode: 'BEARER', token: secret }, dev.token)).status, 403);
    for (const baseUrl of ['https://user:password@example.invalid', 'https://example.invalid/?token=bad', 'https://example.invalid/#bad', 'http://example.invalid']) assert.equal((await call('/api/connectors/jira/config', 'POST', { baseUrl, authMode: 'BEARER', token: secret })).status, 400);
    const saved = await config('jira'); assert.equal(saved.body.connector.status, 'CONFIGURED'); assert.equal(saved.body.connector.hasCredential, true); assert.ok(!JSON.stringify(saved.body).includes(secret));
    const sealed = platform.db.prepare("SELECT credential FROM connector_configs WHERE provider='jira'").get().credential;
    assert.ok(!sealed.includes(secret)); assert.equal(typeof JSON.parse(sealed).tag, 'string');
    assert.equal(statSync(join(f.dir, 'connectors.key')).mode & 0o777, 0o600); assert.equal(readFileSync(join(f.dir, 'connectors.key')).length, 32);
    const reused = await call('/api/connectors/jira/config', 'POST', { baseUrl: f.base, authMode: 'BEARER' }); assert.equal(reused.status, 200);
    assert.equal((await call('/api/connectors/jira/config', 'POST', { baseUrl: 'https://other.invalid', authMode: 'BEARER' })).body.error.code, 'NEW_CREDENTIAL_REQUIRED');
    const verified = await call('/api/connectors/jira/test', 'POST', {}); assert.equal(verified.status, 200); assert.deepEqual(verified.body.identity, { id: 'current-user', displayName: 'L_IDENTITY' }); assert.ok(!JSON.stringify(verified.body).includes('email'));
    state.identity = `L_IDENTITY ${secret}`; const reflectedIdentity = await call('/api/connectors/jira/test', 'POST', {}); assert.equal(reflectedIdentity.body.identity.displayName, 'L_IDENTITY [凭据已隐藏]'); delete state.identity;
    assert.equal((await call('/api/connectors/jira/read', 'POST', { resource: 'jira_issues', jql: 'assignee=currentUser()' }, dev.token)).status, 403);
    const list = await call('/api/connectors/jira/read', 'POST', { resource: 'jira_issues', jql: 'assignee=currentUser()', limit: 1 }); assert.equal(list.status, 200); assert.equal(list.body.items[0].summary, 'L_JIRA_TITLE'); assert.equal(list.body.items[0].status, 'L_REMOTE_STATUS');
    assert.equal((await call('/api/connectors/jira/read', 'POST', { resource: 'jira_issues', jql: 'x', limit: 51 })).status, 400);
    state.error = true; const failure = await call('/api/connectors/jira/test', 'POST', {}); assert.equal(failure.status, 502); assert.equal(failure.body.error.message, 'L_ACCESS_DENIED [凭据已隐藏]'); assert.equal((await call('/api/me')).status, 200); state.error = false;
    state.redirect = true; assert.equal((await call('/api/connectors/jira/test', 'POST', {})).body.error.code, 'REMOTE_REDIRECT'); assert.equal(state.targetHits, 0); state.redirect = false;
    assert.equal((await call('/api/connectors/jenkins/reuse-local', 'POST', {}, lead.token)).status, 403);
    assert.equal((await call('/api/connectors/jenkins/reuse-local', 'POST', { file: '/not/a/caller/chosen/path' })).status, 200);
    state.anonymous = true; assert.equal((await call('/api/connectors/jenkins/test', 'POST', {})).body.error.code, 'REMOTE_IDENTITY_INVALID'); state.anonymous = false;
    assert.equal((await call('/api/connectors/jenkins/test', 'POST', {})).body.identity.name, 'L_JENKINS_USER');
    assert.equal((await call('/api/connectors/jenkins/read', 'POST', { resource: 'jenkins_jobs' }, dev.token)).status, 403);
    await config('confluence', { authMode: 'NONE', token: undefined }); assert.equal((await call('/api/connectors/confluence/test', 'POST', {})).body.error.code, 'REMOTE_AUTH_REQUIRED');
    await config('confluence'); state.description = `L_REQUIREMENTS ${secret}`;
    const imported = await call('/api/connectors/jira/import', 'POST', { resource: 'jira_issue', issueKey: 'TEST-10' }); assert.equal(imported.status, 200); assert.ok(!JSON.stringify(imported.body).includes(secret));
    const encodedBasic = Buffer.from(`user:${secret}`).toString('base64'); await config('confluence', { authMode: 'BASIC', username: 'user' }); state.pageContent = `<p>L_SAFE ${secret} ${encodedBasic}</p>`;
    const reflectedAsset = await call('/api/connectors/confluence/import', 'POST', { resource: 'confluence_page', pageId: 123, taskId: imported.body.task.id }); assert.equal(reflectedAsset.status, 200); assert.equal(reflectedAsset.body.asset.content, '<p>L_SAFE [凭据已隐藏] [凭据已隐藏]</p>');
    assert.ok(!platform.db.prepare('SELECT external_ref FROM tasks').get().external_ref.includes(secret)); assert.ok(!platform.db.prepare('SELECT content FROM assets').get().content.includes(secret));
    assert.equal((await call('/api/connectors/gitlab/reuse-local', 'POST', {})).body.error.code, 'LOCAL_PROFILE_UNAVAILABLE');
    const metadata = await call('/api/connectors'); assert.equal(metadata.body.connectors.find(item => item.provider === 'jenkins').localProfileAvailable, true); assert.ok(!JSON.stringify(metadata.body).includes(secret));
    assert.ok(state.requests.every(req => req.method === 'GET')); assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});
test('stalled local profile reads time out without freezing HTTP or accumulating duplicate opens', async () => {
  let opens = 0; let release;
  const f = await fixture({ connectorProfiles: { confluence: { file: '/configured/allowlisted/profile.env', baseUrl: 'https://example.invalid' } }, connectorProfileReader: () => { opens++; return new Promise(resolve => { release = resolve; }); } });
  try {
    const metadata = await f.call('/api/connectors'); assert.equal(metadata.body.connectors.find(item => item.provider === 'confluence').localProfileAvailable, true); assert.equal(opens, 0);
    const started = Date.now(); const attempts = [f.call('/api/connectors/confluence/reuse-local', 'POST', {}), f.call('/api/connectors/confluence/reuse-local', 'POST', {})];
    await new Promise(resolve => setTimeout(resolve, 30));
    const healthStart = Date.now(); assert.equal((await f.call('/health')).status, 200); assert.ok(Date.now() - healthStart < 500); assert.equal(opens, 1);
    const results = await Promise.all(attempts); assert.ok(Date.now() - started < 5000); assert.ok(results.every(result => result.status === 409 && result.body.error.code === 'LOCAL_PROFILE_TIMEOUT')); assert.equal(opens, 1);
    release(`CONFLUENCE_AUTH_HEADER='Bearer ${secret}'\n`); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await f.call('/health')).status, 200); assert.equal(f.logs.length, 0);
  } finally { release?.(''); await f.close(); }
});
test('read-only imports preserve original content, manual fields, project scope and review invalidation', async () => {
  const f = await fixture(); const { call, config, state, platform } = f;
  try {
    const dev = await f.member('developer', 'DEV'); const pm = await f.member('product', 'PM');
    for (const provider of ['jira', 'confluence', 'gitlab', 'jenkins', 'yunxiao']) await config(provider, provider === 'yunxiao' ? { authMode: 'PRIVATE_TOKEN', organizationId: 'org' } : {});
    const imported = await call('/api/connectors/jira/import', 'POST', { resource: 'jira_issue', issueKey: 'TEST-10' }); assert.equal(imported.status, 200); assert.equal(imported.body.imported, true); let task = imported.body.task;
    assert.equal(task.jiraStatus, 'verified'); assert.equal(task.title, 'L_JIRA_TITLE'); assert.equal(task.externalRef.description, state.description); assert.equal(task.externalRef.status, 'L_REMOTE_STATUS');
    const again = await call('/api/connectors/jira/import', 'POST', { resource: 'jira_issue', issueKey: 'TEST-10' }); assert.equal(again.body.imported, false); assert.equal(again.body.task.version, task.version);
    task = (await call(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'My manual title', assigneeId: dev.user.id, status: 'IN_PROGRESS' })).body.task;
    const confBody = { resource: 'confluence_page', pageId: '123', taskId: task.id, kind: 'PRD' };
    const page = await call('/api/connectors/confluence/import', 'POST', confBody); assert.equal(page.status, 200); assert.equal(page.body.asset.title, 'L_PRD_TITLE'); assert.equal(page.body.asset.content, '<p>L_PRD_BODY</p>');
    const duplicate = await call('/api/connectors/confluence/import', 'POST', confBody); assert.equal(duplicate.body.imported, false); assert.equal(duplicate.body.asset.id, page.body.asset.id);
    const review = (await call('/api/reviews', 'POST', { taskId: task.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, pm.token)).body.job;
    assert.equal((await call(`/api/jobs/${review.id}/report`, 'POST', { summary: 'Reviewed raw PRD', source: 'MANUAL', findings: [] }, pm.token)).status, 201);
    assert.equal((await call(`/api/jobs/${review.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Verified' })).status, 201);
    assert.equal((await call(`/api/tasks/${task.id}/gates`)).body.gates.find(item => item.stage === 'PRD').status, 'PASS');
    state.pageVersion++; state.pageContent = '<p>L_UPDATED_PRD</p>'; const updatedPage = await call('/api/connectors/confluence/import', 'POST', confBody); assert.equal(updatedPage.body.asset.revision, 2); assert.equal(updatedPage.body.asset.content, state.pageContent);
    assert.equal((await call(`/api/tasks/${task.id}/gates`)).body.gates.find(item => item.stage === 'PRD').status, 'STALE');
    const before = (await call(`/api/tasks/${task.id}`)).body.task; state.updated = '2026-11-12T01:00:00Z'; state.title = 'L_CHANGED_REMOTE_TITLE'; state.description = 'Changed remote requirements';
    const changed = await call('/api/connectors/jira/import', 'POST', { resource: 'jira_issue', issueKey: 'TEST-10' }); task = changed.body.task; assert.equal(task.title, 'My manual title'); assert.equal(task.assigneeId, dev.user.id); assert.equal(task.status, 'IN_PROGRESS'); assert.equal(task.contextVersion, before.contextVersion + 1); assert.equal(task.externalRef.title, 'L_CHANGED_REMOTE_TITLE');
    const nextReview = (await call('/api/reviews', 'POST', { taskId: task.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, pm.token)).body.job; assert.equal(nextReview.snapshot.task.title, 'My manual title'); assert.equal(nextReview.snapshot.task.jira.title, 'L_CHANGED_REMOTE_TITLE'); assert.equal(nextReview.snapshot.task.jira.description, 'Changed remote requirements');
    const mrBody = { resource: 'gitlab_mr', repositoryId: 42, mrIid: 7, taskId: task.id, kind: 'CODE' }; state.truncated = true; assert.equal((await call('/api/connectors/gitlab/import', 'POST', mrBody)).body.error.code, 'REMOTE_CONTENT_INCOMPLETE'); state.truncated = false;
    const mr = await call('/api/connectors/gitlab/import', 'POST', mrBody); assert.equal(mr.status, 200); assert.equal(mr.body.asset.title, 'L_MR_TITLE'); assert.equal(mr.body.asset.sourceUrl, `${f.base}/team/repository/-/merge_requests/7`);
    const build = await call('/api/connectors/jenkins/read', 'POST', { resource: 'jenkins_build', jobName: 'team/app' });
    assert.equal(build.body.title, 'L_BUILD_TITLE');
    assert.deepEqual(JSON.parse(build.body.content).gitCheckouts, [{ repository: 'https://git.example/team/app.git', commit: 'a'.repeat(40) }]);
    assert.equal((await call('/api/connectors/jenkins/read', 'POST', { resource: 'jenkins_build', jobName: 'team/app', buildNumber: '16' })).body.error.code, 'REMOTE_RESOURCE_INVALID');
    const jobs = await call('/api/connectors/jenkins/read', 'POST', { resource: 'jenkins_jobs' }); assert.equal(jobs.status, 200); assert.deepEqual(jobs.body.items, [{ id: 'L_FOLDER_NAME', name: 'L_FOLDER_NAME', jobName: 'L_FOLDER_NAME', isFolder: true }, { id: 'L_JOB_NAME', name: 'L_JOB_NAME', jobName: 'L_JOB_NAME', isFolder: false }, { id: 'L_LEGACY_JOB', name: 'L_LEGACY_JOB', jobName: 'L_LEGACY_JOB', isFolder: false }]);
    assert.equal((await call('/api/connectors/jenkins/import', 'POST', { resource: 'jenkins_jobs', taskId: task.id })).body.error.code, 'IMPORT_RESOURCE_REQUIRED');
    assert.deepEqual((await call('/api/connectors/yunxiao/read', 'POST', { resource: 'yunxiao_pipelines' })).body.items, [{ id: 1, name: 'L_PIPELINE_TITLE' }]);
    assert.equal((await call('/api/connectors/yunxiao/import', 'POST', { resource: 'yunxiao_pipelines', taskId: task.id })).body.error.code, 'IMPORT_RESOURCE_REQUIRED');
    assert.equal((await call('/api/connectors/yunxiao/import', 'POST', { resource: 'yunxiao_run', pipelineId: 1, runId: 2, taskId: task.id })).body.asset.title, 'L_RUN_TITLE');
    const other = (await call('/api/projects', 'POST', { key: 'OTHER', name: 'Other' })).body.project; const crossTask = (await call('/api/tasks', 'POST', { projectId: other.id, jiraKey: 'OTHER-1', title: 'Other task' })).body.task;
    assert.equal((await call('/api/connectors/confluence/import', 'POST', { ...confBody, taskId: crossTask.id })).status, 403);
    platform.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(task.id);
    assert.equal((await call('/api/connectors/confluence/import', 'POST', confBody)).body.imported, false);
    state.pageVersion++; assert.equal((await call('/api/connectors/confluence/import', 'POST', confBody)).body.error.code, 'TASK_DONE');
    assert.ok(state.requests.every(req => req.method === 'GET')); assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

test('Jira project catalog sync is atomic, preserves credentials and members, and scopes every bound read', async () => {
  const f = await fixture(); const { call, config, state, platform } = f;
  try {
    const dev = await f.member('developer', 'DEV'); const lead = await f.member('leader', 'LEAD'); await config('jira'); await config('jenkins');
    const catalog = await call('/api/connectors/jira/read', 'POST', { resource: 'jira_projects' });
    assert.equal(catalog.status, 200); assert.equal(catalog.body.items[0].name, 'L_GROUP-L_PROJECT_NAME'); assert.equal(catalog.body.items[0].category.name, 'L_CATEGORY'); assert.equal(catalog.body.items[1].category, null);
    assert.equal((await call('/api/connectors/jira/read', 'POST', { resource: 'jira_projects' }, lead.token)).status, 403);
    assert.equal((await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['101'] }, lead.token)).status, 403);
    const synced = await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['101', '102'] }); assert.equal(synced.status, 200); assert.equal(synced.body.created, 2);
    const project = synced.body.projects.find(item => item.jira?.id === '101'); const other = synced.body.projects.find(item => item.jira?.id === '102');
    assert.equal(project.key, 'TEST'); assert.equal(project.jira.baseUrl, f.base); assert.equal(project.jira.category.description, 'L_CATEGORY_DESCRIPTION'); assert.equal(other.jira.category, null);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS count FROM project_members WHERE project_id=?').get(project.id).count, 1);
    assert.deepEqual(platform.db.prepare('SELECT provider FROM connector_configs WHERE project_id=?').all(project.id).map(item => item.provider), ['jira']);
    assert.equal((await call(`/api/projects`, 'GET', undefined, dev.token)).body.projects.some(item => item.id === project.id), false);
    assert.equal((await call('/api/tasks', 'POST', { projectId: project.id, jiraKey: 'OTHER-123', title: 'Wrong project' })).body.error.code, 'JIRA_TASK_PROJECT_MISMATCH');
    const manualTask = await call('/api/tasks', 'POST', { projectId: project.id, jiraKey: 'TEST-123', title: 'Unverified own-project task' }); assert.equal(manualTask.status, 201); assert.equal(manualTask.body.task.jiraStatus, 'unverified');
    await call(`/api/projects/${project.id}/members`, 'POST', { userId: lead.user.id, role: 'LEAD' });
    const ownCatalog = await call('/api/connectors/jira/read', 'POST', { projectId: project.id, resource: 'jira_projects' }, lead.token); assert.equal(ownCatalog.status, 200); assert.deepEqual(ownCatalog.body.items.map(item => item.id), ['101']);
    assert.equal((await call('/api/connectors/jira/read', 'POST', { projectId: project.id, resource: 'jira_projects' })).body.items.length, 2);
    const ownCredentials = await call('/api/connectors/jira/config', 'POST', { projectId: project.id, baseUrl: f.base, authMode: 'PRIVATE_TOKEN', token: 'project-owned-token' }); assert.equal(ownCredentials.status, 200);
    const beforeConfig = platform.db.prepare("SELECT * FROM connector_configs WHERE project_id=? AND provider='jira'").get(project.id);
    const duplicate = await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['101', '102'] }); assert.equal(duplicate.body.unchanged, 2); assert.equal(duplicate.body.created, 0);
    const afterConfig = platform.db.prepare("SELECT * FROM connector_configs WHERE project_id=? AND provider='jira'").get(project.id);
    assert.equal(beforeConfig.credential, afterConfig.credential); assert.equal(beforeConfig.auth_mode, afterConfig.auth_mode); assert.equal(beforeConfig.version, afterConfig.version);
    assert.equal(platform.db.prepare('SELECT COUNT(*) AS count FROM project_members WHERE project_id=?').get(project.id).count, 2);
    state.projects[0].name = 'L_NEW_PROJECT_NAME'; state.projects[0].projectCategory = null;
    const updated = await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['101'] }); assert.equal(updated.body.updated, 1); assert.equal(updated.body.projects.find(item => item.id === project.id).name, 'L_NEW_PROJECT_NAME'); assert.equal(updated.body.projects.find(item => item.id === project.id).jira.category, null);
    assert.equal((await call('/api/connectors/jira/config', 'POST', { projectId: project.id, baseUrl: 'https://different.invalid', authMode: 'BEARER', token: secret })).body.error.code, 'JIRA_PROJECT_SOURCE_MISMATCH');
    state.issueProject = { id: '101', key: 'TEST', name: 'L_NEW_PROJECT_NAME' };
    state.issueFields = { issuetype: { id: '10000', name: 'L_ISSUE_TYPE', subtask: false }, priority: { id: '2', name: 'L_PRIORITY' }, components: [{ id: '1', name: 'L_COMPONENT' }], fixVersions: [{ id: '3', name: 'L_FIX_VERSION', released: false }], labels: ['L_LABEL'], assignee: { key: 'original-account', name: 'original-account', displayName: 'L_ASSIGNEE' } };
    const scoped = await call('/api/connectors/jira/read', 'POST', { projectId: project.id, resource: 'jira_issues', jql: 'summary ~ "ORDER BY" OR status = Open ORDER BY updated DESC' }, lead.token); assert.equal(scoped.status, 200);
    assert.equal(scoped.body.appliedJql, 'project = 101 AND (summary ~ "ORDER BY" OR status = Open) ORDER BY updated DESC'); assert.equal(new URL(scoped.body.externalUrl).searchParams.get('jql'), scoped.body.appliedJql);
    assert.equal(scoped.body.items[0].priority.name, 'L_PRIORITY'); assert.equal(scoped.body.items[0].type, 'L_ISSUE_TYPE'); assert.equal(scoped.body.items[0].assignee.displayName, 'L_ASSIGNEE');
    assert.equal((await call('/api/connectors/jira/read', 'POST', { projectId: project.id, resource: 'jira_issues', jql: 'project=102) OR project=102 OR (' })).body.error.code, 'INVALID_JQL');
    const mapped = await call('/api/connectors/jira/import', 'POST', { resource: 'jira_issue', issueKey: 'TEST-10' }); assert.equal(mapped.status, 409); assert.equal(mapped.body.error.code, 'PROJECT_MAPPING_REQUIRED'); assert.equal(mapped.body.error.details.targetProjectId, project.id);
    const imported = await call('/api/connectors/jira/import', 'POST', { projectId: project.id, resource: 'jira_issue', issueKey: 'TEST-10' }); assert.equal(imported.status, 200); assert.equal(imported.body.task.projectId, project.id); assert.equal(imported.body.task.type, 'TASK'); assert.equal(imported.body.task.externalRef.type, 'L_ISSUE_TYPE'); assert.equal(imported.body.task.externalRef.fixVersions[0].name, 'L_FIX_VERSION');
    state.issueProject = { id: '102', key: 'OTHER', name: 'L_OTHER_PROJECT' };
    assert.equal((await call('/api/connectors/jira/read', 'POST', { projectId: project.id, resource: 'jira_issues', jql: 'project=OTHER OR project=TEST' })).body.error.code, 'JIRA_PROJECT_SCOPE_MISMATCH');
    assert.equal((await call('/api/connectors/jira/read', 'POST', { projectId: project.id, resource: 'jira_issue', issueKey: 'TEST-10' })).body.error.code, 'JIRA_PROJECT_SCOPE_MISMATCH');
    assert.equal((await call('/api/connectors/jira/import', 'POST', { projectId: project.id, resource: 'jira_issue', issueKey: 'TEST-10' })).body.error.code, 'JIRA_PROJECT_SCOPE_MISMATCH');
    await call('/api/projects', 'POST', { key: 'TAKEN', name: 'Manual project' }); const count = platform.db.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
    state.projects.push({ id: '103', key: 'NEW', name: 'L_NEW' }, { id: '104', key: 'TAKEN', name: 'L_COLLISION' });
    const conflict = await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['103', '104'] }); assert.equal(conflict.body.error.code, 'PROJECT_KEY_CONFLICT'); assert.equal(platform.db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, count); assert.equal(platform.db.prepare("SELECT id FROM projects WHERE key='NEW'").get(), undefined);
    assert.equal((await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['103', '999'] })).body.error.code, 'JIRA_PROJECT_NOT_VISIBLE'); assert.equal(platform.db.prepare('SELECT COUNT(*) AS count FROM projects').get().count, count);
    assert.ok(state.requests.every(req => req.method === 'GET')); assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

test('Jira parent imported later links same-source children without invalidating parent reviews and skips frozen children', async () => {
  const f = await fixture(); const { call, state, platform } = f;
  try {
    await f.config('jira'); const synced = await call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['101'] }); const project = synced.body.projects.find(item => item.jira?.id === '101');
    const issue = (key, parentKey) => ({ id: key.split('-')[1], key, fields: { summary: `L_${key}`, description: `L_DESCRIPTION_${key}`, status: { name: 'L_STATUS' }, project: { id: '101', key: 'TEST', name: 'L_PROJECT' }, issuetype: { id: '10000', name: 'L_TYPE', subtask: !!parentKey }, ...(parentKey ? { parent: { key: parentKey } } : {}), updated: '2026-11-12T00:00:00Z' } });
    state.issues['TEST-20'] = issue('TEST-20', 'TEST-10'); state.issues['TEST-10'] = issue('TEST-10'); state.issues['TEST-30'] = issue('TEST-30');
    const importIssue = key => call('/api/connectors/jira/import', 'POST', { projectId: project.id, resource: 'jira_issue', issueKey: key });
    const child = (await importIssue('TEST-20')).body.task; assert.equal(child.parentId, null);
    await call(`/api/tasks/${child.id}/assets`, 'POST', { kind: 'PRD', title: 'L_PRD', content: 'L_PRD' });
    const review = await call('/api/reviews', 'POST', { taskId: child.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' });
    assert.equal(review.body.error.code, 'SUBTASK_REVIEW_NOT_REQUIRED');
    const beforeChild = (await call(`/api/tasks/${child.id}`)).body.task;
    const parentImport = await importIssue('TEST-10'); const parent = parentImport.body.task; assert.deepEqual(parentImport.body.linkedChildren, [child.id]); assert.equal(parent.contextVersion, 1);
    const linkedChild = (await call(`/api/tasks/${child.id}`)).body.task; assert.equal(linkedChild.parentId, parent.id); assert.equal(linkedChild.contextVersion, beforeChild.contextVersion + 1);
    assert.equal((await importIssue('TEST-20')).body.imported, false);
    const parentBeforeMove = (await call(`/api/tasks/${parent.id}`)).body.task;
    state.issues['TEST-20'] = issue('TEST-20', 'TEST-30'); await importIssue('TEST-20');
    assert.equal((await call(`/api/tasks/${child.id}`)).body.task.parentId, null); assert.equal((await call(`/api/tasks/${parent.id}`)).body.task.contextVersion, parentBeforeMove.contextVersion);
    platform.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(child.id);
    const nextParent = await importIssue('TEST-30'); assert.equal(nextParent.body.skippedChildren[0].id, child.id); assert.equal(nextParent.body.skippedChildren[0].reason, 'TASK_DONE'); assert.equal((await call(`/api/tasks/${child.id}`)).body.task.parentId, null);
    platform.db.prepare("UPDATE tasks SET status='OPEN' WHERE id=?").run(child.id);
    const relinkedParent = await importIssue('TEST-30'); assert.equal(relinkedParent.body.imported, true); assert.deepEqual(relinkedParent.body.linkedChildren, [child.id]);
    const relinked = await importIssue('TEST-20'); assert.equal(relinked.body.imported, false); assert.equal(relinked.body.task.parentId, nextParent.body.task.id);
    const newParentBefore = (await call(`/api/tasks/${nextParent.body.task.id}`)).body.task;
    assert.equal(newParentBefore.contextVersion, nextParent.body.task.contextVersion);
    platform.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(nextParent.body.task.id);
    state.issues['TEST-20'].fields.description = 'L_CANNOT_CHANGE_UNDER_DONE';
    assert.equal((await importIssue('TEST-20')).body.error.code, 'ANCESTOR_DONE');
    assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

const connectorState = db => Object.fromEntries(['connector_configs', 'audit', 'projects', 'jira_project_bindings', 'tasks', 'assets', 'external_imports'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

for (const change of ['membership removal', 'role downgrade', 'session logout', 'configuration replacement', 'configuration recreation']) {
  for (const remoteFailure of [false, true]) {
    test(`late ${remoteFailure ? 'failed' : 'successful'} probe cannot write after ${change}`, { timeout: 10_000 }, async () => {
      const f = await fixture(); let gate; let pending;
      try {
        const lead = await f.member('delayed_leader', 'LEAD'); await f.config('jira');
        f.state.error = remoteFailure; gate = f.holdNext('/rest/api/2/myself');
        pending = f.call('/api/connectors/jira/test', 'POST', {}, lead.token); await gate.started;
        if (change === 'membership removal') f.platform.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run('default', lead.user.id);
        else if (change === 'role downgrade') f.platform.db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?').run('DEV', 'default', lead.user.id);
        else if (change === 'session logout') assert.equal((await f.call('/api/logout', 'POST', {}, lead.token)).status, 204);
        else { if (change === 'configuration recreation') f.platform.db.prepare("DELETE FROM connector_configs WHERE provider='jira'").run(); await f.config('jira', { token: 'replacement-fixture-token' }); }
        const before = connectorState(f.platform.db); gate.release(); const result = await pending;
        const code = { 'membership removal': 'PROJECT_FORBIDDEN', 'role downgrade': 'CONNECTOR_FORBIDDEN', 'session logout': 'UNAUTHENTICATED', 'configuration replacement': 'CONNECTOR_CHANGED', 'configuration recreation': 'CONNECTOR_CHANGED' }[change];
        assert.equal(result.status, change === 'session logout' ? 401 : change.startsWith('configuration ') ? 409 : 403);
        assert.equal(result.body.error.code, code); assert.deepEqual(connectorState(f.platform.db), before);
        assert.equal(f.state.requests.length, 1); assert.equal(f.logs.length, 0);
      } finally { gate?.release(); if (pending) await pending; await f.close(); }
    });
  }
}

test('an authorized remote probe failure still records its original redacted error', async () => {
  const f = await fixture();
  try {
    await f.config('jira'); const audits = f.platform.db.prepare('SELECT * FROM audit ORDER BY rowid').all();
    f.state.error = true; const result = await f.call('/api/connectors/jira/test', 'POST', {});
    assert.equal(result.status, 502); assert.equal(result.body.error.message, 'L_ACCESS_DENIED [凭据已隐藏]');
    const row = f.platform.db.prepare("SELECT * FROM connector_configs WHERE provider='jira'").get();
    assert.equal(row.status, 'ERROR'); assert.equal(row.last_error, result.body.error.message); assert.ok(row.last_checked_at);
    assert.deepEqual(f.platform.db.prepare('SELECT * FROM audit ORDER BY rowid').all(), audits); assert.equal(f.logs.length, 0);
  } finally { await f.close(); }
});

test('session logout during resource read cannot import the already requested body', { timeout: 10_000 }, async () => {
  const f = await fixture(); let gate; let pending;
  try {
    const lead = await f.member('import_leader', 'LEAD'); await f.config('confluence');
    const task = (await f.call('/api/tasks', 'POST', { jiraKey: 'TEST-501', title: 'Import target' })).body.task;
    gate = f.holdNext('/rest/api/content/123');
    pending = f.call('/api/connectors/confluence/import', 'POST', { resource: 'confluence_page', pageId: '123', taskId: task.id }, lead.token); await gate.started;
    assert.equal((await f.call('/api/logout', 'POST', {}, lead.token)).status, 204);
    const before = connectorState(f.platform.db); gate.release(); const result = await pending;
    assert.equal(result.status, 401); assert.equal(result.body.error.code, 'UNAUTHENTICATED');
    assert.deepEqual(connectorState(f.platform.db), before); assert.equal(f.state.requests.length, 2); assert.equal(f.logs.length, 0);
  } finally { gate?.release(); if (pending) await pending; await f.close(); }
});

for (const change of ['platform role downgrade', 'session logout', 'configuration replacement']) {
  test(`Jira catalog sync cannot write after ${change}`, { timeout: 10_000 }, async () => {
    const f = await fixture(); let gate; let pending;
    try {
      await f.config('jira'); gate = f.holdNext('/rest/api/2/project');
      pending = f.call('/api/connectors/jira/sync-projects', 'POST', { projectIds: ['101'] }); await gate.started;
      if (change === 'platform role downgrade') f.platform.db.prepare("UPDATE users SET role='LEAD' WHERE id=?").run(f.admin.user.id);
      else if (change === 'session logout') assert.equal((await f.call('/api/logout', 'POST', {})).status, 204);
      else await f.config('jira', { token: 'replacement-fixture-token' });
      const before = connectorState(f.platform.db); gate.release(); const result = await pending;
      assert.equal(result.status, change === 'session logout' ? 401 : change === 'configuration replacement' ? 409 : 403);
      assert.equal(result.body.error.code, { 'platform role downgrade': 'PROJECT_SYNC_ADMIN_ONLY', 'session logout': 'UNAUTHENTICATED', 'configuration replacement': 'CONNECTOR_CHANGED' }[change]);
      assert.deepEqual(connectorState(f.platform.db), before); assert.equal(f.state.requests.length, 2); assert.equal(f.logs.length, 0);
    } finally { gate?.release(); if (pending) await pending; await f.close(); }
  });
}

test('a downgraded administrator cannot receive an unbound full Jira catalog', { timeout: 10_000 }, async () => {
  const f = await fixture(); let gate; let pending;
  try {
    await f.config('jira'); gate = f.holdNext('/rest/api/2/project');
    pending = f.call('/api/connectors/jira/read', 'POST', { resource: 'jira_projects' }); await gate.started;
    f.platform.db.prepare("UPDATE users SET role='LEAD' WHERE id=?").run(f.admin.user.id);
    const before = connectorState(f.platform.db); gate.release(); const result = await pending;
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'JIRA_CATALOG_ADMIN_ONLY');
    assert.deepEqual(connectorState(f.platform.db), before); assert.equal(f.logs.length, 0);
  } finally { gate?.release(); if (pending) await pending; await f.close(); }
});

for (const change of ['platform role downgrade', 'session logout', 'configuration replacement', 'configuration created']) {
  test(`delayed local profile reuse cannot write after ${change}`, { timeout: 10_000 }, async () => {
    const started = Promise.withResolvers(); const resume = Promise.withResolvers();
    const f = await fixture({ connectorProfileReader: () => { started.resolve(); return resume.promise; } }); let pending;
    try {
      if (change !== 'configuration created') await f.config('jenkins');
      pending = f.call('/api/connectors/jenkins/reuse-local', 'POST', {}); await started.promise;
      if (change === 'platform role downgrade') f.platform.db.prepare("UPDATE users SET role='LEAD' WHERE id=?").run(f.admin.user.id);
      else if (change === 'session logout') assert.equal((await f.call('/api/logout', 'POST', {})).status, 204);
      else await f.config('jenkins', { token: 'replacement-fixture-token' });
      const before = connectorState(f.platform.db); resume.resolve(JSON.stringify({ baseUrl: f.base, username: 'jenkins', token: secret })); const result = await pending;
      assert.equal(result.status, change === 'session logout' ? 401 : change === 'platform role downgrade' ? 403 : 409);
      assert.equal(result.body.error.code, change === 'session logout' ? 'UNAUTHENTICATED' : change === 'platform role downgrade' ? 'LOCAL_PROFILE_ADMIN_ONLY' : 'CONNECTOR_CHANGED');
      assert.deepEqual(connectorState(f.platform.db), before); assert.equal(f.state.requests.length, 0); assert.equal(f.logs.length, 0);
    } finally { resume.resolve('{}'); if (pending) await pending; await f.close(); }
  });
}

test('Yunxiao Codeup read-only connector lists repos/MRs and imports merged MRs and commits as CODE assets', async () => {
  const f = await fixture(); const { call, config } = f;
  try {
    await config('yunxiao', { authMode: 'PRIVATE_TOKEN', organizationId: 'org' });
    const task = (await call('/api/tasks', 'POST', { jiraKey: 'CODEUP-1', title: 'Codeup task' })).body.task;
    const repos = await call('/api/connectors/yunxiao/read', 'POST', { resource: 'yunxiao_repos' });
    assert.equal(repos.status, 200); assert.equal(repos.body.items[0].name, 'example-web');
    const mrs = await call('/api/connectors/yunxiao/read', 'POST', { resource: 'yunxiao_mrs' });
    assert.equal(mrs.status, 200); assert.equal(mrs.body.items[0].localId, '42');
    assert.equal((await call('/api/connectors/yunxiao/import', 'POST', { resource: 'yunxiao_mrs', taskId: task.id })).body.error.code, 'IMPORT_RESOURCE_REQUIRED');

    // Import MR by namespace path (resolves repository ID and falls back to mergedRevision diff)
    const mrImport = await call('/api/connectors/yunxiao/import', 'POST', {
      resource: 'yunxiao_mr', repositoryId: 'example-team/example-web', mrLocalId: '42', taskId: task.id,
    });
    assert.equal(mrImport.status, 200);
    assert.equal(mrImport.body.asset.kind, 'CODE');
    assert.match(mrImport.body.asset.content, /src\/device\.vue/);
    assert.equal(mrImport.body.asset.sourceUrl, 'https://codeup.aliyun.com/org/example-team/example-web/change/42');

    // Import single Codeup commit as CODE
    const commitImport = await call('/api/connectors/yunxiao/import', 'POST', {
      resource: 'yunxiao_commit', repositoryId: '10001', commitSha: '0123456789abcdef0123456789abcdef01234567', taskId: task.id, kind: 'CODE',
    });
    assert.equal(commitImport.status, 200);
    assert.equal(commitImport.body.asset.kind, 'CODE');
    assert.match(commitImport.body.asset.content, /feat: show offline status/);
  } finally { await f.close(); }
});

test('Yunxiao Codeup merged MR falls back to diffs/patches and mergedRevision^1 when commits API lacks token permission', async () => {
  const f = await fixture(); const { call, config } = f;
  const mergeSha = '1'.repeat(40);
  const baseSha = '2'.repeat(40);
  const headSha = '3'.repeat(40);
  const oldHeadSha = '4'.repeat(40);
  const repo = '/oapi/v1/codeup/organizations/org/repositories/10001';
  let patchesEnabled = true;
  f.state.handle = (_req, url) => {
    if (url.pathname === `${repo}/changeRequests/647`) {
      return { value: {
        localId: 647, projectId: 10001, title: 'fix: adyen withdrawal', status: 'MERGED',
        sourceBranch: 'feature/vms', targetBranch: 'i18n-test', mergedRevision: mergeSha,
        author: { name: 'L_AUTHOR' }, detailUrl: 'https://codeup.aliyun.com/org/team/app/change/647',
      } };
    }
    if (url.pathname === `${repo}/commits/${mergeSha}`) {
      return { status: 403, value: { message: 'Current token has no permission to api.' } };
    }
    if (url.pathname === `${repo}/changeRequests/647/diffs/patches`) {
      if (!patchesEnabled) return { status: 404, value: { message: 'Not Found' } };
      return { value: [
        { relatedMergeItemType: 'MERGE_SOURCE', versionNo: 1, commitId: oldHeadSha },
        { relatedMergeItemType: 'MERGE_SOURCE', versionNo: 2, commitId: headSha },
        { relatedMergeItemType: 'MERGE_TARGET', versionNo: 1, commitId: baseSha },
      ] };
    }
    if (url.pathname === `${repo}/compares`) {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from === baseSha && to === headSha) {
        return { value: {
          commits: [{ shortId: headSha.slice(0, 8), title: 'fix: adyen withdrawal', authorName: 'L_AUTHOR' }],
          diffs: [{ oldPath: 'src/withdrawal.vue', newPath: 'src/withdrawal.vue', diff: '@@ -1 +1 @@\n-disabled\n+enabled' }],
        } };
      }
      if (from === `${mergeSha}^1` && to === mergeSha) {
        return { value: {
          commits: [{ shortId: mergeSha.slice(0, 8), title: 'merge: adyen withdrawal', authorName: 'L_AUTHOR' }],
          diffs: [{ oldPath: 'src/fallback.vue', newPath: 'src/fallback.vue', diff: '@@ -1 +1 @@\n-before\n+after' }],
        } };
      }
      return { value: { commits: [], diffs: [] } };
    }
  };
  try {
    await config('yunxiao', { authMode: 'PRIVATE_TOKEN', organizationId: 'org' });
    const task = (await call('/api/tasks', 'POST', { jiraKey: 'CODEUP-2', title: 'Codeup fallback task' })).body.task;

    // 1. Falls back to latest MERGE_TARGET..MERGE_SOURCE from diffs/patches when commits API returns 403
    const viaPatches = await call('/api/connectors/yunxiao/import', 'POST', {
      resource: 'yunxiao_mr', repositoryId: '10001', mrLocalId: '647', taskId: task.id,
    });
    assert.equal(viaPatches.status, 200);
    assert.match(viaPatches.body.asset.content, /## Unified Diff/);
    assert.match(viaPatches.body.asset.content, /src\/withdrawal\.vue/);
    assert.match(viaPatches.body.asset.content, /@@ -1 \+1 @@/);

    // 2. Falls back to mergedRevision^1..mergedRevision when diffs/patches is also unavailable
    patchesEnabled = false;
    const viaParentRef = await call('/api/connectors/yunxiao/import', 'POST', {
      resource: 'yunxiao_mr', repositoryId: '10001', mrLocalId: '647', taskId: task.id,
    });
    assert.equal(viaParentRef.status, 200);
    assert.match(viaParentRef.body.asset.content, /## Unified Diff/);
    assert.match(viaParentRef.body.asset.content, /src\/fallback\.vue/);
    assert.match(viaParentRef.body.asset.content, /@@ -1 \+1 @@/);
  } finally { await f.close(); }
});

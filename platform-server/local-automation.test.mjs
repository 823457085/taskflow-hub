import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectConstitutionFiles } from './local-automation.mjs';
import { createPlatform } from './server.mjs';

const password = 'local-automation-test-passphrase';

function initTempGitRepo(rootDir, name) {
  const repoDir = join(rootDir, name);
  mkdirSync(repoDir, { recursive: true });
  const git = args => execFileSync('git', ['-C', repoDir, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'feature/auto-flow']);
  git(['config', 'user.email', 'dev@example.invalid']);
  git(['config', 'user.name', 'Local Dev']);
  writeFileSync(join(repoDir, 'index.ts'), 'export const version = 1;\n');
  writeFileSync(join(repoDir, 'AGENTS.md'), '# Engineering Constitution\n- Enforce strict TypeScript types.\n');
  git(['add', 'index.ts', 'AGENTS.md']);
  git(['commit', '-m', 'feat: initial business module']);
  return { repoDir, git };
}

test('local automation enforces browser-cookie + same-origin + loopback and rejects bearer or local-device tokens', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tf-auto-sec-'));
  const { repoDir } = initTempGitRepo(tempRoot, 'example-web');
  const app = createPlatform({
    dbPath: ':memory:',
    runsDir: join(tempRoot, 'runs'),
    repoScanRoots: [{ path: tempRoot, maxDepth: 2 }],
    runnerOverride: async () => ({ exitCode: 0, output: 'ok' }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    const loginRes = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    const loginData = await loginRes.json();
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const taskRes = await fetch(base + '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.token}` },
      body: JSON.stringify({ jiraKey: 'AUTO-1', title: 'Security check task' }),
    });
    const task = (await taskRes.json()).task;

    // Bearer token must be rejected for local automation endpoints
    const bearerRepos = await fetch(base + '/api/local-git/repositories', {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(bearerRepos.status, 403);
    assert.equal((await bearerRepos.json()).error.code, 'BROWSER_SESSION_REQUIRED');

    const bearerDoctor = await fetch(base + '/api/local-automation/doctor', {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(bearerDoctor.status, 403);
    assert.equal((await bearerDoctor.json()).error.code, 'BROWSER_SESSION_REQUIRED');

    // Missing Origin on POST with Cookie must be rejected
    const noOriginRun = await fetch(base + `/api/tasks/${task.id}/ai-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mode: 'read', engine: 'codex' }),
    });
    assert.equal(noOriginRun.status, 403);
    assert.equal((await noOriginRun.json()).error.code, 'BROWSER_SESSION_REQUIRED');

    // Cross-origin must be rejected
    const badOriginRun = await fetch(base + `/api/tasks/${task.id}/ai-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.invalid' },
      body: JSON.stringify({ mode: 'read', engine: 'codex' }),
    });
    assert.equal(badOriginRun.status, 403);
    assert.equal((await badOriginRun.json()).error.code, 'ORIGIN_REJECTED');

    // Local device token must be rejected with LOCAL_DEVICE_SCOPE
    const pairRes = await fetch(base + '/api/device-authorizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Test CLI', tool: 'codex-cli' }),
    });
    const pair = await pairRes.json();
    await fetch(base + '/api/device-authorizations/decision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ userCode: pair.userCode, decision: 'APPROVE', projectIds: ['default'] }),
    });
    const devToken = (await (await fetch(base + '/api/device-authorizations/poll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: pair.deviceCode }),
    })).json()).token;

    for (const [method, path, body] of [
      ['GET', '/api/local-automation/doctor'],
      ['GET', '/api/local-git/repositories'],
      ['GET', `/api/tasks/${task.id}/ai-runs`],
      ['POST', `/api/tasks/${task.id}/ai-runs`, { mode: 'read', engine: 'codex' }],
      ['POST', `/api/tasks/${task.id}/assets/from-git`, {}],
      ['POST', '/api/local-git/open', { projectId: 'default', app: 'cursor', repoPath: repoDir }],
    ]) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}), Cookie: `taskflow_session=${devToken}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, 'LOCAL_DEVICE_SCOPE');
    }
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('full local automation flow: repo scan, open app, git diff CODE capture, Jira-as-PRD import, 1-click AI develop & review draft/submit', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tf-auto-flow-'));
  const { repoDir, git } = initTempGitRepo(tempRoot, 'example-web');
  const openedApps = [];
  let slowCancelSignal = null;
  const capturedReviewPrompts = [];

  // Mock loopback Jira server for testing Jira-as-PRD asset import
  const jiraServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/rest/api/2/myself') {
      res.end(JSON.stringify({ accountId: 'u-1', displayName: 'Jira Bot', active: true }));
      return;
    }
    if (req.url?.startsWith('/rest/api/2/issue/DEMO-778')) {
      res.end(JSON.stringify({
        id: '10778',
        key: 'DEMO-778',
        fields: {
          summary: '通知设置功能需求',
          description: '支持用户选择接收哪些通知。',
          status: { name: '进行中' },
          issuetype: { id: '1', name: 'Story' },
          project: { id: '200', key: 'DEFAULT', name: '默认项目' },
          updated: '2026-11-14T00:00:00.000+0800',
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise(resolve => jiraServer.listen(0, '127.0.0.1', resolve));
  const jiraBase = `http://127.0.0.1:${jiraServer.address().port}`;

  const app = createPlatform({
    dbPath: ':memory:',
    allowConnectorLoopbackHttp: true,
    runsDir: join(tempRoot, 'runs'),
    repoScanRoots: [{ path: tempRoot, maxDepth: 2 }],
    appOpener: async info => { openedApps.push(info); },
    runnerOverride: async ({ mode, repoPath, prompt, appendOutput, signal, customInstruction }) => {
      if (customInstruction === 'WAIT_FOR_STOP') {
        slowCancelSignal = signal;
        await new Promise(resolve => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        return { exitCode: 130, output: 'aborted' };
      }
      if (mode === 'read') {
        appendOutput('正在读取任务与材料快照...\n');
        return { exitCode: 0, output: '任务分析完成：核心改动在 example-web 通知模块。' };
      }
      if (mode === 'develop') {
        appendOutput('正在修改业务仓库文件...\n');
        writeFileSync(join(repoPath, 'notifications.ts'), 'export const notificationsEnabled = true;\n');
        execFileSync('git', ['-C', repoPath, 'add', 'notifications.ts'], { stdio: 'pipe' });
        execFileSync('git', ['-C', repoPath, 'commit', '-m', 'feat: add notifications config toggle'], { stdio: 'pipe' });
        return { exitCode: 0, output: '已完成 notifications.ts 开发并提交本地 Commit。' };
      }
      if (mode === 'review') {
        capturedReviewPrompts.push(prompt);
        return {
          exitCode: 0,
          output: [
            '已完成代码与技术方案一致性审查。',
            '```taskflow-review-draft',
            JSON.stringify({
              summary: '代码改动与需求、技术方案一致，边界校验清晰。',
              evidence: '已核对 notifications.ts 与 DEMO-778 PRD 版本 r1',
              findings: [
                { severity: 'INFO', title: '建议补充枚举注释', detail: '可在配置常量旁补充单位说明', location: 'notifications.ts:1' },
              ],
            }, null, 2),
            '```',
          ].join('\n'),
        };
      }
      return { exitCode: 0, output: 'done' };
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const browserCall = async (cookie, path, { method = 'GET', body, expectStatus = 200 } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(method !== 'GET' ? { Origin: base } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = res.status === 204 ? null : await res.json();
    assert.equal(res.status, expectStatus, `${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
    return data;
  };

  const waitForRun = async (cookie, _taskId, runId) => {
    for (let i = 0; i < 40; i++) {
      const { run: found } = await browserCall(cookie, `/api/ai-runs/${runId}`);
      if (found && found.status !== 'RUNNING') return found;
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('Timed out waiting for AI run');
  };

  try {
    await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead_admin', password }) });
    const adminLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lead_admin', password }) });
    const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];

    await browserCall(adminCookie, '/api/users', { method: 'POST', body: { username: 'dev_worker', password, role: 'DEV' }, expectStatus: 201 });
    await browserCall(adminCookie, '/api/users', { method: 'POST', body: { username: 'qa_member', password, role: 'QA' }, expectStatus: 201 });
    const devLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dev_worker', password }) });
    const devCookie = devLogin.headers.get('set-cookie').split(';')[0];
    const qaLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'qa_member', password }) });
    const qaCookie = qaLogin.headers.get('set-cookie').split(';')[0];

    // 1. Capabilities, Online Doctor & Local Git Repository Discovery
    const caps = await browserCall(devCookie, '/api/local-automation/capabilities');
    assert.equal(caps.supported, true);
    assert.equal(caps.engines.length, 4);

    // Doctor before binding workspace or authorizing device session -> 80/100 WARN (4 PASS + 2 WARN)
    const initialDoctor = await browserCall(devCookie, '/api/local-automation/doctor');
    assert.equal(initialDoctor.checks.length, 6);
    assert.equal(initialDoctor.overall, 'WARN');
    assert.equal(initialDoctor.score, 80);
    assert.equal(initialDoctor.checks.find(c => c.id === 'sqlite_storage')?.status, 'PASS');
    assert.equal(initialDoctor.checks.find(c => c.id === 'runs_sandbox')?.status, 'PASS');
    assert.equal(initialDoctor.checks.find(c => c.id === 'git_toolchain')?.status, 'PASS');
    assert.equal(initialDoctor.checks.find(c => c.id === 'ai_engines')?.status, 'PASS');
    assert.equal(initialDoctor.checks.find(c => c.id === 'device_sessions')?.status, 'WARN');
    assert.equal(initialDoctor.checks.find(c => c.id === 'bound_workspaces')?.status, 'WARN');

    const repoList = await browserCall(devCookie, '/api/local-git/repositories');
    assert.ok(repoList.repositories.some(r => r.name === 'example-web' && r.path === repoDir));

    // Newly cloned repo on disk is served from 15s scan cache until ?refresh=1 forces an immediate rescan
    const lateRepoDir = join(tempRoot, 'late-cloned-service');
    mkdirSync(join(lateRepoDir, '.git'), { recursive: true });
    const cachedRepoList = await browserCall(devCookie, '/api/local-git/repositories');
    assert.equal(cachedRepoList.repositories.some(r => r.name === 'late-cloned-service'), false);
    const refreshedRepoList = await browserCall(devCookie, '/api/local-git/repositories?refresh=1');
    assert.equal(refreshedRepoList.repositories.some(r => r.name === 'late-cloned-service' && r.path === lateRepoDir), true);

    // Bind project workspace & open in Cursor
    await browserCall(devCookie, '/api/projects/default/workspace', {
      method: 'PUT', body: { repoPath: repoDir, defaultTarget: 'workbench' },
    });
    const gitStatus = await browserCall(devCookie, '/api/projects/default/git-status');
    assert.equal(gitStatus.accessible, true);
    assert.equal(gitStatus.branch, 'feature/auto-flow');
    assert.equal(gitStatus.dirtyCount, 0);
    assert.deepEqual(gitStatus.constitutionFiles, ['AGENTS.md']);

    // Issue a local device session for dev_worker and re-run Doctor -> 100/100 HEALTHY with zero secret leakage
    const devPair = await (await fetch(base + '/api/device-authorizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Dev MacBook', tool: 'codex-cli' }),
    })).json();
    await browserCall(devCookie, '/api/device-authorizations/decision', {
      method: 'POST', body: { userCode: devPair.userCode, decision: 'APPROVE', projectIds: ['default'] },
    });
    const polledDevice = await (await fetch(base + '/api/device-authorizations/poll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: devPair.deviceCode }),
    })).json();
    assert.ok(polledDevice.token);

    const healthyDoctor = await browserCall(devCookie, '/api/local-automation/doctor');
    assert.equal(healthyDoctor.overall, 'HEALTHY');
    assert.equal(healthyDoctor.score, 100);
    assert.ok(healthyDoctor.checks.every(c => c.status === 'PASS'));
    assert.match(healthyDoctor.checks.find(c => c.id === 'bound_workspaces')?.summary || '', /工程规范文件/);
    const serializedDoctor = JSON.stringify(healthyDoctor);
    assert.equal(serializedDoctor.includes(polledDevice.token), false);
    assert.equal(serializedDoctor.includes('token_hash'), false);

    await browserCall(devCookie, '/api/local-git/open', {
      method: 'POST', body: { projectId: 'default', app: 'cursor' },
    });
    assert.equal(openedApps.length, 1);
    assert.equal(openedApps[0].app, 'cursor');
    assert.equal(openedApps[0].repoPath, repoDir);

    // 2. Create unassigned task & import Jira issue DEMO-778 directly as PRD asset
    const createdTask = (await browserCall(adminCookie, '/api/tasks', {
      method: 'POST', body: { jiraKey: 'DEMO-799', title: '前端通知配置', assigneeId: null }, expectStatus: 201,
    })).task;
    assert.equal(createdTask.assigneeId, null);

    await browserCall(adminCookie, '/api/connectors/jira/config', {
      method: 'POST', body: { projectId: 'default', baseUrl: jiraBase, authMode: 'BEARER', token: 'mock-jira-token' },
    });
    const jiraAssetRes = await browserCall(adminCookie, '/api/connectors/jira/import', {
      method: 'POST',
      body: { projectId: 'default', taskId: createdTask.id, resource: 'jira_issue', issueKey: 'DEMO-778', asAsset: true, kind: 'PRD' },
    });
    assert.equal(jiraAssetRes.imported, true);
    assert.equal(jiraAssetRes.asset.kind, 'PRD');
    assert.match(jiraAssetRes.asset.content, /通知设置功能需求/);

    // Add TECH_SPEC asset
    await browserCall(devCookie, `/api/tasks/${createdTask.id}/assets`, {
      method: 'POST', body: { kind: 'TECH_SPEC', title: '前端技术方案', content: '新增 notificationsEnabled 配置开关与表单校验。' }, expectStatus: 201,
    });

    // 3. 1-Click AI Read Analysis
    const readStart = await browserCall(devCookie, `/api/tasks/${createdTask.id}/ai-runs`, {
      method: 'POST', body: { mode: 'read', engine: 'codex' }, expectStatus: 201,
    });
    const readDone = await waitForRun(devCookie, createdTask.id, readStart.run.id);
    assert.equal(readDone.status, 'SUCCEEDED');
    assert.match(readDone.output, /任务分析完成/);

    // 4. 1-Click AI Develop with autoClaim: claims task, edits repo, commits, and syncs progress automatically!
    const devStart = await browserCall(devCookie, `/api/tasks/${createdTask.id}/ai-runs`, {
      method: 'POST', body: { mode: 'develop', engine: 'antigravity', autoClaim: true }, expectStatus: 201,
    });
    assert.equal(devStart.task.status, 'IN_PROGRESS');
    const devDone = await waitForRun(devCookie, createdTask.id, devStart.run.id);
    assert.equal(devDone.status, 'SUCCEEDED');

    const ctxAfterDev = await browserCall(devCookie, `/api/tasks/${createdTask.id}/context`);
    assert.ok(ctxAfterDev.progressEvents.some(e => e.summary.includes('add notifications config toggle')));

    // 5. 1-Click Local Git Diff / Commit -> CODE asset extraction (and QA role forbidden check)
    await browserCall(qaCookie, `/api/tasks/${createdTask.id}/assets/from-git`, {
      method: 'POST', body: { repoPath: repoDir }, expectStatus: 403,
    });

    // Modify working tree to test working diff extraction
    writeFileSync(join(repoDir, 'notifications.ts'), 'export const notificationsEnabled = true;\nexport const maxRetry = 3;\n');
    const gitCapture = await browserCall(devCookie, `/api/tasks/${createdTask.id}/assets/from-git`, {
      method: 'POST', body: { source: 'auto' }, expectStatus: 201,
    });
    assert.equal(gitCapture.asset.kind, 'CODE');
    assert.equal(gitCapture.usedMode, 'working');
    assert.match(gitCapture.asset.content, /maxRetry = 3/);
    // Commit working tree cleanly
    git(['add', 'notifications.ts']);
    git(['commit', '-m', 'feat: add maxRetry']);

    // 6. Register a project policy plugin, then run 1-Click AI Review with autoCreateReview + autoSubmitReport!
    await browserCall(adminCookie, '/api/plugins', {
      method: 'POST',
      body: {
        projectId: 'default',
        id: 'idempotency-contract-guard',
        name: '接口幂等与向下兼容契约核验',
        version: '1.0.0',
        stages: ['TECH_SPEC', 'CODE_REVIEW'],
      },
      expectStatus: 201,
    });

    const reviewStart = await browserCall(devCookie, `/api/tasks/${createdTask.id}/ai-runs`, {
      method: 'POST', body: { mode: 'review', engine: 'codex', stage: 'CODE_REVIEW', autoSubmitReport: true }, expectStatus: 201,
    });
    assert.ok(reviewStart.job?.id);
    assert.equal(reviewStart.job.snapshot.plugins.length, 1);
    assert.equal(reviewStart.job.snapshot.plugins[0].id, 'idempotency-contract-guard');
    const reviewDone = await waitForRun(devCookie, createdTask.id, reviewStart.run.id);
    assert.equal(reviewDone.status, 'SUCCEEDED');
    assert.equal(reviewDone.draft.autoSubmitted, true);
    assert.equal(reviewDone.draft.findings.length, 1);
    assert.equal(capturedReviewPrompts.length, 1);
    assert.match(capturedReviewPrompts[0], /接口幂等与向下兼容契约核验 \[idempotency-contract-guard@1\.0\.0\]/);

    const submittedJob = (await browserCall(adminCookie, `/api/jobs/${reviewStart.job.id}`)).job;
    assert.equal(submittedJob.status, 'REPORT_SUBMITTED');
    assert.equal(submittedJob.report.source, 'LOCAL_TOOL');
    assert.equal(submittedJob.findings.length, 1);

    // Same dev cannot approve their own report/assigned work
    await browserCall(devCookie, `/api/jobs/${reviewStart.job.id}/decision`, {
      method: 'POST', body: { decision: 'APPROVE', reason: 'self approve attempt' }, expectStatus: 403,
    });
    // Independent admin approves!
    const approvedJob = (await browserCall(adminCookie, `/api/jobs/${reviewStart.job.id}/decision`, {
      method: 'POST', body: { decision: 'APPROVE', reason: '独立代码审查核验通过' }, expectStatus: 201,
    })).job;
    assert.equal(approvedJob.status, 'APPROVED');

    const existingJob = (await browserCall(devCookie, '/api/reviews', {
      method: 'POST', body: { taskId: createdTask.id, stage: 'TECH_SPEC', executionMode: 'LOCAL_REPORT' }, expectStatus: 201,
    })).job;
    const existingReviewBody = { mode: 'review', engine: 'codex', jobId: existingJob.id };
    await browserCall(qaCookie, `/api/tasks/${createdTask.id}/ai-runs`, {
      method: 'POST', body: existingReviewBody, expectStatus: 403,
    });
    const resumedReview = await browserCall(devCookie, `/api/tasks/${createdTask.id}/ai-runs`, {
      method: 'POST', body: existingReviewBody, expectStatus: 201,
    });
    assert.equal(resumedReview.run.jobId, existingJob.id);
    assert.equal((await waitForRun(devCookie, createdTask.id, resumedReview.run.id)).status, 'SUCCEEDED');
    assert.equal((await browserCall(devCookie, `/api/jobs/${existingJob.id}`)).job.report, null);

    // 7. Stop running AI task + verify GET /api/ai-runs/:id security & 404 semantics
    await browserCall(devCookie, '/api/ai-runs/non-existent-run-id', { expectStatus: 404 });
    const bearerLogin = await (await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dev_worker', password }),
    })).json();
    const bearerRunAttempt = await fetch(`${base}/api/ai-runs/${readStart.run.id}`, {
      headers: { Authorization: `Bearer ${bearerLogin.token}` },
    });
    assert.equal(bearerRunAttempt.status, 403, 'Bearer token must not read browser-only local AI runs');

    const stopStart = await browserCall(devCookie, `/api/tasks/${createdTask.id}/ai-runs`, {
      method: 'POST', body: { mode: 'read', engine: 'codex', customInstruction: 'WAIT_FOR_STOP' }, expectStatus: 201,
    });
    const stopped = await browserCall(devCookie, `/api/ai-runs/${stopStart.run.id}/stop`, {
      method: 'POST', body: {},
    });
    assert.equal(stopped.run.status, 'CANCELLED');
    assert.equal(slowCancelSignal?.aborted, true);
  } finally {
    await app.close();
    await new Promise(resolve => jiraServer.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('detectConstitutionFiles discovers repo spec/constitution files and rejects symlinks', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tf-constitution-'));
  try {
    mkdirSync(join(tempRoot, '.github'), { recursive: true });
    writeFileSync(join(tempRoot, 'AGENTS.md'), '# Agents\n');
    writeFileSync(join(tempRoot, '.github', 'copilot-instructions.md'), '# Copilot\n');
    const externalTarget = join(tempRoot, 'outside.txt');
    writeFileSync(externalTarget, 'secret');
    symlinkSync(externalTarget, join(tempRoot, 'CLAUDE.md'));

    const found = detectConstitutionFiles(tempRoot);
    assert.deepEqual(found, ['AGENTS.md', '.github/copilot-instructions.md']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

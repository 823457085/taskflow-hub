import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createPlatform } from '../platform-server/server.mjs';
import { buildCompanionSyncCommand, buildLocalTaskPrompt, localReviewCandidates } from '../preview-app/src/views/localTaskWorkflowPrompt.ts';

const task = Object.freeze({ id: 'task-a', projectId: 'project-a', jiraKey: 'SAMPLE-562', title: 'L_TASK_TITLE', status: 'IN_PROGRESS', version: 4 });
const job = Object.freeze({ id: 'job-a', taskId: task.id, projectId: task.projectId, stage: 'CODE_REVIEW', executionMode: 'LOCAL_REPORT', status: 'AWAITING_REPORT', stale: false, report: null, decision: null, inputHash: 'snapshot-hash', snapshot: { secretDocumentBody: 'DO_NOT_COPY_DOCUMENT_OR_CODE' } });
const access = { frozen: false, allowedStages: ['CODE_REVIEW'] };
const draft = (patch = {}) => ({ task, jobs: [job], mode: 'read', target: 'workbench', canDevelop: true, selectedJobId: job.id, ...access, ...patch });

test('local review selection is scoped to the exact task/project, role grant and current report state', () => {
  const rejected = [
    { taskId: 'task-b' }, { projectId: 'project-b' }, { executionMode: 'HUMAN_REVIEW' }, { executionMode: 'CLOUD_AI' },
    { status: 'REPORT_SUBMITTED' }, { stale: true }, { stale: undefined }, { report: { id: 'report-a' } }, { decision: { id: 'decision-a' } }, { id: '../job' },
  ].map((patch, index) => ({ ...job, id: 'invalid-' + index, ...patch }));
  const input = Object.freeze([job, ...rejected]);
  assert.deepEqual(localReviewCandidates(task, input, access).map(item => item.id), [job.id]);
  assert.deepEqual(localReviewCandidates(task, [job], { ...access, allowedStages: [] }), []);
  assert.deepEqual(localReviewCandidates(task, [job], { ...access, frozen: true }), []);
  assert.deepEqual(localReviewCandidates({ ...task, status: 'DONE' }, [job], access), []);
  assert.equal(input.length, rejected.length + 1);
});

test('frozen or unauthorized tasks only allow read instructions and invalid review selections fail closed', () => {
  assert.ok(buildLocalTaskPrompt(draft({ frozen: true })).includes(task.id));
  for (const mode of ['develop', 'review']) assert.throws(() => buildLocalTaskPrompt(draft({ mode, frozen: true })), /冻结/);
  assert.throws(() => buildLocalTaskPrompt(draft({ mode: 'develop', canDevelop: false })), /权限/);
  for (const patch of [{ jobs: [] }, { selectedJobId: 'different' }, { allowedStages: [] }, { jobs: [{ ...job, stale: true }] }, { jobs: [{ ...job, taskId: 'task-b' }] }]) assert.throws(() => buildLocalTaskPrompt(draft({ mode: 'review', ...patch })), /重新选择/);
  assert.throws(() => buildLocalTaskPrompt(draft({ task: { ...task, id: 'task\nother' } })), /任务信息/);
});

test('copied instructions bind metadata only and require actual context instead of implicit writes', () => {
  const read = buildLocalTaskPrompt(draft());
  const develop = buildLocalTaskPrompt(draft({ mode: 'develop' }));
  const review = buildLocalTaskPrompt(draft({ mode: 'review' }));
  for (const prompt of [read, develop, review]) {
    assert.ok(prompt.includes(task.id)); assert.ok(prompt.includes(task.jiraKey)); assert.ok(prompt.includes(task.projectId));
    assert.ok(prompt.includes('context')); assert.ok(!prompt.includes('DO_NOT_COPY_DOCUMENT_OR_CODE')); assert.ok(!prompt.includes('L_TASK_TITLE'));
    assert.ok(!/task_claim\s*\(|progress_report\s*\(|heartbeat\s*\(|report_submit\s*\(/.test(prompt));
  }
  assert.ok(read.includes('本次只查看任务')); assert.ok(read.includes('不要修改文件'));
  assert.ok(develop.includes('真实业务仓库')); assert.ok(develop.includes('不要默认在 TaskFlow 平台工程中开发')); assert.ok(develop.includes('等我另行明确要求'));
  assert.ok(review.includes(job.id)); assert.ok(review.includes(job.inputHash)); assert.ok(review.includes('review_context')); assert.ok(review.includes('评审草稿')); assert.ok(review.includes('只有我后续明确要求提交')); assert.ok(review.includes('本次不要提交'));
});

test('only installed Codex targets request the shared Skill; other clients use their MCP without assuming Skill installation', () => {
  for (const target of ['workbench', 'codex']) assert.ok(buildLocalTaskPrompt(draft({ target })).startsWith('使用 $taskflow-bridge。'));
  const agyPrompt = buildLocalTaskPrompt(draft({ target: 'antigravity' }));
  assert.ok(agyPrompt.startsWith('使用已安装的 taskflow-bridge 技能与当前已启用的 taskflow MCP。'));
  for (const target of ['claude', 'cursor']) {
    const prompt = buildLocalTaskPrompt(draft({ target }));
    assert.ok(!prompt.includes('$taskflow-bridge')); assert.ok(prompt.includes('taskflow MCP'));
  }
  assert.throws(() => buildLocalTaskPrompt(draft({ target: 'unregistered-tool' })), /任务信息/);
});

test('bound project repository paths and companion sync commands validate input and embed cleanly', () => {
  const boundDevelop = buildLocalTaskPrompt(draft({ mode: 'develop', target: 'antigravity', repoPath: '/Users/demo/workspace/sample-service/' }));
  assert.ok(boundDevelop.includes('"/Users/demo/workspace/sample-service"'));
  assert.ok(boundDevelop.includes('已绑定的真实业务仓库（/Users/demo/workspace/sample-service）'));
  for (const bad of ['relative/path', '/Users/demo/../escape', '/Users/demo/.git/hooks', '/Users/demo/line\nbreak']) {
    assert.throws(() => buildLocalTaskPrompt(draft({ mode: 'develop', repoPath: bad })), /目录/);
  }
  assert.equal(buildCompanionSyncCommand({ jiraKey: 'SAMPLE-562', target: 'antigravity', repoPath: '/Users/demo/sample' }), "taskflow-hub start --task 'SAMPLE-562' --tool custom --repo '/Users/demo/sample'");
  assert.equal(buildCompanionSyncCommand({ jiraKey: 'SAMPLE-562', target: 'codex' }), "taskflow-hub start --task 'SAMPLE-562' --tool codex-cli");
});

test('real platform review responses remain eligible only while their exact input is current and no report is submitted', async t => {
  const app = createPlatform({ dbPath: ':memory:', connectorKey: randomBytes(32), connectorProfiles: {}, logger: { error() {} } });
  t.after(() => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let token;
  const request = async (method, path, body, expected = 200) => {
    const response = await fetch(origin + path, { method, headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status}, code ${result?.error?.code || 'none'}`);
    return result;
  };
  const username = 'workflow-contract-' + randomBytes(6).toString('hex');
  const password = randomBytes(32).toString('base64url');
  await request('POST', '/api/setup', { username, password }, 201);
  token = (await request('POST', '/api/login', { username, password })).token;
  assert.ok(typeof token === 'string', 'Isolated platform must issue a fixture session');
  const created = (await request('POST', '/api/tasks', { jiraKey: 'CONTRACT-1', title: 'L_LOCAL_WORKFLOW_CONTRACT' }, 201)).task;
  const taskPath = `/api/tasks/${created.id}`;
  const addAsset = async (kind, content) => (await request('POST', taskPath + '/assets', {
    kind, logicalKey: 'contract-' + kind, title: 'L_' + kind, content,
  }, 201)).asset;
  for (const kind of ['PRD', 'TECH_SPEC', 'CODE']) await addAsset(kind, `MEMORY_ONLY_ASSET_CONTENT_${kind}`);
  const newReview = async () => (await request('POST', '/api/reviews', {
    taskId: created.id, stage: 'CODE_REVIEW', executionMode: 'LOCAL_REPORT',
  }, 201)).job;
  const initial = await newReview();
  const actualTask = (await request('GET', taskPath)).task;
  const actualJobs = (await request('GET', '/api/jobs?taskId=' + created.id)).jobs;
  assert.deepEqual(localReviewCandidates(actualTask, actualJobs, access).map(item => item.id), [initial.id]);
  const prompt = buildLocalTaskPrompt({ task: actualTask, jobs: actualJobs, mode: 'review', target: 'workbench', selectedJobId: initial.id, canDevelop: true, ...access });
  for (const id of [actualTask.id, actualTask.projectId, initial.id, initial.inputHash]) assert.ok(prompt.includes(id));
  assert.ok(!prompt.includes('MEMORY_ONLY_ASSET_CONTENT'), 'Copied prompt must not embed source documents or code');

  const changed = await addAsset('CODE', 'MEMORY_ONLY_CHANGED_CODE');
  assert.equal(changed.revision, 2);
  const stale = (await request('GET', '/api/jobs/' + initial.id)).job;
  assert.equal(stale.stale, true);
  assert.deepEqual(localReviewCandidates(actualTask, [stale], access), []);
  assert.throws(() => buildLocalTaskPrompt({ task: actualTask, jobs: [stale], mode: 'review', target: 'workbench', selectedJobId: stale.id, canDevelop: true, ...access }), /重新选择/);

  const fresh = await newReview();
  assert.notEqual(fresh.id, initial.id); assert.equal(fresh.stale, false);
  assert.deepEqual(localReviewCandidates(actualTask, [stale, fresh], access).map(item => item.id), [fresh.id]);
  await request('POST', `/api/jobs/${fresh.id}/report`, {
    source: 'LOCAL_TOOL', tool: 'codex-cli', summary: 'L_MEMORY_ONLY_REVIEW_REPORT', findings: [],
  }, 201);
  const submitted = (await request('GET', '/api/jobs/' + fresh.id)).job;
  assert.equal(submitted.status, 'REPORT_SUBMITTED'); assert.equal(submitted.stale, false);
  assert.equal(submitted.report.source, 'LOCAL_TOOL'); assert.equal(submitted.decision, null);
  assert.deepEqual(localReviewCandidates(actualTask, [submitted], access), []);
});

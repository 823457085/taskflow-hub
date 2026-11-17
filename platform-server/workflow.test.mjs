import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlatform } from './server.mjs';
import { createWorkflow } from './workflow.mjs';
const password = 'local-only-workflow-test-passphrase';
async function fixture(dbPath = ':memory:') {
  const app = createPlatform({ dbPath }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, method = 'GET', body, token) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
  const expect = async (path, method, body, token, status = 200) => { const result = await call(path, method, body, token); assert.equal(result.status, status, `${path}: ${JSON.stringify(result.data)}`); return result.data; };
  const login = async username => (await expect('/api/login', 'POST', { username, password })).token;
  return { app, call, expect, login };
}
async function accounts(f) {
  await f.expect('/api/setup', 'POST', { username: 'administrator', password }, undefined, 201);
  const admin = { token: await f.login('administrator') };
  admin.id = (await f.expect('/api/me', 'GET', undefined, admin.token)).user.id;
  const users = { ADMIN: admin };
  for (const [username, role] of [['developer', 'DEV'], ['leader', 'LEAD'], ['operations', 'SRE']]) {
    const { user } = await f.expect('/api/users', 'POST', { username, password, role }, admin.token, 201);
    users[role] = { ...user, token: await f.login(username) };
  }
  return users;
}
test('project isolation, assignees, claims, concurrent versions and scoped audit', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, DEV: dev, LEAD: lead } = await accounts(f);
    const project = (await f.expect('/api/projects', 'POST', { key: 'PRIVATE', name: 'Restricted project' }, admin.token, 201)).project;
    const outsider = (await f.expect('/api/users', 'POST', { username: 'outsider', password, role: 'LEAD', projectId: project.id }, admin.token, 201)).user;
    const outsiderToken = await f.login('outsider');
    const hidden = (await f.expect('/api/tasks', 'POST', { projectId: project.id, jiraKey: 'SEC-1', title: 'Private work' }, outsiderToken, 201)).task;
    const hiddenJob = (await f.expect('/api/reviews', 'POST', { taskId: hidden.id, stage: 'CODE_REVIEW' }, outsiderToken, 201)).job;
    for (const suffix of ['', '/context', '/assets', '/gates']) await f.expect(`/api/tasks/${hidden.id}${suffix}`, 'GET', undefined, dev.token, 403);
    for (const suffix of ['/progress', '/claim', '/heartbeat']) await f.expect(`/api/tasks/${hidden.id}${suffix}`, 'POST', {}, dev.token, 403);
    await f.expect(`/api/jobs/${hiddenJob.id}`, 'GET', undefined, dev.token, 403);
    await f.expect(`/api/jobs/${hiddenJob.id}/report`, 'POST', {}, dev.token, 403);
    await f.expect(`/api/jobs?projectId=${project.id}`, 'GET', undefined, dev.token, 403);
    await f.expect(`/api/audit?projectId=${project.id}`, 'GET', undefined, lead.token, 403);
    assert.ok(!(await f.expect('/api/tasks', 'GET', undefined, dev.token)).tasks.some(task => task.id === hidden.id));
    assert.ok(!(await f.expect('/api/jobs', 'GET', undefined, dev.token)).jobs.some(job => job.id === hiddenJob.id));
    assert.deepEqual((await f.expect('/api/projects', 'GET', undefined, outsiderToken)).projects.map(item => item.id), [project.id]);
    await f.expect('/api/projects/default/members', 'POST', { userId: dev.id, role: 'ADMIN' }, lead.token, 400);
    const task = (await f.expect('/api/tasks', 'POST', { jiraKey: 'TASK-1', title: 'Assigned work', assigneeId: dev.id }, admin.token, 201)).task;
    assert.equal(task.ownerId, admin.id); assert.equal(task.assigneeId, dev.id);
    await f.expect('/api/tasks', 'POST', { jiraKey: 'TASK-2', title: 'Forbidden assignment', assigneeId: lead.id }, dev.token, 403);
    await f.expect('/api/tasks', 'POST', { jiraKey: 'TASK-3', title: 'Foreign member', assigneeId: outsider.id }, admin.token, 400);
    const writes = await Promise.all([f.call(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'First title' }, dev.token), f.call(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Second title' }, dev.token)]);
    assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
    const free = (await f.expect('/api/tasks', 'POST', { jiraKey: 'TASK-4', title: 'Claimable work', assigneeId: null }, admin.token, 201)).task;
    const claimed = (await f.expect(`/api/tasks/${free.id}/claim`, 'POST', { expectedVersion: free.version }, dev.token)).task;
    assert.equal(claimed.assigneeId, dev.id); assert.equal(claimed.status, 'IN_PROGRESS');
    await f.expect(`/api/tasks/${free.id}/claim`, 'POST', { expectedVersion: free.version }, dev.token, 409);
    await f.expect(`/api/tasks/${free.id}/claim`, 'POST', { expectedVersion: claimed.version }, lead.token, 409);
    const progress = (await f.expect(`/api/tasks/${task.id}/progress`, 'POST', { tool: 'codex-cli', deviceId: 'device-1', progress: 35, summary: '  L001 original  ', actorId: outsider.id }, dev.token, 201)).progress;
    assert.equal(progress.actorId, dev.id); assert.equal(progress.summary, '  L001 original  ');
    await f.expect(`/api/tasks/${task.id}/heartbeat`, 'POST', { deviceId: 'device-1', tool: 'codex-cli', status: 'WORKING', receivedAt: '2099-01-01' }, dev.token);
    f.app.db.prepare("UPDATE devices SET last_seen='2000-01-01T00:00:00.000Z' WHERE task_id=?").run(task.id);
    const context = await f.expect(`/api/tasks/${task.id}/context`, 'GET', undefined, lead.token);
    assert.equal(context.devices[0].online, false); assert.equal(context.devices[0].status, 'OFFLINE'); assert.equal(context.progressEvents.length, 1);
    const child = (await f.expect('/api/tasks', 'POST', { jiraKey: 'TASK-5', title: 'Legacy child', parentId: task.id, assigneeId: dev.id }, admin.token, 201)).task;
    f.app.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(task.id);
    await f.expect(`/api/tasks/${child.id}`, 'PATCH', { expectedVersion: child.version, title: 'Cannot change under DONE parent' }, dev.token, 409);
    await f.expect(`/api/tasks/${child.id}/claim`, 'POST', { expectedVersion: child.version }, dev.token, 409);
    await f.expect(`/api/tasks/${child.id}/assets`, 'POST', { kind: 'CODE', title: 'Blocked child input', content: 'new code' }, dev.token, 409);
    await f.expect('/api/tasks', 'POST', { jiraKey: 'TASK-6', title: 'Cannot append descendant', parentId: child.id }, admin.token, 409);
    f.app.db.prepare("UPDATE tasks SET status='OPEN' WHERE id=?").run(task.id);
    const audit = (await f.expect('/api/audit?projectId=default', 'GET', undefined, lead.token)).audit;
    assert.ok(audit.every(item => item.projectId === 'default'));
  } finally { await f.app.close(); }
});
test('immutable reports, independent approvals, stage invalidation, frozen DONE and new delivery cycle', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, DEV: dev, LEAD: lead, SRE: sre } = await accounts(f);
    let task = (await f.expect('/api/tasks', 'POST', { jiraKey: 'FLOW-1', title: 'Versioned delivery', assigneeId: dev.id }, admin.token, 201)).task;
    const taskPath = `/api/tasks/${task.id}`;
    const addAsset = async (kind, content, extras = {}) => (await f.expect(`${taskPath}/assets`, 'POST', { kind, title: `${kind} source`, content, ...extras }, admin.token, 201)).asset;
    const newReview = async (stage, mode = 'HUMAN_REVIEW') => (await f.expect('/api/reviews', 'POST', { taskId: task.id, stage, executionMode: mode }, admin.token, 201)).job;
    const report = async (job, findings = [], mode = 'MANUAL') => (await f.expect(`/api/jobs/${job.id}/report`, 'POST', { summary: '  Original L002 report  ', source: mode, ...(mode === 'LOCAL_TOOL' ? { tool: 'codex-cli' } : {}), findings, actorId: 'forged', evidence: '  exact evidence\n' }, admin.token, 201)).job;
    const approve = async job => (await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Independent review of versioned inputs' }, job.stage === 'RELEASE' ? sre.token : lead.token, 201)).job;
    await f.expect('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'HUMAN_REVIEW' }, admin.token, 409);
    const cloud = await newReview('CODE_REVIEW', 'CLOUD_AI');
    await f.expect(`/api/jobs/${cloud.id}/report`, 'POST', { summary: 'No AI executed', source: 'MANUAL', findings: [] }, admin.token, 409);
    for (const kind of ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN']) await addAsset(kind, `  Original ${kind} L003\n`);
    await f.expect(`${taskPath}/assets`, 'POST', { kind: 'CODE', title: 'Credential URL', content: 'source', sourceUrl: 'https://user:password@example.invalid/source' }, admin.token, 400);
    await f.expect(`${taskPath}/assets`, 'POST', { kind: 'PRD', title: 'Unauthorized source', content: 'source' }, dev.token, 403);
    const prematureRelease = await newReview('RELEASE'); await report(prematureRelease);
    await f.expect(`/api/jobs/${prematureRelease.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Prerequisites are incomplete' }, sre.token, 409);
    const jobs = {};
    for (const stage of ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE']) {
      const job = await newReview(stage, stage === 'CODE_REVIEW' ? 'LOCAL_REPORT' : 'HUMAN_REVIEW');
      const findings = stage === 'CODE_REVIEW' ? [{ severity: 'CRITICAL', title: 'Contract mismatch', detail: 'L004 original detail', location: 'source.ts:10' }] : stage === 'TEST_CASE' ? [{ severity: 'WARN', title: 'Coverage note', detail: 'Check boundary' }] : [];
      const reported = await report(job, findings, stage === 'CODE_REVIEW' ? 'LOCAL_TOOL' : 'MANUAL');
      assert.equal(reported.report.actorId, admin.id); assert.equal(reported.report.summary, '  Original L002 report  '); assert.equal(reported.executor, 'UNCONFIGURED');
      await f.expect(`/api/jobs/${job.id}/report`, 'POST', { summary: 'Overwrite', source: 'MANUAL', findings: [] }, admin.token, 409);
      await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Own report' }, admin.token, 403);
      if (stage === 'CODE_REVIEW') {
        await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Blocked critical' }, lead.token, 409);
        await f.expect(`/api/jobs/${job.id}/findings/${reported.findings[0].id}/waiver`, 'POST', { reason: 'Self waiver' }, admin.token, 403);
        await f.expect(`/api/jobs/${job.id}/findings/${reported.findings[0].id}/waiver`, 'POST', { reason: 'Validated serializer evidence' }, lead.token, 201);
      }
      if (stage === 'TEST_CASE') await f.expect(`/api/jobs/${job.id}/findings/${reported.findings[0].id}/waiver`, 'POST', { reason: 'Forbidden stage' }, lead.token, 403);
      jobs[stage] = await approve(job);
      await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'REQUEST_CHANGES', reason: 'Overwrite' }, stage === 'RELEASE' ? sre.token : lead.token, 409);
    }
    assert.equal((await f.expect(`${taskPath}/gates`, 'GET', undefined, dev.token)).overall, 'PASS');
    assert.ok(jobs.RELEASE.snapshot.upstreamApprovals.every(item => item.decisionId));
    const frozen = JSON.stringify(jobs.CODE_REVIEW.snapshot);
    const assetV2 = await addAsset('CODE', '  New CODE L005\n'); assert.equal(assetV2.revision, 2); assert.equal(assetV2.content, '  New CODE L005\n');
    const stale = await f.expect(`${taskPath}/gates`, 'GET', undefined, dev.token);
    assert.equal(stale.gates[0].status, 'PASS'); assert.equal(stale.gates[1].status, 'PASS');
    assert.ok(stale.gates.slice(2).every(item => item.status === 'STALE'));
    assert.equal(JSON.stringify((await f.expect(`/api/jobs/${jobs.CODE_REVIEW.id}`, 'GET', undefined, dev.token)).job.snapshot), frozen);
    for (const stage of ['CODE_REVIEW', 'TEST_CASE', 'RELEASE']) { const job = await newReview(stage); await report(job); await approve(job); }
    task = (await f.expect(taskPath, 'GET', undefined, dev.token)).task;
    const legacyChild = (await f.expect('/api/tasks', 'POST', { jiraKey: 'FLOW-9', title: 'Imported invalid child', parentId: task.id, assigneeId: dev.id }, admin.token, 201)).task;
    assert.equal((await f.expect(`${taskPath}/gates`, 'GET', undefined, dev.token)).gates[0].status, 'STALE');
    f.app.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(legacyChild.id);
    await f.expect(taskPath, 'PATCH', { expectedVersion: task.version, status: 'DONE' }, dev.token, 409);
    f.app.db.prepare('DELETE FROM tasks WHERE id=?').run(legacyChild.id);
    assert.equal((await f.expect(`${taskPath}/gates`, 'GET', undefined, dev.token)).gates[0].status, 'STALE');
    for (const stage of ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE']) { const job = await newReview(stage); await report(job); await approve(job); }
    task = (await f.expect(taskPath, 'GET', undefined, dev.token)).task;
    task = (await f.expect(taskPath, 'PATCH', { expectedVersion: task.version, status: 'DONE' }, dev.token)).task;
    await f.expect(`${taskPath}/assets`, 'POST', { kind: 'CODE', title: 'Frozen', content: 'change' }, admin.token, 409);
    await f.expect('/api/reviews', 'POST', { taskId: task.id, stage: 'PRD' }, admin.token, 409);
    await f.expect(`${taskPath}/claim`, 'POST', { expectedVersion: task.version }, dev.token, 409);
    await f.expect('/api/tasks', 'POST', { jiraKey: 'FLOW-2', title: 'Cannot append to DONE', parentId: task.id }, admin.token, 409);
    await f.expect('/api/plugins', 'POST', { id: 'new-policy', name: 'New policy', version: '1.0.0', stages: ['CODE_REVIEW'] }, admin.token, 201);
    assert.equal((await f.expect(`${taskPath}/gates`, 'GET', undefined, dev.token)).overall, 'PASS');
    const reopened = (await f.expect(taskPath, 'PATCH', { expectedVersion: task.version, status: 'OPEN' }, dev.token)).task;
    assert.equal(reopened.contextVersion, task.contextVersion + 1);
    assert.ok((await f.expect(`${taskPath}/gates`, 'GET', undefined, dev.token)).gates.every(item => item.status === 'STALE'));
    assert.equal(task.jiraStatus, 'unverified');
  } finally { await f.app.close(); }
});
test('restoring task title or assignee cannot revive old approval; progress does not invalidate PRD', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, DEV: dev, LEAD: lead } = await accounts(f);
    let task = (await f.expect('/api/tasks', 'POST', { jiraKey: 'REV-1', title: 'Original', assigneeId: dev.id }, admin.token, 201)).task;
    await f.expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: 'Original PRD', content: 'Original content' }, admin.token, 201);
    const job = (await f.expect('/api/reviews', 'POST', { taskId: task.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, admin.token, 201)).job;
    await f.expect(`/api/jobs/${job.id}/report`, 'POST', { summary: 'Manual report', source: 'MANUAL', findings: [] }, admin.token, 201);
    await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Independent PM review' }, lead.token, 201);
    await f.expect(`/api/tasks/${task.id}/progress`, 'POST', { tool: 'cursor', deviceId: 'one', summary: 'Working', progress: 50 }, dev.token, 201);
    assert.equal((await f.expect(`/api/tasks/${task.id}/gates`, 'GET', undefined, dev.token)).gates[0].status, 'PASS');
    for (const title of ['Changed', 'Original']) { task = (await f.expect(`/api/tasks/${task.id}`, 'GET', undefined, dev.token)).task; await f.expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title }, dev.token); }
    assert.equal((await f.expect(`/api/tasks/${task.id}/gates`, 'GET', undefined, dev.token)).gates[0].status, 'STALE');
    assert.equal((await f.expect(`/api/tasks/${task.id}`, 'GET', undefined, dev.token)).task.contextVersion, 3);
    const freshJob = (await f.expect('/api/reviews', 'POST', { taskId: task.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, admin.token, 201)).job;
    await f.expect(`/api/jobs/${freshJob.id}/report`, 'POST', { summary: 'New manual report', source: 'MANUAL', findings: [] }, admin.token, 201);
    await f.expect(`/api/jobs/${freshJob.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'New independent review' }, lead.token, 201);
    for (const assigneeId of [lead.id, dev.id]) { task = (await f.expect(`/api/tasks/${task.id}`, 'GET', undefined, admin.token)).task; await f.expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, assigneeId }, admin.token); }
    assert.equal((await f.expect(`/api/tasks/${task.id}/gates`, 'GET', undefined, dev.token)).gates[0].status, 'STALE');
    assert.equal((await f.expect(`/api/tasks/${task.id}`, 'GET', undefined, dev.token)).task.contextVersion, 5);

  } finally { await f.app.close(); }
});
test('legacy schema migration preserves rows and never grants default membership on subsequent restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-legacy-')); const dbPath = join(dir, 'legacy.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,role TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE tasks(id TEXT PRIMARY KEY,jira_key TEXT UNIQUE NOT NULL,title TEXT NOT NULL,owner_id TEXT NOT NULL,created_at TEXT NOT NULL,progress INTEGER DEFAULT 0,last_summary TEXT DEFAULT '',updated_at TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,stage TEXT NOT NULL,status TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO users VALUES('old-user','old-account','DEV','original-salt','original-hash'); INSERT INTO tasks VALUES('old-task','OLD-1','Original task','old-user','2026-01-01',35,'Original L006','2026-01-02'); INSERT INTO jobs VALUES('old-job','old-task','CODE_REVIEW','AWAITING_CONFIGURATION','old-user','2026-01-01');`); old.close();
  let app = createPlatform({ dbPath });
  try {
    assert.equal(app.db.prepare('SELECT hash FROM users WHERE id=?').get('old-user').hash, 'original-hash');
    const row = app.db.prepare('SELECT * FROM tasks WHERE id=?').get('old-task'); assert.equal(row.progress, 35); assert.equal(row.last_summary, 'Original L006'); assert.equal(row.assignee_id, 'old-user'); assert.equal(row.project_id, 'default'); assert.equal(row.context_version, 1);
    assert.equal(app.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get('default', 'old-user').role, 'DEV');
    assert.equal(app.db.prepare('SELECT status FROM jobs WHERE id=?').get('old-job').status, 'AWAITING_CONFIGURATION');
    app.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('private', 'PRIVATE', 'Private', 'now');
    app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('new-user', 'private-only', 'LEAD', 'salt', 'hash');
    app.db.prepare('INSERT INTO project_members VALUES(?,?,?)').run('private', 'new-user', 'LEAD');
    app.db.close(); app = createPlatform({ dbPath });
    assert.equal(app.db.prepare('SELECT * FROM project_members WHERE project_id=? AND user_id=?').get('default', 'new-user'), undefined);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  } finally { app.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('single-account solo mode allows full 7-step delivery to DONE and immediately enforces independent review once another approver joins', async () => {
  const f = await fixture();
  try {
    await f.expect('/api/setup', 'POST', { username: 'solo-admin', password }, undefined, 201);
    const adminToken = await f.login('solo-admin');
    let task = (await f.expect('/api/tasks', 'POST', { jiraKey: 'SOLO-1', title: 'Single account full workflow', assigneeId: null }, adminToken, 201)).task;
    task = (await f.expect(`/api/tasks/${task.id}/claim`, 'POST', { expectedVersion: task.version }, adminToken)).task;
    assert.equal(task.status, 'IN_PROGRESS');

    for (const kind of ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN']) {
      await f.expect(`/api/tasks/${task.id}/assets`, 'POST', { kind, title: `${kind} v1`, content: `# ${kind}\nsolo delivery` }, adminToken, 201);
    }
    for (const stage of ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE']) {
      const job = (await f.expect('/api/reviews', 'POST', { taskId: task.id, stage, executionMode: 'LOCAL_REPORT' }, adminToken, 201)).job;
      assert.equal(job.soloMode, true);
      const findings = stage === 'CODE_REVIEW' ? [{ severity: 'CRITICAL', title: 'Solo critical item', detail: 'Needs explicit waiver' }] : [];
      const reported = (await f.expect(`/api/jobs/${job.id}/report`, 'POST', { summary: `${stage} solo review`, source: 'LOCAL_TOOL', tool: 'codex-cli', findings }, adminToken, 201)).job;
      assert.equal(reported.soloMode, true);
      if (stage === 'CODE_REVIEW') {
        await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Unwaived critical still blocks' }, adminToken, 409);
        const waived = (await f.expect(`/api/jobs/${job.id}/findings/${reported.findings[0].id}/waiver`, 'POST', { reason: 'Solo verified mitigation' }, adminToken, 201)).job;
        assert.ok(waived.findings[0].waiver);
      }
      const approved = (await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: `${stage} solo verified` }, adminToken, 201)).job;
      assert.equal(approved.status, 'APPROVED');
    }
    const gates = await f.expect(`/api/tasks/${task.id}/gates`, 'GET', undefined, adminToken);
    assert.equal(gates.overall, 'PASS');
    task = (await f.expect(`/api/tasks/${task.id}`, 'GET', undefined, adminToken)).task;
    const completed = (await f.expect(`/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, status: 'DONE' }, adminToken)).task;
    assert.equal(completed.status, 'DONE');

    // Once a second eligible approver (LEAD) joins the project, solo self-approval immediately fails with 403 INDEPENDENT_REVIEW_REQUIRED
    await f.expect('/api/users', 'POST', { username: 'peer-lead', password, role: 'LEAD' }, adminToken, 201);
    const peerToken = await f.login('peer-lead');
    const task2 = (await f.expect('/api/tasks', 'POST', { jiraKey: 'SOLO-2', title: 'Multi-user task' }, adminToken, 201)).task;
    await f.expect(`/api/tasks/${task2.id}/assets`, 'POST', { kind: 'PRD', title: 'PRD', content: 'PRD body' }, adminToken, 201);
    const job2 = (await f.expect('/api/reviews', 'POST', { taskId: task2.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, adminToken, 201)).job;
    const reported2 = (await f.expect(`/api/jobs/${job2.id}/report`, 'POST', { summary: 'Admin report', source: 'MANUAL', findings: [] }, adminToken, 201)).job;
    assert.equal(reported2.soloMode, false);
    const selfAttempt = await f.call(`/api/jobs/${job2.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Self approve when peer exists' }, adminToken);
    assert.equal(selfAttempt.status, 403);
    assert.equal(selfAttempt.data.error.code, 'INDEPENDENT_REVIEW_REQUIRED');
    const peerApproved = (await f.expect(`/api/jobs/${job2.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'Peer approved' }, peerToken, 201)).job;
    assert.equal(peerApproved.status, 'APPROVED');
  } finally { await f.app.close(); }
});

test('task deletion removes local task, subtasks, assets, and reviews cleanly while blocking unauthorized callers', async () => {
  const f = await fixture();
  try {
    await f.expect('/api/setup', 'POST', { username: 'del-admin', password }, undefined, 201);
    const adminToken = await f.login('del-admin');
    await f.expect('/api/users', 'POST', { username: 'del-dev1', password, role: 'DEV' }, adminToken, 201);
    await f.expect('/api/users', 'POST', { username: 'del-dev2', password, role: 'DEV' }, adminToken, 201);
    const dev1Token = await f.login('del-dev1');
    const dev2Token = await f.login('del-dev2');

    const parent = (await f.expect('/api/tasks', 'POST', { jiraKey: 'BOARD-934', title: '【重构】主任务' }, adminToken, 201)).task;
    const child = (await f.expect('/api/tasks', 'POST', { jiraKey: 'BOARD-1147', title: '【重构】子任务', parentId: parent.id }, adminToken, 201)).task;
    await f.expect(`/api/tasks/${child.id}/assets`, 'POST', { kind: 'PRD', title: 'Refactor PRD', content: 'Refactor body' }, adminToken, 201);
    const job = (await f.expect('/api/reviews', 'POST', { taskId: child.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, adminToken, 201)).job;
    await f.expect(`/api/jobs/${job.id}/report`, 'POST', { summary: 'Refactor report', source: 'MANUAL', findings: [{ severity: 'WARN', title: 'Note', detail: 'Detail' }] }, adminToken, 201);

    // Other DEV who neither owns the task nor has assignTasks permission is blocked
    const forbidden = await f.call(`/api/tasks/${child.id}`, 'DELETE', undefined, dev2Token);
    assert.equal(forbidden.status, 403);

    // Deleting parent without cascade=1 returns 409 HAS_CHILD_TASKS
    const noCascade = await f.call(`/api/tasks/${parent.id}`, 'DELETE', undefined, adminToken);
    assert.equal(noCascade.status, 409);
    assert.equal(noCascade.data.error.code, 'HAS_CHILD_TASKS');

    // Deleting parent with cascade=1 removes parent, child, assets, jobs, reports, findings
    const deleted = await f.expect(`/api/tasks/${parent.id}?cascade=1`, 'DELETE', undefined, adminToken, 200);
    assert.equal(deleted.deletedCount, 2);
    assert.deepEqual(deleted.deletedKeys, ['BOARD-934', 'BOARD-1147']);
    const remaining = (await f.expect('/api/tasks', 'GET', undefined, adminToken)).tasks;
    assert.equal(remaining.length, 0);

    // Owner DEV can remove their own task
    const ownTask = (await f.expect('/api/tasks', 'POST', { jiraKey: 'DEV-101', title: 'Own task' }, dev1Token, 201)).task;
    const ownDeleted = await f.expect(`/api/tasks/${ownTask.id}`, 'DELETE', undefined, dev1Token, 200);
    assert.equal(ownDeleted.deletedCount, 1);
  } finally { await f.app.close(); }
});

test('inline project rename and lightweight overview-summary enforce permissions and omit heavy payloads', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, DEV: dev, LEAD: lead } = await accounts(f);
    const otherProj = (await f.expect('/api/projects', 'POST', { key: 'HIDDEN', name: 'Hidden Project' }, admin.token, 201)).project;
    const hiddenTask = (await f.expect('/api/tasks', 'POST', { projectId: otherProj.id, jiraKey: 'HID-1', title: 'Hidden task' }, admin.token, 201)).task;
    await f.expect(`/api/tasks/${hiddenTask.id}/assets`, 'POST', { kind: 'PRD', title: 'Hidden PRD', content: 'secret' }, admin.token, 201);

    // DEV cannot rename project; LEAD and ADMIN can rename inline
    await f.expect('/api/projects/default', 'PATCH', { name: 'Dev Rename' }, dev.token, 403);
    const renamedByLead = (await f.expect('/api/projects/default', 'PATCH', { name: '默认交付空间（内联改名）' }, lead.token, 200)).project;
    assert.equal(renamedByLead.name, '默认交付空间（内联改名）');
    const renamedByAdmin = (await f.expect('/api/projects/default', 'PATCH', { name: '核心支付交付空间' }, admin.token, 200)).project;
    assert.equal(renamedByAdmin.name, '核心支付交付空间');

    // Local device token cannot rename project
    const base = `http://127.0.0.1:${f.app.server.address().port}`;
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'administrator', password }),
    });
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] || '';
    const pair = await f.expect('/api/device-authorizations', 'POST', { deviceName: 'Dev Mac', tool: 'custom' }, undefined, 201);
    const decideRes = await fetch(`${base}/api/device-authorizations/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
      body: JSON.stringify({ userCode: pair.userCode, decision: 'APPROVE', projectIds: ['default'] }),
    });
    assert.equal(decideRes.status, 200);
    const deviceToken = (await f.expect('/api/device-authorizations/poll', 'POST', { deviceCode: pair.deviceCode }, undefined, 200)).token;
    const deviceRename = await f.call('/api/projects/default', 'PATCH', { name: 'Device Rename' }, deviceToken);
    assert.equal(deviceRename.status, 403);
    assert.equal(deviceRename.data.error.code, 'LOCAL_DEVICE_SCOPE');
    const deviceSummary = await f.call('/api/overview-summary', 'GET', undefined, deviceToken);
    assert.equal(deviceSummary.status, 403);
    assert.equal(deviceSummary.data.error.code, 'LOCAL_DEVICE_SCOPE');

    // Seed tasks, assets, and reviews in default project to verify overview-summary
    const t1 = (await f.expect('/api/tasks', 'POST', { jiraKey: 'SUM-1', title: 'Summary task', assigneeId: dev.id }, admin.token, 201)).task;
    await f.expect(`/api/tasks/${t1.id}/assets`, 'POST', { kind: 'PRD', title: 'PRD 1', content: 'PRD body' }, admin.token, 201);
    await f.expect(`/api/tasks/${t1.id}/assets`, 'POST', { kind: 'TECH_SPEC', title: 'TECH 1', content: 'spec' }, admin.token, 201);
    const awaitingJob = (await f.expect('/api/reviews', 'POST', { taskId: t1.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, admin.token, 201)).job;
    await f.expect(`/api/jobs/${awaitingJob.id}/report`, 'POST', { summary: 'Ready for decision', source: 'MANUAL', findings: [{ severity: 'INFO', title: 'Nit', detail: 'Minor' }] }, admin.token, 201);
    await f.expect('/api/reviews', 'POST', { taskId: t1.id, stage: 'TECH_SPEC', executionMode: 'LOCAL_REPORT' }, admin.token, 201);

    // DEV sees only default project counts (2 reviews, 2 assets, 1 pending reported job) and no heavy snapshot/findings
    const devSummary = await f.expect('/api/overview-summary', 'GET', undefined, dev.token, 200);
    assert.equal(devSummary.reviewCount, 2);
    assert.equal(devSummary.assetCount, 2);
    assert.equal(devSummary.openBlockersCount, 0);
    assert.deepEqual(devSummary.stageBreakdown.PRD, { approved: 0, pendingApproval: 1, awaitingReport: 0, changesRequested: 0 });
    assert.deepEqual(devSummary.stageBreakdown.TECH_SPEC, { approved: 0, pendingApproval: 0, awaitingReport: 1, changesRequested: 0 });
    assert.equal(devSummary.pendingJobs.length, 1);
    assert.equal(devSummary.pendingJobs[0].id, awaitingJob.id);
    assert.equal(devSummary.pendingJobs[0].report.actorId, admin.id);
    assert.equal(devSummary.pendingJobs[0].hasBlockingFindings, false);
    assert.equal(devSummary.pendingJobs[0].prerequisitesBlocked, false);
    assert.equal('snapshot' in devSummary.pendingJobs[0], false);
    assert.equal('findings' in devSummary.pendingJobs[0], false);

    // Critical finding marks hasBlockingFindings=true and openBlockersCount=1 in overview-summary until waived
    const techJob = (await f.expect('/api/jobs?taskId=' + t1.id, 'GET', undefined, admin.token, 200)).jobs.find(j => j.stage === 'TECH_SPEC');
    const reportedTech = (await f.expect(`/api/jobs/${techJob.id}/report`, 'POST', {
      summary: 'Found blocker',
      source: 'LOCAL_TOOL',
      tool: 'codex-cli',
      findings: [{ severity: 'CRITICAL', title: 'Missing lock', detail: 'Race condition' }],
    }, admin.token, 201)).job;
    const summaryWithBlocker = await f.expect('/api/overview-summary?projectId=default', 'GET', undefined, lead.token, 200);
    assert.equal(summaryWithBlocker.openBlockersCount, 1);
    assert.deepEqual(summaryWithBlocker.stageBreakdown.TECH_SPEC, { approved: 0, pendingApproval: 1, awaitingReport: 0, changesRequested: 0 });
    const techPending = summaryWithBlocker.pendingJobs.find(j => j.id === techJob.id);
    assert.equal(techPending.hasBlockingFindings, true);
    await f.expect(`/api/jobs/${techJob.id}/findings/${reportedTech.findings[0].id}/waiver`, 'POST', { reason: 'Handled upstream' }, lead.token, 201);
    const summaryAfterWaiver = await f.expect('/api/overview-summary?projectId=default', 'GET', undefined, lead.token, 200);
    assert.equal(summaryAfterWaiver.openBlockersCount, 0);
    assert.equal(summaryAfterWaiver.pendingJobs.find(j => j.id === techJob.id).hasBlockingFindings, false);

    // Verify SQLite concurrency pragmas and hot-path indexes exist
    assert.equal(f.app.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assert.equal(f.app.db.prepare('PRAGMA synchronous').get().synchronous, 1);
    const indexNames = new Set(f.app.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name));
    for (const requiredIdx of ['finding_job_idx', 'asset_project_created_idx', 'job_project_idx', 'job_task_stage_idx', 'task_parent_idx', 'progress_task_idx', 'audit_project_idx']) {
      assert.equal(indexNames.has(requiredIdx), true, `expected index ${requiredIdx}`);
    }

    // Scoped ?projectId=default vs all visible projects for ADMIN
    const adminScoped = await f.expect('/api/overview-summary?projectId=default', 'GET', undefined, admin.token, 200);
    assert.equal(adminScoped.assetCount, 2);
    const adminAll = await f.expect('/api/overview-summary', 'GET', undefined, admin.token, 200);
    assert.equal(adminAll.assetCount, 3);
    await f.expect(`/api/overview-summary?projectId=${otherProj.id}`, 'GET', undefined, dev.token, 403);

    // Scoped SQL pushdown for GET /api/tasks and GET /api/jobs
    const defaultTasks = await f.expect('/api/tasks?projectId=default', 'GET', undefined, dev.token, 200);
    assert.equal(defaultTasks.tasks.every(t => t.projectId === 'default'), true);
    await f.expect(`/api/tasks?projectId=${otherProj.id}`, 'GET', undefined, dev.token, 403);

    const taskJobs = await f.expect(`/api/jobs?taskId=${t1.id}`, 'GET', undefined, dev.token, 200);
    assert.equal(taskJobs.jobs.length, 2);
    const mismatchedJobs = await f.expect(`/api/jobs?taskId=${t1.id}&projectId=${otherProj.id}`, 'GET', undefined, admin.token, 200);
    assert.equal(mismatchedJobs.jobs.length, 0);
    await f.expect(`/api/jobs?projectId=${otherProj.id}`, 'GET', undefined, dev.token, 403);
  } finally { await f.app.close(); }
});

test('workflow createMemo deduplicates assets, plugins, gates and approver SQL queries across batch job reads', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, DEV: dev, LEAD: lead, SRE: sre } = await accounts(f);
    for (const member of [dev, lead, sre]) {
      await f.expect('/api/projects/default/members', 'POST', { userId: member.id, role: member.role }, admin.token, 200);
    }
    await f.expect('/api/plugins', 'POST', {
      id: 'contract-guard',
      name: 'Contract Guard',
      version: '1.0.0',
      stages: ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE'],
    }, admin.token, 201);

    const task = (await f.expect('/api/tasks', 'POST', { jiraKey: 'MEMO-1', title: 'Memoized batch test', assigneeId: dev.id }, admin.token, 201)).task;
    for (const kind of ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN']) {
      await f.expect(`/api/tasks/${task.id}/assets`, 'POST', { kind, title: `${kind} doc`, content: `${kind} content` }, admin.token, 201);
    }
    for (const stage of ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE']) {
      await f.expect('/api/reviews', 'POST', { taskId: task.id, stage, executionMode: 'HUMAN_REVIEW' }, admin.token, 201);
    }

    // Spy on db.prepare to count how many SQL statements are prepared during memoized vs unmemoized batch reads
    let prepareCalls = 0;
    const rawPrepare = f.app.db.prepare.bind(f.app.db);
    const countingDb = new Proxy(f.app.db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return sql => {
            prepareCalls += 1;
            return rawPrepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const wf = createWorkflow(countingDb, () => {}, fn => fn());
    const rows = rawPrepare('SELECT * FROM jobs WHERE task_id=? ORDER BY rowid DESC').all(task.id);
    assert.equal(rows.length, 5);

    prepareCalls = 0;
    const unmemoized = rows.map(row => wf.jobRow(row, task));
    const unmemoizedCalls = prepareCalls;

    prepareCalls = 0;
    const memo = wf.createMemo();
    const memoized = rows.map(row => wf.jobRow(row, task, memo));
    const gatesResult = wf.gates(task, memo);
    const memoizedCalls = prepareCalls;

    assert.deepEqual(memoized, unmemoized);
    assert.equal(gatesResult.gates.length, 5);
    assert.ok(memoizedCalls < unmemoizedCalls, `expected memoized SQL count (${memoizedCalls}) < unmemoized (${unmemoizedCalls})`);
  } finally {
    await f.app.close();
  }
});

test('GET /api/tasks/:id/bundle returns exact single-roundtrip parity with individual endpoints and enforces project isolation', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, DEV: dev } = await accounts(f);
    const secretProject = (await f.expect('/api/projects', 'POST', { key: 'SEC', name: 'Secret Project' }, admin.token, 201)).project;
    await f.expect('/api/users', 'POST', { username: 'outsider-qa', password, role: 'QA', projectId: secretProject.id }, admin.token, 201);
    const outsiderToken = await f.login('outsider-qa');
    const secretTask = (await f.expect('/api/tasks', 'POST', { projectId: secretProject.id, jiraKey: 'SEC-1', title: 'Restricted task' }, admin.token, 201)).task;

    const task = (await f.expect('/api/tasks', 'POST', { jiraKey: 'BNDL-1', title: 'Bundle parity task', assigneeId: dev.id }, admin.token, 201)).task;
    await f.expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: 'PRD v1', content: 'PRD body' }, admin.token, 201);
    await f.expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'TECH_SPEC', title: 'Tech Spec v1', content: 'Spec body' }, dev.token, 201);
    await f.expect(`/api/tasks/${task.id}/progress`, 'POST', { progress: 50, tool: 'custom', deviceId: 'web-workbench', summary: 'Halfway done', branch: 'feat/bundle' }, dev.token, 201);
    const job = (await f.expect('/api/reviews', 'POST', { taskId: task.id, stage: 'TECH_SPEC', executionMode: 'LOCAL_REPORT' }, dev.token, 201)).job;
    await f.expect(`/api/jobs/${job.id}/report`, 'POST', { source: 'LOCAL_TOOL', tool: 'codex-cli', summary: 'Checked spec', findings: [] }, dev.token, 201);

    const bundle = await f.expect(`/api/tasks/${task.id}/bundle`, 'GET', undefined, dev.token, 200);
    const [singleTask, singleContext, singleAssets, singleGates, singleJobs] = await Promise.all([
      f.expect(`/api/tasks/${task.id}`, 'GET', undefined, dev.token, 200),
      f.expect(`/api/tasks/${task.id}/context`, 'GET', undefined, dev.token, 200),
      f.expect(`/api/tasks/${task.id}/assets`, 'GET', undefined, dev.token, 200),
      f.expect(`/api/tasks/${task.id}/gates`, 'GET', undefined, dev.token, 200),
      f.expect(`/api/jobs?taskId=${task.id}`, 'GET', undefined, dev.token, 200),
    ]);

    assert.deepEqual(bundle.task, singleTask.task);
    assert.deepEqual(bundle.assets, singleAssets.assets);
    assert.deepEqual(bundle.gates, singleGates);
    assert.deepEqual(bundle.jobs, singleJobs.jobs);
    assert.deepEqual(bundle.context.progressEvents, singleContext.progressEvents);
    assert.equal(bundle.context.progressEvents[0].deviceId, 'web-workbench');
    assert.equal(bundle.context.progressEvents[0].branch, 'feat/bundle');

    // Non-member outsider and unshared project must be rejected with 403
    await f.expect(`/api/tasks/${task.id}/bundle`, 'GET', undefined, outsiderToken, 403);
    await f.expect(`/api/tasks/${secretTask.id}/bundle`, 'GET', undefined, dev.token, 403);
    await f.expect('/api/tasks/nonexistent-task-id/bundle', 'GET', undefined, admin.token, 404);
  } finally {
    await f.app.close();
  }
});

test('GET /api/overview-summary computes DORA flowTelemetry (Lead Time, Review Turnaround, First-Time Pass Rate, 7d Throughput) with strict project isolation', async () => {
  const f = await fixture();
  try {
    const { ADMIN: admin, LEAD: lead, DEV: dev, SRE: sre } = await accounts(f);
    const isolatedProj = (await f.expect('/api/projects', 'POST', { key: 'ISO', name: 'Isolated Flow' }, admin.token, 201)).project;
    await f.expect('/api/tasks', 'POST', { projectId: isolatedProj.id, jiraKey: 'ISO-1', title: 'Hidden task' }, admin.token, 201);

    const flowTask = (await f.expect('/api/tasks', 'POST', { jiraKey: 'DORA-1', title: 'DORA end-to-end delivery', assigneeId: dev.id }, admin.token, 201)).task;
    // Register all 5 stage assets
    await f.expect(`/api/tasks/${flowTask.id}/assets`, 'POST', { kind: 'PRD', title: 'PRD', content: 'prd' }, admin.token, 201);
    await f.expect(`/api/tasks/${flowTask.id}/assets`, 'POST', { kind: 'TECH_SPEC', title: 'SPEC', content: 'spec' }, dev.token, 201);
    await f.expect(`/api/tasks/${flowTask.id}/assets`, 'POST', { kind: 'CODE', title: 'CODE', content: 'code' }, dev.token, 201);
    await f.expect(`/api/tasks/${flowTask.id}/assets`, 'POST', { kind: 'TEST_CASE', title: 'TEST', content: 'test' }, admin.token, 201);
    await f.expect(`/api/tasks/${flowTask.id}/assets`, 'POST', { kind: 'RELEASE_PLAN', title: 'REL', content: 'rel' }, sre.token, 201);

    // 1st PRD review gets REQUEST_CHANGES (rework), then 2nd PRD + remaining 4 stages get APPROVE
    const prdReworkJob = (await f.expect('/api/reviews', 'POST', { taskId: flowTask.id, stage: 'PRD', executionMode: 'HUMAN_REVIEW' }, admin.token, 201)).job;
    await f.expect(`/api/jobs/${prdReworkJob.id}/report`, 'POST', { source: 'MANUAL', summary: 'Draft PRD', findings: [] }, admin.token, 201);
    await f.expect(`/api/jobs/${prdReworkJob.id}/decision`, 'POST', { decision: 'REQUEST_CHANGES', reason: 'Add acceptance criteria' }, lead.token, 201);

    for (const [stage, reporter, approver] of [
      ['PRD', admin, lead],
      ['TECH_SPEC', admin, lead],
      ['CODE_REVIEW', admin, lead],
      ['TEST_CASE', admin, lead],
      ['RELEASE', admin, sre],
    ]) {
      const job = (await f.expect('/api/reviews', 'POST', { taskId: flowTask.id, stage, executionMode: 'HUMAN_REVIEW' }, reporter.token, 201)).job;
      await f.expect(`/api/jobs/${job.id}/report`, 'POST', { source: 'MANUAL', summary: `${stage} ok`, findings: [] }, reporter.token, 201);
      await f.expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: 'LGTM' }, approver.token, 201);
    }

    const latestTask = (await f.expect(`/api/tasks/${flowTask.id}`, 'GET', undefined, dev.token, 200)).task;
    await f.expect(`/api/tasks/${flowTask.id}`, 'PATCH', { status: 'DONE', expectedVersion: latestTask.version }, dev.token, 200);
    // Backdate created_at by 6 hours so Lead Time P50/P90 is deterministically ~6h
    const doneRow = f.app.db.prepare('SELECT updated_at FROM tasks WHERE id=?').get(flowTask.id);
    const sixHoursEarlier = new Date(Date.parse(doneRow.updated_at) - 6 * 3_600_000).toISOString();
    f.app.db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(sixHoursEarlier, flowTask.id);

    const summary = await f.expect('/api/overview-summary?projectId=default', 'GET', undefined, dev.token, 200);
    assert.ok(summary.flowTelemetry);
    assert.equal(summary.flowTelemetry.completedTasksTotal, 1);
    assert.equal(summary.flowTelemetry.medianLeadTimeHours, 6);
    assert.equal(summary.flowTelemetry.p90LeadTimeHours, 6);
    assert.equal(summary.flowTelemetry.decidedReviewsCount, 6);
    assert.equal(summary.flowTelemetry.approvedReviewsCount, 5);
    assert.equal(summary.flowTelemetry.reworkReviewsCount, 1);
    assert.equal(summary.flowTelemetry.firstTimePassRate, 83);
    assert.equal(typeof summary.flowTelemetry.medianReviewTurnaroundHours, 'number');
    assert.equal(summary.flowTelemetry.throughput7d.tasksDone, 1);
    assert.equal(summary.flowTelemetry.throughput7d.gatesApproved, 5);
    assert.equal(summary.flowTelemetry.throughput7d.assetsVersioned, 5);

    // Isolated project has zero completed tasks and null rates
    const isoSummary = await f.expect(`/api/overview-summary?projectId=${isolatedProj.id}`, 'GET', undefined, admin.token, 200);
    assert.equal(isoSummary.flowTelemetry.completedTasksTotal, 0);
    assert.equal(isoSummary.flowTelemetry.medianLeadTimeHours, null);
    assert.equal(isoSummary.flowTelemetry.firstTimePassRate, null);
    assert.equal(isoSummary.flowTelemetry.throughput7d.tasksDone, 0);
  } finally {
    await f.app.close();
  }
});

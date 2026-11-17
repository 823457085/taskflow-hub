import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPlatform } from './server.mjs';

const password = 'report-test-passphrase';

test('work reports group tasks, todos, AI runs and progress by day, keep personal todos private and limit team views to leads', async () => {
  const platform = createPlatform({ dbPath: ':memory:', logger: { error: () => {} } });
  await new Promise(resolve => platform.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${platform.server.address().port}`;
  const call = async (path, method = 'GET', body, token) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  const login = async username => (await call('/api/login', 'POST', { username, password })).body;
  try {
    assert.equal((await call('/api/setup', 'POST', { username: 'admin', password })).status, 201);
    const admin = await login('admin');
    for (const [username, role] of [['dev', 'DEV'], ['peer', 'DEV'], ['pm-lead', 'PM']]) assert.equal((await call('/api/users', 'POST', { username, password, role }, admin.token)).status, 201);
    const secret = (await call('/api/projects', 'POST', { key: 'SECRET', name: 'Secret' }, admin.token)).body.project;
    const [dev, peer, pm] = [await login('dev'), await login('peer'), await login('pm-lead')];
    const report = async (token, query = '') => call(`/api/work-reports?projectId=default&tzOffset=480${query}`, 'GET', undefined, token);
    const now = new Date();
    const today = new Date(now.getTime() + 480 * 60 * 1000).toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() + 480 * 60 * 1000 - 86400000).toISOString().slice(0, 10);

    const create = async (jiraKey, title) => (await call('/api/tasks', 'POST', { jiraKey, title }, dev.token)).body.task;
    const [doing, reviewing, open, done, oldDone] = [await create('RPT-1', '支付联调'), await create('RPT-2', '评审中的任务'), await create('RPT-3', '未开始任务'), await create('RPT-4', '今天完成'), await create('RPT-5', '以前完成')];
    const setStatus = (task, status, updatedAt = now.toISOString()) => platform.db.prepare('UPDATE tasks SET status=?,assignee_id=?,updated_at=? WHERE id=?').run(status, dev.user.id, updatedAt, task.id);
    setStatus(doing, 'IN_PROGRESS'); setStatus(reviewing, 'IN_REVIEW'); setStatus(open, 'OPEN'); setStatus(done, 'DONE'); setStatus(oldDone, 'DONE', '2020-01-01T00:00:00.000Z');
    assert.equal((await call(`/api/tasks/${doing.id}/progress`, 'POST', { progress: 40, tool: 'codex', deviceId: 'mac', summary: '完成接口对接' }, dev.token)).status, 201);

    await call('/api/todos', 'POST', { title: '私人事项', status: 'done' }, dev.token);
    await call('/api/todos', 'POST', { title: '逾期事项', projectId: 'default', dueDate: yesterday }, dev.token);
    await call('/api/todos', 'POST', { title: '指派给 peer', projectId: 'default', assigneeId: peer.user.id }, pm.token);

    const insertRun = (task, mode, status, startedAt, finishedAt) => platform.db.prepare(`INSERT INTO local_ai_runs (id,task_id,project_id,actor_id,mode,engine,tool,status,started_at,finished_at,updated_at,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), task.id, 'default', dev.user.id, mode, 'codex', 'codex', status, startedAt, finishedAt, finishedAt || startedAt, status === 'FAILED' ? '仓库不存在' : null);
    const earlier = new Date(now.getTime() - 1000).toISOString();
    insertRun(doing, 'read', 'FAILED', earlier, earlier);
    insertRun(doing, 'read', 'SUCCEEDED', now.toISOString(), now.toISOString());
    insertRun(open, 'read', 'FAILED', now.toISOString(), now.toISOString());
    insertRun(reviewing, 'review', 'RUNNING', '2020-01-01T00:00:00.000Z', null);
    insertRun(doing, 'develop', 'SUCCEEDED', '2020-01-01T00:00:00.000Z', '2020-01-01T00:10:00.000Z');

    assert.equal((await call('/api/work-reports?projectId=default')).status, 401);
    assert.equal((await call('/api/work-reports', 'GET', undefined, dev.token)).body.error.code, 'PROJECT_REQUIRED');
    assert.equal((await report(dev.token, '&date=2026-02-30')).body.error.code, 'INVALID_DATE');
    assert.equal((await call(`/api/work-reports?projectId=${secret.id}`, 'GET', undefined, dev.token)).status, 403);

    const mine = (await report(dev.token)).body.report;
    assert.equal(mine.date, today);
    assert.equal(mine.canViewOthers, false);
    const { sections, counts, progress } = mine.members[0];
    const titles = name => sections[name].map(item => item.title).sort();
    assert.deepEqual(titles('completed'), ['只读分析：支付联调', '今天完成', '私人事项'].sort());
    assert.deepEqual(titles('doing'), ['评审：评审中的任务', '支付联调'].sort());
    assert.deepEqual(titles('review'), ['评审中的任务'].sort());
    assert.deepEqual(titles('blocked'), ['只读分析：未开始任务', '逾期事项'].sort());
    assert.match(sections.blocked.find(item => item.source === 'run').detail, /仓库不存在/);
    assert.deepEqual(titles('todo'), ['未开始任务'].sort());
    assert.equal(counts.completed, 3);
    assert.deepEqual(progress.map(item => [item.jiraKey, item.summary]), [['RPT-1', '完成接口对接']]);

    const past = (await report(dev.token, `&date=${yesterday}`)).body.report.members[0];
    assert.deepEqual(past.sections.completed, []);
    assert.deepEqual(past.progress, []);

    assert.equal((await report(dev.token, `&memberId=${peer.user.id}`)).body.error.code, 'REPORT_FORBIDDEN');
    assert.equal((await report(dev.token, '&scope=team')).body.error.code, 'REPORT_FORBIDDEN');

    const asLead = (await report(pm.token, `&memberId=${dev.user.id}`)).body.report.members[0];
    assert.equal(asLead.member.username, 'dev');
    assert.ok(!asLead.sections.completed.some(item => item.title === '私人事项'));
    assert.equal(asLead.counts.completed, 2);

    const team = (await report(pm.token, '&scope=team')).body.report;
    assert.equal(team.scope, 'team');
    assert.deepEqual(team.members.map(item => item.member.username), ['admin', 'dev', 'peer', 'pm-lead']);
    assert.deepEqual(team.members.find(item => item.member.username === 'peer').sections.todo.map(item => item.title), ['指派给 peer']);
    assert.equal((await report(pm.token, `&memberId=${randomUUID()}`)).body.error.code, 'REPORT_MEMBER_NOT_FOUND');
    assert.equal((await call('/api/work-reports?projectId=default', 'POST', {}, pm.token)).status, 405);
  } finally { await platform.close(); }
});

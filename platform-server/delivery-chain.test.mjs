import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform } from './server.mjs';
import { chainReportMarkdown, computeAssetDelta, declaredDeliverableKeys, declaredRepository, linkStatus, parseMergeRequest, requirementKeys } from './delivery-chain.mjs';

const password = 'local-only-delivery-chain-passphrase';
async function fixture() {
  const app = createPlatform({ dbPath: ':memory:' }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const expect = async (path, method = 'GET', body, token, status = 200) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`); return data;
  };
  await expect('/api/setup', 'POST', { username: 'administrator', password }, undefined, 201);
  const token = (await expect('/api/login', 'POST', { username: 'administrator', password })).token;
  return { app, expect, token };
}

const description = '*需求来源*\n产品需求 [OPAY-637|https://jira.example.com/browse/OPAY-637]。\n\n*交付物*\n技术方案 OPAY-699、前端实现 OPAY-700、联调自测记录 OPAY-709。\n\n*影响范围*\n仓库：thor-admin2.0\n';

test('description parsing finds requirement, deliverables and repository', () => {
  const task = { jiraKey: 'OPAY-698', externalRef: { description } };
  assert.deepEqual(requirementKeys(task), ['OPAY-637']);
  assert.deepEqual(declaredDeliverableKeys(task), ['OPAY-699', 'OPAY-700', 'OPAY-709']);
  assert.equal(declaredRepository(description), 'thor-admin2.0');
  const child = { jiraKey: 'VMS-800', externalRef: { description: '*需求来源*\n产品需求：[VMS-747|x]；父任务：[VMS-748|y]。' } };
  assert.deepEqual(requirementKeys(child), ['VMS-747']);
});

test('merge request parsing reads Codeup markdown and local snapshots', () => {
  const mr = parseMergeRequest({ id: 'a', title: '#1160 · fix', revision: 1, sourceUrl: 'https://codeup/x/change/1160', content: '# Codeup MR #1160 · fix\n- 状态：MERGED\n- 分支：`feature/apex-OPAY-637` → `i18n-test`\n' });
  assert.equal(mr.number, '1160'); assert.equal(mr.sourceBranch, 'feature/apex-OPAY-637'); assert.equal(mr.targetBranch, 'i18n-test'); assert.equal(mr.local, false);
  const local = parseMergeRequest({ id: 'b', title: 'local', revision: 1, content: '# 本地 Git 代码快照（repo）\n- 当前分支：feature/X-1\n# [提示：Diff 超过单份材料长度上限，已截断展示前 10 字符]' });
  assert.equal(local.local, true); assert.equal(local.sourceBranch, 'feature/X-1'); assert.equal(local.truncated, true);
});

test('link status maps gate and report state', () => {
  assert.equal(linkStatus({ status: 'MISSING_INPUT' }), 'MISSING');
  assert.equal(linkStatus({ status: 'PENDING' }, null), 'READY');
  assert.equal(linkStatus({ status: 'PENDING', jobId: 'j' }, { report: null }), 'REVIEWING');
  assert.equal(linkStatus({ status: 'PENDING', jobId: 'j' }, { report: {} }), 'AWAITING_DECISION');
  assert.equal(linkStatus({ status: 'PASS', jobId: 'j' }, { report: { verdict: 'CONDITIONAL' } }), 'CONDITIONAL');
  assert.equal(linkStatus({ status: 'STALE' }), 'STALE');
});

test('delivery chain: breakdown review, verdict reports, chain report and list statuses', async () => {
  const { app, expect, token } = await fixture();
  try {
    const parent = (await expect('/api/tasks', 'POST', { jiraKey: 'OPAY-698', title: '开发 POS 支持离线开门' }, token, 201)).task;
    let chain = (await expect(`/api/tasks/${parent.id}/chain`, 'GET', undefined, token)).chain;
    assert.deepEqual(chain.links.map(link => link.id), ['REQUIREMENT', 'BREAKDOWN', 'TECH_SPEC', 'CODE', 'TEST', 'RELEASE']);
    assert.equal(chain.links[0].status, 'MISSING');
    assert.equal(chain.links[1].status, 'MISSING');
    assert.equal(chain.links[1].next.type, 'ADD_SUBTASKS');
    assert.equal(chain.links[1].advisory, true);
    assert.ok(chain.links[1].focus.length >= 5);

    // Breakdown needs child tasks; adding one makes the link reviewable.
    await expect('/api/reviews', 'POST', { taskId: parent.id, stage: 'TASK_BREAKDOWN', executionMode: 'LOCAL_REPORT' }, token, 409);
    const child = (await expect('/api/tasks', 'POST', { jiraKey: 'OPAY-700', title: '前端实现 离线开门', parentId: parent.id }, token, 201)).task;
    chain = (await expect(`/api/tasks/${parent.id}/chain`, 'GET', undefined, token)).chain;
    assert.equal(chain.links[1].status, 'READY');
    assert.equal(chain.children.length, 1);

    const job = (await expect('/api/reviews', 'POST', { taskId: parent.id, stage: 'TASK_BREAKDOWN', executionMode: 'LOCAL_REPORT' }, token, 201)).job;
    assert.deepEqual(job.snapshot.children.map(item => item.jiraKey), ['OPAY-700']);
    await expect(`/api/jobs/${job.id}/report`, 'POST', { source: 'LOCAL_TOOL', tool: 'codex', summary: '拆分基本完整', findings: [], verdict: 'MAYBE' }, token, 400);
    await expect(`/api/jobs/${job.id}/report`, 'POST', { source: 'LOCAL_TOOL', tool: 'codex', summary: '拆分基本完整', findings: [], score: 101 }, token, 400);
    const reported = (await expect(`/api/jobs/${job.id}/report`, 'POST', {
      source: 'LOCAL_TOOL', tool: 'codex', summary: '拆分基本完整，缺少联调子任务', verdict: 'CONDITIONAL', score: 78,
      checklist: [{ item: '需求点：后台查看临时密码', result: 'PASS', note: '由前端实现承接', ref: 'OPAY-700' }, { item: '需求点：POS 联调', result: 'FAIL', note: '没有联调子任务' }],
      findings: [{ severity: 'WARN', title: '缺少联调子任务', detail: '补充 POS 联调与自测子任务' }],
    }, token, 201)).job;
    assert.equal(reported.report.verdict, 'CONDITIONAL'); assert.equal(reported.report.score, 78); assert.equal(reported.report.checklist.length, 2);

    chain = (await expect(`/api/tasks/${parent.id}/chain`, 'GET', undefined, token)).chain;
    assert.equal(chain.links[1].status, 'AWAITING_DECISION');
    assert.equal(chain.links[1].next.type, 'DECIDE');
    assert.equal(chain.traceability.length, 2);
    assert.equal(chain.traceability[0].tasks[0].taskId, child.id);
    await expect(`/api/jobs/${job.id}/decision`, 'POST', { decision: 'APPROVE', reason: '同意，补联调子任务' }, token, 201);
    chain = (await expect(`/api/tasks/${parent.id}/chain`, 'GET', undefined, token)).chain;
    assert.equal(chain.links[1].status, 'CONDITIONAL');
    assert.equal(chain.overall.score, 78);

    // Advisory stage never affects the five completion gates.
    const gates = await expect(`/api/tasks/${parent.id}/gates`, 'GET', undefined, token);
    assert.deepEqual(gates.gates.map(item => item.stage), ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE']);

    // Breakdown review goes stale when the child set changes, but not when a child's status changes.
    const childTask = (await expect(`/api/tasks/${child.id}`, 'GET', undefined, token)).task;
    await expect(`/api/tasks/${child.id}`, 'PATCH', { expectedVersion: childTask.version, status: 'IN_PROGRESS' }, token);
    chain = (await expect(`/api/tasks/${parent.id}/chain`, 'GET', undefined, token)).chain;
    assert.equal(chain.links[1].status, 'CONDITIONAL');

    const { markdown } = await expect(`/api/tasks/${parent.id}/chain-report`, 'GET', undefined, token);
    assert.match(markdown, /# 交付链路审核报告 · OPAY-698/);
    assert.match(markdown, /追溯矩阵/);
    assert.match(markdown, /OPAY-700/);
    assert.equal(typeof chainReportMarkdown(chain), 'string');

    const { statuses } = await expect('/api/chain-statuses?projectId=default', 'GET', undefined, token);
    assert.equal(statuses[parent.id].TASK_BREAKDOWN, 'CONDITIONAL');
    assert.equal(statuses[child.id], undefined);
    const childChain = (await expect(`/api/tasks/${child.id}/chain`, 'GET', undefined, token)).chain;
    assert.equal(childChain.overall.status, 'NOT_REQUIRED');
    assert.equal(childChain.parent.id, parent.id);
    assert.deepEqual(childChain.links, []);
    assert.equal(chain.children[0].links, null);

    // Attaching the main task to Jira makes breakdown informational and preserves the old review.
    app.db.prepare('UPDATE tasks SET jira_verified=1,external_ref=? WHERE id=?').run(JSON.stringify({ provider: 'jira', key: parent.jiraKey }), parent.id);
    const linkedChain = (await expect(`/api/tasks/${parent.id}/chain`, 'GET', undefined, token)).chain;
    assert.equal(linkedChain.links[1].status, 'LINKED');
    assert.equal(linkedChain.links[1].statusLabel, '已关联');
    assert.equal(linkedChain.links[1].next, null);
    assert.equal(linkedChain.links[1].review, null);
    assert.ok(!linkedChain.overall.blockers.some(item => item.linkId === 'BREAKDOWN'));
    const rejected = await expect('/api/reviews', 'POST', { taskId: parent.id, stage: 'TASK_BREAKDOWN' }, token, 409);
    assert.equal(rejected.error.code, 'JIRA_LINK_REVIEW_NOT_REQUIRED');
    const historical = (await expect(`/api/jobs/${job.id}`, 'GET', undefined, token)).job;
    assert.equal(historical.reviewRequired, false);
    assert.equal(historical.report.score, 78);
    assert.deepEqual((await expect('/api/jobs?projectId=default', 'GET', undefined, token)).jobs, []);
    assert.equal((await expect(`/api/jobs?taskId=${parent.id}`, 'GET', undefined, token)).jobs[0].id, job.id);
  } finally { await app.close(); }
});

test('computeAssetDelta diffs revisions and extracts changed sections', () => {
  const r1 = { id: 'a1', kind: 'PRD', logicalKey: 'PRD', title: '离线开门 PRD', revision: 1, sha256: 'h1', content: '# 范围\n支持离线开门\n## 异常\n旧提示' };
  const r2 = { id: 'a2', kind: 'PRD', logicalKey: 'PRD', title: '离线开门 PRD', revision: 2, sha256: 'h2', content: '# 范围\n支持离线开门\n## 异常\n新防重放提示\n新增超时 30s' };
  const delta = computeAssetDelta(r1, r2);
  assert.ok(delta);
  assert.equal(delta.fromRevision, 1);
  assert.equal(delta.toRevision, 2);
  assert.equal(delta.additions, 2);
  assert.equal(delta.deletions, 1);
  assert.deepEqual(delta.changedHeadings, ['异常']);
  assert.equal(computeAssetDelta(r1, r1), null);
});

test('delivery chain v2: custom BLOCK rules, rich report meta, PASS guardrail, deltas and chain-analyze', async () => {
  const { app, expect, token } = await fixture();
  try {
    const task = (await expect('/api/tasks', 'POST', { jiraKey: 'OPAY-901', title: '离线凭证轮换与风控' }, token, 201)).task;
    await expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: '离线开门 PRD', content: '# 范围\n离线开门\n## 验收标准\nAC-1 凭证过期拒绝' }, token, 201);
    await expect(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: '离线开门 PRD', content: '# 范围\n离线开门\n## 验收标准\nAC-1 凭证过期拒绝\nAC-2 新增防重放校验' }, token, 201);

    // Custom natural-language BLOCK rule supports all 6 delivery stages and deletion
    await expect('/api/plugins', 'POST', {
      id: 'offline-replay-block',
      name: '防重放校验强门禁',
      version: '1.0.0',
      stages: ['PRD', 'TASK_BREAKDOWN'],
      enforcement: 'BLOCK',
      rule: 'PRD 与拆分必须包含防重放校验要求。',
    }, token, 201);

    const job = (await expect('/api/reviews', 'POST', { taskId: task.id, stage: 'PRD', executionMode: 'LOCAL_REPORT' }, token, 201)).job;
    assert.equal(job.snapshot.plugins[0].enforcement, 'BLOCK');

    // CRITICAL findings cannot submit with PASS verdict
    await expect(`/api/jobs/${job.id}/report`, 'POST', {
      source: 'LOCAL_TOOL', tool: 'codex', summary: '矛盾结论测试', verdict: 'PASS',
      findings: [{ severity: 'CRITICAL', title: '缺少签名校验', detail: '未定义盐值与轮换策略' }],
    }, token, 400);

    const submitted = (await expect(`/api/jobs/${job.id}/report`, 'POST', {
      source: 'LOCAL_TOOL', tool: 'codex', summary: '发现 1 条防重放规则缺口与 1 条待澄清', verdict: 'FAIL', score: 62,
      checklist: [{ item: '防重放校验强门禁', result: 'FAIL', note: '缺少 nonce 时效说明', ref: 'offline-replay-block' }],
      meta: {
        riskLevel: 'high', effortScore: 3, coverageMetrics: { coveragePrd: 85 },
        clarifyQuestions: [{ id: 'Q-001', question: '离线凭证最大离线天数是多少？', impact: '影响本地缓存 TTL', owner: 'PM' }],
        compliance: { compliant: ['AC-1'], missing: ['AC-2'], manualCheck: ['POS 断网实机'] },
      },
      findings: [{
        severity: 'CRITICAL', category: 'SECURITY', confidence: 9, ruleId: 'offline-replay-block',
        title: '缺少防重放 nonce 机制', detail: '需明确离线凭证唯一 jti', location: '§2.3',
        suggestedPatch: { before: 'token = sign(uid)', after: 'token = sign({ uid, jti: randomUUID() })' },
      }],
    }, token, 201)).job;
    assert.equal(submitted.report.meta.riskLevel, 'high');
    assert.equal(submitted.report.meta.clarifyQuestions[0].id, 'Q-001');
    assert.equal(submitted.findings[0].category, 'SECURITY');
    assert.equal(submitted.findings[0].confidence, 9);
    assert.equal(submitted.findings[0].suggestedPatch.after, 'token = sign({ uid, jti: randomUUID() })');

    const chainRes = await expect(`/api/tasks/${task.id}/chain`, 'GET', undefined, token);
    assert.equal(chainRes.chain.deltas.length, 1);
    assert.equal(chainRes.chain.links[0].delta.toRevision, 2);
    assert.equal(chainRes.chain.links[0].checks.some(c => c.id === 'plugin_offline-replay-block' && c.ok === false && c.level === 'required'), true);
    assert.ok(chainRes.chain.analysis.conflicts.some(c => c.id === 'CONFLICT-PLUGIN_OFFLINE-REPLAY-BLOCK'));

    const analyzeRes = await expect(`/api/tasks/${task.id}/chain-analyze`, 'GET', undefined, token);
    assert.equal(analyzeRes.analysis.metrics.clarifyOpenCount, 1);
    assert.equal(analyzeRes.deltas.length, 1);

    const { markdown } = await expect(`/api/tasks/${task.id}/chain-report`, 'GET', undefined, token);
    assert.match(markdown, /跨环节一致性巡检/);
    assert.match(markdown, /材料变更增量/);
    assert.match(markdown, /待澄清问题（Clarify）/);
    assert.match(markdown, /Q-001/);

    await expect('/api/plugins/offline-replay-block', 'DELETE', undefined, token, 200);
    const afterDelete = await expect('/api/plugins', 'GET', undefined, token);
    assert.equal(afterDelete.plugins.length, 0);
  } finally { await app.close(); }
});

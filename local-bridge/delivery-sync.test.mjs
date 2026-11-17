import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSessionsFromRuns, batches, deploymentsFromDelivery, syncDelivery } from './delivery-sync.mjs';
import { deliverySyncConfig } from './worker.mjs';

const run = (id, conversationId, createdAt, extra = {}) => ({
  id, conversationId, provider: 'codex', model: 'gpt', mode: 'ask', objective: '修复 VMS-748 支付回调\n第二行', status: 'completed', result: '完成', error: '',
  workspacePath: '/Users/me/work/payments', branch: 'fix/pay', usage: { inputTokens: 100, outputTokens: 10, costUsd: null }, createdAt, updatedAt: createdAt, ...extra,
});

test('agent runs are grouped into conversations with titles, totals, jira keys and workspace basenames only', () => {
  const sessions = agentSessionsFromRuns([
    run('r1', 'c1', '2026-11-17T01:00:00.000Z'),
    run('r2', 'c1', '2026-11-17T02:00:00.000Z', { status: 'failed', error: '超时', result: '' }),
    run('r3', undefined, '2026-11-17T00:30:00.000Z', { objective: '', task: { role: 'lead', title: '方案评审' } }),
    { id: 'broken' },
  ], { c1: '需求开发·VMS-748·Adyen' });
  assert.equal(sessions.length, 2);
  const [solo, conversation] = sessions;
  assert.deepEqual([solo.id, solo.title, solo.turns], ['r3', '方案评审', 1]);
  assert.deepEqual([conversation.id, conversation.title, conversation.status, conversation.error, conversation.turns, conversation.inputTokens, conversation.costUsd],
    ['c1', '需求开发·VMS-748·Adyen', 'failed', '超时', 2, 200, 0]);
  assert.deepEqual(conversation.jiraKeys, ['VMS-748']);
  assert.equal(conversation.workspace, 'payments');
  assert.equal(conversation.startedAt, '2026-11-17T01:00:00.000Z');
  assert.equal(conversation.updatedAt, '2026-11-17T02:00:00.000Z');
});

test('Delivery deployment runs map to platform statuses and can be filtered by project name', () => {
  const runs = [
    { id: 'y1', provider: 'yunxiao', projectName: 'example-web', environment: 'pre', jobFullName: '预发', status: 'success', pipelineRunId: '983', bindingId: 'https://flow.aliyun.com/pipelines/1/current', createdAt: '2026-11-16T07:53:08.366Z', updatedAt: '2026-11-16T07:55:27.068Z' },
    { id: 'j1', projectName: 'shop-web', environment: 'test', jobFullName: 'shop/test', status: 'queued', buildNumber: 12, buildUrl: 'https://ci.example.com/job/12/', createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T08:00:01.000Z' },
  ];
  const all = deploymentsFromDelivery(runs, ['*']);
  assert.deepEqual(all.map(item => [item.externalId, item.provider, item.status, item.version, item.finishedAt]), [
    ['jenkins:j1', 'jenkins', 'running', '#12', null],
    ['yunxiao:y1', 'yunxiao', 'success', '#983', '2026-11-16T07:55:27.068Z'],
  ]);
  assert.equal(all[1].url, 'https://flow.aliyun.com/pipelines/1/current');
  assert.deepEqual(deploymentsFromDelivery(runs, ['example']).map(item => item.service), ['example-web']);
});

test('syncDelivery pushes only conversations changed since the saved cursor and configured deployment projects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-sync-'));
  try {
    mkdirSync(join(dir, 'agent-runtimes'));
    writeFileSync(join(dir, 'agent-runtimes', 'agent-runs.json'), JSON.stringify([run('r1', 'c1', '2026-11-17T01:00:00.000Z'), run('r2', 'c2', '2026-11-17T02:00:00.000Z')]));
    writeFileSync(join(dir, 'yunxiao-runs.json'), JSON.stringify([{ id: 'y1', provider: 'yunxiao', projectName: 'example', environment: 'pre', status: 'failed', createdAt: '2026-11-16T07:53:08.366Z', updatedAt: '2026-11-16T07:55:27.068Z' }]));
    const statePath = join(dir, 'state.json');
    const calls = [];
    const call = async (path, body) => { calls.push([path, body]); return path.includes('agent') ? { created: body.items.length, updated: 0, unchanged: 0 } : { created: body.items.length, updated: 0, unchanged: 0 }; };
    const first = await syncDelivery({ dataDir: dir, deployments: { default: ['example'] }, statePath }, call);
    assert.deepEqual(first.agents, { created: 2, updated: 0, unchanged: 0, scanned: 2 });
    assert.deepEqual(first.deployments, { default: { created: 1, updated: 0, unchanged: 0 } });
    assert.deepEqual(calls.map(([path]) => path), ['/api/agent-sessions/sync', '/api/deployments/sync']);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).agentCursor, '2026-11-17T02:00:00.000Z');

    calls.length = 0;
    const second = await syncDelivery({ dataDir: dir, deployments: {}, statePath }, call);
    assert.deepEqual(second.agents.scanned, 0);
    assert.deepEqual(calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deliverySync config requires an existing data directory and valid deployment mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-config-'));
  try {
    assert.equal(deliverySyncConfig(undefined), null);
    assert.deepEqual(deliverySyncConfig({ dataDir: dir, deployments: { default: [' example '] } }).deployments, { default: ['example'] });
    assert.throws(() => deliverySyncConfig({ dataDir: join(dir, 'missing') }), /不存在/);
    assert.throws(() => deliverySyncConfig({ dataDir: dir, token: 'x' }), /仅支持字段/);
    assert.throws(() => deliverySyncConfig({ dataDir: dir, deployments: { 'bad id': ['x'] } }), /项目 ID/);
    assert.throws(() => deliverySyncConfig({ dataDir: dir, intervalMinutes: 0 }), /intervalMinutes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('batches split by item count and serialized size so requests stay under the platform body limit', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ index, text: '中'.repeat(10_000) }));
  const sized = batches(items, 100, 70_000);
  assert.deepEqual(sized.map(batch => batch.length), [2, 2, 1]);
  assert.ok(sized.every(batch => Buffer.byteLength(JSON.stringify(batch)) < 70_000));
  assert.deepEqual(batches([1, 2, 3], 2).map(batch => batch.length), [2, 1]);
  assert.deepEqual(batches([], 2), []);
});

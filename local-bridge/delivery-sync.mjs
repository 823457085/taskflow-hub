import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const AGENT_BATCH = 100;
const DEPLOY_BATCH = 200;
const FILE_MAX = 256 * 1024 * 1024;
const BATCH_BYTES = 100_000;
const JIRA_KEY = /\b[A-Z][A-Z0-9_]{1,30}-\d{1,9}\b/g;
const DEPLOY_STATUS = { dispatching: 'running', queued: 'running', running: 'running', success: 'success', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown' };

async function readJson(path, fallback) {
  let info;
  try { info = await lstat(path); } catch { return fallback; }
  if (!info.isFile() || info.size > FILE_MAX) throw new Error(`无法读取 ${path}：不是普通文件或文件过大`);
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`${path} 不是合法 JSON`); }
}

const firstLine = value => String(value || '').split(/\r?\n/).find(line => line.trim())?.trim() || '';
const clip = (value, max) => { const text = String(value || ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
export function batches(items, maxItems, maxBytes = BATCH_BYTES) {
  const result = [];
  let current = [], size = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (current.length && (current.length >= maxItems || size + bytes > maxBytes)) { result.push(current); current = []; size = 0; }
    current.push(item); size += bytes;
  }
  if (current.length) result.push(current);
  return result;
}
const sum = values => values.reduce((total, value) => total + (Number.isFinite(value) && value > 0 ? value : 0), 0);

export function agentSessionsFromRuns(runs, titles = {}) {
  const conversations = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run.id !== 'string' || !run.createdAt || !run.updatedAt) continue;
    const key = run.conversationId || run.id;
    if (!conversations.has(key)) conversations.set(key, []);
    conversations.get(key).push(run);
  }
  const sessions = [];
  for (const [id, items] of conversations) {
    items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const first = items[0], latest = items[items.length - 1];
    const title = clip(firstLine(titles[id]) || firstLine(first.task?.title && first.task?.role !== 'worker' ? first.task.title : '') || firstLine(first.objective) || '未命名会话', 200);
    const text = `${title}\n${first.objective || ''}\n${first.task?.sourceId || ''}`;
    sessions.push({
      id, title, objective: clip(first.objective, 2000), provider: clip(latest.provider, 40), model: clip(latest.model, 80), mode: clip(latest.mode, 40),
      status: clip(latest.status || 'unknown', 40), result: clip(latest.result, 4000), error: clip(latest.error, 1000),
      workspace: basename(latest.sourceWorkspacePath || latest.workspacePath || ''), branch: clip(latest.branch, 200), turns: items.length,
      inputTokens: sum(items.map(run => run.usage?.inputTokens)), outputTokens: sum(items.map(run => run.usage?.outputTokens)), costUsd: sum(items.map(run => run.usage?.costUsd)),
      jiraKeys: [...new Set(text.match(JIRA_KEY) || [])].slice(0, 5), startedAt: first.createdAt, updatedAt: items.reduce((max, run) => run.updatedAt > max ? run.updatedAt : max, latest.updatedAt),
    });
  }
  return sessions.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function deploymentsFromDelivery(runs, match = []) {
  const wanted = name => !match.length || match.includes('*') || match.some(item => name === item || name.includes(item));
  return (Array.isArray(runs) ? runs : []).filter(run => run && run.id && run.environment && run.createdAt && wanted(run.projectName || '')).map(run => {
    const provider = run.provider === 'yunxiao' ? 'yunxiao' : 'jenkins';
    const status = DEPLOY_STATUS[run.status] || 'unknown';
    const number = run.buildNumber ?? run.pipelineRunId;
    const link = [run.buildUrl, run.bindingId].find(value => typeof value === 'string' && /^https?:\/\//.test(value)) || '';
    return {
      externalId: `${provider}:${run.id}`, provider, environment: clip(run.environment, 40), service: clip(run.projectName || run.jobFullName || '未命名服务', 120),
      version: number !== undefined && number !== null ? `#${number}` : '', status, url: link,
      notes: clip([run.jobFullName, run.error].filter(Boolean).join('；'), 2000), startedAt: run.createdAt, finishedAt: status === 'running' ? null : run.updatedAt || null,
    };
  }).sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, DEPLOY_BATCH);
}

export async function syncDelivery({ dataDir, deployments = {}, statePath }, call) {
  const runs = await readJson(join(dataDir, 'agent-runtimes', 'agent-runs.json'), []);
  const titles = await readJson(join(dataDir, 'agent-runtimes', 'conversation-titles.json'), {});
  const state = statePath ? await readJson(statePath, {}) : {};
  const cursor = typeof state.agentCursor === 'string' ? state.agentCursor : '';
  const pending = agentSessionsFromRuns(runs, titles).filter(item => item.updatedAt > cursor);
  const agents = { created: 0, updated: 0, unchanged: 0 };
  let nextCursor = cursor;
  for (const batch of batches(pending, AGENT_BATCH)) {
    const result = await call('/api/agent-sessions/sync', { source: 'delivery', items: batch });
    for (const key of Object.keys(agents)) agents[key] += result[key] || 0;
    nextCursor = batch[batch.length - 1].updatedAt;
  }
  const deployRuns = [
    ...await readJson(join(dataDir, 'yunxiao-runs.json'), []),
    ...((await readJson(join(dataDir, 'jenkins-deployments.json'), {})).runs || []),
  ];
  const deploys = {};
  for (const [projectId, match] of Object.entries(deployments)) {
    const total = { created: 0, updated: 0, unchanged: 0 };
    for (const batch of batches(deploymentsFromDelivery(deployRuns, match), DEPLOY_BATCH)) {
      const result = await call('/api/deployments/sync', { projectId, items: batch });
      for (const key of Object.keys(total)) total[key] += result[key] || 0;
    }
    deploys[projectId] = total;
  }
  if (statePath && nextCursor !== cursor) await writeFile(statePath, `${JSON.stringify({ ...state, agentCursor: nextCursor }, null, 2)}\n`, { mode: 0o600 });
  return { agents: { ...agents, scanned: pending.length }, deployments: deploys };
}

// Delivery chain: one requirement = one chain of six links (需求 → Jira任务与子任务 → 技术方案 → 代码·分支·仓库 → 测试用例 → 上线).
// Each link exposes the same structure — linked objects, deterministic rule checks, the AI review result and one next action —
// so the UI and the exported report can describe every link the same way.
import { existsSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHAIN_STAGES, taskRow } from './common.mjs';
import { CHAIN_LINKS } from './review-rubrics.mjs';

const KIND_LABEL = { PRD: '需求文档', TECH_SPEC: '技术方案', CODE: '代码改动', TEST_CASE: '测试用例', RELEASE_PLAN: '上线计划', SUBTASKS: '研发子任务' };
const STAGE_KIND = { PRD: 'PRD', TASK_BREAKDOWN: null, TECH_SPEC: 'TECH_SPEC', CODE_REVIEW: 'CODE', TEST_CASE: 'TEST_CASE', RELEASE: 'RELEASE_PLAN' };
const KIND_LINK_ID = { PRD: 'REQUIREMENT', TECH_SPEC: 'TECH_SPEC', CODE: 'CODE', TEST_CASE: 'TEST', RELEASE_PLAN: 'RELEASE' };
const CONSTITUTION_CANDIDATES = ['AGENTS.md', '.specify/memory/constitution.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', '.clinerules'];

function quickConstitutionFiles(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') return [];
  const found = [];
  for (const rel of CONSTITUTION_CANDIDATES) {
    try {
      const full = join(repoPath, rel);
      if (existsSync(full) && lstatSync(full).isFile()) found.push(rel);
    } catch { /* ignore inaccessible or TCC-protected dir */ }
  }
  return found;
}

// Lightweight OpenSpec-style revision delta between the latest two revisions of an asset.
export function computeAssetDelta(prevAsset, currAsset) {
  if (!prevAsset || !currAsset || prevAsset.id === currAsset.id || prevAsset.sha256 === currAsset.sha256) return null;
  const splitLines = text => String(text || '').replace(/\r\n/g, '\n').split('\n').slice(0, 1200);
  const oldLines = splitLines(prevAsset.content);
  const newLines = splitLines(currAsset.content);
  const oldCounts = new Map();
  const newCounts = new Map();
  for (const line of oldLines) { const k = line.trim(); if (k) oldCounts.set(k, (oldCounts.get(k) || 0) + 1); }
  for (const line of newLines) { const k = line.trim(); if (k) newCounts.set(k, (newCounts.get(k) || 0) + 1); }

  const removed = [];
  const added = [];
  const seenOld = new Map();
  for (const line of oldLines) {
    const k = line.trim();
    if (!k) continue;
    const nth = (seenOld.get(k) || 0) + 1; seenOld.set(k, nth);
    if (nth > (newCounts.get(k) || 0)) removed.push(line);
  }
  const seenNew = new Map();
  const changedHeadings = new Set();
  let currentHeading = '';
  for (const line of newLines) {
    const headingMatch = /^#{1,4}\s+(.+)$/.exec(line.trim()) || /^\*([^*]{2,40})\*$/.exec(line.trim());
    if (headingMatch) currentHeading = headingMatch[1].trim();
    const k = line.trim();
    if (!k) continue;
    const nth = (seenNew.get(k) || 0) + 1; seenNew.set(k, nth);
    if (nth > (oldCounts.get(k) || 0)) {
      added.push(line);
      if (currentHeading) changedHeadings.add(currentHeading);
    }
  }
  const previewLines = [
    ...removed.slice(0, 8).map(text => ({ kind: '-', text: text.slice(0, 200) })),
    ...added.slice(0, 10).map(text => ({ kind: '+', text: text.slice(0, 200) })),
  ];
  return {
    assetId: currAsset.id,
    kind: currAsset.kind,
    linkId: KIND_LINK_ID[currAsset.kind] || null,
    title: currAsset.title,
    fromRevision: prevAsset.revision,
    toRevision: currAsset.revision,
    additions: added.length,
    deletions: removed.length,
    changedHeadings: [...changedHeadings].slice(0, 6),
    previewLines,
  };
}
export const LINK_STATUS_LABEL = {
  MISSING: '缺资料', READY: '待 AI 审核', REVIEWING: '审核中', AWAITING_DECISION: '待确认',
  PASS: '通过', CONDITIONAL: '有条件通过', CHANGES_REQUESTED: '退回修改', BLOCKED: '阻断', STALE: '需重审',
};
const VERDICT_LABEL = { PASS: '通过', CONDITIONAL: '有条件通过', FAIL: '不通过' };
const RESULT_MARK = { PASS: '✅', WARN: '⚠️', FAIL: '❌', NA: '➖' };
const JIRA_KEY = /\b[A-Z][A-Z0-9]+-[1-9]\d*\b/g;

export const jiraKeysIn = text => [...new Set(String(text || '').match(JIRA_KEY) || [])];

// Jira wiki descriptions use "*标题*" lines as section headings.
export function descriptionSections(description) {
  const sections = {}; let current = '_';
  for (const line of String(description || '').split(/\r?\n/)) {
    const heading = /^\s*\*([^*]{1,30})\*\s*$/.exec(line);
    if (heading) { current = heading[1].trim(); sections[current] = sections[current] || ''; continue; }
    sections[current] = `${sections[current] || ''}${line}\n`;
  }
  return sections;
}

export function declaredRepository(description) {
  const match = /仓库[：:]\s*([A-Za-z0-9_.\-/]+)/.exec(String(description || ''));
  return match ? match[1].replace(/[。，,;；]+$/, '') : null;
}

// Requirement source keys: Jira parent requirement, or keys listed under 需求来源.
export function requirementKeys(task) {
  const ref = task.externalRef || {};
  const sections = descriptionSections(ref.description);
  const sourceText = sections['需求来源'] || '';
  const keys = jiraKeysIn(sourceText).filter(key => key !== task.jiraKey);
  // "父任务：XXX" inside 需求来源 points at the parent dev task, not at the requirement.
  const parentLine = /父任务[：:]\s*\[?([A-Z][A-Z0-9]+-[1-9]\d*)/.exec(sourceText);
  return keys.filter(key => key !== parentLine?.[1]);
}

// Work items the Jira task promises (交付物 / 相关开发事项) — used to spot sub-items that exist in Jira but are not linked here.
export function declaredDeliverableKeys(task) {
  const ref = task.externalRef || {};
  const sections = descriptionSections(ref.description);
  const text = `${sections['交付物'] || ''}\n${(String(ref.description || '').match(/相关开发事项[^\n]*/g) || []).join('\n')}`;
  const exclude = new Set([task.jiraKey, ...requirementKeys(task)]);
  return jiraKeysIn(text).filter(key => !exclude.has(key));
}

export function parseMergeRequest(asset, remoteVersion) {
  const content = String(asset.content || '');
  let snapshot = null;
  try { snapshot = remoteVersion ? JSON.parse(remoteVersion).mergeSnapshot || null : null; } catch { snapshot = null; }
  let json = null;
  if (content.trim().startsWith('{')) { try { json = JSON.parse(content); } catch { json = null; } }
  const branch = /分支：`([^`]+)`\s*→\s*`([^`]+)`/.exec(content);
  const localBranch = /当前分支：\s*(\S+)/.exec(content);
  const state = /- 状态：\s*(\S+)/.exec(content)?.[1] || json?.state || null;
  const number = /MR [#!](\d+)/.exec(content)?.[1] || (json?.iid ? String(json.iid) : null);
  return {
    assetId: asset.id, title: asset.title, url: asset.sourceUrl || null, revision: asset.revision,
    number, state,
    sourceBranch: branch?.[1] || snapshot?.sourceBranch || json?.sourceBranch || localBranch?.[1] || null,
    targetBranch: branch?.[2] || snapshot?.targetBranch || json?.targetBranch || null,
    local: !!localBranch || content.startsWith('# 本地 Git 代码快照'),
    truncated: content.includes('已截断'),
  };
}

const latestAssets = assets => {
  const latest = new Map();
  for (const asset of assets) if (!latest.has(`${asset.kind}:${asset.logicalKey}`)) latest.set(`${asset.kind}:${asset.logicalKey}`, asset);
  return [...latest.values()];
};

export function linkStatus(gate, job) {
  if (!gate || gate.status === 'MISSING_INPUT') return 'MISSING';
  if (gate.status === 'STALE') return 'STALE';
  if (gate.status === 'PASS') return job?.report?.verdict === 'CONDITIONAL' ? 'CONDITIONAL' : 'PASS';
  if (gate.status === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  if (gate.status === 'BLOCKED') return 'BLOCKED';
  if (!job) return 'READY';
  if (!job.report) return 'REVIEWING';
  return 'AWAITING_DECISION';
}

function nextAction(status, link, gate, job, missing) {
  const stage = link.stage;
  if (status === 'MISSING') {
    if (missing.includes('SUBTASKS')) return { type: 'ADD_SUBTASKS', label: '导入或拆分子任务' };
    const kind = missing.find(item => item !== 'SUBTASKS') || STAGE_KIND[stage];
    return { type: 'ADD_INPUT', label: `补充${KIND_LABEL[kind] || '材料'}`, assetKind: kind };
  }
  if (status === 'READY') return { type: 'AI_REVIEW', label: 'AI 审核此环节', stage };
  if (status === 'STALE') return { type: 'AI_REVIEW', label: '材料已变化，重新 AI 审核', stage };
  if (status === 'REVIEWING') return { type: 'AI_REVIEW', label: 'AI 生成审核报告', stage, jobId: job.id };
  if (status === 'AWAITING_DECISION') return { type: 'DECIDE', label: '查看报告并确认', stage, jobId: job.id };
  if (status === 'CHANGES_REQUESTED' || status === 'BLOCKED') {
    if (stage === 'RELEASE' && !job?.findings?.some(item => item.severity === 'CRITICAL' && !item.waiver) && gate?.reason) return { type: 'VIEW', label: '先处理前序环节', stage, jobId: job?.id };
    return { type: 'FIX', label: '按报告修复后重审', stage, jobId: job?.id };
  }
  return { type: 'VIEW', label: '查看报告', stage, jobId: job?.id };
}

const reviewSummary = job => job ? {
  jobId: job.id, status: job.status, stale: job.stale, createdAt: job.createdAt, executionMode: job.executionMode,
  verdict: job.report?.verdict || null, score: job.report?.score ?? null, summary: job.report?.summary || '', tool: job.report?.tool || null,
  reportedAt: job.report?.createdAt || null, checklist: job.report?.checklist || [],
  ...(job.report?.meta ? { meta: job.report.meta } : {}),
  findings: {
    critical: job.findings.filter(item => item.severity === 'CRITICAL' && !item.waiver).length,
    warn: job.findings.filter(item => item.severity === 'WARN').length,
    info: job.findings.filter(item => item.severity === 'INFO').length,
    waived: job.findings.filter(item => item.waiver).length,
    items: job.findings.map(item => ({
      id: item.id, severity: item.severity, title: item.title, detail: item.detail, location: item.location, waived: !!item.waiver,
      ...(item.category ? { category: item.category } : {}),
      ...(Number.isInteger(item.confidence) ? { confidence: item.confidence } : {}),
      ...(item.ruleId ? { ruleId: item.ruleId } : {}),
      ...(item.suggestedPatch ? { suggestedPatch: item.suggestedPatch } : {}),
    })),
  },
  decision: job.decision ? { decision: job.decision.decision, reason: job.decision.reason, createdAt: job.decision.createdAt } : null,
} : null;

export function createDeliveryChain({ db, workflow, workspaceFor }) {
  const userName = id => (id ? db.prepare('SELECT username FROM users WHERE id=?').get(id)?.username || null : null);
  const importsFor = taskId => {
    const rows = db.prepare(`SELECT local_id, resource, remote_version FROM external_imports WHERE task_id=?
      UNION ALL SELECT local_id, resource, remote_version FROM account_external_imports WHERE task_id=?`).all(taskId, taskId);
    return new Map(rows.map(row => [row.local_id, row]));
  };
  const jobFor = (task, gate, stage, memo) => {
    if (gate?.jobId) return workflow.jobRow(db.prepare('SELECT * FROM jobs WHERE id=?').get(gate.jobId), task, memo);
    const latest = db.prepare('SELECT * FROM jobs WHERE task_id=? AND stage=? ORDER BY rowid DESC LIMIT 1').get(task.id, stage);
    return latest ? workflow.jobRow(latest, task, memo) : null;
  };
  const gatesFor = (task, memo) => {
    const five = workflow.gates(task, memo).gates;
    const byStage = Object.fromEntries(five.map(item => [item.stage, item]));
    byStage.TASK_BREAKDOWN = workflow.gate(task, 'TASK_BREAKDOWN', undefined, memo);
    return byStage;
  };

  // Compact per-task statuses, used for child rows and the task list "链路进度" column.
  function statusesFor(task, memo = workflow.createMemo()) {
    const gates = gatesFor(task, memo);
    return Object.fromEntries(CHAIN_STAGES.map(stage => [stage, linkStatus(gates[stage], gates[stage]?.jobId ? { report: reportLite(gates[stage].jobId) } : null)]));
  }
  const reportLite = jobId => {
    const row = db.prepare('SELECT verdict FROM reports WHERE job_id=?').get(jobId);
    return row ? { verdict: row.verdict } : null;
  };

  function chainFor(task, user) {
    const memo = workflow.createMemo();
    const ref = task.externalRef || {};
    const baseUrl = ref.baseUrl || null;
    const jiraUrl = key => (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${key}` : null);
    const allAssets = workflow.assetsFor(task.id);
    memo.assets.set(task.id, allAssets);
    const assets = latestAssets(allAssets);
    const ofKind = kind => assets.filter(asset => asset.kind === kind);
    const deltas = [];
    const bySeries = new Map();
    for (const asset of allAssets) {
      const k = `${asset.kind}:${asset.logicalKey}`;
      if (!bySeries.has(k)) bySeries.set(k, []);
      bySeries.get(k).push(asset);
    }
    for (const series of bySeries.values()) {
      if (series.length >= 2) {
        const delta = computeAssetDelta(series[1], series[0]);
        if (delta) deltas.push(delta);
      }
    }
    const imports = importsFor(task.id);
    const children = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY jira_key').all(task.id).map(taskRow);
    const parent = task.parentId ? taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.parentId)) : null;
    const gates = gatesFor(task, memo);
    const reqKeys = requirementKeys(task);
    const declaredKeys = declaredDeliverableKeys(task);
    const knownKeys = new Set([...children.map(child => child.jiraKey), ...(parent ? [parent.jiraKey] : [])]);
    const notLinked = declaredKeys.filter(key => !knownKeys.has(key));
    const repo = declaredRepository(ref.description);
    const workspace = workspaceFor(user.id, task.projectId);
    const constitutionFiles = quickConstitutionFiles(workspace?.repoPath);
    const projectPlugins = db.prepare('SELECT manifest FROM plugins WHERE project_id=? ORDER BY id').all(task.projectId).map(r => JSON.parse(r.manifest));
    const codeAssets = ofKind('CODE');
    const mrs = codeAssets.map(asset => parseMergeRequest(asset, imports.get(asset.id)?.remote_version));
    const branchKeys = new Set([task.jiraKey, ...reqKeys, ...children.map(child => child.jiraKey), ...(parent ? [parent.jiraKey] : [])]);
    const progressBranch = db.prepare('SELECT branch FROM progress_events WHERE task_id=? AND branch IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(task.id)?.branch || null;
    const branches = [...new Set([...mrs.map(mr => mr.sourceBranch).filter(Boolean), ...(progressBranch ? [progressBranch] : [])])];
    const prdText = ofKind('PRD').map(asset => asset.content).join('\n');
    const releaseText = ofKind('RELEASE_PLAN').map(asset => asset.content).join('\n');
    const gatePass = stage => gates[stage]?.status === 'PASS';
    const assetObject = asset => ({ type: 'asset', kind: asset.kind, label: asset.title, url: asset.sourceUrl, meta: `r${asset.revision}`, assetId: asset.id });

    const pluginChecksFor = (stage, job) => {
      const stagePlugins = projectPlugins.filter(p => Array.isArray(p.stages) && p.stages.includes(stage));
      const checklist = job?.report?.checklist || [];
      return stagePlugins.map(p => {
        const matched = checklist.find(c => (c.ref && c.ref.includes(p.id)) || (c.item && c.item.includes(p.name)));
        const ok = matched ? (matched.result === 'PASS' ? true : matched.result === 'NA' ? null : false) : null;
        return {
          id: `plugin_${p.id}`,
          label: `门禁规则：${p.name}`,
          ok,
          level: p.enforcement === 'BLOCK' ? 'required' : 'advice',
          detail: matched ? (matched.note || matched.result) : (p.rule || '待 AI 审核时逐项核验'),
        };
      });
    };

    const linkDefs = {
      REQUIREMENT: () => ({
        objects: [
          ...reqKeys.map(key => ({ type: 'jira', label: `需求单 ${key}`, url: jiraUrl(key), key })),
          ...ofKind('PRD').map(assetObject),
          ...(ref.fixVersions?.length ? [{ type: 'meta', label: `Fix Version ${ref.fixVersions.map(item => item.name).join(' / ')}` }] : []),
        ],
        checks: [
          { id: 'req_source', label: '能识别到需求单', ok: reqKeys.length > 0 || !!ref.parentKey, level: 'advice', detail: reqKeys.length ? reqKeys.join('、') : '任务描述「需求来源」中没有需求单号' },
          { id: 'prd_asset', label: '需求文档已导入', ok: ofKind('PRD').length > 0, level: 'required', detail: ofKind('PRD').map(asset => asset.title).join('、') || '缺少 PRD，可从 Confluence 链接一键导入' },
          { id: 'prd_acceptance', label: '需求含验收标准', ok: ofKind('PRD').length ? /验收|acceptance|\bAC\b|预期结果/i.test(prdText) : null, level: 'advice', detail: '建议 PRD 写明逐条可测的验收标准' },
          { id: 'fix_version', label: '已设置 Fix Version', ok: task.externalRef ? !!ref.fixVersions?.length : null, level: 'advice', detail: ref.fixVersions?.map(item => item.name).join(' / ') || '未设置版本' },
        ],
      }),
      BREAKDOWN: () => ({
        objects: [
          { type: 'jira', label: `研发任务 ${task.jiraKey}`, url: jiraUrl(task.jiraKey), key: task.jiraKey, meta: ref.status || null },
          ...children.map(child => ({ type: 'task', label: `${child.jiraKey} ${child.title}`, taskId: child.id, url: jiraUrl(child.jiraKey), meta: child.externalRef?.status || child.status, assignee: userName(child.assigneeId) })),
          ...notLinked.map(key => ({ type: 'jira-unlinked', label: `${key}（描述中声明，未导入）`, url: jiraUrl(key), key })),
        ],
        checks: [
          { id: 'jira_verified', label: '任务已从 Jira 校验', ok: task.jiraStatus === 'verified' || !!task.externalRef, level: 'advice', detail: task.externalRef ? `${ref.issueType?.name || ref.type || ''} · ${ref.status || ''}` : '本地任务，未关联 Jira' },
          { id: 'assignee', label: '有受理人', ok: !!task.assigneeId, level: 'required', detail: userName(task.assigneeId) || '未指派' },
          { id: 'subtasks', label: '已关联研发子任务', ok: children.length > 0, level: 'required', detail: children.length ? `${children.length} 个：${children.map(child => child.jiraKey).join('、')}` : '暂无子任务' },
          { id: 'declared_linked', label: '描述中声明的事项均已导入', ok: declaredKeys.length ? notLinked.length === 0 : null, level: 'advice', detail: notLinked.length ? `未导入：${notLinked.join('、')}` : declaredKeys.join('、') || '描述未声明事项' },
          { id: 'children_assignee', label: '子任务均有受理人', ok: children.length ? children.every(child => child.assigneeId) : null, level: 'advice', detail: children.filter(child => !child.assigneeId).map(child => child.jiraKey).join('、') || '—' },
          { id: 'coverage_types', label: '覆盖方案 / 实现 / 自测', ok: children.length || declaredKeys.length ? ['方案', '(开发|实现)', '(自测|联调|测试)'].every(pattern => new RegExp(pattern).test(`${children.map(child => child.title).join(' ')} ${ref.description || ''}`)) : null, level: 'advice', detail: '建议拆出技术方案、开发实现、联调自测三类子任务' },
        ],
      }),
      TECH_SPEC: () => ({
        objects: ofKind('TECH_SPEC').map(assetObject),
        checks: [
          { id: 'spec_asset', label: '技术方案已登记', ok: ofKind('TECH_SPEC').length > 0, level: 'required', detail: ofKind('TECH_SPEC').map(asset => asset.title).join('、') || '缺少技术方案' },
          { id: 'spec_source', label: '方案有原文链接', ok: ofKind('TECH_SPEC').length ? ofKind('TECH_SPEC').every(asset => asset.sourceUrl) : null, level: 'advice', detail: '建议从 Confluence 导入，便于追溯版本' },
          { id: 'upstream_prd', label: '需求环节已通过', ok: gatePass('PRD'), level: 'advice', detail: gatePass('PRD') ? '需求已确认' : '需求尚未确认，方案可能需要随需求调整' },
        ],
      }),
      CODE: () => ({
        objects: [
          ...(repo ? [{ type: 'repo', label: `声明仓库 ${repo}` }] : []),
          ...(workspace?.repoPath ? [{ type: 'repo-local', label: `本机仓库 ${basename(workspace.repoPath)}`, meta: workspace.repoPath }] : []),
          ...mrs.map(mr => ({ type: mr.local ? 'local-diff' : 'mr', label: mr.local ? mr.title : `MR ${mr.number ? `#${mr.number} ` : ''}${mr.title.replace(/^#\d+\s*·\s*/, '')}`, url: mr.url, meta: [mr.sourceBranch && mr.targetBranch ? `${mr.sourceBranch} → ${mr.targetBranch}` : mr.sourceBranch, mr.state].filter(Boolean).join(' · ') || null, assetId: mr.assetId })),
          ...(progressBranch && !mrs.some(mr => mr.sourceBranch === progressBranch) ? [{ type: 'branch', label: `分支 ${progressBranch}` }] : []),
        ],
        checks: [
          { id: 'repo_declared', label: '任务声明了仓库', ok: task.externalRef ? !!repo : null, level: 'advice', detail: repo || 'Jira 描述中没有「仓库：xxx」' },
          { id: 'repo_bound', label: '本机仓库与声明一致', ok: workspace?.repoPath ? (repo ? basename(workspace.repoPath) === repo : true) : false, level: 'advice', detail: workspace?.repoPath ? `${basename(workspace.repoPath)}${repo && basename(workspace.repoPath) !== repo ? `（声明为 ${repo}）` : ''}` : '尚未绑定本机仓库' },
          { id: 'code_asset', label: '已关联代码改动', ok: codeAssets.length > 0, level: 'required', detail: codeAssets.length ? `${codeAssets.length} 份` : '导入 MR 或提取本地 Git 改动' },
          { id: 'mr_linked', label: '已关联 MR', ok: mrs.some(mr => !mr.local), level: 'advice', detail: mrs.filter(mr => !mr.local).map(mr => `#${mr.number || '?'}`).join('、') || '仅有本地 diff，无法追踪合并' },
          { id: 'branch_key', label: '分支名包含 Jira 号', ok: branches.length ? branches.every(name => [...branchKeys].some(key => name.toUpperCase().includes(key))) : null, level: 'advice', detail: branches.join('、') || '未识别到分支' },
          { id: 'mr_target', label: 'MR 目标分支已明确', ok: mrs.some(mr => !mr.local) ? mrs.filter(mr => !mr.local).every(mr => mr.targetBranch) : null, level: 'advice', detail: mrs.filter(mr => mr.targetBranch).map(mr => `→ ${mr.targetBranch}`).join('、') || '—' },
          { id: 'diff_complete', label: '代码 diff 完整', ok: codeAssets.length ? !mrs.some(mr => mr.truncated) : null, level: 'advice', detail: mrs.some(mr => mr.truncated) ? '存在被截断的 diff，AI 审核可能不完整' : '完整' },
          { id: 'upstream_spec', label: '技术方案已通过', ok: gatePass('TECH_SPEC'), level: 'advice', detail: gatePass('TECH_SPEC') ? '可对照方案审核代码' : '方案未确认，代码审核缺少依据' },
        ],
      }),
      TEST: () => ({
        objects: ofKind('TEST_CASE').map(assetObject),
        checks: [
          { id: 'test_asset', label: '测试用例已登记', ok: ofKind('TEST_CASE').length > 0, level: 'required', detail: ofKind('TEST_CASE').map(asset => asset.title).join('、') || '缺少测试用例' },
          { id: 'upstream_spec', label: '技术方案已通过', ok: gatePass('TECH_SPEC'), level: 'advice', detail: '用例应基于确认后的方案与需求' },
        ],
      }),
      RELEASE: () => ({
        objects: ofKind('RELEASE_PLAN').map(assetObject),
        checks: [
          { id: 'release_asset', label: '上线计划已登记', ok: ofKind('RELEASE_PLAN').length > 0, level: 'required', detail: ofKind('RELEASE_PLAN').map(asset => asset.title).join('、') || '缺少上线计划' },
          { id: 'upstream_all', label: '前序门禁全部通过', ok: ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE'].every(gatePass), level: 'required', detail: ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE'].filter(stage => !gatePass(stage)).map(stage => CHAIN_LINKS.find(link => link.stage === stage).title).join('、') ? `未通过：${['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE'].filter(stage => !gatePass(stage)).map(stage => CHAIN_LINKS.find(link => link.stage === stage).title).join('、')}` : '全部通过' },
          { id: 'rollback', label: '含回滚方案', ok: ofKind('RELEASE_PLAN').length ? /回滚|rollback/i.test(releaseText) : null, level: 'advice', detail: '上线计划需写明回滚步骤与触发条件' },
        ],
      }),
    };

    const links = CHAIN_LINKS.map((link, index) => {
      const gate = gates[link.stage];
      const job = jobFor(task, gate, link.stage, memo);
      const { objects, checks: baseChecks } = linkDefs[link.id]();
      const checks = [...baseChecks, ...pluginChecksFor(link.stage, job)];
      const missing = gate?.status === 'MISSING_INPUT' ? workflow.inputs(task, link.stage, undefined, memo).missing : [];
      const status = linkStatus(gate, job && gate?.jobId ? job : null);
      const linkDelta = deltas.find(d => d.linkId === link.id) || null;
      return {
        id: link.id, index: index + 1, stage: link.stage, title: link.title, purpose: link.purpose, focus: link.rubric,
        advisory: link.stage === 'TASK_BREAKDOWN', status, statusLabel: LINK_STATUS_LABEL[status], gateReason: gate?.reason || '',
        missing: missing.map(kind => KIND_LABEL[kind] || kind), objects, checks,
        ...(linkDelta ? { delta: linkDelta } : {}),
        review: reviewSummary(job), next: nextAction(status, link, gate, job, missing),
      };
    });

    const gating = links.filter(link => !link.advisory);
    const scores = links.map(link => link.review?.score).filter(score => Number.isInteger(score));
    const blockers = [];
    for (const link of links) {
      for (const check of link.checks) if (check.level === 'required' && check.ok === false) blockers.push({ linkId: link.id, link: link.title, kind: 'check', title: check.label, detail: check.detail });
      for (const item of link.review?.findings.items || []) if (item.severity === 'CRITICAL' && !item.waived && !link.review.stale) blockers.push({ linkId: link.id, link: link.title, kind: 'finding', title: item.title, detail: item.detail });
      if (link.status === 'CHANGES_REQUESTED' && link.review?.decision) blockers.push({ linkId: link.id, link: link.title, kind: 'decision', title: '审批退回', detail: link.review.decision.reason });
    }
    const overallStatus = gating.every(link => link.status === 'PASS' || link.status === 'CONDITIONAL') ? 'PASS'
      : links.some(link => ['CHANGES_REQUESTED', 'BLOCKED'].includes(link.status)) ? 'BLOCKED' : 'IN_PROGRESS';
    const current = links.find(link => !['PASS', 'CONDITIONAL'].includes(link.status)) || null;

    const childRows = children.map(child => ({ id: child.id, jiraKey: child.jiraKey, title: child.title, status: child.status, jiraStatus: child.externalRef?.status || null, assignee: userName(child.assigneeId), url: jiraUrl(child.jiraKey), links: statusesFor(child, memo) }));
    const breakdown = links.find(link => link.id === 'BREAKDOWN');
    const checklist = breakdown.review?.checklist || [];
    const reqPoints = checklist.filter(item => /PRD|需求点|验收|\bAC\b|§/i.test(item.item));
    const traceRows = reqPoints.length ? reqPoints : checklist.filter(item => jiraKeysIn(item.ref).length);
    const traceability = traceRows.map(item => ({
      point: item.item, result: item.result, note: item.note,
      tasks: jiraKeysIn(item.ref).map(key => { const child = childRows.find(row => row.jiraKey === key); return { key, title: child?.title || null, taskId: child?.id || null, links: child?.links || null }; }),
    }));

    // Deterministic cross-artifact analysis (/analyze lint + coverage metrics).
    const prdLink = links.find(link => link.id === 'REQUIREMENT');
    const specLink = links.find(link => link.id === 'TECH_SPEC');
    const testLink = links.find(link => link.id === 'TEST');
    const ratioOf = items => {
      const active = (items || []).filter(item => item.result !== 'NA');
      if (!active.length) return null;
      return Math.round((active.filter(item => item.result === 'PASS').length / active.length) * 100);
    };
    const specAcRows = (specLink?.review?.checklist || []).filter(item => /需求|PRD|\bAC\b|验收|Coverage/i.test(item.item));
    const coveragePrd = specLink?.review?.meta?.coverageMetrics?.coveragePrd
      ?? (specAcRows.length ? ratioOf(specAcRows) : ratioOf(reqPoints));
    const testAcRows = (testLink?.review?.checklist || []).filter(item => /验收|\bAC\b|需求|Trace/i.test(item.item));
    const traceAc = testLink?.review?.meta?.coverageMetrics?.traceAc
      ?? (testAcRows.length ? ratioOf(testAcRows) : null);
    const prdClarifyQs = prdLink?.review?.meta?.clarifyQuestions || [];
    const openClarifyQs = prdClarifyQs.filter(q => !q.resolved);
    const clarifyChecklistOpen = (prdLink?.review?.checklist || []).filter(item => /歧义|待确认|Clarify/i.test(item.item) && ['WARN', 'FAIL'].includes(item.result));
    const clarifyOpenCount = openClarifyQs.length || clarifyChecklistOpen.length;

    const conflicts = [];
    const parentVersions = new Set((ref.fixVersions || []).map(v => v?.name).filter(Boolean));
    if (parentVersions.size) {
      const driftChildren = children.filter(c => {
        const cVers = (c.externalRef?.fixVersions || []).map(v => v?.name).filter(Boolean);
        return cVers.length > 0 && !cVers.some(v => parentVersions.has(v));
      });
      if (driftChildren.length) {
        conflicts.push({
          id: 'CONFLICT-FIXVERSION', severity: 'WARN', category: 'SPEC_ALIGN',
          title: '父子任务 Fix Version 不一致',
          detail: `主任务版本 ${[...parentVersions].join('/')}，以下子任务版本不一致：${driftChildren.map(c => c.jiraKey).join('、')}`,
          linkIds: ['REQUIREMENT', 'BREAKDOWN'],
        });
      }
    }
    if (repo && workspace?.repoPath && basename(workspace.repoPath) !== repo) {
      conflicts.push({
        id: 'CONFLICT-REPO', severity: 'WARN', category: 'CONTRACT',
        title: '声明仓库与已绑本机仓库目录不一致',
        detail: `Jira 声明仓库「${repo}」，本机当前绑定「${basename(workspace.repoPath)}」`,
        linkIds: ['BREAKDOWN', 'CODE'],
      });
    }
    if (notLinked.length) {
      conflicts.push({
        id: 'CONFLICT-UNLINKED-SUBTASK', severity: 'WARN', category: 'SPEC_ALIGN',
        title: 'Jira 描述中声明的交付事项尚未全部导入',
        detail: `未导入工作台：${notLinked.join('、')}`,
        linkIds: ['BREAKDOWN'],
      });
    }
    const staleLinks = links.filter(l => l.status === 'STALE');
    if (staleLinks.length) {
      conflicts.push({
        id: 'CONFLICT-STALE-DRIFT', severity: 'WARN', category: 'SPEC_ALIGN',
        title: `${staleLinks.length} 个环节受材料或策略变更影响需重审`,
        detail: `${staleLinks.map(l => l.title).join('、')}${deltas.length ? `（已检测 ${deltas.map(d => `${d.title} r${d.fromRevision}→r${d.toRevision}`).join('、')}）` : ''}`,
        linkIds: staleLinks.map(l => l.id),
      });
    }
    if (openClarifyQs.length && (ofKind('TECH_SPEC').length || codeAssets.length)) {
      conflicts.push({
        id: 'CONFLICT-CLARIFY-OPEN', severity: 'WARN', category: 'SPEC_ALIGN',
        title: `需求存在 ${openClarifyQs.length} 条待澄清问题未闭环`,
        detail: openClarifyQs.slice(0, 3).map(q => `${q.id}: ${q.question}`).join('；'),
        linkIds: ['REQUIREMENT', 'TECH_SPEC'],
      });
    }
    for (const link of links) {
      for (const check of link.checks) {
        if (check.id.startsWith('plugin_') && check.ok === false) {
          conflicts.push({
            id: `CONFLICT-${check.id.toUpperCase()}`,
            severity: check.level === 'required' ? 'CRITICAL' : 'WARN',
            category: 'SPEC_ALIGN',
            title: `[${link.title}] ${check.label}未满足`,
            detail: check.detail,
            linkIds: [link.id],
          });
        }
      }
    }

    const analysis = {
      metrics: {
        coveragePrd,
        traceAc,
        clarifyOpenCount,
        constitutionCount: constitutionFiles.length,
        customRuleCount: projectPlugins.length,
        conflictCount: conflicts.length,
      },
      constitutionFiles,
      conflicts,
    };

    return {
      generatedAt: new Date().toISOString(),
      task: { id: task.id, jiraKey: task.jiraKey, title: task.title, url: jiraUrl(task.jiraKey), status: task.status, jiraStatus: ref.status || null, assignee: userName(task.assigneeId), projectId: task.projectId, fixVersions: (ref.fixVersions || []).map(item => item.name) },
      parent: parent ? { id: parent.id, jiraKey: parent.jiraKey, title: parent.title } : null,
      requirementKeys: reqKeys,
      overall: { status: overallStatus, passed: gating.filter(link => link.status === 'PASS' || link.status === 'CONDITIONAL').length, total: gating.length, score: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null, currentLinkId: current?.id || null, blockers },
      links, children: childRows, traceability, deltas, analysis,
    };
  }

  return { chainFor, statusesFor };
}

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ');

export function chainReportMarkdown(chain) {
  const out = [];
  const overallLabel = { PASS: '✅ 全链路通过', BLOCKED: '⛔ 存在阻断', IN_PROGRESS: '🔄 推进中' }[chain.overall.status];
  out.push(`# 交付链路审核报告 · ${chain.task.jiraKey} ${chain.task.title}`, '');
  out.push(`- 结论：**${overallLabel}**（门禁环节 ${chain.overall.passed}/${chain.overall.total} 通过${chain.overall.score !== null ? `，AI 平均评分 ${chain.overall.score}` : ''}）`);
  if (chain.requirementKeys.length) out.push(`- 需求单：${chain.requirementKeys.join('、')}`);
  if (chain.task.fixVersions.length) out.push(`- Fix Version：${chain.task.fixVersions.join(' / ')}`);
  if (chain.parent) out.push(`- 父任务：${chain.parent.jiraKey} ${chain.parent.title}`);
  if (chain.analysis?.metrics) {
    const m = chain.analysis.metrics;
    const metricBits = [
      m.coveragePrd !== null ? `PRD 覆盖 ${m.coveragePrd}%` : null,
      m.traceAc !== null ? `AC 追溯 ${m.traceAc}%` : null,
      `待澄清 ${m.clarifyOpenCount} 项`,
      `跨环节冲突 ${m.conflictCount} 项`,
    ].filter(Boolean);
    out.push(`- 质量指标：${metricBits.join(' · ')}`);
  }
  out.push(`- 生成时间：${chain.generatedAt}`, '');
  out.push('## 环节总览', '', '| # | 环节 | 状态 | AI 结论 | 评分 | 阻断 / 警告 |', '|---|---|---|---|---|---|');
  for (const link of chain.links) out.push(`| ${link.index} | ${link.title}${link.advisory ? '（建议项）' : ''} | ${link.statusLabel} | ${link.review?.verdict ? VERDICT_LABEL[link.review.verdict] : link.review?.summary ? '已出报告' : '—'} | ${link.review?.score ?? '—'} | ${link.review ? `${link.review.findings.critical} / ${link.review.findings.warn}` : '—'} |`);
  out.push('');
  if (chain.analysis?.conflicts?.length) {
    out.push('## 跨环节一致性巡检（/analyze）', '');
    for (const c of chain.analysis.conflicts) out.push(`- \`${c.severity}\` **${c.title}**：${cell(c.detail)}`);
    out.push('');
  }
  if (chain.deltas?.length) {
    out.push('## 材料变更增量（Delta Diff）', '');
    for (const d of chain.deltas) out.push(`- **${d.title}**（\`r${d.fromRevision} → r${d.toRevision}\`）：+${d.additions} / -${d.deletions}${d.changedHeadings.length ? ` · 涉及章节：${d.changedHeadings.join('、')}` : ''}`);
    out.push('');
  }
  if (chain.overall.blockers.length) {
    out.push('## 阻断项', '');
    for (const item of chain.overall.blockers) out.push(`- **[${item.link}] ${item.title}**：${cell(item.detail)}`);
    out.push('');
  }
  for (const link of chain.links) {
    out.push(`## ${link.index}. ${link.title} — ${link.statusLabel}`, '', `> ${link.purpose}`, '');
    if (link.objects.length) { out.push('**关联对象**', ''); for (const object of link.objects) out.push(`- ${object.url ? `[${object.label}](${object.url})` : object.label}${object.meta ? ` · ${object.meta}` : ''}`); out.push(''); }
    out.push('**规则检查**', '');
    for (const check of link.checks) out.push(`- ${check.ok === true ? '✅' : check.ok === false ? (check.level === 'required' ? '❌' : '⚠️') : '➖'} ${check.label}${check.level === 'required' ? '（必需）' : ''}：${cell(check.detail)}`);
    out.push('');
    if (link.review) {
      const review = link.review;
      out.push(`**AI 审核**${review.stale ? '（材料已变化，需重审）' : ''}`, '');
      if (review.verdict || review.score !== null) out.push(`- 结论：${review.verdict ? VERDICT_LABEL[review.verdict] : '—'}${review.score !== null ? ` · 评分 ${review.score}` : ''}${review.meta?.riskLevel ? ` · 风险 ${review.meta.riskLevel}` : ''}${review.meta?.effortScore ? ` · 审校复杂度 ${review.meta.effortScore}/5` : ''}${review.tool ? ` · 工具 ${review.tool}` : ''}`);
      if (review.summary) out.push(`- 摘要：${cell(review.summary)}`);
      if (review.decision) out.push(`- 人工确认：${review.decision.decision === 'APPROVE' ? '批准' : '退回'} — ${cell(review.decision.reason)}`);
      if (review.meta?.clarifyQuestions?.length) {
        out.push('', '**待澄清问题（Clarify）**', '');
        for (const q of review.meta.clarifyQuestions) out.push(`- \`${q.id}\` ${q.resolved ? '✅ ' : '❓ '}${cell(q.question)}${q.impact ? `（影响：${cell(q.impact)}）` : ''}`);
      }
      if (review.meta?.walkthrough?.length) {
        out.push('', '| 文件/章节 | 改动概览 | 风险 |', '|---|---|---|');
        for (const w of review.meta.walkthrough) out.push(`| ${cell(w.file)} | ${cell(w.summary)} | ${w.risk || '—'} |`);
      }
      if (review.checklist.length) { out.push('', '| 检查项 | 结果 | 依据 |', '|---|---|---|'); for (const item of review.checklist) out.push(`| ${cell(item.item)} | ${RESULT_MARK[item.result] || item.result} | ${cell(item.note)}${item.ref ? `（${cell(item.ref)}）` : ''} |`); }
      if (review.findings.items.length) { out.push(''); for (const item of review.findings.items) out.push(`- \`${item.severity}\`${item.category ? ` \`${item.category}\`` : ''}${Number.isInteger(item.confidence) ? ` (置信度 ${item.confidence}/10)` : ''}${item.waived ? '（已豁免）' : ''} ${item.title}：${cell(item.detail)}${item.location ? `（${cell(item.location)}）` : ''}`); }
      out.push('');
    } else out.push('_尚未进行 AI 审核_', '');
  }
  if (chain.traceability.length) {
    out.push('## 追溯矩阵（需求点 → 子任务）', '', '| 需求点 | 覆盖 | 承接子任务 | 说明 |', '|---|---|---|---|');
    for (const row of chain.traceability) out.push(`| ${cell(row.point)} | ${RESULT_MARK[row.result] || row.result} | ${row.tasks.map(item => item.key).join('、') || '—'} | ${cell(row.note)} |`);
    out.push('');
  }
  if (chain.children.length) {
    const short = { PRD: '需求', TASK_BREAKDOWN: '拆分', TECH_SPEC: '方案', CODE_REVIEW: '代码', TEST_CASE: '测试', RELEASE: '上线' };
    out.push('## 子任务链路', '', `| 子任务 | 受理人 | Jira 状态 | ${CHAIN_STAGES.map(stage => short[stage]).join(' | ')} |`, `|---|---|---|${CHAIN_STAGES.map(() => '---').join('|')}|`);
    for (const child of chain.children) out.push(`| ${child.jiraKey} ${cell(child.title)} | ${child.assignee || '—'} | ${child.jiraStatus || '—'} | ${CHAIN_STAGES.map(stage => LINK_STATUS_LABEL[child.links[stage]]).join(' | ')} |`);
    out.push('');
  }
  return out.join('\n');
}

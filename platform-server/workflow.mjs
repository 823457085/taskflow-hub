import { randomUUID } from 'node:crypto';
import { STAGES, REVIEW_STAGES, STAGE_INPUTS, REPORT_VERDICTS, CHECKLIST_RESULTS, FINDING_CATEGORIES, RISK_LEVELS, KINDS, TOOLS, STAGE_AGENTS, REVIEW_ROLES, APPROVAL_ROLES, fail, sha, textField, assetRow } from './common.mjs';
const parseChecklist = value => { if (!value) return []; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
const parseJson = value => { if (!value) return null; try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; } };
function normalizeReportMeta(raw, findings = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (RISK_LEVELS.includes(raw.riskLevel)) out.riskLevel = raw.riskLevel;
  if (Number.isInteger(raw.effortScore) && raw.effortScore >= 1 && raw.effortScore <= 5) out.effortScore = raw.effortScore;
  if (Array.isArray(raw.walkthrough)) {
    const items = raw.walkthrough.slice(0, 60)
      .filter(item => item && typeof item.file === 'string' && item.file.trim())
      .map(item => ({
        file: textField(item.file, 'meta.walkthrough.file', { max: 300 }),
        summary: typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim().slice(0, 600) : '',
        ...(RISK_LEVELS.includes(item.risk) ? { risk: item.risk } : {}),
      }));
    if (items.length) out.walkthrough = items;
  }
  if (raw.compliance && typeof raw.compliance === 'object' && !Array.isArray(raw.compliance)) {
    const pickList = val => Array.isArray(val) ? val.slice(0, 40).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 400)) : [];
    const compliant = pickList(raw.compliance.compliant);
    const missing = pickList(raw.compliance.missing);
    const manualCheck = pickList(raw.compliance.manualCheck);
    if (compliant.length || missing.length || manualCheck.length) out.compliance = { compliant, missing, manualCheck };
  }
  if (Array.isArray(raw.clarifyQuestions)) {
    const qs = raw.clarifyQuestions.slice(0, 30)
      .filter(item => item && typeof item.question === 'string' && item.question.trim())
      .map((item, idx) => ({
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 32) : `Q-${String(idx + 1).padStart(3, '0')}`,
        question: item.question.trim().slice(0, 600),
        ...(typeof item.impact === 'string' && item.impact.trim() ? { impact: item.impact.trim().slice(0, 400) } : {}),
        ...(typeof item.owner === 'string' && item.owner.trim() ? { owner: item.owner.trim().slice(0, 80) } : {}),
        resolved: !!item.resolved,
      }));
    if (qs.length) out.clarifyQuestions = qs;
  }
  if (raw.coverageMetrics && typeof raw.coverageMetrics === 'object' && !Array.isArray(raw.coverageMetrics)) {
    const m = {};
    if (Number.isFinite(raw.coverageMetrics.coveragePrd)) m.coveragePrd = Math.max(0, Math.min(100, Math.round(raw.coverageMetrics.coveragePrd)));
    if (Number.isFinite(raw.coverageMetrics.traceAc)) m.traceAc = Math.max(0, Math.min(100, Math.round(raw.coverageMetrics.traceAc)));
    if (Object.keys(m).length) out.coverageMetrics = m;
  }
  if (findings.length && !out.riskLevel && findings.some(f => f.severity === 'CRITICAL')) out.riskLevel = 'high';
  return Object.keys(out).length ? out : null;
}
export function createWorkflow(db, audit, transaction) {
  const assetsFor = taskId => db.prepare('SELECT * FROM assets WHERE task_id=? ORDER BY rowid DESC').all(taskId).map(assetRow);
  const reportFor = jobId => {
    const row = db.prepare('SELECT * FROM reports WHERE job_id=?').get(jobId);
    if (!row) return null;
    const meta = parseJson(row.meta);
    return {
      id: row.id, summary: row.summary, source: row.source, tool: row.tool, evidence: row.evidence, actorId: row.actor_id, createdAt: row.created_at,
      verdict: row.verdict || null, score: Number.isInteger(row.score) ? row.score : null, checklist: parseChecklist(row.checklist),
      ...(meta ? { meta } : {}),
    };
  };
  const decisionFor = jobId => {
    const row = db.prepare('SELECT * FROM decisions WHERE job_id=?').get(jobId);
    return row ? { id: row.id, decision: row.decision, reason: row.reason, actorId: row.actor_id, createdAt: row.created_at } : null;
  };
  const findingsFor = jobId => db.prepare('SELECT f.id,f.severity,f.title,f.detail,f.location,f.category,f.confidence,f.rule_id,f.patch_json,w.id AS waiver_id,w.reason AS waiver_reason,w.actor_id AS waiver_actor_id,w.created_at AS waiver_created_at FROM findings f LEFT JOIN waivers w ON w.finding_id=f.id WHERE f.job_id=? ORDER BY f.rowid').all(jobId).map(row => {
    const patch = parseJson(row.patch_json);
    return {
      id: row.id,
      severity: row.severity,
      title: row.title,
      detail: row.detail,
      location: row.location,
      ...(row.category ? { category: row.category } : {}),
      ...(Number.isInteger(row.confidence) ? { confidence: row.confidence } : {}),
      ...(row.rule_id ? { ruleId: row.rule_id } : {}),
      ...(patch ? { suggestedPatch: patch } : {}),
      waiver: row.waiver_id ? { id: row.waiver_id, reason: row.waiver_reason, actorId: row.waiver_actor_id, createdAt: row.waiver_created_at } : null,
    };
  });
  const createMemo = () => ({ assets: new Map(), plugins: new Map(), inputs: new Map(), gate: new Map(), gates: new Map(), approver: new Map() });
  // Child tasks as a review input. Only fields that describe the breakdown itself are hashed, so Jira status churn does not invalidate the review.
  const childrenFor = taskId => db.prepare('SELECT id,jira_key,title,assignee_id,external_ref FROM tasks WHERE parent_id=? ORDER BY jira_key').all(taskId).map(row => {
    const ref = row.external_ref ? JSON.parse(row.external_ref) : null;
    return { id: row.id, jiraKey: row.jira_key, title: row.title, assigneeId: row.assignee_id || null, issueType: ref?.issueType?.name || ref?.type || null, fixVersions: (ref?.fixVersions || []).map(item => item?.name).filter(Boolean), description: typeof ref?.description === 'string' ? ref.description.slice(0, 4000) : '' };
  });
  function inputs(task, stage, upstream, memo) {
    const cacheKey = !upstream && memo ? `${task.id}:${stage}` : '';
    if (cacheKey && memo.inputs.has(cacheKey)) return memo.inputs.get(cacheKey);
    const spec = STAGE_INPUTS[stage] || { required: KINDS.slice(0, STAGES.indexOf(stage) + 1), optional: [], children: false };
    const kinds = [...spec.required, ...spec.optional];
    let taskAssets = memo?.assets.get(task.id);
    if (!taskAssets) {
      taskAssets = assetsFor(task.id);
      memo?.assets.set(task.id, taskAssets);
    }
    const latest = new Map();
    for (const asset of taskAssets) if (kinds.includes(asset.kind) && !latest.has(`${asset.kind}:${asset.logicalKey}`)) latest.set(`${asset.kind}:${asset.logicalKey}`, asset);
    const assets = [...latest.values()].sort((a, b) => `${a.kind}:${a.logicalKey}`.localeCompare(`${b.kind}:${b.logicalKey}`));
    const missing = spec.required.filter(kind => !assets.some(asset => asset.kind === kind));
    const children = spec.children ? childrenFor(task.id) : null;
    if (children && !children.length) missing.push('SUBTASKS');
    const agent = STAGE_AGENTS[stage];
    let projectPlugins = memo?.plugins.get(task.projectId);
    if (!projectPlugins) {
      projectPlugins = db.prepare('SELECT manifest FROM plugins WHERE project_id=? ORDER BY id').all(task.projectId).map(row => JSON.parse(row.manifest));
      memo?.plugins.set(task.projectId, projectPlugins);
    }
    const plugins = projectPlugins.filter(plugin => plugin.stages.includes(stage));
    const snapshot = { task: { id: task.id, title: task.title, assigneeId: task.assigneeId, contextVersion: task.contextVersion, ...(task.externalRef ? { jira: { key: task.externalRef.key, title: task.externalRef.title, description: task.externalRef.description, project: task.externalRef.project, type: task.externalRef.type, issueType: task.externalRef.issueType, priority: task.externalRef.priority, components: task.externalRef.components, fixVersions: task.externalRef.fixVersions, labels: task.externalRef.labels, parentKey: task.externalRef.parentKey, requirementsHash: task.externalRef.requirementsHash } } : {}) }, assets, persona: agent.persona, skills: agent.skills.map(id => ({ id, version: '1.0.0' })), plugins, missingKinds: missing };
    if (children) snapshot.children = children;
    if (stage === 'RELEASE') {
      const previous = upstream || STAGES.slice(0, 4).map(item => gate(task, item, undefined, memo));
      snapshot.upstreamApprovals = previous.map(item => ({ stage: item.stage, status: item.status, jobId: item.jobId || null, decisionId: item.jobId ? decisionFor(item.jobId)?.id || null : null }));
    }
    const policyHash = sha(JSON.stringify({ persona: snapshot.persona, skills: snapshot.skills, plugins: snapshot.plugins }));
    const inputHash = sha(JSON.stringify({ task: snapshot.task, assets: assets.map(({ id, kind, logicalKey, revision, sha256 }) => ({ id, kind, logicalKey, revision, sha256 })), ...(snapshot.upstreamApprovals ? { upstreamApprovals: snapshot.upstreamApprovals } : {}), ...(children ? { children } : {}) }));
    const result = { assets, missing, inputHash, snapshot: { ...snapshot, policyHash, inputHash } };
    if (cacheKey) memo.inputs.set(cacheKey, result);
    return result;
  }
  function gate(task, stage, upstream, memo) {
    const cacheKey = !upstream && memo ? `${task.id}:${stage}` : '';
    if (cacheKey && memo.gate.has(cacheKey)) return memo.gate.get(cacheKey);
    const current = inputs(task, stage, upstream, memo);
    if (current.missing.length) {
      const out = { stage, status: 'MISSING_INPUT', reason: `缺少输入：${current.missing.join('、')}` };
      if (cacheKey) memo.gate.set(cacheKey, out);
      return out;
    }
    const all = db.prepare('SELECT * FROM jobs WHERE task_id=? AND stage=? ORDER BY rowid DESC').all(task.id, stage);
    const row = all.find(job => job.input_hash === current.inputHash);
    if (!row) {
      const out = { stage, status: all.length ? 'STALE' : 'PENDING', reason: all.length ? '输入或上游审批已变化，请重新评审' : '尚未发起评审' };
      if (cacheKey) memo.gate.set(cacheKey, out);
      return out;
    }
    const decision = decisionFor(row.id);
    const report = reportFor(row.id);
    const soloMode = !hasOtherApprover(task.projectId, APPROVAL_ROLES[stage] || ['ADMIN'], [report?.actorId, task.assigneeId], memo);
    let status = 'PENDING'; let reason = report && soloMode ? '报告已提交，单账号模式可由本人完成审批' : '等待报告或独立审批';
    if (decision?.decision === 'REQUEST_CHANGES') { status = 'CHANGES_REQUESTED'; reason = decision.reason; }
    else if (decision?.decision === 'APPROVE') { status = 'PASS'; reason = decision.reason; }
    else if (findingsFor(row.id).some(f => f.severity === 'CRITICAL' && !f.waiver)) { status = 'BLOCKED'; reason = '存在未豁免的 CRITICAL 问题'; }
    else if (row.execution_mode === 'CLOUD_AI') reason = '云端 AI 执行器尚未配置';
    if (stage === 'RELEASE' && upstream?.some(item => item.status !== 'PASS')) { status = 'BLOCKED'; reason = '前四项门禁尚未全部通过'; }
    const out = { stage, status, jobId: row.id, reason };
    if (cacheKey) memo.gate.set(cacheKey, out);
    return out;
  }
  const gates = (task, externalMemo) => {
    if (externalMemo?.gates.has(task.id)) return externalMemo.gates.get(task.id);
    const memo = externalMemo || createMemo();
    const result = STAGES.slice(0, 4).map(stage => gate(task, stage, undefined, memo));
    result.push(gate(task, 'RELEASE', result, memo));
    const out = { overall: result.every(item => item.status === 'PASS') ? 'PASS' : 'BLOCKED', gates: result };
    memo.gates.set(task.id, out);
    return out;
  };
  function hasOtherApprover(projectId, allowedRoles, excludedIds, memo) {
    if (!allowedRoles?.length) return false;
    const excluded = [...new Set((excludedIds || []).filter(Boolean))].sort();
    const cacheKey = memo ? `${projectId}:${allowedRoles.join(',')}:${excluded.join(',')}` : '';
    if (memo && memo.approver.has(cacheKey)) return memo.approver.get(cacheKey);
    const rolePh = allowedRoles.map(() => '?').join(',');
    const adminClause = allowedRoles.includes('ADMIN') ? "u.role='ADMIN' OR " : '';
    const exClause = excluded.length ? ` AND u.id NOT IN (${excluded.map(() => '?').join(',')})` : '';
    const found = !!db.prepare(`SELECT 1 AS ok FROM users u LEFT JOIN project_members pm ON pm.project_id=? AND pm.user_id=u.id WHERE (${adminClause}pm.role IN (${rolePh}))${exClause} LIMIT 1`).get(projectId, ...allowedRoles, ...excluded);
    if (memo) memo.approver.set(cacheKey, found);
    return found;
  }
  const jobRow = (row, task, memo) => {
    const snapshot = JSON.parse(row.snapshot);
    const report = reportFor(row.id);
    const soloMode = !hasOtherApprover(task.projectId, APPROVAL_ROLES[row.stage] || ['ADMIN'], [report?.actorId, task.assigneeId], memo);
    return { id: row.id, taskId: row.task_id, projectId: row.project_id, stage: row.stage, status: row.status, actorId: row.actor_id, createdAt: row.created_at, executionMode: row.execution_mode, inputHash: row.input_hash, policyHash: snapshot.policyHash || null, persona: snapshot.persona || 'legacy-unrecorded', skills: snapshot.skills?.map(skill => skill.id) || [], executor: 'UNCONFIGURED', snapshot, report, findings: findingsFor(row.id), decision: decisionFor(row.id), stale: !row.input_hash || row.input_hash !== inputs(task, row.stage, undefined, memo).inputHash, soloMode };
  };
  const roleCanReview = (role, stage) => REVIEW_ROLES[role]?.includes(stage);
  function createReview(task, user, role, body) {
    if (!REVIEW_STAGES.includes(body.stage)) fail(400, 'INVALID_STAGE', '评审阶段不受支持');
    if (!roleCanReview(role, body.stage)) fail(403, 'FORBIDDEN', '当前角色无权发起此阶段评审');
    const mode = body.executionMode || 'LOCAL_REPORT';
    if (!['CLOUD_AI', 'HUMAN_REVIEW', 'LOCAL_REPORT'].includes(mode)) fail(400, 'INVALID_MODE', '执行模式不受支持');
    const current = inputs(task, body.stage);
    if (current.missing.length && mode !== 'CLOUD_AI') fail(409, 'MISSING_INPUT', `缺少输入：${current.missing.join('、')}`);
    const existing = db.prepare("SELECT * FROM jobs WHERE task_id=? AND stage=? AND execution_mode=? AND input_hash=? AND status IN ('AWAITING_CONFIGURATION','AWAITING_REVIEW','AWAITING_REPORT') ORDER BY rowid DESC").all(task.id, body.stage, mode, current.inputHash).find(row => JSON.parse(row.snapshot).policyHash === current.snapshot.policyHash);
    if (existing) return { status: 200, job: jobRow(existing, task) };
    const id = randomUUID(); const status = { CLOUD_AI: 'AWAITING_CONFIGURATION', HUMAN_REVIEW: 'AWAITING_REVIEW', LOCAL_REPORT: 'AWAITING_REPORT' }[mode];
    transaction(() => {
      db.prepare('INSERT INTO jobs (id,task_id,stage,status,actor_id,created_at,project_id,execution_mode,input_hash,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, task.id, body.stage, status, user.id, new Date().toISOString(), task.projectId, mode, current.inputHash, JSON.stringify(current.snapshot));
      audit(user.id, 'REVIEW_REQUEST', id, task.projectId);
    });
    return { status: 201, job: jobRow(db.prepare('SELECT * FROM jobs WHERE id=?').get(id), task) };
  }
  const assertCurrent = (row, task) => { const current = inputs(task, row.stage); if (current.missing.length || row.input_hash !== current.inputHash) fail(409, 'STALE_REVIEW', '评审输入或上游审批已变化，请重新评审'); };
  function submitReport(row, task, user, role, body) {
    if (!roleCanReview(role, row.stage)) fail(403, 'FORBIDDEN', '当前角色无权提交此阶段报告');
    if (row.execution_mode === 'CLOUD_AI') fail(409, 'EXECUTOR_UNCONFIGURED', '云端 AI 执行器尚未配置，不能提交执行报告');
    if (reportFor(row.id)) fail(409, 'REPORT_EXISTS', '报告已提交，不可覆盖');
    assertCurrent(row, task);
    const expectedSource = row.execution_mode === 'HUMAN_REVIEW' ? 'MANUAL' : 'LOCAL_TOOL';
    if (body.source !== expectedSource) fail(400, 'INVALID_SOURCE', '报告来源与评审执行模式不一致');
    if (body.source === 'LOCAL_TOOL' && !TOOLS.includes(body.tool)) fail(400, 'INVALID_TOOL', '本地报告必须声明支持的工具来源');
    const summary = textField(body.summary, 'summary', { max: 8000, preserve: true });
    const evidence = body.evidence === undefined ? null : textField(body.evidence, 'evidence', { min: 0, max: 8000, preserve: true });
    if (!Array.isArray(body.findings) || body.findings.length > 50) fail(400, 'INVALID_FINDINGS', 'findings必须为不超过50项的数组');
    const findings = body.findings.map(item => {
      if (!item || !['CRITICAL', 'WARN', 'INFO'].includes(item.severity)) fail(400, 'INVALID_FINDINGS', '问题严重程度不受支持');
      const category = item.category === undefined || item.category === null || item.category === '' ? null
        : FINDING_CATEGORIES.includes(item.category) ? item.category : fail(400, 'INVALID_FINDINGS', '问题分类不受支持');
      const confidence = item.confidence === undefined || item.confidence === null ? null
        : Number.isInteger(item.confidence) && item.confidence >= 0 && item.confidence <= 10 ? item.confidence : fail(400, 'INVALID_FINDINGS', '问题置信度必须为 0 至 10 的整数');
      const ruleId = item.ruleId === undefined || item.ruleId === null || item.ruleId === '' ? null
        : textField(item.ruleId, 'finding.ruleId', { max: 64 });
      let patchJson = null;
      if (item.suggestedPatch && typeof item.suggestedPatch === 'object' && !Array.isArray(item.suggestedPatch)) {
        const before = typeof item.suggestedPatch.before === 'string' ? item.suggestedPatch.before.slice(0, 4000) : '';
        const after = typeof item.suggestedPatch.after === 'string' ? item.suggestedPatch.after.slice(0, 4000) : '';
        if (before || after) patchJson = JSON.stringify({ before, after });
      }
      return {
        severity: item.severity,
        title: textField(item.title, 'title', { max: 200, preserve: true }),
        detail: textField(item.detail, 'detail', { max: 4000, preserve: true }),
        location: item.location === undefined ? null : textField(item.location, 'location', { min: 0, max: 500, preserve: true }),
        category, confidence, ruleId, patchJson,
      };
    });
    const verdict = body.verdict === undefined || body.verdict === null ? null : body.verdict;
    if (verdict !== null && !REPORT_VERDICTS.includes(verdict)) fail(400, 'INVALID_VERDICT', '评审结论仅支持 PASS / CONDITIONAL / FAIL');
    if (verdict === 'PASS' && findings.some(item => item.severity === 'CRITICAL')) fail(400, 'INVALID_VERDICT', '存在 CRITICAL 问题时不能将结论设为 PASS');
    const score = body.score === undefined || body.score === null ? null : body.score;
    if (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)) fail(400, 'INVALID_SCORE', '评分必须是0至100的整数');
    if (body.checklist !== undefined && body.checklist !== null && (!Array.isArray(body.checklist) || body.checklist.length > 60)) fail(400, 'INVALID_CHECKLIST', 'checklist必须为不超过60项的数组');
    const checklist = (body.checklist || []).map(item => {
      if (!item || !CHECKLIST_RESULTS.includes(item.result)) fail(400, 'INVALID_CHECKLIST', '检查项结果仅支持 PASS / WARN / FAIL / NA');
      return { item: textField(item.item, 'checklist.item', { max: 300, preserve: true }), result: item.result, note: item.note === undefined || item.note === null ? '' : textField(item.note, 'checklist.note', { min: 0, max: 2000, preserve: true }), ...(item.ref ? { ref: textField(item.ref, 'checklist.ref', { max: 500, preserve: true }) } : {}) };
    });
    const meta = normalizeReportMeta(body.meta, findings);
    transaction(() => {
      db.prepare('INSERT INTO reports (id,job_id,summary,source,tool,evidence,actor_id,created_at,verdict,score,checklist,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), row.id, summary, body.source, body.source === 'LOCAL_TOOL' ? body.tool : null, evidence, user.id, new Date().toISOString(), verdict, score, checklist.length ? JSON.stringify(checklist) : null, meta ? JSON.stringify(meta) : null);
      for (const finding of findings) db.prepare('INSERT INTO findings (id,job_id,severity,title,detail,location,category,confidence,rule_id,patch_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), row.id, finding.severity, finding.title, finding.detail, finding.location, finding.category, finding.confidence, finding.ruleId, finding.patchJson);
      db.prepare("UPDATE jobs SET status='REPORT_SUBMITTED' WHERE id=?").run(row.id);
      audit(user.id, 'REVIEW_REPORT', row.id, task.projectId);
    });
    return jobRow(db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id), task);
  }
  function decide(row, task, user, role, body) {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权执行门禁审批');
    if (!APPROVAL_ROLES[row.stage].includes(role)) fail(403, 'FORBIDDEN', '当前角色无权审批此阶段');
    const report = reportFor(row.id);
    if (!report) fail(409, 'REPORT_REQUIRED', '请先提交评审报告');
    if ((report.actorId === user.id || task.assigneeId === user.id) && hasOtherApprover(task.projectId, APPROVAL_ROLES[row.stage], [report.actorId, task.assigneeId])) fail(403, 'INDEPENDENT_REVIEW_REQUIRED', '不得审批自己的报告或自己受理的工作');
    if (decisionFor(row.id)) fail(409, 'DECISION_EXISTS', '审批结论已提交，不可覆盖');
    if (!['APPROVE', 'REQUEST_CHANGES'].includes(body.decision)) fail(400, 'INVALID_DECISION', '审批结论不受支持');
    const reason = textField(body.reason, 'reason', { max: 2000, preserve: true });
    assertCurrent(row, task);
    if (body.decision === 'APPROVE') {
      if (findingsFor(row.id).some(item => item.severity === 'CRITICAL' && !item.waiver)) fail(409, 'CRITICAL_FINDINGS', '存在未豁免的 CRITICAL 问题');
      if (row.stage === 'RELEASE' && gates(task).gates.slice(0, 4).some(item => item.status !== 'PASS')) fail(409, 'PREREQUISITES_BLOCKED', '前四项门禁尚未全部通过');
    }
    transaction(() => {
      db.prepare('INSERT INTO decisions VALUES (?,?,?,?,?,?)').run(randomUUID(), row.id, body.decision, reason, user.id, new Date().toISOString());
      db.prepare('UPDATE jobs SET status=? WHERE id=?').run(body.decision === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', row.id);
      audit(user.id, 'REVIEW_DECISION', row.id, task.projectId);
    });
    return jobRow(db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id), task);
  }
  function waive(row, task, findingId, user, role, body) {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权执行问题豁免');
    if (!['TECH_SPEC', 'CODE_REVIEW'].includes(row.stage)) fail(403, 'WAIVER_STAGE_FORBIDDEN', '仅技术方案与代码审核问题允许申请豁免');
    if (!['ADMIN', 'LEAD'].includes(role)) fail(403, 'FORBIDDEN', '当前角色无权豁免问题');
    const report = reportFor(row.id);
    if (!report) fail(409, 'REPORT_REQUIRED', '请先提交评审报告');
    if ((report.actorId === user.id || task.assigneeId === user.id) && hasOtherApprover(task.projectId, ['ADMIN', 'LEAD'], [report.actorId, task.assigneeId])) fail(403, 'INDEPENDENT_REVIEW_REQUIRED', '不得豁免自己的报告或自己受理的工作');
    if (decisionFor(row.id)) fail(409, 'DECISION_EXISTS', '审批结论已提交，不能再追加豁免');
    assertCurrent(row, task);
    const finding = findingsFor(row.id).find(item => item.id === findingId);
    if (!finding) fail(404, 'FINDING_NOT_FOUND', '问题不存在');
    if (finding.severity !== 'CRITICAL') fail(400, 'WAIVER_SEVERITY_INVALID', '仅 CRITICAL 问题允许申请豁免');
    if (finding.waiver) fail(409, 'WAIVER_EXISTS', '豁免已记录，不可覆盖');
    const reason = textField(body.reason, 'reason', { max: 2000, preserve: true });
    transaction(() => { db.prepare('INSERT INTO waivers VALUES (?,?,?,?,?)').run(randomUUID(), findingId, reason, user.id, new Date().toISOString()); audit(user.id, 'FINDING_WAIVER', findingId, task.projectId); });
    return jobRow(row, task);
  }
  return { assetsFor, childrenFor, inputs, gate, gates, jobRow, createMemo, createReview, submitReport, decide, waive };
}

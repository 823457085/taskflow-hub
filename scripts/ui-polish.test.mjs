import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiRunModeLabel,
  aiRunStatusLabel,
  APPROVAL_REASON_PRESETS,
  ASSET_KIND_OPTIONS,
  assetKindLabel,
  assetMetaCodeLabel,
  authModeLabel,
  connectorStatusLabel,
  decisionLabel,
  DEFAULT_APPROVE_REASON,
  deviceScopeLabel,
  deviceStatusLabel,
  executionModeLabel,
  formatSubmittedReportMarkdown,
  gateStatusLabel,
  gitBranchLabel,
  heartbeatStatusLabel,
  imChannelLabel,
  mcpToolLabel,
  mrStateLabel,
  pairingStatusLabel,
  personaLabel,
  pluginStatusLabel,
  progressSourceLabel,
  REJECTION_REASON_PRESETS,
  REPORT_SUMMARY_PRESETS,
  REPORT_TOOL_OPTIONS,
  reportSourceLabel,
  reviewStatusLabel,
  roleLabel,
  SEVERITY_OPTIONS,
  severityLabel,
  skillLabel,
  skillsLabel,
  stageLabel,
  TASK_STATUS_OPTIONS,
  TASK_TYPE_OPTIONS,
  taskStatusLabel,
  taskTypeLabel,
  toolLabel,
  WAIVER_REASON_PRESETS,
  webhookProviderLabel,
} from '../preview-app/src/views/displayLabels.ts';
import { buildQuickCommandItems } from '../preview-app/src/views/quickCommandSearch.ts';
import { buildTaskTree } from '../preview-app/src/views/taskTree.ts';
import { plainReviewText, reviewDetailSections, sortReviewFindings } from '../preview-app/src/views/reviewFindingPresentation.ts';
import { groupTaskMaterials } from '../preview-app/src/views/assetGroups.ts';
import {
  clearSearchOnEscape,
  deleteSavedTaskView,
  isEditableTarget,
  isSavedViewActive,
  isSubmitShortcut,
  readSavedTaskViews,
  readStoredBool,
  readStoredChoice,
  readStoredStringList,
  saveTaskFilterView,
  writeStoredBool,
  writeStoredString,
  writeStoredStringList,
} from '../preview-app/src/views/uiPreferences.ts';
import { createApiClient } from '../preview-app/src/views/workspaceApi.ts';
import {
  analyzeAssetRiskSignals,
  buildSideBySideUnifiedDiff,
  classifyDiffLine,
  computeRevisionLineDiff,
  isUnifiedDiffContent,
  pairRevisionDiffSideBySide,
  parseUnifiedDiffStats,
  splitUnifiedDiffLines,
} from '../preview-app/src/views/assetDiff.ts';
import { buildAssetTemplate, canImportTaskMaterial } from '../preview-app/src/views/taskSmartLinks.ts';
import { hasDoneAncestor, isTaskFrozen } from '../preview-app/src/views/taskAvailability.ts';
import {
  buildTaskContextPack,
  estimateContextTokens,
  formatBatchTasksMarkdown,
  selectLatestAssets,
} from '../preview-app/src/views/taskContextPack.ts';
import {
  buildBatchFindingsFixPrompt,
  buildSingleFindingFixPrompt,
  sortActionableFindings,
} from '../preview-app/src/views/findingFixPrompt.ts';
import {
  buildReleaseDossierMarkdown,
  countStructuredTestItems,
  evaluateReleaseReadiness,
} from '../preview-app/src/views/releaseReadiness.ts';
import {
  describeAuditAction,
  exportAuditRecordsCsv,
  exportAuditRecordsJsonl,
  filterAuditRecords,
  parseAuditSearchQuery,
  sanitizeCsvCell,
} from '../preview-app/src/views/auditLogUtils.ts';
import {
  allocateNextJiraKeys,
  buildStandardDeliverySubtasks,
  extractSubtaskCandidatesFromSpecs,
  inferSubtaskType,
} from '../preview-app/src/views/subtaskDecomposer.ts';
import {
  isLikelyMarkdown,
  isSafeHttpUrl,
  parseInlineTokens,
  parseMarkdownBlocks,
  summarizeMarkdownChecklists,
} from '../preview-app/src/views/markdownLite.ts';
import {
  buildScopedPluginId,
  isPresetInstalled,
  POLICY_PLUGIN_PRESETS,
} from '../preview-app/src/views/policyPluginPresets.ts';
import {
  buildPersonalStandupDigest,
  buildProjectSprintDigest,
} from '../preview-app/src/views/standupDigest.ts';
import {
  currentAiReviews,
  evaluateReviewSla,
  formatCompactDuration,
  isReviewActionableByUser,
  sortReviewsByQueuePriority,
} from '../preview-app/src/views/reviewQueueSla.ts';
import {
  buildKanbanSwimlanes,
  evaluateColumnWip,
} from '../preview-app/src/views/kanbanSwimlanes.ts';
import { formatLocalDoctorMarkdown } from '../preview-app/src/views/localDoctorReport.ts';
import { buildCodeMaterialPreview, summarizeNodeTests } from '../preview-app/src/views/codeMaterialContent.ts';
import {
  buildConventionalBranchName,
  buildConventionalCommitMessage,
  buildGitWorktreeCommands,
  buildPullRequestDescription,
  inferBranchPrefix,
  shellSingleQuote,
  slugifyAsciiBranchSegment,
} from '../preview-app/src/views/gitHandoffKit.ts';
import {
  extractSpecRequirementPoints,
  synthesizeTestSuiteFromSpecs,
} from '../preview-app/src/views/specToTestSuite.ts';
import {
  buildSarifLogFromReview,
  parseFindingLocation,
  parseSarifFindingsToDraft,
} from '../preview-app/src/views/sarifExport.ts';
import {
  formatFlowHours,
  gradeDoraLeadTime,
  gradeFirstTimePassRate,
  gradeReviewTurnaround,
} from '../preview-app/src/views/deliveryMetrics.ts';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

test('displayLabels maps technical enums to plain Chinese and falls back cleanly', () => {
  assert.equal(taskStatusLabel('OPEN'), '待开始');
  assert.equal(taskStatusLabel('IN_PROGRESS'), '进行中');
  assert.equal(taskStatusLabel('IN_REVIEW'), '评审中');
  assert.equal(taskStatusLabel('DONE'), '已完成');

  assert.equal(taskTypeLabel('STORY'), '需求故事');
  assert.equal(taskTypeLabel('TASK'), '研发任务');
  assert.equal(taskTypeLabel('BUG'), '缺陷修复');
  assert.equal(taskTypeLabel('RELEASE'), '版本发布');

  assert.equal(stageLabel('PRD'), '需求评审');
  assert.equal(stageLabel('TASK_BREAKDOWN'), '任务拆分审核');
  assert.equal(stageLabel('TECH_SPEC'), '技术方案审核');
  assert.equal(personaLabel('ai-delivery-lead'), 'AI 交付负责人');
  assert.equal(skillLabel('requirement-coverage-map'), '需求点覆盖映射');
  assert.equal(stageLabel('CODE_REVIEW'), '代码审核');
  assert.equal(stageLabel('TEST_CASE'), '测试用例评审');
  assert.equal(stageLabel('RELEASE'), '上线审核');

  assert.equal(assetKindLabel('PRD'), '需求文档');
  assert.equal(assetKindLabel('TECH_SPEC'), '技术方案');
  assert.equal(assetKindLabel('CODE'), '代码改动');
  assert.equal(assetKindLabel('TEST_CASE'), '测试用例');
  assert.equal(assetKindLabel('RELEASE_PLAN'), '上线计划');

  assert.equal(reviewStatusLabel('AWAITING_REPORT'), '待提交报告');
  assert.equal(reviewStatusLabel('AWAITING_REVIEW'), '待人工评审');
  assert.equal(reviewStatusLabel('AWAITING_CONFIGURATION'), '待配置执行器');
  assert.equal(reviewStatusLabel('REPORT_SUBMITTED'), '待审批');
  assert.equal(reviewStatusLabel('APPROVED'), '已通过');
  assert.equal(reviewStatusLabel('CHANGES_REQUESTED'), '需修改');

  assert.equal(decisionLabel('APPROVE'), '已批准放行');
  assert.equal(decisionLabel('REQUEST_CHANGES'), '退回修改');

  assert.equal(executionModeLabel('LOCAL_REPORT'), '本地 AI / 工具评审');
  assert.equal(executionModeLabel('HUMAN_REVIEW'), '人工评审');
  assert.equal(executionModeLabel('CLOUD_AI'), '云端 AI（未启用）');

  assert.equal(reportSourceLabel('LOCAL_TOOL'), '本地 AI 工具');
  assert.equal(reportSourceLabel('MANUAL'), '人工填写');

  assert.equal(severityLabel('CRITICAL'), 'P0 阻断问题');
  assert.equal(severityLabel('WARN'), 'P1 需跟进');
  assert.equal(severityLabel('INFO'), 'P2 改进建议');

  assert.equal(gateStatusLabel('PASS'), '已通过');
  assert.equal(gateStatusLabel('MISSING_INPUT'), '缺少材料');
  assert.equal(gateStatusLabel('STALE'), '材料已更新·需重审');
  assert.equal(gateStatusLabel('BLOCKED'), '存在阻断项');

  assert.equal(roleLabel('ADMIN'), '系统管理员');
  assert.equal(roleLabel('DEV'), '研发工程师');
  assert.equal(connectorStatusLabel('CONNECTED'), '已连通');
  assert.equal(connectorStatusLabel('UNCONFIGURED'), '未配置');
  assert.equal(authModeLabel('BEARER'), '访问令牌（Bearer）');
  assert.equal(deviceStatusLabel('ACTIVE'), '生效中');
  assert.equal(deviceScopeLabel('LOCAL_BRIDGE'), '本机桥接');
  assert.equal(pairingStatusLabel('CONSUMED'), '已完成配对');
  assert.equal(heartbeatStatusLabel('WORKING'), '处理中');
  assert.equal(aiRunStatusLabel('SUCCEEDED'), '执行完成');
  assert.equal(aiRunModeLabel('develop'), '开发协作');
  assert.equal(mrStateLabel('OPENED'), '待合并');
  assert.equal(gitBranchLabel('HEAD'), '直接指向提交（未切分支）');
  assert.equal(gitBranchLabel('feature/demo-778'), 'feature/demo-778');
  assert.equal(taskStatusLabel('CUSTOM_STATUS'), 'CUSTOM_STATUS');

  assert.equal(TASK_STATUS_OPTIONS.length, 4);
  assert.equal(TASK_TYPE_OPTIONS.length, 4);
  assert.equal(ASSET_KIND_OPTIONS.length, 5);
  assert.equal(SEVERITY_OPTIONS.length, 3);
});

test('review findings sort by reported severity and separate explicit context, impact and suggestions', () => {
  const findings = [{ id: 'note', severity: 'INFO' }, { id: 'risk', severity: 'WARN' }, { id: 'blocker', severity: 'CRITICAL' }];
  assert.deepEqual(sortReviewFindings(findings).map(item => item.id), ['blocker', 'risk', 'note']);
  assert.equal(findings[0].id, 'note');
  assert.deepEqual(reviewDetailSections('问题：空余额时无法打开首页。\n影响: 用户查不了余额。\n建议：显示空态。\n用零余额账户验证。'), [
    { label: '哪里有问题', text: '空余额时无法打开首页。' },
    { label: '会影响什么', text: '用户查不了余额。' },
    { label: '建议怎么改', text: '显示空态。\n用零余额账户验证。' },
  ]);
  assert.deepEqual(reviewDetailSections('文档和原型的名称不一致。建议统一字段后再验收。'), [
    { label: '问题说明', text: '文档和原型的名称不一致。' },
    { label: '建议怎么改', text: '统一字段后再验收。' },
  ]);
  assert.deepEqual(reviewDetailSections('具体影响需要核实。'), [{ label: '问题说明', text: '具体影响需要核实。' }]);
  assert.equal(plainReviewText('未发现符合 CRITICAL 定义的问题或当前 PRD 的明确 BLOCK 规则失败。规则编号 RULE-CRITICAL-1。'),
    '未发现 P0 阻断问题或需求评审中未通过的必查项。规则编号 RULE-CRITICAL-1。');
});

test('uiPreferences persists booleans and string lists and clears search on Escape without closing drawers', () => {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    assert.equal(readStoredBool('pref.bool', false), false);
    assert.equal(readStoredBool('pref.bool', true), true);
    writeStoredBool('pref.bool', true);
    assert.equal(readStoredBool('pref.bool', false), true);
    writeStoredBool('pref.bool', false);
    assert.equal(readStoredBool('pref.bool', true), false);

    assert.deepEqual(readStoredStringList('pref.list'), []);
    writeStoredStringList('pref.list', ['group-a', 'group-b', 123]);
    assert.deepEqual(readStoredStringList('pref.list'), ['group-a', 'group-b']);
    storage.setItem('pref.list', '{broken-json');
    assert.deepEqual(readStoredStringList('pref.list'), []);

    let cleared = 0;
    let prevented = 0;
    let stopped = 0;
    clearSearchOnEscape('DEMO-778', () => { cleared++; })({
      key: 'Escape',
      preventDefault: () => { prevented++; },
      stopPropagation: () => { stopped++; },
    });
    assert.equal(cleared, 1);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);

    // Empty search does NOT swallow Escape so parent Drawers/Modals can still close via keyboard
    clearSearchOnEscape('', () => { cleared++; })({
      key: 'Escape',
      preventDefault: () => { prevented++; },
      stopPropagation: () => { stopped++; },
    });
    assert.equal(cleared, 1);
    assert.equal(stopped, 1);
  } finally {
    if (prevDescriptor) Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    else delete globalThis.localStorage;
  }
});

test('createApiClient deduplicates concurrent identical GET requests and never deduplicates mutations', async () => {
  let fetchCalls = 0;
  let releaseGet;
  const getGate = new Promise(resolve => { releaseGet = resolve; });

  const mockFetch = async (_url, init) => {
    fetchCalls += 1;
    const callNo = fetchCalls;
    if ((init?.method || 'GET') === 'GET') {
      await getGate;
    }
    return new Response(JSON.stringify({ callNo, method: init?.method || 'GET' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const client = createApiClient(mockFetch);
  const p1 = client('overview-summary?projectId=default');
  const p2 = client('overview-summary?projectId=default');
  assert.equal(fetchCalls, 1, 'concurrent identical GETs share 1 fetch call');

  releaseGet();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.callNo, 1);
  assert.equal(r2.callNo, 1);

  // Subsequent GET after settlement triggers a fresh fetch
  const r3 = await client('overview-summary?projectId=default');
  assert.equal(r3.callNo, 2);
  assert.equal(fetchCalls, 2);

  // Concurrent POST/PATCH mutations are never deduplicated
  const [m1, m2] = await Promise.all([
    client('projects/default', { name: 'A' }, 'PATCH'),
    client('projects/default', { name: 'B' }, 'PATCH'),
  ]);
  assert.notEqual(m1.callNo, m2.callNo);
  assert.equal(fetchCalls, 4);
});

test('persona, skill, tool labels and quick approval presets translate technical IDs to Chinese', () => {
  assert.equal(personaLabel('ai-pm'), 'AI 产品经理');
  assert.equal(personaLabel('ai-architect'), 'AI 架构师');
  assert.equal(personaLabel('ai-reviewer'), 'AI 代码审查员');
  assert.equal(personaLabel('ai-qa'), 'AI 测试工程师');
  assert.equal(personaLabel('ai-sre'), 'AI 运维发布');
  assert.equal(skillLabel('prd-completeness-audit'), '需求完整性核查');
  assert.equal(skillsLabel(['cross-repo-contract-diff', 'fe-security-and-perf']), '跨仓契约与改动比对、安全与性能扫描');
  assert.equal(skillsLabel([]), '—');
  assert.equal(toolLabel('codex-cli'), 'Codex CLI');
  assert.equal(toolLabel('custom'), 'Gemini / 自定义客户端');
  assert.equal(toolLabel('antigravity'), 'Gemini / Antigravity');
  assert.equal(mcpToolLabel('task_list'), '任务列表检索');
  assert.equal(mcpToolLabel('context'), '读取任务与仓库上下文');
  assert.equal(mcpToolLabel('review_context'), '读取冻结评审快照');
  assert.equal(mcpToolLabel('report_submit'), '提交评审报告');
  assert.equal(mcpToolLabel('unknown_tool'), 'unknown_tool');
  assert.equal(mcpToolLabel(null), '—');
  assert.ok(REPORT_TOOL_OPTIONS.length >= 5);
  assert.ok(DEFAULT_APPROVE_REASON.length > 0);
  assert.ok(APPROVAL_REASON_PRESETS.length >= 2);
  assert.ok(REJECTION_REASON_PRESETS.length >= 2);
});

test('readStoredChoice, writeStoredString, isSubmitShortcut and isEditableTarget handle keyboard & storage safely', () => {
  const store = new Map();
  const mockStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, val) => store.set(key, String(val)),
  };

  assert.equal(readStoredChoice('taskflow.ai.engine', ['codex', 'antigravity', 'cursor'], 'codex', mockStorage), 'codex');
  writeStoredString('taskflow.ai.engine', 'antigravity', mockStorage);
  assert.equal(readStoredChoice('taskflow.ai.engine', ['codex', 'antigravity', 'cursor'], 'codex', mockStorage), 'antigravity');
  writeStoredString('taskflow.ai.engine', 'unknown-cli', mockStorage);
  assert.equal(readStoredChoice('taskflow.ai.engine', ['codex', 'antigravity', 'cursor'], 'codex', mockStorage), 'codex');

  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true }), true);
  assert.equal(isSubmitShortcut({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true, shiftKey: true }), false);
  assert.equal(isSubmitShortcut({ key: 'Enter' }), false);

  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', closest: sel => (sel.includes('.ant-drawer') ? {} : null) }), true);
  assert.equal(isEditableTarget({ tagName: 'BODY', closest: () => null }), false);
});

test('progressSourceLabel, assetMetaCodeLabel, report/waiver presets and formatSubmittedReportMarkdown format cleanly', () => {
  assert.equal(progressSourceLabel('custom', 'web-workbench'), '网页工作台');
  assert.equal(progressSourceLabel('codex-cli', 'dev-1'), 'Codex CLI');
  assert.equal(assetMetaCodeLabel('PRD', 'PRD', 2), '需求文档 · r2');
  assert.equal(assetMetaCodeLabel('CODE', 'payment-gateway', 3), '代码改动 · payment-gateway · r3');
  for (const stage of ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE']) {
    assert.ok(Array.isArray(REPORT_SUMMARY_PRESETS[stage]) && REPORT_SUMMARY_PRESETS[stage].length >= 2);
  }
  assert.ok(WAIVER_REASON_PRESETS.length >= 2);

  const md = formatSubmittedReportMarkdown(
    'CODE_REVIEW',
    { summary: '代码与方案一致', evidence: 'npm test 通过' },
    [
      { severity: 'CRITICAL', title: '并发锁缺失', detail: '需补幂等锁', location: 'src/pay.ts:42', waiver: { id: 'w1', reason: '网关已兜底', actorId: 'u1', createdAt: '' } },
      { severity: 'INFO', title: '命名建议', detail: '可提取常量', location: null, waiver: null },
    ],
  );
  assert.ok(md.includes('## 代码审核报告'));
  assert.ok(md.includes('npm test 通过'));
  assert.ok(md.includes('**[P0 阻断问题]** 并发锁缺失 `src/pay.ts:42`（已豁免：网关已兜底）'));
});

test('buildQuickCommandItems ranks tasks, filters projects, actions and sections accurately', () => {
  const projects = [
    { id: 'p-pay', key: 'DEMO', name: '支付网关', role: 'DEV', jira: { id: '1', key: 'DEMO', name: '支付', baseUrl: 'https://jira.example.com', category: null } },
    { id: 'p-crm', key: 'CRM', name: '客户中心', role: 'LEAD', jira: null },
  ];
  const tasks = [
    { id: 't1', jiraKey: 'DEMO-101', title: '退款幂等性改造', projectId: 'p-pay', parentId: null, type: 'TASK', assigneeId: 'u-other', ownerId: 'u1', status: 'OPEN', version: 1, progress: 0, lastSummary: '', updatedAt: '2026-11-14T10:00:00Z' },
    { id: 't2', jiraKey: 'CRM-202', title: '客户标签导出', projectId: 'p-crm', parentId: null, type: 'STORY', assigneeId: 'u-me', ownerId: 'u1', status: 'IN_PROGRESS', version: 1, progress: 50, lastSummary: '', updatedAt: '2026-11-14T09:00:00Z' },
    { id: 't3', jiraKey: 'DEMO-10', title: '对账单性能优化', projectId: 'p-pay', parentId: null, type: 'TASK', assigneeId: null, ownerId: 'u1', status: 'OPEN', version: 1, progress: 0, lastSummary: '', updatedAt: '2026-11-15T01:00:00Z' },
  ];

  // Empty query ranks my active task (CRM-202) first, includes enabled quick actions, projects and sections
  const initial = buildQuickCommandItems({
    query: '',
    tasks,
    projects,
    currentProjectId: 'p-pay',
    currentUserId: 'u-me',
    canIntake: true,
    canSyncJira: true,
  });
  assert.equal(initial[0].id, 'task:t2');
  assert.ok(initial.some(item => item.id === 'action:intake'));
  assert.ok(initial.some(item => item.id === 'action:sync-jira'));
  assert.ok(initial.some(item => item.id === 'project:p-pay' && item.badge === '当前项目'));
  assert.ok(initial.some(item => item.id === 'section:reviews'));

  // Exact Jira key query puts exact match DEMO-10 ahead of prefix match DEMO-101
  const exactKey = buildQuickCommandItems({
    query: 'demo-10',
    tasks,
    projects,
    currentProjectId: 'p-crm',
    currentUserId: 'u-me',
  });
  assert.equal(exactKey[0].id, 'task:t3');
  assert.equal(exactKey[1].id, 'task:t1');

  // Module keyword query matches review center
  const navQuery = buildQuickCommandItems({
    query: '评审 门禁',
    tasks,
    projects,
  });
  assert.ok(navQuery.some(item => item.id === 'section:reviews'));
});

test('assetDiff parses unified diff stats, classifies diff lines and computes folded revision diffs', () => {
  const patchWithMarkdownHeader = [
    '# 本地 Git 改动快照',
    '- 分支: feature/pay',
    '- 提交: a1b2c3d',
    '',
    'diff --git a/src/pay.ts b/src/pay.ts',
    'index 1111111..2222222 100644',
    '--- a/src/pay.ts',
    '+++ b/src/pay.ts',
    '@@ -10,4 +10,5 @@ export function charge() {',
    '   const fee = 0;',
    '-  return amount;',
    '+  const total = amount + fee;',
    '+  return total;',
    ' }',
  ].join('\n');

  assert.equal(isUnifiedDiffContent(patchWithMarkdownHeader), true);
  assert.equal(isUnifiedDiffContent('# 普通需求文档\n- 条目一\n- 条目二'), false);

  const stats = parseUnifiedDiffStats(patchWithMarkdownHeader);
  assert.equal(stats.hasHunks, true);
  assert.deepEqual(stats.files, ['src/pay.ts']);
  assert.equal(stats.additions, 2, 'only counts + lines inside @@ hunks');
  assert.equal(stats.deletions, 1, 'ignores markdown bullets before diff --git');

  const split = splitUnifiedDiffLines(patchWithMarkdownHeader);
  assert.equal(split[1].kind, 'context');
  assert.ok(split.some(l => l.kind === 'file' && l.text.startsWith('diff --git')));
  assert.ok(split.some(l => l.kind === 'hunk' && l.text.startsWith('@@')));
  assert.equal(classifyDiffLine('+new line', true), 'add');
  assert.equal(classifyDiffLine('-old line', true), 'del');
  assert.equal(classifyDiffLine('-markdown bullet', false), 'context');

  const r1 = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'old target', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n');
  const r2 = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'new target A', 'new target B', 'line 7', 'line 8', 'line 9', 'line 10'].join('\n');
  const revDiff = computeRevisionLineDiff(r1, r2, 2);
  assert.equal(revDiff.identical, false);
  assert.equal(revDiff.additions, 2);
  assert.equal(revDiff.deletions, 1);
  assert.ok(revDiff.rows.some(row => row.type === 'skip' && row.count === 3));
  assert.ok(revDiff.rows.some(row => row.type === 'del' && row.text === 'old target'));
  assert.ok(revDiff.rows.some(row => row.type === 'add' && row.text === 'new target B'));

  const sameDiff = computeRevisionLineDiff(r2, r2);
  assert.equal(sameDiff.identical, true);
  assert.equal(sameDiff.rows.length, 0);
});

test('code material keeps its note, verified test counts and patch available independently', () => {
  const log = ['✖ scenario', 'ℹ tests 19', 'ℹ pass 18', 'ℹ fail 1', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n');
  const patch = [
    'diff --git a/src/example.ts b/src/example.ts',
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const content = [
    '# 代码提交（branch: feature/example, commit: abcdef01）',
    '- 仓库：example（本地目录：/work/example）',
    '- 保留当前测试记录',
    '## 定向测试',
    '```text',
    log,
    '```',
    '## Patch Diff',
    patch,
  ].join('\n');
  const result = buildCodeMaterialPreview(content);

  assert.deepEqual(result.metadata, [
    { label: '分支', value: 'feature/example' },
    { label: '提交', value: 'abcdef01' },
    { label: '仓库', value: 'example' },
  ]);
  assert.deepEqual(result.sections, [
    { type: 'markdown', blocks: [
      { type: 'heading', level: 1, text: '代码提交' },
      { type: 'ul', items: ['保留当前测试记录'] },
      { type: 'heading', level: 2, text: '定向测试' },
    ] },
    { type: 'test', code: log, counts: { tests: 19, pass: 18, fail: 1, cancelled: 0, skipped: 0, todo: 0 } },
    { type: 'diff', code: patch, files: 1, additions: 1, deletions: 1 },
  ]);
  assert.equal(summarizeNodeTests(log.replace('ℹ fail 1', 'ℹ fail 0')), null);
  assert.equal(summarizeNodeTests('tests 19\npass 19\nfail 0'), null);
  assert.deepEqual(buildCodeMaterialPreview('```diff\n' + patch + '\n```').sections, [
    { type: 'diff', code: patch, files: 1, additions: 1, deletions: 1 },
  ]);
});

test('task material imports respect selected accounts and legacy connector permissions', () => {
  const shared = { provider: 'confluence', name: 'Confluence', status: 'CONNECTED', hasCredential: true };
  const personalJira = { provider: 'jira', name: 'Jira', status: 'CONNECTED', hasCredential: true, accountId: 'jira-personal' };
  const newConnection = { ...shared, status: 'UNCONFIGURED', hasCredential: false, localProfileAvailable: true };

  assert.equal(canImportTaskMaterial(shared, false, false), false);
  assert.equal(canImportTaskMaterial(personalJira, false, false), true);
  assert.equal(canImportTaskMaterial({ ...personalJira, status: 'ACCOUNT_UNAVAILABLE' }, false, false), false);
  assert.equal(canImportTaskMaterial({ ...personalJira, hasCredential: false }, false, false), false);
  assert.equal(canImportTaskMaterial(shared, true, false), true);
  assert.equal(canImportTaskMaterial(newConnection, true, false), false);
  assert.equal(canImportTaskMaterial(newConnection, true, true), true);
});

test('Spec-Kit structured templates and Kanban hasDoneAncestor behave accurately', () => {
  const sampleTask = {
    id: 't1',
    jiraKey: 'DEMO-888',
    title: '预授权分账改造',
    projectId: 'p1',
    parentId: null,
    type: 'STORY',
    assigneeId: 'u1',
    ownerId: 'u1',
    status: 'IN_PROGRESS',
    version: 1,
    progress: 40,
    lastSummary: '',
    updatedAt: '2026-11-15T10:00:00Z',
  };
  const prdTpl = buildAssetTemplate('PRD', sampleTask);
  assert.match(prdTpl.content, /非目标与范围外边界（Non-Goals）/);
  assert.match(prdTpl.content, /核心功能与状态流转规则/);

  const specTpl = buildAssetTemplate('TECH_SPEC', sampleTask, '/workspace/pay-service');
  assert.match(specTpl.content, /核心接口契约（Golden Contract）与数据模型/);
  assert.match(specTpl.content, /可观测性、风险评估与回滚预案/);

  const nodes = [
    { id: 'root-open', status: 'IN_PROGRESS', parentId: null },
    { id: 'child-done', status: 'DONE', parentId: 'root-open' },
    { id: 'root-done', status: 'DONE', parentId: null },
    { id: 'frozen-child', status: 'IN_PROGRESS', parentId: 'root-done' },
  ];
  assert.equal(isTaskFrozen(nodes[1], nodes), true);
  assert.equal(hasDoneAncestor(nodes[1], nodes), false, 'DONE leaf under open parent can be dragged out of DONE to reopen');
  assert.equal(hasDoneAncestor(nodes[3], nodes), true, 'child under DONE ancestor cannot be dragged until ancestor reopens');
});

test('analyzeAssetRiskSignals performs diff-aware static guardrail scanning without false positives on removed lines', () => {
  assert.deepEqual(analyzeAssetRiskSignals(''), { tier: 'NONE', signals: [] });

  // Removing a legacy console.log inside a patch hunk should NOT trigger DEBUG_LEFTOVER
  const cleanCleanupPatch = [
    'diff --git a/src/utils/math.ts b/src/utils/math.ts',
    '--- a/src/utils/math.ts',
    '+++ b/src/utils/math.ts',
    '@@ -1,4 +1,3 @@',
    ' export function sum(a: number, b: number) {',
    '-  console.log("legacy debug", a, b);',
    '+  return a + b;',
    ' }',
  ].join('\n');
  const cleanRes = analyzeAssetRiskSignals(cleanCleanupPatch);
  assert.equal(cleanRes.tier, 'NONE');
  assert.equal(cleanRes.signals.length, 0);

  // Payment + SQL migration + added console.log triggers HIGH tier with structured signals
  const highRiskPatch = [
    'diff --git a/migrations/009_settlement.sql b/migrations/009_settlement.sql',
    '--- a/migrations/009_settlement.sql',
    '+++ b/migrations/009_settlement.sql',
    '@@ -1,2 +1,4 @@',
    '+ALTER TABLE payment_ledger ADD COLUMN settle_batch VARCHAR(64);',
    '+console.log("debug migration");',
  ].join('\n');
  const highRes = analyzeAssetRiskSignals(highRiskPatch);
  assert.equal(highRes.tier, 'HIGH');
  assert.ok(highRes.signals.some(s => s.code === 'SCHEMA_MIGRATION' && s.level === 'HIGH'));
  assert.ok(highRes.signals.some(s => s.code === 'PAYMENT_CORE' && s.level === 'MEDIUM'));
  assert.ok(highRes.signals.some(s => s.code === 'DEBUG_LEFTOVER' && s.level === 'LOW'));

  // Auth + Infra config triggers MEDIUM tier
  const authInfraDoc = '修改 Dockerfile 与 src/auth/jwtMiddleware.ts 中的 RBAC 校验逻辑';
  const medRes = analyzeAssetRiskSignals(authInfraDoc);
  assert.equal(medRes.tier, 'MEDIUM');
  assert.ok(medRes.signals.some(s => s.code === 'AUTH_SECURITY'));
  assert.ok(medRes.signals.some(s => s.code === 'INFRA_CONFIG'));

  // Synthetic PEM header marker triggers SECRET_PATTERN without echoing content
  const syntheticMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const secRes = analyzeAssetRiskSignals(syntheticMarker);
  assert.equal(secRes.tier, 'HIGH');
  assert.equal(secRes.signals[0].code, 'SECRET_PATTERN');
  assert.equal(secRes.signals[0].label.includes('PRIVATE'), false);
});

test('taskContextPack deduplicates latest asset revisions, exports Markdown & XML prompts, and formats batch task checklists', () => {
  assert.equal(estimateContextTokens(''), 0);
  assert.ok(estimateContextTokens('退款幂等性改造 Refund Idempotency') > 8);

  const task = {
    id: 't-pack',
    jiraKey: 'DEMO-901',
    title: '跨境清分网关 <v2> & 幂等改造',
    projectId: 'default',
    parentId: null,
    type: 'STORY',
    assigneeId: 'u-dev',
    ownerId: 'u-lead',
    status: 'IN_REVIEW',
    version: 2,
    progress: 75,
    lastSummary: '已完成核心对账逻辑',
    updatedAt: '2026-11-15T12:00:00Z',
    externalRef: {
      key: 'DEMO-901',
      title: '跨境清分网关 <v2>',
      status: 'In Progress',
      url: 'https://jira.example.com/browse/DEMO-901',
      description: '支持 T+1 多币种清分与失败重试。',
    },
  };
  const assets = [
    { id: 'a1', taskId: 't-pack', projectId: 'default', kind: 'PRD', logicalKey: 'PRD', title: 'PRD 初稿', content: 'v1 prd', revision: 1, sha256: '111111111111aaaa', actorId: 'u1', createdAt: '' },
    { id: 'a2', taskId: 't-pack', projectId: 'default', kind: 'CODE', logicalKey: 'gateway', title: 'Gateway diff', content: '+export const ok = 1;', revision: 1, sha256: '333333333333cccc', actorId: 'u1', createdAt: '' },
    { id: 'a3', taskId: 't-pack', projectId: 'default', kind: 'PRD', logicalKey: 'PRD', title: 'PRD 终稿', content: 'v2 prd <escaped>', revision: 2, sha256: '222222222222bbbb', actorId: 'u1', createdAt: '' },
  ];
  const latest = selectLatestAssets(assets);
  assert.equal(latest.length, 2);
  assert.equal(latest[0].id, 'a3', 'PRD r2 supersedes r1 and sorts before CODE');
  assert.equal(latest[1].id, 'a2');

  const gates = {
    overall: 'BLOCKED',
    gates: [
      { stage: 'PRD', status: 'PASS', reason: '已审批通过' },
      { stage: 'TECH_SPEC', status: 'MISSING_INPUT', reason: '缺少输入：TECH_SPEC' },
    ],
  };
  const jobs = [
    {
      id: 'j-active',
      taskId: 't-pack',
      projectId: 'default',
      stage: 'PRD',
      status: 'APPROVED',
      executionMode: 'HUMAN_REVIEW',
      actorId: 'u1',
      createdAt: '',
      stale: false,
      soloMode: false,
      report: { id: 'r1', summary: '需求边界清晰', source: 'MANUAL', tool: null, evidence: null, actorId: 'u1', createdAt: '' },
      findings: [{ id: 'f1', severity: 'WARNING', title: '币种精度说明', detail: '需明确 JPY 无小数位', location: 'PRD#L12', waiver: null }],
      decision: { id: 'd1', decision: 'APPROVE', reason: '同意进入研发', actorId: 'u2', createdAt: '' },
    },
    {
      id: 'j-stale',
      taskId: 't-pack',
      projectId: 'default',
      stage: 'PRD',
      status: 'CHANGES_REQUESTED',
      executionMode: 'HUMAN_REVIEW',
      actorId: 'u1',
      createdAt: '',
      stale: true,
      soloMode: false,
      report: { id: 'r0', summary: '旧版过期评审', source: 'MANUAL', tool: null, evidence: null, actorId: 'u1', createdAt: '' },
      findings: [],
      decision: null,
    },
  ];
  const progressEvents = [
    { id: 'p1', taskId: 't-pack', actorId: 'u-dev', progress: 75, summary: '完成清分核心单测', branch: 'feat/demo-901', commitSha: 'abc1234', createdAt: '' },
  ];

  const mdPack = buildTaskContextPack({
    task,
    assets,
    jobs,
    gates,
    progressEvents,
    repoPath: '/workspace/pay-gateway',
    constitutionFiles: ['AGENTS.md', 'CLAUDE.md'],
    format: 'markdown',
    latestAssetsOnly: true,
  });
  assert.equal(mdPack.includedAssetCount, 2);
  assert.ok(mdPack.estimatedTokens > 40);
  assert.ok(mdPack.byteLength > 200);
  assert.ok(mdPack.content.includes('`AGENTS.md` · `CLAUDE.md`'));
  assert.ok(mdPack.content.includes('PRD 终稿'));
  assert.equal(mdPack.content.includes('PRD 初稿'), false, 'superseded r1 omitted when latestAssetsOnly=true');
  assert.equal(mdPack.content.includes('旧版过期评审'), false, 'stale review omitted');
  assert.ok(mdPack.content.includes('币种精度说明 `PRD#L12`'));

  const xmlPack = buildTaskContextPack({
    task,
    assets,
    jobs,
    gates,
    progressEvents,
    repoPath: '/workspace/pay-gateway',
    constitutionFiles: ['AGENTS.md'],
    format: 'xml',
    latestAssetsOnly: false,
  });
  assert.equal(xmlPack.includedAssetCount, 3);
  assert.ok(xmlPack.content.startsWith('<task_context jira_key="DEMO-901"'));
  assert.ok(xmlPack.content.includes('&lt;v2&gt; &amp; 幂等改造'));
  assert.ok(xmlPack.content.includes('v2 prd &lt;escaped&gt;'));
  assert.ok(xmlPack.content.includes('<engineering_constitution files="AGENTS.md">'));
  assert.ok(xmlPack.content.endsWith('</task_context>'));

  const batchMd = formatBatchTasksMarkdown(
    [
      task,
      { ...task, id: 't-done', jiraKey: 'DEMO-900', title: '前置账务配置', status: 'DONE', progress: 100, assigneeId: null },
    ],
    [{ id: 'u-dev', username: 'dev1', role: 'DEV' }],
  );
  assert.ok(batchMd.includes('- [ ] **DEMO-901** 跨境清分网关 <v2> & 幂等改造（评审中 · dev1 · 75%）'));
  assert.ok(batchMd.includes('- [x] **DEMO-900** 前置账务配置（已完成 · 未指派 · 100%）'));
});

test('findingFixPrompt builds surgical single and batch AI fix prompts while excluding waived findings', () => {
  const findings = [
    { id: 'f-info', severity: 'INFO', title: '常量提取', detail: '提取超时时间常量', location: 'src/config.ts:8', waiver: null },
    { id: 'f-waived', severity: 'CRITICAL', title: '旧兼容分支', detail: '网关层已拦截', location: 'src/legacy.ts:12', waiver: { id: 'w1', reason: '上游已兜底', actorId: 'u-lead', createdAt: '' } },
    { id: 'f-crit', severity: 'CRITICAL', title: '并发重入锁缺失', detail: '清分重试未加分布式幂等锁', location: 'src/settle.ts:88', waiver: null },
    { id: 'f-warn', severity: 'WARN', title: '缺少空数组校验', detail: '批量分账明细为空时需提前返回', location: 'src/settle.ts:45', waiver: null },
  ];

  const sorted = sortActionableFindings(findings);
  assert.deepEqual(sorted.map(f => f.id), ['f-crit', 'f-warn', 'f-info']);

  const singlePrompt = buildSingleFindingFixPrompt({
    task: { jiraKey: 'DEMO-910', title: '清分幂等锁增强' },
    stage: 'CODE_REVIEW',
    finding: sorted[0],
    repoPath: '/workspace/pay-core',
    constitutionFiles: ['AGENTS.md', 'CLAUDE.md'],
  });
  assert.ok(singlePrompt.includes('DEMO-910'));
  assert.ok(singlePrompt.includes('代码审核'));
  assert.ok(singlePrompt.includes('`src/settle.ts:88`'));
  assert.ok(singlePrompt.includes('`/workspace/pay-core`'));
  assert.ok(singlePrompt.includes('`AGENTS.md`、`CLAUDE.md`'));
  assert.ok(singlePrompt.includes('Surgical Fix'));

  const batchPrompt = buildBatchFindingsFixPrompt({
    task: { jiraKey: 'DEMO-910', title: '清分幂等锁增强' },
    stage: 'CODE_REVIEW',
    findings,
    summary: '核心清分链路存在并发重入隐患，需补齐锁与边界校验。',
    repoPath: '/workspace/pay-core',
    constitutionFiles: ['AGENTS.md'],
  });
  assert.ok(batchPrompt.includes('3 项未豁免评审发现项（阻断 1 / 风险 1 / 建议 1）'));
  assert.equal(batchPrompt.includes('旧兼容分支'), false, 'waived finding excluded from fix prompt');
  assert.ok(batchPrompt.indexOf('并发重入锁缺失') < batchPrompt.indexOf('缺少空数组校验'), 'CRITICAL ordered before WARN');
  assert.ok(batchPrompt.includes('- [ ] 修复 #1：并发重入锁缺失 (`src/settle.ts:88`)'));

  assert.equal(buildBatchFindingsFixPrompt({ task: { jiraKey: 'DEMO-1', title: 'T' }, stage: 'PRD', findings: [findings[1]] }), '');
});

test('releaseReadiness computes 0-100 scorecard, enforces rollback checks on high-risk diffs, and exports CAB dossier', () => {
  const task = {
    id: 't-rel',
    jiraKey: 'DEMO-920',
    title: '账务核心表扩容与清分切换',
    projectId: 'default',
    parentId: null,
    type: 'RELEASE',
    assigneeId: 'u-dev',
    ownerId: 'u-lead',
    status: 'IN_REVIEW',
    version: 3,
    progress: 90,
    lastSummary: '预发验证通过',
    updatedAt: '2026-11-15T15:00:00Z',
  };
  const baseAssets = [
    { id: 'a-prd', taskId: 't-rel', projectId: 'default', kind: 'PRD', logicalKey: 'PRD', title: '账务扩容需求', content: '# 验收标准\n1. AC-01 支持分表清分\n2. AC-02 幂等锁定', revision: 1, sha256: 'aaaa111122223333', actorId: 'u-pm', createdAt: '' },
    { id: 'a-spec', taskId: 't-rel', projectId: 'default', kind: 'TECH_SPEC', logicalKey: 'TECH_SPEC', title: '分表技术方案', content: 'ALTER TABLE payment_ledger ADD COLUMN shard_id INT;', revision: 2, sha256: 'bbbb111122223333', actorId: 'u-dev', createdAt: '' },
    { id: 'a-code', taskId: 't-rel', projectId: 'default', kind: 'CODE', logicalKey: 'CODE', title: '清分改动', content: 'diff --git a/migrations/01_pay.sql b/migrations/01_pay.sql\n@@ -1,1 +1,2 @@\n+ALTER TABLE payment_ledger ADD COLUMN shard_id INT;', revision: 1, sha256: 'cccc111122223333', actorId: 'u-dev', createdAt: '' },
    { id: 'a-test', taskId: 't-rel', projectId: 'default', kind: 'TEST_CASE', logicalKey: 'TEST_CASE', title: '清分回归用例', content: '- [x] TC-01 正向清分验证，关联 AC-01\n- [x] TC-02 异常幂等边界验证，关联 AC-02\n- [x] TC-03 并发对账断言', revision: 1, sha256: 'dddd111122223333', actorId: 'u-qa', createdAt: '' },
  ];
  assert.equal(countStructuredTestItems(baseAssets[3].content), 3);

  // Missing RELEASE_PLAN when SQL migration + payment risk is present triggers highRiskRequiresRollback
  const partialEval = evaluateReleaseReadiness({
    task,
    assets: baseAssets,
    jobs: [],
    gates: { overall: 'BLOCKED', gates: [] },
  });
  assert.equal(partialEval.highRiskRequiresRollback, true);
  assert.ok(partialEval.highRiskLabels.length >= 2);
  assert.ok(partialEval.checks.find(c => c.id === 'rollback')?.status === 'fail');

  // Complete all 5 assets (including explicit rollback steps) and all 5 gate approvals (with 1 waived CRITICAL)
  const fullAssets = [
    ...baseAssets,
    { id: 'a-rel', taskId: 't-rel', projectId: 'default', kind: 'RELEASE_PLAN', logicalKey: 'RELEASE_PLAN', title: '灰度上线与回滚预案', content: '1. 灰度 5% 流量\n2. 异常超阈值立即执行 Feature Flag 降级与回滚步骤', revision: 1, sha256: 'eeee111122223333', actorId: 'u-sre', createdAt: '' },
  ];
  const stages = ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE'];
  const fullJobs = stages.map((stage, idx) => ({
    id: `j-${stage}`,
    taskId: 't-rel',
    projectId: 'default',
    stage,
    status: 'APPROVED',
    executionMode: 'HUMAN_REVIEW',
    actorId: 'u-dev',
    createdAt: '',
    stale: false,
    soloMode: false,
    report: { id: `r-${idx}`, summary: '通过', source: 'MANUAL', tool: null, evidence: null, actorId: 'u-qa', createdAt: '' },
    findings: stage === 'CODE_REVIEW'
      ? [{ id: 'f-w', severity: 'CRITICAL', title: '双写开关默认值', detail: '需确认默认关闭', location: 'src/flag.ts:3', waiver: { id: 'w-1', reason: '配置中心已锁死默认关闭', actorId: 'u-lead', createdAt: '' } }]
      : [],
    decision: { id: `d-${idx}`, decision: 'APPROVE', reason: '核验通过', actorId: 'u-lead', createdAt: '2026-11-15T16:00:00Z' },
  }));
  const fullGates = {
    overall: 'PASS',
    gates: stages.map(stage => ({ stage, status: 'PASS', jobId: `j-${stage}`, reason: '核验通过' })),
  };

  const readyEval = evaluateReleaseReadiness({
    task,
    assets: fullAssets,
    jobs: fullJobs,
    gates: fullGates,
  });
  assert.equal(readyEval.score, 100);
  assert.equal(readyEval.grade, 'READY');
  assert.equal(readyEval.highRiskRequiresRollback, false);
  assert.equal(readyEval.unwaivedCriticalCount, 0);
  assert.equal(readyEval.waivedCriticalCount, 1);

  const reviewedSha = 'a'.repeat(40);
  const approvedCode = {
    ...fullAssets[2], logicalKey: 'gitlab:gitlab_mr:verified',
    sourceUrl: 'https://git.example/team/repository/-/merge_requests/7',
    content: JSON.stringify({ sha: reviewedSha }),
  };
  const approvalJobs = fullJobs.map(job => ({ ...job, snapshot: { assets: [approvedCode] } }));
  const releaseRun = {
    ...fullAssets[4], logicalKey: 'jenkins:jenkins_build:verified', title: 'release #17',
    content: JSON.stringify({ number: 17, building: false, gitCheckouts: [{ repository: 'git@git.example:team/repository.git', commit: reviewedSha }] }),
  };
  const partialCases = { ...fullAssets[3], revision: 2, content: '## 测试用例\n- TC-01 覆盖 AC-01\n- [ ] TC-03 回归\n```md\nTC-02 覆盖 AC-02\n```' };
  const evaluate = (run, jobs = approvalJobs, gates = fullGates) => evaluateReleaseReadiness({
    task,
    assets: [...fullAssets, partialCases, { ...approvedCode, revision: 2, content: JSON.stringify({ sha: 'f'.repeat(40) }) }, run],
    jobs, gates,
  });
  const applied = evaluate(releaseRun).checks;
  assert.equal(applied.find(c => c.id === 'traceability').status, 'fail');
  assert.match(applied.find(c => c.id === 'traceability').evidence[1], /AC-02.+未找到关联用例/);
  assert.equal(applied.find(c => c.id === 'buildCommit').status, 'pass', 'uses the approved snapshot, not the current asset');
  const otherSha = 'b'.repeat(40);
  const checkout = (repository, commit) => ({
    ...releaseRun, content: JSON.stringify({ number: 17, building: false, gitCheckouts: [{ repository, commit }] }),
  });
  const mismatch = evaluate(checkout('https://git.example/team/repository', otherSha)).checks.find(c => c.id === 'buildCommit');
  assert.equal(mismatch.status, 'fail');
  assert.ok(mismatch.evidence[0].includes(reviewedSha) && mismatch.evidence[0].includes(otherSha));
  assert.equal(evaluate(checkout('https://git.example/other/repository', otherSha)).checks.find(c => c.id === 'buildCommit').status, 'warn');
  assert.equal(evaluate(checkout('https://git.example/team/repository', reviewedSha.slice(0, 7))).checks.find(c => c.id === 'buildCommit').status, 'warn');
  assert.equal(evaluate(releaseRun, approvalJobs.map(job => ({ ...job, stale: true }))).checks.find(c => c.id === 'buildCommit').status, 'warn');

  const dossier = buildReleaseDossierMarkdown({
    task,
    assets: fullAssets,
    jobs: fullJobs,
    gates: fullGates,
    members: [
      { id: 'u-dev', username: 'dev1', role: 'DEV' },
      { id: 'u-lead', username: 'lead1', role: 'LEAD' },
    ],
    repoPath: '/workspace/pay-core',
  });
  assert.ok(dossier.includes('**100 / 100**'));
  assert.ok(dossier.includes('| 代码审核 | 清分改动 (`r1`) | `cccc11112222` | 已通过 | lead1（含 1 项豁免） |'));
  assert.ok(dossier.includes('双写开关默认值 — 豁免人：lead1；理由：配置中心已锁死默认关闭'));
});

test('auditLogUtils maps actions, supports actor:/action: qualifiers, and prevents CSV formula injection on export', () => {
  assert.equal(describeAuditAction('FINDING_WAIVER').category, 'review');
  assert.equal(describeAuditAction('FINDING_WAIVER').label, '豁免阻断发现项');
  assert.equal(describeAuditAction('CUSTOM_FUTURE_EVENT').label, 'CUSTOM_FUTURE_EVENT');

  const parsed = parseAuditSearchQuery('actor:lead1 action:waiver DEMO-920');
  assert.deepEqual(parsed, { actorFilter: 'lead1', actionFilter: 'waiver', terms: ['demo-920'] });

  const records = [
    { id: '1', actorId: 'u-lead', action: 'FINDING_WAIVER', targetId: 't-1', createdAt: '2026-11-15T10:00:00Z', projectId: 'default' },
    { id: '2', actorId: 'u-dev', action: 'ASSET_GIT_CAPTURE', targetId: '=CMD|\' /C calc\'!A0', createdAt: '2026-11-15T10:05:00Z', projectId: 'default' },
  ];
  const resolvers = {
    resolveActorName: id => (id === 'u-lead' ? 'lead1' : 'dev1'),
    resolveTargetLabel: rec => (rec.targetId === 't-1' ? 'DEMO-920 · 账务扩容' : rec.targetId || ''),
  };

  const filtered = filterAuditRecords(records, {
    category: 'review',
    query: 'actor:lead1 action:豁免 DEMO-920',
    ...resolvers,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, '1');

  // Formula injection neutralization check
  assert.equal(sanitizeCsvCell("=CMD|' /C calc'!A0"), "'=CMD|' /C calc'!A0");
  assert.equal(sanitizeCsvCell('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(sanitizeCsvCell('normal, "quoted"'), '"normal, ""quoted"""');

  const csv = exportAuditRecordsCsv(records, resolvers);
  assert.ok(csv.startsWith('\uFEFF时间(ISO),操作人,动作标识,事件说明,分类,目标对象,项目ID\n'));
  assert.ok(csv.includes("'=CMD|' /C calc'!A0"), 'CSV cell starting with = is prefixed with single quote');

  const jsonl = exportAuditRecordsJsonl(records, resolvers);
  const parsedLines = jsonl.split('\n').map(line => JSON.parse(line));
  assert.equal(parsedLines.length, 2);
  assert.equal(parsedLines[0].actorName, 'lead1');
  assert.equal(parsedLines[0].actionLabel, '豁免阻断发现项');

  // QuickCommand search also matches "审计 合规" -> section:members
  const auditNav = buildQuickCommandItems({
    query: '审计 合规',
    tasks: [],
    projects: [],
  });
  assert.ok(auditNav.some(item => item.id === 'section:members'));
});

test('subtaskDecomposer allocates collision-free Jira keys, skips non-goal sections & checked items, and infers subtask types', () => {
  const keys = allocateNextJiraKeys('DEMO-800', ['demo-801', 'DEMO-803'], 3);
  assert.deepEqual(keys, ['DEMO-802', 'DEMO-804', 'DEMO-805']);

  assert.equal(inferSubtaskType('修复并发重复扣款缺陷'), 'BUG');
  assert.equal(inferSubtaskType('配置 5% 灰度放量与五分钟回滚演练'), 'RELEASE');
  assert.equal(inferSubtaskType('新增清结算对账 RPC 接口'), 'TASK');

  const parentTask = {
    id: 't-parent',
    jiraKey: 'DEMO-900',
    title: '预授权增量结算升级',
    projectId: 'default',
    parentId: null,
    type: 'STORY',
    assigneeId: 'u-dev',
    ownerId: 'u-pm',
    status: 'IN_PROGRESS',
    version: 1,
    progress: 20,
    lastSummary: '',
    updatedAt: '',
  };
  const existingChild = {
    ...parentTask,
    id: 't-child-1',
    jiraKey: 'DEMO-901',
    title: '完成数据库增量清分表索引设计',
    parentId: 't-parent',
    type: 'TASK',
  };

  const assets = [
    {
      id: 'a-spec',
      taskId: 't-parent',
      projectId: 'default',
      kind: 'TECH_SPEC',
      logicalKey: 'default',
      title: '技术方案',
      revision: 1,
      sha256: '1111',
      actorId: 'u-dev',
      createdAt: '',
      sourceUrl: null,
      content: [
        '## 业务背景',
        '- 老系统历史包袱说明（不应拆为子任务）',
        '## 本次非目标 (Non-Goals)',
        '- 不改造跨境外币通道',
        '## 核心改造点',
        '- [x] 已完成本地原型调研',
        '- [ ] 完成数据库增量清分表索引设计',
        '- [ ] 实现 **幂等扣款接口** 与状态机流转',
        '- 修复重试超时导致的偶发锁等待报错',
        '- 配置生产灰度放量与应急回滚开关',
      ].join('\n'),
    },
  ];

  const extracted = extractSubtaskCandidatesFromSpecs({
    parentTask,
    assets,
    existingTasks: [parentTask, existingChild],
  });
  assert.equal(extracted.length, 3);
  assert.deepEqual(
    extracted.map(c => ({ jiraKey: c.jiraKey, title: c.title, type: c.type, source: c.source })),
    [
      { jiraKey: 'DEMO-902', title: '实现 幂等扣款接口 与状态机流转', type: 'TASK', source: 'TECH_SPEC' },
      { jiraKey: 'DEMO-903', title: '修复重试超时导致的偶发锁等待报错', type: 'BUG', source: 'TECH_SPEC' },
      { jiraKey: 'DEMO-904', title: '配置生产灰度放量与应急回滚开关', type: 'RELEASE', source: 'TECH_SPEC' },
    ],
  );

  const std = buildStandardDeliverySubtasks(parentTask, [parentTask, existingChild]);
  assert.equal(std.length, 4);
  assert.equal(std[0].jiraKey, 'DEMO-902');
  assert.equal(std[3].type, 'RELEASE');

  const localParent = { ...parentTask, jiraKey: 'LOCAL-T' + 'A'.repeat(32) };
  const localExtracted = extractSubtaskCandidatesFromSpecs({ parentTask: localParent, assets, existingTasks: [existingChild] });
  const localStandard = buildStandardDeliverySubtasks(localParent, [existingChild]);
  for (const [local, jira] of [[localExtracted, extracted], [localStandard, std]]) {
    assert.deepEqual(local.map(item => item.title), jira.map(item => item.title));
    assert.ok(local.every(item => item.jiraKey === ''), '本地子任务编号应由服务端生成');
  }
  assert.deepEqual(allocateNextJiraKeys(localParent.jiraKey, [], 1), []);
});

test('assetDiff Side-by-Side pairs deletions with additions, tracks dual line numbers, and handles revision diffs', () => {
  const unified = [
    'diff --git a/src/pay.ts b/src/pay.ts',
    '--- a/src/pay.ts',
    '+++ b/src/pay.ts',
    '@@ -10,4 +10,5 @@',
    ' const base = 100;',
    '-const retry = 1;',
    '+const retry = 3;',
    '+const timeoutMs = 2000;',
    ' return base;',
  ].join('\n');

  const splitRows = buildSideBySideUnifiedDiff(unified);
  const pairs = splitRows.filter(r => r.kind === 'pair');
  assert.equal(pairs.length, 4);

  // 1st pair: unchanged context line 10 / 10
  assert.deepEqual(pairs[0], {
    kind: 'pair',
    leftLine: 10,
    leftText: 'const base = 100;',
    leftType: 'context',
    rightLine: 10,
    rightText: 'const base = 100;',
    rightType: 'context',
  });
  // 2nd pair: paired modification line 11 -> 11
  assert.deepEqual(pairs[1], {
    kind: 'pair',
    leftLine: 11,
    leftText: 'const retry = 1;',
    leftType: 'del',
    rightLine: 11,
    rightText: 'const retry = 3;',
    rightType: 'add',
  });
  // 3rd pair: extra addition padded with empty left cell
  assert.deepEqual(pairs[2], {
    kind: 'pair',
    leftLine: undefined,
    leftText: undefined,
    leftType: 'empty',
    rightLine: 12,
    rightText: 'const timeoutMs = 2000;',
    rightType: 'add',
  });
  // 4th pair: trailing context line 12 / 13
  assert.equal(pairs[3].leftLine, 12);
  assert.equal(pairs[3].rightLine, 13);

  const rev = computeRevisionLineDiff('line1\noldVal\nline3', 'line1\nnewValA\nnewValB\nline3');
  const revSplit = pairRevisionDiffSideBySide(rev.rows);
  const revPairs = revSplit.filter(r => r.kind === 'pair');
  assert.equal(revPairs.length, 4);
  assert.equal(revPairs[1].leftType, 'del');
  assert.equal(revPairs[1].rightType, 'add');
  assert.equal(revPairs[2].leftType, 'empty');
  assert.equal(revPairs[2].rightType, 'add');
});

test('markdownLite parses GFM tables, checklists, code fences, and strictly blocks unsafe link protocols', () => {
  assert.equal(isSafeHttpUrl('https://docs.example.com/spec'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html;base64,PHNjcmlwdD4='), false);

  const inline = parseInlineTokens('查看 [安全文档](https://example.com/doc) 与 [危险链接](javascript:alert(1)) 及 `order_id` **必填**');
  assert.ok(inline.some(t => t.type === 'link' && t.href === 'https://example.com/doc'));
  assert.equal(inline.some(t => t.type === 'link' && t.href.startsWith('javascript:')), false);
  assert.ok(inline.some(t => t.type === 'code' && t.text === 'order_id'));
  assert.ok(inline.some(t => t.type === 'strong' && t.text === '必填'));

  const figmaUrl = 'https://www.figma.com/design/file/%E8%AE%BE%E8%AE%A1?node-id=402-28144&t=abc-1#preview';
  const docUrl = 'https://example.com/wiki/Balance_(finance)';
  const prose = `设计稿：${figmaUrl}，文档 (${docUrl}). 示例 \`https://example.com/literal\``;
  const proseTokens = parseInlineTokens(prose);
  assert.deepEqual(proseTokens.filter(token => token.type === 'link').map(token => token.href), [figmaUrl, docUrl]);
  assert.ok(proseTokens.some(token => token.type === 'code' && token.text === 'https://example.com/literal'));
  assert.deepEqual(parseInlineTokens('<https://example.com/a>'), [
    { type: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
  ]);
  assert.deepEqual(parseInlineTokens('https://user:pass@example.com/a'), [
    { type: 'text', text: 'https://user:pass@example.com/a' },
  ]);

  const md = [
    '# 灰度发布核查单',
    '| 指标 | 阈值 |',
    '| --- | --- |',
    '| 错误率 | < 0.1% |',
    '',
    '- [x] 完成影子库压测',
    '- [ ] 确认 5 分钟回滚脚本',
    '',
    '```sql',
    'SELECT count(*) FROM orders;',
    '```',
  ].join('\n');

  assert.equal(isLikelyMarkdown(md, 'RELEASE_PLAN'), true);
  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[1].type, 'table');
  assert.deepEqual(blocks[1].headers, ['指标', '阈值']);
  assert.deepEqual(blocks[1].rows, [['错误率', '< 0.1%']]);
  assert.equal(blocks[2].type, 'checklist');
  assert.deepEqual(summarizeMarkdownChecklists(blocks), { checked: 1, total: 2 });
  assert.equal(blocks[3].type, 'code');
  assert.equal(blocks[3].lang, 'sql');
});

test('policyPluginPresets scopes multi-project IDs cleanly and uiPreferences persists saved filter views per project', () => {
  assert.equal(POLICY_PLUGIN_PRESETS.length, 4);
  assert.equal(buildScopedPluginId('sql-migration-safety', 'default', 'DEFAULT'), 'sql-migration-safety');
  const scoped = buildScopedPluginId('sql-migration-safety', 'proj-uuid-1', 'DEMO_CORE');
  assert.equal(scoped, 'sql-migration-safety-demo-core');
  assert.match(scoped, /^[a-z][a-z0-9-]*$/);
  assert.ok(scoped.length <= 64);
  assert.equal(isPresetInstalled('sql-migration-safety', [{ id: scoped, name: 'SQL', version: '1.0.0', stages: ['RELEASE'] }], 'proj-uuid-1', 'DEMO_CORE'), true);

  const mem = new Map();
  const storage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v); },
  };

  const afterFirst = saveTaskFilterView('proj-a', {
    name: '待我推进 · 2.4版本',
    quickScope: 'mine',
    statusFilter: 'IN_PROGRESS',
    jiraVersionFilter: 'v2.4.0',
    viewMode: 'board',
  }, storage);
  assert.equal(afterFirst.length, 1);
  assert.equal(readSavedTaskViews('proj-b', storage).length, 0);

  // Saving with same name updates in place rather than duplicating
  const afterUpdate = saveTaskFilterView('proj-a', {
    name: '待我推进 · 2.4版本',
    quickScope: 'mine',
    statusFilter: 'IN_REVIEW',
    jiraVersionFilter: 'v2.4.0',
  }, storage);
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0].statusFilter, 'IN_REVIEW');
  assert.equal(
    isSavedViewActive(afterUpdate[0], {
      quickScope: 'mine',
      statusFilter: 'IN_REVIEW',
      jiraVersionFilter: 'v2.4.0',
    }),
    true,
  );

  const afterDelete = deleteSavedTaskView('proj-a', afterUpdate[0].id, storage);
  assert.equal(afterDelete.length, 0);
});

test('standupDigest builds anti-hallucination personal & sprint Markdown reports and QuickCommand exposes standup-digest action', () => {
  const user = { id: 'u-dev', username: 'alice_dev', role: 'DEV' };
  const projects = [{ id: 'p-1', key: 'DEMO', name: '支付清结算', role: 'DEV' }];
  const tasks = [
    {
      id: 't-done',
      jiraKey: 'DEMO-101',
      title: '完成对账批次锁优化',
      projectId: 'p-1',
      parentId: null,
      type: 'TASK',
      assigneeId: 'u-dev',
      ownerId: 'u-pm',
      status: 'DONE',
      version: 2,
      progress: 100,
      lastSummary: '压测通过',
      updatedAt: '2026-11-15T10:00:00.000Z',
      externalRef: { url: 'https://jira.example.com/browse/DEMO-101', status: 'Done', type: 'Task' },
    },
    {
      id: 't-active',
      jiraKey: 'DEMO-102',
      title: '实现增量预授权回滚接口',
      projectId: 'p-1',
      parentId: null,
      type: 'STORY',
      assigneeId: 'u-dev',
      ownerId: 'u-pm',
      status: 'IN_PROGRESS',
      version: 3,
      progress: 65,
      lastSummary: '已完成幂等状态机与单测',
      updatedAt: '2026-11-15T12:00:00.000Z',
      externalRef: { url: 'javascript:alert(1)', status: 'In Progress', type: 'Story' },
    },
  ];
  const pendingJobs = [
    {
      id: 'j-1',
      taskId: 't-active',
      projectId: 'p-1',
      stage: 'TECH_SPEC',
      status: 'REPORT_SUBMITTED',
      createdAt: '2026-11-15T08:00:00.000Z',
      stale: false,
      decision: null,
      hasBlockingFindings: true,
      prerequisitesBlocked: false,
      report: { id: 'r-1', actorId: 'u-dev', source: 'LOCAL_TOOL', tool: 'codex-cli', createdAt: '2026-11-15T09:00:00.000Z' },
    },
  ];
  const workspaces = [{ projectId: 'p-1', repoPath: '/Users/dev/workspace/demo-core', defaultTarget: 'workbench', updatedAt: '' }];
  const now = new Date('2026-11-15T14:00:00.000Z');

  const personalMd = buildPersonalStandupDigest({
    user,
    projects,
    tasks,
    pendingJobs,
    workspaces,
    openBlockersCount: 2,
    now,
  });
  assert.match(personalMd, /# 研发晨会简报 · 2026-11-15/);
  assert.match(personalMd, /\[DEMO-101\]\(https:\/\/jira\.example\.com\/browse\/DEMO-101\)/);
  assert.equal(personalMd.includes('javascript:alert'), false);
  assert.match(personalMd, /`DEMO-102` \*\*实现增量预授权回滚接口\*\*（进行中 · 进度 65% · 仓库 `demo-core`） — 已完成幂等状态机与单测/);
  assert.match(personalMd, /\*\*技术方案审核\*\* 待审批（含未豁免阻断项）/);
  assert.match(personalMd, /\*\*2\*\* 项未豁免的 CRITICAL 阻断发现项/);

  const sprintMd = buildProjectSprintDigest({
    projects,
    tasks,
    stageBreakdown: {
      PRD: { approved: 2, pendingApproval: 0, awaitingReport: 0, changesRequested: 0 },
      TECH_SPEC: { approved: 1, pendingApproval: 1, awaitingReport: 0, changesRequested: 0 },
    },
    openBlockersCount: 2,
    reviewCount: 6,
    assetCount: 9,
    now,
  });
  assert.match(sprintMd, /# 项目迭代交付简报 · DEMO · 支付清结算 \(2026-11-15\)/);
  assert.match(sprintMd, /完成率：\*\*50%\*\*（1\/2）/);
  assert.match(sprintMd, /\| 技术方案审核 \| 1 \| 1 \| 0 \| 0 \|/);

  // Filtered single-project mode without global stageBreakdown omits global funnel table cleanly
  const singleFilteredMd = buildProjectSprintDigest({ projects, tasks, now });
  assert.equal(singleFilteredMd.includes('五阶段质量门禁漏斗'), false);

  const cmdItems = buildQuickCommandItems({
    query: '晨会 简报',
    tasks: [],
    projects,
    canStandupDigest: true,
  });
  assert.ok(cmdItems.some(item => item.actionId === 'standup-digest'));
});

test('current AI reviews keep only the latest valid AI review for each task stage', () => {
  const job = { id: 'ai-old', taskId: 't-1', stage: 'PRD', executionMode: 'LOCAL_REPORT', createdAt: '2026-11-22T06:00:00.000Z', stale: false };
  const newest = { ...job, id: 'ai-latest', createdAt: '2026-11-24T06:00:00.000Z' };
  const stale = { ...newest, id: 'stale', createdAt: '2026-11-25T06:00:00.000Z', stale: true };
  const manual = { ...newest, id: 'manual', executionMode: 'HUMAN_REVIEW' };
  const scheme = { ...job, id: 'scheme', stage: 'TECH_SPEC' };
  const anotherTask = { ...job, id: 'another-task', taskId: 't-2' };
  const obsolete = { ...newest, id: 'obsolete', stage: 'TASK_BREAKDOWN', reviewRequired: false };
  assert.deepEqual(currentAiReviews([job, newest, stale, manual, scheme, anotherTask, obsolete]), [newest, scheme, anotherTask]);
});

test('reviewQueueSla stratifies review aging heat, checks user actionability, and sorts burning/overdue queues first', () => {
  assert.equal(formatCompactDuration(30_000), '<1m');
  assert.equal(formatCompactDuration(45 * 60_000), '45m');
  assert.equal(formatCompactDuration(5.5 * 3_600_000), '5.5h');
  assert.equal(formatCompactDuration(3 * 24 * 3_600_000), '3d');

  const nowMs = Date.parse('2026-11-15T12:00:00.000Z');
  const freshJob = {
    id: 'j-fresh',
    taskId: 't-1',
    stage: 'CODE_REVIEW',
    status: 'AWAITING_REPORT',
    createdAt: '2026-11-15T10:30:00.000Z',
    stale: false,
    report: null,
    decision: null,
  };
  const overdueJob = {
    id: 'j-overdue',
    taskId: 't-1',
    stage: 'TECH_SPEC',
    status: 'REPORT_SUBMITTED',
    createdAt: '2026-11-13T08:00:00.000Z',
    stale: false,
    report: { id: 'r-1', actorId: 'u-author', createdAt: '2026-11-14T06:00:00.000Z' },
    decision: null,
  };
  const burningJob = {
    id: 'j-burning',
    taskId: 't-1',
    stage: 'PRD',
    status: 'AWAITING_REPORT',
    createdAt: '2026-11-11T06:00:00.000Z',
    stale: false,
    report: null,
    decision: null,
  };
  const doneJob = {
    id: 'j-done',
    taskId: 't-1',
    stage: 'PRD',
    status: 'APPROVED',
    createdAt: '2026-11-14T10:00:00.000Z',
    stale: false,
    report: { id: 'r-0', actorId: 'u-author', createdAt: '2026-11-14T11:00:00.000Z' },
    decision: { decision: 'APPROVE', createdAt: '2026-11-14T12:30:00.000Z' },
  };

  assert.equal(evaluateReviewSla(freshJob, nowMs).tier, 'FRESH');
  assert.equal(evaluateReviewSla(overdueJob, nowMs).tier, 'OVERDUE');
  assert.equal(evaluateReviewSla(overdueJob, nowMs).isOverdue, true);
  assert.equal(evaluateReviewSla(burningJob, nowMs).tier, 'BURNING');
  assert.equal(evaluateReviewSla(doneJob, nowMs).tier, 'DONE');
  assert.equal(evaluateReviewSla(doneJob, nowMs).label, '耗时 2.5h');

  const prioritized = sortReviewsByQueuePriority([doneJob, freshJob, overdueJob, burningJob], 'oldest_waiting', nowMs);
  assert.deepEqual(prioritized.map(j => j.id), ['j-burning', 'j-overdue', 'j-fresh', 'j-done']);

  const task = { id: 't-1', parentId: null, assigneeId: 'u-author', status: 'IN_REVIEW' };
  // Report author cannot independently approve their own report unless soloMode is enabled
  assert.equal(isReviewActionableByUser(overdueJob, task, [task], { id: 'u-author', username: 'dev', role: 'LEAD' }, 'LEAD'), false);
  assert.equal(isReviewActionableByUser(overdueJob, task, [task], { id: 'u-reviewer', username: 'lead', role: 'LEAD' }, 'LEAD'), true);
  assert.equal(isReviewActionableByUser({ ...overdueJob, soloMode: true }, task, [task], { id: 'u-author', username: 'dev', role: 'LEAD' }, 'LEAD'), true);
});

test('kanbanSwimlanes evaluates column WIP overload and groups tasks by assignee or type with deterministic ordering', () => {
  assert.deepEqual(evaluateColumnWip('OPEN', 9, 3), {
    limit: 3,
    count: 9,
    isGovernedColumn: false,
    isOverloaded: false,
    isNearLimit: false,
  });
  assert.equal(evaluateColumnWip('IN_PROGRESS', 3, 3).isNearLimit, true);
  assert.equal(evaluateColumnWip('IN_PROGRESS', 4, 3).isOverloaded, true);
  assert.equal(evaluateColumnWip('IN_REVIEW', 4, 0).isOverloaded, false);

  const members = [
    { id: 'u-me', username: 'me_dev', role: 'DEV' },
    { id: 'u-busy', username: 'busy_dev', role: 'DEV' },
    { id: 'u-idle', username: 'idle_dev', role: 'DEV' },
  ];
  const tasks = [
    { id: '1', type: 'BUG', status: 'OPEN', assigneeId: null },
    { id: '2', type: 'TASK', status: 'IN_PROGRESS', assigneeId: 'u-busy' },
    { id: '3', type: 'STORY', status: 'IN_REVIEW', assigneeId: 'u-busy' },
    { id: '4', type: 'TASK', status: 'DONE', assigneeId: 'u-idle' },
    { id: '5', type: 'TASK', status: 'IN_PROGRESS', assigneeId: 'u-me' },
  ];

  const byAssignee = buildKanbanSwimlanes(tasks, members, 'u-me', 'assignee');
  assert.deepEqual(byAssignee.map(l => l.key), ['user:u-me', 'user:u-busy', 'user:u-idle', 'unassigned']);
  assert.equal(byAssignee[1].activeWip, 2);
  assert.equal(byAssignee[2].doneCount, 1);

  const byType = buildKanbanSwimlanes(tasks, members, 'u-me', 'type');
  assert.deepEqual(byType.map(l => l.key), ['type:STORY', 'type:TASK', 'type:BUG']);
});

test('localDoctorReport formats redacted diagnostic Markdown with escaped table cells', () => {
  const md = formatLocalDoctorMarkdown({
    checkedAt: '2026-11-15T15:00:00.000Z',
    durationMs: 18,
    score: 90,
    overall: 'WARN',
    checks: [
      { id: 'sqlite_storage', label: '本地数据库', status: 'PASS', summary: 'SQLite WAL | Schema v5', latencyMs: 2 },
      { id: 'device_sessions', label: 'MCP 设备会话', status: 'WARN', summary: '尚无活跃会话', remediation: '点击一键授权 | 签发令牌' },
    ],
  });
  assert.match(md, /总体评分：\*\*90 \/ 100\*\*/);
  assert.match(md, /不包含任何会话令牌、Cookie、密钥或外部账号凭据/);
  assert.match(md, /SQLite WAL \\\| Schema v5/);
  assert.match(md, /点击一键授权 \\\| 签发令牌/);
});

test('gitHandoffKit generates conventional branches, shell-safe worktree commands, and structured PR descriptions', () => {
  assert.equal(shellSingleQuote("feat: user's order\nrm -rf /"), "'feat: user'\\''s orderrm -rf /'");
  assert.equal(inferBranchPrefix({ type: 'STORY', title: '线上紧急修复退款重复回调' }), 'hotfix');
  assert.equal(inferBranchPrefix({ type: 'BUG', title: '金额精度丢失' }), 'bugfix');
  assert.equal(inferBranchPrefix({ type: 'RELEASE', title: '2026.11 发版' }), 'release');
  assert.equal(slugifyAsciiBranchSegment('Add OAuth2 PKCE & Token Refresh Flow!!', 24), 'add-oauth2-pkce-token');

  const task = {
    id: 't-git',
    jiraKey: 'DEMO-799',
    title: 'DEMO-799 Support Idempotent Refund Webhook',
    projectId: 'p-1',
    parentId: null,
    type: 'STORY',
    assigneeId: 'u-1',
    ownerId: 'u-1',
    status: 'IN_PROGRESS',
    version: 2,
    progress: 80,
    lastSummary: '已完成 Webhook 幂等校验与重试退避',
    updatedAt: '2026-11-16T00:00:00.000Z',
    externalRef: { provider: 'jira', key: 'DEMO-799', title: 'Webhook', description: '', status: 'In Progress', url: 'https://jira.example.com/browse/DEMO-799', version: '1' },
  };
  assert.equal(buildConventionalBranchName(task), 'feature/DEMO-799-support-idempotent-refund-webhook');
  assert.equal(buildConventionalCommitMessage(task), 'feat(demo): DEMO-799 Support Idempotent Refund Webhook [DEMO-799]');

  const wt = buildGitWorktreeCommands({
    task,
    repoPath: '/Users/dev/repos/demo-core/',
    baseBranch: '../unsafe',
  });
  assert.equal(wt.worktreeDir, '/Users/dev/repos/demo-core-wt-demo-799');
  assert.match(wt.worktreeCommand, /git worktree add -b 'feature\/DEMO-799-support-idempotent-refund-webhook' '\/Users\/dev\/repos\/demo-core-wt-demo-799' 'main'/);
  assert.match(wt.cleanupWorktreeCommand, /git worktree remove '\/Users\/dev\/repos\/demo-core-wt-demo-799'/);

  const prMd = buildPullRequestDescription({
    task,
    assets: [
      {
        id: 'a-code',
        taskId: 't-git',
        projectId: 'p-1',
        kind: 'CODE',
        logicalKey: 'CODE',
        title: 'Refund webhook diff',
        content: 'diff --git a/src/refund.ts b/src/refund.ts\n--- a/src/refund.ts\n+++ b/src/refund.ts\n@@ -1,2 +1,4 @@\n+await redis.setNx(idempotencyKey, 1);\n+ALTER TABLE refund_ledger ADD COLUMN trace_id VARCHAR(64);',
        sourceUrl: null,
        revision: 2,
        sha256: '1234567890abcdef',
        actorId: 'u-1',
        createdAt: '2026-11-16T00:00:00.000Z',
      },
    ],
    gates: {
      overall: 'BLOCKED',
      gates: [
        { stage: 'PRD', status: 'PASS' },
        { stage: 'CODE_REVIEW', status: 'PENDING', reason: '待独立审批' },
      ],
    },
  });
  assert.match(prMd, /\[DEMO-799\]\(https:\/\/jira\.example\.com\/browse\/DEMO-799\)/);
  assert.match(prMd, /涉及 \*\*1\*\* 个文件，新增 \*\*\+2\*\* 行/);
  assert.match(prMd, /涉及库表 Schema \/ SQL 变更/);
  assert.match(prMd, /- \[x\] \*\*需求评审\*\*：已通过/);
  assert.match(prMd, /- \[ \] \*\*代码审核\*\*：待发起评审（待独立审批）/);
});

test('specToTestSuite extracts requirement bullets and synthesizes checklist & BDD Gherkin suites compatible with releaseReadiness', () => {
  const assets = [
    {
      id: 'a-prd',
      taskId: 't-1',
      projectId: 'p-1',
      kind: 'PRD',
      logicalKey: 'PRD',
      title: '清结算需求说明',
      content: [
        '# 背景与历史',
        '- 旧系统人工对账耗时长（应在跳过章节被忽略）',
        '# 核心验收标准',
        '- 支持按商户号与账期分页查询清结算单',
        '- 单笔退款金额不得超过原交易可退余额',
        '# 非目标 (Out of Scope)',
        '- 本期不支持跨境多币种换汇',
      ].join('\n'),
      sourceUrl: null,
      revision: 1,
      sha256: 'aaaa1111bbbb2222',
      actorId: 'u-1',
      createdAt: '2026-11-16T00:00:00.000Z',
    },
    {
      id: 'a-spec',
      taskId: 't-1',
      projectId: 'p-1',
      kind: 'TECH_SPEC',
      logicalKey: 'TECH_SPEC',
      title: '清结算技术方案',
      content: '# 并发控制\n- 使用分布式锁与幂等键防止重复扣减可退金额 (`SELECT ... FOR UPDATE`)',
      sourceUrl: null,
      revision: 2,
      sha256: 'cccc3333dddd4444',
      actorId: 'u-1',
      createdAt: '2026-11-16T00:00:00.000Z',
    },
  ];

  const extracted = extractSpecRequirementPoints(assets, '商户退款任务');
  assert.equal(extracted.points.length, 3);
  assert.equal(extracted.points.some(p => p.includes('旧系统人工对账')), false);
  assert.equal(extracted.points.some(p => p.includes('跨境多币种')), false);
  assert.ok(extracted.riskCategories.includes('CONCURRENCY_LOCK'));

  const task = { jiraKey: 'DEMO-808', title: '清结算单查询与幂等退款', type: 'STORY' };
  const checklist = synthesizeTestSuiteFromSpecs({ task, assets, format: 'checklist' });
  assert.ok(checklist.scenarioCount >= 6);
  assert.ok(countStructuredTestItems(checklist.content) >= 6);
  assert.match(checklist.content, /并发重复提交相同幂等键/);

  const gherkin = synthesizeTestSuiteFromSpecs({ task, assets, format: 'gherkin' });
  assert.match(gherkin.content, /# language: zh-CN/);
  assert.match(gherkin.content, /功能: DEMO-808 清结算单查询与幂等退款/);
  assert.match(gherkin.content, /场景: \[正向-1\] 支持按商户号与账期分页查询清结算单/);
});

test('sarifExport exports OASIS SARIF 2.1.0 logs and parses external SARIF findings with suppression filtering', () => {
  assert.deepEqual(parseFindingLocation('src/pay/settle.ts:48:9'), {
    uri: 'src/pay/settle.ts',
    startLine: 48,
    startColumn: 9,
  });
  assert.deepEqual(parseFindingLocation('file:///app/service.ts#L12-L20'), {
    uri: 'app/service.ts',
    startLine: 12,
    endLine: 20,
  });
  assert.equal(parseFindingLocation('../../etc/passwd:1'), null);

  const sarifLog = buildSarifLogFromReview({
    task: { id: 't-1', jiraKey: 'DEMO-900', title: '账务核对' },
    job: {
      id: 'j-900',
      stage: 'CODE_REVIEW',
      inputHash: 'hash-abc',
      report: { id: 'r-1', summary: '静态与 AI 联合审查完成', source: 'LOCAL_TOOL', tool: 'codex-cli', evidence: 'npm test pass', actorId: 'u-1', createdAt: '2026-11-16T00:00:00.000Z' },
      findings: [
        { id: 'f-1', severity: 'CRITICAL', title: 'SQL 拼接注入风险', detail: '应改用参数化预编译查询', location: 'src/dao/ledger.ts:88', waiver: null },
        { id: 'f-2', severity: 'CRITICAL', title: '历史遗留兼容字段', detail: '双写过渡期保留', location: 'src/dao/ledger.ts:12', waiver: { id: 'w-1', reason: '灰度期豁免', actorId: 'u-lead', createdAt: '2026-11-16T00:05:00.000Z' } },
        { id: 'f-3', severity: 'WARN', title: '缺少慢查询超时配置', detail: '建议补充 statement_timeout', location: null, waiver: null },
      ],
    },
  });
  assert.equal(sarifLog.version, '2.1.0');
  assert.equal(sarifLog.runs[0].results.length, 3);
  assert.equal(sarifLog.runs[0].results[0].level, 'error');
  assert.equal(sarifLog.runs[0].results[0].locations[0].physicalLocation.region.startLine, 88);
  assert.equal(sarifLog.runs[0].results[1].suppressions[0].justification, '灰度期豁免');

  // Re-importing skips suppressed findings and maps levels accurately
  const reimported = parseSarifFindingsToDraft(JSON.stringify(sarifLog));
  assert.equal(reimported.findings.length, 2);
  assert.equal(reimported.findings[0].severity, 'CRITICAL');
  assert.equal(reimported.findings[0].location, 'src/dao/ledger.ts:88');
  assert.equal(reimported.findings[1].severity, 'WARN');
  assert.match(reimported.evidence, /已跳过 1 项自带抑制\/豁免项/);

  assert.throws(() => parseSarifFindingsToDraft('{"version":"1.0.0","runs":[]}'), /SARIF 2\.x/);
});

test('deliveryMetrics formats hours and grades DORA lead time, review turnaround, and first-time pass rate', () => {
  assert.equal(formatFlowHours(null), '—');
  assert.equal(formatFlowHours(0.5), '30m');
  assert.equal(formatFlowHours(6.24), '6.2h');
  assert.equal(formatFlowHours(72), '3d');

  assert.equal(gradeDoraLeadTime(null).tier, 'NO_DATA');
  assert.equal(gradeDoraLeadTime(12).tier, 'ELITE');
  assert.equal(gradeDoraLeadTime(96).tier, 'HIGH');
  assert.equal(gradeDoraLeadTime(400).tier, 'MEDIUM');
  assert.equal(gradeDoraLeadTime(900).tier, 'LOW');

  assert.equal(gradeReviewTurnaround(2.5).tier, 'ELITE');
  assert.equal(gradeReviewTurnaround(18).tier, 'HIGH');
  assert.equal(gradeReviewTurnaround(48).tier, 'MEDIUM');
  assert.equal(gradeReviewTurnaround(96).tier, 'LOW');

  assert.equal(gradeFirstTimePassRate(92).tier, 'ELITE');
  assert.equal(gradeFirstTimePassRate(75).tier, 'HIGH');
  assert.equal(gradeFirstTimePassRate(60).tier, 'MEDIUM');
  assert.equal(gradeFirstTimePassRate(40).tier, 'LOW');
});

test('buildTaskTree groups children under present parents and keeps filtered orphans or cycles safe', () => {
  const mk = (id, parentId = null) => ({
    id, jiraKey: id, title: id, projectId: 'p1', parentId, type: 'TASK',
    assigneeId: null, ownerId: 'u1', status: 'OPEN', version: 1, progress: 0, lastSummary: '', updatedAt: '',
  });
  const tree = buildTaskTree([mk('P1'), mk('C1', 'P1'), mk('C2', 'P1'), mk('ORPHAN', 'MISSING'), mk('CYC-A', 'CYC-B'), mk('CYC-B', 'CYC-A')]);
  assert.deepEqual(tree.map(row => row.id), ['P1', 'ORPHAN', 'CYC-A', 'CYC-B']);
  assert.deepEqual(tree[0].subtasks?.map(row => row.id), ['C1', 'C2']);
  assert.equal(tree[1].subtasks, undefined);
  assert.equal(tree[2].subtasks, undefined);
  assert.equal(tree[3].subtasks, undefined);
});

test('material groups follow known parents within the project and retain orphaned materials', () => {
  const task = (id, parentId = null, projectId = 'p1', externalRef = null) => ({
    id, projectId, parentId, jiraKey: 'JIRA-' + id, title: '任务 ' + id, externalRef,
  });
  const material = (id, taskId, projectId = 'p1') => ({
    id, taskId, projectId, taskKey: 'JIRA-' + taskId, taskTitle: '材料任务 ' + taskId,
  });
  const tasks = [
    task('parent'), task('child', 'parent'), task('nested', 'child'),
    task('jira-child', null, 'p1', { provider: 'jira', issueType: { subtask: true }, parentKey: 'JIRA-parent' }),
    task('foreign', 'parent', 'p2'), task('loop-a', 'loop-b'), task('loop-b', 'loop-a'),
  ];
  const assets = [
    material('code', 'child'), material('orphan-doc', 'missing'), material('test-cases', 'nested'),
    material('foreign-doc', 'foreign', 'p2'), material('requirements', 'parent'),
    material('jira-doc', 'jira-child'), material('loop-doc-a', 'loop-a'), material('loop-doc-b', 'loop-b'),
  ];
  const groups = groupTaskMaterials(assets, tasks);
  assert.deepEqual(groups.map(group => group.taskId), ['parent', 'missing', 'foreign', 'loop-a', 'loop-b']);
  assert.equal(groups[0].taskTitle, '任务 parent');
  assert.equal(groups[1].taskTitle, '材料任务 missing');
  assert.deepEqual(groups.map(group => group.assets.map(asset => asset.id)), [
    ['code', 'test-cases', 'requirements', 'jira-doc'],
    ['orphan-doc'], ['foreign-doc'], ['loop-doc-a'], ['loop-doc-b'],
  ]);
});

test('material groups combine explicitly linked requirements and development tasks without transferring ownership', () => {
  const task = (key, description = '', server = 'jira.example.test', parentId = null) => ({
    id: key, jiraKey: key, title: key, projectId: 'project', parentId,
    externalRef: { provider: 'jira', description, url: `https://${server}/browse/${key}` },
  });
  const source = key => `*需求来源*\n产品需求 [${key}|https://jira.example.test/browse/${key}]\n*交付物*\nDEMO-20`;
  const tasks = [
    task('DEMO-1'), task('DEMO-2', source('DEMO-1')), task('DEMO-3', '', 'jira.example.test', 'DEMO-2'),
    task('DEMO-4', source('DEMO-1'), 'other.example.test'), task('DEMO-5', source('DEMO-99')),
    task('DEMO-6', '*需求来源*\nDEMO-1、DEMO-2'),
  ];
  const assets = tasks.map(item => ({ taskId: item.id, projectId: item.projectId, taskKey: item.jiraKey, taskTitle: item.title }));
  const groups = groupTaskMaterials(assets, tasks);
  assert.deepEqual(groups.map(group => group.taskId), ['DEMO-1', 'DEMO-4', 'DEMO-5', 'DEMO-6']);
  assert.deepEqual(groups[0].assets.map(asset => asset.taskId), ['DEMO-1', 'DEMO-2', 'DEMO-3']);
  assert.equal(groups[0].rootTaskIds.get('DEMO-3'), 'DEMO-2');
});

test('automation, IM channel, webhook, audit log, and declarative policy labels work consistently', () => {
  assert.equal(reviewStatusLabel('AWAITING_CLOUD_AI'), '待云端 AI 执行');
  assert.equal(executionModeLabel('CLOUD_AI'), '云端 AI（未启用）');
  assert.equal(executionModeLabel('CLOUD_AI', false), '云端 AI（未启用）');
  assert.equal(executionModeLabel('CLOUD_AI', true), '云端 AI 自动评审');
  assert.equal(reportSourceLabel('CLOUD_AI'), '云端 AI');

  assert.equal(imChannelLabel('feishu'), '飞书机器人');
  assert.equal(imChannelLabel('dingtalk'), '钉钉机器人');
  assert.equal(imChannelLabel('wecom'), '企业微信机器人');
  assert.equal(imChannelLabel('generic'), '通用 Webhook');

  assert.equal(webhookProviderLabel('gitlab'), 'GitLab Webhook');
  assert.equal(webhookProviderLabel('confluence'), 'Confluence Webhook');
  assert.equal(webhookProviderLabel('generic'), '通用文档 / 流水线 Webhook');

  assert.equal(pluginStatusLabel('EXECUTABLE_DECLARATIVE'), '可执行规则引擎');
  assert.equal(pluginStatusLabel('REGISTERED_NOT_EXECUTABLE'), '快照与 AI 注入生效');

  assert.equal(describeAuditAction('API_SPEC_IMPORT').label, '导入 OpenAPI / Apifox 接口契约');
  assert.equal(describeAuditAction('CLOUD_AI_REPORT').label, '云端 AI 提交评审报告');
  assert.equal(describeAuditAction('MR_REVIEW_WRITEBACK').label, '回写评审意见到 MR');
  assert.equal(describeAuditAction('WEBHOOK_ASSET_SYNC').label, 'Webhook 自动同步材料');
  assert.equal(describeAuditAction('PLUGIN_REMOVE').label, '移出项目策略插件');

  assert.ok(POLICY_PLUGIN_PRESETS.length >= 3);
  for (const preset of POLICY_PLUGIN_PRESETS) {
    assert.ok(typeof preset.evaluator === 'string' && preset.evaluator.length > 0);
  }
});

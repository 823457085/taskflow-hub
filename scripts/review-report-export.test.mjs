import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanEvidenceForHumans,
  formatReviewReportHtml,
  formatReviewReportMarkdown,
  formatReviewReportPlainText,
  humanizeReviewText,
  reviewExportFilename,
} from '../preview-app/src/views/reviewReportExport.ts';

const SAMPLE_INPUT = {
  task: {
    jiraKey: 'VMS-748',
    title: '【APP】开发 Adyen商家账户拆分',
    url: 'https://jira.example.com/browse/VMS-748',
  },
  stage: 'CODE_REVIEW',
  isDraft: true,
  stale: false,
  report: {
    summary: 'Adyen 提现修复可继续在测试环境验证，未发现符合 CRITICAL 定义的问题，但正式发布前需处理 2 项 WARN。',
    evidence: 'CODE_REVIEW Job 6e054dbf-b878-412e-ac33-443cc1258a06，冻结输入哈希 29308a68e6e17e44c9ccba8e2804416fa986aee1b2eb32fba875b592f507e1a7。指定资产 f9dd6b03-8c17-49d9-bc3a-bee4d7a2f4b2 为 Codeup MR #647 rev2，内容 SHA-256 实算为 cc376743fb64f4f407f737bbb9478d83d38b29acae153ba708598a651d145871。差异与 f1e961482ae2b69faf97bf9cd9b99833d4e58d08 匹配，54/54 项定向测试通过。',
    verdict: 'CONDITIONAL',
    score: 78,
    tool: 'codex-cli',
    createdAt: '2026-11-25T02:54:52.228Z',
    checklist: [
      { item: '边界追踪', result: 'WARN', note: '退出登录后丢失原申请号', ref: 'withdrawal.vue:497' },
      { item: '代码规范', result: 'PASS', note: '静态检查通过', ref: 'npm run check:ci' },
      { item: '资金安全门禁', result: 'FAIL', note: '缺少跨登录去重断言', ref: 'meta.compliance' },
    ],
    meta: {
      riskLevel: 'high',
      clarifyQuestions: [
        { id: 'Q-001', question: '账户变更后原申请何时算终止？', impact: '决定页面何时允许重新提现。', owner: 'DEV', resolved: false },
      ],
      compliance: {
        compliant: ['选定账户路由已区分 HAHA 与 Adyen。'],
        missing: ['跨退出登录恢复原申请的回归断言。'],
        manualCheck: ['在测试环境实测重复提现去重。'],
      },
      walkthrough: [
        { file: 'src/pages/withdrawal.vue', summary: '核对收款账户并刷新额度。', risk: 'high' },
      ],
    },
  },
  findings: [
    {
      severity: 'INFO',
      title: '状态文案优先级变化',
      detail: '问题：本地文案覆盖了接口返回文案。\n影响：部分状态展示不一致。\n建议：优先读取接口翻译编码。',
      location: 'src/utils/financial-account.js:19',
      category: 'CONTRACT',
    },
    {
      severity: 'CRITICAL',
      title: '历史遗留鉴权分支',
      detail: '网关层已拦截，当前分支不再直接暴露。',
      location: 'src/utils/request.js:109',
      category: 'SECURITY',
      waiver: { reason: '上游网关已兜底' },
    },
    {
      severity: 'WARN',
      title: '退出登录后丢失原申请号',
      detail: '问题：退出登录清理缓存时删掉了本地请求号。\n影响：重新登录后可能重复发起提现。\n建议：改为由服务端返回未决申请记录并补回归测试。',
      location: 'src/pages/adyen-payout-recovery.js:28；src/pages/withdrawal.vue:497',
      category: 'CORRECTNESS',
      suggestedPatch: { before: 'clearAllStorage()', after: 'clearSessionOnly()' },
    },
  ],
};

test('humanizeReviewText and cleanEvidenceForHumans remove internal jargon and hash noise without mangling identifiers', () => {
  assert.equal(
    humanizeReviewText('未发现符合 CRITICAL 定义的问题，存在 2 项 WARN 与 1 项 INFO。保留 RULE-CRITICAL-1。'),
    '未发现 P0 阻断问题，存在 2 项 P1 需跟进 与 1 项 P2 改进建议。保留 RULE-CRITICAL-1。',
  );
  const cleaned = cleanEvidenceForHumans(SAMPLE_INPUT.report.evidence);
  assert.ok(cleaned.includes('Codeup MR #647 rev2'));
  assert.ok(cleaned.includes('54/54 项定向测试通过'));
  assert.ok(cleaned.includes('f1e96148'), 'keeps short 8-char commit id');
  assert.equal(cleaned.includes('6e054dbf-b878-412e-ac33-443cc1258a06'), false, 'strips raw Job UUID');
  assert.equal(cleaned.includes('29308a68e6e17e44c9ccba8e2804416fa986aee1b2eb32fba875b592f507e1a7'), false, 'strips raw SHA-256');
});

test('formatReviewReportPlainText produces plain Chinese report grouped by priority without markdown markup', () => {
  const text = formatReviewReportPlainText(SAMPLE_INPUT);

  assert.ok(text.includes('【代码审核报告】VMS-748 【APP】开发 Adyen商家账户拆分'));
  assert.ok(text.includes('报告状态：AI 评审草稿（尚未正式提交）'));
  assert.ok(text.includes('评审结论：有条件通过（主流程基本可用，处理完待跟进项后再放行）'));
  assert.ok(text.includes('综合评分：78 / 100 分 ｜ 风险等级：高风险'));
  assert.ok(text.includes('必须先改（P0）1 项（其中 1 项已豁免）'));
  assert.ok(text.includes('【接下来建议怎么处理】'));

  // Priority grouping order: P0 -> P1 -> P2
  const p0Idx = text.indexOf('■ 必须先改（P0 阻断问题 · 1 项）');
  const p1Idx = text.indexOf('■ 建议尽快处理（P1 需跟进 · 1 项）');
  const p2Idx = text.indexOf('■ 可顺手优化（P2 改进建议 · 1 项）');
  assert.ok(p0Idx > 0 && p1Idx > p0Idx && p2Idx > p1Idx, 'findings ordered P0 -> P1 -> P2');

  // Structured plain detail fields
  assert.ok(text.includes('· 哪里有问题：退出登录清理缓存时删掉了本地请求号。'));
  assert.ok(text.includes('· 会影响什么：重新登录后可能重复发起提现。'));
  assert.ok(text.includes('· 建议怎么改：改为由服务端返回未决申请记录并补回归测试。'));
  assert.ok(text.includes('已豁免：上游网关已兜底'));
  assert.ok(text.includes('[待确认 · 研发工程师] 账户变更后原申请何时算终止？'));
  assert.ok(text.includes('【逐项检查清单（共 3 项：1 项不满足、1 项待完善、1 项满足）】'));

  // Checklist sorts FAIL before WARN before PASS
  const failIdx = text.indexOf('[不满足] 资金安全门禁');
  const warnIdx = text.indexOf('[待完善] 边界追踪');
  const passIdx = text.indexOf('[满足] 代码规范');
  assert.ok(failIdx > 0 && warnIdx > failIdx && passIdx > warnIdx);

  // No markdown formatting noise
  assert.equal(text.includes('**'), false);
  assert.equal(text.includes('###'), false);
});

test('formatReviewReportMarkdown creates structured Markdown with tables and diff suggestions', () => {
  const md = formatReviewReportMarkdown(SAMPLE_INPUT);
  assert.ok(md.startsWith('# 代码审核报告：VMS-748 【APP】开发 Adyen商家账户拆分'));
  assert.ok(md.includes('### 建议尽快处理（P1 需跟进 · 1 项）'));
  assert.ok(md.includes('- **哪里有问题**：退出登录清理缓存时删掉了本地请求号。'));
  assert.ok(md.includes('```diff\n- clearAllStorage()\n+ clearSessionOnly()\n```'));
  assert.ok(md.includes('| 状态 | 检查项 | 说明与依据 |'));
});

test('formatReviewReportHtml escapes XSS payloads cleanly and supports both HTML and Word modes', () => {
  const dangerous = {
    ...SAMPLE_INPUT,
    task: {
      jiraKey: 'XSS-1',
      title: '<script>alert(1)</script> & "quote"',
      url: 'javascript:alert(1)',
    },
    report: {
      ...SAMPLE_INPUT.report,
      summary: '<img src=x onerror=alert(1)> 正常结论',
    },
  };

  const webHtml = formatReviewReportHtml(dangerous, { forWord: false });
  assert.equal(webHtml.includes('<script>alert(1)</script>'), false);
  assert.equal(webHtml.includes('<img src=x'), false);
  assert.equal(webHtml.includes('javascript:alert(1)'), false);
  assert.ok(webHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(webHtml.includes('window.print()'), 'web HTML includes print button');

  const wordHtml = formatReviewReportHtml(dangerous, { forWord: true });
  assert.ok(wordHtml.includes('urn:schemas-microsoft-com:office:word'));
  assert.ok(wordHtml.includes('<w:WordDocument>'));
  assert.equal(wordHtml.includes('window.print()'), false, 'Word doc omits interactive browser print button');
});

test('reviewExportFilename sanitizes unsafe filesystem characters', () => {
  assert.equal(reviewExportFilename({ jiraKey: 'VMS-748', title: '测试' }, 'CODE_REVIEW', 'doc'), 'VMS-748-代码审核报告.doc');
  assert.equal(reviewExportFilename({ jiraKey: 'OPAY/637:v1', title: '测试' }, 'TEST_CASE', 'md'), 'OPAY-637-v1-测试用例评审报告.md');
  assert.equal(reviewExportFilename({ jiraKey: '', title: '新建需求*含非法/字符?' }, 'PRD', 'html'), '新建需求-含非法-字符-需求评审报告.html');
});

import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  FileCheck2,
  FileText,
  GitBranch,
  Laptop,
  Lock,
  Play,
  Rocket,
  ShieldAlert,
  Sparkles,
  TestTube2,
  Unlock,
} from 'lucide-react';
import {
  CLOUD_AI_ROLES,
  RequirementStory,
  StageKey,
  UserProfile,
} from '../data/mockPlatformData';
import { Modal, StatusBadge } from '../components/Primitives';

const STAGE_META: {
  key: StageKey;
  step: string;
  label: string;
  aiRoleId: string;
  icon: React.ReactNode;
}[] = [
  { key: 'PRD', step: '01', label: '需求评审 (PRD)', aiRoleId: 'ai-pm', icon: <FileText className="w-4 h-4" /> },
  { key: 'TECH_SPEC', step: '02', label: '技术方案审核', aiRoleId: 'ai-architect', icon: <FileCheck2 className="w-4 h-4" /> },
  { key: 'CODE_REVIEW', step: '03', label: '跨端代码审核', aiRoleId: 'ai-reviewer', icon: <Code2 className="w-4 h-4" /> },
  { key: 'TEST_CASE', step: '04', label: '测试用例评审', aiRoleId: 'ai-qa', icon: <TestTube2 className="w-4 h-4" /> },
  { key: 'RELEASE', step: '05', label: '需求集中上线', aiRoleId: 'ai-sre', icon: <Rocket className="w-4 h-4" /> },
];

export const TaskCockpitView: React.FC<{
  story: RequirementStory;
  activeStage: StageKey;
  onChangeStage: (stage: StageKey) => void;
  currentUser: UserProfile;
  onOverrideFinding: (storyKey: string, findingId: string, reason: string, byUser: string) => void;
  onSimulateLocalFix: (storyKey: string, findingId: string) => void;
  onApproveTestCases?: (storyKey: string) => void;
  onJumpToReleaseCenter: () => void;
}> = ({
  story,
  activeStage,
  onChangeStage,
  currentUser,
  onOverrideFinding,
  onSimulateLocalFix,
  onApproveTestCases,
  onJumpToReleaseCenter,
}) => {
  const [selectedSubTaskKey, setSelectedSubTaskKey] = useState<string>(
    story.subTasks[3]?.jiraKey || story.subTasks[0]?.jiraKey || ''
  );
  const [runningCloudAi, setRunningCloudAi] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [overrideModalFindingId, setOverrideModalFindingId] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [testhubSynced, setTesthubSynced] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const reviewInProgress = useRef(false);
  const isOrderDemo = story.jiraKey === 'ORD-200';

  useEffect(() => {
    setSelectedSubTaskKey(story.subTasks[3]?.jiraKey || story.subTasks[0]?.jiraKey || '');
    setTesthubSynced(false);
    setOverrideModalFindingId(null);
    setOverrideReason('');
  }, [story.jiraKey]);

  useEffect(() => {
    setRunningCloudAi(false);
    setReviewFeedback('');
    setCopiedCmd(null);
    setCopyFeedback('');
    reviewInProgress.current = false;
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      reviewInProgress.current = false;
    };
  }, [story.jiraKey, activeStage]);

  const currentStageMeta = STAGE_META.find((m) => m.key === activeStage) || STAGE_META[2];
  const activeAiAgent = CLOUD_AI_ROLES.find((a) => a.id === currentStageMeta.aiRoleId) || CLOUD_AI_ROLES[2];

  const unresolvedCriticals = story.findings.filter(
    (f) => f.severity === 'CRITICAL' && !f.overridden && !f.fixedInLocal
  );

  // These thresholds model the prototype flow only; production gates need signed review evidence.
  const demoGatesPassed = story.prdScore >= 90 && story.techSpecScore >= 90 &&
    story.codeScore >= 90 && story.testCoveragePct === 100 && unresolvedCriticals.length === 0;

  const handleRunCloudReview = () => {
    if (!currentUser.permissions.canTriggerReview || !isOrderDemo || reviewInProgress.current) return;
    reviewInProgress.current = true;
    setRunningCloudAi(true);
    setReviewFeedback('');
    const roleName = activeAiAgent.name;
    timers.current.push(setTimeout(() => {
      reviewInProgress.current = false;
      setRunningCloudAi(false);
      setReviewFeedback(`模拟复审完成：${roleName} 已展示当前示例报告；未调用 AI，也未新增评审证据。`);
    }, 900));
  };

  const handleCopyPrompt = async (cmd: string, tag: string) => {
    setReviewFeedback('');
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(tag);
      setCopyFeedback('已复制演示指令；本地命令接入将在基础工程中实现。');
      timers.current.push(setTimeout(() => setCopiedCmd(null), 1800));
    } catch {
      setCopyFeedback('复制未完成，请从示例内容中手动复制。');
    }
  };

  const handleApproveTestCases = () => {
    if (!currentUser.permissions.canApproveTestCase || !isOrderDemo ||
      testhubSynced || story.testCoveragePct === 100) return;
    setTesthubSynced(true);
    onApproveTestCases?.(story.jiraKey);
  };

  const submitOverride = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser.permissions.canOverrideGate || !overrideModalFindingId || !overrideReason.trim()) return;
    onOverrideFinding(story.jiraKey, overrideModalFindingId, overrideReason.trim(), currentUser.userName);
    setOverrideModalFindingId(null);
    setOverrideReason('');
  };

  return (
    <div className="cc-animate-in space-y-5 max-w-[1420px] mx-auto">
      {/* Top Story Context Banner Card */}
      <div className="cc-card p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[13px] font-semibold px-2.5 py-0.5 rounded bg-[#eff6ff] text-[#1e40af]">
              {story.jiraKey}
            </span>
            <span className="text-[13px] text-[#64748b] font-mono">
              Jira Epic: {story.epicKey} · {story.sprint}
            </span>
            {unresolvedCriticals.length > 0 ? (
              <StatusBadge variant="block">代码门禁拦截 ({unresolvedCriticals.length} Blocker)</StatusBadge>
            ) : (
              <StatusBadge variant={demoGatesPassed ? "green" : "neutral"}>{demoGatesPassed ? "演示门禁就绪" : "仍有前置评审待完成"}</StatusBadge>
            )}
          </div>
          <h1 className="text-[22px] font-semibold text-[#0f172a] mt-1.5 leading-[1.35]">
            {story.title}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleRunCloudReview}
            disabled={!currentUser.permissions.canTriggerReview || !isOrderDemo || runningCloudAi}
            className="cc-btn cc-btn-primary"
          >
            <Play className={`w-4 h-4 ${runningCloudAi ? 'animate-spin' : ''}`} />
            {runningCloudAi
              ? `正在模拟 ${activeAiAgent.name}...`
              : `模拟【${activeAiAgent.name}】复审`}
          </button>
          <button
            type="button"
            onClick={onJumpToReleaseCenter}
            className="cc-btn cc-btn-secondary"
          >
            <Rocket className="w-4 h-4 text-[#1e40af]" />
            打开集中上线编排单
          </button>
        </div>
      </div>

      <p role="status" aria-live="polite" className="text-[13px] text-[#64748b]">{reviewFeedback || copyFeedback || "交互演示：评审、同步与审批仅更新本页面示例状态。"}</p>

      {/* Holy Grail 3-Column Layout: Left Jira Task Tree (290px) | Center 5-Stage Timeline Workspace | Right Cloud AI Role & Links (310px) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN (3 cols): Jira Task Tree & Local AI IDE Real-Time Sync */}
        <div className="lg:col-span-3 space-y-4">
          <div className="cc-card p-5">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#e5e7eb]">
              <div>
                <h2 className="text-[15px] font-semibold text-[#0f172a]">Jira 任务跟踪树</h2>
                <p className="text-[12px] text-[#64748b]">本地 AI 编程进度演示</p>
              </div>
              <StatusBadge variant="blue">{story.subTasks.length} 子单</StatusBadge>
            </div>

            <div className="space-y-2.5">
              {story.subTasks.map((sub) => {
                const isSelected = selectedSubTaskKey === sub.jiraKey;
                return (
                  <div
                    key={sub.jiraKey}
                    onClick={() => setSelectedSubTaskKey(sub.jiraKey)}
                    className={`rounded-[8px] p-3 border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-[#eff6ff]/70 border-[#3b82f6]'
                        : 'bg-[#ffffff] border-[#e5e7eb] hover:bg-[#f8fafc]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] font-semibold text-[#1e40af]">
                        {sub.jiraKey} · {sub.type}
                      </span>
                      <span className="text-[12px] text-[#64748b]">{sub.assignee}</span>
                    </div>
                    <div className="text-[13px] font-medium text-[#0f172a] mt-1 leading-[1.45]">
                      {sub.title}
                    </div>

                    {/* Progress bar */}
                    <div className="mt-2.5">
                      <div className="flex items-center justify-between text-[11px] text-[#64748b] mb-1">
                        <span>{sub.localIdeTool ? `${sub.localIdeTool} 同步` : sub.jiraStatus}</span>
                        <span className="font-mono font-medium text-[#0f172a]">{sub.progressPct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[#e5e7eb] rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-200"
                          style={{
                            width: `${sub.progressPct}%`,
                            backgroundColor: sub.progressPct === 100 ? '#10b981' : '#3b82f6',
                          }}
                        />
                      </div>
                    </div>

                    {sub.lastSyncText && (
                      <div className="mt-2 text-[11px] text-[#64748b] flex items-center gap-1">
                        <Laptop className="w-3 h-3 text-[#10b981] shrink-0" />
                        <span className="truncate">{sub.lastSyncText}</span>
                      </div>
                    )}

                    {isSelected && sub.checklist.length > 0 && (
                      <div className="mt-2.5 pt-2.5 border-t border-[#e5e7eb] space-y-1.5">
                        {sub.branch && (
                          <div className="text-[11px] font-mono text-[#1e40af] flex items-center gap-1">
                            <GitBranch className="w-3 h-3" />
                            {sub.branch}
                          </div>
                        )}
                        {sub.checklist.map((item, idx) => (
                          <div key={idx} className="flex items-start gap-1.5 text-[12px]">
                            <CheckCircle2
                              className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                                item.done ? 'text-[#10b981]' : 'text-[#cbd5e1]'
                              }`}
                            />
                            <span className={item.done ? 'text-[#64748b] line-through' : 'text-[#0f172a]'}>
                              {item.label}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* CENTER COLUMN (6 cols): 5-Stage Vertical Timeline & Active Stage Review Workspace */}
        <div className="lg:col-span-6 space-y-5">
          {/* Horizontal Stage Switcher + Vertical Timeline Header */}
          <div className="cc-card p-3 flex flex-wrap items-center gap-1.5">
            {STAGE_META.map((st) => {
              const active = st.key === activeStage;
              const hasBlock = st.key === 'CODE_REVIEW' && unresolvedCriticals.length > 0;
              return (
                <button
                  key={st.key}
                  type="button"
                  onClick={() => onChangeStage(st.key)}
                  className={`cc-btn !py-2 !px-3 !text-[13px] flex-1 min-w-[120px] ${
                    active ? 'cc-btn-primary' : 'cc-btn-ghost'
                  }`}
                >
                  {st.icon}
                  <span>{st.label}</span>
                  {hasBlock && !active && (
                    <span className="w-2 h-2 rounded-full bg-[#dc2626]" />
                  )}
                </button>
              );
            })}
          </div>

          {!isOrderDemo && (
            <div className="cc-card p-8 text-center space-y-2">
              <FileText className="w-7 h-7 mx-auto text-[#64748b]" />
              <h2 className="text-[18px] font-semibold">{currentStageMeta.label}</h2>
              <p className="text-[14px] text-[#64748b]">{story.jiraKey} 尚未准备此阶段的文档与评审材料。</p>
              <p className="text-[13px] text-[#64748b]">可在任务总览打开 ORD-200 体验完整演示流程。</p>
            </div>
          )}

          {/* STAGE 1: PRD REVIEW */}
          {isOrderDemo && activeStage === 'PRD' && (
            <div className="cc-card p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-4">
                <div>
                  <h2 className="text-[20px] font-semibold text-[#0f172a]">
                    阶段一：需求评审示例
                  </h2>
                  <p className="text-[14px] text-[#64748b] mt-0.5">
                    由云端【AI 产品评审官】加载 `prd-completeness-audit` 审查完备度并拆解 Jira 子任务
                  </p>
                </div>
                <StatusBadge variant={story.prdScore >= 90 ? "green" : "neutral"}>演示得分 {story.prdScore}</StatusBadge>
              </div>

              {/* Clean 16px/1.65 max-w-[70ch] Document Excerpt per Corporate Clean Typography Rule */}
              <div className="rounded-[12px] bg-[#f8fafc] border border-[#e5e7eb] p-5 max-w-[70ch]">
                <div className="text-[12px] font-medium uppercase tracking-[0.04em] text-[#64748b] mb-2">
                  示例 PRD 正文节选 (Revision v4)
                </div>
                <p className="text-[16px] leading-[1.65] text-[#0f172a]">
                  当买家单笔结算订单包含跨不同履约仓（如华东常温仓 + 华南冷链仓）的 SKU 时，系统需在支付成功后按仓库维度自动拆分为多个子订单独立发货。满减优惠券金额按各子单商品实付占比精确分摊（尾差归入金额最大子单）。
                </p>
              </div>

              <div className="space-y-2.5">
                <div className="text-[14px] font-semibold text-[#0f172a]">AI 产品评审示例记录</div>
                <div className="rounded-[8px] border border-[#e5e7eb] p-3.5 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[14px] font-medium text-[#0f172a]">
                      [已补充至 v4] 单子单发生缺货取消时，主单状态机与跨店满减追回逻辑缺失
                    </div>
                    <p className="text-[13px] text-[#64748b] mt-1">
                      示例批注位于 PRD 第 4.3 节，模拟产品经理补充“子单独立逆向退款、不回滚其他正常履约子单”规则。
                    </p>
                  </div>
                  <StatusBadge variant="green">已解决</StatusBadge>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 2: TECH SPEC REVIEW */}
          {isOrderDemo && activeStage === 'TECH_SPEC' && (
            <div className="cc-card p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-4">
                <div>
                  <h2 className="text-[20px] font-semibold text-[#0f172a]">
                    阶段二：技术方案与接口契约示例
                  </h2>
                  <p className="text-[14px] text-[#64748b] mt-0.5">
                    示例展示【AI 首席架构师】对照 PRD 和仓库结构审查方案后生成的接口契约。
                  </p>
                </div>
                <StatusBadge variant="green">示例契约 v1.2</StatusBadge>
              </div>

              <div className="rounded-[12px] bg-[#f8fafc] border border-[#e5e7eb] p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] font-semibold text-[#0f172a]">
                    示例前后端接口契约 (Golden API Contract)
                  </span>
                  <span className="font-mono text-[12px] text-[#1e40af]">POST /api/v2/orders/split-preview</span>
                </div>
                <pre className="font-mono text-[12px] leading-[1.6] text-[#0f172a] overflow-x-auto bg-[#ffffff] p-3 rounded-[8px] border border-[#e5e7eb]">
{`{
  "parentOrderNo": "string (必传, 母单号)",
  "subOrders": [
    {
      "subOrderId": "string (19位雪花ID，严禁用 JSON Number 防止前端精度丢失)",
      "warehouseCode": "string",
      "allocatedPayAmount": "string (精确到分 Decimal 字符串)"
    }
  ]
}`}
                </pre>
              </div>

              <div className="text-[13px] text-[#64748b]">
                提示：本地开发者在 Cursor / Claude Code / Codex CLI 中调用 MCP 工具 <code className="font-mono text-[#0f172a]">start_and_load_task_context(&quot;ORD-204&quot;)</code> 可加载关联契约；当前仅展示接入示例。
              </div>
            </div>
          )}

          {/* STAGE 3: CROSS-REPO CODE REVIEW */}
          {isOrderDemo && activeStage === 'CODE_REVIEW' && (
            <div className="cc-card p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] pb-4">
                <div>
                  <h2 className="text-[20px] font-semibold text-[#0f172a]">
                    阶段三：前后端及测试跨仓代码联审
                  </h2>
                  <p className="text-[14px] text-[#64748b] mt-0.5">
                    示例联审范围：<code className="font-mono text-[#0f172a]">fe-mall-web (!215)</code> + <code className="font-mono text-[#0f172a]">be-order-service (!88)</code> + <code className="font-mono text-[#0f172a]">Golden Contract</code>
                  </p>
                </div>
                {unresolvedCriticals.length > 0 ? (
                  <StatusBadge variant="block">{unresolvedCriticals.length} 项阻断拦截 Merge</StatusBadge>
                ) : (
                  <StatusBadge variant="green">跨仓代码审核通过</StatusBadge>
                )}
              </div>

              {story.findings.length === 0 ? (
                <div className="rounded-[12px] bg-[#ecfdf5] border border-[#a7f3d0] p-5 text-[14px] text-[#059669] flex items-center gap-2.5">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  所有关联前端与后端 MR 均符合 PRD、黄金接口契约与团队安全规范，允许合入！
                </div>
              ) : (
                <div className="space-y-4">
                  {story.findings.map((finding) => {
                    const isResolved = finding.overridden || finding.fixedInLocal;
                    return (
                      <div
                        key={finding.id}
                        className={`rounded-[12px] border p-5 space-y-3 ${
                          isResolved
                            ? 'bg-[#f8fafc] border-[#e5e7eb]'
                            : finding.severity === 'CRITICAL'
                            ? 'bg-[#ffffff] border-[#fca5a5]'
                            : 'bg-[#ffffff] border-[#e5e7eb]'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {finding.fixedInLocal ? (
                              <StatusBadge variant="green">模拟本地修复完成</StatusBadge>
                            ) : finding.overridden ? (
                              <StatusBadge variant="neutral">演示已由 {finding.overrideBy} 豁免</StatusBadge>
                            ) : finding.severity === 'CRITICAL' ? (
                              <StatusBadge variant="block">CRITICAL · 阻断合并</StatusBadge>
                            ) : (
                              <StatusBadge variant="warn">WARN · 上线预检提醒</StatusBadge>
                            )}
                            <span className="text-[12px] font-medium text-[#1e40af]">{finding.category}</span>
                          </div>
                          <span className="font-mono text-[12px] text-[#64748b]">
                            {finding.platform} · {finding.mrIid}
                          </span>
                        </div>

                        <h3 className="text-[16px] font-semibold text-[#0f172a] leading-[1.45]">
                          {finding.title}
                        </h3>
                        <p className="text-[14px] text-[#64748b] leading-[1.6]">{finding.detail}</p>

                        <div className="font-mono text-[12px] bg-[#f8fafc] border border-[#e5e7eb] rounded-[8px] p-3 overflow-x-auto">
                          <div className="text-[#64748b] mb-1">
                            {finding.filePath}:{finding.line}
                          </div>
                          <pre className="text-[#0f172a] whitespace-pre-wrap">{finding.diffSnippet}</pre>
                        </div>

                        {finding.overridden && (
                          <div className="text-[12px] text-[#64748b] bg-[#ffffff] border border-[#e5e7eb] rounded-[8px] p-2.5">
                            <strong>演示豁免记录：</strong> {finding.overrideReason}（审批人：{finding.overrideBy}）
                          </div>
                        )}

                        {!isResolved && (
                          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#e5e7eb]">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyPrompt(
                                    `/fix-cr ${story.jiraKey} ${finding.id} --apply-contract`,
                                    finding.id
                                  )
                                }
                                className="cc-btn cc-btn-secondary !py-1.5 !px-3 !text-[13px]"
                              >
                                <Copy className="w-3.5 h-3.5 text-[#1e40af]" />
                                {copiedCmd === finding.id
                                  ? '已复制本地 AI 修复指令！'
                                  : '复制本地 Cursor / Claude Code 修复指令'}
                              </button>

                              <button
                                type="button"
                                onClick={() => onSimulateLocalFix(story.jiraKey, finding.id)}
                                className="cc-btn cc-btn-primary !py-1.5 !px-3 !text-[13px]"
                              >
                                <Laptop className="w-3.5 h-3.5" />
                                模拟本地 IDE 修复与同步
                              </button>
                            </div>

                            {/* Strict RBAC Control Demonstration */}
                            {finding.severity === 'CRITICAL' && (
                              <div>
                                {currentUser.permissions.canOverrideGate ? (
                                  <button
                                    type="button"
                                    onClick={() => setOverrideModalFindingId(finding.id)}
                                    className="cc-btn cc-btn-secondary !py-1.5 !px-3 !text-[13px]"
                                  >
                                    <Unlock className="w-3.5 h-3.5 text-[#1e40af]" />
                                    Tech Lead 审批豁免
                                  </button>
                                ) : (
                                  <span
                                    className="inline-flex items-center gap-1 text-[12px] text-[#64748b]"
                                    title="请在右上角切换为【架构师 / Tech Lead】角色体验豁免审批权限"
                                  >
                                    <Lock className="w-3.5 h-3.5" />
                                    当前角色({currentUser.roleLabel})无权豁免阻断
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* STAGE 4: TEST CASE REVIEW */}
          {isOrderDemo && activeStage === 'TEST_CASE' && (
            <div className="cc-card p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] pb-4">
                <div>
                  <h2 className="text-[20px] font-semibold text-[#0f172a]">
                    阶段四：测试用例评审 (PRD 黑盒 + 代码白盒分支双维核查)
                  </h2>
                  <p className="text-[14px] text-[#64748b] mt-0.5">
                    示例展示【AI 测试架构师】基于 28 条存量用例与代码分支提出的补充建议。
                  </p>
                </div>
                <StatusBadge variant={story.testCoveragePct === 100 ? "green" : "neutral"}>示例覆盖率 {story.testCoveragePct}%</StatusBadge>
              </div>

              <div className="space-y-3">
                <div className="text-[14px] font-semibold text-[#0f172a]">
                  代码分支补充用例建议示例
                </div>
                <div className="rounded-[12px] border border-[#e5e7eb] divide-y divide-[#e5e7eb]">
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[14px] font-medium text-[#0f172a]">
                        [边界逆向用例] 拆单仓库数超过 `max-warehouse-count=5` 阈值时的降级合单与提示校验
                      </div>
                      <p className="text-[13px] text-[#64748b] mt-1">
                        来源：后端代码 `OrderSplitEngine.java:118` 新增了最大拆仓数保护分支，原黑盒用例库未覆盖 `&gt;5` 仓场景。
                      </p>
                    </div>
                    <StatusBadge variant={testhubSynced ? 'green' : 'blue'}>
                      {testhubSynced || story.testCoveragePct === 100 ? '演示已采纳' : 'AI 示例建议'}
                    </StatusBadge>
                  </div>
                  <div className="p-4 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[14px] font-medium text-[#0f172a]">
                        [并发幂等用例] 同一母单 100ms 内重复收到支付成功 MQ 消息时的分布式锁防重拆单验证
                      </div>
                      <p className="text-[13px] text-[#64748b] mt-1">
                        来源：后端 `SplitLockInterceptor.java:54` Redis 锁超时分支白盒推导。
                      </p>
                    </div>
                    <StatusBadge variant={testhubSynced ? 'green' : 'blue'}>
                      {testhubSynced || story.testCoveragePct === 100 ? '演示已采纳' : 'AI 示例建议'}
                    </StatusBadge>
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    disabled={!currentUser.permissions.canApproveTestCase || testhubSynced || story.testCoveragePct === 100}
                    onClick={handleApproveTestCases}
                    className="cc-btn cc-btn-primary"
                  >
                    <Sparkles className="w-4 h-4" />
                    {!currentUser.permissions.canApproveTestCase ? '当前角色无用例审批权限' : testhubSynced || story.testCoveragePct === 100 ? '演示用例已采纳 · 覆盖率 100%' : '模拟采纳补充用例'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STAGE 5: RELEASE SHORTCUT */}
          {isOrderDemo && activeStage === 'RELEASE' && (
            <div className="cc-card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-4">
                <div>
                  <h2 className="text-[20px] font-semibold text-[#0f172a]">
                    阶段五：单需求生产上线集中管控
                  </h2>
                  <p className="text-[14px] text-[#64748b] mt-0.5">
                    已自动盘点该需求关联的 2 个代码仓库 MR、Flyway SQL 脚本、Nacos 配置项与 Jenkins/云效流水线
                  </p>
                </div>
                {unresolvedCriticals.length > 0 ? (
                  <StatusBadge variant="block">前置代码门禁未放行</StatusBadge>
                ) : (
                  <StatusBadge variant="green">RBOM 核验就绪</StatusBadge>
                )}
              </div>

              {unresolvedCriticals.length > 0 && (
                <div className="rounded-[8px] bg-[#fef2f2] border border-[#fecaca] p-4 text-[13px] text-[#dc2626] flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  当前 ORD-204 仍存在 {unresolvedCriticals.length} 个未解决的 CRITICAL 跨仓契约问题，请先在阶段三修复或由 Tech Lead 审批豁免后再执行生产发布。
                </div>
              )}

              <button
                type="button"
                onClick={onJumpToReleaseCenter}
                className="cc-btn cc-btn-primary"
              >
                <Rocket className="w-4 h-4" />
                进入【需求集中上线编排中心】执行 DAG 发布
              </button>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN (3 cols): Cloud AI Role Card & External DevOps Links */}
        <div className="lg:col-span-3 space-y-4">
          {/* Corporate Clean Feature Card for Active Cloud AI Digital Employee */}
          <div className="cc-card cc-card-hover p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="cc-feature-icon">
                <Bot className="w-5 h-5" />
              </div>
              <StatusBadge variant="blue">AI 角色演示</StatusBadge>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[18px] font-semibold text-[#0f172a]">{activeAiAgent.name}</h3>
                <span className="font-mono text-[12px] text-[#1e40af]">{activeAiAgent.handle}</span>
              </div>
              <p className="text-[13px] text-[#64748b] mt-1.5 leading-[1.55]">
                {activeAiAgent.description}
              </p>
            </div>

            <div className="pt-3 border-t border-[#e5e7eb] space-y-2 text-[12px]">
              <div>
                <span className="text-[#64748b]">算力路由策略：</span>
                <div className="font-medium text-[#0f172a] mt-0.5">{activeAiAgent.accountStrategy}</div>
              </div>
              <div>
                <span className="text-[#64748b]">沙箱隔离模式：</span>
                <div className="font-mono text-[#0f172a] mt-0.5">{activeAiAgent.sandboxMode}</div>
              </div>
            </div>

            <div className="pt-3 border-t border-[#e5e7eb]">
              <div className="text-[12px] font-medium text-[#64748b] mb-2">本阶段配置的 Skills</div>
              <div className="flex flex-wrap gap-1.5">
                {activeAiAgent.skills.map((sk) => (
                  <span
                    key={sk.id}
                    className="font-mono text-[11px] px-2 py-1 rounded bg-[#f8fafc] border border-[#e5e7eb] text-[#0f172a]"
                  >
                    {sk.id}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Connected External Platforms Card */}
          <div className="cc-card p-5 space-y-3">
            <h3 className="text-[15px] font-semibold text-[#0f172a]">跨平台双向关联资产</h3>
            <div className="space-y-2 text-[13px]">
              {(isOrderDemo ? [
                { platform: 'Jira 任务', detail: story.jiraKey, status: '演示关联' },
                { platform: 'Confluence PRD', detail: 'Revision v4 (94分)', status: '示例批注' },
                { platform: 'Confluence 技术方案', detail: 'Golden Contract v1.2', status: '示例契约' },
                { platform: 'GitLab / 云效 MR', detail: 'FE !215 · BE !88', status: '演示联审' },
                { platform: '云效 Testhub', detail: '28 + 2 条测试用例', status: '演示关联' },
                { platform: 'Jenkins / 云效 Flow', detail: 'build #409 示例', status: '演示就绪' },
              ] : [{ platform: 'Jira 任务', detail: story.jiraKey, status: '演示关联' }]).map((item) => (
                <div
                  key={item.platform}
                  className="flex items-center justify-between py-1.5 border-b border-[#e5e7eb] last:border-b-0"
                >
                  <div>
                    <div className="font-medium text-[#0f172a] flex items-center gap-1">
                      {item.platform}
                      <ExternalLink className="w-3 h-3 text-[#64748b]" />
                    </div>
                    <div className="text-[12px] text-[#64748b] font-mono">{item.detail}</div>
                  </div>
                  <span className="text-[12px] font-medium text-[#1e40af]">{item.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tech Lead Gate Override Modal */}
      <Modal
        open={Boolean(overrideModalFindingId)}
        title="模拟 Tech Lead 门禁豁免"
        subtitle="仅在当前演示中记录原因和审批人，不会修改外部系统门禁。"
        onClose={() => setOverrideModalFindingId(null)}
      >
        <form onSubmit={submitOverride} className="space-y-4">
          <div>
            <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
              豁免原因与风险评估说明 <span className="text-[#dc2626]">*</span>
            </label>
            <textarea
              rows={3}
              className="cc-input"
              placeholder="例如：网关层 Jackson 全局 ObjectMapper 已统一配置 LongToStringSerializer，此处不会出现精度丢失。"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              required
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setOverrideModalFindingId(null)}
              className="cc-btn cc-btn-secondary"
            >
              取消
            </button>
            <button type="submit" disabled={!currentUser.permissions.canOverrideGate} className="cc-btn cc-btn-primary">
              确认模拟豁免
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

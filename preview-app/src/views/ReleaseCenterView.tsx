import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Database, FileCog, GitMerge, Lock, Play, RotateCcw, ShieldCheck, Terminal } from 'lucide-react';
import { RequirementStory, UserProfile } from '../data/mockPlatformData';
import { StatusBadge } from '../components/Primitives';

interface ReleaseStep {
  order: number;
  title: string;
  platform: string;
  target: string;
  detail: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ROLLED_BACK';
}

const DEMO_STEPS: ReleaseStep[] = [
  { order: 1, title: '数据库兼容性变更', platform: 'DBA 插件', target: 'V20261112__add_split_order.sql', detail: '演示核对新增表与索引、备份和回退计划。', status: 'PENDING' },
  { order: 2, title: '灰度配置准备', platform: '配置中心插件', target: 'order.split.max-warehouse-count=5', detail: '演示核对阈值与灰度开关配置。', status: 'PENDING' },
  { order: 3, title: '后端服务发布', platform: 'Jenkins', target: 'be-order-service · MR !88', detail: '演示等待数据库和配置完成后执行后端发布。', status: 'PENDING' },
  { order: 4, title: '前端资源发布', platform: '云效 Flow', target: 'fe-mall-web · MR !215', detail: '演示等待后端检查通过后发布前端资源。', status: 'PENDING' },
  { order: 5, title: '冒烟验证与任务状态更新', platform: 'Testhub / Jira', target: 'ORD-200 与关联子任务', detail: '仅模拟冒烟结果与本页任务状态，不发送通知或更新 Jira。', status: 'PENDING' },
];

export const ReleaseCenterView: React.FC<{
  story: RequirementStory;
  currentUser: UserProfile;
  onMarkStoryReleased: (jiraKey: string) => void;
}> = ({ story, currentUser, onMarkStoryReleased }) => {
  const isOrderDemo = story.jiraKey === 'ORD-200';
  const [steps, setSteps] = useState<ReleaseStep[]>([]);
  const [releasing, setReleasing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const runId = useRef(0);
  const runningRef = useRef(false);

  const cancelTimers = () => {
    runId.current += 1;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    runningRef.current = false;
  };

  useEffect(() => {
    cancelTimers();
    setReleasing(false);
    setCompleted(false);
    setSteps(story.jiraKey === 'ORD-200' ? DEMO_STEPS.map((step) => ({ ...step })) : []);
    setLogs(story.jiraKey === 'ORD-200'
      ? ['[演示] 已准备 ORD-200 的发布物料与 5 步顺序。', '[待操作] 完成前置演示门禁后，由发布官 / SRE 启动演示。']
      : ['[待准备] 当前任务尚无发布物料与编排方案。']);
    return cancelTimers;
  }, [story.jiraKey]);

  const unresolvedCriticals = story.findings.filter(
    (finding) => finding.severity === 'CRITICAL' && !finding.overridden && !finding.fixedInLocal
  ).length;
  // Prototype thresholds demonstrate the flow. Production gates require approved, versioned evidence.
  const gateChecks = [
    { label: '需求评审', passed: story.prdScore >= 90 },
    { label: '技术方案', passed: story.techSpecScore >= 90 },
    { label: '代码审核', passed: story.codeScore >= 90 && unresolvedCriticals === 0 },
    { label: '用例评审', passed: story.testCoveragePct === 100 },
  ];
  const gatesPassed = gateChecks.every((gate) => gate.passed);
  const alreadyReleased = completed || story.jiraStatus.includes('已上线') || story.jiraStatus.includes('Released');
  const canStart = currentUser.permissions.canExecuteRelease && isOrderDemo && gatesPassed && !releasing && !alreadyReleased;
  const canRollback = currentUser.permissions.canExecuteRelease && releasing;

  const handleExecuteRelease = () => {
    if (!canStart || runningRef.current) return;
    cancelTimers();
    runningRef.current = true;
    const thisRun = runId.current;
    setReleasing(true);
    setSteps(DEMO_STEPS.map((step) => ({ ...step })));
    setLogs((previous) => [...previous, `[开始演示] ${currentUser.userName} 启动 ${story.jiraKey} 发布演示。`]);

    DEMO_STEPS.forEach((step, index) => {
      timers.current.push(setTimeout(() => {
        if (runId.current !== thisRun) return;
        setSteps((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'RUNNING' } : item));
        setLogs((previous) => [...previous, `[步骤 ${step.order}] 模拟调度 ${step.platform} → ${step.target}`]);
      }, index * 800));
      timers.current.push(setTimeout(() => {
        if (runId.current !== thisRun) return;
        setSteps((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'SUCCESS' } : item));
        setLogs((previous) => [...previous, `[步骤 ${step.order} 演示完成] ${step.title}`]);
        if (index === DEMO_STEPS.length - 1) {
          cancelTimers();
          setReleasing(false);
          setCompleted(true);
          setLogs((previous) => [...previous, `[演示完成] ${story.jiraKey} 的本页状态已更新，未执行真实发布。`]);
          onMarkStoryReleased(story.jiraKey);
        }
      }, index * 800 + 600));
    });
  };

  const handleRollback = () => {
    if (!canRollback || !runningRef.current) return;
    cancelTimers();
    setReleasing(false);
    setSteps((current) => current.map((step) => ({ ...step, status: 'ROLLED_BACK' })));
    setLogs((previous) => [...previous, `[停止并回滚演示] ${currentUser.userName} 已终止后续步骤，任务不会标记为已上线。`]);
  };

  return (
    <div className="cc-animate-in space-y-6 max-w-[1380px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.01em]">需求上线集中编排中心</h1>
            <span className="font-mono text-[13px] px-2.5 py-0.5 rounded-[8px] bg-[#eff6ff] text-[#1e40af]">{story.jiraKey}</span>
          </div>
          <p className="text-[14px] text-[#64748b] mt-1">发布物料、阶段门禁与执行顺序集中查看。本页仅演示流程。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!currentUser.permissions.canExecuteRelease && <span className="inline-flex items-center gap-1.5 text-[12px] text-[#64748b]"><Lock className="w-3.5 h-3.5" />当前角色无发布权限</span>}
          <button type="button" disabled={!canRollback} onClick={handleRollback} className="cc-btn cc-btn-secondary" title="仅在发布演示运行时可停止并回滚">
            <RotateCcw className="w-4 h-4" />停止并回滚演示
          </button>
          <button type="button" disabled={!canStart} onClick={handleExecuteRelease} className="cc-btn cc-btn-primary">
            <Play className="w-4 h-4" />{alreadyReleased ? '演示已完成' : releasing ? '正在模拟发布…' : '按序执行发布演示'}
          </button>
        </div>
      </div>

      <div className="cc-card p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[16px] font-semibold">前置演示门禁</h2>
          {gateChecks.map((gate) => <StatusBadge key={gate.label} variant={gate.passed ? 'green' : 'neutral'}>{gate.label} · {gate.passed ? '就绪' : '待完成'}</StatusBadge>)}
        </div>
        <p className="text-[13px] text-[#64748b]">原型规则：需求、方案、代码示例评分均 ≥ 90，无未处理 CRITICAL，用例覆盖率 100%。真实上线需人工审批与版本证据。</p>
      </div>

      {!isOrderDemo ? (
        <div className="cc-card p-10 text-center space-y-2">
          <FileCog className="w-8 h-8 mx-auto text-[#64748b]" />
          <h2 className="text-[18px] font-semibold">发布物料尚未准备</h2>
          <p className="text-[14px] text-[#64748b]">{story.jiraKey} 尚无发布清单和编排方案，可打开 ORD-200 体验上线演示。</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { icon: <GitMerge className="w-5 h-5" />, title: '2 个示例 MR', detail: 'be-order-service !88 · fe-mall-web !215' },
              { icon: <Database className="w-5 h-5" />, title: '1 份示例 SQL', detail: '订单拆分表与索引变更' },
              { icon: <FileCog className="w-5 h-5" />, title: '2 项示例配置', detail: '拆仓阈值与灰度开关' },
              { icon: <ShieldCheck className="w-5 h-5" />, title: gatesPassed ? '演示门禁就绪' : '前置评审待完成', detail: '仅用于交互演示，不代表真实审批' },
            ].map((item) => <div key={item.title} className="cc-card cc-card-hover p-6"><div className="cc-feature-icon">{item.icon}</div><h2 className="mt-4 text-[20px] font-semibold">{item.title}</h2><p className="text-[13px] text-[#64748b] mt-1">{item.detail}</p></div>)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 cc-card p-6 space-y-4">
              <h2 className="text-[18px] font-semibold border-b border-[#e5e7eb] pb-3">发布步骤与依赖</h2>
              {steps.map((step) => <div key={step.order} className="rounded-[12px] border border-[#e5e7eb] p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[15px] font-semibold">{step.order}. {step.title}</h3>
                  <StatusBadge variant={step.status === 'SUCCESS' ? 'green' : step.status === 'RUNNING' ? 'blue' : step.status === 'ROLLED_BACK' ? 'warn' : 'neutral'}>{step.status === 'SUCCESS' ? '演示完成' : step.status === 'RUNNING' ? '模拟执行中' : step.status === 'ROLLED_BACK' ? '演示已终止' : '等待前置步骤'}</StatusBadge>
                </div>
                <div className="font-mono text-[12px] text-[#1e40af] break-all">[{step.platform}] {step.target}</div>
                <p className="text-[13px] text-[#64748b]">{step.detail}</p>
              </div>)}
            </div>
            <div className="lg:col-span-5 cc-card p-6 space-y-4">
              <h2 className="text-[16px] font-semibold flex items-center gap-2 border-b border-[#e5e7eb] pb-3"><Terminal className="w-4 h-4 text-[#1e40af]" />编排演示日志</h2>
              <div role="log" aria-live="polite" className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-4 h-[380px] overflow-y-auto font-mono text-[12px] leading-[1.7] space-y-2 break-words">{logs.map((line, index) => <p key={index}>{line}</p>)}</div>
              <p className="text-[12px] text-[#64748b] flex items-start gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />运行时可停止并回滚；离开页面会取消后续演示步骤。完成后不允许重复发布。</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

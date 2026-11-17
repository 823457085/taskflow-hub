import React, { useState } from 'react';
import {
  GitPullRequest,
  Laptop,
  Layers,
  Plus,
  RefreshCw,
  ShieldCheck,
  ArrowRight,
  CheckSquare,
  ExternalLink,
} from 'lucide-react';
import { RequirementStory, StageKey, UserProfile } from '../data/mockPlatformData';
import { Modal, StatusBadge } from '../components/Primitives';

const STAGE_LABELS: Record<StageKey, string> = {
  PRD: '1. 需求评审',
  TECH_SPEC: '2. 技术方案审核',
  CODE_REVIEW: '3. 跨端代码审核',
  TEST_CASE: '4. 测试用例评审',
  RELEASE: '5. 需求上线集中管控',
};

export const TaskDashboardView: React.FC<{
  stories: RequirementStory[];
  existingKeys: string[];
  currentUser: UserProfile;
  onSelectStory: (jiraKey: string, stage?: StageKey) => void;
  onCreateStory: (story: RequirementStory) => void;
}> = ({ stories, existingKeys, currentUser, onSelectStory, onCreateStory }) => {
  const [stageFilter, setStageFilter] = useState<'ALL' | StageKey>('ALL');
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState('ORD-218');
  const [newTitle, setNewTitle] = useState('');
  const [newEpic, setNewEpic] = useState('EPIC-18 跨仓履约与智能拆单专项');
  const [syncingJira, setSyncingJira] = useState(false);

  const filtered = stories.filter((s) => stageFilter === 'ALL' || s.currentStage === stageFilter);

  const totalSubTasks = stories.reduce((acc, s) => acc + s.subTasks.length, 0);
  const activeLocalIdes = stories.reduce(
    (acc, s) => acc + s.subTasks.filter((t) => t.localConnected).length,
    0
  );
  const activeBlockers = stories.reduce(
    (acc, s) => acc + s.findings.filter((f) => f.severity === 'CRITICAL' && !f.overridden && !f.fixedInLocal).length,
    0
  );

  const handleTriggerJiraSync = () => {
    setSyncingJira(true);
    setTimeout(() => setSyncingJira(false), 600);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !/^[A-Z][A-Z0-9]*-[1-9]\d*$/.test(newKey.trim().toUpperCase()) || existingKeys.includes(newKey.trim().toUpperCase())) return;
    const created: RequirementStory = {
      jiraKey: newKey.trim().toUpperCase(),
      epicKey: newEpic.split(' ')[0] || 'EPIC-18',
      epicName: newEpic,
      title: newTitle.trim(),
      sprint: '2026 Sprint 46',
      priority: 'P1',
      owner: currentUser.userName.split(' ')[0],
      currentStage: 'PRD',
      jiraStatus: '需求评审中 (PRD Review)',
      prdUrl: 'https://confluence.example.invalid/pages/new-prd',
      techSpecUrl: 'https://confluence.example.invalid/pages/pending',
      prdScore: 88,
      techSpecScore: 0,
      codeScore: 0,
      testCoveragePct: 0,
      subTasks: [
        {
          jiraKey: `${newKey.trim().toUpperCase()}-1`,
          title: `${newTitle.trim()} — PRD 编写与 AI 产品预审`,
          type: '产品',
          assignee: currentUser.userName.split(' ')[0],
          jiraStatus: '进行中',
          progressPct: 50,
          lastSyncText: '演示任务已创建，未写入 Jira',
          checklist: [{ label: '补充异常分支与可测试验收标准 (AC)', done: false }],
        },
      ],
      findings: [],
    };
    onCreateStory(created);
    setNewTitle('');
    setCreateOpen(false);
  };

  return (
    <div className="cc-animate-in space-y-6 max-w-[1380px] mx-auto">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.01em] text-[#0f172a] leading-[1.25]">
              研发任务全流程追踪总览
            </h1>
            <StatusBadge variant="green">Jira 任务管理 · 演示数据</StatusBadge>
          </div>
          <p className="text-[14px] text-[#64748b] mt-1">
            工程纪律：无任务不立项、无任务不编码、无任务不上线。所有本地 AI 编程进程、代码审核与生产发布均强绑定 Jira 任务树。
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleTriggerJiraSync}
            className="cc-btn cc-btn-secondary"
          >
            <RefreshCw className={`w-4 h-4 text-[#64748b] ${syncingJira ? 'animate-spin' : ''}`} />
            {syncingJira ? '正在演示同步...' : '演示刷新任务树'}
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="cc-btn cc-btn-primary"
          >
            <Plus className="w-4 h-4" />
            新建演示任务
          </button>
        </div>
      </div>

      {/* 4 Corporate Clean Feature Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="cc-card cc-card-hover p-6">
          <div className="flex items-start justify-between">
            <div className="cc-feature-icon">
              <Layers className="w-5 h-5" />
            </div>
            <StatusBadge variant="blue">Sprint 46</StatusBadge>
          </div>
          <div className="mt-4">
            <div className="text-[28px] font-bold text-[#0f172a] leading-[1.2]">
              {stories.length} <span className="text-[14px] font-normal text-[#64748b]">个主需求 / {totalSubTasks} 子任务</span>
            </div>
            <p className="text-[14px] text-[#64748b] mt-1">各类研发工作通过 Jira 任务跟踪</p>
          </div>
        </div>

        <div className="cc-card cc-card-hover p-6">
          <div className="flex items-start justify-between">
            <div className="cc-feature-icon">
              <Laptop className="w-5 h-5" />
            </div>
            <StatusBadge variant="green" pulse>设备状态演示</StatusBadge>
          </div>
          <div className="mt-4">
            <div className="text-[28px] font-bold text-[#0f172a] leading-[1.2]">
              {activeLocalIdes} <span className="text-[14px] font-normal text-[#64748b]">个本地工具示例会话</span>
            </div>
            <p className="text-[14px] text-[#64748b] mt-1">Cursor / Claude Code / Codex CLI 进程同步预览</p>
          </div>
        </div>

        <div className="cc-card cc-card-hover p-6">
          <div className="flex items-start justify-between">
            <div className="cc-feature-icon">
              <ShieldCheck className="w-5 h-5" />
            </div>
            {activeBlockers > 0 ? (
              <StatusBadge variant="block">{activeBlockers} 项阻断待处理</StatusBadge>
            ) : (
              <StatusBadge variant="green">全部放行</StatusBadge>
            )}
          </div>
          <div className="mt-4">
            <div className="text-[28px] font-bold text-[#0f172a] leading-[1.2]">
              5 <span className="text-[14px] font-normal text-[#64748b]">类云端 AI 角色</span>
            </div>
            <p className="text-[14px] text-[#64748b] mt-1">覆盖 PRD、技术方案、跨仓代码、用例与上线</p>
          </div>
        </div>

        <div className="cc-card cc-card-hover p-6">
          <div className="flex items-start justify-between">
            <div className="cc-feature-icon">
              <GitPullRequest className="w-5 h-5" />
            </div>
            <StatusBadge variant="blue">集中收口</StatusBadge>
          </div>
          <div className="mt-4">
            <div className="text-[28px] font-bold text-[#0f172a] leading-[1.2]">
              5 <span className="text-[14px] font-normal text-[#64748b]">个计划接入平台</span>
            </div>
            <p className="text-[14px] text-[#64748b] mt-1">Jira · Confluence · GitLab · 云效 · Jenkins</p>
          </div>
        </div>
      </div>

      {/* Stage Filter Bar */}
      <div className="cc-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStageFilter('ALL')}
            className={`cc-btn !py-1.5 !px-3 !text-[13px] ${
              stageFilter === 'ALL' ? 'cc-btn-primary' : 'cc-btn-ghost'
            }`}
          >
            全部受控需求 ({stories.length})
          </button>
          {(Object.keys(STAGE_LABELS) as StageKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setStageFilter(key)}
              className={`cc-btn !py-1.5 !px-3 !text-[13px] ${
                stageFilter === key ? 'cc-btn-primary' : 'cc-btn-ghost'
              }`}
            >
              {STAGE_LABELS[key]}
            </button>
          ))}
        </div>
        <div className="text-[12px] text-[#64748b]">
          点击任意需求卡片进入 <span className="font-medium text-[#0f172a]">全流程作战室</span> 查看子任务、代码联审与本地同步进程
        </div>
      </div>

      {/* Story List Cards */}
      <div className="space-y-4">
        {filtered.length === 0 && <div className="cc-card p-8 text-center text-[#64748b]">没有符合条件的任务，请调整搜索或阶段筛选。</div>}
        {filtered.map((story) => {
          const unresolvedCriticals = story.findings.filter(
            (f) => f.severity === 'CRITICAL' && !f.overridden && !f.fixedInLocal
          ).length;

          return (
            <div
              key={story.jiraKey}
              className="cc-card cc-card-hover p-6 cursor-pointer"
              onClick={() => onSelectStory(story.jiraKey, story.currentStage)}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-mono text-[13px] font-semibold px-2 py-0.5 rounded bg-[#eff6ff] text-[#1e40af]">
                      {story.jiraKey}
                    </span>
                    <span className="text-[12px] text-[#64748b] font-mono">
                      归属专项: {story.epicKey} ({story.epicName})
                    </span>
                    <StatusBadge variant="blue">{STAGE_LABELS[story.currentStage]}</StatusBadge>
                    {unresolvedCriticals > 0 ? (
                      <StatusBadge variant="block">{unresolvedCriticals} 项跨端契约阻断</StatusBadge>
                    ) : (
                      <StatusBadge variant="green">暂无代码阻断</StatusBadge>
                    )}
                  </div>
                  <h2 className="text-[20px] font-semibold text-[#0f172a] leading-[1.4]">
                    {story.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-4 text-[13px] text-[#64748b]">
                    <span>负责人：{story.owner}</span>
                    <span>迭代：{story.sprint}</span>
                    <span>Jira 状态：{story.jiraStatus}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectStory(story.jiraKey, story.currentStage);
                  }}
                  className="cc-btn cc-btn-primary"
                >
                  进入全流程作战室
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>

              {/* 5-Stage Mini Stepper */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-5 pt-5 border-t border-[#e5e7eb]">
                {(
                  [
                    { key: 'PRD', label: '1. 需求评审', metric: story.prdScore ? `${story.prdScore} 分通过` : '待评审' },
                    { key: 'TECH_SPEC', label: '2. 技术方案', metric: story.techSpecScore >= 90 ? `${story.techSpecScore} 分 · 示例通过` : story.techSpecScore ? `${story.techSpecScore} 分 · 待完善` : '待开始' },
                    {
                      key: 'CODE_REVIEW',
                      label: '3. 跨端代码审核',
                      metric:
                        unresolvedCriticals > 0
                          ? `${unresolvedCriticals} 个 Blocker 拦截`
                          : story.codeScore >= 90
                          ? `${story.codeScore} 分 · 示例通过`
                          : '待提交 MR',
                    },
                    {
                      key: 'TEST_CASE',
                      label: '4. 测试用例评审',
                      metric: story.testCoveragePct ? `AC 覆盖率 ${story.testCoveragePct}%` : '待评审',
                    },
                    {
                      key: 'RELEASE',
                      label: '5. 集中编排上线',
                      metric: story.jiraStatus.includes('Released') ? '演示已上线' : '等待前置门禁',
                    },
                  ] as { key: StageKey; label: string; metric: string }[]
                ).map((st) => {
                  const isCurrent = story.currentStage === st.key;
                  const isBlocked = st.key === 'CODE_REVIEW' && unresolvedCriticals > 0;
                  return (
                    <button
                      type="button"
                      key={st.key}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectStory(story.jiraKey, st.key);
                      }}
                      className={`rounded-[8px] p-3 border transition-colors ${
                        isBlocked
                          ? 'bg-[#fef2f2] border-[#fecaca]'
                          : isCurrent
                          ? 'bg-[#eff6ff] border-[#3b82f6]'
                          : 'bg-[#f8fafc] border-[#e5e7eb] hover:border-[#cbd5e1]'
                      }`}
                    >
                      <div className="text-[12px] font-medium text-[#0f172a]">{st.label}</div>
                      <div
                        className={`text-[12px] mt-1 ${
                          isBlocked ? 'text-[#dc2626] font-medium' : isCurrent ? 'text-[#1e40af] font-medium' : 'text-[#64748b]'
                        }`}
                      >
                        {st.metric}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Sub-task & Local AI IDE Sync Strip */}
              <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[12px]">
                <span className="text-[#64748b] flex items-center gap-1 font-medium">
                  <CheckSquare className="w-3.5 h-3.5 text-[#1e40af]" />
                  关联执行子任务与本地 AI 编程同步：
                </span>
                {story.subTasks.map((sub) => (
                  <span
                    key={sub.jiraKey}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] text-[#0f172a]"
                  >
                    <span className="font-mono font-medium text-[#1e40af]">{sub.jiraKey}</span>
                    <span>[{sub.type}]</span>
                    <span className="text-[#64748b]">{sub.assignee}</span>
                    {sub.localIdeTool && (
                      <span className="text-[#059669] font-medium">
                        · {sub.localIdeTool} {sub.progressPct}%
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Story Modal (<=640px Single Column Corporate Clean Form) */}
      <Modal
        open={createOpen}
        title="新建演示任务"
        subtitle="在预览中体验任务进入评审流程；不会创建真实 Jira 事项。"
        onClose={() => setCreateOpen(false)}
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-task-key" className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
                演示任务号
              </label>
              <input
                id="new-task-key"
                required
                pattern="[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*"
                title="例如 ORD-218，任务号必须唯一"
                className="cc-input font-mono"
                value={newKey}
                onChange={(e) => {
                  const value = e.target.value;
                  setNewKey(value);
                  e.target.setCustomValidity(existingKeys.includes(value.trim().toUpperCase()) ? '该演示任务号已存在' : '');
                }}
              />
            </div>
            <div>
              <label htmlFor="new-task-epic" className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
                归属 Jira Epic 专项
              </label>
              <input
                className="cc-input"
                id="new-task-epic"
                value={newEpic}
                onChange={(e) => setNewEpic(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label htmlFor="new-task-title" className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
              需求 / 任务标题 <span className="text-[#dc2626]">*</span>
            </label>
            <input
              className="cc-input"
              id="new-task-title"
              placeholder="例如：支持跨境大促组合商品阶梯退换货逆向结算"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              required
            />
            <p className="text-[12px] text-[#64748b] mt-1.5">
              创建后进入需求评审，等待关联 PRD。所有操作仅保留于本次预览。
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#e5e7eb]">
            <button type="button" onClick={() => setCreateOpen(false)} className="cc-btn cc-btn-secondary">
              取消
            </button>
            <button type="submit" className="cc-btn cc-btn-primary">
              <ExternalLink className="w-4 h-4" />
              创建演示任务
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import {
  Blocks,
  Code2,
  Database,
  FileCheck2,
  FileText,
  KeyRound,
  Laptop,
  LayoutDashboard,
  Rocket,
  Search,
  ShieldCheck,
  TestTube2,
  UserCheck,
} from 'lucide-react';
import {
  INITIAL_STORIES,
  RequirementStory,
  RoleKey,
  StageKey,
  USER_ROLES,
} from './data/mockPlatformData';
import { TaskDashboardView } from './views/TaskDashboardView';
import { TaskCockpitView } from './views/TaskCockpitView';
import { ReleaseCenterView } from './views/ReleaseCenterView';
import { AiRolesAndPluginsView } from './views/AiRolesAndPluginsView';
import { LocalBridgeView } from './views/LocalBridgeView';
import { AccountAndRbacView } from './views/AccountAndRbacView';
import { PlatformServiceView } from './views/PlatformServiceView';

type NavTab =
  | 'DASHBOARD'
  | 'COCKPIT'
  | 'RELEASE_CENTER'
  | 'AI_PLUGINS'
  | 'LOCAL_BRIDGE'
  | 'SERVICE'
  | 'ACCOUNTS_RBAC';

const DemoApp: React.FC = () => {
  const [activeNav, setActiveNav] = useState<NavTab>('DASHBOARD');
  const [currentRoleKey, setCurrentRoleKey] = useState<RoleKey>('BACKEND_DEV');
  const [stories, setStories] = useState<RequirementStory[]>(INITIAL_STORIES);
  const [selectedStoryKey, setSelectedStoryKey] = useState<string>('ORD-200');
  const [cockpitStage, setCockpitStage] = useState<StageKey>('CODE_REVIEW');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    document.title = 'TaskFlow AI Hub · 交互预览';
  }, []);

  const currentUser = USER_ROLES[currentRoleKey];
  const activeStory =
    stories.find((s) => s.jiraKey === selectedStoryKey) || stories[0];

  const handleOpenStoryCockpit = (jiraKey: string, stage?: StageKey) => {
    setSelectedStoryKey(jiraKey);
    const target = stories.find((s) => s.jiraKey === jiraKey);
    setCockpitStage(stage || target?.currentStage || 'CODE_REVIEW');
    setActiveNav('COCKPIT');
  };

  const handleJumpStageNav = (stage: StageKey) => {
    setCockpitStage(stage);
    if (stage === 'RELEASE') {
      setActiveNav('RELEASE_CENTER');
    } else {
      setActiveNav('COCKPIT');
    }
  };

  const handleOverrideFinding = (
    storyKey: string,
    findingId: string,
    reason: string,
    byUser: string
  ) => {
    if (!currentUser.permissions.canOverrideGate || !reason.trim()) return;
    setStories((prev) =>
      prev.map((st) => {
        if (st.jiraKey !== storyKey) return st;
        return {
          ...st,
          codeScore: 93,
          findings: st.findings.map((f) =>
            f.id === findingId
              ? { ...f, overridden: true, overrideReason: reason, overrideBy: byUser }
              : f
          ),
        };
      })
    );
  };

  const handleSimulateLocalFix = (storyKey: string, findingId: string) => {
    setStories((prev) =>
      prev.map((st) => {
        if (st.jiraKey !== storyKey) return st;
        return {
          ...st,
          codeScore: 96,
          subTasks: st.subTasks.map((sub) =>
            sub.jiraKey === 'ORD-204'
              ? {
                  ...sub,
                  progressPct: 100,
                  jiraStatus: '已完成',
                  lastSyncText: '演示：已同步本地修复，未提交代码',
                  checklist: sub.checklist.map((c) => ({ ...c, done: true })),
                }
              : sub
          ),
          findings: st.findings.map((f) =>
            f.id === findingId ? { ...f, fixedInLocal: true } : f
          ),
        };
      })
    );
  };

  const handleMarkStoryReleased = (jiraKey: string) => {
    setStories((prev) =>
      prev.map((st) =>
        st.jiraKey === jiraKey
          ? {
              ...st,
              jiraStatus: '已上线 (Released)',
              subTasks: st.subTasks.map((sub) => ({
                ...sub,
                progressPct: 100,
                jiraStatus: '已完成',
              })),
            }
          : st
      )
    );
  };

  const filteredStories = searchQuery.trim()
    ? stories.filter(
        (s) =>
          s.jiraKey.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.epicName.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : stories;

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc] text-[#0f172a]">
      {/* Top Navigation: 64px height, #ffffff bg, 1px #e5e7eb bottom border, no shadow (per StyleKit Corporate Clean) */}
      <header className="app-header min-h-[64px] bg-[#ffffff] border-b border-[#e5e7eb] px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => setActiveNav('DASHBOARD')}
            className="flex items-center gap-2.5 text-left cursor-pointer"
          >
            <div className="w-8 h-8 rounded-[8px] bg-[#1e40af] text-white flex items-center justify-center font-bold text-[15px]">
              TF
            </div>
            <div>
              <div className="text-[17px] font-semibold text-[#0f172a] leading-none">
                TaskFlow AI Hub
              </div>
              <div className="text-[11px] text-[#64748b] mt-0.5">
                {activeNav === 'SERVICE' ? '本机基础服务 · 真实本地数据' : '交互预览 · 所有平台状态与执行结果均为演示'}
              </div>
            </div>
          </button>

          <div className="hidden md:flex items-center relative w-[300px]">
            <Search className="w-4 h-4 text-[#64748b] absolute left-3 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (activeNav !== 'DASHBOARD') setActiveNav('DASHBOARD');
              }}
              aria-label="搜索任务"
              placeholder="搜索 Jira 任务号、标题或专项"
              className="cc-input !pl-9 !py-1.5 !text-[13px] !bg-[#f8fafc]"
            />
          </div>
        </div>

        {/* Right Side: Interactive Multi-User / Role Switcher & Quick Action */}
        <div className="flex items-center gap-3">
          <div className={`items-center gap-2 bg-[#f8fafc] border border-[#e5e7eb] rounded-[8px] px-2.5 py-1 ${activeNav === 'SERVICE' ? 'hidden' : 'flex'}`}>
            <UserCheck className="w-4 h-4 text-[#1e40af] shrink-0" />
            <span className="text-[12px] text-[#64748b] hidden sm:inline">预览登录角色:</span>
            <select
              aria-label="切换当前预览登录角色"
              value={currentRoleKey}
              onChange={(e) => setCurrentRoleKey(e.target.value as RoleKey)}
              className="bg-transparent text-[13px] font-medium text-[#0f172a] focus:outline-none cursor-pointer"
            >
              {(Object.keys(USER_ROLES) as RoleKey[]).map((rk) => (
                <option key={rk} value={rk}>
                  {USER_ROLES[rk].roleLabel} — {USER_ROLES[rk].userName.split(' ')[0]}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => setActiveNav('LOCAL_BRIDGE')}
            className="cc-btn cc-btn-primary !py-1.5 !px-3.5 !text-[13px]"
          >
            <Laptop className="w-4 h-4" />
            本地 AI 桥接
          </button>
        </div>
      </header>

      <nav aria-label="移动端页面导航" className="mobile-nav md:hidden flex gap-2 p-3 bg-white border-b border-[#e5e7eb] overflow-x-auto">
        {([['DASHBOARD', '任务总览'], ['COCKPIT', '评审作战室'], ['RELEASE_CENTER', '上线编排'], ['AI_PLUGINS', 'AI 与插件'], ['LOCAL_BRIDGE', '本地工具'], ['ACCOUNTS_RBAC', '账号权限'], ['SERVICE', '本机服务']] as [NavTab, string][]).map(([key, label]) => (
          <button key={key} type="button" className={`cc-btn !text-[12px] !px-3 ${activeNav === key ? 'cc-btn-primary' : 'cc-btn-ghost'}`} onClick={() => setActiveNav(key)}>{label}</button>
        ))}
      </nav>
      {/* Main Body: Fixed Sidebar (240px) + Slate Mist (#f8fafc) Main Canvas */}
      <div className="flex flex-1">
        <aside className="w-[240px] shrink-0 bg-[#ffffff] border-r border-[#e5e7eb] p-4 hidden md:flex flex-col justify-between md:sticky md:top-16 md:h-[calc(100vh-64px)] overflow-y-auto gap-6">
          <div className="space-y-6">
            {/* Group 1: Task Hub */}
            <div className="space-y-1">
              <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b]">
                任务跟踪中枢 (Jira 底座)
              </div>
              <SidebarItem
                active={activeNav === 'DASHBOARD'}
                onClick={() => setActiveNav('DASHBOARD')}
                icon={<LayoutDashboard className="w-4 h-4" />}
                label="研发任务追踪总览"
              />
              <SidebarItem
                active={activeNav === 'COCKPIT' && cockpitStage !== 'RELEASE'}
                onClick={() => setActiveNav('COCKPIT')}
                icon={<ShieldCheck className="w-4 h-4" />}
                label={`全流程作战室 (${activeStory.jiraKey})`}
              />
            </div>

            {/* Group 2: 5 Centralized Control Stages */}
            <div className="space-y-1">
              <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b]">
                五大核心流程集中管控
              </div>
              <SidebarItem
                active={activeNav === 'COCKPIT' && cockpitStage === 'PRD'}
                onClick={() => handleJumpStageNav('PRD')}
                icon={<FileText className="w-4 h-4" />}
                label="1. 需求评审 (PRD)"
              />
              <SidebarItem
                active={activeNav === 'COCKPIT' && cockpitStage === 'TECH_SPEC'}
                onClick={() => handleJumpStageNav('TECH_SPEC')}
                icon={<FileCheck2 className="w-4 h-4" />}
                label="2. 技术方案审核"
              />
              <SidebarItem
                active={activeNav === 'COCKPIT' && cockpitStage === 'CODE_REVIEW'}
                onClick={() => handleJumpStageNav('CODE_REVIEW')}
                icon={<Code2 className="w-4 h-4" />}
                label="3. 跨端代码审核"
                badge={
                  activeStory.findings.filter(
                    (f) => f.severity === 'CRITICAL' && !f.overridden && !f.fixedInLocal
                  ).length || undefined
                }
              />
              <SidebarItem
                active={activeNav === 'COCKPIT' && cockpitStage === 'TEST_CASE'}
                onClick={() => handleJumpStageNav('TEST_CASE')}
                icon={<TestTube2 className="w-4 h-4" />}
                label="4. 测试用例评审"
              />
              <SidebarItem
                active={activeNav === 'RELEASE_CENTER'}
                onClick={() => setActiveNav('RELEASE_CENTER')}
                icon={<Rocket className="w-4 h-4" />}
                label="5. 需求上线编排中心"
              />
            </div>

            {/* Group 3: Cloud AI, Local Bridge & Governance */}
            <div className="space-y-1">
              <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b]">
                云-端 AI 协同与扩展底座
              </div>
              <SidebarItem
                active={activeNav === 'AI_PLUGINS'}
                onClick={() => setActiveNav('AI_PLUGINS')}
                icon={<Blocks className="w-4 h-4" />}
                label="云端 AI 角色与插件库"
              />
              <SidebarItem
                active={activeNav === 'LOCAL_BRIDGE'}
                onClick={() => setActiveNav('LOCAL_BRIDGE')}
                icon={<Laptop className="w-4 h-4" />}
                label="本地编程工具同步"
              />
              <SidebarItem
                active={activeNav === 'ACCOUNTS_RBAC'}
                onClick={() => setActiveNav('ACCOUNTS_RBAC')}
                icon={<KeyRound className="w-4 h-4" />}
                label="多账号算力池 & 权限"
              />
              <SidebarItem
                active={activeNav === 'SERVICE'}
                onClick={() => setActiveNav('SERVICE')}
                icon={<Database className="w-4 h-4" />}
                label="基础服务（本机）"
              />
            </div>
          </div>

          <div className="rounded-[12px] bg-[#f8fafc] border border-[#e5e7eb] p-3.5 text-[12px] space-y-1">
            <div className="font-semibold text-[#0f172a]">StyleKit · Corporate Clean</div>
            <div className="text-[#64748b]">
              演示范围：Jira · Confluence · GitLab · 云效 · Jenkins
            </div>
          </div>
        </aside>

        {/* Main Content Canvas */}
        <main className="flex-1 min-w-0 p-4 md:p-8 overflow-y-auto">
          {activeNav === 'DASHBOARD' && (
            <TaskDashboardView
              stories={filteredStories}
              existingKeys={stories.map((story) => story.jiraKey)}
              currentUser={currentUser}
              onSelectStory={handleOpenStoryCockpit}
              onCreateStory={(created) => {
                setStories((prev) => [created, ...prev]);
                handleOpenStoryCockpit(created.jiraKey, 'PRD');
              }}
            />
          )}

          {activeNav === 'COCKPIT' && (
            <TaskCockpitView
              key={activeStory.jiraKey}
              story={activeStory}
              activeStage={cockpitStage}
              onChangeStage={(st) => {
                if (st === 'RELEASE') {
                  setActiveNav('RELEASE_CENTER');
                } else {
                  setCockpitStage(st);
                }
              }}
              currentUser={currentUser}
              onOverrideFinding={handleOverrideFinding}
              onSimulateLocalFix={handleSimulateLocalFix}
              onJumpToReleaseCenter={() => setActiveNav('RELEASE_CENTER')}
              onApproveTestCases={(storyKey) => {
                if (!currentUser.permissions.canApproveTestCase) return;
                setStories((prev) => prev.map((story) => story.jiraKey === storyKey ? { ...story, testCoveragePct: 100 } : story));
              }}
            />
          )}

          {activeNav === 'RELEASE_CENTER' && (
            <ReleaseCenterView
              key={activeStory.jiraKey}
              story={activeStory}
              currentUser={currentUser}
              onMarkStoryReleased={handleMarkStoryReleased}
            />
          )}

          {activeNav === 'AI_PLUGINS' && <AiRolesAndPluginsView currentUser={currentUser} />}

          {activeNav === 'LOCAL_BRIDGE' && <LocalBridgeView />}
          {activeNav === 'SERVICE' && <PlatformServiceView />}

          {activeNav === 'ACCOUNTS_RBAC' && (
            <AccountAndRbacView
              currentUser={currentUser}
              onSwitchRole={(rk) => setCurrentRoleKey(rk)}
            />
          )}
        </main>
      </div>
    </div>
  );
};

const SidebarItem: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}> = ({ active, onClick, icon, label, badge }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[8px] text-[13px] font-medium transition-all cursor-pointer ${
      active
        ? 'bg-[#eff6ff] text-[#1e40af] border-l-[3px] border-[#3b82f6]'
        : 'text-[#64748b] hover:bg-[#f8fafc] hover:text-[#0f172a]'
    }`}
  >
    <span className="flex items-center gap-2.5 truncate">
      {icon}
      <span className="truncate">{label}</span>
    </span>
    {badge !== undefined && badge > 0 && (
      <span className="px-1.5 py-0.5 text-[11px] font-mono rounded-full bg-[#fef2f2] text-[#dc2626] border border-[#fecaca]">
        {badge}
      </span>
    )}
  </button>
);


export default DemoApp;

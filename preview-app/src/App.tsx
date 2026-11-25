import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Button, Drawer, Layout, Menu, Skeleton, type MenuProps } from 'antd';
import {
  Blocks,
  FileText,
  FolderKanban,
  GitPullRequest,
  KeyRound,
  Layers3,
  Laptop,
  LayoutDashboard,
  Bot, BookOpen, ListChecks, ListTodo, NotebookText, Rocket, Sparkles,
  Menu as MenuIcon,
  Workflow,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react';
import { PlatformServiceView } from './views/PlatformServiceView';
import { displayWorkspaceSection, navigateWorkspace, requirementIdFromRoute, requirementReviewStageForSection, SECTION_LABELS, WorkspaceSection } from './views/workspaceNavigation';
import { DEFAULT_TASKFLOW_THEME, resolveTaskFlowTheme, type TaskFlowThemeId } from './theme';
import { ThemePicker } from './ThemePicker';

const DemoApp = lazy(() => import('./DemoApp'));

export const App: React.FC<{
  themeId?: TaskFlowThemeId;
  onThemeChange?: (next: TaskFlowThemeId) => void;
}> = ({ themeId = DEFAULT_TASKFLOW_THEME, onThemeChange }) => {
  const route = () => new URLSearchParams(location.hash.slice(1));
  const isDemo = () => location.protocol === 'file:' || route().get('mode') === 'demo';
  const [demo, setDemo] = useState(isDemo);
  const [section, setSection] = useState<WorkspaceSection>(() => displayWorkspaceSection());
  const [authenticated, setAuthenticated] = useState(false);
  const [access, setAccess] = useState({ manageMembers: false, manageConnections: false });
  const [workHash, setWorkHash] = useState('');
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null);
  const stageSurface = useRef<HTMLDivElement>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('taskflow.rail.collapsed') === '1'; } catch { return false; }
  });

  const themeMeta = resolveTaskFlowTheme(themeId);
  const railWidth = railCollapsed ? 60 : 220;

  useEffect(() => {
    const changed = () => { setDemo(isDemo()); setSection(displayWorkspaceSection()); setNavigationOpen(false); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const changed = () => { setDesktop(media.matches); if (media.matches) setNavigationOpen(false); };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => { document.title = demo ? 'TaskFlow AI Hub · 原型演示' : 'TaskFlow AI Hub · 研发工作台'; }, [demo]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); stageSurface.current?.scrollTo(0, 0); }, [demo, section]);
  useEffect(() => { if (!authenticated) setNavigationOpen(false); }, [authenticated]);

  const toggleRail = () => {
    setRailCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('taskflow.rail.collapsed', next ? '1' : '0'); } catch { /* optional */ }
      return next;
    });
  };

  const navigate = (next: WorkspaceSection) => {
    navigateWorkspace(next, { requirementId: requirementIdFromRoute() });
    setNavigationOpen(false);
    stageSurface.current?.scrollTo(0, 0);
  };
  const sectionLabel = (key: WorkspaceSection) => key === 'members' && !access.manageMembers ? '项目成员' : key === 'connections' && !access.manageConnections ? '平台读取' : SECTION_LABELS[key];
  const menuItems: MenuProps['items'] = [
    {
      key: 'group:work',
      type: 'group',
      label: desktop && railCollapsed ? null : '研发',
      children: [
        { key: 'overview', icon: <LayoutDashboard size={14} />, label: SECTION_LABELS.overview },
        { key: 'projects', icon: <FolderKanban size={14} />, label: SECTION_LABELS.projects },
        { key: 'tasks', icon: <ListTodo size={14} />, label: SECTION_LABELS.tasks },
        { key: 'assets', icon: <FileText size={14} />, label: SECTION_LABELS.assets },
      ],
    },
    {
      key: 'group:reviews',
      type: 'group',
      label: desktop && railCollapsed ? null : '评审',
      children: [
        { key: 'tech-review', icon: <Layers3 size={14} />, label: SECTION_LABELS['tech-review'] },
        { key: 'test-review', icon: <ListChecks size={14} />, label: SECTION_LABELS['test-review'] },
        { key: 'code-review', icon: <GitPullRequest size={14} />, label: SECTION_LABELS['code-review'] },
      ],
    },
    {
      key: 'group:collab',
      type: 'group',
      label: desktop && railCollapsed ? null : '协同',
      children: [
        { key: 'todos', icon: <ListChecks size={14} />, label: SECTION_LABELS.todos },
        { key: 'reports', icon: <NotebookText size={14} />, label: SECTION_LABELS.reports },
        { key: 'deployments', icon: <Rocket size={14} />, label: SECTION_LABELS.deployments },
        { key: 'sessions', icon: <Bot size={14} />, label: SECTION_LABELS.sessions },
        { key: 'knowledge', icon: <BookOpen size={14} />, label: SECTION_LABELS.knowledge },
      ],
    },
    {
      key: 'group:settings',
      type: 'group',
      label: desktop && railCollapsed ? null : '设置',
      children: [
        { key: 'members', icon: <Users size={14} />, label: sectionLabel('members') },
        { key: 'accounts', icon: <KeyRound size={14} />, label: SECTION_LABELS.accounts },
        { key: 'connections', icon: <Blocks size={14} />, label: sectionLabel('connections') },
        { key: 'skills', icon: <Sparkles size={14} />, label: SECTION_LABELS.skills },
        { key: 'local', icon: <Laptop size={14} />, label: SECTION_LABELS.local },
      ],
    },
  ];
  const navigation = (
    <nav aria-label="工作台导航">
      <Menu
        className="tf-shell-menu"
        mode="inline"
        inlineCollapsed={desktop && railCollapsed}
        selectedKeys={[section === 'reviews' ? 'overview' : section]}
        items={menuItems}
        onClick={({ key }) => navigate(key as WorkspaceSection)}
      />
    </nav>
  );
  const demoEntry = (
    <Button
      type="text"
      size="small"
      icon={<MonitorPlay size={14} />}
      className="tf-shell-demo-link"
      aria-label="演示原型"
      title="演示原型"
      onClick={() => { setWorkHash(location.hash); location.hash = 'mode=demo'; }}
    >
      {railCollapsed && desktop ? '' : '演示原型'}
    </Button>
  );

  if (demo) return <>
    <Suspense fallback={<div role="status" aria-label="正在加载交互原型" style={{ maxWidth: 1120, margin: '0 auto', padding: 24 }}><Skeleton active title paragraph={{ rows: 8 }} /></div>}><DemoApp /></Suspense>
    <Button className="workspace-demo-return" onClick={() => { location.hash = workHash; }}>返回真实工作台</Button>
  </>;

  return (
    <Layout className={`workbench tf-shell tf-theme-${themeId} ${authenticated ? 'workbench-signed-in' : 'workbench-signed-out'}${authenticated && (section === 'tasks' || requirementReviewStageForSection(section)) ? ' tf-shell-task-view' : ''}`}>
      <Layout.Header className="tf-shell-header">
        <div className="tf-shell-header-start" style={authenticated && desktop ? { width: railWidth } : undefined}>
          {authenticated && !desktop && (
            <Button type="text" className="tf-shell-menu-toggle" icon={<MenuIcon size={18} />} aria-label="打开工作台导航" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)} />
          )}
          <button type="button" className="tf-shell-brand" aria-label="返回工作台" onClick={() => navigate('overview')}>
            <span className="tf-shell-brand-mark"><Workflow size={19} strokeWidth={2.25} aria-hidden="true" /></span>
            {!(authenticated && desktop && railCollapsed) && <strong>TaskFlow</strong>}
          </button>
          {authenticated && desktop && !railCollapsed && (
            <button type="button" className="tf-sider-collapse" aria-label="收起侧栏导航" title="收起侧栏" onClick={toggleRail}><PanelLeftClose size={15} /></button>
          )}
        </div>
        <div className="tf-shell-header-end">
          {authenticated ? <div className="tf-shell-actions-slot" ref={setHeaderActions} /> : onThemeChange && <ThemePicker value={themeId} onChange={onThemeChange} />}
        </div>
      </Layout.Header>

      <Layout className="tf-shell-body" hasSider={authenticated && desktop}>
        {authenticated && desktop && (
          <Layout.Sider
            width={220}
            collapsedWidth={60}
            collapsed={railCollapsed}
            theme={themeMeta.dark ? 'dark' : 'light'}
            className={`tf-shell-sider${railCollapsed ? ' is-collapsed' : ''}`}
          >
            {railCollapsed && <div className="tf-sider-head"><button type="button" className="tf-sider-collapse" aria-label="展开侧栏导航" title="展开侧栏" onClick={toggleRail}><PanelLeftOpen size={15} /></button></div>}
            {navigation}
            <div className="tf-shell-sidebar-foot">
              {demoEntry}
              {!railCollapsed && onThemeChange && <ThemePicker value={themeId} onChange={onThemeChange} placement="rightBottom" />}
            </div>
          </Layout.Sider>
        )}
        <Layout.Content className="tf-shell-content">
          <div className="tf-stage-surface" ref={stageSurface}>
            <PlatformServiceView headerActions={headerActions} section={section} onSessionChange={setAuthenticated} onAccessChange={setAccess} />
          </div>
        </Layout.Content>
      </Layout>

      {authenticated && !desktop && (
        <Drawer
          className="tf-shell-drawer"
          title="工作空间"
          placement="left"
          size={280}
          open={navigationOpen}
          onClose={() => setNavigationOpen(false)}
          destroyOnHidden
          footer={<div className="tf-mobile-nav-foot">{demoEntry}{onThemeChange && <ThemePicker value={themeId} onChange={onThemeChange} placement="topLeft" />}</div>}
          styles={{ body: { padding: '8px' } }}
        >
          {navigation}
        </Drawer>
      )}
    </Layout>
  );
};

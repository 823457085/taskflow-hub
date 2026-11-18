import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Button, Drawer, Layout, Menu, Skeleton, type MenuProps } from 'antd';
import {
  Blocks,
  ClipboardCheck,
  ExternalLink,
  FileText,
  FolderKanban,
  KeyRound,
  Laptop,
  LayoutDashboard,
  Bot, BookOpen, ListChecks, ListTodo, NotebookText, Rocket, Sparkles,
  Menu as MenuIcon,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react';
import { PlatformServiceView } from './views/PlatformServiceView';
import { openWorkbench } from './views/workspaceApi';
import { currentWorkspaceSection, navigateWorkspace, SECTION_LABELS, WorkspaceSection } from './views/workspaceNavigation';
import { DEFAULT_TASKFLOW_THEME, resolveTaskFlowTheme, type TaskFlowThemeId } from './theme';
import { ThemePicker } from './ThemePicker';

const DemoApp = lazy(() => import('./DemoApp'));

const TOP_NAV_SECTIONS: { key: WorkspaceSection; shortLabel: string; icon: React.ReactNode }[] = [
  { key: 'overview', shortLabel: '工作台', icon: <LayoutDashboard size={14} /> },
  { key: 'projects', shortLabel: '项目', icon: <FolderKanban size={14} /> },
  { key: 'tasks', shortLabel: '任务', icon: <ListTodo size={14} /> },
  { key: 'todos', shortLabel: '待办', icon: <ListChecks size={14} /> },
  { key: 'reports', shortLabel: '日报', icon: <NotebookText size={14} /> },
  { key: 'reviews', shortLabel: '评审', icon: <ClipboardCheck size={14} /> },
  { key: 'assets', shortLabel: '材料', icon: <FileText size={14} /> },
  { key: 'members', shortLabel: '成员', icon: <Users size={14} /> },
  { key: 'accounts', shortLabel: '账号', icon: <KeyRound size={14} /> },
  { key: 'connections', shortLabel: '连接', icon: <Blocks size={14} /> },
  { key: 'local', shortLabel: '本地 AI', icon: <Laptop size={14} /> },
];

export const App: React.FC<{
  themeId?: TaskFlowThemeId;
  onThemeChange?: (next: TaskFlowThemeId) => void;
}> = ({ themeId = DEFAULT_TASKFLOW_THEME, onThemeChange }) => {
  const route = () => new URLSearchParams(location.hash.slice(1));
  const isDemo = () => location.protocol === 'file:' || route().get('mode') === 'demo';
  const [demo, setDemo] = useState(isDemo);
  const [section, setSection] = useState<WorkspaceSection>(currentWorkspaceSection);
  const [authenticated, setAuthenticated] = useState(false);
  const [access, setAccess] = useState({ manageMembers: false, manageConnections: false });
  const [workHash, setWorkHash] = useState('');
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('taskflow.rail.collapsed') === '1'; } catch { return false; }
  });

  const themeMeta = resolveTaskFlowTheme(themeId);

  useEffect(() => {
    const changed = () => { setDemo(isDemo()); setSection(currentWorkspaceSection()); setNavigationOpen(false); };
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
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [demo, section]);
  useEffect(() => { if (!authenticated) setNavigationOpen(false); }, [authenticated]);

  const toggleRail = () => {
    setRailCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('taskflow.rail.collapsed', next ? '1' : '0'); } catch { /* optional */ }
      return next;
    });
  };

  const navigate = (next: WorkspaceSection) => {
    navigateWorkspace(next);
    setNavigationOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const sectionLabel = (key: WorkspaceSection) => key === 'members' && !access.manageMembers ? '项目成员' : key === 'connections' && !access.manageConnections ? '平台读取' : SECTION_LABELS[key];
  const menuItems: MenuProps['items'] = [
    { type: 'group', label: railCollapsed ? '·' : '工作空间', children: [
      { key: 'overview', icon: <LayoutDashboard size={14} />, label: SECTION_LABELS.overview },
      { key: 'projects', icon: <FolderKanban size={14} />, label: SECTION_LABELS.projects },
      { key: 'tasks', icon: <ListTodo size={14} />, label: SECTION_LABELS.tasks },
      { key: 'todos', icon: <ListChecks size={14} />, label: SECTION_LABELS.todos },
      { key: 'reports', icon: <NotebookText size={14} />, label: SECTION_LABELS.reports },
    ] },
    { type: 'group', label: railCollapsed ? '·' : '交付协作', children: [
      { key: 'reviews', icon: <ClipboardCheck size={14} />, label: SECTION_LABELS.reviews },
      { key: 'assets', icon: <FileText size={14} />, label: SECTION_LABELS.assets },
      { key: 'sessions', icon: <Bot size={14} />, label: SECTION_LABELS.sessions },
      { key: 'deployments', icon: <Rocket size={14} />, label: SECTION_LABELS.deployments },
      { key: 'knowledge', icon: <BookOpen size={14} />, label: SECTION_LABELS.knowledge },
      { key: 'skills', icon: <Sparkles size={14} />, label: SECTION_LABELS.skills },
    ] },
    { type: 'group', label: railCollapsed ? '·' : '平台与本机', children: [
      { key: 'members', icon: <Users size={14} />, label: sectionLabel('members') },
      { key: 'accounts', icon: <KeyRound size={14} />, label: SECTION_LABELS.accounts },
      { key: 'connections', icon: <Blocks size={14} />, label: sectionLabel('connections') },
      { key: 'local', icon: <Laptop size={14} />, label: SECTION_LABELS.local },
    ] },
  ];
  const navigation = (
    <nav aria-label="工作台导航">
      <Menu
        className="tf-shell-menu"
        mode="inline"
        inlineCollapsed={desktop && railCollapsed}
        selectedKeys={[section]}
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
    <Layout className={`workbench tf-shell tf-theme-${themeId} ${authenticated ? 'workbench-signed-in' : 'workbench-signed-out'}`}>
      <Layout.Header className="tf-shell-header">
        <div className="tf-shell-header-start">
          {authenticated && !desktop && (
            <Button
              type="text"
              className="tf-shell-menu-toggle"
              icon={<MenuIcon size={18} />}
              aria-label="打开工作台导航"
              aria-expanded={navigationOpen}
              onClick={() => setNavigationOpen(true)}
            />
          )}
          <button type="button" className="tf-shell-brand" aria-label="返回工作台" onClick={() => navigate('overview')}>
            <span className="tf-shell-brand-mark">TF</span>
            <span className="tf-shell-brand-copy">
              <strong>TASKFLOW</strong>
              <span>{themeId.toUpperCase()} // {location.host}</span>
            </span>
          </button>
          {authenticated && desktop && (
            <nav className="tf-top-nav" aria-label="顶部快捷切换">
              {TOP_NAV_SECTIONS.map(item => (
                <button
                  key={item.key}
                  type="button"
                  className={`tf-top-nav-item${section === item.key ? ' is-active' : ''}`}
                  aria-current={section === item.key ? 'page' : undefined}
                  onClick={() => navigate(item.key)}
                >
                  {item.icon}
                  <span>{item.key === 'members' || item.key === 'connections' ? sectionLabel(item.key) : item.shortLabel}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
        <div className="tf-shell-header-end">
          {authenticated ? (
            <button type="button" className="tf-companion-pill" onClick={() => openWorkbench()}>
              <span>我的工作台</span>
              <ExternalLink size={12} />
            </button>
          ) : null}
          {authenticated && desktop && (
            <Button
              size="small"
              type="text"
              icon={<MonitorPlay size={13} />}
              className="tf-top-demo-btn"
              onClick={() => { setWorkHash(location.hash); location.hash = 'mode=demo'; }}
            >
              原型
            </Button>
          )}
          {onThemeChange && <ThemePicker value={themeId} onChange={onThemeChange} />}
        </div>
      </Layout.Header>

      <Layout className="tf-shell-body" hasSider={authenticated && desktop}>
        {authenticated && desktop && (
          <Layout.Sider
            width={208}
            collapsedWidth={60}
            collapsed={railCollapsed}
            theme={themeMeta.dark ? 'dark' : 'light'}
            className={`tf-shell-sider${railCollapsed ? ' is-collapsed' : ''}`}
          >
            <div className="tf-sider-head">
              {!railCollapsed && <span className="tf-sider-kicker">导航</span>}
              <button
                type="button"
                className="tf-sider-collapse"
                aria-label={railCollapsed ? '展开侧栏导航' : '收起侧栏导航'}
                title={railCollapsed ? '展开侧栏' : '收起侧栏'}
                onClick={toggleRail}
              >
                {railCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
              </button>
            </div>
            {navigation}
            <div className="tf-shell-sidebar-foot">
              {!railCollapsed ? (
                <div className="tf-sider-signal">
                  <span>服务地址</span>
                  <em>{location.host}</em>
                </div>
              ) : (
                demoEntry
              )}
            </div>
          </Layout.Sider>
        )}
        <Layout.Content className="tf-shell-content">
          <div className="tf-stage-surface">
            <PlatformServiceView section={section} onSessionChange={setAuthenticated} onAccessChange={setAccess} />
          </div>
        </Layout.Content>
      </Layout>

      <footer className="tf-shell-statusbar" aria-label="平台运行遥测">
        <div className="tf-statusbar-left">
          <span className="tf-statusbar-dot" aria-hidden="true" />
          <strong>TaskFlow AI Hub</strong>
          <span>{themeMeta.label} · {location.host}</span>
        </div>
        <div className="tf-statusbar-center">{themeMeta.telemetry}</div>
        {authenticated && (
          <div className="tf-statusbar-right">
            <button type="button" onClick={() => navigate('overview')}>总览</button>
            <button type="button" onClick={() => navigate('projects')}>项目</button>
            <button type="button" onClick={() => navigate('tasks')}>任务</button>
            <button type="button" onClick={() => navigate('reviews')}>评审</button>
            <button type="button" onClick={() => navigate('local')}>本地 AI</button>
          </div>
        )}
      </footer>

      {authenticated && !desktop && (
        <Drawer
          className="tf-shell-drawer"
          title="工作空间"
          placement="left"
          size={280}
          open={navigationOpen}
          onClose={() => setNavigationOpen(false)}
          destroyOnHidden
          footer={demoEntry}
          styles={{ body: { padding: '8px' } }}
        >
          {navigation}
        </Drawer>
      )}
    </Layout>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Card, Drawer, Flex, Form, Grid, Input, Segmented, Select, Space, Steps, Tag, Typography } from 'antd';
import { Activity, ArrowLeft, ArrowRight, Check, Copy, Cpu, ExternalLink, FolderGit2, FolderOpen, LayoutDashboard, MousePointer2, RefreshCw, ShieldCheck, Terminal, Trash2, Zap } from 'lucide-react';
import { api, ApiError, HostBridgeStatus, hubApiUrl, LocalAutomationCapabilities, LocalGitRepo, openWorkbench, Project, ProjectWorkspace, timeText, User } from './workspaceApi';
import { LocalDeviceList, LocalDevicePairing } from './LocalDevicePairing';
import { LocalBridgeQuickConnect } from './LocalBridgeQuickConnect';
import { TeamAgentsCard } from './TeamAgents';
import { bridgeInstallCommand } from './bridgeInstall';
import { CustomClientAdapters } from './CustomClientAdapters';
import type { ClientAdapterManifest } from '../../../shared/local-client-adapter.mjs';
import { navigateWorkspace } from './workspaceNavigation';
import { localBridgePortFromHash, suggestedLocalProjects, suggestRepoPathForProject, withoutLocalBridgePort } from './localBridgeHandoff';
import { LOCAL_TASK_TARGETS, LocalTaskTarget, validRepoPath } from './localTaskWorkflowPrompt';
import { formatLocalDoctorMarkdown, type LocalDoctorResult } from './localDoctorReport';
import { readTogether } from './readTogether';
import { StatusBadge } from '../components/Primitives';
import { mcpToolLabel } from './displayLabels';
import './LocalIntegrationView.css';

const CLIENTS = [
  { key: 'codex', name: 'Codex CLI', tool: 'codex-cli', file: '.codex/config.toml', node: '[mcp_servers.taskflow]', description: '在终端读取任务、获取冻结上下文并按权限回传进度与报告。', icon: Terminal },
  { key: 'claude', name: 'Claude Code', tool: 'claude-code', file: '.mcp.json', node: 'mcpServers.taskflow', description: '在本地开发会话中直连项目任务、材料版本与评审快照。', icon: Cpu },
  { key: 'cursor', name: 'Cursor', tool: 'cursor', file: '.cursor/mcp.json', node: 'mcpServers.taskflow', description: '在 IDE 对话中直接调用任务检索、认领与评审工具链。', icon: MousePointer2 },
];
const READ_TOOLS = ['task_list', 'context', 'assets', 'reviews', 'review_context', 'knowledge_search', 'knowledge_doc'];
const WRITE_TOOLS = ['task_claim', 'progress_report', 'heartbeat', 'report_submit'];
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const absoluteProjectPath = (value: string) => value.startsWith('/') && !/[\r\n\x00]/.test(value);

export const LocalIntegrationView: React.FC<{ user: User; onUnauthorized?: () => void }> = ({ user, onUnauthorized }) => {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [pathForm] = Form.useForm<{ projectPath: string; adapterPath: string }>();
  const [bridgeForm] = Form.useForm<{ deviceName: string; projectIds: string[] }>();
  const [workspaceForm] = Form.useForm<{ projectId: string; repoPath: string; defaultTarget: LocalTaskTarget }>();
  const [client, setClient] = useState('codex');
  const [customAdapter, setCustomAdapter] = useState<ClientAdapterManifest | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [projectPath, setProjectPath] = useState('');
  const [adapterPath, setAdapterPath] = useState('');
  const [copied, setCopied] = useState('');
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const [handoffPort, setHandoffPort] = useState<number>();
  const [hostBridge, setHostBridge] = useState<HostBridgeStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>([]);
  const [repositoryScan, setRepositoryScan] = useState<{ projectId?: string; items: LocalGitRepo[] }>({ items: [] });
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [loadingBridge, setLoadingBridge] = useState(true);
  const [priorBridgeIds, setPriorBridgeIds] = useState<string[] | null>(null);
  const [authorizingBridge, setAuthorizingBridge] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [rescanningRepos, setRescanningRepos] = useState(false);
  const [doctorResult, setDoctorResult] = useState<LocalDoctorResult | null>(null);
  const [runningDoctor, setRunningDoctor] = useState(false);
  const selectedBridgeProjects = Form.useWatch('projectIds', bridgeForm);
  const workspaceProjectId = Form.useWatch('projectId', workspaceForm);
  const serverMode = capabilities?.deployment === 'server';
  const waitingForBridge = priorBridgeIds !== null;
  const requestedBridgeProject = new URLSearchParams(location.hash.slice(1)).get('bridgeProject') || undefined;
  const repositories = !serverMode || repositoryScan.projectId === workspaceProjectId ? repositoryScan.items : [];
  const seenHandoff = useRef('');
  const copySequence = useRef(0);
  const bridgeSequence = useRef(0);
  const bridgeScopeInitialized = useRef(false);
  const alive = useRef(true);
  const activeClient = customAdapter ? { key: 'custom', name: customAdapter.name, tool: 'custom', file: customAdapter.configPath, node: `${customAdapter.serversKey}.taskflow` } : CLIENTS.find(item => item.key === client) || CLIENTS[0];
  const clearCopy = () => { copySequence.current += 1; setCopied(''); };
  const clearPaths = () => { clearCopy(); if (guideOpen && step === 2) pathForm.resetFields(); setProjectPath(''); setAdapterPath(''); };

  const loadHostState = async (resetSelection = false) => {
    const seq = ++bridgeSequence.current;
    setLoadingBridge(true);
    try {
      const [bridgeData, projectData, workspaceData] = await readTogether([
        api<HostBridgeStatus>('local-devices/host-bridge'),
        api<{ projects: Project[] }>('projects'),
        api<{ workspaces: ProjectWorkspace[] }>('project-workspaces'),
      ]);
      if (!alive.current || seq !== bridgeSequence.current) return;
      setHostBridge(bridgeData);
      setProjects(projectData.projects);
      setWorkspaces(workspaceData.workspaces);
      void api<LocalAutomationCapabilities>('local-automation/capabilities').then(async capability => {
        if (!alive.current || seq !== bridgeSequence.current) return;
        setCapabilities(capability);
        if (capability.deployment !== 'server') {
          const { repositories: scanned } = await api<{ repositories: LocalGitRepo[] }>('local-git/repositories');
          if (!alive.current || seq !== bridgeSequence.current) return;
          setRepositoryScan({ items: scanned });
          const curProjId = workspaceForm.getFieldValue('projectId');
          const curRepoPath = workspaceForm.getFieldValue('repoPath');
          if (curProjId && !curRepoPath) {
            const existing = workspaceData.workspaces.find(item => item.projectId === curProjId);
            if (!existing) {
              const guessed = suggestRepoPathForProject(projectData.projects.find(p => p.id === curProjId), scanned);
              if (guessed) workspaceForm.setFieldValue('repoPath', guessed);
            }
          }
        }
      }).catch(() => {});
      if (resetSelection || !bridgeScopeInitialized.current) {
        bridgeScopeInitialized.current = true;
        bridgeForm.setFieldsValue({
          deviceName: bridgeData.device?.deviceName || '工作台与本地 AI',
          projectIds: suggestedLocalProjects(bridgeData.suggestedProjectIds || [], projectData.projects),
        });
      }
      if (!workspaceForm.getFieldValue('projectId') && projectData.projects.length) {
        const first = projectData.projects[0].id;
        const existing = workspaceData.workspaces.find(item => item.projectId === first);
        workspaceForm.setFieldsValue({
          projectId: first,
          repoPath: existing?.repoPath || '',
          defaultTarget: (existing?.defaultTarget as LocalTaskTarget) || 'workbench',
        });
      }
    } catch (error) {
      if (!alive.current || seq !== bridgeSequence.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else void message.error(error instanceof Error ? error.message : '加载本机接入状态失败。');
    } finally {
      if (alive.current && seq === bridgeSequence.current) setLoadingBridge(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; copySequence.current += 1; bridgeSequence.current += 1; };
  }, []);

  useEffect(() => {
    bridgeScopeInitialized.current = false;
    setGuideOpen(false); clearCopy(); setProjectPath(''); setAdapterPath(''); setClient('codex'); setCustomAdapter(null); setStep(0); setHandoffPort(undefined); seenHandoff.current = '';
    setDoctorResult(null);
    bridgeForm.resetFields(); workspaceForm.resetFields();
    void loadHostState(true);
  }, [user.id]);

  const runOnlineDoctor = async () => {
    if (runningDoctor) return;
    setRunningDoctor(true);
    try {
      const res = await api<LocalDoctorResult>('local-automation/doctor');
      if (!alive.current) return;
      setDoctorResult(res);
      void message.success(`全链路体检完成：健康度评分 ${res.score}/100（耗时 ${res.durationMs}ms）。`);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else void message.error(error instanceof Error ? error.message : '运行本机在线体检失败。');
    } finally {
      if (alive.current) setRunningDoctor(false);
    }
  };

  useEffect(() => {
    if (deviceRefresh > 0) void loadHostState(false);
  }, [deviceRefresh]);

  useEffect(() => {
    if (!priorBridgeIds) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const check = async () => {
      try {
        const next = await api<LocalAutomationCapabilities>('local-automation/capabilities');
        if (cancelled) return;
        setCapabilities(next);
        if (next.devices?.some(device => device.online && !priorBridgeIds.includes(device.id))) {
          setPriorBridgeIds(null);
          setDeviceRefresh(value => value + 1);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setPriorBridgeIds(null);
          onUnauthorized?.();
          return;
        }
      }
      if (++attempts >= 20) {
        setPriorBridgeIds(null);
        void message.warning('新绑定尚未上线，请查看本机终端的配对结果。');
      } else timer = setTimeout(() => void check(), 2500);
    };
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [priorBridgeIds, user.id]);

  const authorizeHostBridge = async (values: { deviceName: string; projectIds: string[] }, replaceBindingRevision?: string) => {
    setAuthorizingBridge(true);
    try {
      const result = await api<{ replaced?: boolean }>('local-devices/host-bridge', {
        deviceName: (values.deviceName || '工作台与本地 AI').trim(),
        tool: 'custom',
        projectIds: values.projectIds,
        ...(replaceBindingRevision ? { replaceBindingRevision } : {}),
      });
      if (!alive.current) return;
      void message.success(result.replaced ? '已切换本机工作台绑定。' : '本机 AI 已接通。');
      setDeviceRefresh(value => value + 1);
      await loadHostState(true);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else {
        void message.error(error instanceof Error ? error.message : '一键授权失败。');
        if (error instanceof ApiError && error.status === 409) await loadHostState(false);
      }
    } finally {
      if (alive.current) setAuthorizingBridge(false);
    }
  };

  const pairHostBridge = (values: { deviceName: string; projectIds: string[] }) => {
    const revision = hostBridge?.bindingRevision;
    if (!revision || (!hostBridge?.connected && hostBridge.status !== 'OTHER_USER')) {
      void authorizeHostBridge(values);
      return;
    }
    modal.confirm({
      title: '切换本机工作台绑定',
      content: `这台电脑已有绑定。确认后，工作台将连接当前账号 ${user.username} 和所选项目，旧设备授权随之解除。`,
      okText: '确认切换',
      cancelText: '保留原绑定',
      onOk: () => authorizeHostBridge(values, revision),
    });
  };

  const saveProjectWorkspace = async (values: { projectId: string; repoPath: string; defaultTarget: LocalTaskTarget }) => {
    setSavingWorkspace(true);
    try {
      await api(`projects/${encodeURIComponent(values.projectId)}/workspace`, {
        repoPath: values.repoPath.trim(),
        defaultTarget: values.defaultTarget,
      }, 'PUT');
      if (!alive.current) return;
      void message.success('已保存项目本地代码目录绑定。');
      await loadHostState(false);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else void message.error(error instanceof Error ? error.message : '保存目录绑定失败。');
    } finally {
      if (alive.current) setSavingWorkspace(false);
    }
  };

  const rescanRepositories = async () => {
    const projectId = serverMode ? workspaceForm.getFieldValue('projectId') : undefined;
    if (rescanningRepos || (serverMode && !projectId)) return;
    const params = new URLSearchParams({ refresh: '1' });
    if (projectId) params.set('projectId', projectId);
    const isCurrent = () => alive.current && (!projectId || workspaceForm.getFieldValue('projectId') === projectId);
    setRescanningRepos(true);
    try {
      const { repositories: scanned, tccProtected } = await api<{ repositories: LocalGitRepo[]; tccProtected?: boolean }>('local-git/repositories?' + params);
      if (!isCurrent()) return;
      setRepositoryScan({ projectId, items: scanned });
      const curProjId = workspaceForm.getFieldValue('projectId');
      const curRepoPath = workspaceForm.getFieldValue('repoPath');
      if (curProjId && !curRepoPath && !workspaces.some(item => item.projectId === curProjId)) {
        const guessed = suggestRepoPathForProject(projects.find(p => p.id === curProjId), scanned);
        if (guessed) workspaceForm.setFieldValue('repoPath', guessed);
      }
      if (scanned.length) void message.success(`发现 ${scanned.length} 个 Git 仓库。`);
      else void message.info(tccProtected ? '部分目录无法访问，可手动填写仓库路径。' : '已扫描的目录中没有 Git 仓库，可手动填写路径。');
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else void message.error(error instanceof Error ? error.message : '扫描本机 Git 仓库失败。');
    } finally {
      if (alive.current) setRescanningRepos(false);
    }
  };

  const removeProjectWorkspace = async (projectId: string) => {
    setSavingWorkspace(true);
    try {
      await api(`projects/${encodeURIComponent(projectId)}/workspace`, undefined, 'DELETE');
      if (!alive.current) return;
      void message.success('已解除该项目的目录绑定。');
      await loadHostState(false);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else void message.error(error instanceof Error ? error.message : '解除目录绑定失败。');
    } finally {
      if (alive.current) setSavingWorkspace(false);
    }
  };

  const clearHandoffRoute = (port: number) => {
    const next = withoutLocalBridgePort(location.hash, port);
    if (next !== location.hash) history.replaceState(history.state, '', location.pathname + location.search + next);
  };
  useEffect(() => {
    const update = () => {
      try {
        const port = localBridgePortFromHash(location.hash);
        if (port === undefined || seenHandoff.current === user.id + ':' + port) return;
        seenHandoff.current = user.id + ':' + port;
        clearPaths(); setClient('codex'); setCustomAdapter(null); setStep(1); setCopied(''); setHandoffPort(port); setGuideOpen(true);
      } catch (error) {
        const next = withoutLocalBridgePort(location.hash);
        history.replaceState(history.state, '', location.pathname + location.search + next);
        void message.error(error instanceof Error ? error.message : '本地接入申请无效。');
      }
    };
    update(); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [user.id]);
  const startGuide = (key: string, initialStep = 0) => {
    setHandoffPort(undefined); setClient(key); setCustomAdapter(null); setStep(initialStep); setCopied(''); clearPaths(); setGuideOpen(true);
  };
  const startCustomGuide = (adapter: ClientAdapterManifest) => { setHandoffPort(undefined); clearPaths(); setCustomAdapter(adapter); setClient('custom'); setStep(0); setCopied(''); setGuideOpen(true); };
  const changeStep = (next: number) => { if (step === 2 && next !== 2) clearPaths(); setStep(next); clearCopy(); };
  const closeGuide = () => { if (handoffPort !== undefined) clearHandoffRoute(handoffPort); seenHandoff.current = ''; setHandoffPort(undefined); clearPaths(); setCopied(''); setGuideOpen(false); };
  const selectClient = (key: string) => { clearPaths(); setClient(key); setCustomAdapter(null); setStep(0); setCopied(''); };
  const pairCommand = `node local-bridge/rd.mjs ${serverMode ? 'pair' : 'connect'} --url ${hubApiUrl()} --web-url ${location.origin} --name ${shellQuote(customAdapter?.name || '我的开发电脑')} --tool ${activeClient.tool}`;
  const backupLogin = `node local-bridge/rd.mjs login --url ${hubApiUrl()} --username ${shellQuote(user.username)}`;
  const pathsReady = absoluteProjectPath(projectPath) && (!customAdapter || (absoluteProjectPath(adapterPath) && /\.json$/i.test(adapterPath)));
  const adapterOption = customAdapter ? `--adapter ${shellQuote(adapterPath)}` : `--client ${activeClient.key}`;
  const installCommand = pathsReady ? `node local-bridge/rd.mjs install-mcp ${adapterOption} --project ${shellQuote(projectPath)}` : '';
  const doctorCommand = pathsReady ? `node local-bridge/rd.mjs doctor ${customAdapter ? `--adapter ${shellQuote(adapterPath)} ` : ''}--project ${shellQuote(projectPath)}` : '';
  const copy = async (key: string, value: string, label = '命令') => {
    const sequence = ++copySequence.current;
    try { await navigator.clipboard.writeText(value); if (sequence !== copySequence.current) return; setCopied(key); void message.success(`${label}已复制。`); }
    catch { if (sequence !== copySequence.current) return; setCopied(''); void message.warning(`复制未完成，请手动选择${label}文本。`); }
  };
  const commandBlock = (key: string, command: string, label: string) => <div className="tf-local-command">
    <pre><code>{command}</code></pre><Button size="small" icon={copied === key ? <Check size={14} /> : <Copy size={14} />} aria-label={`复制${label}命令`} onClick={() => void copy(key, command)}>{copied === key ? '已复制' : '复制'}</Button>
  </div>;

  const bridgeConnected = hostBridge?.supported !== false && hostBridge?.connected === true;
  const bridgeOccupied = hostBridge?.status === 'OTHER_USER';
  const bridgeStatusBadge = bridgeConnected
    ? <StatusBadge variant="green" pulse>已接通 · 有效期至 {timeText(hostBridge?.device?.expiresAt)}</StatusBadge>
    : bridgeOccupied
      ? <StatusBadge variant="warn">已绑定其他账号</StatusBadge>
      : hostBridge?.status === 'EXPIRED' || hostBridge?.status === 'REVOKED'
        ? <StatusBadge variant="warn">授权已过期 · 待续期</StatusBadge>
        : <StatusBadge variant="neutral">{loadingBridge ? '正在读取授权状态' : '待授权'}</StatusBadge>;

  const authorizedCount = hostBridge?.device?.projectIds?.length || 0;
  const Settings = serverMode ? 'details' : 'div';

  return <div className="tf-local-integration">
    {!serverMode && !!capabilities?.engines.length && (
      <Card size="small" title={<Space size={8}><Cpu size={16} />本机 CLI 与默认模型</Space>}>
        <div className="tf-engine-pill-grid">
          {capabilities.engines.map(engine => (
            <div key={engine.id} className={`tf-engine-pill${engine.available ? ' is-ready' : ' is-missing'}`}>
              <i aria-hidden="true" />
              <strong title={engine.label}>{engine.label}</strong>
              <small>{engine.available ? '就绪' : '未检测到'}</small>
              <code title={engine.defaultModel || undefined}>
                {engine.defaultModel || (engine.available ? '使用 CLI 默认模型' : '—')}
              </code>
            </div>
          ))}
        </div>
      </Card>
    )}
    {serverMode && <LocalBridgeQuickConnect
      key={user.id}
      devices={capabilities.devices || []}
      projects={projects}
      requestedProjectId={projects.some(project => project.id === requestedBridgeProject) ? requestedBridgeProject : undefined}
      loading={loadingBridge}
      waitingForBridge={waitingForBridge}
      onUnauthorized={onUnauthorized}
      onConnected={() => {
        if (!alive.current) return;
        setDeviceRefresh(value => value + 1);
        void message.success('本机 AI 已连接。');
      }}
    />}
    <Settings className={serverMode ? 'tf-local-advanced' : undefined} style={serverMode ? undefined : { display: 'contents' }}>
    {serverMode && <summary>高级设置</summary>}
    <div className="tf-local-integration" style={serverMode ? undefined : { display: 'contents' }}>
    {serverMode && (
      <Card
        className="tf-local-bridge-card"
        title={<div className="tf-local-card-title-row">
          <span>Bridge 设备</span>
          {capabilities?.devices?.some(device => device.online)
            ? <StatusBadge variant="green" pulse>在线 {capabilities.devices.filter(device => device.online).length} 台</StatusBadge>
            : <StatusBadge variant="blue">未在线</StatusBadge>}
        </div>}
        extra={<Space size={8} wrap>
          <Button size="small" icon={<LayoutDashboard size={14} />} onClick={() => openWorkbench()}>打开工作台</Button>
          <Button size="small" icon={<RefreshCw size={13} />} loading={loadingBridge} onClick={() => void loadHostState(false)}>刷新状态</Button>
        </Space>}
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">开发任务由已配对设备执行，启动时需在本机确认。</Typography.Text>
          {(capabilities?.devices || []).map(device => (
            <Flex key={device.id} justify="space-between" align="center" gap={8} wrap>
              <Space size={[8, 6]} wrap><Typography.Text strong>{device.deviceName}</Typography.Text><Tag>{device.tool}</Tag><Tag>{device.projectIds.length} 个项目</Tag></Space>
              <Typography.Text type={device.online ? 'success' : 'secondary'}>{device.online ? '在线' : device.lastSeenAt ? `最近在线 ${timeText(device.lastSeenAt)}` : '已配对，未启动 worker'} · 有效期至 {timeText(device.expiresAt)}</Typography.Text>
            </Flex>
          ))}
          <Typography.Text>在本机终端安装 Bridge（Node.js 24+），然后用上方「设备授权」核对设备和可访问项目。</Typography.Text>
          {commandBlock('bridge-install', bridgeInstallCommand(location.origin), '一键安装')}
          <Typography.Text>需接收开发任务时，在 ~/.taskflow/state/worker.json 中设置仓库路径和 allowDevelop，再重启 Bridge。</Typography.Text>
          {commandBlock('bridge-service', '~/.taskflow/bin/taskflow-bridge service --action restart', '重启 Bridge')}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>只装 Bridge 不装工作台：在命令前加 TASKFLOW_SKIP_WORKBENCH=1。查看状态用 service --action status 或 workbench --action status；立即检查更新用 update；关闭自动更新在 worker.json 加 "autoUpdate": false。在「我的设备」中开启「允许团队派发」后，项目负责人也能把任务派到这台电脑。</Typography.Text>
        </Flex>
      </Card>
    )}
    {hostBridge?.supported !== false && !serverMode && (
      <Card
        className="tf-local-bridge-card"
        title={
          <div className="tf-local-card-title-row">
            <span className="tf-card-icon-badge"><Zap size={16} /></span>
            <span>本机 Bridge 授权</span>
            {bridgeStatusBadge}
          </div>
        }
        extra={<Button size="small" icon={<RefreshCw size={13} />} loading={loadingBridge} onClick={() => void loadHostState(false)}>刷新状态</Button>}
      >
        <Flex vertical gap={16}>
          {bridgeConnected && <Typography.Text type="secondary">{hostBridge?.device?.deviceName} · 已授权 {authorizedCount} 个项目</Typography.Text>}
          {bridgeOccupied && <Typography.Text type="secondary">检测到本机工作台已有绑定。可以将这台电脑切换到当前登录账号。</Typography.Text>}

          <Form
            form={bridgeForm}
            layout="vertical"
            labelWrap
            className="tf-local-bridge-form"
            disabled={authorizingBridge || loadingBridge}
            initialValues={{ deviceName: '工作台与本地 AI', projectIds: [] }}
            onFinish={pairHostBridge}
          >
            <div className="tf-local-bridge-fields">
              <Form.Item name="deviceName" label="本机设备标识" rules={[{ required: true, max: 80, message: '请输入设备名称' }]}>
                <Input placeholder="工作台与本地 AI" autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="projectIds"
                label={
                  <Flex justify="space-between" align="center" gap={8} wrap style={{ width: '100%' }}>
                    <span>允许本机 AI 访问的项目</span>
                    {projects.length > 0 && (
                      <Space size={6} wrap>
                        <Button
                          type="link"
                          size="small"
                          style={{ padding: 0, height: 'auto' }}
                          disabled={authorizingBridge || loadingBridge || (selectedBridgeProjects?.length || 0) === projects.length}
                          onClick={() => bridgeForm.setFieldValue('projectIds', projects.map(project => project.id))}
                        >
                          全选全部 ({projects.length})
                        </Button>
                        {!!selectedBridgeProjects?.length && (
                          <Button
                            type="link"
                            size="small"
                            style={{ padding: 0, height: 'auto' }}
                            disabled={authorizingBridge || loadingBridge}
                            onClick={() => bridgeForm.setFieldValue('projectIds', [])}
                          >
                            清空
                          </Button>
                        )}
                      </Space>
                    )}
                  </Flex>
                }
                rules={[{ type: 'array', required: true, min: 1, message: '请至少选择一个允许访问的项目' }]}
              >
                <Select
                  mode="multiple"
                  maxTagCount="responsive"
                  placeholder="选择允许访问的项目"
                  loading={loadingBridge}
                  showSearch={{ optionFilterProp: 'label' }}
                  options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))}
                />
              </Form.Item>
            </div>
            <Space wrap size={8} className="tf-local-bridge-actions">
              <Button type="primary" htmlType="submit" icon={<ShieldCheck size={15} />} loading={authorizingBridge} disabled={!projects.length}>
                {bridgeConnected || bridgeOccupied ? '切换绑定' : '一键配对'}
              </Button>
              <Button onClick={() => navigateWorkspace('tasks')}>前往任务中心</Button>
              <Button onClick={() => openWorkbench()} icon={<ExternalLink size={13} />}>打开工作台</Button>
            </Space>
          </Form>

          {bridgeConnected && (
            <div className="tf-local-doctor-strip">
              <Typography.Text type="secondary">终端快速自检（验证 MCP 握手与真实任务读取）</Typography.Text>
              {commandBlock('quick-doctor', 'taskflow-hub doctor', '本机自检')}
            </div>
          )}
        </Flex>
      </Card>
    )}

    <LocalDeviceList key={user.id} onUnauthorized={onUnauthorized} refreshKey={deviceRefresh} teamDispatch={serverMode} onAuthorize={() => { setHandoffPort(undefined); setStep(1); setCopied(''); clearPaths(); setGuideOpen(true); }} />
    <Card
      className="tf-local-doctor-card"
      title={
        <div className="tf-local-card-title-row">
          <span className="tf-card-icon-badge"><Activity size={16} /></span>
          <span>本机诊断</span>
          {doctorResult && (
            <StatusBadge
              variant={doctorResult.overall === 'HEALTHY' ? 'green' : 'warn'}
            >
              评分 {doctorResult.score} / 100 · {doctorResult.durationMs}ms
            </StatusBadge>
          )}
        </div>
      }
      extra={
        <Space size={8} wrap>
          {doctorResult && (
            <Button
              size="small"
              icon={copied === 'doctor-report' ? <Check size={13} /> : <Copy size={13} />}
              onClick={() => void copy('doctor-report', formatLocalDoctorMarkdown(doctorResult))}
            >
              {copied === 'doctor-report' ? '已复制诊断报告' : '复制脱敏诊断报告'}
            </Button>
          )}
          <Button
            size="small"
            type="primary"
            ghost={!doctorResult}
            icon={<Activity size={13} />}
            loading={runningDoctor}
            onClick={() => void runOnlineDoctor()}
          >
            {doctorResult ? '重新诊断' : '运行诊断'}
          </Button>
        </Space>
      }
    >
      {!doctorResult ? (
        <Typography.Text type="secondary">
          检查本机工具、设备会话、仓库配置与文件权限。
        </Typography.Text>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: screens.md ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
            gap: 10,
          }}
        >
          {doctorResult.checks.map(chk => (
            <div
              key={chk.id}
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid var(--tf-border)',
                background: 'var(--tf-raised)',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <Flex justify="space-between" align="center" gap={8}>
                <Space size={6} wrap>
                  <Tag
                    color={chk.status === 'PASS' ? 'success' : chk.status === 'WARN' ? 'warning' : 'error'}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {chk.status}
                  </Tag>
                  <Typography.Text strong style={{ fontSize: 13 }}>{chk.label}</Typography.Text>
                </Space>
                {typeof chk.latencyMs === 'number' && (
                  <Typography.Text type="secondary" style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
                    {chk.latencyMs}ms
                  </Typography.Text>
                )}
              </Flex>
              <Typography.Text style={{ fontSize: 12.5 }}>{chk.summary}</Typography.Text>
              {chk.remediation && (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  建议：{chk.remediation}
                </Typography.Text>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>

    <Card
      className="tf-local-workspace-card"
      title={
        <div className="tf-local-card-title-row">
          <span className="tf-card-icon-badge"><FolderGit2 size={16} /></span>
          <span>项目仓库绑定</span>
        </div>
      }
      extra={
        <Space size={6} wrap>
          {repositories.length > 0 && <Tag className="tf-local-protocol">已发现 {repositories.length} 个本地库</Tag>}
          <Tag className="tf-local-protocol">已绑定 {workspaces.length} 项</Tag>
          <Button size="small" icon={<RefreshCw size={13} />} disabled={!capabilities || loadingBridge || (serverMode && !workspaceProjectId)} loading={rescanningRepos} onClick={() => void rescanRepositories()}>{serverMode ? '扫描设备仓库' : '重新扫描'}</Button>
        </Space>
      }
    >
      <Flex vertical gap={16}>
        {serverMode && <Typography.Text type="secondary">可扫描已授权当前项目的本机 Bridge，也可手动填写仓库路径。网页绑定用于本地协作，Bridge 自动开发使用设备上的仓库映射。</Typography.Text>}
        {repositories.length > 0 && (
          <div className="tf-repo-quick-picker">
            <Typography.Text className="tf-field-caption">从本机已扫描的 Git 仓库快速填入路径</Typography.Text>
            <Select
              style={{ width: '100%' }}
              showSearch={{ optionFilterProp: 'label' }}
              placeholder="搜索并选择本机业务 Git 仓库，自动填入下方路径"
              options={repositories.map(repo => ({
                value: repo.path,
                label: `${repo.name}${repo.group ? ` (${repo.group})` : ''} · ${repo.path}`,
              }))}
              onChange={value => workspaceForm.setFieldValue('repoPath', value)}
            />
          </div>
        )}
        <Form
          form={workspaceForm}
          layout="vertical"
          className="tf-workspace-bind-form"
          disabled={savingWorkspace || loadingBridge || !projects.length}
          initialValues={{ projectId: undefined, repoPath: '', defaultTarget: 'workbench' }}
          onValuesChange={changed => {
            if ('projectId' in changed && changed.projectId) {
              const existing = workspaces.find(item => item.projectId === changed.projectId);
              const guessed = existing?.repoPath || (serverMode ? '' : suggestRepoPathForProject(projects.find(p => p.id === changed.projectId), repositories));
              workspaceForm.setFieldsValue({
                repoPath: guessed,
                defaultTarget: (existing?.defaultTarget as LocalTaskTarget) || 'workbench',
              });
            }
          }}
          onFinish={values => void saveProjectWorkspace(values)}
        >
          <div className="tf-workspace-bind-grid">
            <Form.Item name="projectId" label="平台项目" rules={[{ required: true, message: '请选择项目' }]}>
              <Select
                placeholder="选择项目"
                showSearch={{ optionFilterProp: 'label' }}
                options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))}
              />
            </Form.Item>
            <Form.Item name="repoPath" label="本机业务仓库绝对路径" required rules={[{
              validator: (_, value) => {
                const path = typeof value === 'string' ? value.trim() : '';
                if (validRepoPath(path)) return Promise.resolve();
                return Promise.reject(new Error(path ? '请输入有效的本机仓库绝对路径。' : '请输入本机仓库的绝对路径。'));
              },
            }]}>
              <Input placeholder="/Users/you/workspace/service-repo" autoComplete="off" />
            </Form.Item>
            <Form.Item name="defaultTarget" label="默认本地工具">
              <Select options={LOCAL_TASK_TARGETS} />
            </Form.Item>
            <div className="tf-workspace-bind-submit">
              <Button type="primary" htmlType="submit" loading={savingWorkspace}>保存项目目录绑定</Button>
            </div>
          </div>
        </Form>

        {workspaces.length > 0 && (
          <div className="tf-bound-workspaces">
            <div className="tf-bound-workspaces-head">
              <Typography.Text strong>已绑定项目目录（{workspaces.length}）</Typography.Text>
              <Typography.Text type="secondary">仅对当前登录成员在本机生效</Typography.Text>
            </div>
            <div className="tf-bound-workspaces-list">
              {workspaces.map(item => {
                const proj = projects.find(p => p.id === item.projectId);
                const targetLabel = LOCAL_TASK_TARGETS.find(t => t.value === item.defaultTarget)?.label || item.defaultTarget;
                return (
                  <div key={item.projectId} className="tf-bound-workspace-row">
                    <div className="tf-bound-workspace-meta">
                      <StatusBadge variant="blue">{proj ? `${proj.key} · ${proj.name}` : item.projectId}</StatusBadge>
                      <code className="tf-bound-repo-path" title={item.repoPath}>{item.repoPath}</code>
                      <span className="tf-bound-target-pill">{targetLabel}</span>
                    </div>
                    <Space size={8} wrap className="tf-bound-workspace-actions">
                      {capabilities && !serverMode ? <>
                        <Button size="small" type="text" icon={<FolderOpen size={13} />} onClick={() => void api('local-git/open', { projectId: item.projectId, app: 'finder', repoPath: item.repoPath }).then(() => message.success('已在 Finder 中打开文件夹。')).catch(err => message.error(err instanceof Error ? err.message : '打开失败。'))}>Finder</Button>
                        <Button size="small" type="text" onClick={() => void api('local-git/open', { projectId: item.projectId, app: 'cursor', repoPath: item.repoPath }).then(() => message.success('已在 Cursor 中打开。')).catch(err => message.error(err instanceof Error ? err.message : '打开失败。'))}>Cursor</Button>
                        <Button size="small" type="text" icon={<Terminal size={13} />} onClick={() => void api('local-git/open', { projectId: item.projectId, app: 'terminal', repoPath: item.repoPath }).then(() => message.success('已在终端中打开仓库目录。')).catch(err => message.error(err instanceof Error ? err.message : '打开失败。'))}>终端</Button>
                      </> : <Button size="small" type="text" icon={<Copy size={13} />} onClick={() => void copy(`repo-${item.projectId}`, item.repoPath, '仓库路径')}>复制路径</Button>}
                      <Button size="small" type="text" onClick={() => workspaceForm.setFieldsValue({ projectId: item.projectId, repoPath: item.repoPath, defaultTarget: (item.defaultTarget as LocalTaskTarget) || 'workbench' })}>编辑</Button>
                      <Button size="small" type="text" danger icon={<Trash2 size={13} />} onClick={() => void removeProjectWorkspace(item.projectId)}>解除</Button>
                    </Space>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Flex>
    </Card>

    <section aria-labelledby="local-clients-heading" className="tf-local-clients-section">
      <div className="tf-local-section-heading">
        <div>
          <Typography.Title id="local-clients-heading" level={2}>按项目安装独立 CLI / IDE 配置</Typography.Title>
          <Typography.Text type="secondary">在指定代码目录配置 MCP。</Typography.Text>
        </div>
      </div>
      <div className="tf-local-client-grid">
        {CLIENTS.map(item => (
          <Card key={item.key} className="tf-local-client-card">
            <div className="tf-local-client-top">
              <div className="tf-local-client-identity">
                <span className="tf-local-client-icon"><item.icon size={19} strokeWidth={1.85} /></span>
                <div>
                  <Typography.Title level={3}>{item.name}</Typography.Title>
                </div>
              </div>
              <code className="tf-client-config-chip">{item.file}</code>
            </div>
            <Typography.Paragraph type="secondary" className="tf-local-client-description">{item.description}</Typography.Paragraph>
            <Button className="tf-local-client-action" icon={<ArrowRight size={14} />} iconPlacement="end" onClick={() => startGuide(item.key)}>配置项目</Button>
          </Card>
        ))}
      </div>
    </section>

    <CustomClientAdapters userId={user.id} onConnect={startCustomGuide} />

    {serverMode && <TeamAgentsCard key={`team-${user.id}`} projects={projects} onUnauthorized={onUnauthorized} />}

    <Card size="small" title="设备访问权限">
      <div className="tf-local-capabilities">
        <div className="tf-capability-group">
          <Typography.Text strong>读取</Typography.Text>
          <Typography.Text type="secondary">{READ_TOOLS.map(mcpToolLabel).join('、')}</Typography.Text>
        </div>
        <div className="tf-capability-group">
          <Typography.Text strong>回传</Typography.Text>
          <Typography.Text type="secondary">{WRITE_TOOLS.map(mcpToolLabel).join('、')}</Typography.Text>
        </div>
      </div>
      <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0' }}>设备只能访问已授权项目。审批、发布及项目配置仍由平台成员操作。可在「我的设备」撤销授权。</Typography.Paragraph>
    </Card>
    </div>
    </Settings>

    <Drawer
      title={handoffPort !== undefined ? '确认本地设备接入' : '接入本地编程工具'}
      open={guideOpen}
      onClose={closeGuide}
      size={660}
      destroyOnHidden
      className="tf-local-setup-drawer"
      footer={
        <Flex justify="space-between" gap={12}>
          {handoffPort !== undefined ? (
            <Button onClick={closeGuide}>关闭</Button>
          ) : (
            <>
              <Button icon={step ? <ArrowLeft size={14} /> : undefined} onClick={() => step ? changeStep(step - 1) : closeGuide()}>{step ? '上一步' : '取消'}</Button>
              {step < 2 ? (
                <Button type={step === 0 ? 'primary' : 'default'} icon={<ArrowRight size={14} />} iconPlacement="end" onClick={() => changeStep(step + 1)}>
                  {step === 0 ? '下一步：核对授权' : '继续：安装配置'}
                </Button>
              ) : (
                <Button type="primary" onClick={closeGuide}>完成</Button>
              )}
            </>
          )}
        </Flex>
      }
    >
      <div className="tf-local-setup">
        {handoffPort === undefined && (customAdapter ? <div className="tf-local-custom-selection"><div><Typography.Text strong>{customAdapter.name}</Typography.Text><Typography.Text type="secondary">自定义 MCP 客户端 · {customAdapter.configPath}</Typography.Text></div><Button size="small" onClick={closeGuide}>更换客户端</Button></div> : <Segmented block aria-label="选择 AI 编程软件" value={client} options={CLIENTS.map(item => ({ label: item.name, value: item.key }))} onChange={value => selectClient(value)} />)}
        {handoffPort === undefined && <Steps size="small" responsive={false} titlePlacement={screens.sm ? 'horizontal' : 'vertical'} current={step} onChange={changeStep} items={[{ title: '准备连接' }, { title: '核对授权' }, { title: '安装配置' }]} />}
        {step === 0 && <div className="tf-local-guide-section">
          <div className="tf-local-guide-lead"><Typography.Title level={3}>连接 {activeClient.name}</Typography.Title><Typography.Paragraph type="secondary">{serverMode ? '在网页发起 AI 评审时，使用页面顶部的「一键配对」。这里用于在指定项目目录安装独立的 MCP 配置。' : '在同一台电脑上使用时，可直接用页面顶部的「一键授权接通本机 AI」。'}</Typography.Paragraph></div>
          {customAdapter && <Alert type="info" showIcon title="自定义客户端需支持标准 MCP stdio 与 JSON 配置" description="请先导出此适配器到本机 JSON 文件，安装时会使用该文件；导入适配器本身不会安装软件或启动 AI。" />}
          <div className="tf-local-guide-card"><Typography.Text strong>1. 准备本地桥接依赖</Typography.Text>{commandBlock('install', 'npm --prefix local-bridge install --include=dev', '准备本地桥接')}</div>
          <div className="tf-local-guide-card"><Typography.Text strong>2. 发起设备配对（备用路径）</Typography.Text><Typography.Text type="secondary">{serverMode ? '在下一步填写终端显示的配对码。' : '命令会自动打开日常 Chrome，在网页核对设备与项目后批准。'}</Typography.Text>{commandBlock('pair', pairCommand, '发起设备授权')}</div>
        </div>}
        {step === 1 && <div className="tf-local-guide-section"><div className="tf-local-guide-lead"><Typography.Title level={3}>核对并授权设备</Typography.Title><Typography.Paragraph type="secondary">{handoffPort !== undefined ? '核对设备和项目范围后，批准接入。' : '输入本机终端显示的配对码。'}</Typography.Paragraph></div><LocalDevicePairing key={user.id + ':' + client + ':' + (handoffPort ?? 'manual')} username={user.username} handoffPort={handoffPort} onHandoffComplete={() => { if (handoffPort !== undefined) clearHandoffRoute(handoffPort); }} onUnauthorized={onUnauthorized} onApproved={status => {
          setDeviceRefresh(value => value + 1);
          if (serverMode && handoffPort !== undefined) {
            if (status === 'APPROVED') setPriorBridgeIds((capabilities?.devices || []).map(device => device.id));
            closeGuide();
          }
        }} /></div>}
        {step === 2 && <div className="tf-local-guide-section">
          <div className="tf-local-guide-lead"><Typography.Title level={3}>安装 {activeClient.name} 配置</Typography.Title><Typography.Paragraph type="secondary">完成本机授权后，可为指定业务代码目录写入项目级 MCP 配置（<code>{activeClient.file}</code>）。</Typography.Paragraph></div>
          <Form form={pathForm} layout="vertical" clearOnDestroy initialValues={{ projectPath: '', adapterPath: '' }} onValuesChange={values => { if ('projectPath' in values) setProjectPath(values.projectPath || ''); if ('adapterPath' in values) setAdapterPath(values.adapterPath || ''); clearCopy(); }}>
            <Form.Item name="projectPath" label="项目绝对目录" htmlFor="local-project-path" rules={[{ required: true, message: '请明确填写本机项目绝对目录。' }, { validator: (_, value) => typeof value === 'string' && absoluteProjectPath(value) ? Promise.resolve() : Promise.reject(new Error('请输入有效的 macOS/Linux 项目绝对目录。')) }]} extra="在本机终端执行。网页只生成命令，不会访问或修改此目录。"><Input id="local-project-path" placeholder="/Users/you/workspace/project" autoComplete="off" /></Form.Item>
            {customAdapter && <Form.Item name="adapterPath" label="适配器 JSON 文件绝对路径" htmlFor="local-adapter-path" rules={[{ required: true, message: '请填写已导出的适配器文件路径。' }, { validator: (_, value) => typeof value === 'string' && absoluteProjectPath(value) && /\.json$/i.test(value) ? Promise.resolve() : Promise.reject(new Error('请输入有效的本机 JSON 文件绝对路径。')) }]} extra="填写刚才导出文件在本机的位置。不要填写客户端的配置文件路径。"><Input id="local-adapter-path" placeholder="/Users/you/Downloads/generic-workbench.json" autoComplete="off" /></Form.Item>}
            <div className="tf-local-guide-card"><Typography.Text strong>安装项目配置</Typography.Text>{installCommand ? <div className="tf-local-command"><pre><code>{installCommand}</code></pre><Button size="small" icon={copied === 'mcp-install' ? <Check size={14} /> : <Copy size={14} />} aria-label="复制 MCP 安装命令" onClick={() => void pathForm.validateFields().then(() => copy('mcp-install', installCommand)).catch(() => {})}>{copied === 'mcp-install' ? '已复制' : '复制'}</Button></div> : <Button disabled icon={<Copy size={14} />}>填写目录后复制安装命令</Button>}</div>
          </Form>
          <div className="tf-local-guide-card"><Typography.Text strong>检查连接状态</Typography.Text>{doctorCommand ? commandBlock('doctor', doctorCommand, '检查本机连接') : <Button disabled icon={<Copy size={14} />}>填写路径后生成检查命令</Button>}<Typography.Text type="secondary">运行后在终端查看诊断结果，再重载 {activeClient.name} 并实际调用 <code>task_list</code>。配置已写入不代表客户端已加载。</Typography.Text></div>
          <div className="tf-local-guide-block">
            <Typography.Text strong>配置详情与备用终端登录</Typography.Text><Typography.Text type="secondary">项目内配置文件：<Typography.Text code>{activeClient.file}</Typography.Text></Typography.Text><Typography.Text type="secondary">合并节点：<Typography.Text code>{activeClient.node}</Typography.Text></Typography.Text>{customAdapter && <Typography.Paragraph type="secondary">当前 Delivery Workspace 的原生自定义插件尚不支持注册 MCP。可直接使用工作台内置的 Codex 或 Gemini / Antigravity 引擎全局 MCP 配置。</Typography.Paragraph>}<Typography.Paragraph type="secondary">已有平台成员可使用备用登录，密码在终端隐藏输入。</Typography.Paragraph>{commandBlock('backup-login', backupLogin, '备用登录')}{customAdapter ? absoluteProjectPath(adapterPath) && commandBlock('export-mcp', `node local-bridge/rd.mjs export-mcp --adapter ${shellQuote(adapterPath)}`, '导出 MCP 配置') : <Typography.Text type="secondary">手动合并配置可运行 <code>node local-bridge/mcp.mjs --print-config</code>。</Typography.Text>}
          </div>
        </div>}
      </div>
    </Drawer>
  </div>;
};

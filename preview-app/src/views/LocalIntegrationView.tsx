import React, { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Card, Collapse, Drawer, Flex, Form, Grid, Input, Segmented, Select, Space, Steps, Tag, Typography } from 'antd';
import { Activity, ArrowLeft, ArrowRight, Check, Copy, Cpu, ExternalLink, FileCode2, FolderGit2, FolderOpen, LayoutDashboard, MousePointer2, RefreshCw, ShieldCheck, Sparkles, Terminal, Trash2, Zap } from 'lucide-react';
import { api, ApiError, HostBridgeStatus, hubApiUrl, LocalAutomationCapabilities, LocalGitRepo, Project, ProjectWorkspace, timeText, User } from './workspaceApi';
import { LocalDeviceList, LocalDevicePairing } from './LocalDevicePairing';
import { TeamAgentsCard } from './TeamAgents';
import { bridgeInstallCommand } from './bridgeInstall';
import { CustomClientAdapters } from './CustomClientAdapters';
import type { ClientAdapterManifest } from '../../../shared/local-client-adapter.mjs';
import { navigateWorkspace } from './workspaceNavigation';
import { localBridgePortFromHash, suggestedLocalProjects, suggestRepoPathForProject, withoutLocalBridgePort } from './localBridgeHandoff';
import { LOCAL_TASK_TARGETS, LocalTaskTarget } from './localTaskWorkflowPrompt';
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
  const { message } = App.useApp();
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
  const [repositories, setRepositories] = useState<LocalGitRepo[]>([]);
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [loadingBridge, setLoadingBridge] = useState(true);
  const [authorizingBridge, setAuthorizingBridge] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [rescanningRepos, setRescanningRepos] = useState(false);
  const [doctorResult, setDoctorResult] = useState<LocalDoctorResult | null>(null);
  const [runningDoctor, setRunningDoctor] = useState(false);
  const selectedBridgeProjects = Form.useWatch('projectIds', bridgeForm);
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
      void Promise.allSettled([
        api<{ repositories: LocalGitRepo[] }>('local-git/repositories'),
        api<LocalAutomationCapabilities>('local-automation/capabilities'),
      ]).then(([repoRes, capRes]) => {
        if (!alive.current || seq !== bridgeSequence.current) return;
        if (repoRes.status === 'fulfilled') {
          const scanned = repoRes.value.repositories || [];
          setRepositories(scanned);
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
        if (capRes.status === 'fulfilled') setCapabilities(capRes.value);
      });
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

  const authorizeHostBridge = async (values: { deviceName: string; projectIds: string[] }) => {
    setAuthorizingBridge(true);
    try {
      await api('local-devices/host-bridge', {
        deviceName: (values.deviceName || '工作台与本地 AI').trim(),
        tool: 'custom',
        projectIds: values.projectIds,
      });
      if (!alive.current) return;
      void message.success('本机 AI 已一键接通！工作台（新开或续聊）及本地 CLI 现可直接读取平台任务。');
      setDeviceRefresh(value => value + 1);
      await loadHostState(true);
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else void message.error(error instanceof Error ? error.message : '一键授权失败。');
    } finally {
      if (alive.current) setAuthorizingBridge(false);
    }
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
    if (rescanningRepos) return;
    setRescanningRepos(true);
    try {
      const res = await api<{ repositories: LocalGitRepo[] }>('local-git/repositories?refresh=1');
      if (!alive.current) return;
      const scanned = res.repositories || [];
      setRepositories(scanned);
      const curProjId = workspaceForm.getFieldValue('projectId');
      const curRepoPath = workspaceForm.getFieldValue('repoPath');
      if (curProjId && !curRepoPath && !workspaces.some(item => item.projectId === curProjId)) {
        const guessed = suggestRepoPathForProject(projects.find(p => p.id === curProjId), scanned);
        if (guessed) workspaceForm.setFieldValue('repoPath', guessed);
      }
      void message.success(`已重新扫描本机目录，发现 ${scanned.length} 个 Git 仓库。`);
    } catch (error) {
      if (!alive.current) return;
      void message.error(error instanceof Error ? error.message : '扫描本机 Git 仓库失败。');
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
  const serverMode = capabilities?.deployment === 'server';
  const pairCommand = `node local-bridge/rd.mjs ${serverMode ? 'pair' : 'connect'} --url ${hubApiUrl()} --web-url ${location.origin} --name ${shellQuote(customAdapter?.name || '我的开发电脑')} --tool ${activeClient.tool}`;
  const backupLogin = `node local-bridge/rd.mjs login --url ${hubApiUrl()} --username ${shellQuote(user.username)}`;
  const pathsReady = absoluteProjectPath(projectPath) && (!customAdapter || (absoluteProjectPath(adapterPath) && /\.json$/i.test(adapterPath)));
  const adapterOption = customAdapter ? `--adapter ${shellQuote(adapterPath)}` : `--client ${activeClient.key}`;
  const installCommand = pathsReady ? `node local-bridge/rd.mjs install-mcp ${adapterOption} --project ${shellQuote(projectPath)}` : '';
  const doctorCommand = pathsReady ? `node local-bridge/rd.mjs doctor ${customAdapter ? `--adapter ${shellQuote(adapterPath)} ` : ''}--project ${shellQuote(projectPath)}` : '';
  const copy = async (key: string, command: string) => {
    const sequence = ++copySequence.current;
    try { await navigator.clipboard.writeText(command); if (sequence !== copySequence.current) return; setCopied(key); void message.success('命令已复制。'); }
    catch { if (sequence !== copySequence.current) return; setCopied(''); void message.warning('复制未完成，请手动选择命令文本。'); }
  };
  const commandBlock = (key: string, command: string, label: string) => <div className="tf-local-command">
    <pre><code>{command}</code></pre><Button size="small" icon={copied === key ? <Check size={14} /> : <Copy size={14} />} aria-label={`复制${label}命令`} onClick={() => void copy(key, command)}>{copied === key ? '已复制' : '复制'}</Button>
  </div>;

  const bridgeConnected = hostBridge?.supported !== false && hostBridge?.connected === true;
  const bridgeStatusBadge = bridgeConnected
    ? <StatusBadge variant="green" pulse>已接通 · 有效期至 {timeText(hostBridge?.device?.expiresAt)}</StatusBadge>
    : hostBridge?.status === 'EXPIRED' || hostBridge?.status === 'REVOKED'
      ? <StatusBadge variant="warn">授权已过期 · 待续期</StatusBadge>
      : <StatusBadge variant="blue">MCP 已就绪 · 待一键授权</StatusBadge>;

  const authorizedCount = hostBridge?.device?.projectIds?.length || 0;
  const readyEngineCount = capabilities?.engines ? capabilities.engines.filter(e => e.available).length : 4;

  return <div className="tf-local-integration">
    <div className="tf-local-hero-deck">
      {serverMode && (
        <Card
          className="tf-local-bridge-card"
          title={<div className="tf-local-card-title-row">
            <span className="tf-card-icon-badge"><Zap size={16} /></span>
            <span>我的本机 Bridge（服务器派发、本机执行）</span>
            {capabilities?.devices?.some(device => device.online)
              ? <StatusBadge variant="green" pulse>在线 {capabilities.devices.filter(device => device.online).length} 台</StatusBadge>
              : <StatusBadge variant="blue">未在线</StatusBadge>}
          </div>}
          extra={<Button size="small" icon={<RefreshCw size={13} />} loading={loadingBridge} onClick={() => void loadHostState(false)}>刷新状态</Button>}
        >
          <Flex vertical gap={12}>
            <Typography.Text type="secondary">服务器只保存任务、派发与结果；AI 在你的电脑上运行，代码仓库和 AI 账号不离开本机。worker 只执行派发给该设备的任务，仓库路径以本机配置为准，开发类任务需在本机弹窗确认。</Typography.Text>
            {(capabilities?.devices || []).map(device => (
              <Flex key={device.id} justify="space-between" align="center" gap={8} wrap>
                <Space size={8}><Typography.Text strong>{device.deviceName}</Typography.Text><Tag>{device.tool}</Tag><Tag>{device.projectIds.length} 个项目</Tag></Space>
                <Typography.Text type={device.online ? 'success' : 'secondary'}>{device.online ? '在线' : device.lastSeenAt ? `最近在线 ${timeText(device.lastSeenAt)}` : '已配对，未启动 worker'} · 有效期至 {timeText(device.expiresAt)}</Typography.Text>
              </Flex>
            ))}
            <Typography.Text>1. 在你的电脑终端运行一键安装（需要 Node.js 24+）。脚本会下载客户端到 ~/.taskflow，自签名证书时提示核对指纹，然后显示配对码，在本页「设备授权」中确认并勾选项目：</Typography.Text>
            {commandBlock('bridge-install', bridgeInstallCommand(location.origin), '一键安装')}
            <Typography.Text>2. 编辑 ~/.taskflow/state/worker.json，把「项目ID」映射到本机代码仓库绝对路径；要接收开发任务时把 allowDevelop 设为 true。</Typography.Text>
            <Typography.Text>3. 设为登录后自动在后台运行（macOS），之后不用开着终端：</Typography.Text>
            {commandBlock('bridge-service', '~/.taskflow/bin/taskflow-bridge service --action install', '后台运行')}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>想先前台试运行可执行 ~/.taskflow/bin/taskflow-bridge worker；查看后台状态用 service --action status，停止用 service --action uninstall。在「我的设备」中开启「允许团队派发」后，项目负责人也能把任务派到这台电脑。</Typography.Text>
          </Flex>
        </Card>
      )}
      {hostBridge?.supported !== false && !serverMode && (
        <Card
          className="tf-local-bridge-card"
          title={
            <div className="tf-local-card-title-row">
              <span className="tf-card-icon-badge"><Zap size={16} /></span>
              <span>本机 AI 一键授权接通</span>
              {bridgeStatusBadge}
            </div>
          }
          extra={<Button size="small" icon={<RefreshCw size={13} />} loading={loadingBridge} onClick={() => void loadHostState(false)}>刷新状态</Button>}
        >
          <Flex vertical gap={16}>
            {bridgeConnected ? (
              <Alert
                type="success"
                showIcon
                title={`当前本机桥接已接通（${hostBridge?.device?.deviceName || '工作台与本地 AI'}），已授权 ${authorizedCount} 个项目`}
                description="你的工作台（Codex 与 Gemini / Antigravity 引擎）、Codex CLI、Claude Code、Cursor 现可直接读取所选项目的任务与评审上下文，无需再运行临时配对终端。"
              />
            ) : (
              <Alert
                type="info"
                showIcon
                title="无需临时终端端口或配对码：核对下方项目后点击「一键授权接通本机 AI」即可生效"
                description="本机的 Codex、Gemini / Antigravity、Claude Code、Cursor 已完成 taskflow MCP 配置。点击下方按钮将直接签发受限本机设备会话（7 天有效），所有本地 AI 工具立即可读。"
              />
            )}

            {capabilities?.engines && (
              <div className="tf-engine-readiness">
                <span className="tf-engine-readiness-label">本机直连执行引擎检测</span>
                <div className="tf-engine-pill-grid">
                  {capabilities.engines.map(eng => (
                    <span key={eng.id} className={`tf-engine-pill${eng.available ? ' is-ready' : ' is-missing'}`}>
                      <i aria-hidden="true" />
                      <strong>{eng.label}</strong>
                      <small>{eng.available ? '可一键调用' : '未检测到'}</small>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <Form
              form={bridgeForm}
              layout="vertical"
              className="tf-local-bridge-form"
              disabled={authorizingBridge || loadingBridge}
              initialValues={{ deviceName: '工作台与本地 AI', projectIds: [] }}
              onFinish={values => void authorizeHostBridge(values)}
            >
              <div className="tf-local-bridge-fields">
                <Form.Item name="deviceName" label="本机设备标识" rules={[{ required: true, max: 80, message: '请输入设备名称' }]}>
                  <Input placeholder="工作台与本地 AI" autoComplete="off" />
                </Form.Item>
                <Form.Item
                  name="projectIds"
                  label={
                    <Flex justify="space-between" align="center" gap={8} style={{ width: '100%' }}>
                      <span>允许本机 AI 访问的项目</span>
                      {projects.length > 0 && (
                        <Space size={4}>
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
                  {bridgeConnected ? '更新授权项目并续期' : '一键授权接通本机 AI'}
                </Button>
                <Button onClick={() => navigateWorkspace('tasks')}>前往任务中心处理任务</Button>
                <Button href="http://127.0.0.1:5288/agent" target="_blank" rel="noopener noreferrer" icon={<ExternalLink size={13} />}>打开 5288 工作台</Button>
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

      <div className="tf-local-side-stack">
        <div className="tf-local-kpi-grid" aria-label="本地协同遥测概览">
          <div className={`tf-local-kpi-tile${bridgeConnected ? ' is-connected' : ''}`}>
            <span>桥接会话</span>
            <strong>{bridgeConnected ? '已在线' : '待授权'}</strong>
            <small>{bridgeConnected ? '7 天受限设备令牌有效' : '点击左侧一键签发会话'}</small>
          </div>
          <div className="tf-local-kpi-tile">
            <span>已授权项目</span>
            <strong>{authorizedCount}</strong>
            <small>可见项目共 {projects.length} 个</small>
          </div>
          <div className="tf-local-kpi-tile">
            <span>已绑定仓库</span>
            <strong>{workspaces.length}</strong>
            <small>扫描发现 {repositories.length} 个本地库</small>
          </div>
          <div className="tf-local-kpi-tile">
            <span>就绪 AI 引擎</span>
            <strong>{readyEngineCount}</strong>
            <small>Codex / Gemini / Cursor / Claude</small>
          </div>
        </div>

        <Card
          className="tf-local-workflow-card"
          title={
            <div className="tf-local-card-title-row">
              <span className="tf-card-icon-badge"><Sparkles size={16} /></span>
              <span>全流程免复制自动化协作</span>
            </div>
          }
        >
          <div className="tf-local-workflow-steps">
            <div className="tf-workflow-step-item">
              <em>01</em>
              <div>
                <strong>任务详情页直连本地引擎</strong>
                <p>在任意任务点击 <span className="tf-inline-pill">本地 AI 一键处理</span>，直接调度本机 <strong>Codex</strong>、<strong>Gemini / Antigravity</strong>、<strong>Cursor Agent</strong> 或 <strong>Claude Code</strong>，告别手工复制粘贴。</p>
              </div>
            </div>
            <div className="tf-workflow-step-item">
              <em>02</em>
              <div>
                <strong>自动提取代码改动与生成评审草稿</strong>
                <p>绑定本地业务 Git 仓库后，支持一键读取工作树 Diff 登记为 <code>CODE</code> 材料，并基于冻结输入自动生成结构化评审草稿。</p>
              </div>
            </div>
            <div className="tf-workflow-step-item">
              <em>03</em>
              <div>
                <strong>伴随心跳与提交同步</strong>
                <p>运行 <code>taskflow-hub start --task &lt;任务号&gt; --tool custom</code> 可在编码期间自动同步心跳与 Git 新提交进度。</p>
              </div>
            </div>
          </div>
          <Space wrap size={8} className="tf-local-workflow-actions">
            <Button type="primary" onClick={() => navigateWorkspace('tasks')}>进入任务中心体验全流程</Button>
            <Button href="http://127.0.0.1:5288/agent" target="_blank" rel="noopener noreferrer" icon={<LayoutDashboard size={14} />}>打开当前工作台</Button>
          </Space>
        </Card>
      </div>
    </div>

    <Card
      className="tf-local-doctor-card"
      title={
        <div className="tf-local-card-title-row">
          <span className="tf-card-icon-badge"><Activity size={16} /></span>
          <span>本机 AI 与 MCP 全链路在线体检 (Doctor)</span>
          {doctorResult && (
            <StatusBadge
              variant={doctorResult.overall === 'HEALTHY' ? 'green' : doctorResult.overall === 'WARN' ? 'warn' : 'warn'}
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
            {doctorResult ? '重新体检' : '一键运行全面体检'}
          </Button>
        </Space>
      }
    >
      {!doctorResult ? (
        <Typography.Text type="secondary">
          一键实时检测 SQLite 并发日志模式、本地 AI 私有运行沙盒目录权限（0700 隔离）、Git 工具链、CLI 编程引擎可达性、MCP 受限设备会话有效期及业务仓库规范文件，支持导出零密钥脱敏诊断报告。
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
          <span>项目本地代码目录绑定（免手输路径）</span>
        </div>
      }
      extra={
        <Space size={6} wrap>
          {repositories.length > 0 && <Tag className="tf-local-protocol">已发现 {repositories.length} 个本地库</Tag>}
          <Tag className="tf-local-protocol">已绑定 {workspaces.length} 项</Tag>
          <Button size="small" icon={<RefreshCw size={13} />} loading={rescanningRepos} onClick={() => void rescanRepositories()}>重新扫描</Button>
        </Space>
      }
    >
      <Flex vertical gap={16}>
        <Typography.Text type="secondary">将平台项目与本机真实业务 Git 仓库绑定后，任务详情支持「一键启动本机 AI 执行」「一键提取 Git 改动为代码材料」与「Finder / Cursor / 终端一键打开」。</Typography.Text>
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
              const guessed = existing?.repoPath || suggestRepoPathForProject(projects.find(p => p.id === changed.projectId), repositories);
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
            <Form.Item name="repoPath" label="本机业务仓库绝对路径" rules={[{ required: true, message: '请输入绝对路径' }, { validator: (_, value) => typeof value === 'string' && absoluteProjectPath(value) ? Promise.resolve() : Promise.reject(new Error('请输入以 / 开头的本机绝对路径')) }]}>
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
                      <code className="tf-bound-repo-path">{item.repoPath}</code>
                      <span className="tf-bound-target-pill">{targetLabel}</span>
                    </div>
                    <Space size={4} className="tf-bound-workspace-actions">
                      <Button size="small" type="text" icon={<FolderOpen size={13} />} onClick={() => void api('local-git/open', { projectId: item.projectId, app: 'finder', repoPath: item.repoPath }).then(() => message.success('已在 Finder 中打开文件夹。')).catch(err => message.error(err instanceof Error ? err.message : '打开失败。'))}>Finder 打开</Button>
                      <Button size="small" type="text" onClick={() => void api('local-git/open', { projectId: item.projectId, app: 'cursor', repoPath: item.repoPath }).then(() => message.success('已在 Cursor 中打开。')).catch(err => message.error(err instanceof Error ? err.message : '打开失败。'))}>在 Cursor 打开</Button>
                      <Button size="small" type="text" icon={<Terminal size={13} />} onClick={() => void api('local-git/open', { projectId: item.projectId, app: 'terminal', repoPath: item.repoPath }).then(() => message.success('已在终端中打开仓库目录。')).catch(err => message.error(err instanceof Error ? err.message : '打开失败。'))}>打开终端</Button>
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
          <Typography.Text type="secondary">本机全局配置已就绪；若需写入单个业务仓库内的项目级 MCP 配置可使用下方引导。</Typography.Text>
        </div>
        <Tag className="tf-local-protocol">标准 MCP 协议</Tag>
      </div>
      <div className="tf-local-client-grid">
        {CLIENTS.map(item => (
          <Card key={item.key} className="tf-local-client-card">
            <div className="tf-local-client-top">
              <div className="tf-local-client-identity">
                <span className="tf-local-client-icon"><item.icon size={19} strokeWidth={1.85} /></span>
                <div>
                  <Typography.Title level={3}>{item.name}</Typography.Title>
                  <Typography.Text type="secondary" className="tf-local-client-type">本地编程工具</Typography.Text>
                </div>
              </div>
              <code className="tf-client-config-chip">{item.file}</code>
            </div>
            <Typography.Paragraph type="secondary" className="tf-local-client-description">{item.description}</Typography.Paragraph>
            <Button className="tf-local-client-action" icon={<ArrowRight size={14} />} iconPlacement="end" onClick={() => startGuide(item.key)}>项目级配置引导</Button>
          </Card>
        ))}
      </div>
    </section>

    <CustomClientAdapters userId={user.id} onConnect={startCustomGuide} />

    <LocalDeviceList key={user.id} onUnauthorized={onUnauthorized} refreshKey={deviceRefresh} teamDispatch={serverMode} onAuthorize={() => { setHandoffPort(undefined); setStep(1); setCopied(''); clearPaths(); setGuideOpen(true); }} />

    {serverMode && <TeamAgentsCard key={`team-${user.id}`} projects={projects} onUnauthorized={onUnauthorized} />}

    <Collapse className="tf-local-help" items={[
      { key: 'capabilities', label: <Space size={8}><FileCode2 size={15} /><span>接入后可以调用哪些 MCP 能力</span></Space>, children: <div className="tf-local-capabilities">
        <div className="tf-capability-group"><Typography.Text strong>只读检索工具（{READ_TOOLS.length} 项）</Typography.Text><Typography.Paragraph type="secondary">查询任务列表、上下文、绑定仓库路径、材料版本、评审记录、冻结输入快照与团队知识库。</Typography.Paragraph><Space wrap size={[8, 8]}>{READ_TOOLS.map(tool => <Tag key={tool} className="tf-mcp-tool-tag"><code>{tool}</code> · {mcpToolLabel(tool)}</Tag>)}</Space></div>
        <div className="tf-capability-group"><Typography.Text strong>受控回传工具（4 项）</Typography.Text><Typography.Paragraph type="secondary">在项目成员权限内认领任务、上报开发进度、记录伴随心跳或提交指定评审报告。</Typography.Paragraph><Space wrap size={[8, 8]}>{WRITE_TOOLS.map(tool => <Tag key={tool} className="tf-mcp-tool-tag is-write"><code>{tool}</code> · {mcpToolLabel(tool)}</Tag>)}</Space></div>
        <div className="tf-local-capabilities-footer"><Typography.Text type="secondary">云端 AI 托管执行尚未接入，当前均由本机 AI 工具执行并按权限回传。</Typography.Text><Button type="link" icon={<ArrowRight size={14} />} iconPlacement="end" onClick={() => navigateWorkspace('tasks')}>前往任务中心</Button></div>
      </div> },
      { key: 'permissions', label: <Space size={8}><ShieldCheck size={15} /><span>设备权限边界与安全说明</span></Space>, children: <Typography.Paragraph type="secondary" style={{ margin: 0 }}>设备仅可访问明确批准的项目，支持任务读取、认领、进度、心跳与报告提交。成员管理、平台配置、业务审批和发布权限不会授予本地设备。一键授权与终端配对同样遵循浏览器登录态与同源校验，可随时在「我的设备」撤销。</Typography.Paragraph> },
    ]} />

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
          <div className="tf-local-guide-lead"><Typography.Title level={3}>连接 {activeClient.name}</Typography.Title><Typography.Paragraph type="secondary">如果在同一台电脑上使用，直接用页面顶部的「一键授权接通本机 AI」即可；也可在包含 local-bridge 的平台根目录执行终端配对。</Typography.Paragraph></div>
          {customAdapter && <Alert type="info" showIcon title="自定义客户端需支持标准 MCP stdio 与 JSON 配置" description="请先导出此适配器到本机 JSON 文件，安装时会使用该文件；导入适配器本身不会安装软件或启动 AI。" />}
          <div className="tf-local-guide-card"><Typography.Text strong>1. 准备本地桥接依赖</Typography.Text>{commandBlock('install', 'npm --prefix local-bridge install --include=dev', '准备本地桥接')}</div>
          <div className="tf-local-guide-card"><Typography.Text strong>2. 发起设备配对（备用路径）</Typography.Text><Typography.Text type="secondary">可将设备名称改为容易识别的名称。命令会自动打开日常 Chrome，在网页核对设备与项目并批准，无需抄写配对码。</Typography.Text>{commandBlock('pair', pairCommand, '发起设备授权')}</div>
        </div>}
        {step === 1 && <div className="tf-local-guide-section"><div className="tf-local-guide-lead"><Typography.Title level={3}>核对并授权设备</Typography.Title><Typography.Paragraph type="secondary">{handoffPort !== undefined ? '从本机读取申请后，核对设备与项目范围并批准。' : 'connect 会自动打开核对页面；也可在下方输入既有终端配对码。'}</Typography.Paragraph></div><LocalDevicePairing key={user.id + ':' + client + ':' + (handoffPort ?? 'manual')} handoffPort={handoffPort} onHandoffComplete={() => { if (handoffPort !== undefined) clearHandoffRoute(handoffPort); }} onUnauthorized={onUnauthorized} onApproved={() => setDeviceRefresh(value => value + 1)} /></div>}
        {step === 2 && <div className="tf-local-guide-section">
          <div className="tf-local-guide-lead"><Typography.Title level={3}>安装 {activeClient.name} 配置</Typography.Title><Typography.Paragraph type="secondary">完成本机授权后，可为指定业务代码目录写入项目级 MCP 配置（<code>{activeClient.file}</code>）。</Typography.Paragraph></div>
          <Form form={pathForm} layout="vertical" clearOnDestroy initialValues={{ projectPath: '', adapterPath: '' }} onValuesChange={values => { if ('projectPath' in values) setProjectPath(values.projectPath || ''); if ('adapterPath' in values) setAdapterPath(values.adapterPath || ''); clearCopy(); }}>
            <Form.Item name="projectPath" label="项目绝对目录" htmlFor="local-project-path" rules={[{ required: true, message: '请明确填写本机项目绝对目录。' }, { validator: (_, value) => typeof value === 'string' && absoluteProjectPath(value) ? Promise.resolve() : Promise.reject(new Error('请输入有效的 macOS/Linux 项目绝对目录。')) }]} extra="在本机终端执行。网页只生成命令，不会访问或修改此目录。"><Input id="local-project-path" placeholder="/Users/you/workspace/project" autoComplete="off" /></Form.Item>
            {customAdapter && <Form.Item name="adapterPath" label="适配器 JSON 文件绝对路径" htmlFor="local-adapter-path" rules={[{ required: true, message: '请填写已导出的适配器文件路径。' }, { validator: (_, value) => typeof value === 'string' && absoluteProjectPath(value) && /\.json$/i.test(value) ? Promise.resolve() : Promise.reject(new Error('请输入有效的本机 JSON 文件绝对路径。')) }]} extra="填写刚才导出文件在本机的位置。不要填写客户端的配置文件路径。"><Input id="local-adapter-path" placeholder="/Users/you/Downloads/generic-workbench.json" autoComplete="off" /></Form.Item>}
            <div className="tf-local-guide-card"><Typography.Text strong>安装项目配置</Typography.Text>{installCommand ? <div className="tf-local-command"><pre><code>{installCommand}</code></pre><Button size="small" icon={copied === 'mcp-install' ? <Check size={14} /> : <Copy size={14} />} aria-label="复制 MCP 安装命令" onClick={() => void pathForm.validateFields().then(() => copy('mcp-install', installCommand)).catch(() => {})}>{copied === 'mcp-install' ? '已复制' : '复制'}</Button></div> : <Button disabled icon={<Copy size={14} />}>填写目录后复制安装命令</Button>}</div>
          </Form>
          <div className="tf-local-guide-card"><Typography.Text strong>检查连接状态</Typography.Text>{doctorCommand ? commandBlock('doctor', doctorCommand, '检查本机连接') : <Button disabled icon={<Copy size={14} />}>填写路径后生成检查命令</Button>}<Typography.Text type="secondary">运行后在终端查看诊断结果，再重载 {activeClient.name} 并实际调用 <code>task_list</code>。配置已写入不代表客户端已加载。</Typography.Text></div>
          <Collapse size="small" items={[{ key: 'advanced', label: '配置详情与备用终端登录', children: <div className="tf-local-guide-block"><Typography.Text type="secondary">项目内配置文件：<Typography.Text code>{activeClient.file}</Typography.Text></Typography.Text><Typography.Text type="secondary">合并节点：<Typography.Text code>{activeClient.node}</Typography.Text></Typography.Text>{customAdapter && <Typography.Paragraph type="secondary">当前 Delivery Workspace 的原生自定义插件尚不支持注册 MCP。可直接使用工作台内置的 Codex 或 Gemini / Antigravity 引擎全局 MCP 配置。</Typography.Paragraph>}<Typography.Paragraph type="secondary">已有平台成员可使用备用登录，密码在终端隐藏输入。</Typography.Paragraph>{commandBlock('backup-login', backupLogin, '备用登录')}{customAdapter ? absoluteProjectPath(adapterPath) && commandBlock('export-mcp', `node local-bridge/rd.mjs export-mcp --adapter ${shellQuote(adapterPath)}`, '导出 MCP 配置') : <Typography.Text type="secondary">手动合并配置可运行 <code>node local-bridge/mcp.mjs --print-config</code>。</Typography.Text>}</div> }]} />
        </div>}
      </div>
    </Drawer>
  </div>;
};

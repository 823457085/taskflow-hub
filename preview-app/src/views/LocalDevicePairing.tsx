import React, { useEffect, useRef, useState } from 'react';
import { readTogether } from './readTogether';
import { App, Button, Card, Descriptions, Empty, Flex, Form, Grid, Input, List, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { api, ApiError, Project, timeText } from './workspaceApi';
import { assertLocalBridgeRequest, isLocalBridgeRouteCurrent, readLocalBridgeHandoff, suggestedLocalProjects } from './localBridgeHandoff';
import type { LocalBridgeHandoff } from './localBridgeHandoff';
import { deviceScopeLabel, deviceStatusLabel, pairingStatusLabel } from './displayLabels';

interface PairingRequest {
  deviceName: string;
  tool: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'CONSUMED';
  expiresAt: string;
}
interface LocalDevice {
  id: string;
  deviceName: string;
  tool: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  projectIds: string[];
  scope: 'LOCAL_BRIDGE';
  teamDispatch?: boolean;
}
interface PairingPreview { userCode: string; request: PairingRequest; suggestedProjectIds?: string[]; handoff?: boolean; replacesExisting?: true }

const DeviceApproval: React.FC<{ preview: PairingPreview; username: string; projects: Project[]; loadingProjects: boolean; pending: boolean; expired: boolean; onDecision: (decision: 'APPROVE' | 'DENY', projectIds: string[]) => void }> = ({ preview, username, projects, loadingProjects, pending, expired, onDecision }) => {
  const [form] = Form.useForm<{ projectIds: string[] }>();
  const pendingRequest = preview.request.status === 'PENDING';
  const initializedScope = useRef(false);
  useEffect(() => {
    if (!pendingRequest || expired || loadingProjects) return;
    const ids: string[] = initializedScope.current ? form.getFieldValue('projectIds') || [] : preview.suggestedProjectIds || [];
    initializedScope.current = true;
    form.setFieldValue('projectIds', suggestedLocalProjects(ids, projects));
  }, [projects, pendingRequest, expired, loadingProjects]);
  return <Flex vertical gap={24} className="tf-local-device-review">
    <Descriptions bordered size="small" column={1} items={[
      { key: 'name', label: '设备名称', children: preview.request.deviceName },
      { key: 'tool', label: '客户端标记', children: preview.request.tool },
      { key: 'status', label: '申请状态', children: <Tag>{pairingStatusLabel(preview.request.status)}</Tag> },
      { key: 'expires', label: '授权截止时间', children: timeText(preview.request.expiresAt) },
    ]} />
    <Typography.Paragraph type="secondary">{preview.replacesExisting ? `检测到这台电脑已有绑定。确认后将连接当前账号 ${username}，新连接验证成功后会解除旧绑定。` : '请核对设备和允许访问的项目，再批准接入。'}</Typography.Paragraph>
    {pendingRequest && !expired ? <Form form={form} layout="vertical" disabled={pending} initialValues={{ projectIds: [] }} onFinish={values => onDecision('APPROVE', values.projectIds)}>
      <Form.Item name="projectIds" label="允许访问的项目" rules={[{ type: 'array', required: true, min: 1, message: '请明确选择至少一个可访问项目。' }]} extra="仅允许所选项目内的任务读取、认领、进度、心跳和报告提交，不授予成员管理、平台配置、业务审批或发布权限。">
        <Select mode="multiple" placeholder="选择允许访问的项目" disabled={loadingProjects || pending} loading={loadingProjects} showSearch={{ optionFilterProp: 'label' }} options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))} />
      </Form.Item>
      <Space size={8} wrap><Button type="primary" htmlType="submit" icon={<ShieldCheck size={16} />} loading={pending} disabled={loadingProjects || !projects.length}>{preview.replacesExisting ? '确认切换绑定' : '批准设备接入'}</Button><Button danger disabled={pending} onClick={() => onDecision('DENY', [])}>拒绝申请</Button></Space>
    </Form> : <Typography.Paragraph type="secondary">{expired ? '配对申请已过期，请在终端重新发起。' : preview.request.status === 'APPROVED' ? '已批准，正在等待本地终端完成配对。' : preview.request.status === 'DENIED' ? '此配对申请已拒绝。' : '此配对申请已完成，可在“我的设备”查看授权。'}</Typography.Paragraph>}
  </Flex>;
};

export const LocalDevicePairing: React.FC<{ username: string; onUnauthorized?: () => void; onApproved?: (status: 'APPROVED' | 'CONSUMED') => void; handoffPort?: number; onHandoffComplete?: () => void }> = ({ username, onUnauthorized, onApproved, handoffPort, onHandoffComplete }) => {
  const { message } = App.useApp();
  const [codeForm] = Form.useForm<{ userCode: string }>();
  const [preview, setPreview] = useState<PairingPreview | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [now, setNow] = useState(Date.now);
  const [manualMode, setManualMode] = useState(false);
  const [handoffReload, setHandoffReload] = useState(0);
  const callbacks = useRef({ onUnauthorized, onApproved, onHandoffComplete }); callbacks.current = { onUnauthorized, onApproved, onHandoffComplete };
  const alive = useRef(true);
  const currentCode = useRef('');
  const inspectSequence = useRef(0);
  const projectSequence = useRef(0);
  const decisionPending = useRef(false);
  const routeCurrent = () => isLocalBridgeRouteCurrent(location.hash, handoffPort);
  const showError = (error: unknown) => {
    if (!alive.current || !routeCurrent()) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      inspectSequence.current += 1; projectSequence.current += 1; currentCode.current = ''; setPreview(null); codeForm.resetFields(); setInspecting(false); setLoadingProjects(false); setProjects([]);
      if (error.status === 401) callbacks.current.onUnauthorized?.();
    }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refreshProjects = async () => {
    const sequence = ++projectSequence.current;
    setLoadingProjects(true);
    try {
      const projectData = await api<{ projects: Project[] }>('projects');
      if (!alive.current || sequence !== projectSequence.current || !routeCurrent()) return;
      setProjects(projectData.projects);
    } catch (error) { if (sequence === projectSequence.current) { setProjects([]); showError(error); } }
    finally { if (alive.current && sequence === projectSequence.current) setLoadingProjects(false); }
  };
  useEffect(() => {
    alive.current = true; void refreshProjects();
    return () => { alive.current = false; inspectSequence.current += 1; projectSequence.current += 1; };
  }, []);
  useEffect(() => {
    if (!preview || preview.request.status !== 'PENDING') return;
    setNow(Date.now());
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [preview]);
  const inspect = async ({ userCode }: { userCode: string }, handoff?: LocalBridgeHandoff, currentSequence?: number) => {
    if (!alive.current || decisionPending.current || !routeCurrent()) return;
    if (!projects.length && !loadingProjects) void refreshProjects();
    const sequence = currentSequence ?? ++inspectSequence.current;
    const code = userCode.trim().toUpperCase();
    currentCode.current = code; setPreview(null); setInspecting(true);
    try {
      const data = await api<{ request: PairingRequest }>('device-authorizations/inspect', { userCode: code });
      if (!alive.current || sequence !== inspectSequence.current || currentCode.current !== code || !routeCurrent()) return;
      if (handoff) assertLocalBridgeRequest(handoff, data.request);
      setPreview({ userCode: code, request: data.request, suggestedProjectIds: handoff?.suggestedProjectIds, handoff: !!handoff, replacesExisting: handoff?.replacesExisting });
      if (data.request.status === 'CONSUMED') {
        if (handoff) callbacks.current.onHandoffComplete?.();
        callbacks.current.onApproved?.('CONSUMED');
      }
    } catch (error) { if (sequence === inspectSequence.current) showError(error); }
    finally { if (alive.current && sequence === inspectSequence.current) setInspecting(false); }
  };
  useEffect(() => {
    if (handoffPort === undefined || manualMode) return;
    const sequence = ++inspectSequence.current; const controller = new AbortController();
    currentCode.current = ''; setPreview(null); codeForm.resetFields(); setInspecting(true);
    void readLocalBridgeHandoff(handoffPort, controller.signal).then(async handoff => {
      if (!alive.current || controller.signal.aborted || sequence !== inspectSequence.current || !routeCurrent()) return;
      codeForm.setFieldValue('userCode', handoff.userCode);
      await inspect({ userCode: handoff.userCode }, handoff, sequence);
    }).catch(error => { if (!controller.signal.aborted && sequence === inspectSequence.current) showError(error); })
      .finally(() => { if (alive.current && sequence === inspectSequence.current) setInspecting(false); });
    return () => { controller.abort(); if (sequence === inspectSequence.current) inspectSequence.current += 1; };
  }, [handoffPort, handoffReload, manualMode]);
  useEffect(() => {
    if (!preview || preview.request.status !== 'APPROVED') return;
    const sequence = inspectSequence.current; const code = preview.userCode; const isHandoff = preview.handoff; const until = Date.now() + 60_000; let stopped = false; let timer: number;
    const update = async () => {
      if (stopped || Date.now() >= until || !routeCurrent()) return;
      try {
        const data = await api<{ request: PairingRequest }>('device-authorizations/inspect', { userCode: code });
        if (stopped || !alive.current || sequence !== inspectSequence.current || code !== currentCode.current || !routeCurrent()) return;
        setPreview(current => current && current.userCode === code ? { ...current, request: data.request } : current);
        if (data.request.status === 'CONSUMED') {
          if (isHandoff) callbacks.current.onHandoffComplete?.();
          callbacks.current.onApproved?.('CONSUMED');
        }
        else if (data.request.status === 'APPROVED' && Date.now() < until) timer = window.setTimeout(update, 3000);
      } catch (error) { if (!stopped && sequence === inspectSequence.current) { setPreview(null); showError(error); } }
    };
    timer = window.setTimeout(update, 3000);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [preview?.userCode, preview?.request.status]);
  const decide = async (decision: 'APPROVE' | 'DENY', projectIds: string[]) => {
    if (!alive.current || !routeCurrent() || !preview || preview.request.status !== 'PENDING' || decisionPending.current || preview.userCode !== currentCode.current) return;
    const expiresAt = Date.parse(preview.request.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { setNow(Date.now()); return; }
    if (decision === 'APPROVE' && (!projectIds.length || projectIds.some(id => !projects.some(project => project.id === id)))) {
      void message.error('项目权限已变化，请重新选择允许访问的项目。'); return;
    }
    const sequence = inspectSequence.current;
    const code = preview.userCode;
    decisionPending.current = true; setDeciding(true);
    try {
      const data = await api<{ status: 'APPROVED' | 'DENIED' }>('device-authorizations/decision', { userCode: code, decision, projectIds });
      if (!alive.current || sequence !== inspectSequence.current || currentCode.current !== code || !routeCurrent()) return;
      setPreview(current => current && current.userCode === code ? { ...current, request: { ...current.request, status: data.status } } : null);
      void message.success(data.status === 'APPROVED' ? '已批准该设备接入。' : '已拒绝该设备配对申请。');
      if (data.status === 'APPROVED') callbacks.current.onApproved?.('APPROVED');
    } catch (error) {
      if (alive.current && sequence === inspectSequence.current && currentCode.current === code && routeCurrent()) {
        showError(error);
        if (error instanceof ApiError && error.status === 403) void refreshProjects();
        if (error instanceof ApiError && [404, 410].includes(error.status)) setPreview(null);
        if (error instanceof ApiError && error.status === 409) {
          try {
            const data = await api<{ request: PairingRequest }>('device-authorizations/inspect', { userCode: code });
            if (alive.current && sequence === inspectSequence.current && currentCode.current === code && routeCurrent()) setPreview(current => current && current.userCode === code ? { ...current, request: data.request } : null);
          } catch (readError) {
            if (alive.current && sequence === inspectSequence.current && currentCode.current === code && routeCurrent()) {
              setPreview(null); showError(readError);
            }
          }
        }
      }
    }
    finally { decisionPending.current = false; if (alive.current) setDeciding(false); }
  };
  const expires = preview ? Date.parse(preview.request.expiresAt) : 0;
  const expired = !!preview && (!Number.isFinite(expires) || expires <= now);
  return <Flex vertical gap={24}>
    {handoffPort !== undefined && <Flex vertical gap={12}><Typography.Text type="secondary">{inspecting ? '正在读取本机接入申请…' : preview ? '已读取本机申请，请核对设备和项目范围。' : '本机申请尚未读取，可重试或使用手动配对。'}</Typography.Text><Space wrap><Button loading={inspecting} disabled={deciding} onClick={() => { void refreshProjects(); setManualMode(false); setHandoffReload(value => value + 1); }}>重新读取本机申请</Button>{!preview?.replacesExisting && <Button type="text" disabled={deciding || inspecting} onClick={() => { inspectSequence.current += 1; setInspecting(false); setManualMode(true); }}>手动输入配对码</Button>}</Space></Flex>}
    {(handoffPort === undefined || manualMode) && <Form form={codeForm} layout="vertical" disabled={deciding} onFinish={values => void inspect(values)} onValuesChange={values => {
      if ('userCode' in values) { currentCode.current = String(values.userCode || '').trim().toUpperCase(); inspectSequence.current += 1; setPreview(null); setInspecting(false); }
    }}>
      <Form.Item name="userCode" label="终端配对码" htmlFor="local-device-pair-code" normalize={value => typeof value === 'string' ? value.toUpperCase() : value} rules={[{ required: true, message: '请输入终端显示的配对码。' }, { pattern: /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i, message: '请输入终端显示的8位配对码，例如 ABCD-EFGH。' }]}><Input id="local-device-pair-code" placeholder="ABCD-EFGH" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={9} className="tf-local-code-input" /></Form.Item>
      <Button type={preview ? 'default' : 'primary'} htmlType="submit" loading={inspecting} disabled={deciding || inspecting}>读取配对申请</Button>
    </Form>}
    {preview && <DeviceApproval key={preview.userCode} preview={preview} username={username} projects={projects} loadingProjects={loadingProjects} pending={deciding} expired={expired} onDecision={(decision, ids) => void decide(decision, ids)} />}
  </Flex>;
};

export const LocalDeviceList: React.FC<{ onUnauthorized?: () => void; refreshKey?: number; onAuthorize?: () => void; teamDispatch?: boolean }> = ({ onUnauthorized, refreshKey = 0, onAuthorize, teamDispatch = false }) => {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [projects, setProjects] = useState<Project[]>([]);
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState('');
  const [togglingId, setTogglingId] = useState('');
  const alive = useRef(true);
  const sequence = useRef(0);
  const revokePending = useRef('');
  const showError = (error: unknown) => {
    if (!alive.current) return;
    if (error instanceof ApiError && error.status === 401) { setProjects([]); setDevices([]); onUnauthorized?.(); }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    if (!alive.current) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const [projectData, deviceData] = await readTogether([api<{ projects: Project[] }>('projects'), api<{ devices: LocalDevice[] }>('local-devices')]);
      if (!alive.current || request !== sequence.current) return;
      setProjects(projectData.projects); setDevices(deviceData.devices);
    } catch (error) { if (request === sequence.current) showError(error); }
    finally { if (alive.current && request === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current += 1; };
  }, []);
  useEffect(() => { void refresh(); }, [refreshKey]);
  useEffect(() => {
    const focused = () => { if (!revokePending.current) void refresh(); };
    window.addEventListener('focus', focused);
    return () => window.removeEventListener('focus', focused);
  }, []);
  const revoke = async (device: LocalDevice) => {
    if (!alive.current || revokePending.current || device.status !== 'ACTIVE') return;
    revokePending.current = device.id; setRevokingId(device.id);
    try {
      await api(`local-devices/${encodeURIComponent(device.id)}`, undefined, 'DELETE');
      if (!alive.current) return;
      sequence.current += 1;
      setDevices(current => current.map(item => item.id === device.id ? { ...item, status: 'REVOKED' } : item));
      void message.success('设备授权已撤销。'); await refresh();
    } catch (error) { showError(error); }
    finally { revokePending.current = ''; if (alive.current) setRevokingId(''); }
  };
  const toggleTeamDispatch = async (device: LocalDevice, value: boolean) => {
    if (!alive.current || togglingId) return;
    setTogglingId(device.id);
    try {
      await api(`local-devices/${encodeURIComponent(device.id)}`, { teamDispatch: value }, 'PATCH');
      if (!alive.current) return;
      setDevices(current => current.map(item => item.id === device.id ? { ...item, teamDispatch: value } : item));
      void message.success(value ? '已允许项目负责人、PM 和管理员把任务派发到这台设备。' : '已关闭团队派发，只有你自己能派发到这台设备。');
    } catch (error) { showError(error); }
    finally { if (alive.current) setTogglingId(''); }
  };
  const teamSwitch = (item: LocalDevice) => item.status === 'ACTIVE' ? <Tooltip title="开启后，项目负责人、PM 和管理员可以把任务派发到这台设备，由本机 AI 执行；开发任务仍需你在本机确认。"><Switch size="small" aria-label={`允许团队派发到 ${item.deviceName}`} checked={!!item.teamDispatch} loading={togglingId === item.id} disabled={!!togglingId && togglingId !== item.id} onChange={value => void toggleTeamDispatch(item, value)} /></Tooltip> : <Typography.Text type="secondary">—</Typography.Text>;
  const statusTag = (item: LocalDevice) => <Tag color={item.status === 'ACTIVE' ? 'success' : 'default'} icon={<span aria-hidden="true" style={{ fontSize: 8, marginInlineEnd: 4 }}>●</span>}>{deviceStatusLabel(item.status)}</Tag>;
  const projectNames = (item: LocalDevice) => <Flex vertical gap={4}>{item.projectIds.map(id => { const project = projects.find(project => project.id === id); return <Typography.Text key={id}>{project ? `${project.key} · ${project.name}` : id}</Typography.Text>; })}</Flex>;
  const revokeButton = (item: LocalDevice) => item.status === 'ACTIVE' ? <Popconfirm title="撤销此设备授权？" description="撤销后该设备会话将失效。" okText="撤销" cancelText="取消" okButtonProps={{ danger: true, loading: revokingId === item.id }} onConfirm={() => revoke(item)} disabled={!!revokingId}><Button danger size="small" icon={<Unplug size={14} />} loading={revokingId === item.id} disabled={!!revokingId && revokingId !== item.id}>撤销</Button></Popconfirm> : null;
  const columns: TableColumnsType<LocalDevice> = [
    { title: '设备', width: 220, render: (_, item) => <Flex vertical gap={4}><Typography.Text strong>{item.deviceName}</Typography.Text><Space size={8} wrap><Typography.Text type="secondary" className="tf-local-device-secondary">{item.tool}</Typography.Text><Tag>{deviceScopeLabel(item.scope)}</Tag></Space><Typography.Text type="secondary" className="tf-local-device-secondary">创建于 {timeText(item.createdAt)}</Typography.Text></Flex> },
    { title: '授权项目', width: 240, render: (_, item) => projectNames(item) },
    { title: '授权状态', width: 120, render: (_, item) => statusTag(item) },
    { title: '最近调用 / 有效期', width: 225, render: (_, item) => <Flex vertical gap={4}><Typography.Text>{timeText(item.lastSeenAt || undefined)}</Typography.Text><Typography.Text type="secondary" className="tf-local-device-secondary">有效期至 {timeText(item.expiresAt)}</Typography.Text></Flex> },
    ...(teamDispatch ? [{ title: '允许团队派发', width: 130, render: (_: unknown, item: LocalDevice) => teamSwitch(item) }] : []),
    { title: '操作', width: 100, render: (_, item) => revokeButton(item) },
  ];
  return <Card className="tf-local-devices-card" title="我的设备" style={{ width: '100%', maxWidth: 'none', minWidth: 0 }} extra={<Space size={8} wrap><Button icon={<RefreshCw size={16} />} loading={loading} disabled={!!revokingId} onClick={() => void refresh()}>刷新</Button>{onAuthorize && <Button disabled={!!revokingId} onClick={onAuthorize}>输入配对码</Button>}</Space>}>
    <Flex vertical gap={16} style={{ minWidth: 0 }}>
      <Typography.Paragraph type="secondary" className="tf-local-device-note">共 {devices.length} 条设备授权，其中生效中 {devices.filter(device => device.status === 'ACTIVE').length} 条。最近调用为设备访问本平台的时间，不代表 AI 软件在线。</Typography.Paragraph>
      {screens.md ? <Table<LocalDevice> rowKey="id" className="tf-local-devices-table" style={{ minWidth: 0 }} columns={columns} dataSource={devices} size="middle" loading={loading} scroll={{ x: teamDispatch ? 1035 : 905 }} pagination={devices.length > 5 ? { pageSize: 5, showSizeChanger: false } : false} locale={{ emptyText: '尚无本地设备授权。' }} /> : <List<LocalDevice> rowKey="id" className="tf-local-device-mobile" loading={loading} dataSource={devices} pagination={devices.length > 5 ? { pageSize: 5, showSizeChanger: false } : false} locale={{ emptyText: <Empty description="尚无本地设备授权。" /> }} renderItem={item => <List.Item className="tf-local-device-mobile-item">
        <Flex vertical gap={12} style={{ minWidth: 0, width: '100%' }}>
          <Flex justify="space-between" align="start" gap={8} wrap><Typography.Text strong style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.deviceName}</Typography.Text>{statusTag(item)}</Flex>
          <Space size={8} wrap><Typography.Text type="secondary" className="tf-local-device-secondary">{item.tool}</Typography.Text><Tag>{deviceScopeLabel(item.scope)}</Tag></Space>
          <Flex vertical gap={4}><Typography.Text type="secondary" className="tf-local-device-secondary">授权项目</Typography.Text>{projectNames(item)}</Flex>
          <Flex vertical gap={4}><Typography.Text type="secondary" className="tf-local-device-secondary">创建于 {timeText(item.createdAt)}</Typography.Text><Typography.Text type="secondary" className="tf-local-device-secondary">最近调用 {timeText(item.lastSeenAt || undefined)}</Typography.Text><Typography.Text type="secondary" className="tf-local-device-secondary">有效期至 {timeText(item.expiresAt)}</Typography.Text></Flex>
          {teamDispatch && item.status === 'ACTIVE' && <Space size={8}><Typography.Text type="secondary" className="tf-local-device-secondary">允许团队派发</Typography.Text>{teamSwitch(item)}</Space>}
          {item.status === 'ACTIVE' && <div>{revokeButton(item)}</div>}
        </Flex>
      </List.Item>} />}
    </Flex>
  </Card>;
};

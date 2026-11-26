import { useState } from 'react';
import { App, Button, Card, Flex, Modal, Select, Typography } from 'antd';
import { Link2 } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { bridgeInstallCommand } from './bridgeInstall';
import { suggestedLocalProjects } from './localBridgeHandoff';
import { api, ApiError, type BridgeDevice, type Project } from './workspaceApi';

interface Props {
  devices: BridgeDevice[];
  projects: Project[];
  requestedProjectId?: string;
  loading: boolean;
  waitingForBridge: boolean;
  onConnected: () => void;
  onUnauthorized?: () => void;
}

export function LocalBridgeQuickConnect({ devices, projects, requestedProjectId, loading, waitingForBridge, onConnected, onUnauthorized }: Props) {
  const { message } = App.useApp();
  const [selectedDevice, setSelectedDevice] = useState<string>();
  const [scope, setScope] = useState<{ key: string; ids: string[] }>();
  const [pairing, setPairing] = useState(false);
  const [installShown, setInstallShown] = useState(false);
  const [chooseAction, setChooseAction] = useState(false);
  const online = devices.filter(device => device.online);
  const device = online.find(item => item.id === selectedDevice) || (online.length === 1 ? online[0] : undefined);
  const key = (device?.id || '') + ':' + (requestedProjectId || '');
  const fallbackProject = projects.find(project => project.key === 'DEFAULT') || projects[0];
  const defaults = [...(requestedProjectId ? [requestedProjectId] : []), ...(device?.projectIds || [])];
  const projectIds = suggestedLocalProjects(scope?.key === key ? scope.ids : defaults.length ? defaults : [fallbackProject?.id || ''], projects);
  const ready = !!device && projectIds.length > 0 && projectIds.every(id => device.projectIds.includes(id));
  const localSwitchSupported = navigator.platform.includes('Mac');
  const install = bridgeInstallCommand(location.origin, undefined, projectIds, localSwitchSupported);

  const startLocalPairing = async () => {
    setChooseAction(false);
    setInstallShown(true);
    try { await navigator.clipboard.writeText(install); void message.success('配对命令已复制。'); }
    catch { /* The command is selectable in the card. */ }
  };

  const reuseDevice = async () => {
    if (!device) return;
    setChooseAction(false);
    if (ready) {
      onConnected();
      return;
    }
    setPairing(true);
    try {
      await api(`local-devices/${encodeURIComponent(device.id)}/projects`, { projectIds }, 'PATCH');
      onConnected();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      else if (error instanceof Error) void message.error(error.message);
    } finally {
      setPairing(false);
    }
  };

  return <Card title={<span className="tf-local-card-title-row">
    <span className="tf-card-icon-badge"><Link2 size={16} /></span>
    一键连接本机 AI
    {ready && !waitingForBridge && <StatusBadge variant="green" pulse>已连接</StatusBadge>}
    {waitingForBridge && <StatusBadge variant="neutral">正在等待新绑定上线</StatusBadge>}
  </span>}>
    <Flex vertical gap={12}>
      <div className="tf-local-quick-connect">
        {online.length > 1 && <Select
          aria-label="本机设备"
          placeholder="选择要配对的设备"
          value={device?.id}
          onChange={setSelectedDevice}
          options={online.map(item => ({ label: item.deviceName + ' · ' + item.tool, value: item.id }))}
        />}
        <Select
          aria-label="要接入的项目"
          mode="multiple"
          placeholder="选择允许访问的项目"
          maxTagCount={2}
          maxTagPlaceholder={hidden => `另有 ${hidden.length} 个项目`}
          showSearch={{ optionFilterProp: 'label' }}
          disabled={loading || pairing}
          value={projectIds}
          onChange={ids => setScope({ key, ids })}
          options={projects.map(project => ({ label: `${project.key} · ${project.name}`, value: project.id }))}
        />
        <Button type="primary" icon={<Link2 size={15} />} loading={loading || pairing} disabled={waitingForBridge || !projectIds.length} onClick={() => {
          if (!device) void startLocalPairing();
          else if (localSwitchSupported) setChooseAction(true);
          else void reuseDevice();
        }}>
          一键配对
        </Button>
      </div>
      {device && <Typography.Text type="secondary">当前账号的在线设备 · {device.deviceName}</Typography.Text>}
      {installShown && <>
        <Typography.Text type="secondary">{localSwitchSupported ? '在这台电脑的终端运行命令。Bridge 会检测旧绑定，并打开网页给你确认。' : '在这台电脑的终端运行命令，按终端提示完成配对。'}</Typography.Text>
        <div className="tf-local-command"><pre><code>{install}</code></pre></div>
      </>}
    </Flex>
    <Modal
      title="已检测到在线设备"
      open={chooseAction && !!device}
      onCancel={() => setChooseAction(false)}
      footer={[
        <Button key="cancel" onClick={() => setChooseAction(false)}>取消</Button>,
        <Button key="reuse" onClick={() => void reuseDevice()}>沿用在线设备</Button>,
        <Button key="switch" type="primary" onClick={() => void startLocalPairing()}>切换本机绑定</Button>,
      ]}
    >
      <Typography.Text>当前账号已连接「{device?.deviceName}」。切换时会检查这台电脑的旧绑定。</Typography.Text>
    </Modal>
  </Card>;
}

import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Flex, Select, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { RefreshCw } from 'lucide-react';
import { api, ApiError, Project, TeamAgent, timeText } from './workspaceApi';

export const TeamAgentsCard: React.FC<{ projects: Project[]; onUnauthorized?: () => void }> = ({ projects, onUnauthorized }) => {
  const { message } = App.useApp();
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const current = projects.some(project => project.id === projectId) ? projectId : projects[0]?.id || '';

  const refresh = async (id = current) => {
    if (!id) { setAgents([]); return; }
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = await api<{ agents: TeamAgent[] }>(`agents?projectId=${encodeURIComponent(id)}`);
      if (request === sequence.current) setAgents(data.agents);
    } catch (error) {
      if (request !== sequence.current) return;
      setAgents([]);
      if (error instanceof ApiError && error.status === 401) onUnauthorized?.();
      void message.error(error instanceof Error ? error.message : '读取团队 Agent 失败。');
    } finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { void refresh(current); }, [current]);

  const columns: TableColumnsType<TeamAgent> = [
    { title: '成员', width: 140, render: (_, item) => <Flex gap={6} align="center"><Typography.Text strong>{item.owner.username}</Typography.Text>{item.mine && <Tag>我</Tag>}</Flex> },
    { title: '设备', width: 200, render: (_, item) => <Flex vertical gap={2}><Typography.Text>{item.deviceName}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.tool}</Typography.Text></Flex> },
    { title: '状态', width: 150, render: (_, item) => item.online ? <Tag color="success">在线</Tag> : <Flex vertical gap={2}><Tag>离线</Tag><Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.lastSeenAt ? `最近 ${timeText(item.lastSeenAt)}` : '未启动 worker'}</Typography.Text></Flex> },
    { title: '团队派发', width: 110, render: (_, item) => item.mine ? <Typography.Text type="secondary">本人设备</Typography.Text> : item.teamDispatch ? <Tag color="processing">已开启</Tag> : <Tag>未开启</Tag> },
    { title: '我能否派发', width: 120, render: (_, item) => item.dispatchable ? <Tag color="success">可以</Tag> : <Typography.Text type="secondary">{item.teamDispatch ? '需负责人权限' : '—'}</Typography.Text> },
  ];

  return <Card title="团队 Agent" style={{ width: '100%' }} extra={<Flex gap={8} wrap>
    <Select aria-label="选择项目" style={{ minWidth: 200 }} value={current || undefined} placeholder="选择项目" options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))} onChange={setProjectId} />
    <Button icon={<RefreshCw size={16} />} loading={loading} disabled={!current} onClick={() => void refresh()}>刷新</Button>
  </Flex>}>
    <Flex vertical gap={12}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        列出已授权该项目的全部本机 Bridge。成员在「我的设备」中开启「允许团队派发」后，项目负责人、PM 和管理员可以在任务的“本地 AI 执行”里选择他的设备；开发任务需要先指派给该成员，并由他在本机确认后才会执行。
      </Typography.Paragraph>
      <Table<TeamAgent> rowKey="id" size="middle" columns={columns} dataSource={agents} loading={loading} pagination={agents.length > 8 ? { pageSize: 8, showSizeChanger: false } : false} scroll={{ x: 720 }} locale={{ emptyText: '该项目还没有成员接入本机 Bridge。' }} />
    </Flex>
  </Card>;
};

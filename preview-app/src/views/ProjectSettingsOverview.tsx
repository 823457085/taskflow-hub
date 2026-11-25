import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Input, Space, Table, Tag, Typography } from 'antd';
import { RefreshCw, Search } from 'lucide-react';
import { connectorStatusLabel, roleLabel } from './displayLabels';
import { api, ApiError } from './workspaceApi';
import type { ConnectorSummary, Project, ProjectMember } from './workspaceApi';

type SettingsSection = 'members' | 'connections';
type SummaryItem = { key: string; label: string; status?: string };
type Summary = { items: SummaryItem[]; error?: string };

const COLUMNS = {
  members: { title: '成员', action: '查看成员', unit: '人' },
  connections: { title: '平台连接状态', action: '打开平台读取', unit: '个平台' },
};

async function readSummary(section: SettingsSection, projectId: string): Promise<SummaryItem[]> {
  const id = encodeURIComponent(projectId);
  if (section === 'members') {
    const { members } = await api<{ members: ProjectMember[] }>(`projects/${id}/members`);
    return members.map(member => ({ key: member.id, label: `${member.username} · ${roleLabel(member.role)}` }));
  }
  const { connectors } = await api<{ connectors: ConnectorSummary[] }>(`connectors?projectId=${id}`);
  return connectors.map(connector => ({
    key: connector.provider, label: `${connector.name} · ${connectorStatusLabel(connector.status)}`, status: connector.status,
  }));
}

export function ProjectSettingsOverview({ section, userId, projects, onPickProject, onUnauthorized }: {
  section: SettingsSection;
  userId: string;
  projects: Project[];
  onPickProject: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ scope: string; summaries: Map<string, Summary> }>();
  const scope = JSON.stringify([userId, section, attempt, projects.map(project => project.id)]);
  const latest = useRef(scope);
  const unauthorized = useRef(onUnauthorized);
  latest.current = scope;
  unauthorized.current = onUnauthorized;
  const summaries = result?.scope === scope ? result.summaries : undefined;
  const loading = !!projects.length && !summaries;

  useEffect(() => {
    let active = true;
    const current = () => active && latest.current === scope;
    const read = async () => {
      const results = new Map<string, Summary>();
      for (let offset = 0; offset < projects.length; offset += 6) {
        const batch = projects.slice(offset, offset + 6);
        const entries = await Promise.allSettled(batch.map(project => readSummary(section, project.id)));
        if (!current()) return;
        for (const [i, entry] of entries.entries()) {
          if (entry.status === 'fulfilled') results.set(batch[i].id, { items: entry.value });
          else if (entry.reason instanceof ApiError && entry.reason.status === 401) {
            unauthorized.current();
            return;
          } else {
            results.set(batch[i].id, { items: [], error: entry.reason instanceof Error ? entry.reason.message : undefined });
          }
        }
      }
      if (current()) setResult({ scope, summaries: results });
    };
    void read();
    return () => { active = false; };
  }, [scope]);

  const definition = COLUMNS[section];
  const matched = query.trim().toLowerCase();
  const rows = projects.filter(project => `${project.key} ${project.name}`.toLowerCase().includes(matched));

  return <Card className="tf-settings-overview" size="small" title={
    <Input aria-label="搜索项目" placeholder="搜索项目编号或名称" allowClear prefix={<Search size={15} />}
      style={{ width: 'min(100%, 280px)' }} value={query} onChange={event => setQuery(event.target.value)} />
  } extra={<Button size="small" icon={<RefreshCw size={15} />} loading={loading} onClick={() => setAttempt(value => value + 1)}>刷新</Button>}>
    <Table<Project> size="small" rowKey="id" loading={loading} dataSource={rows}
      scroll={{ x: 640 }} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={projects.length ? '没有匹配的项目' : '尚无可访问的项目'} /> }}
      columns={[
        { title: '项目', key: 'project', width: 240, render: (_, project) => <Typography.Text>{project.key} · {project.name}</Typography.Text> },
        { title: '我的角色', key: 'role', width: 110, render: (_, project) => roleLabel(project.role) },
        { title: definition.title, key: 'summary', render: (_, project) => {
          const summary = summaries?.get(project.id);
          if (!summary) return '—';
          if (summary.error) return <Typography.Text type="secondary">{summary.error}</Typography.Text>;
          const { items } = summary;
          return <Space size={[6, 6]} wrap>
            <Typography.Text type="secondary">{items.length} {definition.unit}</Typography.Text>
            {items.slice(0, 6).map(item => <Tag key={item.key} color={item.status === 'CONNECTED' ? 'green' : item.status === 'ERROR' ? 'red' : undefined}>{item.label}</Tag>)}
          </Space>;
        } },
        { title: '操作', key: 'action', width: 138, render: (_, project) => <Button type="link" size="small"
          aria-label={`${project.key} · ${definition.action}`} onClick={() => onPickProject(project.id)}>{definition.action}</Button> },
      ]} />
  </Card>;
}

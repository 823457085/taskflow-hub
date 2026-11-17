import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Collapse, Empty, Flex, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { ChevronLeft, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { api, ApiError, Project, ProjectMember, User } from './workspaceApi';
import { openTaskRoute } from './workspaceNavigation';

type Section = 'completed' | 'doing' | 'review' | 'blocked' | 'todo';
export interface ReportItem {
  source: 'task' | 'todo' | 'run'; id: string; taskId: string | null; jiraKey: string | null; title: string; status: string;
  detail: string; dueDate?: string; priority?: string; personal?: boolean; updatedAt: string;
}
export interface ReportProgress { id: string; taskId: string; jiraKey: string; title: string; tool: string; progress: number; summary: string; branch: string | null; createdAt: string }
export interface MemberReport {
  member: { id: string; username: string; role: string };
  sections: Record<Section, ReportItem[]>; counts: Record<Section, number>; progress: ReportProgress[];
}
export interface WorkReport { projectId: string; date: string; scope: 'member' | 'team'; generatedAt: string; canViewOthers: boolean; members: MemberReport[] }

const TEAM = '__team__';
const SECTIONS: Section[] = ['completed', 'doing', 'review', 'blocked', 'todo'];
const SECTION_LABELS: Record<Section, string> = { completed: '今天已完成', doing: '正在进行', review: '需要确认', blocked: '卡住了，需要处理', todo: '接下来要做' };
const SECTION_COLORS: Record<Section, string> = { completed: 'success', doing: 'processing', review: 'purple', blocked: 'error', todo: 'default' };
const SOURCE_LABELS: Record<ReportItem['source'], string> = { task: '任务', todo: '待办', run: 'AI 执行' };
const localDate = (time = new Date()) => `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
const shiftDate = (date: string, days: number) => { const [year, month, day] = date.split('-').map(Number); return localDate(new Date(year, month - 1, day + days)); };
const itemLine = (item: ReportItem) => [item.jiraKey && item.source !== 'run' ? item.jiraKey : '', item.title].filter(Boolean).join(' ');

export function reportText(report: WorkReport, projectKey: string) {
  const lines = [`【工作日报】${projectKey} ${report.date}`];
  for (const { member, sections, counts, progress } of report.members) {
    lines.push('', `## ${member.username}`);
    let empty = true;
    for (const name of SECTIONS) {
      if (!counts[name]) continue;
      empty = false;
      lines.push(`${SECTION_LABELS[name]}（${counts[name]}）`);
      for (const item of sections[name]) lines.push(`- ${itemLine(item)}${item.detail ? `：${item.detail.split(/\r?\n/)[0]}` : ''}`);
      if (counts[name] > sections[name].length) lines.push(`- 另有 ${counts[name] - sections[name].length} 项未列出`);
    }
    if (progress.length) {
      empty = false;
      lines.push('今日进展');
      for (const entry of progress) lines.push(`- ${entry.jiraKey} ${entry.summary.split(/\r?\n/)[0]}（${entry.progress}%）`);
    }
    if (empty) lines.push('暂无记录');
  }
  return lines.join('\n');
}

async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
  const area = document.createElement('textarea');
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select();
  try { if (!document.execCommand('copy')) throw new Error('浏览器不允许复制，请手动选择文本。'); } finally { area.remove(); }
}

const MemberSections: React.FC<{ report: MemberReport }> = ({ report }) => {
  const filled = SECTIONS.filter(name => report.counts[name]);
  if (!filled.length && !report.progress.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这一天没有任务、待办或 AI 执行记录。" />;
  return (
    <Flex vertical gap={16}>
      {filled.map(name => (
        <div key={name}>
          <Space size={8} style={{ marginBottom: 6 }}><Tag color={SECTION_COLORS[name]}>{SECTION_LABELS[name]}</Tag><Typography.Text type="secondary">{report.counts[name]} 项</Typography.Text></Space>
          <Flex vertical gap={4}>
            {report.sections[name].map(item => (
              <Flex key={`${item.source}:${item.id}`} gap={8} align="baseline" wrap>
                <Tag bordered={false}>{item.personal ? '个人待办' : SOURCE_LABELS[item.source]}</Tag>
                {item.taskId ? <Typography.Link onClick={() => openTaskRoute(item.taskId!, { from: 'reports' })}>{itemLine(item)}</Typography.Link> : <Typography.Text>{itemLine(item)}</Typography.Text>}
                {item.priority === 'high' ? <Tag color="red">高</Tag> : null}
                {item.detail ? <Typography.Text type="secondary" ellipsis style={{ maxWidth: 520 }}>{item.detail}</Typography.Text> : null}
              </Flex>
            ))}
            {report.counts[name] > report.sections[name].length ? <Typography.Text type="secondary">另有 {report.counts[name] - report.sections[name].length} 项未列出</Typography.Text> : null}
          </Flex>
        </div>
      ))}
      {report.progress.length ? (
        <div>
          <Space size={8} style={{ marginBottom: 6 }}><Tag color="cyan">今日进展</Tag><Typography.Text type="secondary">本机 AI 通过 MCP 回报</Typography.Text></Space>
          <Flex vertical gap={4}>
            {report.progress.map(entry => (
              <Flex key={entry.id} gap={8} align="baseline" wrap>
                <Typography.Link onClick={() => openTaskRoute(entry.taskId, { tab: 'activity', from: 'reports' })}>{entry.jiraKey}</Typography.Link>
                <Typography.Text>{entry.summary.split(/\r?\n/)[0]}</Typography.Text>
                <Typography.Text type="secondary">{entry.progress}% · {entry.tool} · {new Date(entry.createdAt).toLocaleTimeString()}</Typography.Text>
              </Flex>
            ))}
          </Flex>
        </div>
      ) : null}
    </Flex>
  );
};

const countTags = (report: MemberReport) => SECTIONS.filter(name => report.counts[name]).map(name => <Tag key={name} color={SECTION_COLORS[name]}>{SECTION_LABELS[name]} {report.counts[name]}</Tag>);

export const WorkReportsView: React.FC<{
  user: User; projects: Project[]; projectId: string; members: ProjectMember[]; canViewOthers: boolean; onUnauthorized: () => void;
}> = ({ user, projects, projectId, members, canViewOthers, onUnauthorized }) => {
  const { message } = App.useApp();
  const [date, setDate] = useState(localDate);
  const [target, setTarget] = useState(user.id);
  const [report, setReport] = useState<WorkReport | null>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const projectKey = projects.find(project => project.id === projectId)?.key || projectId;

  const refresh = async () => {
    if (!projectId) { setReport(null); return; }
    const request = ++sequence.current;
    setLoading(true);
    const query = new URLSearchParams({ projectId, date, tzOffset: String(-new Date().getTimezoneOffset()) });
    if (target === TEAM) query.set('scope', 'team'); else if (target !== user.id) query.set('memberId', target);
    try {
      const data = await api<{ report: WorkReport }>(`work-reports?${query}`);
      if (request === sequence.current) setReport(data.report);
    } catch (error) {
      if (request !== sequence.current) return;
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      setReport(null);
      void message.error(error instanceof Error ? error.message : '报告生成失败。');
    } finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setReport(null); void refresh(); }, [projectId, date, target, user.id]);
  useEffect(() => { if (!canViewOthers) setTarget(user.id); }, [canViewOthers, user.id]);

  const copy = async () => {
    if (!report) return;
    try { await copyText(reportText(report, projectKey)); void message.success('日报已复制，可以直接粘贴到群里。'); }
    catch (error) { void message.error(error instanceof Error ? error.message : '复制失败。'); }
  };
  const today = localDate();
  const targetOptions = [
    { value: user.id, label: `${user.username}（我）` },
    ...members.filter(member => member.id !== user.id).map(member => ({ value: member.id, label: member.username })),
    { value: TEAM, label: '全员汇总' },
  ];

  return (
    <Flex vertical gap={16}>
      <Card size="small">
        <Flex gap={12} align="center" wrap justify="space-between">
          <Space wrap>
            <Button aria-label="前一天" icon={<ChevronLeft size={14} />} onClick={() => setDate(shiftDate(date, -1))} />
            <Input type="date" aria-label="报告日期" value={date} max={today} onChange={event => event.target.value && setDate(event.target.value)} style={{ width: 160 }} />
            <Button aria-label="后一天" icon={<ChevronRight size={14} />} disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))} />
            {date !== today ? <Button onClick={() => setDate(today)}>回到今天</Button> : null}
            {canViewOthers ? <Select aria-label="报告对象" value={target} onChange={setTarget} options={targetOptions} style={{ minWidth: 160 }} /> : null}
          </Space>
          <Space>
            <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
            <Button type="primary" icon={<Copy size={14} />} disabled={!report} onClick={() => void copy()}>复制为文本</Button>
          </Space>
        </Flex>
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          根据任务、待办、本机 AI 执行记录和 MCP 回报的进展自动生成。“今天已完成”和“今日进展”按所选日期统计；进行中、待确认和待处理是当前状态。个人待办只出现在本人的报告里。
          {canViewOthers ? '' : '项目负责人、PM 和管理员可以查看其他成员和全员汇总。'}
        </Typography.Paragraph>
      </Card>
      {!projectId ? <Empty description="请先选择项目。" /> : !report ? <Card><Flex justify="center" style={{ padding: 32 }}>{loading ? <Spin /> : <Empty description="暂无报告。" />}</Flex></Card>
        : report.scope === 'team' ? (
          <Collapse defaultActiveKey={report.members.filter(item => SECTIONS.some(name => item.counts[name]) || item.progress.length).map(item => item.member.id)}
            items={report.members.map(item => ({ key: item.member.id, label: <Space wrap><Typography.Text strong>{item.member.username}</Typography.Text>{countTags(item)}{!SECTIONS.some(name => item.counts[name]) && !item.progress.length ? <Typography.Text type="secondary">暂无记录</Typography.Text> : null}</Space>, children: <MemberSections report={item} /> }))} />
        ) : report.members.map(item => (
          <Card key={item.member.id} title={<Space wrap><span>{item.member.username} · {report.date}</span>{countTags(item)}</Space>}>
            <MemberSections report={item} />
          </Card>
        ))}
    </Flex>
  );
};

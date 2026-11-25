import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Empty, Flex, Input, Pagination, Select, Space, Spin, Tag, Typography } from 'antd';
import { ChevronLeft, ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { api, ApiError, Project, ProjectMember, User } from './workspaceApi';
import { readProjectRecords } from './readProjectRecords';
import { openTaskRoute } from './workspaceNavigation';
import { progressSourceLabel } from './displayLabels';
import { LinkifiedText } from './MarkdownPreview';
import './WorkspaceRecords.css';

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
const PAGE_SIZE = 8;
const SECTIONS: Section[] = ['completed', 'doing', 'review', 'blocked', 'todo'];
const SECTION_LABELS: Record<Section, string> = { completed: '当日完成', doing: '正在进行', review: '需要确认', blocked: '受阻', todo: '待开始' };
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
      lines.push('当日进展');
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
    <div className="tf-report-sections">
      {filled.map(name => (
        <section className="tf-report-section" key={name}>
          <Space size={[8, 4]} wrap><Tag color={SECTION_COLORS[name]}>{SECTION_LABELS[name]}</Tag><Typography.Text type="secondary">{report.counts[name]} 项</Typography.Text></Space>
          <Flex vertical gap={8}>
            {report.sections[name].map(item => (
              <Flex key={`${item.source}:${item.id}`} vertical gap={2}>
                <Flex gap="4px 8px" align="baseline" wrap>
                  <Typography.Text type="secondary">{item.personal ? '个人待办' : SOURCE_LABELS[item.source]}</Typography.Text>
                  {item.taskId ? <Button size="small" type="link" className="tf-reading-title" onClick={() => openTaskRoute(item.taskId!, { from: 'reports' })}>{itemLine(item)}</Button> : <Typography.Text>{itemLine(item)}</Typography.Text>}
                  {item.priority === 'high' ? <Tag color="red">高</Tag> : null}
                </Flex>
                {item.detail ? <Typography.Text type="secondary" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><LinkifiedText text={item.detail} /></Typography.Text> : null}
              </Flex>
            ))}
            {report.counts[name] > report.sections[name].length ? <Typography.Text type="secondary">另有 {report.counts[name] - report.sections[name].length} 项未列出</Typography.Text> : null}
          </Flex>
        </section>
      ))}
      {report.progress.length ? (
        <section className="tf-report-section tf-report-progress">
          <Typography.Title level={5}>当日进展</Typography.Title>
          <Flex vertical gap={8}>
            {report.progress.map(entry => (
              <Flex key={entry.id} vertical gap={2}>
                <Space size={[8, 4]} wrap>
                  <Button size="small" type="link" className="tf-reading-title" onClick={() => openTaskRoute(entry.taskId, { tab: 'activity', from: 'reports' })}>{entry.jiraKey}</Button>
                  <Typography.Text type="secondary">{entry.progress}% · {progressSourceLabel(entry.tool)} · {new Date(entry.createdAt).toLocaleTimeString()}</Typography.Text>
                </Space>
                <Typography.Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><LinkifiedText text={entry.summary} /></Typography.Text>
              </Flex>
            ))}
          </Flex>
        </section>
      ) : null}
    </div>
  );
};

const hasRecords = (report: MemberReport) => SECTIONS.some(name => report.counts[name]) || report.progress.length > 0;

function uniquePersonalTodos(reports: WorkReport[]): WorkReport[] {
  const personalIds = new Set<string>();
  return reports.map(report => ({
    ...report,
    members: report.members.map(member => {
      const counts = { ...member.counts };
      const sections = { ...member.sections };
      for (const name of SECTIONS) {
        sections[name] = sections[name].filter(item => {
          if (!item.personal) return true;
          if (personalIds.has(item.id)) { counts[name] -= 1; return false; }
          personalIds.add(item.id);
          return true;
        });
      }
      return { ...member, counts, sections };
    }),
  }));
}

export const WorkReportsView: React.FC<{
  user: User; projects: Project[]; projectId: string; members: ProjectMember[]; canViewOthers: boolean; onUnauthorized: () => void;
}> = ({ user, projects, projectId, members, canViewOthers, onUnauthorized }) => {
  const { message } = App.useApp();
  const [date, setDate] = useState(localDate);
  const [target, setTarget] = useState(user.id);
  const [reports, setReports] = useState<WorkReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const sequence = useRef(0);
  const canViewTeam = projectId ? canViewOthers : projects.some(project => project.permissions?.assignTasks);
  const selectedTarget = (target === TEAM && canViewTeam) || (projectId && canViewOthers && members.some(member => member.id === target)) ? target : user.id;
  const projectKey = (id: string) => projects.find(project => project.id === id)?.key || id;

  const refresh = async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const results = await readProjectRecords(projectId ? [projectId] : projects.map(project => project.id), async id => {
        const query = new URLSearchParams({ projectId: id, date, tzOffset: String(-new Date().getTimezoneOffset()) });
        const canReadProjectTeam = projectId ? canViewOthers : projects.find(project => project.id === id)?.permissions?.assignTasks;
        if (selectedTarget === TEAM && canReadProjectTeam) query.set('scope', 'team');
        else if (selectedTarget !== TEAM && selectedTarget !== user.id) query.set('memberId', selectedTarget);
        return (await api<{ report: WorkReport }>(`work-reports?${query}`)).report;
      });
      if (request === sequence.current) setReports(projectId ? results : uniquePersonalTodos(results));
    } catch (error) {
      if (request !== sequence.current) return;
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      setReports([]);
      void message.error(error instanceof Error ? error.message : '报告生成失败。');
    } finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setReports([]); setPage(1); void refresh(); return () => { sequence.current += 1; }; }, [projectId, projects, date, selectedTarget, user.id]);
  useEffect(() => { if (!canViewTeam) setTarget(user.id); }, [canViewTeam, user.id]);

  const shownReports = projectId ? reports : reports.filter(report => report.members.some(hasRecords));
  const cards = shownReports.flatMap(report => {
    const visible = report.scope === 'team' || !projectId ? report.members.filter(hasRecords) : report.members;
    return visible.map(item => ({ projectId: report.projectId, item }));
  });
  const currentPage = Math.min(page, Math.max(1, Math.ceil(cards.length / PAGE_SIZE)));
  const visibleCards = projectId ? cards : cards.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const membersWithoutRecords = projectId && reports[0]?.scope === 'team' ? reports[0].members.filter(item => !hasRecords(item)) : [];
  const copy = async () => {
    if (!shownReports.length) return;
    try { await copyText(shownReports.map(report => reportText(report, projectKey(report.projectId))).join('\n\n')); void message.success('日报已复制，可以直接粘贴到群里。'); }
    catch (error) { void message.error(error instanceof Error ? error.message : '复制失败。'); }
  };
  const today = localDate();
  const targetOptions = [
    { value: user.id, label: `${user.username}（我）` },
    ...(projectId ? members.filter(member => member.id !== user.id).map(member => ({ value: member.id, label: member.username })) : []),
    { value: TEAM, label: '全员汇总' },
  ];

  return (
    <div className="tf-record-workspace">
      <div className="tf-record-toolbar">
        <div className="tf-record-filters tf-report-filters">
          <Space.Compact>
            <Button aria-label="前一天" icon={<ChevronLeft size={14} />} onClick={() => setDate(shiftDate(date, -1))} />
            <Input type="date" aria-label="报告日期" title="完成与进展按所选日期统计，其余栏目显示当前状态" value={date} max={today} onChange={event => event.target.value && setDate(event.target.value)} style={{ width: 160 }} />
            <Button aria-label="后一天" icon={<ChevronRight size={14} />} disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))} />
          </Space.Compact>
          <div className="tf-record-filters">
            {date !== today ? <Button onClick={() => setDate(today)}>回到今天</Button> : null}
            {canViewTeam ? <Select aria-label="报告对象" value={selectedTarget} onChange={setTarget} options={targetOptions} style={{ minWidth: 160 }} /> : null}
          </div>
        </div>
        <div className="tf-record-actions">
          <Button icon={<RefreshCw size={14} />} loading={loading} aria-label="刷新工作报告" title="刷新工作报告" onClick={() => void refresh()} />
          <Button type="primary" icon={<Copy size={14} />} disabled={!shownReports.length} onClick={() => void copy()}>复制报告</Button>
        </div>
      </div>
      {!shownReports.length ? (
        <div className="tf-record-table"><Flex justify="center" style={{ padding: 24 }}>{loading ? <Spin /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无报告" />}</Flex></div>
      ) : <>
          {projectId && !reports[0]?.members.length && <Empty description="暂无成员报告。" />}
          {visibleCards.map(({ projectId: reportProjectId, item }) => (
            <Card className="tf-report-card" key={reportProjectId + ':' + item.member.id} size="small"
              title={projectId ? item.member.username : <Space size={6}><Tag>{projectKey(reportProjectId)}</Tag>{item.member.username}</Space>}>
              <MemberSections report={item} />
            </Card>
          ))}
          {membersWithoutRecords.length > 0 && <Typography.Text type="secondary">暂无记录的成员：{membersWithoutRecords.map(item => item.member.username).join('、')}</Typography.Text>}
          {!projectId && cards.length > PAGE_SIZE && <Pagination size="small" current={currentPage} onChange={setPage}
            total={cards.length} pageSize={PAGE_SIZE} showSizeChanger={false} />}
        </>}
    </div>
  );
};

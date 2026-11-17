import React, { useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Collapse, Flex, Input, Space, Table, Tag, Timeline, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ChevronRight, Copy, GitBranch, Laptop, Play } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { Device, LocalAiRun, memberName, ProgressEvent, timeText, User } from './workspaceApi';
import { Empty } from './WorkspaceFields';
import { aiRunStatusLabel, heartbeatStatusLabel, progressSourceLabel, toolLabel } from './displayLabels';
import { isSubmitShortcut } from './uiPreferences';

const PROGRESS_PRESETS = [25, 50, 75, 90, 100] as const;
const RECENT_EVENT_LIMIT = 10;

export const TaskActivityPanel: React.FC<{
  taskProgress: number; members: User[]; progressEvents: ProgressEvent[]; devices: Device[]; aiRuns: LocalAiRun[];
  branch?: string | null; canReport: boolean; busy: boolean;
  onReport: (progress: number, summary: string) => Promise<boolean>;
  onStartLocalAi: () => void;
  onOpenReview: (jobId: string) => void;
}> = ({ taskProgress, members, progressEvents, devices, aiRuns, branch, canReport, busy, onReport, onStartLocalAi, onOpenReview }) => {
  const { message } = AntApp.useApp();
  const [progress, setProgress] = useState(taskProgress);
  const [summary, setSummary] = useState('');
  const [reporting, setReporting] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  useEffect(() => { setProgress(taskProgress); }, [taskProgress]);

  const submit = async () => {
    if (!canReport || reporting || busy) return;
    if (!summary.trim()) { void message.warning('请简要填写本轮开发进展说明。'); return; }
    setReporting(true);
    try { if (await onReport(progress, summary.trim())) setSummary(''); }
    finally { setReporting(false); }
  };

  const activeBranch = branch && branch !== 'HEAD' ? branch : '';
  const deviceColumns: TableColumnsType<Device> = [
    { title: '设备 / 工具', key: 'device', render: (_, item) => <div className="tf-table-title"><Space size={8}><Laptop size={16} /><Typography.Text strong>{toolLabel(item.tool)}</Typography.Text></Space><Typography.Text type="secondary" className="tf-break"><code>{item.deviceId}</code></Typography.Text></div> },
    { title: '成员', width: 140, render: (_, item) => memberName(members, item.actorId) },
    { title: '最近心跳', width: 180, render: (_, item) => timeText(item.lastSeen) },
    { title: '状态', width: 130, render: (_, item) => <StatusBadge variant={item.online ? 'green' : 'neutral'}>{heartbeatStatusLabel(item.status)}</StatusBadge> },
  ];
  const onlineCount = devices.filter(item => item.online).length;

  return <div className="tf-detail-stack">
    <Card title={<Space size={8}><span>进度事件</span>{progressEvents.length > 0 && <Typography.Text type="secondary" className="tf-card-subtitle">{progressEvents.length} 条 · 当前自报 {taskProgress}%</Typography.Text>}</Space>}>
      <div className="tf-detail-stack">
        {canReport && (
          <div className="tf-progress-reporter">
            <Flex vertical gap={8}>
              <Flex justify="space-between" align="center" gap={8} wrap>
                <Space size={8} wrap>
                  <Typography.Text strong>记录开发进度</Typography.Text>
                  <Input
                    type="number"
                    size="small"
                    min={0}
                    max={100}
                    aria-label="进度百分比"
                    value={progress}
                    disabled={reporting || busy}
                    onChange={event => {
                      const next = Number(event.target.value);
                      if (!Number.isNaN(next)) setProgress(Math.max(0, Math.min(100, Math.round(next))));
                    }}
                    suffix="%"
                    style={{ width: 88 }}
                  />
                  {PROGRESS_PRESETS.map(pct => (
                    <Tag key={pct} color={progress === pct ? 'blue' : undefined} style={{ cursor: 'pointer', marginInlineEnd: 0 }} onClick={() => setProgress(pct)}>{pct}%</Tag>
                  ))}
                </Space>
                {activeBranch && <Space size={4}><GitBranch size={13} /><Typography.Text type="secondary" code style={{ fontSize: 12 }}>{activeBranch}</Typography.Text></Space>}
              </Flex>
              <Flex gap={8} align="start" wrap>
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  aria-label="开发进展说明"
                  placeholder="填写阶段性进展、关键改动或联调结果（按 Cmd/Ctrl + Enter 快速记录）"
                  value={summary}
                  disabled={reporting || busy}
                  style={{ flex: '1 1 320px' }}
                  onChange={event => setSummary(event.target.value)}
                  onKeyDown={event => { if (isSubmitShortcut(event)) { event.preventDefault(); void submit(); } }}
                />
                <Button type="primary" loading={reporting} disabled={busy || !summary.trim()} onClick={() => void submit()}>记录进度</Button>
              </Flex>
            </Flex>
          </div>
        )}
        {progressEvents.length ? <Timeline items={(showAllEvents ? progressEvents : progressEvents.slice(0, RECENT_EVENT_LIMIT)).map(event => ({
          content: <div>
            <Flex justify="space-between" gap={12} wrap><Typography.Text strong>{memberName(members, event.actorId)} · {progressSourceLabel(event.tool, event.deviceId)}</Typography.Text><Typography.Text type="secondary">自报 {event.progress}% · {timeText(event.createdAt)}</Typography.Text></Flex>
            <Typography.Paragraph className="tf-preserve tf-meta-line">{event.summary}</Typography.Paragraph>
            {event.branch && <Typography.Text type="secondary" className="tf-break"><Space size={8}><GitBranch size={14} /><code>{event.branch}</code></Space></Typography.Text>}
          </div>,
        }))} /> : <Empty>尚无进度事件。自报进度不构成测试或门禁通过证据。</Empty>}
        {progressEvents.length > RECENT_EVENT_LIMIT && <Button type="link" size="small" style={{ justifySelf: 'start', paddingInline: 0 }} onClick={() => setShowAllEvents(value => !value)}>{showAllEvents ? '收起，只看最近 ' + RECENT_EVENT_LIMIT + ' 条' : `查看全部 ${progressEvents.length} 条进度`}</Button>}
      </div>
    </Card>

    <Card
      title={`本机 AI 执行记录 (${aiRuns.length})`}
      extra={<Space size={6} wrap>
        <Button size="small" type="primary" icon={<Play size={14} />} disabled={busy} onClick={onStartLocalAi}>启动本地 AI</Button>
        <Button size="small" type="text" onClick={() => { location.hash = 'view=local'; }}>本机接入配置<ChevronRight size={14} /></Button>
      </Space>}
    >
      {aiRuns.length ? (
        <Collapse items={aiRuns.map(item => ({
          key: item.id,
          label: <Space size={8} wrap>
            <StatusBadge variant={item.status === 'SUCCEEDED' ? 'green' : item.status === 'RUNNING' ? 'blue' : item.status === 'FAILED' ? 'block' : 'neutral'}>{aiRunStatusLabel(item.status)}</StatusBadge>
            <Typography.Text strong>{item.mode === 'read' ? '任务分析' : item.mode === 'develop' ? '开发协作' : '本地评审'}</Typography.Text>
            <Tag>{toolLabel(item.engine)}</Tag>
            <Typography.Text type="secondary">{timeText(item.startedAt)}</Typography.Text>
          </Space>,
          children: <div className="tf-detail-stack tf-detail-stack-small">
            {item.error && <Alert type="warning" showIcon title={item.error} />}
            <Flex justify="space-between" align="center" gap={8} wrap>
              {item.jobId ? <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={() => onOpenReview(item.jobId!)}>查看关联评审记录</Button> : <span />}
              {item.output && (
                <Button size="small" icon={<Copy size={13} />} onClick={() => {
                  void navigator.clipboard.writeText(item.output).then(() => message.success('AI 执行输出已复制。')).catch(() => message.warning('浏览器未能复制，请手动选择复制。'));
                }}>复制输出</Button>
              )}
            </Flex>
            <pre className="tf-code-panel">{item.output || '（无输出）'}</pre>
          </div>,
        }))} />
      ) : <Empty>尚无本机 AI 执行记录。点击「启动本地 AI」即可在本机运行 Codex / Gemini / Cursor / Claude。</Empty>}
    </Card>

    <Collapse className="tf-device-collapse" items={[{
      key: 'devices',
      label: <Space size={8}><span>设备心跳</span><Typography.Text type="secondary">{devices.length ? `${onlineCount} / ${devices.length} 在线` : '暂无'}</Typography.Text></Space>,
      children: <Table<Device> rowKey={device => device.actorId + ':' + device.deviceId} dataSource={devices} columns={deviceColumns} size="middle" pagination={false} scroll={{ x: 680 }} locale={{ emptyText: <Empty>尚无设备心跳。在线状态按服务接收时间计算，超过 90 秒未上报会离线。</Empty> }} />,
    }]} />
  </div>;
};

import React, { useEffect, useState } from 'react';
import { App as AntApp, Button, Input, Pagination, Tooltip } from 'antd';
import { ChevronRight, Copy, GitBranch, Laptop, Play } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { Device, LocalAiRun, memberName, ProgressEvent, timeText, User } from './workspaceApi';
import { Empty } from './WorkspaceFields';
import { aiRunStatusLabel, heartbeatStatusLabel, progressSourceLabel, toolLabel } from './displayLabels';
import { AiRunIdentity } from './LocalAiExecutionFields';
import { isSubmitShortcut } from './uiPreferences';
import { navigateWorkspace } from './workspaceNavigation';
import { LinkifiedText } from './MarkdownPreview';

const PROGRESS_PRESETS = [25, 50, 75, 90, 100] as const;
const EVENT_PAGE_SIZE = 4;
const RUN_PAGE_SIZE = 3;
const DEVICE_PAGE_SIZE = 4;

export const TaskActivityPanel: React.FC<{
  taskProgress: number; members: User[]; progressEvents: ProgressEvent[]; devices: Device[]; aiRuns: LocalAiRun[];
  branch?: string | null; canReport: boolean; busy: boolean;
  onReport: (progress: number, summary: string) => Promise<boolean>;
  onStartLocalAi?: () => void;
  onOpenReview: (jobId: string) => void;
}> = ({ taskProgress, members, progressEvents, devices, aiRuns, branch, canReport, busy, onReport, onStartLocalAi, onOpenReview }) => {
  const { message } = AntApp.useApp();
  const [progress, setProgress] = useState(taskProgress);
  const [summary, setSummary] = useState('');
  const [reporting, setReporting] = useState(false);
  const [eventPage, setEventPage] = useState(1);
  const [runPage, setRunPage] = useState(1);
  const [devicePage, setDevicePage] = useState(1);
  const currentEventPage = Math.min(eventPage, Math.max(1, Math.ceil(progressEvents.length / EVENT_PAGE_SIZE)));
  const currentRunPage = Math.min(runPage, Math.max(1, Math.ceil(aiRuns.length / RUN_PAGE_SIZE)));
  const currentDevicePage = Math.min(devicePage, Math.max(1, Math.ceil(devices.length / DEVICE_PAGE_SIZE)));
  useEffect(() => { setProgress(taskProgress); }, [taskProgress]);

  const submit = async () => {
    if (!canReport || reporting || busy) return;
    if (!summary.trim()) { void message.warning('请简要填写本轮开发进展说明。'); return; }
    setReporting(true);
    try { if (await onReport(progress, summary.trim())) setSummary(''); }
    finally { setReporting(false); }
  };

  const activeBranch = branch && branch !== 'HEAD' ? branch : '';
  const onlineCount = devices.filter(item => item.online).length;

  return (
    <div className="tf-task-activity">
      <div className="tf-task-activity-layout">
        <section className="tf-record-section" aria-label="进度记录">
          <header className="tf-record-section-header">
            <h3>进度记录</h3>
            <span className="tf-record-meta">{progressEvents.length} 条 · 当前 {taskProgress}%</span>
          </header>
          {canReport && (
            <div className="tf-record-reporter">
              <div className="tf-record-progress-presets">
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
                />
                {PROGRESS_PRESETS.map(percent => (
                  <Button
                    size="small"
                    key={percent}
                    type={progress === percent ? 'primary' : 'default'}
                    aria-pressed={progress === percent}
                    disabled={reporting || busy}
                    onClick={() => setProgress(percent)}
                  >{percent}%</Button>
                ))}
              </div>
              <div className="tf-record-progress-form">
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  aria-label="开发进展说明"
                  placeholder="填写本轮进展"
                  value={summary}
                  disabled={reporting || busy}
                  onChange={event => setSummary(event.target.value)}
                  onKeyDown={event => { if (isSubmitShortcut(event)) { event.preventDefault(); void submit(); } }}
                />
                <Button type="primary" loading={reporting} disabled={busy || !summary.trim()} onClick={() => void submit()}>记录进度</Button>
              </div>
            </div>
          )}
          {activeBranch && (
            <div className="tf-record-branch" title={activeBranch}>
              <GitBranch size={13} /><span className="tf-record-ellipsis">{activeBranch}</span>
            </div>
          )}
          {progressEvents.length ? (
            <ul className="tf-record-list">
              {progressEvents.slice((currentEventPage - 1) * EVENT_PAGE_SIZE, currentEventPage * EVENT_PAGE_SIZE).map(event => (
                <li key={event.id} className="tf-record-row">
                  <div className="tf-record-row-heading">
                    <strong className="tf-record-ellipsis">{memberName(members, event.actorId)} · {progressSourceLabel(event.tool, event.deviceId)}</strong>
                    <span className="tf-record-meta">{event.progress}% · {timeText(event.createdAt)}</span>
                  </div>
                  <p className="tf-record-notes" tabIndex={0}><LinkifiedText text={event.summary} /></p>
                  {event.branch && (
                    <div className="tf-record-branch" title={event.branch}>
                      <GitBranch size={13} /><span className="tf-record-ellipsis">{event.branch}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : <Empty>暂无进度记录。</Empty>}
          <Pagination className="tf-record-pagination" current={currentEventPage} pageSize={EVENT_PAGE_SIZE} total={progressEvents.length}
            showSizeChanger={false} hideOnSinglePage size="small" onChange={setEventPage} />
        </section>

        <div className="tf-record-stack">
          <section className="tf-record-section" aria-label="本机执行记录">
            <header className="tf-record-section-header">
              <h3>本机执行 <span className="tf-record-meta">{aiRuns.length}</span></h3>
              <div className="tf-record-actions">
                {onStartLocalAi && <Tooltip title="启动本地 AI">
                  <Button size="small" type="primary" icon={<Play size={14} />} aria-label="启动本地 AI" disabled={busy} onClick={onStartLocalAi} />
                </Tooltip>}
                <Button size="small" type="text" onClick={() => navigateWorkspace('local')}>接入配置<ChevronRight size={13} /></Button>
              </div>
            </header>
            {aiRuns.length ? (
              <ul className="tf-record-list">
                {aiRuns.slice((currentRunPage - 1) * RUN_PAGE_SIZE, currentRunPage * RUN_PAGE_SIZE).map(item => (
                  <li key={item.id} className="tf-record-row">
                    <div className="tf-record-row-heading">
                      <strong>{item.mode === 'read' ? '任务分析' : item.mode === 'develop' ? '开发协作' : '本地评审'}</strong>
                      <StatusBadge variant={item.status === 'SUCCEEDED' ? 'green' : item.status === 'RUNNING' ? 'blue' : item.status === 'FAILED' ? 'block' : 'neutral'}>{aiRunStatusLabel(item.status)}</StatusBadge>
                    </div>
                    <div className="tf-record-row-heading tf-record-run-meta">
                      <div className="tf-record-meta tf-record-ellipsis">
                        <AiRunIdentity run={item} /> · {timeText(item.startedAt)}
                      </div>
                      <div className="tf-record-actions">
                        {item.jobId && <Button size="small" type="link" onClick={() => onOpenReview(item.jobId!)}>查看评审</Button>}
                        {item.output && (
                          <Tooltip title="复制原始输出">
                            <Button size="small" icon={<Copy size={13} />} aria-label="复制原始输出" onClick={() => {
                              void navigator.clipboard.writeText(item.output).then(() => message.success('执行输出已复制。')).catch(() => message.warning('浏览器未能复制。'));
                            }} />
                          </Tooltip>
                        )}
                      </div>
                    </div>
                    {(item.error || item.draft?.summary) && (
                      <div className="tf-record-notes" tabIndex={0}>
                        {item.error && <p className="tf-record-error">{item.error}</p>}
                        {item.draft?.summary && <p><LinkifiedText text={item.draft.summary} /></p>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : <Empty>暂无本机执行记录。</Empty>}
            <Pagination className="tf-record-pagination" current={currentRunPage} pageSize={RUN_PAGE_SIZE} total={aiRuns.length}
              showSizeChanger={false} hideOnSinglePage size="small" onChange={setRunPage} />
          </section>

          <section className="tf-record-section" aria-label="设备">
            <header className="tf-record-section-header">
              <h3>设备</h3>
              {devices.length > 0 && <span className="tf-record-meta">{onlineCount}/{devices.length} 在线</span>}
            </header>
            {devices.length ? (
              <ul className="tf-record-list">
                {devices.slice((currentDevicePage - 1) * DEVICE_PAGE_SIZE, currentDevicePage * DEVICE_PAGE_SIZE).map(item => (
                  <li key={item.actorId + ':' + item.deviceId} className="tf-record-row">
                    <div className="tf-record-row-heading">
                      <strong className="tf-record-device-name tf-record-ellipsis" title={item.deviceId}>
                        <Laptop size={14} /> <span className="tf-record-ellipsis">{toolLabel(item.tool)} · {memberName(members, item.actorId)}</span>
                      </strong>
                      <StatusBadge variant={item.online ? 'green' : 'neutral'}>{heartbeatStatusLabel(item.status)}</StatusBadge>
                    </div>
                    <div className="tf-record-meta tf-record-ellipsis" title={item.deviceId}>
                      {item.deviceId} · 最近心跳 {timeText(item.lastSeen)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty>暂无设备心跳。</Empty>}
            <Pagination className="tf-record-pagination" current={currentDevicePage} pageSize={DEVICE_PAGE_SIZE} total={devices.length}
              showSizeChanger={false} hideOnSinglePage size="small" onChange={setDevicePage} />
          </section>
        </div>
      </div>
    </div>
  );
};

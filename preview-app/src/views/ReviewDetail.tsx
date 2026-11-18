import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Collapse, Descriptions, Flex, Form, Input, Segmented, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircle2, Copy, Download, FileCheck2, Play, Plus, RefreshCw, Sparkles, Square, Trash2, Upload } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import {
  api, ApiError, APPROVE_ROLES, Finding, LocalAiEngineId, LocalAiRun, LocalAutomationCapabilities,
  memberName, REVIEW_ROLES, ReviewJob, Role, timeText, User, WorkTask,
} from './workspaceApi';
import { Empty } from './WorkspaceFields';
import { readTogether } from './readTogether';
import {
  APPROVAL_REASON_PRESETS, assetKindLabel, decisionLabel, DEFAULT_APPROVE_REASON,
  executionModeLabel, formatSubmittedReportMarkdown, gateStatusLabel, personaLabel,
  REJECTION_REASON_PRESETS, REPORT_SUMMARY_PRESETS, REPORT_TOOL_OPTIONS,
  reportSourceLabel, reviewStatusLabel, SEVERITY_OPTIONS, severityLabel,
  skillsLabel, stageLabel, toolLabel, WAIVER_REASON_PRESETS,
} from './displayLabels';
import { isSubmitShortcut, readStoredChoice, writeStoredString } from './uiPreferences';
import { buildBatchFindingsFixPrompt, buildSingleFindingFixPrompt, sortActionableFindings } from './findingFixPrompt';
import { buildSarifLogFromReview, parseSarifFindingsToDraft } from './sarifExport';
import { ChecklistTable, draftExtras, VerdictTag } from './ChainReportBits';
import './WorkTaskDetail.css';

const AI_ENGINE_PREF_KEY = 'taskflow.ai.engine';
const ENGINE_IDS: readonly LocalAiEngineId[] = ['codex', 'antigravity', 'cursor', 'claude'];

interface ReportDraft {
  summary: string; tool?: string; evidence?: string;
  findings?: { severity: Finding['severity']; title: string; detail: string; location?: string }[];
}

const FindingWaiverForm: React.FC<{
  busy: boolean;
  independent: boolean;
  onSubmit: (reason: string) => void;
}> = ({ busy, independent, onSubmit }) => {
  const [waiverForm] = Form.useForm<{ reason: string }>();
  return (
    <Form form={waiverForm} layout="vertical" disabled={busy} onFinish={({ reason }) => onSubmit(reason)}>
      <Form.Item
        label="此阻断问题的豁免理由（支持 Cmd/Ctrl + Enter 提交）"
        name="reason"
        rules={[{ required: true, whitespace: true, message: '请填写豁免理由' }]}
      >
        <Input.TextArea
          rows={3}
          maxLength={2000}
          placeholder="说明风险兜底措施与跟进计划，或点击下方快捷理由填入"
          onKeyDown={event => {
            if (isSubmitShortcut(event) && !busy) {
              event.preventDefault();
              waiverForm.submit();
            }
          }}
        />
      </Form.Item>
      <Flex gap={6} wrap style={{ marginBottom: 10 }}>
        {WAIVER_REASON_PRESETS.map(preset => (
          <Tag
            key={preset}
            style={{ cursor: 'pointer', marginInlineEnd: 0 }}
            onClick={() => waiverForm.setFields([{ name: 'reason', value: preset, errors: [] }])}
          >
            + {preset}
          </Tag>
        ))}
      </Flex>
      <Button htmlType="submit" loading={busy}>{independent ? '记录独立豁免' : '记录豁免（单账号模式）'}</Button>
    </Form>
  );
};
export const ReviewDetail: React.FC<{
  jobId: string; task: WorkTask; user: User; role: Role; members: User[];
  repoPath?: string | null; constitutionFiles?: readonly string[];
  onChanged: () => Promise<void>; onUnauthorized: () => void; onForbidden: () => void;
  onOpenJob?: (newJobId: string) => void; onReady?: () => void; readOnly?: boolean;
}> = ({ jobId, task, user, role, members, repoPath = null, constitutionFiles = [], onChanged, onUnauthorized, onForbidden, onOpenJob, onReady, readOnly = task.status === 'DONE' }) => {
  const { message } = AntApp.useApp();
  const [job, setJob] = useState<ReviewJob | null>(null);
  const [busy, setBusy] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [appliedDraftExtras, setAppliedDraftExtras] = useState<ReturnType<typeof draftExtras>>({});
  const [engine, setEngine] = useState<LocalAiEngineId>(() => readStoredChoice(AI_ENGINE_PREF_KEY, ENGINE_IDS, 'codex'));
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [jobRuns, setJobRuns] = useState<LocalAiRun[]>([]);
  const [startingAi, setStartingAi] = useState(false);
  const [findingFilter, setFindingFilter] = useState<'ALL' | 'UNWAIVED_CRITICAL' | 'ACTIONABLE'>('ALL');

  const mounted = useRef(true);
  const accessLost = useRef(false);
  const refreshSequence = useRef(0);
  const actionSequence = useRef(0);
  const actionInFlight = useRef(false);
  const appliedRunIds = useRef<Set<string>>(new Set());
  const consoleRef = useRef<HTMLPreElement>(null);
  const sarifFileInputRef = useRef<HTMLInputElement>(null);
  const [reportForm] = Form.useForm<ReportDraft>();
  const [decisionForm] = Form.useForm<{ reason: string }>();

  const clearSensitiveState = () => {
    accessLost.current = true; refreshSequence.current += 1;
    setAccessDenied(true); setJob(null); setJobRuns([]); setBusy(false); setAppliedDraftExtras({});
    reportForm.resetFields(); decisionForm.resetFields();
  };

  const applyDraftToForm = (run: LocalAiRun) => {
    if (!run.draft) return;
    setAppliedDraftExtras(draftExtras(run.draft));
    reportForm.setFieldsValue({
      tool: run.tool || 'codex-cli',
      summary: run.draft.summary,
      evidence: run.draft.evidence || '',
      findings: (run.draft.findings || []).map(f => ({
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        location: f.location || '',
      })),
    });
    void message.success('已自动填入 AI 评审草稿，核对无误后点击「提交评审报告」即可。');
  };

  const loadJobRuns = async (autoFillRunId?: string) => {
    try {
      const data = await api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`);
      if (accessLost.current || !mounted.current) return;
      const filtered = (data.runs || []).filter(r => r.jobId === jobId);
      setJobRuns(filtered);
      if (autoFillRunId) {
        const finished = filtered.find(r => r.id === autoFillRunId && r.status === 'SUCCEEDED' && r.draft);
        if (finished && !appliedRunIds.current.has(finished.id)) {
          appliedRunIds.current.add(finished.id);
          applyDraftToForm(finished);
        }
      }
    } catch { /* ignore in restricted sessions */ }
  };

  const pollSingleJobRun = async (targetRunId: string) => {
    try {
      const data = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(targetRunId)}`);
      if (accessLost.current || !mounted.current) return;
      const updated = data.run;
      if (updated.jobId !== jobId) return;
      setJobRuns(current => current.some(item => item.id === updated.id)
        ? current.map(item => item.id === updated.id ? updated : item)
        : [updated, ...current]);
      if (updated.status === 'SUCCEEDED' && updated.draft && !appliedRunIds.current.has(updated.id)) {
        appliedRunIds.current.add(updated.id);
        applyDraftToForm(updated);
      }
    } catch {
      await loadJobRuns(targetRunId);
    }
  };

  const refresh = async () => {
    const sequence = ++refreshSequence.current;
    const next = await api<{ job: ReviewJob }>('jobs/' + jobId);
    if (accessLost.current || !mounted.current || sequence !== refreshSequence.current) return;
    setJob(next.job);
    void Promise.allSettled([
      api<LocalAutomationCapabilities>('local-automation/capabilities'),
      api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`),
    ]).then(([capRes, runRes]) => {
      if (accessLost.current || !mounted.current || sequence !== refreshSequence.current) return;
      if (capRes.status === 'fulfilled') {
        setCapabilities(capRes.value);
        setEngine(current => {
          if (capRes.value.engines.some(item => item.id === current && item.available)) return current;
          return capRes.value.engines.find(item => item.available)?.id || current;
        });
      }
      if (runRes.status === 'fulfilled') {
        setJobRuns((runRes.value.runs || []).filter(r => r.jobId === jobId));
      }
    });
  };

  const run = async (action: () => Promise<void>, mutation = false) => {
    if (accessLost.current || !mounted.current || actionInFlight.current) return;
    if (mutation) actionInFlight.current = true;
    const sequence = ++actionSequence.current;
    setBusy(true);
    try { await action(); }
    catch (error) {
      if (accessLost.current || !mounted.current || sequence !== actionSequence.current || error instanceof DOMException && error.name === 'AbortError') return;
      void message.error(error instanceof Error ? error.message : '请求失败。');
      if (error instanceof ApiError && error.status === 403) { clearSensitiveState(); onForbidden(); }
      else if (error instanceof ApiError && error.status === 401) { clearSensitiveState(); onUnauthorized(); }
    } finally { if (mutation) actionInFlight.current = false; if (mounted.current && !accessLost.current && sequence === actionSequence.current) setBusy(false); }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshSequence.current += 1; actionSequence.current += 1; };
  }, []);

  useEffect(() => { setFindingFilter('ALL'); void run(refresh); }, [jobId]);

  const serverMode = capabilities?.deployment === 'server';
  const scopedDevices = (capabilities?.devices || []).filter(device => device.projectIds.includes(task.projectId));
  const bridgeDevice = scopedDevices.find(device => device.online) || scopedDevices[0] || null;
  const bridgeUnavailable = serverMode && (!bridgeDevice || !(capabilities?.bridgeModes || []).includes('review'));
  const runTarget = serverMode && bridgeDevice ? { runner: 'bridge', deviceId: bridgeDevice.id } : {};
  const runningAiRun = jobRuns.find(r => r.status === 'RUNNING') || null;
  const latestDraftRun = jobRuns.find(r => r.status === 'SUCCEEDED' && r.draft) || null;

  useEffect(() => {
    if (!runningAiRun) return;
    const targetRunId = runningAiRun.id;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pollSingleJobRun(targetRunId);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [runningAiRun?.id, jobId, task.id]);

  useEffect(() => {
    const el = consoleRef.current;
    if (!el || !runningAiRun) return;
    el.scrollTop = el.scrollHeight;
  }, [runningAiRun?.id, runningAiRun?.output]);

  // Scroll after the fetched report has expanded the loading placeholder.
  useLayoutEffect(() => { if (job) onReady?.(); }, [job?.id]);

  const update = async () => {
    await readTogether([onChanged(), refresh()]);
    if (accessLost.current || !mounted.current) throw new DOMException('', 'AbortError');
  };

  const independent = !!job?.report && job.report.actorId !== user.id && task.assigneeId !== user.id;
  const soloApprovable = !!job?.report && !!job.soloMode;
  const canDecide = !readOnly && !!job && !!job.report && !job.decision && !job.stale && (independent || soloApprovable) && APPROVE_ROLES[job.stage].includes(role);
  const canReport = !readOnly && !!job && !job.report && !job.stale && job.executionMode !== 'CLOUD_AI' && REVIEW_ROLES[job.stage].includes(role);
  const canWaive = !readOnly && !!job && ['TECH_SPEC', 'CODE_REVIEW'].includes(job.stage) && (independent || soloApprovable) && ['ADMIN', 'LEAD'].includes(role) && !job.decision && !job.stale;
  const canReReview = !readOnly && !!job && (job.stale || job.status === 'CHANGES_REQUESTED') && REVIEW_ROLES[job.stage].includes(role);
  const hasCritical = job?.findings.some(finding => finding.severity === 'CRITICAL' && !finding.waiver);

  const recreateReview = (autoAiDraft: boolean) => {
    if (!job || !canReReview || busy || startingAi) return;
    const nextMode = autoAiDraft ? 'LOCAL_REPORT' : (job.executionMode === 'CLOUD_AI' ? 'LOCAL_REPORT' : job.executionMode);
    void run(async () => {
      const created = await api<{ job: ReviewJob }>('reviews', {
        taskId: task.id,
        stage: job.stage,
        executionMode: nextMode,
      });
      if (accessLost.current || !mounted.current) return;
      if (autoAiDraft && !created.job.report && !bridgeUnavailable) {
        try {
          await api<{ run: LocalAiRun }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`, {
            mode: 'review',
            jobId: created.job.id,
            engine,
            ...runTarget,
          });
          void message.success('已基于最新材料创建新评审并启动本机 AI 草稿生成。');
        } catch {
          void message.success('已基于最新材料创建新评审申请。');
        }
      } else {
        void message.success('已基于最新材料创建新评审申请。');
      }
      await onChanged();
      onOpenJob?.(created.job.id);
    }, true);
  };

  const startAiDraft = async () => {
    if (!job || !canReport || startingAi || runningAiRun || bridgeUnavailable) return;
    setStartingAi(true);
    try {
      const res = await api<{ run: LocalAiRun }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`, {
        mode: 'review',
        jobId: job.id,
        engine,
        ...runTarget,
      });
      if (!mounted.current || accessLost.current) return;
      setJobRuns(current => [res.run, ...current.filter(item => item.id !== res.run.id)]);
      void message.info(serverMode ? `已派发到「${bridgeDevice?.deviceName}」，等待本机 Bridge 领取并生成草稿…` : '正在调用本机 AI 分析冻结快照并生成结构化评审草稿…');
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '启动本机 AI 草稿生成失败。');
    } finally {
      if (mounted.current) setStartingAi(false);
    }
  };

  const stopAiDraft = async (runId: string) => {
    try {
      const res = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(runId)}/stop`, {});
      if (mounted.current && !accessLost.current) {
        setJobRuns(current => current.map(item => item.id === res.run.id ? res.run : item));
      }
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '停止执行失败。');
    }
  };

  const submitReport = (values: ReportDraft) => {
    if (!job || !canReport) return;
    void run(async () => {
      const result = await api<{ job: ReviewJob }>('jobs/' + jobId + '/report', {
        summary: values.summary, source: job.executionMode === 'LOCAL_REPORT' ? 'LOCAL_TOOL' : 'MANUAL',
        ...(job.executionMode === 'LOCAL_REPORT' ? { tool: values.tool } : {}),
        ...(values.evidence?.trim() ? { evidence: values.evidence } : {}),
        findings: (values.findings || []).map(finding => ({ ...finding, location: finding.location?.trim() ? finding.location : undefined })),
        ...appliedDraftExtras,
      });
      if (accessLost.current || !mounted.current) return;
      setJob(result.job); setAppliedDraftExtras({}); reportForm.resetFields(); void message.success('报告已提交并保留原始内容，等待审批。');
      await update();
    }, true);
  };
  const decide = async (decision: 'APPROVE' | 'REQUEST_CHANGES') => {
    if (!job || !canDecide || (decision === 'APPROVE' && hasCritical)) return;
    const rawReason = String(decisionForm.getFieldValue('reason') ?? '').trim();
    if (decision === 'REQUEST_CHANGES' && !rawReason) {
      decisionForm.setFields([{ name: 'reason', errors: ['请填写退回修改的具体原因，便于跟进修复'] }]);
      return;
    }
    const finalReason = rawReason || DEFAULT_APPROVE_REASON;
    void run(async () => {
      const result = await api<{ job: ReviewJob }>('jobs/' + jobId + '/decision', { decision, reason: finalReason });
      if (accessLost.current || !mounted.current) return;
      setJob(result.job); decisionForm.resetFields(); void message.success(decision === 'APPROVE' ? '已批准放行本阶段评审。' : '已退回修改并记录说明。');
      await update();
    }, true);
  };

  if (accessDenied) return null;
  if (!job) return <Card title="评审详情"><Skeleton active loading={busy} />{!busy && <Empty><Space orientation="vertical"><span>评审尚未加载。</span><Button onClick={() => void run(refresh)}>重新加载评审</Button></Space></Empty>}</Card>;

  const engineOptions = (capabilities?.engines || [
    { id: 'codex' as const, label: 'Codex', tool: 'codex-cli', available: true },
    { id: 'antigravity' as const, label: 'Gemini / Antigravity', tool: 'antigravity', available: true },
    { id: 'cursor' as const, label: 'Cursor Agent', tool: 'cursor', available: true },
    { id: 'claude' as const, label: 'Claude Code', tool: 'claude-code', available: true },
  ]).map(item => ({
    value: item.id,
    label: item.available ? item.label : `${item.label} (未安装)`,
    disabled: !item.available,
  }));

  const statusVariant = job.status === 'APPROVED' ? 'green' : job.status === 'REPORT_SUBMITTED' ? 'blue' : job.status === 'CHANGES_REQUESTED' ? 'warn' : 'neutral';
  const snapshotAssets = Array.isArray(job.snapshot?.assets)
    ? (job.snapshot.assets as { id?: string; kind?: string; title?: string; revision?: number; sha256?: string }[])
    : [];
  const snapshotUpstream = Array.isArray(job.snapshot?.upstreamApprovals)
    ? (job.snapshot.upstreamApprovals as { stage?: string; status?: string }[])
    : [];
  const snapshotPlugins = Array.isArray(job.snapshot?.plugins)
    ? (job.snapshot.plugins as { id?: string; name?: string; version?: string }[])
    : [];
  const snapshotPolicyHash = typeof job.snapshot?.policyHash === 'string' ? job.snapshot.policyHash : '';

  return <Card title="评审详情" className="tf-review-card" extra={<Button size="small" icon={<RefreshCw size={14} />} loading={busy} onClick={() => void run(refresh)}>刷新评审</Button>}>
    <div className="tf-detail-stack">
      <div>
        <Flex gap={8} align="center" wrap><Typography.Title level={4} style={{ margin: 0 }}>{stageLabel(job.stage)}</Typography.Title><StatusBadge variant={statusVariant}>{reviewStatusLabel(job.status)}</StatusBadge>{job.stale && <StatusBadge variant="warn">材料已更新·需重审</StatusBadge>}</Flex>
        <Typography.Paragraph type="secondary" className="tf-meta-line">{executionModeLabel(job.executionMode)} · {memberName(members, job.actorId)} · {timeText(job.createdAt)}</Typography.Paragraph>
      </div>
      {readOnly && <Typography.Paragraph type="secondary">任务已完成或上级任务已冻结，当前评审仅供查看。</Typography.Paragraph>}
      {(job.stale || job.status === 'CHANGES_REQUESTED') && (
        <Alert
          type="warning"
          showIcon
          title={job.stale ? '相关材料已更新，当前快照已过期（保留用于审计追溯）' : '本轮评审已退回修改，请在修复材料后重新发起评审'}
          description={canReReview ? (
            <Space size={8} wrap style={{ marginTop: 8 }}>
              <Button size="small" type="primary" icon={<Sparkles size={13} />} disabled={busy} onClick={() => recreateReview(true)}>
                一键 AI 重审最新材料
              </Button>
              <Button size="small" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => recreateReview(false)}>
                基于最新材料重新发起评审
              </Button>
            </Space>
          ) : undefined}
        />
      )}
      {job.executionMode === 'CLOUD_AI' && !job.report && <Typography.Paragraph type="secondary">云端执行器尚未配置，当前申请不会自动生成报告或通过结论。</Typography.Paragraph>}
      {job.report ? <>
        <div>
          <Flex justify="space-between" align="center" gap={8} wrap>
            <Typography.Title level={5} style={{ margin: 0 }}><Space size={8}><FileCheck2 size={18} />提交报告</Space></Typography.Title>
            <Space size={6} wrap>
              <Tooltip title="导出标准 OASIS SARIF 2.1.0 静态/AI 分析报告，可直接导入 GitHub Code Scanning、SonarQube 或 IDE SARIF Viewer">
                <Button
                  size="small"
                  icon={<Download size={13} />}
                  onClick={() => {
                    const sarif = buildSarifLogFromReview({ task, job });
                    const blob = new Blob([JSON.stringify(sarif, null, 2)], { type: 'application/sarif+json;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${task.jiraKey}-${job.stage}.sarif.json`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                    void message.success(`已导出 ${task.jiraKey}-${job.stage}.sarif.json`);
                  }}
                >
                  导出 SARIF 2.1
                </Button>
              </Tooltip>
              <Button
                size="small"
                icon={<Copy size={13} />}
                onClick={() => {
                  const md = formatSubmittedReportMarkdown(job.stage, job.report!, job.findings);
                  void navigator.clipboard.writeText(md).then(() => message.success('评审报告已复制为 Markdown。')).catch(() => message.warning('浏览器未能复制，请手动选择复制。'));
                }}
              >
                复制报告
              </Button>
            </Space>
          </Flex>
          <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>{memberName(members, job.report.actorId)} · {reportSourceLabel(job.report.source)}{job.report.tool ? ' · ' + toolLabel(job.report.tool) : ''} · {timeText(job.report.createdAt)}</Typography.Paragraph>
          <Typography.Paragraph className="tf-preserve">{job.report.summary}</Typography.Paragraph>
          {job.report.evidence && <pre className="tf-code-panel">{job.report.evidence}</pre>}
          {(job.report.verdict || typeof job.report.score === 'number') && <div style={{ marginBottom: 8 }}><VerdictTag verdict={job.report.verdict} score={job.report.score} /></div>}
          {!!job.report.checklist?.length && <ChecklistTable items={job.report.checklist} />}
        </div>
        {job.findings.length > 0 && (() => {
          const unwaivedCriticalCount = job.findings.filter(item => item.severity === 'CRITICAL' && !item.waiver).length;
          const waivedCriticalCount = job.findings.filter(item => item.severity === 'CRITICAL' && !!item.waiver).length;
          const warnCount = job.findings.filter(item => item.severity === 'WARN').length;
          const infoCount = job.findings.filter(item => item.severity === 'INFO').length;
          const actionableCount = unwaivedCriticalCount + warnCount;
          const unwaivedAll = sortActionableFindings(job.findings);
          const filteredFindings = job.findings.filter(item => {
            if (findingFilter === 'UNWAIVED_CRITICAL') return item.severity === 'CRITICAL' && !item.waiver;
            if (findingFilter === 'ACTIONABLE') return (item.severity === 'CRITICAL' && !item.waiver) || item.severity === 'WARN';
            return true;
          });
          return (
            <div className="tf-detail-stack tf-detail-stack-small">
              <Flex justify="space-between" align="center" gap={8} wrap>
                <Space size={6} wrap>
                  <Typography.Text strong>发现项分级 ({job.findings.length})</Typography.Text>
                  {unwaivedCriticalCount > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>阻断问题 {unwaivedCriticalCount}</Tag>}
                  {waivedCriticalCount > 0 && <Tag color="purple" style={{ marginInlineEnd: 0 }}>已豁免 {waivedCriticalCount}</Tag>}
                  {warnCount > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>风险提醒 {warnCount}</Tag>}
                  {infoCount > 0 && <Tag style={{ marginInlineEnd: 0 }}>改进建议 {infoCount}</Tag>}
                </Space>
                <Space size={8} wrap>
                  {unwaivedAll.length > 0 && (
                    <Tooltip title="复制可直接粘贴给 Cursor / Codex / Claude / Gemini 的结构化批量修复指令">
                      <Button
                        size="small"
                        icon={<Sparkles size={13} />}
                        onClick={() => {
                          const prompt = buildBatchFindingsFixPrompt({
                            task,
                            stage: job.stage,
                            findings: unwaivedAll,
                            summary: job.report?.summary || null,
                            repoPath,
                            constitutionFiles,
                          });
                          void navigator.clipboard.writeText(prompt)
                            .then(() => message.success(`已复制 ${unwaivedAll.length} 项待修问题的 AI 修复指令。`))
                            .catch(() => message.warning('浏览器未能复制，请重试。'));
                        }}
                      >
                        一键复制全部修复指令 ({unwaivedAll.length})
                      </Button>
                    </Tooltip>
                  )}
                  {job.findings.length >= 2 && (
                    <Segmented<'ALL' | 'UNWAIVED_CRITICAL' | 'ACTIONABLE'>
                      size="small"
                      aria-label="发现项严重度筛选"
                      value={findingFilter}
                      onChange={setFindingFilter}
                      options={[
                        { value: 'ALL', label: `全部 (${job.findings.length})` },
                        { value: 'ACTIONABLE', label: `阻断与风险 (${actionableCount})` },
                        { value: 'UNWAIVED_CRITICAL', label: `仅未豁免阻断 (${unwaivedCriticalCount})` },
                      ]}
                    />
                  )}
                </Space>
              </Flex>
              {!filteredFindings.length ? (
                <Typography.Text type="secondary">当前筛选条件下无发现项。</Typography.Text>
              ) : filteredFindings.map(finding => (
                <Card key={finding.id} size="small" className="tf-finding-card">
                  <div className="tf-detail-stack tf-detail-stack-small">
                    <Flex justify="space-between" align="start" gap={8} wrap>
                      <Flex gap={8} align="start" wrap style={{ flex: 1, minWidth: 0 }}>
                        <StatusBadge variant={finding.severity === 'CRITICAL' && !finding.waiver ? 'block' : finding.severity === 'WARN' ? 'warn' : 'neutral'}>
                          {severityLabel(finding.severity)}
                        </StatusBadge>
                        <Typography.Text strong className="tf-break">{finding.title}</Typography.Text>
                      </Flex>
                      {!finding.waiver && (
                        <Button
                          size="small"
                          type="text"
                          icon={<Copy size={13} />}
                          onClick={() => {
                            const prompt = buildSingleFindingFixPrompt({
                              task,
                              stage: job.stage,
                              finding,
                              repoPath,
                              constitutionFiles,
                            });
                            void navigator.clipboard.writeText(prompt)
                              .then(() => message.success('已复制该发现项的 AI 定向修复指令。'))
                              .catch(() => message.warning('浏览器未能复制，请重试。'));
                          }}
                        >
                          复制 AI 修复指令
                        </Button>
                      )}
                    </Flex>
                    <Typography.Paragraph className="tf-preserve">{finding.detail}</Typography.Paragraph>
                    {finding.location && (
                      <Tooltip title="点击复制定位锚点">
                        <Typography.Text
                          type="secondary"
                          className="tf-break"
                          style={{ cursor: 'pointer', width: 'fit-content' }}
                          onClick={() => { void navigator.clipboard.writeText(finding.location!).then(() => message.success('已复制文件/锚点位置。')).catch(() => {}); }}
                        >
                          <code>{finding.location}</code>
                        </Typography.Text>
                      </Tooltip>
                    )}
                    {finding.waiver ? (
                      <div>
                        <Typography.Paragraph className="tf-preserve">豁免记录：{finding.waiver.reason}</Typography.Paragraph>
                        <Typography.Text type="secondary">{memberName(members, finding.waiver.actorId)} · {timeText(finding.waiver.createdAt)}</Typography.Text>
                      </div>
                    ) : finding.severity === 'CRITICAL' && canWaive && (
                      <FindingWaiverForm busy={busy} independent={independent} onSubmit={reason => {
                        if (!canWaive) return;
                        void run(async () => {
                          const result = await api<{ job: ReviewJob }>('jobs/' + jobId + '/findings/' + finding.id + '/waiver', { reason });
                          if (accessLost.current || !mounted.current) return;
                          setJob(result.job); void message.success('豁免理由已记录，原始问题保留。');
                          await update();
                        }, true);
                      }} />
                    )}
                  </div>
                </Card>
              ))}
            </div>
          );
        })()}
        {!job.findings.length && <Typography.Text type="secondary">此报告未登记发现项。</Typography.Text>}
      </> : canReport && <>
        <div className="tf-form-width">
          <Typography.Title level={5}>提交评审报告</Typography.Title>
          <Typography.Paragraph type="secondary">报告提交后不可覆盖。本地工具报告由成员核对后提交，多人项目需由独立成员审批。</Typography.Paragraph>

          {job.executionMode === 'LOCAL_REPORT' && (
            <Card size="small" style={{ marginBottom: 16, background: 'var(--tf-accent-soft)', borderColor: 'color-mix(in srgb, var(--tf-accent) 34%, var(--tf-border))' }}>
              <Flex vertical gap={10}>
                <Flex justify="space-between" align="center" gap={8} wrap>
                  <Space size={6}><Sparkles size={15} /><Typography.Text strong>本机 AI 自动生成评审草稿</Typography.Text></Space>
                  <Space size={8} wrap>
                    <Select size="small" style={{ width: 175 }} value={engine} options={engineOptions} onChange={val => { setEngine(val); writeStoredString(AI_ENGINE_PREF_KEY, val); }} disabled={!!runningAiRun} />
                    {runningAiRun ? (
                      <Button size="small" danger icon={<Square size={13} />} onClick={() => void stopAiDraft(runningAiRun.id)}>停止生成</Button>
                    ) : (
                      <Button size="small" type="primary" icon={<Play size={13} />} loading={startingAi} disabled={bridgeUnavailable} onClick={() => void startAiDraft()}>{serverMode ? '派发到本机生成' : '一键生成并填入表单'}</Button>
                    )}
                    {latestDraftRun && !runningAiRun && (
                      <Button size="small" onClick={() => applyDraftToForm(latestDraftRun)}>重新带入上次草稿</Button>
                    )}
                  </Space>
                </Flex>
                {serverMode && !runningAiRun && (
                  <Typography.Text type={bridgeUnavailable ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                    {!bridgeDevice ? '尚未配对可接收该项目任务的本机 Bridge，请在「本机接入」页按指引配对并运行 worker。'
                      : bridgeUnavailable ? '服务器未开启评审类派发。'
                      : `将派发到「${bridgeDevice.deviceName}」（${bridgeDevice.online ? '在线' : '离线，需在本机运行 worker 后才会领取'}）。`}
                  </Typography.Text>
                )}
                {runningAiRun && (
                  <pre ref={consoleRef} className="tf-code-panel" style={{ maxHeight: 160 }}>
                    {runningAiRun.output || (runningAiRun.runner === 'bridge' && runningAiRun.bridgePhase === 'QUEUED'
                      ? '已排队，等待本机 Bridge 领取（请确认本机正在运行 rd.mjs worker）…'
                      : '正在读取冻结输入快照并执行审查，完成后将自动填入下方表单…')}
                  </pre>
                )}
                {jobRuns[0]?.status === 'FAILED' && jobRuns[0].error && (
                  <Alert type="warning" showIcon title={jobRuns[0].error} />
                )}
              </Flex>
            </Card>
          )}

          <Form form={reportForm} layout="vertical" disabled={busy} initialValues={{ tool: 'codex-cli', findings: [] }} onFinish={submitReport} scrollToFirstError>
            {job.executionMode === 'LOCAL_REPORT' && <Form.Item label="本地工具来源" name="tool" htmlFor="report-tool" rules={[{ required: true }]}><Select id="report-tool" options={REPORT_TOOL_OPTIONS} /></Form.Item>}
            <Form.Item label="报告结论与说明（支持 Cmd/Ctrl + Enter 提交）" name="summary" htmlFor="report-summary" rules={[{ required: true, whitespace: true, message: '请填写报告结论与说明' }]}><Input.TextArea id="report-summary" rows={4} maxLength={8000} onKeyDown={event => { if (isSubmitShortcut(event)) { event.preventDefault(); reportForm.submit(); } }} /></Form.Item>
            <Flex gap={6} wrap style={{ marginBottom: 14 }}>
              {(REPORT_SUMMARY_PRESETS[job.stage] || []).map(preset => (
                <Tag
                  key={preset}
                  style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                  onClick={() => reportForm.setFields([{ name: 'summary', value: preset, errors: [] }])}
                >
                  + {preset}
                </Tag>
              ))}
            </Flex>
            <Form.Item label="验证证据或执行说明（可选）" name="evidence"><Input.TextArea rows={3} maxLength={8000} className="tf-code-input" /></Form.Item>
            {(appliedDraftExtras.verdict || typeof appliedDraftExtras.score === 'number' || !!appliedDraftExtras.checklist?.length) && (
              <div style={{ marginBottom: 14 }}>
                <Space size={8} wrap style={{ marginBottom: 6 }}>
                  <VerdictTag verdict={appliedDraftExtras.verdict} score={appliedDraftExtras.score} />
                  {!!appliedDraftExtras.checklist?.length && <Tag>含 AI 检查清单 {appliedDraftExtras.checklist.length} 项</Tag>}
                </Space>
                {!!appliedDraftExtras.checklist?.length && <ChecklistTable items={appliedDraftExtras.checklist} />}
              </div>
            )}
            <input
              ref={sarifFileInputRef}
              type="file"
              accept=".sarif,.json,application/json"
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                void file.text().then(raw => {
                  try {
                    const draft = parseSarifFindingsToDraft(raw);
                    const existingSummary = (reportForm.getFieldValue('summary') || '').trim();
                    const existingEvidence = (reportForm.getFieldValue('evidence') || '').trim();
                    const existingFindings = Array.isArray(reportForm.getFieldValue('findings')) ? reportForm.getFieldValue('findings') : [];
                    const mergedFindings = [...existingFindings, ...draft.findings].slice(0, 50);
                    reportForm.setFieldsValue({
                      summary: existingSummary ? `${existingSummary}\n${draft.summary}` : draft.summary,
                      evidence: existingEvidence ? `${existingEvidence}\n${draft.evidence}` : draft.evidence,
                      findings: mergedFindings,
                    });
                    void message.success(`已从 ${draft.toolName} 导入 ${draft.findings.length} 项 SARIF 发现。`);
                  } catch (err) {
                    void message.error(err instanceof Error ? err.message : 'SARIF 解析失败');
                  }
                }).catch(() => {
                  void message.error('读取 SARIF 文件失败');
                });
              }}
            />
            <Form.List name="findings">{(fields, { add, remove }) => <>
              <Flex justify="space-between" align="center" gap={12} wrap className="tf-finding-toolbar">
                <Typography.Text strong>发现项</Typography.Text>
                <Space size={8} wrap>
                  <Tooltip title="支持直接导入 ESLint / Semgrep / CodeQL / Sonar 等输出的 OASIS SARIF 2.x (.sarif / .json) 报告">
                    <Button icon={<Upload size={15} />} disabled={fields.length >= 50} onClick={() => sarifFileInputRef.current?.click()}>
                      导入 SARIF 扫描结果
                    </Button>
                  </Tooltip>
                  <Button icon={<Plus size={16} />} disabled={fields.length >= 50} onClick={() => add({ severity: 'WARN', title: '', detail: '', location: '' })}>
                    添加发现项
                  </Button>
                </Space>
              </Flex>
              {fields.map((field, index) => <Card key={field.key} size="small" className="tf-finding-draft" title={'发现项 ' + (index + 1)} extra={<Button type="text" size="small" danger icon={<Trash2 size={16} />} aria-label={'删除发现项 ' + (index + 1)} onClick={() => remove(field.name)} />}>
                <div className="tf-form-grid tf-form-grid-severity">
                  <Form.Item label="严重程度" name={[field.name, 'severity']} rules={[{ required: true }]}><Select options={SEVERITY_OPTIONS} /></Form.Item>
                  <Form.Item label="问题标题" name={[field.name, 'title']} rules={[{ required: true, whitespace: true, message: '请填写问题标题' }]}><Input maxLength={200} /></Form.Item>
                </div>
                <Form.Item label="问题详情" name={[field.name, 'detail']} rules={[{ required: true, whitespace: true, message: '请填写问题详情' }]}><Input.TextArea rows={3} maxLength={4000} /></Form.Item>
                <Form.Item label="文件位置或文档锚点（可选）" name={[field.name, 'location']}><Input maxLength={500} className="tf-code-input" /></Form.Item>
              </Card>)}
            </>}</Form.List>
            <Button type="primary" htmlType="submit" loading={busy}>提交评审报告</Button>
          </Form>
        </div>
      </>}
      {job.decision ? <>
        <div><Typography.Title level={5}>审批记录</Typography.Title><StatusBadge variant={job.decision.decision === 'APPROVE' ? 'green' : 'warn'}>{decisionLabel(job.decision.decision)}</StatusBadge><Typography.Paragraph className="tf-preserve tf-meta-line">{job.decision.reason}</Typography.Paragraph><Typography.Text type="secondary">{memberName(members, job.decision.actorId)} · {timeText(job.decision.createdAt)}</Typography.Text></div>
      </> : job.report && <>
        <div className="tf-form-width"><Typography.Title level={5}>{independent ? '独立审批' : '门禁核验审批'}</Typography.Title>
          {!independent && soloApprovable && canDecide && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              title="单账号全流程模式：当前项目暂无其他独立审批成员，可直接用本人账号完成门禁审批（后续添加其他审批成员后将自动恢复双人独立审批）。"
            />
          )}
          {canDecide ? <Form form={decisionForm} layout="vertical" disabled={busy}>
            <Form.Item
              label="审批备注（批准时可留空，默认使用标准放行结论；退回修改需说明原因）"
              name="reason"
              htmlFor="decision-reason"
            >
              <Input.TextArea
                id="decision-reason"
                rows={2}
                maxLength={2000}
                placeholder={`可留空直接一键批准（默认：${DEFAULT_APPROVE_REASON}），或点击下方快捷评语填入`}
                onKeyDown={event => {
                  if (isSubmitShortcut(event) && !hasCritical) {
                    event.preventDefault();
                    void decide('APPROVE');
                  }
                }}
              />
            </Form.Item>
            <Flex gap={6} wrap style={{ marginBottom: 12 }}>
              {(!hasCritical ? APPROVAL_REASON_PRESETS : REJECTION_REASON_PRESETS).map(preset => (
                <Tag
                  key={preset}
                  style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                  onClick={() => decisionForm.setFields([{ name: 'reason', value: preset, errors: [] }])}
                >
                  + {preset}
                </Tag>
              ))}
            </Flex>
            {hasCritical && <Typography.Paragraph type="secondary">存在尚未豁免的阻断问题，不能直接批准。可退回修改；技术方案与代码审核可记录具体豁免理由。</Typography.Paragraph>}
            <Space size={8} wrap>
              <Button type="primary" icon={<CheckCircle2 size={15} />} disabled={hasCritical} loading={busy} onClick={() => void decide('APPROVE')}>一键批准放行</Button>
              <Button loading={busy} onClick={() => void decide('REQUEST_CHANGES')}>退回修改</Button>
            </Space>
          </Form> : <Typography.Paragraph type="secondary">审批需对应阶段权限，且存在其他审批人时需由非报告作者、非任务受理人完成；输入版本需保持有效。</Typography.Paragraph>}
        </div>
      </>}
      <Collapse items={[{
        key: 'snapshot',
        label: `评审配置与冻结快照（${snapshotAssets.length} 份材料）`,
        children: <div className="tf-detail-stack tf-detail-stack-small">
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
        { key: 'persona', label: '评审视角', children: personaLabel(job.persona) },
        { key: 'executor', label: '执行方式', children: job.executor === 'UNCONFIGURED' ? executionModeLabel(job.executionMode) : <code>{job.executor}</code> },
        { key: 'skills', label: '核验规则集', span: 2, children: skillsLabel(job.skills) },
        ...(snapshotPlugins.length > 0 ? [{
          key: 'plugins',
          label: '项目门禁插件',
          span: 2,
          children: (
            <Space size={[6, 6]} wrap>
              {snapshotPlugins.map((plugin, idx) => (
                <Tag key={plugin.id || idx} color="geekblue" style={{ marginInlineEnd: 0 }}>
                  {plugin.name || plugin.id} {plugin.version ? `v${plugin.version}` : ''}
                </Tag>
              ))}
              {snapshotPolicyHash && (
                <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                  策略指纹 {snapshotPolicyHash.slice(0, 12)}
                </Typography.Text>
              )}
            </Space>
          ),
        }] : []),
      ]} />
          <Descriptions bordered size="small" column={1} items={[
            { key: 'job', label: '评审编号', children: <code className="tf-break">{job.id}</code> },
            { key: 'hash', label: '输入指纹 (SHA256)', children: <code className="tf-break">{job.inputHash || '—'}</code> },
          ]} />
          {snapshotAssets.length > 0 && (
            <div>
              <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>本轮冻结的材料版本：</Typography.Text>
              <Space orientation="vertical" size={6} style={{ width: '100%' }}>
                {snapshotAssets.map((item, idx) => (
                  <Flex key={item.id || idx} justify="space-between" align="center" gap={8} wrap style={{ padding: '6px 10px', background: 'var(--tf-surface)', border: '1px solid var(--tf-border)', borderRadius: 6 }}>
                    <Space size={8} wrap>
                      <Tag color="blue">{assetKindLabel(item.kind)}</Tag>
                      <Typography.Text strong>{item.title || '未命名材料'}</Typography.Text>
                      {typeof item.revision === 'number' && <Tag>r{item.revision}</Tag>}
                    </Space>
                    {item.sha256 && <Typography.Text type="secondary" code>{item.sha256.slice(0, 12)}</Typography.Text>}
                  </Flex>
                ))}
              </Space>
            </div>
          )}
          {snapshotUpstream.length > 0 && (
            <div>
              <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>前置阶段门禁核验快照：</Typography.Text>
              <Space size={6} wrap>
                {snapshotUpstream.map((up, idx) => (
                  <Tag key={up.stage || idx} color={up.status === 'PASS' ? 'success' : 'warning'}>
                    {stageLabel(up.stage)}：{gateStatusLabel(up.status)}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
          <Collapse ghost size="small" items={[{ key: 'raw', label: '查看原始快照 JSON', children: <pre className="tf-code-panel">{JSON.stringify(job.snapshot, null, 2)}</pre> }]} />
        </div>,
      }]} />
    </div>
  </Card>;
};

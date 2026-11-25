import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Descriptions, Flex, Form, Input, Segmented, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircle2, Copy, Download, FileCheck2, MessageSquare, MessageSquarePlus, Play, Plus, RefreshCw, ShieldCheck, Sparkles, Square, Trash2, Upload } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import {
  api, ApiError, isChildTask, APPROVE_ROLES, Finding, FindingCategory, LocalAiRun, LocalAutomationCapabilities,
  memberName, PrecheckResult, REVIEW_ROLES, ReviewJob, Role, timeText, User, WorkTask,
} from './workspaceApi';
import { navigateWorkspace } from './workspaceNavigation';
import { requiresTaskReview } from './taskAvailability';
import { Empty } from './WorkspaceFields';
import { readTogether } from './readTogether';
import {
  APPROVAL_REASON_PRESETS, assetKindLabel, decisionLabel, DEFAULT_APPROVE_REASON,
  executionModeLabel, findingCategoryLabel, gateStatusLabel, personaLabel,
  REJECTION_REASON_PRESETS, REPORT_SUMMARY_PRESETS, REPORT_TOOL_OPTIONS,
  reportSourceLabel, reviewStatusLabel, SEVERITY_OPTIONS, severityLabel,
  skillsLabel, stageLabel, toolLabel, WAIVER_REASON_PRESETS,
} from './displayLabels';
import { isSubmitShortcut } from './uiPreferences';
import { buildBatchFindingsFixPrompt, buildSingleFindingFixPrompt, sortActionableFindings } from './findingFixPrompt';
import { buildSarifLogFromReview, parseSarifFindingsToDraft } from './sarifExport';
import { ChecklistTable, draftExtras, FindingMetaBadges, ReportMetaSummary, SuggestedPatchView, VerdictTag } from './ChainReportBits';
import { LinkifiedText, MarkdownPreview } from './MarkdownPreview';
import { plainReviewText, ReviewFindingContent, sortReviewFindings } from './ReviewFindingContent';
import { ReviewExportActions } from './ReviewExportActions';
import { AiRunIdentity, availableAiEngine, LocalAiExecutionFields, readAiEngine, useAiModelSelection } from './LocalAiExecutionFields';
import './WorkTaskDetail.css';

const ASK_PRESETS: readonly string[] = [
  '请核实该问题在当前代码中是否真实可触发，并给出最小修复代码',
  '本次改动还可能影响哪些边界场景或缺失什么回归测试？',
  '对比 PRD 与技术方案，当前实现还有哪些偏差？',
];

interface ReportDraft {
  summary: string; tool?: string; evidence?: string;
  findings?: {
    severity: Finding['severity']; title: string; detail: string; location?: string;
    category?: FindingCategory; confidence?: number; ruleId?: string;
    suggestedPatch?: { before: string; after: string };
  }[];
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
  repoPath?: string | null; constitutionFiles?: readonly string[]; cloudAiEnabled?: boolean; taskLink?: React.ReactNode; refreshToken?: number;
  onChanged: () => Promise<void>; onUnauthorized: () => void; onForbidden: () => void;
  onOpenJob?: (newJobId: string) => void; onReady?: () => void; readOnly?: boolean; historical?: boolean; aiReviewOnly?: boolean;
}> = ({ jobId, task, user, role, members, repoPath = null, constitutionFiles = [], cloudAiEnabled = false, taskLink, refreshToken, onChanged, onUnauthorized, onForbidden, onOpenJob, onReady, readOnly: frozen = task.status === 'DONE', historical: historyEntry = false, aiReviewOnly = false }) => {
  const { message } = AntApp.useApp();
  const [job, setJob] = useState<ReviewJob | null>(null);
  const historical = historyEntry || isChildTask(task) || !!job && (job.reviewRequired === false || !requiresTaskReview(task, job.stage));
  const readOnly = frozen || historical;
  const [busy, setBusy] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [appliedDraftExtras, setAppliedDraftExtras] = useState<ReturnType<typeof draftExtras>>({});
  const [engine, setEngine] = useState(readAiEngine);
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [jobRuns, setJobRuns] = useState<LocalAiRun[]>([]);
  const [startingAi, setStartingAi] = useState(false);
  const [runningCloudAi, setRunningCloudAi] = useState(false);
  const [runningPrecheck, setRunningPrecheck] = useState(false);
  const [writingBackMr, setWritingBackMr] = useState(false);
  const [findingFilter, setFindingFilter] = useState<'ALL' | 'UNWAIVED_CRITICAL' | 'ACTIONABLE'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | FindingCategory>('ALL');
  const [askTargetFindingId, setAskTargetFindingId] = useState<string>('');
  const [askInput, setAskInput] = useState('');
  const [askingAi, setAskingAi] = useState(false);

  const mounted = useRef(true);
  const accessLost = useRef(false);
  const refreshSequence = useRef(0);
  const actionSequence = useRef(0);
  const lastRefreshToken = useRef(refreshToken);
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
        ...(f.category ? { category: f.category } : {}),
        ...(typeof f.confidence === 'number' ? { confidence: f.confidence } : {}),
        ...(f.ruleId ? { ruleId: f.ruleId } : {}),
        ...(f.suggestedPatch ? { suggestedPatch: f.suggestedPatch } : {}),
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
        const finished = filtered.find(r => r.id === autoFillRunId && (!r.actionType || r.actionType === 'DEFAULT') && r.status === 'SUCCEEDED' && r.draft);
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
      if ((!updated.actionType || updated.actionType === 'DEFAULT') && updated.status === 'SUCCEEDED' && updated.draft && !appliedRunIds.current.has(updated.id)) {
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
        setEngine(current => availableAiEngine(capRes.value, current));
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

  useEffect(() => { setFindingFilter('ALL'); setCategoryFilter('ALL'); setAskTargetFindingId(''); setAskInput(''); void run(refresh); }, [jobId]);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) return;
    lastRefreshToken.current = refreshToken;
    void run(refresh);
  }, [refreshToken]);

  const serverMode = capabilities?.deployment === 'server';
  const scopedDevices = (capabilities?.devices || []).filter(device => device.projectIds.includes(task.projectId));
  const bridgeDevice = scopedDevices.find(device => device.online) || scopedDevices[0] || null;
  const bridgeUnavailable = serverMode && (!bridgeDevice || !(capabilities?.bridgeModes || []).includes('review'));
  const reviewBridgeUnavailableMessage = bridgeDevice ? '服务器未开启评审类派发。' : '尚未配对可接收该项目任务的本机 Bridge，请在「本机接入」页按指引配对并运行 worker。';
  const runTarget = serverMode && bridgeDevice ? { runner: 'bridge', deviceId: bridgeDevice.id } : {};
  const executionRunner = serverMode ? 'bridge' : 'local';
  const model = useAiModelSelection(capabilities, engine, executionRunner, bridgeDevice?.modelEngines, serverMode ? bridgeDevice?.id : undefined);
  const explicitModel = model.model ? { model: model.model } : {};
  const draftRuns = jobRuns.filter(r => !r.actionType || r.actionType === 'DEFAULT');
  const askRuns = jobRuns.filter(r => r.actionType === 'REVIEW_ASK');
  const runningAiRun = draftRuns.find(r => r.status === 'RUNNING') || null;
  const latestDraftRun = draftRuns.find(r => r.status === 'SUCCEEDED' && r.draft) || null;
  const currentDraftRun = runningAiRun || latestDraftRun;
  const runningAskRun = askRuns.find(r => r.status === 'RUNNING') || null;

  useEffect(() => {
    const activeRuns = jobRuns.filter(r => r.status === 'RUNNING');
    if (!activeRuns.length) return;
    const targetIds = activeRuns.map(r => r.id);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        for (const id of targetIds) void pollSingleJobRun(id);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [jobRuns.filter(r => r.status === 'RUNNING').map(r => r.id).join(','), jobId, task.id]);

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
    if (!job || !canReReview || busy || startingAi || (autoAiDraft && model.invalid)) return;
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
            ...explicitModel,
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
    if (!job || !canReport || startingAi || runningAiRun || bridgeUnavailable || model.invalid) return;
    setStartingAi(true);
    try {
      const res = await api<{ run: LocalAiRun }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`, {
        mode: 'review',
        jobId: job.id,
        engine,
        ...explicitModel,
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

  const startAskQuestion = async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? askInput).trim();
    if (!job || historical || !question || askingAi || runningAskRun || serverMode || model.invalid) return;
    setAskingAi(true);
    try {
      const res = await api<{ run: LocalAiRun }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`, {
        mode: 'read',
        actionType: 'REVIEW_ASK',
        jobId: job.id,
        engine,
        ...explicitModel,
        ...(askTargetFindingId ? { askFindingId: askTargetFindingId } : {}),
        customInstruction: question,
      });
      if (!mounted.current || accessLost.current) return;
      setJobRuns(current => [res.run, ...current.filter(item => item.id !== res.run.id)]);
      if (!overrideQuestion) setAskInput('');
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '发起 AI 追问失败。');
    } finally {
      if (mounted.current) setAskingAi(false);
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

  const runCloudAiReview = async () => {
    if (!job || runningCloudAi || readOnly || job.stale || job.report) return;
    setRunningCloudAi(true);
    try {
      const res = await api<{ job: ReviewJob; precheck?: PrecheckResult }>(`jobs/${encodeURIComponent(job.id)}/cloud-execute`, {});
      if (!mounted.current || accessLost.current) return;
      setJob(res.job);
      void message.success(`云端 AI 评审已完成（共发现 ${res.job.findings.length} 项）！`);
      await onChanged();
    } catch (error) {
      if (!mounted.current || accessLost.current) return;
      void message.error(error instanceof Error ? error.message : '云端 AI 执行失败。');
    } finally {
      if (mounted.current) setRunningCloudAi(false);
    }
  };

  const runDeterministicPrecheck = async () => {
    if (!job || runningPrecheck) return;
    setRunningPrecheck(true);
    try {
      const res = await api<PrecheckResult>(`jobs/${encodeURIComponent(job.id)}/precheck`, {});
      if (!mounted.current || accessLost.current) return;
      const existing = Array.isArray(reportForm.getFieldValue('findings')) ? reportForm.getFieldValue('findings') : [];
      const seen = new Set(existing.map((item: { severity?: string; title?: string; location?: string }) => `${item.severity}|${item.title}|${item.location || ''}`));
      const added = res.findings.filter(f => !seen.has(`${f.severity}|${f.title}|${f.location || ''}`));
      if (added.length) {
        reportForm.setFieldValue('findings', [...existing, ...added].slice(0, 50));
      }
      const existingEv = (reportForm.getFieldValue('evidence') || '').trim();
      const note = `确定性规则预检：${res.checks.join(', ') || '基础规范'}${res.executedPlugins.length ? `；已执行策略插件：${res.executedPlugins.join(', ')}` : ''}（命中 ${res.findings.length} 项）`;
      if (!existingEv.includes(note)) {
        reportForm.setFieldValue('evidence', existingEv ? `${existingEv}\n${note}` : note);
      }
      void message.success(res.findings.length ? `规则预检命中 ${res.findings.length} 项问题，已合并至发现项列表。` : '规则预检通过，未命中静态安全或接口契约异常。');
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '规则预检执行失败。');
    } finally {
      if (mounted.current) setRunningPrecheck(false);
    }
  };

  const writebackToMr = async () => {
    if (!job || !job.report || writingBackMr || readOnly) return;
    setWritingBackMr(true);
    try {
      const res = await api<{ writebacks: { provider: string; inlineCount: number; summaryPosted: boolean }[]; skipped?: boolean; reason?: string }>(
        `tasks/${encodeURIComponent(task.id)}/merge-requests/all/writeback`,
        { jobId: job.id },
      );
      if (!mounted.current || accessLost.current) return;
      if (res.skipped) {
        void message.warning(res.reason || '当前任务未关联来自 GitLab 或云效 Codeup 的 MR 代码材料。');
        return;
      }
      const totalInline = (res.writebacks || []).reduce((sum, item) => sum + item.inlineCount, 0);
      void message.success(`已将评审意见回写至 ${res.writebacks.length} 个合并请求（含 ${totalInline} 条行级评论与 1 条汇总评论）。`);
      await onChanged();
    } catch (error) {
      if (mounted.current) void message.error(error instanceof Error ? error.message : '回写 MR 评审意见失败。');
    } finally {
      if (mounted.current) setWritingBackMr(false);
    }
  };

  const submitReport = (values: ReportDraft) => {
    if (!job || !canReport) return;
    void run(async () => {
      const result = await api<{ job: ReviewJob }>('jobs/' + jobId + '/report', {
        summary: values.summary, source: job.executionMode === 'LOCAL_REPORT' ? 'LOCAL_TOOL' : 'MANUAL',
        ...(job.executionMode === 'LOCAL_REPORT' ? { tool: values.tool } : {}),
        ...(values.evidence?.trim() ? { evidence: values.evidence } : {}),
        findings: (values.findings || []).map(finding => ({
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          location: finding.location?.trim() ? finding.location : undefined,
          ...(finding.category ? { category: finding.category } : {}),
          ...(typeof finding.confidence === 'number' ? { confidence: finding.confidence } : {}),
          ...(finding.ruleId ? { ruleId: finding.ruleId } : {}),
          ...(finding.suggestedPatch ? { suggestedPatch: finding.suggestedPatch } : {}),
        })),
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

  return <Card title="评审详情" className="tf-review-card" extra={<Space size={4} wrap>{taskLink}<Button size="small" icon={<RefreshCw size={14} />} loading={busy} onClick={() => void run(refresh)}>刷新评审</Button></Space>}>
    <div className="tf-detail-stack">
      <div>
        <Flex gap={8} align="center" wrap><Typography.Title level={4} style={{ margin: 0 }}>{stageLabel(job.stage)}</Typography.Title><StatusBadge variant={historical && job.stale ? 'neutral' : statusVariant}>{historical && job.stale ? '快照已过期' : reviewStatusLabel(job.status)}</StatusBadge>{job.stale && !historical && <StatusBadge variant="warn">材料已更新·需重审</StatusBadge>}</Flex>
        <Typography.Paragraph type="secondary" className="tf-meta-line">{executionModeLabel(job.executionMode)} · {memberName(members, job.actorId)} · {timeText(job.createdAt)}</Typography.Paragraph>
      </div>
      {readOnly && <Typography.Paragraph type="secondary">{historical ? '历史评审，仅供查看。' : '任务已完成或上级任务已冻结，当前评审仅供查看。'}</Typography.Paragraph>}
      {!historical && (job.stale || job.status === 'CHANGES_REQUESTED') && (
        <Alert
          type="warning"
          showIcon
          title={job.stale ? '相关材料已更新，当前快照已过期（保留用于审计追溯）' : '本轮评审已退回修改，请在修复材料后重新发起评审'}
          description={canReReview ? (
            <Flex vertical gap={8} style={{ marginTop: 8 }}>
              {!bridgeUnavailable && <LocalAiExecutionFields size="small" capabilities={capabilities} engine={engine}
                onEngineChange={setEngine} model={model} runner={executionRunner} disabled={busy || startingAi} />}
              <Space size={8} wrap>
                {!bridgeUnavailable && <Button size="small" type="primary" icon={<Sparkles size={13} />} disabled={busy || model.invalid} onClick={() => recreateReview(true)}>
                  AI 重审
                </Button>}
                {!aiReviewOnly && <Button size="small" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => recreateReview(false)}>
                  重新发起评审
                </Button>}
                {aiReviewOnly && bridgeUnavailable && <Typography.Text type="secondary">{reviewBridgeUnavailableMessage}</Typography.Text>}
              </Space>
            </Flex>
          ) : undefined}
        />
      )}
      {!historical && job.executionMode === 'CLOUD_AI' && !job.report && (() => {
        const isCloudReady = cloudAiEnabled || (!!job.executor && job.executor !== 'UNCONFIGURED');
        const canRunCloud = !readOnly && !job.stale && REVIEW_ROLES[job.stage].includes(role);
        const configuredModel = job.executor?.startsWith('openai:') ? job.executor.slice('openai:'.length) : '';
        const modelText = configuredModel && configuredModel !== 'default'
          ? configuredModel
          : job.executor?.startsWith('dify:') ? '随 Dify 配置' : '使用服务端默认模型';
        return isCloudReady ? (
          <Card size="small">
            <Flex justify="space-between" align="center" gap={12} wrap>
              <Flex vertical gap={4} style={{ minWidth: 0 }}>
                <Space size={8}><Sparkles size={16} /><Typography.Text strong>云端 AI 评审</Typography.Text></Space>
                <Typography.Text type="secondary" ellipsis title={modelText}>配置模型 · {modelText}</Typography.Text>
              </Flex>
              {canRunCloud && (
                <Button type="primary" size="small" icon={<Play size={13} />} loading={runningCloudAi} onClick={() => void runCloudAiReview()}>
                  立即执行云端 AI 评审
                </Button>
              )}
            </Flex>
          </Card>
        ) : (
          <Alert
            type="info"
            showIcon
            title="当前项目尚未启用云端 AI 执行器"
            description={
              <Space size={8} wrap>
                <span>请在「平台连接 → 云端 AI · Webhook · IM 通知」配置 OpenAI 兼容接口或 Dify 工作流后即可直接云端执行。</span>
                <Button size="small" onClick={() => navigateWorkspace('connections')}>前往配置</Button>
              </Space>
            }
          />
        );
      })()}
      {job.report ? <>
        <div className="tf-detail-stack tf-detail-stack-small">
          <Flex justify="space-between" align="center" gap={8} wrap>
            <Typography.Title level={5} style={{ margin: 0 }}><Space size={8}><FileCheck2 size={18} />评审报告</Space></Typography.Title>
            <Space size={6} wrap>
              {job.stage === 'CODE_REVIEW' && !readOnly && (
                <Tooltip title="将评审摘要与带文件行号的发现项回写为 GitLab / 云效 Codeup 合并请求评论">
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<MessageSquarePlus size={13} />}
                    loading={writingBackMr}
                    onClick={() => void writebackToMr()}
                  >
                    回写评审意见到 MR
                  </Button>
                </Tooltip>
              )}
              <ReviewExportActions
                data={{
                  task: { jiraKey: task.jiraKey, title: task.title, url: task.externalRef?.url || null },
                  stage: job.stage,
                  isDraft: false,
                  stale: job.stale,
                  report: {
                    summary: job.report.summary,
                    evidence: job.report.evidence,
                    verdict: job.report.verdict,
                    score: job.report.score,
                    checklist: job.report.checklist,
                    meta: job.report.meta,
                    tool: job.report.tool,
                    createdAt: job.report.createdAt,
                    actorName: memberName(members, job.report.actorId),
                  },
                  findings: job.findings,
                }}
                extraExportItems={[
                  {
                    key: 'sarif',
                    icon: <Download size={14} />,
                    label: '导出 SARIF 2.1（开发工具格式）',
                    onClick: () => {
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
                    },
                  },
                ]}
              />
            </Space>
          </Flex>
          <Typography.Paragraph type="secondary">{memberName(members, job.report.actorId)} · {reportSourceLabel(job.report.source)}{job.report.tool ? ' · ' + toolLabel(job.report.tool) : ''} · {timeText(job.report.createdAt)}</Typography.Paragraph>
          <VerdictTag verdict={job.report.verdict} score={job.report.score} meta={job.report.meta} />
          <Typography.Paragraph className="tf-preserve"><LinkifiedText text={plainReviewText(job.report.summary)} /></Typography.Paragraph>
        </div>
        {job.findings.length > 0 && (() => {
          const unwaivedCriticalCount = job.findings.filter(item => item.severity === 'CRITICAL' && !item.waiver).length;
          const waivedCriticalCount = job.findings.filter(item => item.severity === 'CRITICAL' && !!item.waiver).length;
          const warnCount = job.findings.filter(item => item.severity === 'WARN').length;
          const infoCount = job.findings.filter(item => item.severity === 'INFO').length;
          const actionableCount = unwaivedCriticalCount + warnCount;
          const unwaivedAll = sortActionableFindings(job.findings);
          const categories = [...new Set(job.findings.map(item => item.category).filter(Boolean))] as FindingCategory[];
          const filteredFindings = sortReviewFindings(job.findings.filter(item => {
            if (findingFilter === 'UNWAIVED_CRITICAL' && !(item.severity === 'CRITICAL' && !item.waiver)) return false;
            if (findingFilter === 'ACTIONABLE' && !((item.severity === 'CRITICAL' && !item.waiver) || item.severity === 'WARN')) return false;
            if (categoryFilter !== 'ALL' && item.category !== categoryFilter) return false;
            return true;
          }));
          return (
            <div className="tf-detail-stack tf-detail-stack-small">
              <Flex justify="space-between" align="center" gap={8} wrap>
                <Space size={6} wrap>
                  <Typography.Text strong>评审问题 ({job.findings.length})</Typography.Text>
                  {unwaivedCriticalCount > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>{severityLabel('CRITICAL')} {unwaivedCriticalCount}</Tag>}
                  {waivedCriticalCount > 0 && <Tag color="purple" style={{ marginInlineEnd: 0 }}>P0 已豁免 {waivedCriticalCount}</Tag>}
                  {warnCount > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>{severityLabel('WARN')} {warnCount}</Tag>}
                  {infoCount > 0 && <Tag style={{ marginInlineEnd: 0 }}>{severityLabel('INFO')} {infoCount}</Tag>}
                </Space>
                <Space size={8} wrap>
                  {categories.length > 0 && (
                    <Select<'ALL' | FindingCategory>
                      size="small"
                      style={{ minWidth: 120 }}
                      value={categoryFilter}
                      onChange={setCategoryFilter}
                      options={[
                        { value: 'ALL', label: '全部分类' },
                        ...categories.map(c => ({ value: c, label: findingCategoryLabel(c) })),
                      ]}
                    />
                  )}
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
                      aria-label="评审问题等级筛选"
                      value={findingFilter}
                      onChange={setFindingFilter}
                      options={[
                        { value: 'ALL', label: `全部 (${job.findings.length})` },
                        { value: 'ACTIONABLE', label: `需处理的 P0–P1 (${actionableCount})` },
                        { value: 'UNWAIVED_CRITICAL', label: `未豁免 P0 (${unwaivedCriticalCount})` },
                      ]}
                    />
                  )}
                </Space>
              </Flex>
              {!filteredFindings.length ? (
                <Typography.Text type="secondary">没有符合筛选条件的问题。</Typography.Text>
              ) : filteredFindings.map(finding => (
                <Card key={finding.id} size="small" className="tf-finding-card">
                  <div className="tf-detail-stack tf-detail-stack-small">
                    <Flex justify="space-between" align="start" gap={8} wrap>
                      <Flex gap={8} align="start" wrap style={{ flex: 1, minWidth: 0 }}>
                        <StatusBadge variant={finding.severity === 'CRITICAL' && !finding.waiver ? 'block' : finding.severity === 'WARN' ? 'warn' : 'neutral'}>
                          {severityLabel(finding.severity)}
                        </StatusBadge>
                        <Typography.Text strong className="tf-break">{plainReviewText(finding.title)}</Typography.Text>
                        {finding.waiver && <Tag color="purple">已豁免</Tag>}
                      </Flex>
                      <Space size={4} wrap>
                        {!serverMode && !historical && (
                          <Button
                            size="small"
                            type="text"
                            icon={<MessageSquare size={13} />}
                            onClick={() => setAskTargetFindingId(finding.id)}
                          >
                            追问 AI
                          </Button>
                        )}
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
                            复制修复指令
                          </Button>
                        )}
                      </Space>
                    </Flex>
                    <ReviewFindingContent detail={finding.detail} location={finding.location} copyLocation />
                    {(finding.category || typeof finding.confidence === 'number' || finding.ruleId || finding.suggestedPatch) && (
                      <details className="tf-review-source-details">
                        <summary>技术细节</summary>
                        <Flex vertical gap={8}>
                          <FindingMetaBadges category={finding.category} confidence={finding.confidence} ruleId={finding.ruleId} />
                          <SuggestedPatchView patch={finding.suggestedPatch} />
                        </Flex>
                      </details>
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
        {!job.findings.length && <Typography.Text type="secondary">报告未列出问题。</Typography.Text>}
        {(job.report.evidence || job.report.meta || !!job.report.checklist?.length) && (
          <details className="tf-review-source-details">
            <summary>评审依据和检查详情</summary>
            <Flex vertical gap={10}>
              {job.report.evidence && <pre className="tf-code-panel"><LinkifiedText text={job.report.evidence} /></pre>}
              <ReportMetaSummary meta={job.report.meta} />
              {!!job.report.checklist?.length && <ChecklistTable items={job.report.checklist} />}
            </Flex>
          </details>
        )}
        {!serverMode && (!historical || askRuns.length > 0) && (
          <Card
            size="small"
            title={<Space size={6}><MessageSquare size={15} /><span>{historical ? '历史追问' : '追问评审报告'}</span></Space>}
          >
            <Flex vertical gap={8}>
              {!historical && <>
                <LocalAiExecutionFields size="small" capabilities={capabilities} engine={engine} onEngineChange={setEngine}
                  model={model} disabled={askingAi || !!runningAskRun} />
                {job.findings.length > 0 && (
                  <Select
                    size="small"
                    value={askTargetFindingId}
                    onChange={setAskTargetFindingId}
                    options={[
                      { value: '', label: '聚焦范围：整份评审报告' },
                      ...sortReviewFindings(job.findings).map(f => ({ value: f.id, label: `[${severityLabel(f.severity)}] ${f.title}` })),
                    ]}
                  />
                )}
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    placeholder="输入追问内容（只读核查快照与代码，按 Enter 发送）"
                    maxLength={1000}
                    value={askInput}
                    disabled={!!runningAskRun || askingAi}
                    onChange={e => setAskInput(e.target.value)}
                    onPressEnter={() => void startAskQuestion()}
                  />
                  {runningAskRun ? (
                    <Button danger icon={<Square size={13} />} onClick={() => void stopAiDraft(runningAskRun.id)}>停止</Button>
                  ) : (
                    <Button type="primary" loading={askingAi} disabled={!askInput.trim() || model.invalid} onClick={() => void startAskQuestion()}>追问 AI</Button>
                  )}
                </Space.Compact>
                <Flex gap={6} wrap>
                  {ASK_PRESETS.map(q => (
                    <Tag key={q} style={{ cursor: 'pointer', marginInlineEnd: 0 }} onClick={() => setAskInput(q)}>+ {q}</Tag>
                  ))}
                </Flex>
              </>}
              {askRuns.map(run => {
                const targetFinding = run.askFindingId ? job.findings.find(f => f.id === run.askFindingId) : null;
                return (
                  <Card key={run.id} size="small" style={{ background: 'var(--tf-raised)' }}>
                    <Flex justify="space-between" align="center" gap={6} wrap style={{ marginBottom: 6 }}>
                      <Space size={6} wrap>
                        <Tag color={run.status === 'SUCCEEDED' ? 'success' : run.status === 'RUNNING' ? 'processing' : 'error'}>
                          {run.status === 'RUNNING' ? '核查回答中…' : run.status === 'SUCCEEDED' ? 'AI 回答' : '执行异常'}
                        </Tag>
                        <AiRunIdentity run={run} />
                        {targetFinding && <Tag color="geekblue">{targetFinding.title}</Tag>}
                        <Typography.Text strong>{run.askQuestion || '专项核查追问'}</Typography.Text>
                      </Space>
                      {(run.draft?.answer || run.output) && (
                        <Button size="small" type="text" icon={<Copy size={12} />} onClick={() => { void navigator.clipboard.writeText(run.draft?.answer || run.output).then(() => message.success('已复制回答。')).catch(() => {}); }}>复制</Button>
                      )}
                    </Flex>
                    {(run.draft?.answer || run.output) ? <MarkdownPreview content={run.draft?.answer || run.output} /> : <Typography.Text type="secondary">{run.error || '正在基于冻结快照分析…'}</Typography.Text>}
                  </Card>
                );
              })}
            </Flex>
          </Card>
        )}
      </> : canReport && <>
        <div className="tf-form-width">
          <Typography.Title level={5}>提交评审报告</Typography.Title>
          <Typography.Paragraph type="secondary">报告提交后不可覆盖。本地工具报告由成员核对后提交，多人项目需由独立成员审批。</Typography.Paragraph>

          {job.executionMode === 'LOCAL_REPORT' && (
            <Card size="small" style={{ marginBottom: 16 }}>
              <Flex vertical gap={10}>
                <Space size={6}><Sparkles size={15} /><Typography.Text strong>生成评审草稿</Typography.Text></Space>
                <LocalAiExecutionFields size="small" capabilities={capabilities} engine={engine} onEngineChange={setEngine}
                  model={model} runner={executionRunner} disabled={!!runningAiRun || startingAi} />
                <Flex justify="space-between" align="center" gap={8} wrap>
                  {currentDraftRun && <AiRunIdentity run={currentDraftRun} />}
                  <Space size={8} wrap style={{ marginInlineStart: 'auto' }}>
                    {runningAiRun ? (
                      <Button size="small" danger icon={<Square size={13} />} onClick={() => void stopAiDraft(runningAiRun.id)}>停止生成</Button>
                    ) : (
                      <Button size="small" type="primary" icon={<Play size={13} />} loading={startingAi} disabled={bridgeUnavailable || model.invalid} onClick={() => void startAiDraft()}>{serverMode ? '派发到本机生成' : '一键生成并填入表单'}</Button>
                    )}
                    {latestDraftRun?.draft && !runningAiRun && (
                      <>
                        <Button size="small" onClick={() => applyDraftToForm(latestDraftRun)}>重新带入上次草稿</Button>
                        <ReviewExportActions
                          data={{
                            task: { jiraKey: task.jiraKey, title: task.title, url: task.externalRef?.url || null },
                            stage: job.stage,
                            isDraft: true,
                            stale: job.stale,
                            report: {
                              summary: latestDraftRun.draft.summary,
                              evidence: latestDraftRun.draft.evidence,
                              verdict: latestDraftRun.draft.verdict,
                              score: latestDraftRun.draft.score,
                              checklist: latestDraftRun.draft.checklist,
                              meta: latestDraftRun.draft.meta,
                              tool: latestDraftRun.tool,
                              createdAt: latestDraftRun.finishedAt || latestDraftRun.updatedAt,
                            },
                            findings: latestDraftRun.draft.findings || [],
                          }}
                        />
                      </>
                    )}
                  </Space>
                </Flex>
                {serverMode && !runningAiRun && (
                  <Typography.Text type={bridgeUnavailable ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                    {!bridgeDevice || bridgeUnavailable ? reviewBridgeUnavailableMessage
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
            {!!REPORT_SUMMARY_PRESETS[job.stage]?.length && (
              <Form.Item label="常用结论">
                <Select
                  aria-label="选择常用结论"
                  placeholder="选择后填入报告结论"
                  value={undefined}
                  options={REPORT_SUMMARY_PRESETS[job.stage].map(preset => ({ value: preset, label: preset }))}
                  onChange={value => reportForm.setFields([{ name: 'summary', value, errors: [] }])}
                />
              </Form.Item>
            )}
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
                  <Tooltip title="在服务端运行确定性安全扫描、OpenAPI 契约校验与项目可执行策略插件，将命中结果合并进发现项">
                    <Button icon={<ShieldCheck size={15} />} loading={runningPrecheck} disabled={fields.length >= 50} onClick={() => void runDeterministicPrecheck()}>
                      运行规则预检
                    </Button>
                  </Tooltip>
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
                <Form.Item name={[field.name, 'category']} hidden><Input /></Form.Item>
                <Form.Item name={[field.name, 'confidence']} hidden><Input /></Form.Item>
                <Form.Item name={[field.name, 'ruleId']} hidden><Input /></Form.Item>
                <Form.Item name={[field.name, 'suggestedPatch']} hidden><Input /></Form.Item>
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
            <Form.Item label="常用评语">
              <Select
                aria-label="选择常用评语"
                placeholder="选择后填入审批理由"
                value={undefined}
                options={(!hasCritical ? APPROVAL_REASON_PRESETS : REJECTION_REASON_PRESETS).map(preset => ({ value: preset, label: preset }))}
                onChange={value => decisionForm.setFields([{ name: 'reason', value, errors: [] }])}
              />
            </Form.Item>
            {hasCritical && <Typography.Paragraph type="secondary">存在尚未豁免的阻断问题，不能直接批准。可退回修改；技术方案与代码审核可记录具体豁免理由。</Typography.Paragraph>}
            <Space size={8} wrap>
              <Button type="primary" icon={<CheckCircle2 size={15} />} disabled={hasCritical} loading={busy} onClick={() => void decide('APPROVE')}>一键批准放行</Button>
              <Button loading={busy} onClick={() => void decide('REQUEST_CHANGES')}>退回修改</Button>
            </Space>
          </Form> : <Typography.Paragraph type="secondary">审批需对应阶段权限，且存在其他审批人时需由非报告作者、非任务受理人完成；输入版本需保持有效。</Typography.Paragraph>}
        </div>
      </>}
      <section className="tf-review-snapshot">
        <Typography.Title level={5}>评审配置与冻结材料</Typography.Title>
        <div className="tf-detail-stack tf-detail-stack-small">
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
        </div>
      </section>
    </div>
  </Card>;
};

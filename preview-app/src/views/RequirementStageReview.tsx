import { useEffect, useRef, useState } from 'react';
import { App, Button, Flex, Input, Select, Space, Tag, Typography } from 'antd';
import { ExternalLink, Paperclip, RefreshCw, Sparkles, Square } from 'lucide-react';
import { VerdictTag } from './ChainReportBits';
import { MarkdownPreview } from './MarkdownPreview';
import { aiRunStatusLabel, reviewStatusLabel, runLocationLabel, SEVERITY_OPTIONS, severityLabel, toolLabel } from './displayLabels';
import { plainReviewText, ReviewFindingContent, sortReviewFindings } from './ReviewFindingContent';
import { ReviewExportActions } from './ReviewExportActions';
import { readReviewCaseFile } from './reviewCaseFile';
import { discoverRequirementMergeRequests, materialSourceIdentity, REQUIREMENT_REVIEW_KINDS, startRequirementReview, type RequirementMergeRequestDiscovery, type RequirementReviewExecutor, type RequirementReviewStage } from './requirementReviewFlow';
import { currentAiReviews } from './reviewQueueSla';
import { extractTaskSmartHints } from './taskSmartLinks';
import { displayWorkspaceSection, navigateWorkspace, openTaskRoute } from './workspaceNavigation';
import { api, ApiError, REVIEW_ROLES, type LocalAiRun, type ReviewJob, type Role, type TaskDetailBundle, type User, type WorkTask } from './workspaceApi';

interface RequirementStageReviewProps {
  task: WorkTask;
  stage: RequirementReviewStage;
  user: User;
  role: Role;
  bundle?: TaskDetailBundle;
  relatedTasks?: readonly WorkTask[];
  available?: boolean;
  executor: RequirementReviewExecutor;
  onConfigure: () => void;
  onChanged?: () => Promise<void> | void;
  onUnauthorized: () => void;
  onForbidden: () => void;
}

const STAGE_PLACEHOLDERS: Record<RequirementReviewStage, string> = {
  PRD: '可补充 PRD 或原型链接',
  TECH_SPEC: '粘贴技术方案链接',
  TEST_CASE: '粘贴测试用例链接，或上传 XLSX',
  CODE_REVIEW: '补充合并请求（MR）链接',
};

function webUrl(value?: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {
    return undefined;
  }
}

export function RequirementStageReview({
  task, stage, user, role, bundle, relatedTasks, available, executor, onConfigure, onChanged, onUnauthorized, onForbidden,
}: RequirementStageReviewProps) {
  const { message } = App.useApp();
  const kind = REQUIREMENT_REVIEW_KINDS[stage];
  const isCodeReview = stage === 'CODE_REVIEW';
  const [sourceUrl, setSourceUrl] = useState('');
  const [manualMr, setManualMr] = useState(false);
  const [selectedMr, setSelectedMr] = useState('');
  const [scanAttempt, setScanAttempt] = useState(0);
  const [mrScan, setMrScan] = useState<{ key: string; result?: RequirementMergeRequestDiscovery }>();
  const [caseFile, setCaseFile] = useState<File>();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [isLoadingRun, setIsLoadingRun] = useState(false);
  const [run, setRun] = useState<LocalAiRun>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [startedJob, setStartedJob] = useState<ReviewJob>();
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const callbacks = useRef({ onChanged, onUnauthorized, onForbidden });
  callbacks.current = { onChanged, onUnauthorized, onForbidden };

  const matchingBundle = bundle?.task.id === task.id && bundle.task.projectId === task.projectId ? bundle : undefined;
  const jobs = (matchingBundle?.jobs || []).filter(item => item.stage === stage && item.executionMode !== 'HUMAN_REVIEW');
  const job = (startedJob && !jobs.some(item => item.id === startedJob.id) ? startedJob : undefined)
    || currentAiReviews(jobs)[0] || jobs[0];
  const activeRun = run?.jobId === job?.id ? run : undefined;
  const isRunning = activeRun?.status === 'RUNNING';
  const nextRunId = isRunning ? activeRun.id : '';
  const mayReview = REVIEW_ROLES[stage].includes(role) && task.status !== 'DONE';
  const scanKey = `${user.id}:${task.id}:${scanAttempt}`;
  const currentScan = mrScan?.key === scanKey ? mrScan : undefined;
  const scanning = isCodeReview && !currentScan;
  const mrCandidates = new Map<string, { url: string; label: string }>();
  for (const candidate of currentScan?.result?.candidates || []) {
    const url = webUrl(candidate.url);
    if (!url) continue;
    const identity = materialSourceIdentity(url);
    if (!mrCandidates.has(identity)) {
      const keys = candidate.taskKeys.join('、');
      mrCandidates.set(identity, { url, label: keys ? `${candidate.title} · ${keys}` : candidate.title });
    }
  }
  const activeMr = mrCandidates.get(selectedMr) || (mrCandidates.size === 1 ? mrCandidates.values().next().value : undefined);
  const reviewSource = isCodeReview && !manualMr ? activeMr?.url || '' : sourceUrl;
  const missingMr = isCodeReview && !reviewSource.trim();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!isCodeReview || !mayReview) return;
    let current = true;
    void discoverRequirementMergeRequests(task.id)
      .then(result => {
        if (current) setMrScan({ key: scanKey, result });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setMrScan({ key: scanKey });
        if (error instanceof ApiError && error.status === 401) callbacks.current.onUnauthorized();
        else if (error instanceof ApiError && error.status === 403) callbacks.current.onForbidden();
        else if (error instanceof Error) void message.error(error.message);
      });
    return () => { current = false; };
  }, [isCodeReview, mayReview, scanKey, task.id, message]);

  useEffect(() => {
    if (!job?.id) return;
    let current = true;
    setIsLoadingRun(true);
    void api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(task.id)}/ai-runs`)
      .then(({ runs }) => {
        if (!current) return;
        const latest = runs.find(item => item.mode === 'review' && item.jobId === job.id);
        setRun(existing => existing?.jobId === job.id && (!latest ||
          (existing.id === latest.id ? existing.updatedAt >= latest.updatedAt : existing.startedAt >= latest.startedAt)) ? existing : latest);
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 401) callbacks.current.onUnauthorized();
        else if (error instanceof ApiError && error.status === 403) callbacks.current.onForbidden();
        else if (error instanceof ApiError) void message.error(error.message);
      })
      .finally(() => { if (current) setIsLoadingRun(false); });
    return () => { current = false; };
  }, [task.id, job?.id, message]);

  useEffect(() => {
    if (!nextRunId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(nextRunId)}`);
        if (!current) return;
        setRun(result.run);
        if (result.run.status !== 'RUNNING') {
          void Promise.resolve(callbacks.current.onChanged?.()).catch(() => {});
          return;
        }
      } catch (error) {
        if (!current) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          if (error.status === 401) callbacks.current.onUnauthorized();
          else callbacks.current.onForbidden();
          return;
        }
      }
      timer = setTimeout(() => { void poll(); }, 1800);
    }
    timer = setTimeout(() => { void poll(); }, 1800);
    return () => { current = false; clearTimeout(timer); };
  }, [nextRunId]);

  const launch = async () => {
    if (!mayReview || available === false || inFlight.current || isRunning || isLoadingRun || missingMr) return;
    const link = webUrl(reviewSource);
    if (reviewSource.trim() && !link) {
      void message.warning('请输入有效的 HTTP 或 HTTPS 链接。');
      return;
    }
    const tab = executor.runner === 'workbench' ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    let tabOpened = false;
    inFlight.current = true;
    setStarting(true);
    setWarnings([]);
    try {
      const file = caseFile && stage === 'TEST_CASE' ? { name: caseFile.name, content: await readReviewCaseFile(caseFile) } : undefined;
      if (!mounted.current) return;
      const result = await startRequirementReview({ task, relatedTasks, stage, sourceUrl: link, caseFile: file, executor, isCurrent: () => mounted.current });
      if (!mounted.current) return;
      setRun(result.run);
      setWarnings(result.warnings || []);
      setStartedJob(result.job);
      const workbenchUrl = webUrl(result.run.workbenchUrl);
      if (tab && workbenchUrl) {
        tab.location.replace(workbenchUrl);
        tabOpened = true;
      }
      void Promise.resolve(callbacks.current.onChanged?.()).catch(() => {});
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) callbacks.current.onUnauthorized();
      else if (error instanceof Error) void message.error(error.message);
    } finally {
      if (!tabOpened) tab?.close();
      inFlight.current = false;
      if (mounted.current) setStarting(false);
    }
  };

  const stop = async () => {
    if (!activeRun || stopping) return;
    setStopping(true);
    try {
      const result = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(activeRun.id)}/stop`, {});
      if (mounted.current) setRun(result.run);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 401) callbacks.current.onUnauthorized();
      else if (error instanceof Error) void message.error(error.message);
    } finally {
      if (mounted.current) setStopping(false);
    }
  };

  const materialAssets = (matchingBundle?.assets || []).filter(asset => asset.kind === kind);
  const linkedInputs = new Map<string, { url: string; label: string; registered: boolean }>();
  for (const asset of materialAssets) {
    const url = webUrl(asset.sourceUrl);
    const identity = url && materialSourceIdentity(url);
    if (url && identity && !linkedInputs.has(identity)) linkedInputs.set(identity, { url, label: asset.title, registered: true });
  }
  const hintTasks = [task];
  if (stage === 'CODE_REVIEW' && relatedTasks) {
    const included = new Set([task.id]);
    for (const parent of hintTasks) {
      for (const item of relatedTasks) {
        if (item.parentId === parent.id && item.projectId === task.projectId && !included.has(item.id)) {
          included.add(item.id);
          hintTasks.push(item);
        }
      }
    }
  }
  for (const link of hintTasks.flatMap(item => extractTaskSmartHints(item).detectedLinks)) {
    const parsed = new URL(link.url);
    const gitHub = parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*/.test(parsed.pathname);
    const relevant = stage === 'PRD' ? link.provider !== 'jenkins' && !gitHub && !link.suggestedKinds.includes('CODE')
      : link.suggestedKinds.includes(kind) || stage === 'CODE_REVIEW' && gitHub;
    const identity = materialSourceIdentity(link.url);
    if (relevant && !linkedInputs.has(identity)) {
      const label = /(^|\.)figma\.com$/i.test(parsed.hostname) ? 'Figma 设计稿' : gitHub ? 'GitHub PR ' + parsed.pathname.split('/')[4] : link.label;
      linkedInputs.set(identity, { url: link.url, label, registered: false });
    }
  }
  const visibleSources = [...linkedInputs.values()]
    .filter(entry => !isCodeReview || !mrCandidates.has(materialSourceIdentity(entry.url))).slice(0, 4);
  const branchMatches = currentScan?.result?.branches || [];
  const scanNote = currentScan?.result?.reason || (currentScan?.result?.incomplete ? '部分来源未能读取' : '');
  const accountBlocked = /账号|权限/.test(currentScan?.result?.reason || '');
  const draft = activeRun?.draft;
  const report = job?.report || draft;
  const findings = sortReviewFindings([...((job?.report ? job.findings : draft?.findings) ?? [])]);
  const workbenchUrl = webUrl(activeRun?.workbenchUrl);

  return <section className="tf-requirement-stage" aria-label="AI 评审">
    <Flex vertical gap={10}>
      {mayReview && <Flex className="tf-requirement-source" gap={8} wrap="wrap" align="center">
        {isCodeReview && !manualMr ? <Select
          aria-label="选择关联 MR"
          placeholder={scanning ? '正在扫描关联 MR…' : mrCandidates.size ? '选择要评审的 MR' : currentScan?.result ? '暂未找到关联 MR' : '扫描未完成'}
          value={activeMr ? materialSourceIdentity(activeMr.url) : undefined}
          options={[...mrCandidates].map(([value, candidate]) => ({ value, label: candidate.label }))}
          showSearch
          optionFilterProp="label"
          onChange={setSelectedMr}
          loading={scanning}
          disabled={starting || isRunning || scanning || !mrCandidates.size}
          style={{ flex: '1 1 240px', minWidth: 0 }}
        /> : <Input
          aria-label={STAGE_PLACEHOLDERS[stage]}
          placeholder={STAGE_PLACEHOLDERS[stage]}
          value={sourceUrl}
          onChange={event => { setSourceUrl(event.target.value); if (caseFile) setCaseFile(undefined); }}
          onPressEnter={() => void launch()}
          disabled={starting || isRunning}
          style={{ flex: '1 1 240px' }}
        />}
        {isCodeReview && <>
          <Button icon={<RefreshCw size={14} />} disabled={starting || isRunning || scanning}
            onClick={() => setScanAttempt(value => value + 1)}>重新扫描</Button>
          <Button type="text" disabled={starting || isRunning} onClick={() => setManualMr(value => !value)}>
            {manualMr ? '返回候选' : '补充链接'}
          </Button>
        </>}
        {stage === 'TEST_CASE' && <>
          <input
            type="file"
            ref={fileInput}
            accept=".xlsx,.csv"
            hidden
            onChange={event => {
              const selected = event.currentTarget.files?.[0];
              if (selected) { setCaseFile(selected); setSourceUrl(''); }
              event.currentTarget.value = '';
            }}
          />
          <Button icon={<Paperclip size={14} />} onClick={() => fileInput.current?.click()} disabled={starting || isRunning}>上传 XLSX</Button>
        </>}
        {available === false
          ? <Button onClick={onConfigure}>配置 AI</Button>
          : <Button type="primary" icon={<Sparkles size={14} />} loading={starting} disabled={isRunning || isLoadingRun || missingMr} onClick={() => void launch()}>开始 AI 评审</Button>}
      </Flex>}
      {isCodeReview && scanNote && <Space wrap size={4}>
        <Typography.Text type="secondary">{scanNote}</Typography.Text>
        {accountBlocked && <Button type="link" size="small" onClick={() => navigateWorkspace('accounts')}>账号管理</Button>}
      </Space>}
      {isCodeReview && (!mrCandidates.size || currentScan?.result?.incomplete) && branchMatches.length > 0 &&
        <Space wrap size={[6, 4]}>
          <Typography.Text type="secondary">匹配分支</Typography.Text>
          {branchMatches.slice(0, 5).map(branch => <Tag key={branch.name} title={branch.commit}>{branch.name}</Tag>)}
        </Space>}
      {caseFile && <Space className="tf-requirement-attachments" wrap>
        <Typography.Text>{caseFile.name}</Typography.Text>
        <Button size="small" type="text" disabled={starting || isRunning} onClick={() => setCaseFile(undefined)}>移除</Button>
      </Space>}
      {!!visibleSources.length && <Space className="tf-requirement-attachments" size={[8, 4]} wrap>
        {visibleSources.map(entry => stage === 'PRD'
          ? <Typography.Link key={entry.url} href={entry.url} target="_blank" rel="noreferrer noopener" title={entry.label}>
            {entry.label}{entry.registered ? '' : ' · Jira 关联'}
          </Typography.Link>
          : <Button key={entry.url} size="small" type="link" title="用于本轮评审" disabled={!mayReview || starting || isRunning} onClick={() => {
            setSourceUrl(entry.url);
            setCaseFile(undefined);
            if (isCodeReview) setManualMr(true);
          }}>{entry.label}</Button>)}
      </Space>}
      {!linkedInputs.size && !!materialAssets.length && <Typography.Text type="secondary">已登记 {materialAssets[0].title}</Typography.Text>}
      {warnings.map(warning => <Typography.Text key={warning} type="warning">{warning}</Typography.Text>)}
      {!!activeRun && <Flex gap={8} align="center" wrap="wrap" aria-live="polite">
        <Tag color={isRunning ? 'processing' : activeRun.status === 'FAILED' ? 'error' : 'default'}>
          {runLocationLabel(activeRun)}{aiRunStatusLabel(activeRun.status)}
        </Tag>
        <Typography.Text type="secondary">{toolLabel(activeRun.tool)}{activeRun.effectiveModel || activeRun.model ? ` · ${activeRun.effectiveModel || activeRun.model}` : ''}</Typography.Text>
        {workbenchUrl && <Button type="link" size="small" icon={<ExternalLink size={13} />} href={workbenchUrl} target="_blank" rel="noreferrer noopener">打开工作台</Button>}
        {isRunning && activeRun.actorId === user.id && <Button size="small" icon={<Square size={12} />} loading={stopping} onClick={() => void stop()}>停止</Button>}
      </Flex>}
      {activeRun?.error && <Typography.Text type="danger">{activeRun.error}</Typography.Text>}
      {report && <div className="tf-requirement-result">
        <Flex justify="space-between" gap={8} align="center" wrap="wrap">
          <Space size={8} wrap>
            <Typography.Text strong>评审结果</Typography.Text>
            {job?.stale && <Tag style={{ marginInlineEnd: 0 }}>材料已变更</Tag>}
            {!job?.report && <Tag style={{ marginInlineEnd: 0 }}>草稿</Tag>}
            <VerdictTag verdict={report.verdict} score={report.score} />
          </Space>
          <Flex className="tf-requirement-result-badges" align="center" gap={8} wrap="wrap">
            <ReviewExportActions
              data={{
                task: { jiraKey: task.jiraKey, title: task.title, url: task.externalRef?.url || null },
                stage,
                isDraft: !job?.report,
                stale: job?.stale,
                report: {
                  summary: report.summary,
                  evidence: report.evidence,
                  verdict: report.verdict,
                  score: report.score,
                  checklist: report.checklist,
                  meta: report.meta,
                  tool: job?.report ? job.report.tool : activeRun?.tool,
                  createdAt: job?.report ? job.report.createdAt : (activeRun?.finishedAt || activeRun?.updatedAt),
                },
                findings,
              }}
            />
            {job && <Button type="link" size="small" onClick={() => openTaskRoute(task.id, { tab: 'reviews', jobId: job.id, from: displayWorkspaceSection(), requirementId: task.id })}>完整评审</Button>}
          </Flex>
        </Flex>
        <MarkdownPreview content={plainReviewText(report.summary)} />
        {findings.length > 0 && <>
          <Flex className="tf-review-priority-counts" gap={8} wrap="wrap" aria-label="问题优先级">
            {SEVERITY_OPTIONS.map(({ value, label }) => (
              <Tag key={value} color={value === 'CRITICAL' ? 'error' : value === 'WARN' ? 'warning' : 'default'}>
                {label} {findings.filter(finding => finding.severity === value).length}
              </Tag>
            ))}
          </Flex>
          <ul className="tf-stage-review-findings" aria-label="评审问题">
            {findings.map((finding, index) => <li key={index} className="tf-stage-review-finding">
              <Space size={6} wrap>
                <Tag color={finding.severity === 'CRITICAL' ? 'error' : finding.severity === 'WARN' ? 'warning' : 'default'}>{severityLabel(finding.severity)}</Tag>
                <Typography.Text strong>{plainReviewText(finding.title)}</Typography.Text>
                {'waiver' in finding && !!finding.waiver && <Tag>已豁免</Tag>}
              </Space>
              <ReviewFindingContent detail={finding.detail} location={finding.location} />
            </li>)}
          </ul>
        </>}
      </div>}
      {job && !report && !activeRun && !isLoadingRun && <Typography.Text type="secondary">
        {job.stale ? '材料已变更，可重新发起评审。' : reviewStatusLabel(job.status)}
      </Typography.Text>}
    </Flex>
  </section>;
}

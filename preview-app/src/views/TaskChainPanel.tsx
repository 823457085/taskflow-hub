import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Drawer, Dropdown, Empty, Flex, Input, Modal, Popconfirm, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { AlertTriangle, CheckCircle2, Copy, Download, ExternalLink, FileBarChart, GitBranch, ListTree, MinusCircle, MoreHorizontal, Plus, RefreshCw, Sparkles, Square, XCircle } from 'lucide-react';
import { api, ApiError, CHAIN_STAGE_ORDER, CHAIN_STAGE_SHORT } from './workspaceApi';
import type {
  ChainCheck, ChainChild, ChainLink, ChainLinkStatus, ChainNextAction, ChainObject,
  ChainStatusMap, DeliveryChain, LocalAiRun, LocalAutomationCapabilities, Stage,
} from './workspaceApi';
import { ChecklistTable, LINK_STATUS_META, ReportMetaSummary } from './ChainReportBits';
import { MarkdownPreview } from './MarkdownPreview';
import { AiRunIdentity, availableAiEngine, LocalAiExecutionFields, readAiEngine, useAiModelSelection } from './LocalAiExecutionFields';
import { severityLabel, taskStatusLabel } from './displayLabels';
import { ReviewExportActions } from './ReviewExportActions';
import './TaskChainPanel.css';

const DEFAULT_VISIBLE_FINDINGS = 3;
const DEFAULT_WAIVE_REASON = '已人工确认风险可控，暂不阻塞当前任务。';
const DETAIL_PAGINATION = { size: 'small', pageSize: 5, hideOnSinglePage: true, showSizeChanger: false } as const;

const PLAIN_STAGE_TITLE: Record<Stage, string> = {
  PRD: '需求文档',
  TASK_BREAKDOWN: '任务拆分',
  TECH_SPEC: '技术方案',
  CODE_REVIEW: '代码审查',
  TEST_CASE: '测试用例',
  RELEASE: '上线检查',
};

const PLAIN_STATUS_TEXT: Record<ChainLinkStatus, string> = {
  PASS: '已通过',
  LINKED: '已关联',
  BLOCKED: '未通过',
  CHANGES_REQUESTED: '需修改',
  CONDITIONAL: '有提醒',
  AWAITING_DECISION: '待确认',
  STALE: '需重审',
  REVIEWING: '评审中',
  READY: '待评审',
  MISSING: '缺材料',
};

function plainStageBadge(link: ChainLink): { label: string; tone: string } {
  const baseTone = (LINK_STATUS_META[link.status] || LINK_STATUS_META.MISSING).tone;
  if (link.status === 'LINKED') return { label: link.statusLabel || '已关联', tone: baseTone };
  if (link.status === 'BLOCKED' && link.advisory) {
    return { label: '建议优化', tone: 'warn' };
  }
  return { label: PLAIN_STATUS_TEXT[link.status] || link.statusLabel, tone: baseTone };
}

export const ChainStatusDots: React.FC<{ statuses: ChainStatusMap | null | undefined; size?: 'small' | 'default' }> = ({ statuses, size = 'default' }) => {
  if (!statuses) return <Typography.Text type="secondary">—</Typography.Text>;
  return <span className={`tf-chain-dots ${size === 'small' ? 'is-small' : ''}`} aria-label="AI 评审进度">
    {CHAIN_STAGE_ORDER.map(stage => {
      const status = statuses[stage];
      const meta = LINK_STATUS_META[status] || LINK_STATUS_META.MISSING;
      const text = PLAIN_STATUS_TEXT[status] || meta.label;
      return <Tooltip key={stage} title={`${PLAIN_STAGE_TITLE[stage]}：${text}`}><span className={`tf-chain-dot tone-${meta.tone}`}>{size === 'small' ? null : CHAIN_STAGE_SHORT[stage]}</span></Tooltip>;
    })}
  </span>;
};

const CheckIcon: React.FC<{ check: ChainCheck }> = ({ check }) => {
  if (check.ok === true) return <CheckCircle2 size={14} className="tf-chain-check-icon is-ok" />;
  if (check.ok === false) return check.level === 'required' ? <XCircle size={14} className="tf-chain-check-icon is-fail" /> : <AlertTriangle size={14} className="tf-chain-check-icon is-warn" />;
  return <MinusCircle size={14} className="tf-chain-check-icon is-na" />;
};

const ObjectRow: React.FC<{ object: ChainObject; onOpenTask: (id: string) => void; onLinkChild?: (key: string) => void; linking?: boolean }> = ({ object, onOpenTask, onLinkChild, linking }) => {
  const unlinked = object.type === 'jira-unlinked';
  const title = unlinked ? object.key || object.label : object.label;
  const icon = ['mr', 'branch', 'local-diff', 'repo', 'repo-local'].includes(object.type) ? <GitBranch size={13} /> : object.type === 'task' ? <ListTree size={13} /> : null;
  const label = object.type === 'task' && object.taskId
    ? <button type="button" className="tf-chain-object-link" onClick={() => onOpenTask(object.taskId!)}>{title}</button>
    : object.url ? <Typography.Link href={object.url} target="_blank" rel="noreferrer">{title}<ExternalLink size={11} className="tf-chain-ext-icon" /></Typography.Link>
      : <Typography.Text>{title}</Typography.Text>;
  const meta = unlinked ? 'Jira 未导入' : [object.meta, object.assignee].filter(Boolean).join(' · ');
  return <li className="tf-chain-object">
    <span className="tf-chain-object-label">
      {icon && <span className="tf-chain-object-icon" aria-hidden="true">{icon}</span>}
      <span className="tf-chain-object-title" title={object.label}>{label}</span>
    </span>
    {meta && <Typography.Text type="secondary" className="tf-chain-object-meta" title={meta}>{meta}</Typography.Text>}
    {unlinked && object.key && onLinkChild && (
      <Button type="link" size="small" className="tf-chain-object-action" loading={linking} onClick={() => onLinkChild(object.key!)}>导入</Button>
    )}
  </li>;
};

export const ChainReportDrawer: React.FC<{ taskId: string; jiraKey: string; open: boolean; onClose: () => void; onUnauthorized: () => void }> = ({ taskId, jiraKey, open, onClose, onUnauthorized }) => {
  const { message } = AntApp.useApp();
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true; setLoading(true);
    api<{ markdown: string }>(`tasks/${encodeURIComponent(taskId)}/chain-report`)
      .then(data => { if (alive) setMarkdown(data.markdown); })
      .catch(error => { if (error instanceof ApiError && error.status === 401) onUnauthorized(); else void message.error(error instanceof Error ? error.message : '报告生成失败。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, taskId]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${jiraKey}-AI评审总报告.md`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  };
  return <Drawer title={<Space size={8}><FileBarChart size={18} />AI 评审总报告 · {jiraKey}</Space>} size={880} open={open} onClose={onClose} className="tf-task-detail-drawer"
    extra={<Space size={6}>
      <Button icon={<Copy size={14} />} disabled={!markdown} onClick={() => { void navigator.clipboard.writeText(markdown).then(() => message.success('报告已复制为 Markdown，可直接粘贴到 Jira / Confluence。')).catch(() => message.warning('浏览器未能复制，请使用下载。')); }}>复制</Button>
      <Button type="primary" icon={<Download size={14} />} disabled={!markdown} onClick={download}>下载 .md</Button>
    </Space>}>
    {loading ? <Skeleton active paragraph={{ rows: 12 }} /> : markdown ? <div className="tf-chain-report"><MarkdownPreview content={markdown} /></div> : <Empty description="暂无报告" />}
  </Drawer>;
};

export const TaskChainPanel: React.FC<{
  taskId: string; refreshKey: string; frozen: boolean;
  wizardMode?: boolean;
  focusStage?: Stage;
  onSelectStage?: (stage?: Stage) => void;
  onChainLoaded?: (chain: DeliveryChain) => void;
  onAction: (link: ChainLink, action: ChainNextAction) => void;
  onRunAiReview?: (stage: Stage) => void;
  onAddInput?: (link: ChainLink) => void;
  onImportOpenApi?: () => void;
  onSyncJiraChildren?: () => void; syncingJiraChildren?: boolean;
  approvableJobIds?: readonly string[];
  waivableJobIds?: readonly string[];
  onQuickApprove?: (jobId: string) => void;
  onQuickWaive?: (jobId: string, findingId: string, reason: string) => Promise<void> | void;
  onOpenTask: (id: string) => void; onUnauthorized: () => void; onForbidden?: () => void; onChanged?: () => Promise<void> | void;
}> = ({
  taskId, refreshKey, frozen, focusStage, onSelectStage, onChainLoaded,
  onAction, onRunAiReview, onAddInput, onImportOpenApi, onSyncJiraChildren, syncingJiraChildren,
  approvableJobIds = [], waivableJobIds = [], onQuickApprove, onQuickWaive,
  onOpenTask, onUnauthorized, onForbidden, onChanged,
}) => {
  const { message } = AntApp.useApp();
  const [chain, setChain] = useState<DeliveryChain | null>(null);
  const [linkingKey, setLinkingKey] = useState('');
  const [analyzeRun, setAnalyzeRun] = useState<LocalAiRun | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisSetupOpen, setAnalysisSetupOpen] = useState(false);
  const [analysisCaps, setAnalysisCaps] = useState<LocalAutomationCapabilities | null>(null);
  const [analysisEngine, setAnalysisEngine] = useState(readAiEngine);
  const executionRunner = analysisCaps?.deployment === 'server' ? 'bridge' : 'local';
  const analysisModel = useAiModelSelection(analysisCaps, analysisEngine, executionRunner);
  const [localStage, setLocalStage] = useState<Stage | undefined>(undefined);
  const [waiveDrafts, setWaiveDrafts] = useState<Record<string, string>>({});
  const [waivingId, setWaivingId] = useState('');
  const sequence = useRef(0);

  useEffect(() => {
    setLocalStage(undefined);
    setAnalysisSetupOpen(false);
    setWaiveDrafts({});
  }, [taskId]);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const [data, runsRes] = await Promise.all([
        api<{ chain: DeliveryChain }>(`tasks/${encodeURIComponent(taskId)}/chain`),
        api<{ runs: LocalAiRun[] }>(`tasks/${encodeURIComponent(taskId)}/ai-runs`).catch(() => ({ runs: [] as LocalAiRun[] })),
      ]);
      if (current === sequence.current) {
        setChain(data.chain);
        onChainLoaded?.(data.chain);
        const latestAnalyze = (runsRes.runs || []).find(r => r.actionType === 'CHAIN_ANALYZE') || null;
        setAnalyzeRun(latestAnalyze);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else if (error instanceof ApiError && error.status === 403) onForbidden?.();
      else void message.error(error instanceof Error ? error.message : '评审流程加载失败。');
    }
  }, [taskId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!analyzeRun || analyzeRun.status !== 'RUNNING') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(analyzeRun.id)}`)
        .then(res => setAnalyzeRun(res.run))
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [analyzeRun?.id, analyzeRun?.status]);

  useEffect(() => {
    if (!analysisSetupOpen) return;
    let visible = true;
    void api<LocalAutomationCapabilities>('local-automation/capabilities').then(result => {
      if (!visible) return;
      setAnalysisCaps(result);
      setAnalysisEngine(preferred => availableAiEngine(result, preferred));
    }).catch(() => {});
    return () => { visible = false; };
  }, [analysisSetupOpen]);

  const startCrossAnalyze = async () => {
    if (analyzing || analyzeRun?.status === 'RUNNING' || analysisModel.invalid) return;
    setAnalyzing(true);
    try {
      const res = await api<{ run: LocalAiRun }>(`tasks/${encodeURIComponent(taskId)}/ai-runs`, {
        mode: 'read',
        actionType: 'CHAIN_ANALYZE',
        engine: analysisEngine,
        ...(analysisModel.model ? { model: analysisModel.model } : {}),
      });
      setAnalyzeRun(res.run);
      setAnalysisSetupOpen(false);
      void message.success('已发起跨阶段 AI 一致性检查。');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '启动一致性检查失败。');
    } finally {
      setAnalyzing(false);
    }
  };

  const stopCrossAnalyze = async () => {
    if (!analyzeRun) return;
    try {
      const res = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(analyzeRun.id)}/stop`, {});
      setAnalyzeRun(res.run);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '停止执行失败。');
    }
  };

  const linkChild = async (key: string) => {
    if (!chain) return;
    setLinkingKey(key);
    try {
      const result = await api<{ task: { jiraKey: string }; imported: boolean; linkedToParent: boolean }>('jira/tasks/import', { reference: key, projectId: chain.task.projectId, parentTaskId: chain.task.id });
      void message.success(`${result.task.jiraKey} 已${result.imported ? '导入并' : ''}关联为子任务。`);
      await onChanged?.();
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '导入关联失败。');
    } finally { setLinkingKey(''); }
  };

  if (!chain) return <div style={{ padding: '12px 0' }}><Skeleton active paragraph={{ rows: 5 }} /></div>;

  const activeStage = focusStage ?? localStage;
  const selectStage = (stage: Stage) => {
    if (onSelectStage) onSelectStage(stage);
    else setLocalStage(stage);
  };

  const currentLink = chain.links.find(link => link.id === chain.overall.currentLinkId) || null;
  const focusedLink = activeStage ? chain.links.find(link => link.stage === activeStage) || null : null;
  const activeLink = focusedLink || currentLink || chain.links[0];
  if (!activeLink) return null;
  const activeBadge = plainStageBadge(activeLink);
  const autoLinked = activeLink.status === 'LINKED' && activeLink.stage === 'TASK_BREAKDOWN';

  const stepReview = activeLink.review;
  const canApproveHere = !frozen && !!stepReview && !!onQuickApprove && approvableJobIds.includes(stepReview.jobId);
  const canWaiveHere = !frozen && !!stepReview && !!onQuickWaive && waivableJobIds.includes(stepReview.jobId);

  const conflicts = chain.analysis?.conflicts || [];
  const stepConflicts = conflicts.filter(c => c.linkIds.includes(activeLink.id));
  const activeFindings = (stepReview && !stepReview.stale ? stepReview.findings.items : [])
    .filter(item => item.severity !== 'INFO' && !item.waived)
    .sort((a, b) => Number(b.severity === 'CRITICAL') - Number(a.severity === 'CRITICAL'));
  const visibleFindings = activeFindings.slice(0, DEFAULT_VISIBLE_FINDINGS);

  const requiredIssues = activeLink.checks.filter(check => check.ok === false && check.level === 'required');
  const otherChecks = activeLink.checks.filter(check => !requiredIssues.includes(check));
  const passedChecks = activeLink.checks.filter(c => c.ok === true).length;
  const totalChecks = activeLink.checks.length;

  const triggerAiReview = () => {
    if (onRunAiReview) {
      onRunAiReview(activeLink.stage);
      return;
    }
    onAction(activeLink, { type: 'AI_REVIEW', label: '发起 AI 评审', stage: activeLink.stage, jobId: stepReview?.jobId });
  };

  const openFullReport = () => {
    if (!stepReview) return;
    onAction(activeLink, { type: 'VIEW', label: '查看完整报告', stage: activeLink.stage, jobId: stepReview.jobId });
  };

  const submitWaive = async (findingId: string) => {
    if (!stepReview || !onQuickWaive) return;
    const reason = (waiveDrafts[findingId] ?? DEFAULT_WAIVE_REASON).trim() || DEFAULT_WAIVE_REASON;
    setWaivingId(findingId);
    try {
      await onQuickWaive(stepReview.jobId, findingId, reason);
      await load();
    } finally {
      setWaivingId('');
    }
  };

  const missingInput = activeLink.status === 'MISSING';
  const inputLabel = activeLink.id === 'BREAKDOWN' ? '拆分子任务' : '补充材料';
  const reviewLabel = activeLink.status === 'REVIEWING' ? '生成评审报告' : stepReview ? '重新评审' : '发起评审';
  const reviewInMenu = canApproveHere || activeLink.status === 'PASS' || activeLink.status === 'REVIEWING' || activeLink.status === 'AWAITING_DECISION';
  const analysisRunning = analyzeRun?.status === 'RUNNING';
  const auditReport = analyzeRun?.draft?.answer || analyzeRun?.output || '';
  const stageActions: MenuProps['items'] = [
    ...(!frozen && !missingInput && onAddInput ? [{ key: 'input', icon: <Plus size={14} />, label: inputLabel }] : []),
    ...(!frozen && activeLink.stage === 'TECH_SPEC' && onImportOpenApi ? [{ key: 'openapi', label: '导入接口' }] : []),
    ...(!frozen && !missingInput && reviewInMenu ? [{ key: 'review', icon: <Sparkles size={14} />, label: reviewLabel }] : []),
    analysisRunning ? { key: 'stop', icon: <Square size={14} />, label: '停止跨阶段检查', danger: true }
      : { key: 'check', label: '跨阶段一致性检查', disabled: analyzing },
  ];
  const runStageAction: MenuProps['onClick'] = ({ key }) => {
    if (key === 'input') onAddInput?.(activeLink);
    else if (key === 'openapi') onImportOpenApi?.();
    else if (key === 'review') triggerAiReview();
    else if (key === 'stop') void stopCrossAnalyze();
    else if (key === 'check') { setAnalysisEngine(readAiEngine()); setAnalysisSetupOpen(true); }
  };

  return <div className="tf-wizard-panel">
    {analysisSetupOpen && <Modal title="跨阶段一致性检查" open width={460}
      onCancel={() => setAnalysisSetupOpen(false)} onOk={() => void startCrossAnalyze()} okText="开始检查"
      confirmLoading={analyzing} okButtonProps={{ disabled: analysisModel.invalid }}>
      <LocalAiExecutionFields capabilities={analysisCaps} engine={analysisEngine} onEngineChange={setAnalysisEngine}
        model={analysisModel} runner={executionRunner} disabled={analyzing} />
    </Modal>}
    <nav className="tf-wizard-steps" aria-label="交付阶段">
      {chain.links.map(link => {
        const isStepActive = link.id === activeLink.id;
        const stepBadge = plainStageBadge(link);
        const stepTitle = link.status === 'LINKED' ? 'Jira 子任务' : PLAIN_STAGE_TITLE[link.stage];
        return (
          <button
            key={link.id}
            type="button"
            className={`tf-wizard-step tone-${stepBadge.tone}${isStepActive ? ' is-active' : ''}`}
            aria-label={`${stepTitle} · ${stepBadge.label}`}
            aria-pressed={isStepActive}
            title={`${stepTitle} · ${stepBadge.label}`}
            onClick={() => selectStage(link.stage)}
          >
            <span className="tf-wizard-step-dot" aria-hidden="true" />
            <span className="tf-wizard-step-name">{link.status === 'LINKED' ? '子任务' : CHAIN_STAGE_SHORT[link.stage]}</span>
            <span className="tf-wizard-step-state">{stepBadge.label}</span>
          </button>
        );
      })}
    </nav>

    <div className="tf-wizard-stage-head">
      <div className="tf-wizard-stage-title-wrap">
        <Typography.Title level={5} className="tf-chain-overview-title">{autoLinked ? 'Jira 子任务' : PLAIN_STAGE_TITLE[activeLink.stage]}</Typography.Title>
        <span className={`tf-chain-pill tone-${activeBadge.tone}`}>{activeBadge.label}</span>
      </div>

      {autoLinked ? onSyncJiraChildren && (
        <Button size="small" icon={<RefreshCw size={14} />} loading={syncingJiraChildren} onClick={onSyncJiraChildren}>刷新 Jira 子任务</Button>
      ) : <Space size={6} className="tf-wizard-stage-actions">
        {!frozen && missingInput && onAddInput && (
          <Button size="small" type="primary" icon={<Plus size={14} />} onClick={() => onAddInput(activeLink)}>{inputLabel}</Button>
        )}
        {canApproveHere && stepReview && (
          <Button size="small" type="primary" icon={<CheckCircle2 size={14} />} onClick={() => onQuickApprove?.(stepReview.jobId)}>
            批准通过
          </Button>
        )}
        {!frozen && !missingInput && !reviewInMenu && (
          <Button size="small" type="primary" onClick={triggerAiReview}>{reviewLabel}</Button>
        )}
        <Dropdown trigger={['click']} menu={{ items: stageActions, onClick: runStageAction }}>
          <Button size="small" type="text" loading={analyzing} icon={<MoreHorizontal size={16} />} aria-label="更多环节操作" />
        </Dropdown>
      </Space>}
    </div>

    {autoLinked ? (
      <section className="tf-simple-section" aria-label="Jira 子任务列表">
        {chain.children.length > 0 ? (
          <Table<ChainChild> key={taskId} size="small" pagination={DETAIL_PAGINATION} rowKey="id" dataSource={chain.children} scroll={{ x: 390 }} columns={[
            { title: '子任务', render: (_, child) => <div className="tf-table-title"><Button type="link" size="small" onClick={() => onOpenTask(child.id)}>{child.jiraKey}</Button><Typography.Text className="tf-break">{child.title}</Typography.Text></div> },
            { title: '状态', width: 96, render: (_, child) => child.jiraStatus || taskStatusLabel(child.status) },
            { title: '来源', width: 90, render: (_, child) => child.url ? <Typography.Link href={child.url} target="_blank" rel="noreferrer">Jira 原单</Typography.Link> : '本地' },
          ]} />
        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关联子任务" />}
      </section>
    ) : <>

    {requiredIssues.length > 0 && (
      <section className="tf-simple-section">
        <Typography.Text strong>待处理</Typography.Text>
        <ul className="tf-chain-checks tf-chain-bounded-list" tabIndex={requiredIssues.length > 5 ? 0 : undefined} aria-label="待处理的检查">
          {requiredIssues.map(check => (
            <li key={check.id}>
              <CheckIcon check={check} />
              <span className="tf-break">{check.detail || check.label}</span>
            </li>
          ))}
        </ul>
      </section>
    )}

    {(activeLink.objects.length > 0 || !requiredIssues.length) && (
      <section className="tf-simple-section">
        <Typography.Text strong>关联材料</Typography.Text>

        {activeLink.objects.length > 0 ? (
          <ul className="tf-chain-objects tf-chain-bounded-list" tabIndex={activeLink.objects.length > 5 ? 0 : undefined} aria-label="关联材料">
            {activeLink.objects.map((object, index) => (
              <ObjectRow
                key={`${object.type}:${object.label}:${index}`}
                object={object}
                onOpenTask={onOpenTask}
                onLinkChild={frozen ? undefined : key => void linkChild(key)}
                linking={linkingKey === object.key}
              />
            ))}
          </ul>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {activeLink.missing.length ? `缺少 ${activeLink.missing.join('、')}` : '暂无关联材料'}
          </Typography.Text>
        )}
      </section>
    )}

    {stepReview && (
      <section className="tf-stage-review-box">
        <Flex justify="space-between" align="center" gap={8} className="tf-wizard-section-head">
          <Space size={8} align="center">
            <Typography.Text strong>{activeFindings.length ? `评审问题 (${activeFindings.length})` : '评审记录'}</Typography.Text>
            {stepReview.decision && (
              <Typography.Text type="secondary">{stepReview.decision.decision === 'APPROVE' ? '已批准' : '已退回'}</Typography.Text>
            )}
          </Space>
          <Space size={8} align="center" wrap>
            {(stepReview.summary || stepReview.findings.items.length > 0) && (
              <ReviewExportActions
                data={{
                  task: { jiraKey: chain.task.jiraKey, title: chain.task.title, url: chain.task.url },
                  stage: activeLink.stage,
                  isDraft: !stepReview.reportedAt,
                  stale: stepReview.stale,
                  report: {
                    summary: stepReview.summary,
                    verdict: stepReview.verdict,
                    score: stepReview.score,
                    checklist: stepReview.checklist,
                    meta: stepReview.meta,
                    tool: stepReview.tool,
                    createdAt: stepReview.reportedAt || stepReview.createdAt,
                  },
                  findings: stepReview.findings.items,
                }}
              />
            )}
            <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={openFullReport}>
              {stepReview.reportedAt ? '查看报告' : '查看评审'}
            </Button>
          </Space>
        </Flex>

        {visibleFindings.length > 0 && (
          <ul className="tf-wizard-findings">
            {visibleFindings.map(item => (
              <li key={item.id} className="tf-wizard-finding">
                <div className="tf-wizard-finding-head">
                  <Tag color={item.severity === 'CRITICAL' ? 'error' : 'warning'}>
                    {severityLabel(item.severity)}
                  </Tag>
                  <Typography.Text strong className="tf-wizard-finding-title" title={item.title}>{item.title}</Typography.Text>
                  {item.severity === 'CRITICAL' && canWaiveHere && (
                    <Popconfirm
                      title="忽略这条严重问题？"
                      description={
                        <div style={{ width: 260, marginTop: 6 }}>
                          <Input
                            size="small"
                            placeholder="填写忽略理由"
                            value={waiveDrafts[item.id] ?? DEFAULT_WAIVE_REASON}
                            onChange={e => setWaiveDrafts(prev => ({ ...prev, [item.id]: e.target.value }))}
                          />
                        </div>
                      }
                      okText="确认忽略"
                      cancelText="取消"
                      onConfirm={() => void submitWaive(item.id)}
                    >
                      <Button size="small" type="link" loading={waivingId === item.id} style={{ paddingInline: 4, height: 'auto' }}>
                        忽略此条
                      </Button>
                    </Popconfirm>
                  )}
                </div>
                <Typography.Paragraph type="secondary" className="tf-wizard-finding-description" title={item.detail}>
                  {item.detail}
                </Typography.Paragraph>
                {item.location && (
                  <Typography.Text code className="tf-wizard-finding-location" title={item.location}>{item.location}</Typography.Text>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    )}

    <section className="tf-simple-section">
      <Typography.Text strong>检查结果 <Typography.Text type="secondary">({passedChecks}/{totalChecks})</Typography.Text></Typography.Text>
      <div className="tf-simple-details-body">
        <ul className="tf-chain-checks tf-chain-bounded-list" tabIndex={otherChecks.length > 5 ? 0 : undefined} aria-label="检查清单">
          {otherChecks.map(check => (
            <li key={check.id}>
              <CheckIcon check={check} />
              <div className="tf-wizard-check-text">
                <span className="tf-wizard-check-label" title={check.label}>{check.label}</span>
                {check.detail && <Typography.Text type="secondary" className="tf-chain-check-detail" title={check.detail}>{check.detail}</Typography.Text>}
              </div>
            </li>
          ))}
        </ul>

        {analysisRunning && <Typography.Text type="secondary">跨阶段检查进行中</Typography.Text>}

        {stepConflicts.length > 0 && (
          <div className="tf-simple-subblock">
            <Typography.Text strong style={{ fontSize: 12.5 }}>跨阶段一致性提醒（{stepConflicts.length}）</Typography.Text>
            <ul className="tf-stage-conflict-list tf-chain-bounded-list" tabIndex={stepConflicts.length > 3 ? 0 : undefined} aria-label="跨阶段一致性提醒">
              {stepConflicts.map(c => (
                <li key={c.id}>
                  <Typography.Text strong>{c.title}</Typography.Text>{' '}
                  <Typography.Text type="secondary">{c.detail}</Typography.Text>
                </li>
              ))}
            </ul>
          </div>
        )}

        {activeLink.delta && (
          <div className="tf-chain-delta">
            <Space size={6} wrap>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>版本变化 r{activeLink.delta.fromRevision} → r{activeLink.delta.toRevision}</Tag>
              <Typography.Text type="success">+{activeLink.delta.additions}</Typography.Text>
              <Typography.Text type="danger">-{activeLink.delta.deletions}</Typography.Text>
            </Space>
            {activeLink.delta.previewLines.length > 0 && (
              <div className="tf-chain-delta-lines">
                {activeLink.delta.previewLines.map((line, i) => (
                  <div key={i} className={line.kind === '+' ? 'tf-chain-delta-add' : 'tf-chain-delta-del'}>
                    {line.kind} {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {analyzeRun && (
          <div className="tf-simple-subblock">
            <Flex align="center" justify="space-between" gap={8} wrap>
              <Typography.Text strong>跨阶段检查</Typography.Text>
              {auditReport && <Button size="small" type="link" icon={<Copy size={13} />} onClick={() => {
                void navigator.clipboard.writeText(auditReport).then(() => message.success('报告已复制。')).catch(() => message.error('无法写入剪贴板。'));
              }}>复制报告</Button>}
            </Flex>
            <AiRunIdentity run={analyzeRun} />
            {analyzeRun.draft?.summary && <Typography.Text type="secondary" className="tf-break">{analyzeRun.draft.summary}</Typography.Text>}
          </div>
        )}

        {stepReview?.meta && (
          <div className="tf-simple-subblock">
            <Typography.Text strong style={{ fontSize: 12.5 }}>结构化洞察</Typography.Text>
            <div className="tf-chain-evidence" tabIndex={0} aria-label="结构化评审明细">
              <ReportMetaSummary meta={stepReview.meta} />
            </div>
          </div>
        )}

        {stepReview?.checklist && stepReview.checklist.length > 0 && (
          <div className="tf-simple-subblock">
            <Typography.Text strong style={{ fontSize: 12.5 }}>AI 检查清单（{stepReview.checklist.length} 项）</Typography.Text>
            <div className="tf-chain-evidence" tabIndex={stepReview.checklist.length > 3 ? 0 : undefined} aria-label="AI 检查清单">
              <ChecklistTable items={stepReview.checklist} />
            </div>
          </div>
        )}

        {activeLink.stage === 'TASK_BREAKDOWN' && chain.traceability.length > 0 && (
          <div className="tf-simple-subblock">
            <Typography.Text strong style={{ fontSize: 12.5 }}>需求点 → 子任务覆盖情况</Typography.Text>
            <Table key={taskId} size="small" pagination={DETAIL_PAGINATION} rowKey={(row, index) => `${index}:${row.point}`} dataSource={chain.traceability} scroll={{ x: 440 }} columns={[
              { title: '需求点', dataIndex: 'point', render: value => <span className="tf-break">{value}</span> },
              { title: '覆盖', dataIndex: 'result', width: 90, render: value => <Tag color={value === 'PASS' ? 'success' : value === 'FAIL' ? 'error' : value === 'WARN' ? 'warning' : 'default'}>{{ PASS: '已覆盖', WARN: '部分', FAIL: '未覆盖', NA: '不适用' }[value as string] || value}</Tag> },
              { title: '子任务', width: 200, render: (_, row) => row.tasks.length ? <div className="tf-chain-trace-tasks">{row.tasks.map(item => <span key={item.key} className="tf-chain-trace-task">{item.taskId ? <Typography.Link onClick={() => onOpenTask(item.taskId!)}>{item.key}</Typography.Link> : <Typography.Text>{item.key}</Typography.Text>}</span>)}</div> : <Typography.Text type="danger">无</Typography.Text> },
              { title: '说明', dataIndex: 'note', render: value => <Typography.Text type="secondary" className="tf-break">{value}</Typography.Text> },
            ]} />
          </div>
        )}

        {activeLink.stage === 'TASK_BREAKDOWN' && chain.children.length > 0 && (
          <div className="tf-simple-subblock">
            <Typography.Text strong style={{ fontSize: 12.5 }}>研发子任务进度（{chain.children.length}）</Typography.Text>
            <Table<ChainChild> key={taskId} size="small" pagination={DETAIL_PAGINATION} rowKey="id" dataSource={chain.children} scroll={{ x: 340 }} columns={[
              { title: '子任务', render: (_, child) => <div className="tf-table-title"><Typography.Link onClick={() => onOpenTask(child.id)}>{child.jiraKey}</Typography.Link><Typography.Text type="secondary" className="tf-break">{child.title}</Typography.Text></div> },
              { title: '负责人', dataIndex: 'assignee', width: 96, render: value => value || '—' },
              { title: '状态', width: 96, render: (_, child) => taskStatusLabel(child.status) },
            ]} />
          </div>
        )}
      </div>
    </section>
    </>}
  </div>;
};

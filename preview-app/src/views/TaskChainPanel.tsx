import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Collapse, Drawer, Empty, Flex, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { AlertTriangle, CheckCircle2, Copy, Download, ExternalLink, FileBarChart, GitBranch, ListTree, MinusCircle, RefreshCw, Sparkles, XCircle } from 'lucide-react';
import { api, ApiError, CHAIN_STAGE_ORDER, CHAIN_STAGE_SHORT } from './workspaceApi';
import type { ChainCheck, ChainChild, ChainLink, ChainLinkStatus, ChainNextAction, ChainObject, ChainStatusMap, DeliveryChain } from './workspaceApi';
import { ChecklistTable, LINK_STATUS_META, VerdictTag } from './ChainReportBits';
import { MarkdownPreview } from './MarkdownPreview';
import './TaskChainPanel.css';

const OVERALL_META: Record<DeliveryChain['overall']['status'], { label: string; color: string }> = {
  PASS: { label: '全链路通过', color: 'success' },
  BLOCKED: { label: '存在阻断', color: 'error' },
  IN_PROGRESS: { label: '推进中', color: 'processing' },
};

export const ChainStatusDots: React.FC<{ statuses: ChainStatusMap | null | undefined; size?: 'small' | 'default' }> = ({ statuses, size = 'default' }) => {
  if (!statuses) return <Typography.Text type="secondary">—</Typography.Text>;
  return <span className={`tf-chain-dots ${size === 'small' ? 'is-small' : ''}`} aria-label="交付链路进度">
    {CHAIN_STAGE_ORDER.map(stage => {
      const status = statuses[stage];
      const meta = LINK_STATUS_META[status] || LINK_STATUS_META.MISSING;
      return <Tooltip key={stage} title={`${CHAIN_STAGE_SHORT[stage]}：${meta.label}`}><span className={`tf-chain-dot tone-${meta.tone}`}>{size === 'small' ? null : CHAIN_STAGE_SHORT[stage]}</span></Tooltip>;
    })}
  </span>;
};

const StatusPill: React.FC<{ status: ChainLinkStatus; label?: string }> = ({ status, label }) => {
  const meta = LINK_STATUS_META[status] || LINK_STATUS_META.MISSING;
  return <span className={`tf-chain-pill tone-${meta.tone}`}>{label || meta.label}</span>;
};

const CheckIcon: React.FC<{ check: ChainCheck }> = ({ check }) => {
  if (check.ok === true) return <CheckCircle2 size={15} className="tf-chain-check-icon is-ok" />;
  if (check.ok === false) return check.level === 'required' ? <XCircle size={15} className="tf-chain-check-icon is-fail" /> : <AlertTriangle size={15} className="tf-chain-check-icon is-warn" />;
  return <MinusCircle size={15} className="tf-chain-check-icon is-na" />;
};

const ObjectRow: React.FC<{ object: ChainObject; onOpenTask: (id: string) => void; onLinkChild?: (key: string) => void; linking?: boolean }> = ({ object, onOpenTask, onLinkChild, linking }) => {
  const icon = ['mr', 'branch', 'local-diff', 'repo', 'repo-local'].includes(object.type) ? <GitBranch size={13} /> : object.type === 'task' ? <ListTree size={13} /> : null;
  const label = object.type === 'task' && object.taskId
    ? <Typography.Link onClick={() => onOpenTask(object.taskId!)}>{object.label}</Typography.Link>
    : object.url ? <Typography.Link href={object.url} target="_blank" rel="noreferrer">{object.label}<ExternalLink size={11} className="tf-chain-ext-icon" /></Typography.Link>
      : <Typography.Text>{object.label}</Typography.Text>;
  return <li className={`tf-chain-object ${object.type === 'jira-unlinked' ? 'is-unlinked' : ''}`}>
    {icon && <span className="tf-chain-object-icon">{icon}</span>}
    <span className="tf-break">{label}{object.meta ? <Typography.Text type="secondary" className="tf-chain-object-meta"> · {object.meta}</Typography.Text> : null}{object.assignee ? <Typography.Text type="secondary" className="tf-chain-object-meta"> · {object.assignee}</Typography.Text> : null}</span>
    {object.type === 'jira-unlinked' && object.key && onLinkChild && <Button type="link" size="small" className="tf-chain-object-action" loading={linking} onClick={() => onLinkChild(object.key!)}>导入并关联</Button>}
  </li>;
};

const LinkCard: React.FC<{
  link: ChainLink; current: boolean; frozen: boolean; linkingKey: string;
  onAction: (link: ChainLink, action: ChainNextAction) => void; onOpenTask: (id: string) => void; onLinkChild: (key: string) => void; onAddInput?: (link: ChainLink) => void;
}> = ({ link, current, frozen, linkingKey, onAction, onOpenTask, onLinkChild, onAddInput }) => {
  const meta = LINK_STATUS_META[link.status];
  const review = link.review;
  const failedRequired = link.checks.filter(check => check.ok === false && check.level === 'required').length;
  const warnings = link.checks.filter(check => check.ok === false && check.level === 'advice').length;
  const actionDisabled = frozen && !['VIEW', 'DECIDE'].includes(link.next.type);
  const primary = ['AI_REVIEW', 'DECIDE', 'ADD_INPUT', 'ADD_SUBTASKS', 'FIX'].includes(link.next.type);
  return <section id={`chain-link-${link.id}`} className={`tf-chain-link tone-${meta.tone} ${current ? 'is-current' : ''}`} aria-label={`${link.index}. ${link.title}`}>
    <div className="tf-chain-link-rail"><span className="tf-chain-link-index">{link.index}</span></div>
    <Card size="small" className="tf-chain-link-card">
      <Flex justify="space-between" align="start" gap={12} wrap className="tf-chain-link-head">
        <div className="tf-chain-link-heading">
          <Space size={8} wrap>
            <Typography.Title level={5} className="tf-chain-link-title">{link.title}</Typography.Title>
            <StatusPill status={link.status} label={link.statusLabel} />
            {link.advisory && <Tooltip title="建议项：显示 AI 结论，但不阻止任务完成"><Tag>建议项</Tag></Tooltip>}
            {current && <Tag color="processing">当前环节</Tag>}
          </Space>
          <Typography.Text type="secondary" className="tf-chain-link-purpose">{link.purpose}</Typography.Text>
        </div>
        <Space size={6} wrap>
          {review && link.next.type !== 'VIEW' && link.next.type !== 'DECIDE' && <Button size="small" onClick={() => onAction(link, { type: 'VIEW', label: '查看报告', stage: link.stage, jobId: review.jobId })}>查看报告</Button>}
          <Button size="small" type={primary ? 'primary' : 'default'} icon={link.next.type === 'AI_REVIEW' ? <Sparkles size={14} /> : undefined} disabled={actionDisabled} onClick={() => onAction(link, link.next)}>{link.next.label}</Button>
        </Space>
      </Flex>
      <div className="tf-chain-link-grid">
        <div className="tf-chain-col">
          <Flex justify="space-between" align="center" gap={6}>
            <Typography.Text strong className="tf-chain-col-title">关联对象</Typography.Text>
            {!frozen && onAddInput && <Button type="link" size="small" className="tf-chain-object-action" onClick={() => onAddInput(link)}>{link.id === 'BREAKDOWN' ? '+ 拆分子任务' : '+ 补充 / 更新'}</Button>}
          </Flex>
          {link.objects.length ? <ul className="tf-chain-objects">{link.objects.map((object, index) => <ObjectRow key={`${object.type}:${object.label}:${index}`} object={object} onOpenTask={onOpenTask} onLinkChild={frozen ? undefined : onLinkChild} linking={linkingKey === object.key} />)}</ul>
            : <Typography.Text type="secondary">尚未关联{link.missing.length ? `（缺${link.missing.join('、')}）` : ''}</Typography.Text>}
        </div>
        <div className="tf-chain-col">
          <Typography.Text strong className="tf-chain-col-title">规则检查{failedRequired ? <Tag color="error" className="tf-chain-col-tag">{failedRequired} 项必需未满足</Tag> : warnings ? <Tag color="warning" className="tf-chain-col-tag">{warnings} 项建议</Tag> : null}</Typography.Text>
          <ul className="tf-chain-checks">{link.checks.map(check => <li key={check.id}>
            <CheckIcon check={check} />
            <span className="tf-break"><span className={check.ok === false && check.level === 'required' ? 'tf-chain-check-fail' : ''}>{check.label}</span>{check.level === 'required' && <Typography.Text type="secondary" className="tf-chain-required">必需</Typography.Text>}<Typography.Text type="secondary" className="tf-chain-check-detail">{check.detail}</Typography.Text></span>
          </li>)}</ul>
        </div>
        <div className="tf-chain-col">
          <Typography.Text strong className="tf-chain-col-title">AI 审核</Typography.Text>
          {review ? <div className="tf-chain-review">
            <Space size={4} wrap>
              <VerdictTag verdict={review.verdict} score={review.score} />
              {review.stale && <Tag color="warning">材料已变化</Tag>}
              {!review.reportedAt && <Tag color="processing">等待 AI 报告</Tag>}
            </Space>
            {review.summary && <Typography.Paragraph type="secondary" ellipsis={{ rows: 3, expandable: true, symbol: '展开' }} className="tf-chain-review-summary">{review.summary}</Typography.Paragraph>}
            {review.reportedAt && <Space size={6} wrap className="tf-chain-finding-counts">
              <Tag color={review.findings.critical ? 'error' : 'default'}>阻断 {review.findings.critical}</Tag>
              <Tag color={review.findings.warn ? 'warning' : 'default'}>警告 {review.findings.warn}</Tag>
              {review.findings.waived > 0 && <Tag>已豁免 {review.findings.waived}</Tag>}
            </Space>}
            {review.decision && <Typography.Text type="secondary" className="tf-chain-decision">人工确认：{review.decision.decision === 'APPROVE' ? '批准' : '退回'} · {review.decision.reason}</Typography.Text>}
          </div> : <Typography.Text type="secondary">{link.status === 'MISSING' ? '资料齐备后可发起 AI 审核' : '尚未审核'}</Typography.Text>}
        </div>
      </div>
      <Collapse ghost size="small" className="tf-chain-link-more" items={[
        ...(review?.checklist.length ? [{ key: 'checklist', label: `AI 检查清单（${review.checklist.length} 项）`, children: <ChecklistTable items={review.checklist} /> }] : []),
        ...(review?.findings.items.length ? [{ key: 'findings', label: `问题清单（${review.findings.items.length}）`, children: <ul className="tf-chain-findings">{review.findings.items.map(item => <li key={item.id}><Tag color={item.severity === 'CRITICAL' ? 'error' : item.severity === 'WARN' ? 'warning' : 'default'}>{item.severity}</Tag>{item.waived && <Tag>已豁免</Tag>}<Typography.Text strong>{item.title}</Typography.Text><Typography.Paragraph type="secondary" className="tf-preserve">{item.detail}{item.location ? `（${item.location}）` : ''}</Typography.Paragraph></li>)}</ul> }] : []),
        { key: 'focus', label: '本环节审核要点', children: <ol className="tf-chain-focus">{link.focus.map(item => <li key={item}>{item}</li>)}</ol> },
      ]} />
    </Card>
  </section>;
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
    const link = document.createElement('a'); link.href = url; link.download = `${jiraKey}-交付链路审核报告.md`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  };
  return <Drawer title={<Space size={8}><FileBarChart size={18} />交付链路审核报告 · {jiraKey}</Space>} size={880} open={open} onClose={onClose} className="tf-task-detail-drawer"
    extra={<Space size={6}>
      <Button icon={<Copy size={14} />} disabled={!markdown} onClick={() => { void navigator.clipboard.writeText(markdown).then(() => message.success('报告已复制为 Markdown，可直接粘贴到 Jira / Confluence。')).catch(() => message.warning('浏览器未能复制，请使用下载。')); }}>复制</Button>
      <Button type="primary" icon={<Download size={14} />} disabled={!markdown} onClick={download}>下载 .md</Button>
    </Space>}>
    {loading ? <Skeleton active paragraph={{ rows: 12 }} /> : markdown ? <div className="tf-chain-report"><MarkdownPreview content={markdown} /></div> : <Empty description="暂无报告" />}
  </Drawer>;
};

export const TaskChainPanel: React.FC<{
  taskId: string; refreshKey: string; frozen: boolean;
  onAction: (link: ChainLink, action: ChainNextAction) => void;
  onAddInput?: (link: ChainLink) => void;
  onOpenTask: (id: string) => void; onUnauthorized: () => void; onForbidden?: () => void; onChanged?: () => Promise<void> | void;
}> = ({ taskId, refreshKey, frozen, onAction, onAddInput, onOpenTask, onUnauthorized, onForbidden, onChanged }) => {
  const { message } = AntApp.useApp();
  const [chain, setChain] = useState<DeliveryChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportOpen, setReportOpen] = useState(false);
  const [linkingKey, setLinkingKey] = useState('');
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const data = await api<{ chain: DeliveryChain }>(`tasks/${encodeURIComponent(taskId)}/chain`);
      if (current === sequence.current) setChain(data.chain);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else if (error instanceof ApiError && error.status === 403) onForbidden?.();
      else void message.error(error instanceof Error ? error.message : '交付链路加载失败。');
    } finally { if (current === sequence.current) setLoading(false); }
  }, [taskId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  // Import a Jira item declared in the dev task (交付物 / 相关开发事项) and link it as a child of this task.
  const linkChild = async (key: string) => {
    if (!chain) return;
    setLinkingKey(key);
    try {
      const result = await api<{ task: { jiraKey: string }; imported: boolean; linkedToParent: boolean }>('jira/tasks/import', { reference: key, projectId: chain.task.projectId, parentTaskId: chain.task.id });
      void message.success(`${result.task.jiraKey} 已${result.imported ? '导入并' : ''}关联为研发子任务。`);
      await onChanged?.();
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '导入关联失败。');
    } finally { setLinkingKey(''); }
  };

  if (!chain) return <Card><Skeleton active paragraph={{ rows: 8 }} /></Card>;
  const overall = OVERALL_META[chain.overall.status];
  const currentLink = chain.links.find(link => link.id === chain.overall.currentLinkId) || null;
  const jumpTo = (id: string) => document.getElementById(`chain-link-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  return <div className="tf-chain-panel">
    <Card className="tf-chain-overview" size="small">
      <Flex justify="space-between" align="start" gap={12} wrap>
        <div className="tf-chain-overview-main">
          <Space size={8} wrap>
            <Typography.Title level={5} className="tf-chain-overview-title">交付链路</Typography.Title>
            <Tag color={overall.color}>{overall.label}</Tag>
            <Typography.Text type="secondary">门禁 {chain.overall.passed}/{chain.overall.total} 通过</Typography.Text>
            {chain.overall.score !== null && <Typography.Text type="secondary">· AI 平均评分 {chain.overall.score}</Typography.Text>}
            {chain.requirementKeys.length > 0 && <Typography.Text type="secondary">· 需求 {chain.requirementKeys.join('、')}</Typography.Text>}
            {chain.parent && <Typography.Text type="secondary">· 父任务 <Typography.Link onClick={() => onOpenTask(chain.parent!.id)}>{chain.parent.jiraKey}</Typography.Link></Typography.Text>}
          </Space>
          <Typography.Text type="secondary" className="tf-chain-overview-hint">
            {currentLink ? <>下一步：<Typography.Text strong>{currentLink.index}. {currentLink.title}</Typography.Text> — {currentLink.next.label}</> : '全部环节已通过，可在顶部「一键完成核验」归档任务。'}
          </Typography.Text>
        </div>
        <Space size={6} wrap>
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void load()}>刷新</Button>
          {currentLink && !frozen && <Button icon={currentLink.next.type === 'AI_REVIEW' ? <Sparkles size={14} /> : undefined} onClick={() => onAction(currentLink, currentLink.next)}>{currentLink.next.label}</Button>}
          <Button type="primary" icon={<FileBarChart size={14} />} onClick={() => setReportOpen(true)}>链路审核报告</Button>
        </Space>
      </Flex>
      <ol className="tf-chain-strip" aria-label="交付链路环节">
        {chain.links.map(link => <li key={link.id}>
          <button type="button" className={`tf-chain-strip-node tone-${LINK_STATUS_META[link.status].tone} ${link.id === chain.overall.currentLinkId ? 'is-current' : ''}`} onClick={() => jumpTo(link.id)}>
            <span className="tf-chain-strip-index">{link.index}</span>
            <span className="tf-chain-strip-text"><span className="tf-chain-strip-title">{link.title}</span><span className="tf-chain-strip-status">{link.statusLabel}{link.review?.score !== null && link.review?.score !== undefined ? ` · ${link.review.score}` : ''}</span></span>
          </button>
        </li>)}
      </ol>
      {chain.overall.blockers.length > 0 && <Alert type="error" showIcon className="tf-chain-blockers" title={`${chain.overall.blockers.length} 项阻断需要处理`} description={<ul>{chain.overall.blockers.slice(0, 6).map((item, index) => <li key={index}><Typography.Link onClick={() => jumpTo(item.linkId)}>[{item.link}]</Typography.Link> <Typography.Text strong>{item.title}</Typography.Text> <Typography.Text type="secondary">{item.detail}</Typography.Text></li>)}{chain.overall.blockers.length > 6 && <li>… 其余 {chain.overall.blockers.length - 6} 项见链路审核报告</li>}</ul>} />}
    </Card>

    <div className="tf-chain-links">
      {chain.links.map(link => <LinkCard key={link.id} link={link} current={link.id === chain.overall.currentLinkId} frozen={frozen} linkingKey={linkingKey} onAction={onAction} onAddInput={onAddInput} onOpenTask={onOpenTask} onLinkChild={key => void linkChild(key)} />)}
    </div>

    {chain.traceability.length > 0 && <Card size="small" title="追溯矩阵：需求点 → 子任务" className="tf-chain-trace">
      <Table size="small" pagination={false} rowKey={(row, index) => `${index}:${row.point}`} dataSource={chain.traceability} columns={[
        { title: '需求点', dataIndex: 'point', render: value => <span className="tf-break">{value}</span> },
        { title: '覆盖', dataIndex: 'result', width: 90, render: value => <Tag color={value === 'PASS' ? 'success' : value === 'FAIL' ? 'error' : value === 'WARN' ? 'warning' : 'default'}>{{ PASS: '已覆盖', WARN: '部分', FAIL: '未覆盖', NA: '不适用' }[value as string] || value}</Tag> },
        { title: '承接子任务', width: 220, render: (_, row) => row.tasks.length ? <div className="tf-chain-trace-tasks">{row.tasks.map(item => <span key={item.key} className="tf-chain-trace-task">{item.taskId ? <Typography.Link onClick={() => onOpenTask(item.taskId!)}>{item.key}</Typography.Link> : <Typography.Text>{item.key}</Typography.Text>}<ChainStatusDots statuses={item.links} size="small" /></span>)}</div> : <Typography.Text type="danger">无</Typography.Text> },
        { title: '说明', dataIndex: 'note', render: value => <Typography.Text type="secondary" className="tf-break">{value}</Typography.Text> },
      ]} />
    </Card>}

    {chain.children.length > 0 && <Card size="small" title={`研发子任务链路（${chain.children.length}）`} className="tf-chain-children">
      <Table<ChainChild> size="small" pagination={false} rowKey="id" dataSource={chain.children} scroll={{ x: 640 }} columns={[
        { title: '子任务', render: (_, child) => <div className="tf-table-title"><Typography.Link onClick={() => onOpenTask(child.id)}>{child.jiraKey}</Typography.Link><Typography.Text type="secondary" className="tf-break">{child.title}</Typography.Text></div> },
        { title: '受理人', dataIndex: 'assignee', width: 110, render: value => value || '—' },
        { title: 'Jira 状态', dataIndex: 'jiraStatus', width: 100, render: value => value || '—' },
        { title: '链路进度', width: 300, render: (_, child) => <ChainStatusDots statuses={child.links} /> },
      ]} />
    </Card>}

    <ChainReportDrawer taskId={taskId} jiraKey={chain.task.jiraKey} open={reportOpen} onClose={() => setReportOpen(false)} onUnauthorized={onUnauthorized} />
  </div>;
};

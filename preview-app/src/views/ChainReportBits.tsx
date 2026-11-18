import React from 'react';
import { Table, Tag, Tooltip, Typography } from 'antd';
import type { ChainLinkStatus, ChecklistItem, LocalAiRunDraft, ReportVerdict } from './workspaceApi';

export const VERDICT_META: Record<ReportVerdict, { label: string; color: string }> = {
  PASS: { label: '通过', color: 'success' },
  CONDITIONAL: { label: '有条件通过', color: 'warning' },
  FAIL: { label: '不通过', color: 'error' },
};

export const LINK_STATUS_META: Record<ChainLinkStatus, { label: string; tone: 'done' | 'warn' | 'error' | 'active' | 'idle' }> = {
  MISSING: { label: '缺资料', tone: 'idle' },
  READY: { label: '待 AI 审核', tone: 'active' },
  REVIEWING: { label: '审核中', tone: 'active' },
  AWAITING_DECISION: { label: '待确认', tone: 'active' },
  PASS: { label: '通过', tone: 'done' },
  CONDITIONAL: { label: '有条件通过', tone: 'warn' },
  CHANGES_REQUESTED: { label: '退回修改', tone: 'error' },
  BLOCKED: { label: '阻断', tone: 'error' },
  STALE: { label: '需重审', tone: 'warn' },
};

const RESULT_META: Record<ChecklistItem['result'], { label: string; color: string }> = {
  PASS: { label: '满足', color: 'success' },
  WARN: { label: '待完善', color: 'warning' },
  FAIL: { label: '不满足', color: 'error' },
  NA: { label: '不适用', color: 'default' },
};

export const VerdictTag: React.FC<{ verdict?: ReportVerdict | null; score?: number | null }> = ({ verdict, score }) => {
  if (!verdict && (score === null || score === undefined)) return null;
  return <span className="tf-verdict">
    {verdict && <Tag color={VERDICT_META[verdict].color} style={{ marginInlineEnd: 4 }}>AI 结论：{VERDICT_META[verdict].label}</Tag>}
    {score !== null && score !== undefined && <Tooltip title="AI 按本环节审核清单给出的评分（0-100）"><Tag>评分 {score}</Tag></Tooltip>}
  </span>;
};

export const ChecklistTable: React.FC<{ items: ChecklistItem[]; compact?: boolean }> = ({ items, compact }) => {
  if (!items.length) return null;
  return <Table<ChecklistItem>
    className="tf-checklist-table"
    size="small"
    rowKey={(item, index) => `${index}:${item.item}`}
    pagination={false}
    dataSource={items}
    columns={[
      { title: '审核项', dataIndex: 'item', render: value => <Typography.Text className="tf-break">{value}</Typography.Text> },
      { title: '结果', dataIndex: 'result', width: 92, render: (value: ChecklistItem['result']) => <Tag color={RESULT_META[value]?.color}>{RESULT_META[value]?.label || value}</Tag> },
      ...(compact ? [] : [{ title: '依据 / 差距', dataIndex: 'note', render: (value: string, item: ChecklistItem) => <Typography.Text type="secondary" className="tf-break">{value}{item.ref ? <Typography.Text code style={{ marginInlineStart: 6 }}>{item.ref}</Typography.Text> : null}</Typography.Text> }]),
    ]}
  />;
};

/** Extra structured fields an AI draft may carry beyond summary/findings. */
export const draftExtras = (draft: LocalAiRunDraft | null | undefined) => ({
  ...(draft?.verdict ? { verdict: draft.verdict } : {}),
  ...(typeof draft?.score === 'number' ? { score: draft.score } : {}),
  ...(draft?.checklist?.length ? { checklist: draft.checklist } : {}),
});

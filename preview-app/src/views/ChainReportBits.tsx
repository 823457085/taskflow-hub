import React from 'react';
import { Flex, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { findingCategoryLabel, riskLevelLabel } from './displayLabels';
import type {
  ChainLinkStatus, ChecklistItem, FindingCategory, LocalAiRunDraft,
  ReportMeta, ReportVerdict, RiskLevel, WalkthroughItem,
} from './workspaceApi';

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
  LINKED: { label: '已关联', tone: 'idle' },
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

const RISK_COLORS: Record<RiskLevel, string> = { low: 'success', medium: 'warning', high: 'error' };

export const VerdictTag: React.FC<{ verdict?: ReportVerdict | null; score?: number | null; meta?: ReportMeta }> = ({ verdict, score, meta }) => {
  if (!verdict && (score === null || score === undefined) && !meta?.riskLevel && !meta?.effortScore) return null;
  return <span className="tf-verdict" style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
    {verdict && <Tag color={VERDICT_META[verdict].color} style={{ marginInlineEnd: 0 }}>AI 结论：{VERDICT_META[verdict].label}</Tag>}
    {score !== null && score !== undefined && <Tooltip title="AI 按本环节审核清单给出的评分（0-100）"><Tag style={{ marginInlineEnd: 0 }}>评分 {score}</Tag></Tooltip>}
    {meta?.riskLevel && <Tag color={RISK_COLORS[meta.riskLevel]} style={{ marginInlineEnd: 0 }}>{riskLevelLabel(meta.riskLevel)}</Tag>}
    {typeof meta?.effortScore === 'number' && <Tooltip title="审校复杂度估算（1 极简 - 5 极复杂）"><Tag style={{ marginInlineEnd: 0 }}>审校工作量 {meta.effortScore}/5</Tag></Tooltip>}
  </span>;
};

export const ChecklistTable: React.FC<{ items: ChecklistItem[]; compact?: boolean }> = ({ items, compact }) => {
  if (!items.length) return null;
  return (
    <div
      className="tf-checklist-table"
      style={{
        display: 'grid',
        gap: 8,
        minWidth: 0,
      }}
    >
      {items.map((item, index) => {
        const meta = RESULT_META[item.result] || { label: item.result, color: 'default' };
        const refs = item.ref
          ? item.ref.split(/[,，;；]+/).map(s => s.trim()).filter(Boolean)
          : [];
        return (
          <div
            key={`${index}:${item.item}`}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--tf-border)',
              background: 'var(--tf-surface)',
              display: 'grid',
              gap: 6,
              minWidth: 0,
            }}
          >
            <Flex align="center" justify="space-between" gap={8} wrap>
              <Space size={8} align="center" wrap style={{ minWidth: 0, flex: 1 }}>
                <Tag color={meta.color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                  {meta.label}
                </Tag>
                <Typography.Text strong className="tf-break" style={{ fontSize: 13 }}>
                  {item.item}
                </Typography.Text>
              </Space>
            </Flex>
            {!compact && item.note && (
              <Typography.Paragraph
                type="secondary"
                className="tf-break"
                style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}
              >
                {item.note}
              </Typography.Paragraph>
            )}
            {!compact && refs.length > 0 && (
              <Flex gap={6} wrap>
                {refs.map((refStr, idx) => (
                  <Typography.Text
                    key={`${idx}:${refStr}`}
                    code
                    style={{ fontSize: 11.5, wordBreak: 'break-all', margin: 0 }}
                  >
                    {refStr}
                  </Typography.Text>
                ))}
              </Flex>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const FindingMetaBadges: React.FC<{ category?: FindingCategory; confidence?: number; ruleId?: string }> = ({ category, confidence, ruleId }) => {
  if (!category && typeof confidence !== 'number' && !ruleId) return null;
  return <Space size={4} wrap>
    {category && <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{findingCategoryLabel(category)}</Tag>}
    {typeof confidence === 'number' && (
      <Tag color={confidence >= 8 ? 'green' : confidence >= 6 ? 'default' : 'warning'} style={{ marginInlineEnd: 0 }}>
        置信度 {confidence}/10
      </Tag>
    )}
    {ruleId && <Typography.Text code style={{ fontSize: 11 }}>{ruleId}</Typography.Text>}
  </Space>;
};

export const SuggestedPatchView: React.FC<{ patch?: { before: string; after: string } }> = ({ patch }) => {
  if (!patch || (!patch.before && !patch.after)) return null;
  return (
    <section aria-label="建议修复代码" style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <Typography.Text strong>建议修复代码</Typography.Text>
      {patch.before && <pre className="tf-code-panel" style={{ margin: 0, maxHeight: 200, borderLeft: '3px solid var(--tf-error, #dc2626)' }}>- {patch.before}</pre>}
      {patch.after && <pre className="tf-code-panel" style={{ margin: 0, maxHeight: 200, borderLeft: '3px solid var(--tf-success, #16a34a)' }}>+ {patch.after}</pre>}
    </section>
  );
};

export const ReportMetaSummary: React.FC<{ meta?: ReportMeta }> = ({ meta }) => {
  if (!meta) return null;
  const sections: { key: string; title: string; children: React.ReactNode }[] = [];
  if (meta.clarifyQuestions?.length) {
    sections.push({
      key: 'clarify',
      title: `待澄清问题（${meta.clarifyQuestions.length}）`,
      children: (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          {meta.clarifyQuestions.map(q => (
            <li key={q.id}>
              <Space size={6} wrap>
                <Typography.Text code>{q.id}</Typography.Text>
                <Typography.Text strong>{q.question}</Typography.Text>
                {q.owner && <Tag style={{ marginInlineEnd: 0 }}>{q.owner}</Tag>}
                <Tag color={q.resolved ? 'success' : 'warning'} style={{ marginInlineEnd: 0 }}>{q.resolved ? '已闭环' : '待确认'}</Tag>
              </Space>
              {q.impact && <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>影响：{q.impact}</Typography.Text>}
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (meta.walkthrough?.length) {
    sections.push({
      key: 'walkthrough',
      title: `改动概览（${meta.walkthrough.length}）`,
      children: (
        <Table<WalkthroughItem>
          size="small"
          scroll={{ x: 360 }}
          pagination={false}
          rowKey={(item, idx) => `${idx}:${item.file}`}
          dataSource={meta.walkthrough}
          columns={[
            { title: '文件 / 章节', dataIndex: 'file', render: v => <Typography.Text code className="tf-break">{v}</Typography.Text> },
            { title: '变更说明', dataIndex: 'summary', render: v => <span className="tf-break">{v}</span> },
            { title: '风险', dataIndex: 'risk', width: 84, render: (v?: RiskLevel) => v ? <Tag color={RISK_COLORS[v]}>{riskLevelLabel(v)}</Tag> : '—' },
          ]}
        />
      ),
    });
  }
  if (meta.compliance && (meta.compliance.compliant.length || meta.compliance.missing.length || meta.compliance.manualCheck.length)) {
    sections.push({
      key: 'compliance',
      title: '需求核验',
      children: (
        <Flex vertical gap={8}>
          {!!meta.compliance.compliant.length && <div><Tag color="success">已满足</Tag><Typography.Text>{meta.compliance.compliant.join('；')}</Typography.Text></div>}
          {!!meta.compliance.missing.length && <div><Tag color="error">未满足</Tag><Typography.Text type="danger">{meta.compliance.missing.join('；')}</Typography.Text></div>}
          {!!meta.compliance.manualCheck.length && <div><Tag color="warning">需实机/人工核验</Tag><Typography.Text type="secondary">{meta.compliance.manualCheck.join('；')}</Typography.Text></div>}
        </Flex>
      ),
    });
  }
  if (!sections.length && !meta.coverageMetrics) return null;
  return (
    <Flex vertical gap={12} style={{ marginTop: 6, minWidth: 0 }}>
      {meta.coverageMetrics && (
        <Space size={6} wrap>
          {typeof meta.coverageMetrics.coveragePrd === 'number' && <Tag color="blue">PRD 覆盖率 {meta.coverageMetrics.coveragePrd}%</Tag>}
          {typeof meta.coverageMetrics.traceAc === 'number' && <Tag color="purple">AC 测试追溯 {meta.coverageMetrics.traceAc}%</Tag>}
        </Space>
      )}
      {sections.map(item => (
        <section key={item.key} aria-label={item.title} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <Typography.Text strong>{item.title}</Typography.Text>
          {item.children}
        </section>
      ))}
    </Flex>
  );
};

/** Extra structured fields an AI draft may carry beyond summary/findings. */
export const draftExtras = (draft: LocalAiRunDraft | null | undefined) => ({
  ...(draft?.verdict ? { verdict: draft.verdict } : {}),
  ...(typeof draft?.score === 'number' ? { score: draft.score } : {}),
  ...(draft?.checklist?.length ? { checklist: draft.checklist } : {}),
  ...(draft?.meta ? { meta: draft.meta } : {}),
});

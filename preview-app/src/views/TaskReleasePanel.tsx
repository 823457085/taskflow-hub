import React from 'react';
import { Alert, App as AntApp, Button, Card, Collapse, Flex, Grid, Space, Steps, Tag, Typography } from 'antd';
import { Copy, Download, FileCheck2 } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { Asset, AssetKind, Gates, memberName, ReviewJob, Stage, STAGES, User, WorkTask } from './workspaceApi';
import { assetKindLabel, gateStatusLabel, stageLabel } from './displayLabels';
import { buildReleaseDossierMarkdown, evaluateReleaseReadiness, type ReadinessCheckItem } from './releaseReadiness';

const ASSET_CODE_PATTERN = /\b(TECH_SPEC|TEST_CASE|RELEASE_PLAN|CODE|PRD)\b/g;
const readableReason = (reason = '') => reason.replace(ASSET_CODE_PATTERN, code => assetKindLabel(code));
const CHECK_ORDER: Record<ReadinessCheckItem['status'], number> = { fail: 0, warn: 1, pass: 2 };
const gateVariant = (status: string) => status === 'PASS' ? 'green' : ['BLOCKED', 'CHANGES_REQUESTED'].includes(status) ? 'block' : 'neutral';

export const TaskReleasePanel: React.FC<{
  task: WorkTask; assets: Asset[]; jobs: ReviewJob[]; gates: Gates | null; members: User[]; repoPath: string | null;
  frozen: boolean; allowedKinds: AssetKind[];
  onOpenReview: (jobId: string) => void;
  onFixAsset: (kind: AssetKind) => void;
  onFixStage: (stage: Stage) => void;
}> = ({ task, assets, jobs, gates, members, repoPath, frozen, allowedKinds, onOpenReview, onFixAsset, onFixStage }) => {
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const readiness = evaluateReleaseReadiness({ task, assets, jobs, gates });
  const dossier = () => buildReleaseDossierMarkdown({ task, assets, jobs, gates, members, repoPath });

  const copyDossier = () => {
    void navigator.clipboard.writeText(dossier())
      .then(() => message.success(`已复制 ${task.jiraKey} 变更发布就绪度与追溯档案 (Markdown)。`))
      .catch(() => message.warning('浏览器未能复制，请点击右侧下载档案。'));
  };
  const downloadDossier = () => {
    const url = URL.createObjectURL(new Blob([dossier()], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${task.jiraKey}-release-dossier.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    void message.success(`已下载 ${task.jiraKey}-release-dossier.md。`);
  };

  const sortedChecks = [...readiness.checks].sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
  const openChecks = sortedChecks.filter(chk => chk.status !== 'pass');
  const passedChecks = sortedChecks.filter(chk => chk.status === 'pass');
  const renderCheck = (chk: ReadinessCheckItem) => (
    <div key={chk.id} className="tf-readiness-check">
      <div style={{ minWidth: 0, flex: 1 }}>
        <Space size={6} wrap>
          <Tag color={chk.status === 'pass' ? 'success' : chk.status === 'warn' ? 'warning' : 'error'} style={{ marginInlineEnd: 0 }}>
            {chk.maxPoints ? `${chk.points}/${chk.maxPoints}` : chk.status === 'pass' ? '一致' : chk.status === 'fail' ? '不一致' : '待核验'}
          </Tag>
          <Typography.Text strong style={{ fontSize: 13 }}>{chk.label}</Typography.Text>
        </Space>
        <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{chk.detail}</Typography.Text></div>
        {!!chk.evidence?.length && (
          <details>
            <summary>{chk.id === 'traceability' ? '查看逐条验收覆盖' : '查看构建及审批提交'}</summary>
            <ul>{chk.evidence.map((item, idx) => <li key={idx} style={{ overflowWrap: 'anywhere' }}>{item}</li>)}</ul>
          </details>
        )}
      </div>
      {chk.status !== 'pass' && !frozen && (chk.targetAssetKind || chk.targetStage) && (
        <Flex flex="0 0 auto">
          <Button
            size="small"
            type="link"
            style={{ paddingInline: 2 }}
            onClick={() => {
              if (chk.targetAssetKind && allowedKinds.includes(chk.targetAssetKind)) onFixAsset(chk.targetAssetKind);
              else if (chk.targetStage) onFixStage(chk.targetStage);
            }}
          >
            去处理
          </Button>
        </Flex>
      )}
    </div>
  );

  return <div className="tf-detail-stack">
    <Card
      title={<Space size={12}><span>阶段门禁</span><StatusBadge variant={gates?.overall === 'PASS' ? 'green' : 'neutral'}>{gates ? gateStatusLabel(gates.overall) : '计算中'}</StatusBadge></Space>}
    >
      <Steps
        current={-1}
        orientation={screens.lg ? 'horizontal' : 'vertical'}
        titlePlacement={screens.lg ? 'vertical' : 'horizontal'}
        className="tf-gate-steps"
        items={(gates?.gates || []).map(gate => {
          const latest = readiness.traceabilityChain.find(node => node.stage === gate.stage);
          return {
            title: STAGES.find(item => item.value === gate.stage)?.label || stageLabel(gate.stage),
            status: gate.status === 'PASS' ? 'finish' : ['BLOCKED', 'CHANGES_REQUESTED'].includes(gate.status) ? 'error' : 'wait',
            content: <div className="tf-gate-description">
              <StatusBadge variant={gateVariant(gate.status)}>{gateStatusLabel(gate.status)}</StatusBadge>
              <Typography.Text type="secondary">{readableReason(gate.reason)}</Typography.Text>
              {latest?.latestAsset && <Typography.Text type="secondary" className="tf-gate-meta"><code>r{latest.latestAsset.revision} · {latest.latestAsset.sha256.slice(0, 8)}</code></Typography.Text>}
              {latest?.approverId && <Typography.Text type="secondary" className="tf-gate-meta">签字：{memberName(members, latest.approverId)}</Typography.Text>}
              {gate.jobId
                ? <Button type="link" size="small" onClick={() => onOpenReview(gate.jobId!)}>查看评审</Button>
                : gate.status !== 'PASS' && !frozen && <Button type="link" size="small" onClick={() => onFixStage(gate.stage)}>去处理</Button>}
            </div>,
          };
        })}
      />
      <Typography.Paragraph type="secondary" className="tf-gate-footnote">依据当前输入版本、报告与独立审批计算；进度百分比不会放行门禁。通过不触发外部发布。</Typography.Paragraph>
    </Card>

    <Card
      title={<Space size={8} wrap>
        <FileCheck2 size={16} />
        <span>发布就绪度</span>
        <StatusBadge variant={readiness.grade === 'READY' ? 'green' : readiness.grade === 'ALMOST' ? 'blue' : readiness.unwaivedCriticalCount > 0 || readiness.highRiskRequiresRollback ? 'warn' : 'neutral'}>
          {readiness.score} / 100
        </StatusBadge>
      </Space>}
      extra={<Space size={6} wrap>
        <Button size="small" icon={<Copy size={13} />} onClick={copyDossier}>复制发布档案</Button>
        <Button size="small" icon={<Download size={13} />} onClick={downloadDossier}>下载 .md</Button>
      </Space>}
    >
      <div className="tf-detail-stack tf-detail-stack-small">
        {readiness.highRiskRequiresRollback && (
          <Alert
            type="warning"
            showIcon
            title={`检测到高敏变更（${readiness.highRiskLabels.join('、')}），上线方案尚未包含明确回滚/兜底步骤`}
            action={!frozen && allowedKinds.includes('RELEASE_PLAN')
              ? <Button size="small" type="primary" onClick={() => onFixAsset('RELEASE_PLAN')}>补齐回滚方案</Button>
              : undefined}
          />
        )}
        {openChecks.length ? <div className="tf-readiness-checks">{openChecks.map(renderCheck)}</div> : <Typography.Text type="secondary">所有就绪度检查均已通过。</Typography.Text>}
        {passedChecks.length > 0 && <Collapse ghost size="small" items={[{ key: 'passed', label: `已通过的检查 (${passedChecks.length})`, children: <div className="tf-readiness-checks">{passedChecks.map(renderCheck)}</div> }]} />}
      </div>
    </Card>
  </div>;
};

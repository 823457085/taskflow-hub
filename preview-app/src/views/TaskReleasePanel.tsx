import React, { useMemo } from 'react';
import { App as AntApp, Button, Tag, Tooltip } from 'antd';
import { Copy, Download } from 'lucide-react';
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
  const readiness = useMemo(() => evaluateReleaseReadiness({ task, assets, jobs, gates }), [task, assets, jobs, gates]);
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

  return (
    <div className="tf-task-release">
      <div className="tf-task-release-layout">
        <section className="tf-record-section" aria-label="阶段门禁">
          <header className="tf-record-section-header">
            <h3>阶段门禁</h3>
            <StatusBadge variant={gates?.overall === 'PASS' ? 'green' : 'neutral'}>{gates ? gateStatusLabel(gates.overall) : '计算中'}</StatusBadge>
          </header>
          <ul className="tf-record-list">
            {(gates?.gates || []).map(gate => {
              const latest = readiness.traceabilityChain.find(node => node.stage === gate.stage);
              return (
                <li key={gate.stage} className="tf-record-row">
                  <div className="tf-record-row-heading">
                    <div className="tf-record-title">
                      <strong>{STAGES.find(item => item.value === gate.stage)?.label || stageLabel(gate.stage)}</strong>
                      <StatusBadge variant={gateVariant(gate.status)}>{gateStatusLabel(gate.status)}</StatusBadge>
                    </div>
                    {gate.jobId
                      ? <Button type="link" size="small" onClick={() => onOpenReview(gate.jobId!)}>查看评审</Button>
                      : gate.status !== 'PASS' && !frozen && <Button type="link" size="small" onClick={() => onFixStage(gate.stage)}>去处理</Button>}
                  </div>
                  <p className="tf-record-detail">{readableReason(gate.reason)}</p>
                  {(latest?.latestAsset || latest?.approverId) && (
                    <div className="tf-record-meta tf-record-ellipsis">
                      {latest?.latestAsset && <code>r{latest.latestAsset.revision} · {latest.latestAsset.sha256.slice(0, 8)}</code>}
                      {latest?.latestAsset && latest?.approverId && ' · '}
                      {latest?.approverId && <>签字 {memberName(members, latest.approverId)}</>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="tf-record-section" aria-label="发布就绪度">
          <header className="tf-record-section-header">
            <div className="tf-record-title">
              <h3>发布就绪度</h3>
              <StatusBadge variant={readiness.grade === 'READY' ? 'green' : readiness.grade === 'ALMOST' ? 'blue' : readiness.unwaivedCriticalCount > 0 || readiness.highRiskRequiresRollback ? 'warn' : 'neutral'}>
                {readiness.score}/100
              </StatusBadge>
            </div>
            <div className="tf-record-actions">
              <Tooltip title="复制发布档案">
                <Button size="small" aria-label="复制发布档案" icon={<Copy size={14} />} onClick={copyDossier} />
              </Tooltip>
              <Tooltip title="下载发布档案 Markdown">
                <Button size="small" aria-label="下载发布档案 Markdown" icon={<Download size={14} />} onClick={downloadDossier} />
              </Tooltip>
            </div>
          </header>
          <ul className="tf-record-list">
            {sortedChecks.map(check => (
              <li key={check.id} className="tf-record-row">
                <div className="tf-record-row-heading">
                  <div className="tf-record-title">
                    <Tag color={check.status === 'pass' ? 'success' : check.status === 'warn' ? 'warning' : 'error'}>
                      {check.status === 'pass' ? '已通过' : check.status === 'fail' ? '未通过' : '待核验'}
                    </Tag>
                    <strong className="tf-record-ellipsis" title={check.label}>{check.label}</strong>
                  </div>
                  {check.status !== 'pass' && !frozen && (
                    (check.targetAssetKind && allowedKinds.includes(check.targetAssetKind)) || check.targetStage
                  ) && (
                    <Button type="link" size="small" onClick={() => {
                      if (check.targetAssetKind && allowedKinds.includes(check.targetAssetKind)) onFixAsset(check.targetAssetKind);
                      else if (check.targetStage) onFixStage(check.targetStage);
                    }}>去处理</Button>
                  )}
                </div>
                <p className="tf-record-detail">{check.detail}</p>
                {!!check.evidence?.length && (
                  <ul className="tf-record-evidence" tabIndex={0} aria-label={check.id === 'traceability' ? '验收覆盖明细' : '构建与审批提交'}>
                    {check.evidence.map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};

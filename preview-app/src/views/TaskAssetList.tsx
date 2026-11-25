import React, { useState } from 'react';
import { Alert, App as AntApp, Button, Flex, Grid, Select, Tag, Tooltip, Typography } from 'antd';
import { Copy, ExternalLink, Pencil, ShieldAlert } from 'lucide-react';
import { api, Asset, AssetKind, Finding, memberName, timeText, User } from './workspaceApi';
import { Empty } from './WorkspaceFields';
import { assetMetaCodeLabel } from './displayLabels';
import {
  analyzeAssetRiskSignals,
  buildSideBySideUnifiedDiff,
  computeRevisionLineDiff,
  pairRevisionDiffSideBySide,
  parseUnifiedDiffStats,
  splitUnifiedDiffLines,
  type SideBySideDiffRow,
} from './assetDiff';
import { isLikelyMarkdown, parseMarkdownBlocks, summarizeMarkdownChecklists } from './markdownLite';
import { MarkdownPreview } from './MarkdownPreview';
import './TaskRecords.css';

type AssetViewerMode = 'pretty' | 'split' | 'md' | 'rev-diff' | 'rev-split' | 'raw';

const SideBySideDiff: React.FC<{ rows: SideBySideDiffRow[]; ariaLabel: string; header?: React.ReactNode }> = ({ rows, ariaLabel, header }) => (
  <div className="tf-diff-viewer" aria-label={ariaLabel}>
    {header && <div className="tf-diff-line tf-diff-file"><span className="tf-diff-code">{header}</span></div>}
    {rows.map((row, idx) => {
      if (row.kind === 'skip') return <div key={idx} className="tf-diff-skip">{row.text}</div>;
      if (row.kind !== 'pair') {
        return <div key={idx} className={`tf-diff-line ${row.kind === 'hunk' ? 'tf-diff-hunk' : row.kind === 'file' ? 'tf-diff-file' : 'tf-diff-meta'}`}>
          <span className="tf-diff-code">{row.text || ' '}</span>
        </div>;
      }
      const leftCls = row.leftType === 'del' ? 'tf-diff-del' : row.leftType === 'empty' ? 'tf-diff-empty' : '';
      const rightCls = row.rightType === 'add' ? 'tf-diff-add' : row.rightType === 'empty' ? 'tf-diff-empty' : '';
      return (
        <div key={idx} className="tf-diff-split-row">
          <div className={`tf-diff-split-cell ${leftCls}`}>
            <span className="tf-diff-split-gutter">{row.leftLine ?? ''}</span>
            <span className="tf-diff-code">{row.leftType === 'del' ? '- ' : row.leftType === 'context' ? '  ' : ''}{row.leftText ?? ''}</span>
          </div>
          <div className={`tf-diff-split-cell ${rightCls}`}>
            <span className="tf-diff-split-gutter">{row.rightLine ?? ''}</span>
            <span className="tf-diff-code">{row.rightType === 'add' ? '+ ' : row.rightType === 'context' ? '  ' : ''}{row.rightText ?? ''}</span>
          </div>
        </div>
      );
    })}
  </div>
);

const AssetBody: React.FC<{ asset: Asset; prevAsset?: Asset; mode: AssetViewerMode; isMd: boolean; hasHunks: boolean }> = ({ asset, prevAsset, mode, isMd, hasHunks }) => {
  const revDiff = (mode === 'rev-diff' || mode === 'rev-split') && prevAsset ? computeRevisionLineDiff(prevAsset.content, asset.content) : null;
  if (revDiff && prevAsset) {
    const stats = <>（<span className="tf-diff-stat-add">+{revDiff.additions}</span> / <span className="tf-diff-stat-del">-{revDiff.deletions}</span> 行）</>;
    if (revDiff.identical) return <Alert type="info" showIcon title={`当前 r${asset.revision} 与上一版 r${prevAsset.revision} 正文内容完全一致。`} />;
    if (mode === 'rev-split') {
      return <SideBySideDiff rows={pairRevisionDiffSideBySide(revDiff.rows)} ariaLabel={`双栏版本对比 r${prevAsset.revision} 至 r${asset.revision}`}
        header={<>双栏版本对比：r{prevAsset.revision}（左） → r{asset.revision}（右）{stats}</>} />;
    }
    return (
      <div className="tf-diff-viewer" aria-label={`版本对比 r${prevAsset.revision} 至 r${asset.revision}`}>
        <div className="tf-diff-line tf-diff-file"><span className="tf-diff-code">版本变更对比：r{prevAsset.revision} → r{asset.revision}{stats}</span></div>
        {revDiff.rows.map((row, idx) => row.type === 'skip' ? (
          <div key={idx} className="tf-diff-skip">⋯ 省略 {row.count} 行未变更上下文 ⋯</div>
        ) : (
          <div key={idx} className={`tf-diff-line ${row.type === 'add' ? 'tf-diff-add' : row.type === 'del' ? 'tf-diff-del' : ''}`}>
            <span className="tf-diff-gutter">{row.oldLine ?? ''}{row.oldLine && row.newLine ? ':' : ''}{row.newLine ?? ''}</span>
            <span className="tf-diff-code">{row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}{row.text}</span>
          </div>
        ))}
      </div>
    );
  }
  if (mode === 'split' && hasHunks) return <SideBySideDiff rows={buildSideBySideUnifiedDiff(asset.content)} ariaLabel="代码双栏 Diff 视图" />;
  if (mode === 'pretty' && hasHunks) {
    return (
      <div className="tf-diff-viewer" aria-label="代码统一 Diff 视图">
        {splitUnifiedDiffLines(asset.content).map((line, idx) => (
          <div key={idx} className={`tf-diff-line ${line.kind === 'add' ? 'tf-diff-add' : line.kind === 'del' ? 'tf-diff-del' : line.kind === 'hunk' ? 'tf-diff-hunk' : line.kind === 'file' ? 'tf-diff-file' : line.kind === 'meta' ? 'tf-diff-meta' : ''}`}>
            <span className="tf-diff-code">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    );
  }
  if (mode === 'md' && isMd) return <MarkdownPreview content={asset.content} blocks={parseMarkdownBlocks(asset.content)} />;
  return <pre className="tf-code-panel">{asset.content}</pre>;
};

export const TaskAssetList: React.FC<{
  assets: Asset[]; members: User[]; allowedKinds: AssetKind[]; frozen: boolean; busy: boolean;
  onUpdateFromBasis: (asset: Asset) => void;
}> = ({ assets, members, allowedKinds, frozen, busy, onUpdateFromBasis }) => {
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const [viewModes, setViewModes] = useState<Record<string, AssetViewerMode>>({});
  const [selectionId, setSelectionId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [scanningId, setScanningId] = useState('');
  const [scanResults, setScanResults] = useState<Record<string, { kind: string; findings: { severity: Finding['severity']; title: string; detail: string; location?: string }[] }>>({});

  const analyzeAsset = async (asset: Asset) => {
    if (scanningId) return;
    setScanningId(asset.id);
    try {
      const res = await api<{ kind: string; findings: { severity: Finding['severity']; title: string; detail: string; location?: string }[] }>(
        `tasks/${encodeURIComponent(asset.taskId)}/assets/${encodeURIComponent(asset.id)}/analyze-contract`,
        {},
      );
      setScanResults(prev => ({ ...prev, [asset.id]: { kind: res.kind, findings: res.findings || [] } }));
      void message.success(res.findings?.length ? `扫描完成，发现 ${res.findings.length} 项契约/安全提示。` : '扫描完成，未发现契约或规则异常。');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '静态扫描失败。');
    } finally {
      setScanningId('');
    }
  };

  if (!assets.length) {
    return <Empty>暂无材料。</Empty>;
  }

  const copy = (text: string, success: string) => {
    void navigator.clipboard.writeText(text).then(() => message.success(success)).catch(() => message.warning('浏览器未能复制，请手动选择复制。'));
  };

  const sameMaterial = (left: Asset, right: Asset) => left.kind === right.kind && left.logicalKey === right.logicalKey;
  const latest = assets.filter(asset => !assets.some(other => sameMaterial(other, asset) && other.revision > asset.revision))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const selection = assets.find(asset => asset.id === selectionId);
  const current = (selection && latest.find(asset => sameMaterial(asset, selection))) || latest[0];
  const versions = assets.filter(asset => sameMaterial(asset, current)).sort((left, right) => right.revision - left.revision);
  const asset = versions.find(item => item.id === versionId) || current;
  const diffStats = parseUnifiedDiffStats(asset.content);
  const isMd = !diffStats.hasHunks && isLikelyMarkdown(asset.content, asset.kind);
  const checklistStats = isMd ? summarizeMarkdownChecklists(parseMarkdownBlocks(asset.content)) : { checked: 0, total: 0 };
  const risk = ['CODE', 'TECH_SPEC', 'RELEASE_PLAN'].includes(asset.kind) ? analyzeAssetRiskSignals(asset.content) : { tier: 'NONE' as const, signals: [] };
  const prevAsset = versions.find(candidate => candidate.revision < asset.revision);
  const rawMode = viewModes[asset.id] || (diffStats.hasHunks ? 'pretty' : isMd ? 'md' : 'raw');
  const mode: AssetViewerMode = !screens.md && rawMode === 'split' ? 'pretty' : !screens.md && rawMode === 'rev-split' ? 'rev-diff' : rawMode;

  const modeOptions: { value: AssetViewerMode; label: string }[] = [];
  if (diffStats.hasHunks) {
    modeOptions.push({ value: 'pretty', label: '统一对比' });
    if (screens.md) modeOptions.push({ value: 'split', label: '双栏对比' });
  } else if (isMd) {
    modeOptions.push({ value: 'md', label: '排版预览' });
  }
  if (prevAsset) {
    modeOptions.push({ value: 'rev-diff', label: `对比 r${prevAsset.revision}` });
    if (screens.md) modeOptions.push({ value: 'rev-split', label: `双栏 r${prevAsset.revision}` });
  }
  if (modeOptions.length) modeOptions.push({ value: 'raw', label: '原始文本' });

  const scan = scanResults[asset.id];
  const scanLabel = asset.kind === 'CODE' ? '安全规则扫描' : '接口契约校验';
  const assetLabel = assetMetaCodeLabel(asset.kind, asset.logicalKey, asset.revision);
  const authorLabel = `${memberName(members, asset.actorId)} · ${timeText(asset.createdAt)}`;

  return (
    <div className="tf-task-materials">
      <div className="tf-task-materials-layout">
        <nav className="tf-material-list" aria-label="材料列表">
          {latest.map(item => (
            <button
              key={item.id}
              type="button"
              className="tf-material-option"
              aria-current={item.id === current.id || undefined}
              title={item.title}
              onClick={() => { setSelectionId(item.id); setVersionId(''); }}
            >
              <strong className="tf-record-ellipsis">{item.title}</strong>
              <small className="tf-record-ellipsis">{assetMetaCodeLabel(item.kind, item.logicalKey, item.revision)}</small>
            </button>
          ))}
        </nav>

        <article className="tf-material-content">
          <header className="tf-material-header">
            <div className="tf-material-title">
              <h3 className="tf-record-ellipsis" title={asset.title}>{asset.title}</h3>
              <div className="tf-record-meta tf-record-ellipsis" title={`${assetLabel} · ${authorLabel}`}>
                {assetLabel} · {authorLabel}
              </div>
            </div>
            <div className="tf-record-actions" aria-label="材料操作" role="group">
              {versions.length > 1 && (
                <Select
                  size="small"
                  aria-label="材料版本"
                  value={asset.id}
                  onChange={setVersionId}
                  options={versions.map(item => ({ value: item.id, label: `r${item.revision}${item.id === current.id ? '（最新）' : ''}` }))}
                />
              )}
              {modeOptions.length > 1 && (
                <Select<AssetViewerMode>
                  aria-label="材料查看方式"
                  size="small"
                  value={mode}
                  options={modeOptions}
                  onChange={value => setViewModes(prev => ({ ...prev, [asset.id]: value }))}
                />
              )}
              <Tooltip title="复制材料内容">
                <Button size="small" icon={<Copy size={14} />} aria-label="复制材料内容" onClick={() => copy(asset.content, '材料内容已复制到剪贴板。')} />
              </Tooltip>
              {asset.sourceUrl && (
                <Tooltip title="打开材料来源">
                  <Button size="small" icon={<ExternalLink size={14} />} aria-label="打开材料来源" href={asset.sourceUrl} target="_blank" rel="noreferrer" />
                </Tooltip>
              )}
              {['TECH_SPEC', 'CODE'].includes(asset.kind) && (
                <Tooltip title={scanLabel}>
                  <Button size="small" icon={<ShieldAlert size={14} />} aria-label={scanLabel} loading={scanningId === asset.id} disabled={busy} onClick={() => void analyzeAsset(asset)} />
                </Tooltip>
              )}
              {!frozen && allowedKinds.includes(asset.kind) && (
                <Tooltip title="基于此版更新">
                  <Button size="small" icon={<Pencil size={14} />} aria-label="基于此版更新" disabled={busy} onClick={() => onUpdateFromBasis(asset)} />
                </Tooltip>
              )}
            </div>
          </header>

          <div className="tf-material-evidence">
            {checklistStats.total > 0 && <span>核查项 {checklistStats.checked}/{checklistStats.total}</span>}
            {risk.signals.map(sig => (
              <Tag key={sig.code} color={sig.level === 'HIGH' ? 'error' : sig.level === 'MEDIUM' ? 'warning' : 'default'}>{sig.label}</Tag>
            ))}
            {diffStats.files.length > 0 && (
              <span className="tf-record-ellipsis" title={diffStats.files.join(' · ')}>
                {diffStats.files.length} 个文件 · {diffStats.files[0]}
              </span>
            )}
            <Tooltip title={`复制完整指纹 ${asset.sha256}`}>
              <Button type="text" size="small" className="tf-material-fingerprint" onClick={() => copy(asset.sha256, 'SHA256 指纹已复制。')}>
                SHA256 {asset.sha256.slice(0, 12)}
              </Button>
            </Tooltip>
          </div>

          {scan && (
            <Alert
              type={scan.findings.some(item => item.severity === 'CRITICAL') ? 'error' : scan.findings.length ? 'warning' : 'success'}
              showIcon
              title={`${scan.kind === 'API_SPEC' ? '接口契约预检' : '确定性规则扫描'} · ${scan.findings.length ? `发现 ${scan.findings.length} 项` : '全部通过'}`}
              description={scan.findings.length ? (
                <div className="tf-material-scan" tabIndex={0} aria-label="扫描结果">
                  {scan.findings.map((item, index) => (
                    <div key={index}>
                      <Tag color={item.severity === 'CRITICAL' ? 'error' : item.severity === 'WARN' ? 'warning' : 'default'}>{item.severity}</Tag>
                      <strong>{item.title}</strong>{item.location ? ` (${item.location})` : ''} — {item.detail}
                    </div>
                  ))}
                </div>
              ) : undefined}
            />
          )}

          <div key={`${asset.id}:${mode}`} className="tf-material-preview" tabIndex={0} role="region" aria-label="材料正文">
            <AssetBody asset={asset} prevAsset={prevAsset} mode={mode} isMd={isMd} hasHunks={diffStats.hasHunks} />
          </div>
        </article>
      </div>
    </div>
  );
};

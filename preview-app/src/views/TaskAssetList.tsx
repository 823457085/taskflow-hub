import React, { useState } from 'react';
import { Alert, App as AntApp, Button, Collapse, Flex, Grid, Segmented, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { Copy, Pencil } from 'lucide-react';
import { Asset, AssetKind, memberName, timeText, User } from './workspaceApi';
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
  const [showHistory, setShowHistory] = useState(false);

  if (!assets.length) {
    return <Empty>{allowedKinds.length && !frozen ? '尚无材料，可使用上方「粘贴链接导入」「提取本地 Git 代码」或「添加材料」快速补齐。' : '尚无材料。'}</Empty>;
  }

  const copy = (text: string, success: string) => {
    void navigator.clipboard.writeText(text).then(() => message.success(success)).catch(() => message.warning('浏览器未能复制，请手动选择复制。'));
  };

  const isLatest = (asset: Asset) => !assets.some(other => other.kind === asset.kind && other.logicalKey === asset.logicalKey && other.revision > asset.revision);
  const historyCount = assets.filter(asset => !isLatest(asset)).length;
  const visible = [...assets]
    .filter(asset => showHistory || isLatest(asset))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return <Flex vertical gap={10}>
    {historyCount > 0 && <Flex justify="space-between" align="center" gap={8} wrap>
      <Typography.Text type="secondary" className="tf-table-hint">{showHistory ? `共 ${assets.length} 个版本` : `显示每份材料的最新版本，另有 ${historyCount} 个历史版本`}</Typography.Text>
      <Space size={6}><Switch size="small" checked={showHistory} onChange={setShowHistory} aria-label="显示历史版本" /><Typography.Text type="secondary">显示历史版本</Typography.Text></Space>
    </Flex>}
    <Collapse items={visible.map(asset => {
    const diffStats = parseUnifiedDiffStats(asset.content);
    const isMd = !diffStats.hasHunks && isLikelyMarkdown(asset.content, asset.kind);
    const checklistStats = isMd ? summarizeMarkdownChecklists(parseMarkdownBlocks(asset.content)) : { checked: 0, total: 0 };
    const risk = ['CODE', 'TECH_SPEC', 'RELEASE_PLAN'].includes(asset.kind) ? analyzeAssetRiskSignals(asset.content) : { tier: 'NONE' as const, signals: [] };
    const prevAsset = assets
      .filter(candidate => candidate.kind === asset.kind && candidate.logicalKey === asset.logicalKey && candidate.revision < asset.revision)
      .sort((a, b) => b.revision - a.revision)[0];
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

    return {
      key: asset.id,
      label: <div className="tf-table-title">
        <Space size={8} wrap>
          <Typography.Text type="secondary"><code>{assetMetaCodeLabel(asset.kind, asset.logicalKey, asset.revision)}</code></Typography.Text>
          {diffStats.hasHunks && (
            <Space size={6}>
              <span className="tf-diff-stat-add">+{diffStats.additions}</span>
              <span className="tf-diff-stat-del">-{diffStats.deletions}</span>
              {diffStats.files.length > 0 && <Tag style={{ marginInlineEnd: 0 }}>{diffStats.files.length} 个文件</Tag>}
            </Space>
          )}
          {checklistStats.total > 0 && (
            <Tag color={checklistStats.checked === checklistStats.total ? 'success' : 'processing'} style={{ marginInlineEnd: 0 }}>
              核查项 {checklistStats.checked}/{checklistStats.total}
            </Tag>
          )}
          {!isLatest(asset) && <Tag style={{ marginInlineEnd: 0 }}>历史版本</Tag>}
          {prevAsset && <Tag color="blue" style={{ marginInlineEnd: 0 }}>可对比 r{prevAsset.revision}</Tag>}
          {risk.signals.map(sig => (
            <Tag key={sig.code} color={sig.level === 'HIGH' ? 'error' : sig.level === 'MEDIUM' ? 'warning' : 'default'} style={{ marginInlineEnd: 0 }}>{sig.label}</Tag>
          ))}
        </Space>
        <Typography.Text strong className="tf-break">{asset.title}</Typography.Text>
      </div>,
      children: <div className="tf-detail-stack tf-detail-stack-small">
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Typography.Text type="secondary">{memberName(members, asset.actorId)} · {timeText(asset.createdAt)}</Typography.Text>
          <Space size={6} wrap>
            {modeOptions.length > 1 && (
              <Segmented<AssetViewerMode>
                size="small"
                aria-label={`切换 ${asset.title} 视图模式`}
                value={mode}
                options={modeOptions}
                onChange={val => setViewModes(prev => ({ ...prev, [asset.id]: val }))}
              />
            )}
            <Button size="small" icon={<Copy size={13} />} onClick={() => copy(asset.content, '材料内容已复制到剪贴板。')}>复制内容</Button>
            {!frozen && allowedKinds.includes(asset.kind) && (
              <Button size="small" icon={<Pencil size={13} />} disabled={busy} onClick={() => onUpdateFromBasis(asset)}>基于此版更新</Button>
            )}
          </Space>
        </Flex>
        <Space size={6} wrap>
          <Tooltip title={`点击复制完整指纹：${asset.sha256}`}>
            <Typography.Text type="secondary" code style={{ cursor: 'pointer' }} onClick={() => copy(asset.sha256, 'SHA256 指纹已复制。')}>
              SHA256 {asset.sha256.slice(0, 12)}
            </Typography.Text>
          </Tooltip>
          {diffStats.files.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              涉及文件：{diffStats.files.slice(0, 5).join(' · ')}{diffStats.files.length > 5 ? ` 等 ${diffStats.files.length} 个` : ''}
            </Typography.Text>
          )}
        </Space>
        {asset.sourceUrl && <Typography.Link href={asset.sourceUrl} target="_blank" rel="noreferrer" className="tf-break">{asset.sourceUrl}</Typography.Link>}
        <AssetBody asset={asset} prevAsset={prevAsset} mode={mode} isMd={isMd} hasHunks={diffStats.hasHunks} />
      </div>,
    };
  })} />
  </Flex>;
};

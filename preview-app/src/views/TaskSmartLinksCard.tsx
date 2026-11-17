import React from 'react';
import { Button, Card, Flex, Space, Tag, Typography } from 'antd';
import { ExternalLink, FolderOpen, Sparkles } from 'lucide-react';
import type { AssetKind, WorkTask } from './workspaceApi';
import { assetKindLabel } from './displayLabels';
import type { extractTaskSmartHints } from './taskSmartLinks';

type SmartHints = ReturnType<typeof extractTaskSmartHints>;
type ImportProvider = 'confluence' | 'gitlab' | 'jenkins' | 'jira' | 'yunxiao';

export const TaskSmartLinksCard: React.FC<{
  hints: SmartHints; tasks: WorkTask[]; allowedKinds: AssetKind[]; busy: boolean;
  showRepos: boolean; showSelfPrd: boolean; hasAssetKind: (kind: AssetKind) => boolean;
  onBindRepo: (path: string) => void;
  onOpenRepo: (app: 'finder' | 'cursor', path: string) => void;
  onImport: (params: { provider: ImportProvider; url?: string; issueKey?: string; kind: AssetKind }) => void;
  onSaveSelfPrd: () => void;
  onOpenTask: (id: string) => void;
}> = ({ hints, tasks, allowedKinds, busy, showRepos, showSelfPrd, hasAssetKind, onBindRepo, onOpenRepo, onImport, onSaveSelfPrd, onOpenTask }) => (
  <Card size="small" className="tf-smart-hints-card" title={<Space size={8}><Sparkles size={16} /><span>智能识别的关联来源（一键导入为材料）</span></Space>}>
    <div className="tf-detail-stack tf-detail-stack-small">
      {showRepos && hints.matchedRepos.map(repo => (
        <Flex key={repo.path} justify="space-between" align="center" gap={8} wrap className="tf-smart-hint-row">
          <Space size={8} wrap>
            <Tag color="geekblue">本机 Git 仓库</Tag>
            <Typography.Text strong>{repo.name}</Typography.Text>
            <Typography.Text type="secondary" code>{repo.path}</Typography.Text>
          </Space>
          <Space size={6} wrap>
            <Button size="small" type="primary" disabled={busy} onClick={() => onBindRepo(repo.path)}>一键绑定仓库</Button>
            <Button size="small" icon={<FolderOpen size={13} />} onClick={() => onOpenRepo('finder', repo.path)}>Finder 打开</Button>
            <Button size="small" onClick={() => onOpenRepo('cursor', repo.path)}>在 Cursor 打开</Button>
          </Space>
        </Flex>
      ))}

      {hints.detectedLinks.map(link => (
        <Flex key={link.url} justify="space-between" align="center" gap={8} wrap className="tf-smart-hint-row">
          <Space size={8} wrap>
            <Tag color={link.provider === 'confluence' ? 'blue' : link.provider === 'gitlab' || link.provider === 'yunxiao' ? 'purple' : link.provider === 'jenkins' ? 'cyan' : 'default'}>
              {link.provider.toUpperCase()}
            </Tag>
            <Typography.Link href={link.url} target="_blank" rel="noreferrer" className="tf-break">{link.label}</Typography.Link>
          </Space>
          <Space size={6} wrap>
            {link.provider !== 'external' && link.suggestedKinds.filter(k => allowedKinds.includes(k)).map(k => (
              <Button
                key={k}
                size="small"
                type={(k === 'PRD' || k === 'CODE') && !hasAssetKind(k) ? 'primary' : 'default'}
                disabled={busy}
                onClick={() => onImport({ provider: link.provider as ImportProvider, url: link.url, issueKey: link.issueKey, kind: k })}
              >
                导入为{assetKindLabel(k)}
              </Button>
            ))}
            <Button size="small" type="text" icon={<ExternalLink size={13} />} href={link.url} target="_blank" rel="noopener noreferrer">原链接</Button>
          </Space>
        </Flex>
      ))}

      {hints.relatedJira.map(rel => {
        const localTask = tasks.find(t => t.jiraKey === rel.key);
        return (
          <Flex key={rel.key} justify="space-between" align="center" gap={8} wrap className="tf-smart-hint-row">
            <Space size={8} wrap>
              <Tag color="processing">{rel.relation === 'parent' ? 'Jira 父事项' : '关联 Jira'}</Tag>
              {rel.url ? <Typography.Link href={rel.url} target="_blank" rel="noreferrer">{rel.key}</Typography.Link> : <Typography.Text strong>{rel.key}</Typography.Text>}
            </Space>
            <Space size={6} wrap>
              {rel.sameProject && allowedKinds.includes('PRD') && (
                <Button size="small" disabled={busy} onClick={() => onImport({ provider: 'jira', issueKey: rel.key, kind: 'PRD' })}>拉取为需求文档</Button>
              )}
              {rel.sameProject && allowedKinds.includes('TECH_SPEC') && (
                <Button size="small" disabled={busy} onClick={() => onImport({ provider: 'jira', issueKey: rel.key, kind: 'TECH_SPEC' })}>拉取为技术方案</Button>
              )}
              {localTask && <Button size="small" type="link" onClick={() => onOpenTask(localTask.id)}>打开本地任务</Button>}
            </Space>
          </Flex>
        );
      })}

      {showSelfPrd && (
        <Flex justify="space-between" align="center" gap={8} wrap className="tf-smart-hint-row">
          <Space size={8} wrap>
            <Tag>本任务描述</Tag>
            <Typography.Text type="secondary">需求直接写在本任务 Jira 正文中时，可固化为首版需求文档</Typography.Text>
          </Space>
          <Button size="small" disabled={busy} onClick={onSaveSelfPrd}>存为需求文档</Button>
        </Flex>
      )}
    </div>
  </Card>
);

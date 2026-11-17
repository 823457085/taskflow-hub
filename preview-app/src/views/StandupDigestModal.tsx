import React, { useMemo, useState } from 'react';
import { App, Button, Flex, Modal, Segmented, Select, Space, Tag, Typography } from 'antd';
import { Check, Copy, Download, FileSpreadsheet } from 'lucide-react';
import type { OverviewStageStat, OverviewSummaryJob, Project, ProjectWorkspace, Stage, User, WorkTask } from './workspaceApi';
import { buildPersonalStandupDigest, buildProjectSprintDigest } from './standupDigest';
import { MarkdownPreview } from './MarkdownPreview';

export type DigestMode = 'personal' | 'sprint';

export const StandupDigestModal: React.FC<{
  open: boolean;
  onClose: () => void;
  user: User;
  projects: Project[];
  tasks: WorkTask[];
  pendingJobs: OverviewSummaryJob[];
  workspaces: ProjectWorkspace[];
  openBlockersCount?: number;
  stageBreakdown?: Partial<Record<Stage, OverviewStageStat>>;
  reviewCount?: number;
  assetCount?: number;
}> = ({
  open,
  onClose,
  user,
  projects,
  tasks,
  pendingJobs,
  workspaces,
  openBlockersCount = 0,
  stageBreakdown,
  reviewCount,
  assetCount,
}) => {
  const { message } = App.useApp();
  const [mode, setMode] = useState<DigestMode>('personal');
  const [projectScope, setProjectScope] = useState<string>('');
  const [viewTab, setViewTab] = useState<'preview' | 'raw'>('preview');
  const [copied, setCopied] = useState(false);

  const effectiveScope = projects.some(p => p.id === projectScope) ? projectScope : '';
  const scopedProjects = useMemo(
    () => (effectiveScope ? projects.filter(p => p.id === effectiveScope) : projects),
    [effectiveScope, projects],
  );
  const isAllProjects = !effectiveScope || projects.length <= 1;

  const markdown = useMemo(() => {
    if (mode === 'personal') {
      return buildPersonalStandupDigest({
        user,
        projects: scopedProjects,
        tasks,
        pendingJobs,
        workspaces,
        openBlockersCount: isAllProjects ? openBlockersCount : 0,
      });
    }
    return buildProjectSprintDigest({
      projects: scopedProjects,
      tasks,
      stageBreakdown: isAllProjects ? (stageBreakdown || {}) : undefined,
      openBlockersCount: isAllProjects ? openBlockersCount : undefined,
      reviewCount: isAllProjects ? reviewCount : undefined,
      assetCount: isAllProjects ? assetCount : undefined,
    });
  }, [
    assetCount,
    isAllProjects,
    mode,
    openBlockersCount,
    pendingJobs,
    reviewCount,
    scopedProjects,
    stageBreakdown,
    tasks,
    user,
    workspaces,
  ]);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      void message.success('简报 Markdown 已复制，可直接粘贴至群聊、周报或 Confluence。');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      void message.warning('自动复制受限，请切换到源码视图手动全选复制。');
    }
  };

  const downloadMarkdown = () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = effectiveScope
      ? (projects.find(p => p.id === effectiveScope)?.key || 'project').toLowerCase()
      : 'all';
    const filename = `taskflow-${mode === 'personal' ? 'standup' : 'sprint'}-${slug}-${dateStr}.md`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    void message.success(`已导出 ${filename}`);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={780}
      title={
        <Space size={8} wrap>
          <FileSpreadsheet size={17} />
          <span>自动研发晨会与迭代交付简报</span>
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>零幻觉实况聚合</Tag>
        </Space>
      }
      footer={
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            所有条目均实时取自本地任务进展、五阶段门禁与阻断审计记录，不含大模型主观猜测。
          </Typography.Text>
          <Space size={8}>
            <Button onClick={onClose}>关闭</Button>
            <Button icon={<Download size={14} />} onClick={downloadMarkdown}>
              下载 .md
            </Button>
            <Button
              type="primary"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => void copyMarkdown()}
            >
              {copied ? '已复制' : '一键复制 Markdown'}
            </Button>
          </Space>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Flex justify="space-between" align="center" gap={10} wrap>
          <Space size={8} wrap>
            <Segmented<DigestMode>
              aria-label="选择简报类型"
              value={mode}
              onChange={val => {
                setMode(val);
                setCopied(false);
              }}
              options={[
                { value: 'personal', label: '个人晨会日报' },
                { value: 'sprint', label: '项目迭代简报' },
              ]}
            />
            {projects.length > 1 && (
              <Select
                aria-label="简报项目范围"
                style={{ minWidth: 210 }}
                value={effectiveScope}
                onChange={val => {
                  setProjectScope(val);
                  setCopied(false);
                }}
                options={[
                  { value: '', label: `全部可见项目 (${projects.length})` },
                  ...projects.map(p => ({ value: p.id, label: `${p.key} · ${p.name}` })),
                ]}
              />
            )}
          </Space>
          <Segmented<'preview' | 'raw'>
            size="small"
            aria-label="切换简报渲染模式"
            value={viewTab}
            onChange={setViewTab}
            options={[
              { value: 'preview', label: '排版预览' },
              { value: 'raw', label: 'Markdown 源码' },
            ]}
          />
        </Flex>

        <div
          style={{
            maxHeight: '58vh',
            overflowY: 'auto',
            padding: '14px 16px',
            borderRadius: 10,
            border: '1px solid var(--tf-border)',
            background: 'var(--tf-raised)',
          }}
        >
          {viewTab === 'preview' ? (
            <MarkdownPreview content={markdown} />
          ) : (
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              {markdown}
            </pre>
          )}
        </div>
      </Flex>
    </Modal>
  );
};

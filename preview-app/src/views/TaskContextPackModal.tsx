import React, { useMemo, useState } from 'react';
import { App, Button, Checkbox, Flex, Modal, Segmented, Space, Tag, Typography } from 'antd';
import { Check, Copy, Download, Package } from 'lucide-react';
import type { Asset, Gates, ProgressEvent, ReviewJob, WorkTask } from './workspaceApi';
import { buildTaskContextPack, type ContextPackFormat } from './taskContextPack';
import { readStoredChoice, writeStoredString } from './uiPreferences';

const FORMAT_PREF_KEY = 'taskflow.contextPack.format';
const PACK_FORMATS = ['markdown', 'xml'] as const;

export const TaskContextPackModal: React.FC<{
  open: boolean;
  onClose: () => void;
  task: WorkTask;
  assets: Asset[];
  jobs: ReviewJob[];
  gates: Gates | null;
  progressEvents: ProgressEvent[];
  repoPath: string | null;
  constitutionFiles?: string[];
}> = ({
  open,
  onClose,
  task,
  assets,
  jobs,
  gates,
  progressEvents,
  repoPath,
  constitutionFiles,
}) => {
  const { message } = App.useApp();
  const [format, setFormat] = useState<ContextPackFormat>(() =>
    readStoredChoice(FORMAT_PREF_KEY, PACK_FORMATS, 'markdown'),
  );
  const [latestAssetsOnly, setLatestAssetsOnly] = useState(true);
  const [includeReviews, setIncludeReviews] = useState(true);
  const [includeProgress, setIncludeProgress] = useState(true);
  const [copied, setCopied] = useState(false);

  const pack = useMemo(
    () =>
      buildTaskContextPack({
        task,
        assets,
        jobs,
        gates,
        progressEvents,
        repoPath,
        constitutionFiles,
        format,
        latestAssetsOnly,
        includeReviews,
        includeProgress,
      }),
    [task, assets, jobs, gates, progressEvents, repoPath, constitutionFiles, format, latestAssetsOnly, includeReviews, includeProgress],
  );

  const copyPack = async () => {
    try {
      await navigator.clipboard.writeText(pack.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      void message.success(`已复制 AI 上下文包（约 ${pack.estimatedTokens.toLocaleString()} tokens）。`);
    } catch {
      void message.warning('浏览器未能直接写入剪贴板，可点击「下载档案文件」或在预览框手动复制。');
    }
  };

  const downloadPack = () => {
    const ext = format === 'xml' ? 'xml' : 'md';
    const mime = format === 'xml' ? 'application/xml;charset=utf-8' : 'text/markdown;charset=utf-8';
    const blob = new Blob([pack.content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${task.jiraKey}-context-pack.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    void message.success(`已导出 ${task.jiraKey}-context-pack.${ext}`);
  };

  const kbText = (pack.byteLength / 1024).toFixed(1);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={720}
      title={
        <Space size={8}>
          <Package size={17} />
          <span>打包 AI 上下文与导出交付档案 · {task.jiraKey}</span>
        </Space>
      }
      footer={
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Space size={6} wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              约 {pack.estimatedTokens.toLocaleString()} tokens
            </Tag>
            <Tag style={{ marginInlineEnd: 0 }}>{kbText} KB</Tag>
            <Tag style={{ marginInlineEnd: 0 }}>材料 {pack.includedAssetCount} 份</Tag>
          </Space>
          <Space size={8}>
            <Button onClick={onClose}>关闭</Button>
            <Button icon={<Download size={15} />} onClick={downloadPack}>
              下载 .{format === 'xml' ? 'xml' : 'md'} 档案
            </Button>
            <Button type="primary" icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => void copyPack()}>
              {copied ? '已复制上下文包' : '一键复制上下文包'}
            </Button>
          </Space>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          将当前任务的 Jira 需求、仓库规范、五阶段门禁矩阵、版本化材料及评审结论一键聚合为单文件上下文包，可直接投喂给任意 Web AI 助手或归档至知识库。
        </Typography.Text>

        <Flex justify="space-between" align="center" gap={10} wrap>
          <Segmented<ContextPackFormat>
            aria-label="上下文包输出格式"
            value={format}
            onChange={val => {
              setFormat(val);
              writeStoredString(FORMAT_PREF_KEY, val);
            }}
            options={[
              { value: 'markdown', label: 'Markdown 交付档案（通用 / 归档）' },
              { value: 'xml', label: 'XML 结构化提示包（Claude / Cursor 推荐）' },
            ]}
          />
          <Space size={12} wrap>
            <Checkbox checked={latestAssetsOnly} onChange={e => setLatestAssetsOnly(e.target.checked)}>
              仅保留最新版材料（省 Token）
            </Checkbox>
            <Checkbox checked={includeReviews} onChange={e => setIncludeReviews(e.target.checked)}>
              含评审结论
            </Checkbox>
            <Checkbox checked={includeProgress} onChange={e => setIncludeProgress(e.target.checked)}>
              含进度流水
            </Checkbox>
          </Space>
        </Flex>

        <pre className="tf-code-panel" style={{ maxHeight: 340 }} aria-label="上下文包预览">
          {pack.content}
        </pre>
      </Flex>
    </Modal>
  );
};

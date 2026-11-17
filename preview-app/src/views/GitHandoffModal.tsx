import React, { useMemo, useState } from 'react';
import { App, Button, Card, Flex, Input, Modal, Segmented, Space, Tag, Typography } from 'antd';
import { Check, Copy, Download, GitBranch, RotateCcw, Terminal } from 'lucide-react';
import type { Asset, Gates, WorkTask } from './workspaceApi';
import {
  buildConventionalBranchName,
  buildGitWorktreeCommands,
  buildPullRequestDescription,
} from './gitHandoffKit';
import { MarkdownPreview } from './MarkdownPreview';

export const GitHandoffModal: React.FC<{
  open: boolean;
  onClose: () => void;
  task: WorkTask;
  assets: Asset[];
  gates: Gates | null;
  repoPath: string | null;
  currentBranch?: string | null;
}> = ({ open, onClose, task, assets, gates, repoPath, currentBranch }) => {
  const { message } = App.useApp();
  const defaultBranch = useMemo(() => buildConventionalBranchName(task), [task]);
  const [customBranch, setCustomBranch] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState<string>(() =>
    currentBranch && currentBranch !== 'HEAD' ? currentBranch : 'main',
  );
  const [activeTab, setActiveTab] = useState<'commands' | 'pr'>('commands');
  const [prViewMode, setPrViewMode] = useState<'preview' | 'raw'>('preview');
  const [copiedKey, setCopiedKey] = useState('');

  const effectiveBranch = (customBranch ?? defaultBranch).trim() || defaultBranch;

  const handoff = useMemo(
    () =>
      buildGitWorktreeCommands({
        task,
        branchName: effectiveBranch,
        repoPath,
        baseBranch,
      }),
    [task, effectiveBranch, repoPath, baseBranch],
  );

  const prDescription = useMemo(
    () =>
      buildPullRequestDescription({
        task,
        assets,
        gates,
        branchName: effectiveBranch,
      }),
    [task, assets, gates, effectiveBranch],
  );

  const copyText = async (key: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(cur => (cur === key ? '' : cur)), 1600);
      void message.success(`已复制${label}`);
    } catch {
      void message.warning('浏览器未能直接写入剪贴板，请手动选择复制。');
    }
  };

  const downloadPrMarkdown = () => {
    const blob = new Blob([prDescription], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${task.jiraKey}-pull-request.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    void message.success(`已导出 ${task.jiraKey}-pull-request.md`);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={780}
      title={
        <Space size={8}>
          <GitBranch size={18} />
          <span>Git 分支 · Worktree 隔离 · PR/MR 描述套件</span>
          <Tag color="blue">{task.jiraKey}</Tag>
        </Space>
      }
      destroyOnHidden
    >
      <Flex vertical gap={14}>
        <Typography.Text type="secondary">
          根据事项类型与关联材料自动生成规范分支名、多 AI Agent 并行隔离的 <code>git worktree</code> 命令及合并请求（PR/MR）说明文档。
        </Typography.Text>

        <div className="tf-form-grid">
          <div>
            <Flex justify="space-between" align="center" style={{ marginBottom: 4 }}>
              <Typography.Text strong style={{ fontSize: 12.5 }}>工作分支名（Conventional Branch）</Typography.Text>
              {customBranch !== null && customBranch !== defaultBranch && (
                <Button size="small" type="link" icon={<RotateCcw size={12} />} onClick={() => setCustomBranch(null)} style={{ padding: 0, height: 'auto' }}>
                  恢复默认
                </Button>
              )}
            </Flex>
            <Input
              value={customBranch ?? defaultBranch}
              onChange={e => setCustomBranch(e.target.value)}
              maxLength={120}
              suffix={
                <Button
                  size="small"
                  type="text"
                  icon={copiedKey === 'branch' ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => void copyText('branch', effectiveBranch, '分支名')}
                >
                  复制
                </Button>
              }
            />
          </div>
          <div>
            <Typography.Text strong style={{ display: 'block', fontSize: 12.5, marginBottom: 4 }}>
              基准分支（用于创建隔离 Worktree）
            </Typography.Text>
            <Input
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
              placeholder="main"
              maxLength={80}
            />
          </div>
        </div>

        <Flex justify="space-between" align="center" gap={8} wrap>
          <Segmented<'commands' | 'pr'>
            value={activeTab}
            onChange={setActiveTab}
            options={[
              { value: 'commands', label: 'Git / Worktree 终端命令' },
              { value: 'pr', label: 'PR / MR 合并说明文档' },
            ]}
          />
          {activeTab === 'pr' && (
            <Space size={8} wrap>
              <Segmented<'preview' | 'raw'>
                size="small"
                value={prViewMode}
                onChange={setPrViewMode}
                options={[
                  { value: 'preview', label: '排版预览' },
                  { value: 'raw', label: 'Markdown 源码' },
                ]}
              />
              <Button
                size="small"
                type="primary"
                icon={copiedKey === 'pr' ? <Check size={14} /> : <Copy size={14} />}
                onClick={() => void copyText('pr', prDescription, ' PR / MR 描述')}
              >
                复制 PR/MR 描述
              </Button>
              <Button size="small" icon={<Download size={14} />} onClick={downloadPrMarkdown}>
                下载 .md
              </Button>
            </Space>
          )}
        </Flex>

        {activeTab === 'commands' ? (
          <Flex vertical gap={10}>
            <Card
              size="small"
              title={<Space size={6}><Terminal size={14} /><span>1. 多 AI Agent 并行隔离 Worktree（推荐）</span><Tag color="purple">零切分支冲突</Tag></Space>}
              extra={
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={copiedKey === 'wt' ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => void copyText('wt', handoff.worktreeCommand, ' Worktree 创建命令')}
                >
                  复制创建命令
                </Button>
              }
            >
              <pre className="tf-code-panel" style={{ margin: 0 }}>{handoff.worktreeCommand}</pre>
              <Flex justify="space-between" align="center" gap={8} wrap style={{ marginTop: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  合并完成后清理工作树：<code>{handoff.cleanupWorktreeCommand}</code>
                </Typography.Text>
                <Button
                  size="small"
                  type="text"
                  icon={copiedKey === 'wt-clean' ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => void copyText('wt-clean', handoff.cleanupWorktreeCommand, ' Worktree 清理命令')}
                >
                  复制清理命令
                </Button>
              </Flex>
            </Card>

            <Card
              size="small"
              title="2. 常规单仓库新建并切换分支"
              extra={
                <Button
                  size="small"
                  icon={copiedKey === 'checkout' ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => void copyText('checkout', handoff.checkoutCommand, '切分支命令')}
                >
                  复制命令
                </Button>
              }
            >
              <pre className="tf-code-panel" style={{ margin: 0 }}>{handoff.checkoutCommand}</pre>
            </Card>

            <Card
              size="small"
              title="3. 规范化提交信息（Conventional Commits + Jira 关联号）"
              extra={
                <Button
                  size="small"
                  icon={copiedKey === 'commit' ? <Check size={13} /> : <Copy size={13} />}
                  onClick={() => void copyText('commit', handoff.commitCommand, '规范提交命令')}
                >
                  复制命令
                </Button>
              }
            >
              <pre className="tf-code-panel" style={{ margin: 0 }}>{handoff.commitCommand}</pre>
            </Card>
          </Flex>
        ) : prViewMode === 'preview' ? (
          <div style={{ maxHeight: 420, overflowY: 'auto', padding: '12px 16px', background: 'var(--tf-surface)', border: '1px solid var(--tf-border)', borderRadius: 8 }}>
            <MarkdownPreview content={prDescription} />
          </div>
        ) : (
          <pre className="tf-code-panel" style={{ maxHeight: 420, overflowY: 'auto', margin: 0 }}>
            {prDescription}
          </pre>
        )}
      </Flex>
    </Modal>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Flex, Input, Modal, Space, Tag, Typography } from 'antd';
import type { InputRef } from 'antd';
import { ArrowRight, Compass, FolderKanban, Layers, Search, Zap } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import type { Project, WorkTask } from './workspaceApi';
import type { WorkspaceSection } from './workspaceNavigation';
import { buildQuickCommandItems, type QuickCommandItem } from './quickCommandSearch';

export const QuickCommandModal: React.FC<{
  open: boolean;
  tasks: WorkTask[];
  projects: Project[];
  currentProjectId: string;
  currentUserId: string;
  canIntake: boolean;
  canSyncJira: boolean;
  canStandupDigest?: boolean;
  onClose: () => void;
  onSelectTask: (taskId: string, projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectSection: (section: WorkspaceSection) => void;
  onTriggerAction: (action: 'intake' | 'sync-jira' | 'standup-digest') => void;
}> = ({
  open,
  tasks,
  projects,
  currentProjectId,
  currentUserId,
  canIntake,
  canSyncJira,
  canStandupDigest = true,
  onClose,
  onSelectTask,
  onSelectProject,
  onSelectSection,
  onTriggerAction,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  const items = useMemo(
    () =>
      buildQuickCommandItems({
        query,
        tasks,
        projects,
        currentProjectId,
        currentUserId,
        canIntake,
        canSyncJira,
        canStandupDigest,
      }),
    [query, tasks, projects, currentProjectId, currentUserId, canIntake, canSyncJira, canStandupDigest],
  );

  const safeIndex = items.length ? Math.min(activeIndex, items.length - 1) : 0;

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${safeIndex}"]`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [safeIndex, open]);

  const executeItem = (item: QuickCommandItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'task' && item.taskId && item.projectId) {
      onSelectTask(item.taskId, item.projectId);
    } else if (item.kind === 'project' && item.projectId) {
      onSelectProject(item.projectId);
    } else if (item.kind === 'section' && item.section) {
      onSelectSection(item.section);
    } else if (item.kind === 'action' && item.actionId) {
      onTriggerAction(item.actionId);
    }
  };

  const iconFor = (kind: QuickCommandItem['kind']) => {
    if (kind === 'task') return <Layers size={15} />;
    if (kind === 'project') return <FolderKanban size={15} />;
    if (kind === 'action') return <Zap size={15} />;
    return <Compass size={15} />;
  };

  return (
    <Modal
      open={open}
      title={null}
      footer={null}
      closable={false}
      width={620}
      onCancel={onClose}
      styles={{ body: { padding: 12 } }}
    >
      <Flex vertical gap={10}>
        <Input
          ref={inputRef}
          size="large"
          allowClear
          prefix={<Search size={16} />}
          suffix={<Tag style={{ marginInlineEnd: 0 }}>↑↓ 选择 · ↵ 直达 · Esc 关闭</Tag>}
          aria-label="全局快速跳转搜索"
          placeholder="输入 Jira 任务号、任务标题、项目名称或功能模块…"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (items.length) setActiveIndex(prev => (prev + 1) % items.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (items.length) setActiveIndex(prev => (prev - 1 + items.length) % items.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              executeItem(items[safeIndex]);
            } else if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery('');
              setActiveIndex(0);
            }
          }}
        />
        <div
          ref={listRef}
          role="listbox"
          aria-label="快速跳转结果"
          style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          {!items.length ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到匹配的任务、项目或模块" />
          ) : (
            items.map((item, idx) => {
              const showGroup = idx === 0 || items[idx - 1].groupLabel !== item.groupLabel;
              const selected = idx === safeIndex;
              return (
                <React.Fragment key={item.id}>
                  {showGroup && (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11.5, fontWeight: 600, padding: '6px 8px 2px' }}
                    >
                      {item.groupLabel}
                    </Typography.Text>
                  )}
                  <div
                    role="option"
                    aria-selected={selected}
                    data-cmd-idx={idx}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => executeItem(item)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: selected ? 'var(--tf-accent-soft)' : 'transparent',
                      border: selected
                        ? '1px solid color-mix(in srgb, var(--tf-accent) 32%, var(--tf-border))'
                        : '1px solid transparent',
                    }}
                  >
                    <Space size={10} style={{ minWidth: 0, flex: '1 1 auto' }}>
                      <span style={{ color: selected ? 'var(--tf-accent)' : 'var(--tf-secondary)', display: 'inline-flex' }}>
                        {iconFor(item.kind)}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <Typography.Text strong ellipsis style={{ display: 'block', maxWidth: 410 }}>
                          {item.title}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {item.subtitle}
                        </Typography.Text>
                      </div>
                    </Space>
                    <Space size={6} style={{ flex: '0 0 auto' }}>
                      {item.badge && (
                        <StatusBadge variant={item.badgeVariant || 'neutral'}>{item.badge}</StatusBadge>
                      )}
                      {selected && <ArrowRight size={14} style={{ color: 'var(--tf-accent)' }} />}
                    </Space>
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>
      </Flex>
    </Modal>
  );
};

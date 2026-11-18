import React from 'react';
import { App as AntApp, Button, Flex, Grid, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Copy, Trash2, UserCheck } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { memberName, ProjectMember, TaskStatus, timeText, WorkTask } from './workspaceApi';
import type { ChainStatusMap } from './workspaceApi';
import { ChainStatusDots } from './TaskChainPanel';
import { TASK_STATUS_OPTIONS, taskStatusLabel, taskTypeLabel } from './displayLabels';
import { isTaskFrozen } from './taskAvailability';
import { formatBatchTasksMarkdown } from './taskContextPack';
import { buildTaskTree, type TreeTaskRow } from './taskTree';

const { Text } = Typography;
const PAGE_SIZE = 10;
const ROW_CLICK_IGNORE = 'button,a,input,.ant-select,.ant-select-dropdown,.ant-checkbox-wrapper,.ant-table-selection-column';
const localStatusVariant = (status: WorkTask['status']) => status === 'DONE' ? 'green' : status === 'IN_PROGRESS' || status === 'IN_REVIEW' ? 'blue' : 'neutral';

const JiraMeta: React.FC<{ task: WorkTask }> = ({ task }) => {
  const ref = task.externalRef;
  if (!ref) return null;
  const brief = [
    ref.assignee?.displayName,
    ref.priority?.name,
    ref.fixVersions?.length ? ref.fixVersions.map(item => item.name).join(' / ') : '',
  ].filter(Boolean);
  const details = [
    ref.assignee?.displayName && `Jira 经办人：${ref.assignee.displayName}`,
    ref.priority && `优先级：${ref.priority.name}`,
    ref.components?.length && `组件：${ref.components.map(item => item.name).join(' · ')}`,
    ref.fixVersions?.length && `修复版本：${ref.fixVersions.map(item => item.name).join(' · ')}`,
    ref.labels?.length && `标签：${ref.labels.join(' · ')}`,
  ].filter((value): value is string => !!value);
  if (!details.length) return null;
  return <Tooltip title={<div>{details.map(line => <div key={line}>{line}</div>)}</div>}>
    <Text type="secondary" className="tf-task-source-meta" ellipsis>{brief.join(' · ') || details[0]}</Text>
  </Tooltip>;
};

export const TaskListTable: React.FC<{
  tasks: WorkTask[]; projectTasks: WorkTask[]; allTasks: WorkTask[]; members: ProjectMember[];
  userId: string; canAssign: boolean; isProjectMember: boolean; busy: boolean; updatingTaskId: string;
  page: number; onPageChange: (page: number) => void;
  selectedIds: string[]; onSelectionChange: (ids: string[]) => void;
  onOpenTask: (id: string) => void;
  onSwitchStatus: (task: WorkTask, status: TaskStatus) => void;
  onSwitchAssignee: (task: WorkTask, assigneeId: string) => void;
  onClaim: (task: WorkTask) => void;
  onRemove: (task: WorkTask) => void;
  onBatchClaim: (tasks: WorkTask[]) => void;
  onBatchStatus: (tasks: WorkTask[], status: TaskStatus) => void;
  onBatchAssign: (tasks: WorkTask[], assigneeId: string) => void;
  chainStatuses?: Record<string, ChainStatusMap>;
  groupByParent?: boolean;
}> = props => {
  const { tasks, projectTasks, allTasks, members, userId, canAssign, isProjectMember, busy, updatingTaskId, page, onPageChange, selectedIds, onSelectionChange, onOpenTask, groupByParent = false } = props;
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const assigneeOptions = [{ value: '', label: '未指派' }, ...members.map(member => ({ value: member.id, label: member.username }))];
  const editableStatusOptions = TASK_STATUS_OPTIONS.filter(opt => opt.value !== 'DONE');
  const dataSource: TreeTaskRow[] = groupByParent ? buildTaskTree(tasks) : tasks;

  const columns: TableColumnsType<TreeTaskRow> = [
    { title: '任务', key: 'task', width: screens.md ? 350 : undefined, render: (_, task) => <div className="tf-task-cell">
      <Space wrap size={8}>
        <Text className="tf-task-key">{task.jiraKey}</Text>
        <Text type="secondary">{task.externalRef ? task.externalRef.type : taskTypeLabel(task.type)}</Text>
        {!!task.subtasks?.length && <Tag style={{ marginInlineEnd: 0 }}>{task.subtasks.length} 个子任务</Tag>}
        {task.parentId && !groupByParent && <Text type="secondary">父任务 {projectTasks.find(item => item.id === task.parentId)?.jiraKey || task.parentId}</Text>}
      </Space>
      <div className="tf-mobile-task-status"><Space wrap size={8}>{task.externalRef && <><Text type="secondary">Jira</Text><StatusBadge variant="blue">{task.externalRef.status}</StatusBadge></>}<Text type="secondary">本地</Text><StatusBadge variant={localStatusVariant(task.status)}>{taskStatusLabel(task.status)}</StatusBadge></Space></div>
      <Button type="link" className="tf-task-title" disabled={busy} onClick={() => onOpenTask(task.id)}>{task.title}</Button>
      <JiraMeta task={task} />
    </div> },
    { title: 'Jira 状态', key: 'jiraStatus', width: 120, responsive: ['md'], render: (_, task) => task.externalRef ? <StatusBadge variant="blue">{task.externalRef.status}</StatusBadge> : <Text type="secondary">—</Text> },
    { title: <Tooltip title="需求 → 拆分 → 方案 → 代码 → 测试 → 上线，每个环节的审核状态">交付链路</Tooltip>, key: 'chain', width: 256, responsive: ['lg'], render: (_, task) => <ChainStatusDots statuses={props.chainStatuses?.[task.id]} /> },
    { title: '本地状态', key: 'status', width: 140, responsive: ['md'], render: (_, task) => {
      const editable = (canAssign || task.assigneeId === userId) && task.status !== 'DONE' && !isTaskFrozen(task, allTasks);
      return <Flex vertical gap={6}>
        {editable ? (
          <Select<TaskStatus>
            size="small"
            aria-label={`修改 ${task.jiraKey} 本地状态`}
            value={task.status}
            disabled={busy || updatingTaskId === task.id}
            options={editableStatusOptions}
            onChange={val => props.onSwitchStatus(task, val)}
            style={{ width: 108 }}
          />
        ) : <StatusBadge variant={localStatusVariant(task.status)}>{taskStatusLabel(task.status)}</StatusBadge>}
        <Text type="secondary" className="tf-table-secondary">自报 {task.progress}%</Text>
      </Flex>;
    } },
    { title: '本地受理人', key: 'assignee', width: 136, responsive: ['md'], render: (_, task) => {
      if (!canAssign || task.status === 'DONE' || isTaskFrozen(task, allTasks)) return memberName(members, task.assigneeId);
      return <Select<string>
        size="small"
        aria-label={`修改 ${task.jiraKey} 本地受理人`}
        value={task.assigneeId || ''}
        disabled={busy || updatingTaskId === task.id}
        popupMatchSelectWidth={false}
        options={assigneeOptions}
        onChange={val => props.onSwitchAssignee(task, val)}
        style={{ width: 112 }}
      />;
    } },
    { title: '更新时间', key: 'updatedAt', width: 168, responsive: ['lg'], render: (_, task) => <Text type="secondary" className="tf-table-secondary">{timeText(task.updatedAt)}</Text> },
    { title: '操作', key: 'actions', width: 136, render: (_, task) => {
      const canClaim = isProjectMember && !task.assigneeId && task.status !== 'DONE';
      const canRemove = canAssign || task.ownerId === userId;
      if (!canClaim && !canRemove) return <Text type="secondary">—</Text>;
      return <Space size={2} wrap>
        {canClaim && <Button type="link" size="small" icon={<UserCheck size={14} />} disabled={busy} onClick={() => props.onClaim(task)}>认领</Button>}
        {canRemove && <Button type="text" danger size="small" icon={<Trash2 size={14} />} disabled={busy} aria-label={`移出任务 ${task.jiraKey}`} onClick={() => props.onRemove(task)}>移出</Button>}
      </Space>;
    } },
  ];

  const selectedSet = new Set(selectedIds);
  const selected = tasks.filter(item => selectedSet.has(item.id));
  const claimable = isProjectMember ? selected.filter(item => !item.assigneeId && item.status !== 'DONE') : [];
  const editable = selected.filter(item => (canAssign || item.assigneeId === userId) && item.status !== 'DONE' && !isTaskFrozen(item, allTasks));
  const assignable = canAssign ? selected.filter(item => item.status !== 'DONE' && !isTaskFrozen(item, allTasks)) : [];
  const copySelected = () => {
    void navigator.clipboard.writeText(formatBatchTasksMarkdown(selected, members))
      .then(() => message.success(`已复制 ${selected.length} 项任务清单 (Markdown)。`))
      .catch(() => {});
  };

  return <>
    {selected.length > 0 && (
      <div className="tf-batch-bar" role="region" aria-label="批量操作栏">
        <Space size={8} wrap>
          <Text strong>已选 {selected.length} 项</Text>
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => onSelectionChange([])}>取消选择</Button>
        </Space>
        <Space size={8} wrap>
          {claimable.length > 0 && <Button size="small" type="primary" icon={<UserCheck size={13} />} disabled={busy} onClick={() => props.onBatchClaim(claimable)}>批量认领 ({claimable.length})</Button>}
          {editable.length > 0 && (
            <Select<TaskStatus>
              size="small"
              placeholder="批量改状态…"
              aria-label="批量修改本地状态"
              value={undefined}
              disabled={busy}
              popupMatchSelectWidth={false}
              options={editableStatusOptions}
              onChange={status => {
                const toMove = editable.filter(item => item.status !== status);
                if (toMove.length) props.onBatchStatus(toMove, status);
              }}
              style={{ width: 128 }}
            />
          )}
          {assignable.length > 0 && (
            <Select<string>
              size="small"
              placeholder="批量指派…"
              aria-label="批量指派本地受理人"
              value={undefined}
              disabled={busy}
              popupMatchSelectWidth={false}
              options={assigneeOptions}
              onChange={assigneeId => props.onBatchAssign(assignable, assigneeId)}
              style={{ width: 128 }}
            />
          )}
          <Button size="small" icon={<Copy size={13} />} onClick={copySelected}>复制清单</Button>
        </Space>
      </div>
    )}
    <Table<TreeTaskRow>
      className="tf-task-table"
      rowKey="id"
      rowSelection={{ selectedRowKeys: selectedIds, onChange: keys => onSelectionChange(keys.map(String)) }}
      columns={columns}
      dataSource={dataSource}
      expandable={groupByParent ? { childrenColumnName: 'subtasks', defaultExpandAllRows: true } : undefined}
      loading={busy}
      pagination={{ current: page, pageSize: PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true, size: 'small', onChange: onPageChange }}
      tableLayout="fixed"
      scroll={screens.md ? { x: 1080 } : undefined}
      locale={{ emptyText: projectTasks.length ? '没有符合条件的任务。' : '当前项目尚无任务，可粘贴 Jira 链接或选择已有事项接入。' }}
      onRow={record => ({
        onClick: event => {
          if (!busy && !(event.target as HTMLElement).closest(ROW_CLICK_IGNORE)) onOpenTask(record.id);
        },
      })}
    />
  </>;
};

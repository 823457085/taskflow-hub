import React from 'react';
import { App as AntApp, Button, Dropdown, Grid, Select, Space, Table, Tooltip, Typography } from 'antd';
import type { MenuProps, TableColumnsType } from 'antd';
import { Copy, Ellipsis, Trash2, UserCheck } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { memberName, ProjectMember, TaskStatus, timeText, WorkTask } from './workspaceApi';
import { TASK_STATUS_OPTIONS, taskStatusLabel, taskTypeLabel } from './displayLabels';
import { isTaskFrozen } from './taskAvailability';
import { formatBatchTasksMarkdown } from './taskContextPack';
import './TaskListTable.css';

const { Text } = Typography;
export const TASK_PAGE_SIZE = 10;
const ROW_CLICK_IGNORE = 'button,a,input,.ant-select,.ant-select-dropdown,.ant-checkbox-wrapper,.ant-table-selection-column';
const localStatusVariant = (status: WorkTask['status']) => status === 'DONE' ? 'green' : status === 'IN_PROGRESS' || status === 'IN_REVIEW' ? 'blue' : 'neutral';

const JiraMeta: React.FC<{ task: WorkTask }> = ({ task }) => {
  const ref = task.externalRef;
  if (!ref) return null;
  const details = [
    ref.assignee?.displayName && `Jira 经办人：${ref.assignee.displayName}`,
    ref.priority && `优先级：${ref.priority.name}`,
    ref.components?.length && `组件：${ref.components.map(item => item.name).join(' · ')}`,
    ref.fixVersions?.length && `修复版本：${ref.fixVersions.map(item => item.name).join(' · ')}`,
    ref.labels?.length && `标签：${ref.labels.join(' · ')}`,
  ].filter((value): value is string => !!value);
  return <Tooltip title={details.length ? <div>{details.map(line => <div key={line}>{line}</div>)}</div> : undefined}>
    <Text type="secondary">{ref.type}</Text>
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
  activeTaskId?: string; compact?: boolean; readOnly?: boolean; projectKeys?: ReadonlyMap<string, string>;
}> = props => {
  const { tasks, projectTasks, allTasks, members, userId, canAssign, isProjectMember, busy, updatingTaskId, page, onPageChange, selectedIds, onSelectionChange, onOpenTask, activeTaskId, compact = false, readOnly = false, projectKeys } = props;
  const { message } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const showInlineStatus = compact || !screens.md;
  const assigneeOptions = [{ value: '', label: '未指派' }, ...members.map(member => ({ value: member.id, label: member.username }))];
  const editableStatusOptions = TASK_STATUS_OPTIONS.filter(opt => opt.value !== 'DONE');

  const columns: TableColumnsType<WorkTask> = [
    { title: '任务', key: 'task', render: (_, task) => {
      const assignee = memberName(members, task.assigneeId);
      const childCount = projectTasks.filter(item => item.parentId === task.id).length;

      return <div className="tf-task-cell">
        <Tooltip title={task.title} placement="topLeft">
          <Button type="link" className="tf-task-title" disabled={busy} aria-current={activeTaskId === task.id || undefined} onClick={() => onOpenTask(task.id)}>{task.title}</Button>
        </Tooltip>
        <div className="tf-task-rail-meta">
          <Text className="tf-task-key">{task.jiraKey}</Text>
          {projectKeys?.has(task.projectId) && <Text type="secondary">{projectKeys.get(task.projectId)}</Text>}
          {showInlineStatus && (
            <>
              <span className={`tf-task-rail-status tf-task-rail-status-${localStatusVariant(task.status)}`}>{taskStatusLabel(task.status)}</span>
              {!readOnly && <span className="tf-task-rail-assignee" title={assignee}>{assignee}</span>}
            </>
          )}
          {!showInlineStatus && (task.externalRef ? <JiraMeta task={task} /> : <Text type="secondary">{taskTypeLabel(task.type)}</Text>)}
          {childCount > 0 && <span className="tf-task-rail-parent">{childCount} 个子任务</span>}
        </div>
      </div>;
    } },
    { title: '状态', key: 'status', width: 148, responsive: ['md'], render: (_, task) => {
      const editable = !readOnly && (canAssign || task.assigneeId === userId) && task.status !== 'DONE' && !isTaskFrozen(task, allTasks);
      return <div className="tf-task-cell">
        <div>{editable ? (
          <Select<TaskStatus>
            size="small"
            aria-label={`修改 ${task.jiraKey} 本地状态`}
            value={task.status}
            disabled={busy || updatingTaskId === task.id}
            options={editableStatusOptions}
            onChange={val => props.onSwitchStatus(task, val)}
          />
        ) : <StatusBadge variant={localStatusVariant(task.status)}>{taskStatusLabel(task.status)}</StatusBadge>}</div>
        {task.externalRef?.status && <Text type="secondary" className="tf-task-row-meta">Jira · {task.externalRef.status}</Text>}
      </div>;
    } },
    { title: '负责人', key: 'assignee', width: 148, responsive: ['md'], render: (_, task) => {
      if (!canAssign || task.status === 'DONE' || isTaskFrozen(task, allTasks)) return memberName(members, task.assigneeId);
      return <Select<string>
        size="small"
        aria-label={`修改 ${task.jiraKey} 本地受理人`}
        value={task.assigneeId || ''}
        disabled={busy || updatingTaskId === task.id}
        popupMatchSelectWidth={false}
        options={assigneeOptions}
        onChange={val => props.onSwitchAssignee(task, val)}
        style={{ maxWidth: '100%' }}
      />;
    } },
    { title: '更新时间', key: 'updatedAt', width: 172, responsive: ['lg'], render: (_, task) => <Text type="secondary" className="tf-task-row-meta">{timeText(task.updatedAt)}</Text> },
    { title: '', key: 'actions', width: compact ? 34 : 52, render: (_, task) => {
      const canClaim = isProjectMember && !task.assigneeId && task.status !== 'DONE';
      const canRemove = canAssign || task.ownerId === userId;
      if (!canClaim && !canRemove) return null;
      return <Dropdown trigger={['click']} menu={{ items: [
        ...(canClaim ? [{ key: 'claim', label: '认领', icon: <UserCheck size={14} />, onClick: () => props.onClaim(task) }] : []),
        ...(canRemove ? [{ key: 'remove', label: '移出任务', danger: true, icon: <Trash2 size={14} />, onClick: () => props.onRemove(task) }] : []),
      ] }}>
        <Button type="text" size="small" icon={<Ellipsis size={16} />} disabled={busy} aria-label={`${task.jiraKey} 更多操作`} />
      </Dropdown>;
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
  const batchActions: MenuProps['items'] = [
    ...(claimable.length > 0 ? [{
      key: 'claim',
      label: `认领 ${claimable.length} 项`,
      icon: <UserCheck size={14} />,
      onClick: () => props.onBatchClaim(claimable),
    }] : []),
    ...(editable.length > 0 ? [{
      key: 'status',
      label: '修改状态',
      children: editableStatusOptions.map(({ label, value }) => ({
        key: `status:${value}`,
        label,
        onClick: () => {
          const toMove = editable.filter(item => item.status !== value);
          if (toMove.length) props.onBatchStatus(toMove, value);
        },
      })),
    }] : []),
    ...(assignable.length > 0 ? [{
      key: 'assign',
      label: '指派负责人',
      children: assigneeOptions.map(({ label, value }) => ({
        key: `assignee:${value}`,
        label,
        onClick: () => props.onBatchAssign(assignable, value),
      })),
    }] : []),
    { key: 'copy', label: '复制清单', icon: <Copy size={14} />, onClick: copySelected },
  ];

  return <div className={compact ? 'tf-task-list-rail' : undefined}>
    {!readOnly && selected.length > 0 && (
      <div className="tf-batch-bar tf-task-batch-controls" role="region" aria-label="批量操作栏">
        <Text strong>已选 {selected.length} 项</Text>
        <Space size={6}>
          <Button type="text" size="small" onClick={() => onSelectionChange([])}>取消</Button>
          <Dropdown trigger={['click']} menu={{ items: batchActions }}>
            <Button type="default" size="small" disabled={busy}>批量操作</Button>
          </Dropdown>
        </Space>
      </div>
    )}
    <Table<WorkTask>
      className="tf-task-table"
      rowKey="id"
      rowSelection={readOnly ? undefined : { columnWidth: compact ? 36 : undefined, selectedRowKeys: selectedIds, onChange: keys => onSelectionChange(keys.map(String)) }}
      columns={readOnly ? columns.filter(column => column.key !== 'assignee' && column.key !== 'actions')
        : compact ? columns.filter(column => column.key === 'task' || column.key === 'actions') : columns}
      dataSource={tasks}
      loading={busy}
      pagination={{ current: page, pageSize: TASK_PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true, size: 'small', onChange: onPageChange }}
      tableLayout="fixed"
      locale={{ emptyText: projectTasks.length ? '没有符合条件的主任务' : '当前项目暂无主任务' }}
      rowClassName={record => record.id === activeTaskId ? 'tf-task-preview-active' : ''}
      onRow={record => ({
        onClick: event => {
          if (!busy && !(event.target as HTMLElement).closest(ROW_CLICK_IGNORE)) onOpenTask(record.id);
        },
      })}
    />
  </div>;
};

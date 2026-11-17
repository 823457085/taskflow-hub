import React, { useMemo, useState } from 'react';
import { Button, Flex, Segmented, Select, Space, Tag, Typography } from 'antd';
import { ChevronDown, ChevronRight, GripVertical, UserCheck } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { memberName, ProjectMember, TaskStatus, timeText, WorkTask } from './workspaceApi';
import { TASK_STATUS_OPTIONS, taskTypeLabel } from './displayLabels';
import { hasDoneAncestor } from './taskAvailability';
import { buildKanbanSwimlanes, evaluateColumnWip, type KanbanGroupBy } from './kanbanSwimlanes';
import { readStoredChoice, readStoredStringList, writeStoredString, writeStoredStringList } from './uiPreferences';

const { Text } = Typography;

const COLUMN_VARIANT: Record<TaskStatus, 'neutral' | 'blue' | 'green'> = {
  OPEN: 'neutral',
  IN_PROGRESS: 'blue',
  IN_REVIEW: 'blue',
  DONE: 'green',
};

const KANBAN_GROUP_KEY = 'taskflow.tasks.kanbanGroupBy';
const KANBAN_WIP_KEY = 'taskflow.tasks.kanbanWipLimit';
const KANBAN_COLLAPSED_KEY = 'taskflow.tasks.kanbanCollapsedLanes';
const GROUP_OPTIONS = ['none', 'assignee', 'type'] as const;
const WIP_OPTIONS = ['0', '3', '5', '8'] as const;

export const TaskKanbanBoard: React.FC<{
  tasks: WorkTask[];
  allTasks: WorkTask[];
  members: ProjectMember[];
  userId: string;
  canAssign: boolean;
  isProjectMember: boolean;
  busy: boolean;
  updatingTaskId: string;
  onOpenTask: (taskId: string) => void;
  onMoveStatus: (task: WorkTask, nextStatus: TaskStatus) => void;
  onClaimTask: (task: WorkTask) => void;
}> = ({
  tasks,
  allTasks,
  members,
  userId,
  canAssign,
  isProjectMember,
  busy,
  updatingTaskId,
  onOpenTask,
  onMoveStatus,
  onClaimTask,
}) => {
  const [draggingId, setDraggingId] = useState<string>('');
  const [dropCell, setDropCell] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<KanbanGroupBy>(() => readStoredChoice(KANBAN_GROUP_KEY, GROUP_OPTIONS, 'none'));
  const [wipLimitStr, setWipLimitStr] = useState<typeof WIP_OPTIONS[number]>(() => readStoredChoice(KANBAN_WIP_KEY, WIP_OPTIONS, '5'));
  const [collapsedLanes, setCollapsedLanes] = useState<string[]>(() => readStoredStringList(KANBAN_COLLAPSED_KEY));

  const wipLimit = Number(wipLimitStr) || 0;

  const canDragTask = (task: WorkTask): boolean =>
    !busy &&
    updatingTaskId !== task.id &&
    (canAssign || task.assigneeId === userId) &&
    !hasDoneAncestor(task, allTasks);

  const draggingTask = draggingId ? tasks.find(item => item.id === draggingId) : undefined;

  const swimlanes = useMemo(
    () => buildKanbanSwimlanes(tasks, members, userId, groupBy),
    [tasks, members, userId, groupBy],
  );

  const globalWipByCol = useMemo(() => {
    const map = new Map<TaskStatus, ReturnType<typeof evaluateColumnWip>>();
    for (const col of TASK_STATUS_OPTIONS) {
      const count = tasks.filter(t => t.status === col.value).length;
      map.set(col.value, evaluateColumnWip(col.value, count, wipLimit));
    }
    return map;
  }, [tasks, wipLimit]);

  const overloadedColumns = TASK_STATUS_OPTIONS.filter(col => globalWipByCol.get(col.value)?.isOverloaded);

  const toggleLane = (laneKey: string) => {
    setCollapsedLanes(prev => {
      const next = prev.includes(laneKey) ? prev.filter(k => k !== laneKey) : [...prev, laneKey];
      writeStoredStringList(KANBAN_COLLAPSED_KEY, next);
      return next;
    });
  };

  const renderColumnsGrid = (laneKey: string, laneTasks: WorkTask[], showGlobalWipBadge: boolean) => (
    <div className="tf-kanban-board">
      {TASK_STATUS_OPTIONS.map(col => {
        const colTasks = laneTasks.filter(item => item.status === col.value);
        const cellKey = `${laneKey}:${col.value}`;
        const isDropActive = !!draggingTask && dropCell === cellKey && draggingTask.status !== col.value;
        const wipEval = showGlobalWipBadge
          ? globalWipByCol.get(col.value)
          : evaluateColumnWip(col.value, colTasks.length, wipLimit);

        return (
          <div
            key={col.value}
            className={`tf-kanban-col ${isDropActive ? 'tf-kanban-col-drop-active' : ''} ${wipEval?.isOverloaded ? 'tf-kanban-col-overloaded' : ''}`}
            onDragOver={event => {
              if (!draggingTask || draggingTask.status === col.value) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (dropCell !== cellKey) setDropCell(cellKey);
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dropCell === cellKey) {
                setDropCell(null);
              }
            }}
            onDrop={event => {
              event.preventDefault();
              setDropCell(null);
              const droppedId = event.dataTransfer.getData('text/plain') || draggingId;
              setDraggingId('');
              const target = tasks.find(item => item.id === droppedId);
              if (target && target.status !== col.value && canDragTask(target)) {
                onMoveStatus(target, col.value);
              }
            }}
          >
            <Flex justify="space-between" align="center" gap={6} className="tf-kanban-col-header">
              <Space size={6}>
                <StatusBadge variant={COLUMN_VARIANT[col.value]}>{col.label}</StatusBadge>
                <Text type="secondary" className="tf-kanban-count">
                  {wipEval?.isGovernedColumn && wipLimit > 0 ? `${colTasks.length}/${wipLimit}` : colTasks.length}
                </Text>
              </Space>
              {wipEval?.isOverloaded ? (
                <Tag color="warning" style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  WIP 超载
                </Tag>
              ) : wipEval?.isNearLimit ? (
                <Tag color="processing" style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  达上限
                </Tag>
              ) : col.value === 'DONE' ? (
                <Text type="secondary" style={{ fontSize: 11 }}>需门禁全通</Text>
              ) : null}
            </Flex>
            <div className="tf-kanban-cards">
              {!colTasks.length ? (
                <div className="tf-kanban-empty">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {draggingTask && draggingTask.status !== col.value ? `松开以移至「${col.label}」` : '暂无任务'}
                  </Text>
                </div>
              ) : colTasks.map(task => {
                const draggable = canDragTask(task);
                const canClaimCard = isProjectMember && !task.assigneeId && task.status !== 'DONE';
                return (
                  <div
                    key={task.id}
                    draggable={draggable}
                    className={`tf-kanban-card ${draggable ? 'tf-kanban-card-draggable' : ''} ${draggingId === task.id ? 'tf-kanban-card-dragging' : ''}`}
                    onDragStart={event => {
                      if (!draggable) {
                        event.preventDefault();
                        return;
                      }
                      setDraggingId(task.id);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', task.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId('');
                      setDropCell(null);
                    }}
                    onClick={event => {
                      if (!busy && !(event.target as HTMLElement).closest('button,a')) {
                        onOpenTask(task.id);
                      }
                    }}
                  >
                    <Flex justify="space-between" align="center" gap={6}>
                      <Space size={6} wrap>
                        {draggable && <GripVertical size={13} className="tf-kanban-grip" aria-hidden="true" />}
                        <Text className="tf-task-key">{task.jiraKey}</Text>
                        <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '18px', paddingInline: 5 }}>
                          {task.externalRef ? task.externalRef.type : taskTypeLabel(task.type)}
                        </Tag>
                      </Space>
                      {task.externalRef?.priority?.name && (
                        <Text type="secondary" style={{ fontSize: 11 }}>{task.externalRef.priority.name}</Text>
                      )}
                    </Flex>
                    <Button
                      type="link"
                      className="tf-kanban-card-title"
                      disabled={busy}
                      onClick={() => onOpenTask(task.id)}
                    >
                      {task.title}
                    </Button>
                    {task.progress > 0 && task.status !== 'DONE' && (
                      <div className="tf-kanban-progress-wrap" aria-label={`自报进度 ${task.progress}%`}>
                        <div className="tf-kanban-progress-bar">
                          <div className="tf-kanban-progress-fill" style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }} />
                        </div>
                        <Text type="secondary" style={{ fontSize: 11 }}>{task.progress}%</Text>
                      </div>
                    )}
                    <Flex justify="space-between" align="center" gap={6} className="tf-kanban-card-footer">
                      {canClaimCard ? (
                        <Button
                          type="link"
                          size="small"
                          icon={<UserCheck size={13} />}
                          disabled={busy}
                          style={{ paddingInline: 0, height: 22 }}
                          onClick={event => {
                            event.stopPropagation();
                            onClaimTask(task);
                          }}
                        >
                          认领
                        </Button>
                      ) : (
                        <Text type="secondary" style={{ fontSize: 11.5 }} ellipsis>
                          {memberName(members, task.assigneeId)}
                        </Text>
                      )}
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {timeText(task.updatedAt).slice(5, 16)}
                      </Text>
                    </Flex>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div role="region" aria-label="任务状态看板" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Flex justify="space-between" align="center" gap={8} wrap className="tf-kanban-toolbar">
        <Space size={8} wrap>
          <Segmented<KanbanGroupBy>
            size="small"
            aria-label="看板水平泳道分组"
            value={groupBy}
            onChange={val => {
              setGroupBy(val);
              writeStoredString(KANBAN_GROUP_KEY, val);
            }}
            options={[
              { value: 'none', label: '不分组' },
              { value: 'assignee', label: '按负责人泳道' },
              { value: 'type', label: '按类型泳道' },
            ]}
          />
          {overloadedColumns.length > 0 && (
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              {overloadedColumns.map(c => c.label).join(' / ')} 超出在制品上限 ({wipLimit})
            </Tag>
          )}
        </Space>
        <Select<typeof WIP_OPTIONS[number]>
          size="small"
          aria-label="列在制品 WIP 上限"
          value={wipLimitStr}
          popupMatchSelectWidth={false}
          onChange={val => {
            setWipLimitStr(val);
            writeStoredString(KANBAN_WIP_KEY, val);
          }}
          options={[
            { value: '0', label: 'WIP 上限：不限' },
            { value: '3', label: 'WIP 上限：3 / 列' },
            { value: '5', label: 'WIP 上限：5 / 列' },
            { value: '8', label: 'WIP 上限：8 / 列' },
          ]}
        />
      </Flex>

      {groupBy === 'none' ? (
        renderColumnsGrid('all', tasks, true)
      ) : (
        <Flex vertical gap={12}>
          {swimlanes.map(lane => {
            const isCollapsed = collapsedLanes.includes(lane.key);
            return (
              <section key={lane.key} className="tf-kanban-swimlane">
                <button
                  type="button"
                  className="tf-kanban-swimlane-header"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleLane(lane.key)}
                >
                  <Space size={8} wrap>
                    {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                    <span className="tf-kanban-swimlane-title">{lane.title}</span>
                    <Tag style={{ marginInlineEnd: 0 }}>共 {lane.tasks.length} 项</Tag>
                    {lane.activeWip > 0 && (
                      <Tag color={wipLimit > 0 && lane.activeWip > wipLimit ? 'warning' : 'processing'} style={{ marginInlineEnd: 0 }}>
                        活跃 WIP {lane.activeWip}
                      </Tag>
                    )}
                    {lane.doneCount > 0 && (
                      <Tag color="success" style={{ marginInlineEnd: 0 }}>
                        已完成 {lane.doneCount}
                      </Tag>
                    )}
                  </Space>
                </button>
                {!isCollapsed && renderColumnsGrid(lane.key, lane.tasks, false)}
              </section>
            );
          })}
        </Flex>
      )}
    </div>
  );
};

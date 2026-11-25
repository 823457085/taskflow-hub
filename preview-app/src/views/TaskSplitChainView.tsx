import React from 'react';
import { Button, Card, Empty, Flex, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowUpRight, ChevronRight, CornerDownRight, Plus } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import { LINK_STATUS_META } from './ChainReportBits';
import { ChainStatusDots } from './TaskChainPanel';
import { taskStatusLabel, taskTypeLabel } from './displayLabels';
import { buildTaskTree } from './taskTree';
import {
  CHAIN_STAGE_ORDER,
  CHAIN_STAGE_SHORT,
  memberName,
  ProjectMember,
  ProjectPermissions,
  Role,
  User,
  WorkTask,
} from './workspaceApi';
import type { ChainLinkStatus, ChainStatusMap, Stage } from './workspaceApi';

const { Text } = Typography;

const WorkTaskDetail = React.lazy(() => import('./WorkTaskDetail').then(mod => ({ default: mod.WorkTaskDetail })));

const STAGE_FULL_LABEL: Record<Stage, string> = {
  PRD: '需求与 PRD',
  TASK_BREAKDOWN: 'Jira 与子任务',
  TECH_SPEC: '技术方案',
  CODE_REVIEW: '代码·分支·仓库',
  TEST_CASE: '测试用例',
  RELEASE: '上线与报告',
};

const isStageCleared = (status?: ChainLinkStatus): boolean => status === 'PASS' || status === 'CONDITIONAL';
const isStageBlocked = (status?: ChainLinkStatus): boolean =>
  status === 'BLOCKED' || status === 'CHANGES_REQUESTED';
const isStageStale = (status?: ChainLinkStatus): boolean => status === 'STALE';

function firstBottleneck(statuses?: ChainStatusMap): { index: number; stage: Stage; status: ChainLinkStatus } | null {
  if (!statuses) return null;
  for (let i = 0; i < CHAIN_STAGE_ORDER.length; i++) {
    const stage = CHAIN_STAGE_ORDER[i];
    const st = statuses[stage];
    if (!isStageCleared(st)) return { index: i + 1, stage, status: st || 'MISSING' };
  }
  return null;
}

export const ChainStagePipelineBar: React.FC<{
  tasks: WorkTask[];
  chainStatuses: Record<string, ChainStatusMap>;
  activeStage?: Stage;
  onSelectStage: (stage?: Stage) => void;
}> = ({ tasks, chainStatuses, activeStage, onSelectStage }) => {
  const roots = React.useMemo(() => buildTaskTree(tasks), [tasks]);
  if (!roots.length) return null;

  return (
    <div className="tf-stage-flow-bar" role="region" aria-label="6 环交付流程进度筛选">
      {CHAIN_STAGE_ORDER.map((stage, idx) => {
        let cleared = 0;
        let blocked = 0;
        let stale = 0;
        let pending = 0;
        for (const root of roots) {
          const st = chainStatuses[root.id]?.[stage];
          if (isStageCleared(st)) cleared += 1;
          else if (isStageBlocked(st)) blocked += 1;
          else if (isStageStale(st)) stale += 1;
          else pending += 1;
        }
        const selected = activeStage === stage;
        return (
          <React.Fragment key={stage}>
            {idx > 0 && <ChevronRight size={14} className="tf-stage-flow-arrow" aria-hidden="true" />}
            <Tooltip title={selected ? '点击取消聚焦，查看全部 6 环交付链路' : blocked + stale + pending > 0 ? `点击聚焦「${STAGE_FULL_LABEL[stage]}」环节并查看待处理任务` : `点击查看「${STAGE_FULL_LABEL[stage]}」已通过的材料与评审结论`}>
              <button
                type="button"
                className={`tf-stage-flow-node${selected ? ' is-active' : ''}${blocked > 0 ? ' has-block' : cleared === roots.length ? ' is-all-clear' : ''}`}
                onClick={() => onSelectStage(selected ? undefined : stage)}
              >
                <span className="tf-stage-flow-title">
                  <span className="tf-stage-flow-num">{idx + 1}</span>
                  <span>{STAGE_FULL_LABEL[stage]}</span>
                </span>
                <span className="tf-stage-flow-counts">
                  {blocked > 0 && <Tag color="error" style={{ marginInlineEnd: 0 }}>阻断 {blocked}</Tag>}
                  {stale > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>重审 {stale}</Tag>}
                  {pending > 0 && <Tag color="processing" style={{ marginInlineEnd: 0 }}>待处理 {pending}</Tag>}
                  {blocked === 0 && stale === 0 && pending === 0 && <Tag color="success" style={{ marginInlineEnd: 0 }}>全过 {cleared}</Tag>}
                </span>
              </button>
            </Tooltip>
          </React.Fragment>
        );
      })}
      {activeStage && (
        <Button size="small" type="link" onClick={() => onSelectStage(undefined)}>
          重置环节筛选
        </Button>
      )}
    </div>
  );
};

export const TaskSplitChainView: React.FC<{
  tasks: WorkTask[];
  projectTasks: WorkTask[];
  allTasks: WorkTask[];
  members: ProjectMember[];
  user: User;
  role: Role;
  permissions: ProjectPermissions;
  chainStatuses: Record<string, ChainStatusMap>;
  activeStage?: Stage;
  onSelectStage?: (stage?: Stage) => void;
  selectedTaskId: string;
  onSelectTask: (id: string) => void;
  onOpenFullTask: (id: string) => void;
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
  onForbidden: () => void;
  onResetFilters?: () => void;
  onCreateTask?: () => void;
}> = ({
  tasks,
  projectTasks,
  allTasks,
  members,
  user,
  role,
  permissions,
  chainStatuses,
  activeStage,
  onSelectStage,
  selectedTaskId,
  onSelectTask,
  onOpenFullTask,
  onChanged,
  onUnauthorized,
  onForbidden,
  onResetFilters,
  onCreateTask,
}) => {
  const tree = React.useMemo(() => buildTaskTree(tasks), [tasks]);
  const projectTaskIdSet = React.useMemo(() => new Set(projectTasks.map(item => item.id)), [projectTasks]);

  const activeTask = React.useMemo(() => {
    if (selectedTaskId) {
      const direct = tasks.find(t => t.id === selectedTaskId);
      if (direct) return direct;
      for (const root of tree) {
        const sub = root.subtasks?.find(c => c.id === selectedTaskId);
        if (sub) return sub;
      }
    }
    return tree[0] || null;
  }, [selectedTaskId, tasks, tree]);

  if (!tree.length) {
    return (
      <Card>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="当前筛选条件下暂无任务"
        >
          <Space>
            {onResetFilters && <Button onClick={onResetFilters}>清空筛选</Button>}
            {onCreateTask && <Button type="primary" icon={<Plus size={14} />} onClick={onCreateTask}>新建任务</Button>}
          </Space>
        </Empty>
      </Card>
    );
  }

  return (
    <div className="tf-tasks-split-layout">
      <div className="tf-tasks-split-rail" role="list" aria-label="交付任务清单">
        <div className="tf-split-rail-head">
          <span>任务清单</span>
          <span>{tasks.length} 项</span>
        </div>
        {tree.map(parent => {
          const parentSelected = activeTask?.id === parent.id;
          const statuses = chainStatuses[parent.id];
          const bottleneck = firstBottleneck(statuses);
          const bottleneckMeta = bottleneck ? LINK_STATUS_META[bottleneck.status] : null;
          return (
            <div
              key={parent.id}
              role="listitem"
              className={`tf-split-task-card${parentSelected ? ' is-selected' : ''}`}
            >
              <button
                type="button"
                className="tf-split-task-hit"
                onClick={() => onSelectTask(parent.id)}
              >
                <Flex justify="space-between" align="center" gap={6} wrap>
                  <Space size={6} wrap>
                    <Text className="tf-task-key" strong>{parent.jiraKey}</Text>
                    <Text type="secondary" style={{ fontSize: 11.5 }}>{memberName(members, parent.assigneeId)}</Text>
                  </Space>
                  <StatusBadge variant={parent.status === 'DONE' ? 'green' : parent.status === 'IN_PROGRESS' || parent.status === 'IN_REVIEW' ? 'blue' : 'neutral'}>
                    {taskStatusLabel(parent.status)}
                  </StatusBadge>
                </Flex>
                <div className="tf-split-task-title">{parent.title}</div>
                <Flex justify="space-between" align="center" gap={8} wrap>
                  <ChainStatusDots statuses={statuses} size="small" />
                  {bottleneck && bottleneckMeta ? (
                    <span className={`tf-split-bottleneck tone-${bottleneckMeta.tone}`}>
                      卡在 {bottleneck.index}.{CHAIN_STAGE_SHORT[bottleneck.stage]}
                    </span>
                  ) : statuses ? (
                    <span className="tf-split-bottleneck tone-done">6 环全过</span>
                  ) : null}
                </Flex>
              </button>

              {!!parent.subtasks?.length && (
                <div className="tf-split-subtasks">
                  {parent.subtasks.map(child => {
                    const childSelected = activeTask?.id === child.id;
                    return (
                      <button
                        key={child.id}
                        type="button"
                        className={`tf-split-subtask-item${childSelected ? ' is-selected' : ''}`}
                        onClick={() => onSelectTask(child.id)}
                      >
                        <CornerDownRight size={12} className="tf-split-subtask-icon" aria-hidden="true" />
                        <Text className="tf-task-key">{child.jiraKey}</Text>
                        <span className="tf-split-subtask-title">{child.title}</span>
                        <StatusBadge variant={child.status === 'DONE' ? 'green' : child.status === 'IN_PROGRESS' || child.status === 'IN_REVIEW' ? 'blue' : 'neutral'}>
                          {taskStatusLabel(child.status)}
                        </StatusBadge>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="tf-tasks-split-detail">
        {activeTask ? (
          <React.Suspense fallback={<Card><Skeleton active paragraph={{ rows: 8 }} /></Card>}>
            <WorkTaskDetail
              embedded
              key={activeTask.id}
              taskId={activeTask.id}
              focusStage={activeStage}
              onFocusStageChange={onSelectStage}
              user={user}
              role={role}
              permissions={permissions}
              members={members}
              tasks={projectTasks}
              allTasks={allTasks}
              onOpenFullScreen={() => onOpenFullTask(activeTask.id)}
              onOpenTask={targetId => {
                if (!targetId) onSelectTask('');
                else if (projectTaskIdSet.has(targetId)) onSelectTask(targetId);
                else onOpenFullTask(targetId);
              }}
              onChanged={onChanged}
              onUnauthorized={onUnauthorized}
              onForbidden={onForbidden}
            />
          </React.Suspense>
        ) : (
          <Card>
            <Empty description="请在左侧选择一个需求或研发任务查看其 6 环交付链路">
              <Button icon={<ArrowUpRight size={14} />} onClick={() => tree[0] && onSelectTask(tree[0].id)}>查看首项任务</Button>
            </Empty>
          </Card>
        )}
      </div>
    </div>
  );
};

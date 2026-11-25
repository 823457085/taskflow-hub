import React, { useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Checkbox, Flex, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { api, ApiError, isLocalTaskKey, type Asset, type LocalAiRun, type LocalAutomationCapabilities, type User, type WorkTask } from './workspaceApi';
import { TASK_TYPE_OPTIONS } from './displayLabels';
import { AiRunIdentity, availableAiEngine, LocalAiExecutionFields, readAiEngine, useAiModelSelection } from './LocalAiExecutionFields';
import {
  allocateNextJiraKeys,
  buildStandardDeliverySubtasks,
  extractSubtaskCandidatesFromSpecs,
  type SubtaskCandidate,
} from './subtaskDecomposer';

interface DraftSubtaskRow {
  rowId: string;
  enabled: boolean;
  jiraKey: string;
  title: string;
  type: WorkTask['type'];
  assigneeId: string;
  source: SubtaskCandidate['source'] | 'AI_DRAFT';
  estimateDays?: number;
  covers?: string[];
  after?: string[];
  created?: boolean;
}

const VALID_JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;

const SOURCE_LABELS: Record<DraftSubtaskRow['source'], string> = {
  TECH_SPEC: '方案提取',
  PRD: 'PRD 提取',
  JIRA: 'Jira 描述',
  STANDARD: '研发模板',
  AI_DRAFT: 'AI 拆解',
  CUSTOM: '自定义',
};

export const SubtaskDecomposeModal: React.FC<{
  open: boolean;
  onClose: () => void;
  parentTask: WorkTask;
  assets: Asset[];
  existingTasks: WorkTask[];
  members: User[];
  currentUser: User;
  canAssign: boolean;
  onCreated: () => Promise<void>;
}> = ({ open, onClose, parentTask, assets, existingTasks, members, currentUser, canAssign, onCreated }) => {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<DraftSubtaskRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [capabilities, setCapabilities] = useState<LocalAutomationCapabilities | null>(null);
  const [engine, setEngine] = useState(readAiEngine);
  const executionRunner = capabilities?.deployment === 'server' ? 'bridge' : 'local';
  const model = useAiModelSelection(capabilities, engine, executionRunner);
  const [aiRun, setAiRun] = useState<LocalAiRun | null>(null);
  const [startingAi, setStartingAi] = useState(false);
  const [aiRationale, setAiRationale] = useState('');

  const localParent = isLocalTaskKey(parentTask.jiraKey);
  const defaultAssignee = canAssign
    ? (parentTask.assigneeId && members.some(m => m.id === parentTask.assigneeId) ? parentTask.assigneeId : currentUser.id)
    : currentUser.id;

  const toDraftRows = (candidates: SubtaskCandidate[]): DraftSubtaskRow[] =>
    candidates.map((c, idx) => ({
      rowId: `sub-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      enabled: true,
      jiraKey: c.jiraKey,
      title: c.title,
      type: c.type,
      assigneeId: defaultAssignee,
      source: c.source,
    }));

  useEffect(() => {
    if (!open) return;
    setAiRationale('');
    const specCandidates = extractSubtaskCandidatesFromSpecs({
      parentTask,
      assets,
      existingTasks,
    });
    if (specCandidates.length > 0) {
      setRows(toDraftRows(specCandidates));
    } else {
      setRows(toDraftRows(buildStandardDeliverySubtasks(parentTask, existingTasks)));
    }
  }, [open, parentTask.id]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void api<LocalAutomationCapabilities>('local-automation/capabilities').then(result => {
      if (!current) return;
      setCapabilities(result);
      setEngine(preferred => availableAiEngine(result, preferred));
    }).catch(() => {});
    return () => { current = false; };
  }, [open]);

  useEffect(() => {
    if (!open || !aiRun || aiRun.status !== 'RUNNING') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(aiRun.id)}`)
        .then(res => {
          setAiRun(res.run);
          if (res.run.status === 'SUCCEEDED' && res.run.draft?.subtasks?.length) {
            const list = res.run.draft.subtasks;
            const keys = localParent ? list.map(() => '') : allocateNextJiraKeys(parentTask.jiraKey, existingTasks.map(t => t.jiraKey), list.length);
            setRows(list.map((item, idx) => ({
              rowId: `ai-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
              enabled: true,
              jiraKey: keys[idx] || '',
              title: item.roleHint && !item.title.includes(item.roleHint) ? `[${item.roleHint}] ${item.title}`.slice(0, 200) : item.title,
              type: item.type || 'TASK',
              assigneeId: defaultAssignee,
              source: 'AI_DRAFT',
              estimateDays: item.estimateDays,
              covers: item.covers,
              after: item.after,
            })));
            setAiRationale(res.run.draft.rationale || '');
            void message.success(`AI 已基于 PRD/技术方案生成 ${list.length} 条建议子任务（支持工期与依赖核对）。`);
          } else if (res.run.status === 'FAILED') {
            void message.error(res.run.error || 'AI 拆解未产出有效结构化草案。');
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [open, aiRun?.id, aiRun?.status]);

  const startAiSubtaskDraft = async () => {
    if (startingAi || aiRun?.status === 'RUNNING' || submitting || model.invalid) return;
    setStartingAi(true);
    try {
      const res = await api<{ run: LocalAiRun }>(`tasks/${encodeURIComponent(parentTask.id)}/ai-runs`, {
        mode: 'read',
        actionType: 'SUBTASK_DRAFT',
        engine,
        ...(model.model ? { model: model.model } : {}),
      });
      setAiRun(res.run);
      void message.info('正在调用本机 AI 阅读 PRD 与技术方案生成子任务草案…');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '启动 AI 智能拆解失败。');
    } finally {
      setStartingAi(false);
    }
  };

  const stopAiDraftRun = async () => {
    if (!aiRun) return;
    try {
      const res = await api<{ run: LocalAiRun }>(`ai-runs/${encodeURIComponent(aiRun.id)}/stop`, {});
      setAiRun(res.run);
    } catch { /* ignore */ }
  };

  const applySpecExtraction = () => {
    const specCandidates = extractSubtaskCandidatesFromSpecs({
      parentTask,
      assets,
      existingTasks,
    });
    if (!specCandidates.length) {
      void message.info('当前 PRD / 技术方案中未识别到待拆解条目，已保持现有列表。');
      return;
    }
    setRows(toDraftRows(specCandidates));
    void message.success(`已从材料中提取 ${specCandidates.length} 个候选子任务。`);
  };

  const applyStandardTemplates = () => {
    const std = buildStandardDeliverySubtasks(parentTask, existingTasks);
    setRows(toDraftRows(std));
  };

  const addCustomRow = () => {
    const usedKeys = [
      ...existingTasks.map(t => t.jiraKey),
      ...rows.map(r => r.jiraKey),
    ];
    const [nextKey] = allocateNextJiraKeys(parentTask.jiraKey, usedKeys, 1);
    setRows(prev => [
      ...prev,
      {
        rowId: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        enabled: true,
        jiraKey: localParent ? '' : nextKey || `${parentTask.jiraKey.split('-')[0] || 'TASK'}-101`,
        title: '',
        type: 'TASK',
        assigneeId: defaultAssignee,
        source: 'CUSTOM',
      },
    ]);
  };

  const updateRow = (rowId: string, patch: Partial<DraftSubtaskRow>) => {
    setRows(prev => prev.map(r => (r.rowId === rowId ? { ...r, ...patch } : r)));
  };

  const removeRow = (rowId: string) => {
    setRows(prev => prev.filter(r => r.rowId !== rowId));
  };

  const existingKeySet = new Set(existingTasks.map(t => t.jiraKey.toUpperCase()));
  const activeRows = rows.filter(r => r.enabled && !r.created);
  const parentPrefix = !localParent && parentTask.jiraKey.includes('-') ? `${parentTask.jiraKey.split('-')[0].toUpperCase()}-` : '';

  const validateActiveRows = (): string | null => {
    if (!activeRows.length) return '请至少勾选一项待创建的子任务。';
    const seenBatchKeys = new Set<string>();
    for (const row of activeRows) {
      const key = row.jiraKey.trim().toUpperCase();
      const title = row.title.trim();
      if (!title) return key ? `请填写子任务「${key}」的标题。` : '请填写子任务标题。';
      if (!key) continue;
      if (!VALID_JIRA_KEY_RE.test(key)) {
        return `子任务号「${row.jiraKey || '空'}」格式不正确（示例：${parentPrefix || 'TASK-'}101）。`;
      }
      if (parentTask.externalRef?.project?.key && !key.startsWith(`${parentTask.externalRef.project.key.toUpperCase()}-`)) {
        return `子任务号「${key}」需使用项目前缀 ${parentTask.externalRef.project.key.toUpperCase()}-。`;
      }
      if (existingKeySet.has(key)) {
        return `子任务号「${key}」已在工作台中存在，请调整编号。`;
      }
      if (seenBatchKeys.has(key)) {
        return `批次内存在重复的子任务号「${key}」。`;
      }
      seenBatchKeys.add(key);
    }
    return null;
  };

  const submitBatch = async () => {
    const validationError = validateActiveRows();
    if (validationError) {
      void message.warning(validationError);
      return;
    }
    setSubmitting(true);
    let createdCount = 0;
    try {
      for (const row of activeRows) {
        const jiraKey = row.jiraKey.trim().toUpperCase();
        const { task } = await api<{ task: WorkTask }>('tasks', {
          projectId: parentTask.projectId,
          parentId: parentTask.id,
          ...(jiraKey ? { jiraKey } : {}),
          title: row.title.trim().slice(0, 200),
          type: row.type,
          assigneeId: canAssign ? (row.assigneeId || null) : currentUser.id,
        });
        createdCount += 1;
        updateRow(row.rowId, { jiraKey: task.jiraKey, created: true, enabled: false });
      }
      await onCreated();
      void message.success(`已为 ${parentTask.jiraKey} 批量创建 ${createdCount} 个子任务！`);
      onClose();
    } catch (error) {
      if (createdCount > 0) {
        await onCreated().catch(() => {});
      }
      const errMsg = error instanceof ApiError || error instanceof Error ? error.message : '创建子任务失败。';
      void message.error(createdCount > 0 ? `已创建 ${createdCount} 项，后续项失败：${errMsg}` : errMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const assigneeOptions = canAssign
    ? [{ value: '', label: '未指派' }, ...members.map(m => ({ value: m.id, label: m.username }))]
    : [{ value: currentUser.id, label: `${currentUser.username}（本人）` }];

  return (
    <Modal
      title={
        <Space size={8}>
          <Sparkles size={16} />
          <span>智能拆解与批量创建子任务 · {parentTask.jiraKey}</span>
        </Space>
      }
      open={open}
      onCancel={() => { if (!submitting) onClose(); }}
      width={780}
      okText={`一键创建子任务 (${activeRows.length} 项)`}
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: activeRows.length === 0 }}
      onOk={() => void submitBatch()}
    >
      <Flex vertical gap={12}>
        <Alert
          type="info"
          showIcon
          title="支持从最新 PRD / 技术方案自动提取实施条目（自动跳过「背景」「非目标」等非交付段落），仅在本地工作台建立父子研发跟踪，不会向外部 Jira 写回事项。"
        />
        <LocalAiExecutionFields size="small" capabilities={capabilities} engine={engine} onEngineChange={setEngine}
          model={model} runner={executionRunner} disabled={startingAi || aiRun?.status === 'RUNNING' || submitting} />
        <Flex justify="space-between" align="center" wrap gap={8}>
          <Space size={8} wrap>
            {aiRun?.status === 'RUNNING' ? (
              <Button size="small" danger icon={<Square size={13} />} onClick={() => void stopAiDraftRun()}>
                停止 AI 拆解
              </Button>
            ) : (
              <Button size="small" type="primary" ghost icon={<Sparkles size={13} />} loading={startingAi} disabled={submitting || model.invalid} onClick={() => void startAiSubtaskDraft()}>
                AI 智能拆解 PRD/方案
              </Button>
            )}
            <Button size="small" icon={<Sparkles size={13} />} disabled={submitting} onClick={applySpecExtraction}>
              从 PRD / 技术方案提取
            </Button>
            <Button size="small" disabled={submitting} onClick={applyStandardTemplates}>
              套用四步标准研发模板
            </Button>
            <Button size="small" icon={<Plus size={13} />} disabled={submitting} onClick={addCustomRow}>
              新增一行
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已选 {activeRows.length} / {rows.length} 项
          </Typography.Text>
        </Flex>
        {aiRun && <AiRunIdentity run={aiRun} />}
        {aiRationale && <Alert type="success" showIcon title={aiRationale} />}

        <div style={{ display: 'grid', gap: 8, maxHeight: 380, overflowY: 'auto', paddingRight: 2 }}>
          {rows.map(row => (
            <div
              key={row.rowId}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 120px minmax(180px, 1fr) 96px 120px 28px',
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                background: 'var(--tf-raised)',
                border: '1px solid var(--tf-border)',
                borderRadius: 8,
                opacity: row.created ? 0.55 : 1,
              }}
            >
              <Checkbox
                checked={row.enabled}
                disabled={submitting || row.created}
                aria-label={`勾选子任务 ${row.jiraKey || row.title}`}
                onChange={e => updateRow(row.rowId, { enabled: e.target.checked })}
              />
              <Input
                size="small"
                value={row.jiraKey}
                disabled={submitting || row.created}
                aria-label="Jira 任务号（可选）"
                placeholder="留空自动编号"
                maxLength={48}
                onChange={e => updateRow(row.rowId, { jiraKey: e.target.value.toUpperCase() })}
              />
              <Flex vertical gap={4} style={{ minWidth: 0 }}>
                <Input
                  size="small"
                  value={row.title}
                  disabled={submitting || row.created}
                  aria-label="子任务标题"
                  placeholder="输入具体可交付的子任务标题"
                  maxLength={200}
                  suffix={
                    <Tag color={row.created ? 'success' : row.source === 'AI_DRAFT' ? 'geekblue' : 'default'} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {row.created ? '已创建' : SOURCE_LABELS[row.source]}
                    </Tag>
                  }
                  onChange={e => updateRow(row.rowId, { title: e.target.value })}
                />
                {(typeof row.estimateDays === 'number' || !!row.covers?.length || !!row.after?.length) && (
                  <Space size={4} wrap>
                    {typeof row.estimateDays === 'number' && (
                      <Tag color={row.estimateDays > 3 ? 'warning' : 'default'} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                        约 {row.estimateDays}d{row.estimateDays > 3 ? '（超3天建议再拆）' : ''}
                      </Tag>
                    )}
                    {row.covers?.map(c => <Tag key={c} color="blue" style={{ marginInlineEnd: 0, fontSize: 11 }}>{c}</Tag>)}
                    {!!row.after?.length && <Typography.Text type="secondary" style={{ fontSize: 11 }}>依赖：{row.after.join('、')}</Typography.Text>}
                  </Space>
                )}
              </Flex>
              <Select<WorkTask['type']>
                size="small"
                value={row.type}
                disabled={submitting || row.created}
                options={TASK_TYPE_OPTIONS}
                onChange={val => updateRow(row.rowId, { type: val })}
              />
              <Select<string>
                size="small"
                value={row.assigneeId}
                disabled={submitting || row.created || !canAssign}
                options={assigneeOptions}
                onChange={val => updateRow(row.rowId, { assigneeId: val })}
              />
              <Button
                type="text"
                danger
                size="small"
                icon={<Trash2 size={14} />}
                disabled={submitting || row.created}
                aria-label={`移除候选行 ${row.jiraKey}`}
                onClick={() => removeRow(row.rowId)}
              />
            </div>
          ))}
        </div>
      </Flex>
    </Modal>
  );
};

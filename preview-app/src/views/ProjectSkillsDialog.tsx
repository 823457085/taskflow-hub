import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Empty, Flex, Input, Modal, Segmented, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Search } from 'lucide-react';
import { api, ApiError } from './workspaceApi';
import type { Project, TeamSkillItem } from './workspaceApi';
import { navigateWorkspace } from './workspaceNavigation';

type SkillSummary = Pick<TeamSkillItem, 'id' | 'projectId' | 'name' | 'title' | 'description' | 'visibility' | 'enabled' | 'version'>;
type LinkedSkill = SkillSummary & { canUnlink: boolean };
type ProjectSkills = {
  skills: LinkedSkill[];
  available: SkillSummary[];
};
type SkillRow = SkillSummary & { linked: boolean; canUnlink?: boolean };
type SkillFilter = 'all' | 'available' | 'linked';

const skillVisibility = (skill: SkillSummary) => skill.visibility === 'PERSONAL' ? '个人' : '项目共享';
const skillLabel = (skill: SkillSummary) => skill.title || skill.name;
const skillIdentity = (skill: SkillSummary) => `${skill.visibility}:${skill.name}`;
const MAX_BATCH_SIZE = 100;
const PAGE_SIZE = 7;

export function ProjectSkillsDialog({ project, onClose, onUnauthorized }: {
  project: Project;
  onClose: () => void;
  onUnauthorized?: () => void;
}) {
  const { message } = App.useApp();
  const path = `projects/${encodeURIComponent(project.id)}/skills`;
  const [data, setData] = useState<ProjectSkills>();
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [page, setPage] = useState(1);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const loadSequence = useRef(0);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const showError = useCallback((error: unknown) => {
    if (!mounted.current) return;
    if (error instanceof ApiError && error.status === 401) unauthorized.current?.();
    if (error instanceof Error) void message.error(error.message);
  }, [message]);

  const load = useCallback(async () => {
    const request = ++loadSequence.current;
    const isCurrent = () => mounted.current && request === loadSequence.current;
    setLoading(true);
    setData(undefined);
    try {
      const result = await api<ProjectSkills>(path);
      if (isCurrent()) {
        setData(result);
        const availableIds = new Set(result.available.map(skill => skill.id));
        setSelectedIds(ids => ids.filter(id => availableIds.has(id)));
      }
    } catch (error) {
      if (isCurrent()) showError(error);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [path, showError]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const saveLinks = async (unlinkId?: string) => {
    if (submitting.current || loading || (!unlinkId && !selectedIds.length)) return;
    submitting.current = true;
    setPendingId(unlinkId || 'batch');
    try {
      if (unlinkId) {
        await api(`${path}/${encodeURIComponent(unlinkId)}`, undefined, 'DELETE');
        if (!mounted.current) return;
        void message.success('Skill 已解除关联。');
        await load();
      } else {
        const updated = await api<ProjectSkills & { linkedCount: number }>(path, { skillIds: selectedIds });
        if (!mounted.current) return;
        setData(updated);
        setSelectedIds([]);
        void message.success(updated.linkedCount ? `已关联 ${updated.linkedCount} 项 Skill。` : '所选 Skills 已关联。');
      }
    } catch (error) {
      showError(error);
      if (mounted.current && error instanceof ApiError && [403, 404, 409].includes(error.status)) await load();
    } finally {
      submitting.current = false;
      if (mounted.current) setPendingId('');
    }
  };

  const search = query.trim().toLowerCase();
  const availableById = new Map(data?.available.map(skill => [skill.id, skillIdentity(skill)]));
  const identityCounts = new Map<string, number>();
  for (const identity of availableById.values()) {
    identityCounts.set(identity, (identityCounts.get(identity) || 0) + 1);
  }
  const selectedByIdentity = new Map(selectedIds.map(id => [availableById.get(id), id]));
  const rows: SkillRow[] = [
    ...(filter === 'linked' ? [] : (data?.available || []).map(skill => ({ ...skill, linked: false }))),
    ...(filter === 'available' ? [] : (data?.skills || []).map(skill => ({ ...skill, linked: true }))),
  ].filter(skill => [skillLabel(skill), skill.name, skill.description].some(value => value.toLowerCase().includes(search)));
  const columns: TableColumnsType<SkillRow> = [
    { title: 'Skill', render: (_, skill) => <Flex vertical gap={2}>
      <Typography.Text strong>{skillLabel(skill)}</Typography.Text>
      {skill.title && skill.title !== skill.name && <Typography.Text type="secondary">{skill.name}</Typography.Text>}
      {!skill.linked && (identityCounts.get(skillIdentity(skill)) || 0) > 1 &&
        <Typography.Text type="secondary">{skill.projectId ? '来自项目' : '来自 Skills 库'} · v{skill.version}</Typography.Text>}
      {skill.description && <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, tooltip: skill.description }} style={{ margin: 0 }}>
        {skill.description}
      </Typography.Paragraph>}
    </Flex> },
    { title: '范围', width: 100, render: (_, skill) => skillVisibility(skill) },
    { title: '状态', width: 110, render: (_, skill) => <Flex vertical gap={4} align="start">
      <Tag color={skill.linked ? 'success' : undefined}>{skill.linked ? '已关联' : '可关联'}</Tag>
      {!skill.enabled && <Tag>已停用</Tag>}
    </Flex> },
    { title: '操作', width: 104, render: (_, skill) => skill.canUnlink
      ? <Button type="link" size="small" disabled={!!pendingId} loading={pendingId === skill.id}
        aria-label={`解除关联 ${skillLabel(skill)}`} onClick={() => void saveLinks(skill.id)}>解除关联</Button>
      : null },
  ];

  return <Modal
    title={`${project.name} · Skills`}
    open
    width={780}
    loading={loading}
    onCancel={onClose}
    maskClosable={!pendingId}
    keyboard={!pendingId}
    closable={!pendingId}
    footer={<Flex justify="space-between" align="center" gap={8} wrap>
      <Button type="link" disabled={!selectedIds.length || !!pendingId} onClick={() => setSelectedIds([])}>清空已选</Button>
      <Flex gap={8} wrap>
        <Button disabled={!!pendingId} onClick={onClose}>关闭</Button>
        <Button type="primary" loading={pendingId === 'batch'} onClick={() => void saveLinks()}
          disabled={loading || !data || !selectedIds.length || !!pendingId}>关联所选（{selectedIds.length}）</Button>
      </Flex>
    </Flex>}
  >
    {data ? <Flex vertical gap={12}>
      <Flex gap={8} wrap align="center" justify="space-between">
        <Input aria-label="搜索项目 Skills" prefix={<Search size={14} />} placeholder="搜索 Skill 标题、标识或用途" allowClear value={query}
          style={{ flex: '1 1 240px', minWidth: 0 }} onChange={event => { setQuery(event.target.value); setPage(1); }} />
        <Button type="link" disabled={!!pendingId} onClick={() => { onClose(); navigateWorkspace('skills'); }}>打开 Skills 库</Button>
      </Flex>
      <Segmented<SkillFilter> aria-label="按关联状态筛选" value={filter} onChange={value => { setFilter(value); setPage(1); }} options={[
        { value: 'all', label: `全部（${data.available.length + data.skills.length}）` },
        { value: 'available', label: `可关联（${data.available.length}）` },
        { value: 'linked', label: `已关联（${data.skills.length}）` },
      ]} />
      <Table<SkillRow>
        size="small"
        aria-label="项目 Skills 清单"
        dataSource={rows}
        columns={columns}
        rowKey="id"
        scroll={{ x: 520 }}
        pagination={{ current: Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE))), pageSize: PAGE_SIZE,
          size: 'small', hideOnSinglePage: true, showSizeChanger: false, onChange: setPage }}
        rowSelection={filter === 'linked' ? undefined : {
          selectedRowKeys: selectedIds, preserveSelectedRowKeys: true,
          onChange: keys => {
            const requested = new Set(keys.map(String));
            const unique = new Map<string, string>();
            for (const id of [...selectedIds, ...requested]) {
              const identity = availableById.get(id);
              if (requested.has(id) && identity && !unique.has(identity)) unique.set(identity, id);
            }
            if (unique.size > MAX_BATCH_SIZE) { void message.warning(`每次最多关联 ${MAX_BATCH_SIZE} 项 Skill。`); return; }
            setSelectedIds([...unique.values()]);
          },
          getCheckboxProps: skill => {
            const selected = selectedByIdentity.get(skillIdentity(skill));
            const conflicts = !!selected && selected !== skill.id;
            return {
              disabled: skill.linked || !!pendingId || conflicts,
              title: conflicts ? '同一标识的同类 Skill 只能选一个' : undefined,
              'aria-label': `选择 ${skillLabel(skill)}`,
            };
          },
        }}
        locale={{ emptyText: <Empty description={search ? '没有匹配的 Skills' : filter === 'linked' ? '此项目暂无已关联的 Skills' : '暂无可关联的 Skills'}
          image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      />
    </Flex> : !loading && <Empty description="项目 Skills 加载失败" image={Empty.PRESENTED_IMAGE_SIMPLE}>
      <Button onClick={() => void load()}>重试</Button>
    </Empty>}
  </Modal>;
}

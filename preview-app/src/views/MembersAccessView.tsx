import React, { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Empty, Flex, Form, Grid, Input, List, Popconfirm, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Download, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiError, MemberCandidate, Project, ProjectMember, ProjectPermissions, REVIEW_STAGE_OPTIONS, Role, ROLES, RuleEnforcement, Stage, timeText, User, WorkTask } from './workspaceApi';
import { StatusBadge } from '../components/Primitives';
import { pluginStatusLabel, roleLabel, stageLabel } from './displayLabels';
import { clearSearchOnEscape, isSubmitShortcut } from './uiPreferences';
import { openTaskRoute } from './workspaceNavigation';
import { ResetPasswordDrawer } from './PasswordDrawers';
import {
  AUDIT_CATEGORY_OPTIONS,
  describeAuditAction,
  exportAuditRecordsCsv,
  exportAuditRecordsJsonl,
  filterAuditRecords,
  type AuditCategory,
  type AuditRecord,
} from './auditLogUtils';
import {
  buildScopedPluginId,
  isPresetInstalled,
  POLICY_PLUGIN_PRESETS,
  type PolicyPlugin,
  type PolicyPluginPreset,
} from './policyPluginPresets';

const choices = (roles: string[]) => roles.map(value => ({ value, label: roleLabel(value) }));
export const MembersAccessView: React.FC<{
  projectId: string; projectKey?: string; user: User; role: Role; members: ProjectMember[]; users: User[]; tasks?: WorkTask[];
  permissions: ProjectPermissions; candidates: MemberCandidate[]; canManageUsers: boolean;
  onChanged: () => Promise<void>; onUnauthorized: () => void; onForbidden?: () => void;
}> = ({ projectId, projectKey, user, role, members, users, tasks = [], permissions, candidates, canManageUsers, onChanged, onUnauthorized, onForbidden }) => {
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [form] = Form.useForm<{ userId: string; role: Role }>();
  const [newMemberForm] = Form.useForm<{ username: string; password: string; role: Role }>();
  const [pluginForm] = Form.useForm<{ id: string; name: string; version: string; stages: Stage[]; enforcement: RuleEnforcement; rule?: string; evaluator?: string; ruleType?: 'regex_forbidden' | 'regex_required' | 'openapi_lint'; rulePattern?: string }>();
  const [open, setOpen] = useState(false);
  const [newMemberOpen, setNewMemberOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ id: string; username: string } | null>(null);
  const [pluginDrawerOpen, setPluginDrawerOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [plugins, setPlugins] = useState<PolicyPlugin[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [installingPluginId, setInstallingPluginId] = useState('');
  const [auditRecords, setAuditRecords] = useState<AuditRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditCategory, setAuditCategory] = useState<AuditCategory>('all');
  const [auditQuery, setAuditQuery] = useState('');
  const auditSeq = useRef(0);
  const pluginSeq = useRef(0);
  const alive = useRef(true);
  const accessLost = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const canManage = permissions.manageMembers && !accessDenied;
  const canCreateUsers = user.role === 'ADMIN' && canManageUsers && !accessDenied;
  const canRegisterPlugins = permissions.registerPlugins && !accessDenied;
  const availableCandidates = candidates.filter(candidate => !members.some(member => member.id === candidate.id));
  const capabilityKey = JSON.stringify([projectId, user.id, user.role, role, permissions, canManageUsers]);
  const closeForms = () => {
    setOpen(false); setNewMemberOpen(false); setPluginDrawerOpen(false); setResetTarget(null);
    form.resetFields(); newMemberForm.resetFields(); pluginForm.resetFields();
  };
  const invalidate = () => { sequence.current += 1; pending.current = false; setBusy(false); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current += 1; };
  }, []);
  useEffect(() => { invalidate(); closeForms(); setMemberSearch(''); accessLost.current = false; setAccessDenied(false); }, [capabilityKey]);
  useEffect(() => {
    if (!open) return;
    const userId = form.getFieldValue('userId');
    const selectedRole = form.getFieldValue('role');
    if (!permissions.manageMembers || !permissions.grantRoles.length || selectedRole && !permissions.grantRoles.includes(selectedRole) || userId && !availableCandidates.some(candidate => candidate.id === userId)) {
      invalidate(); setOpen(false); form.resetFields();
    }
  }, [open, members, candidates, capabilityKey]);
  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (!alive.current || accessLost.current || pending.current) return;
    const request = ++sequence.current;
    const isCurrent = () => alive.current && !accessLost.current && request === sequence.current;
    pending.current = true; setBusy(true);
    try { await action(isCurrent); }
    catch (error) {
      if (!isCurrent()) return;
      void message.error(error instanceof Error ? error.message : '请求失败。');
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        accessLost.current = true; invalidate(); closeForms(); setAccessDenied(true);
        if (error.status === 401) onUnauthorized(); else onForbidden?.();
      }
    } finally { if (isCurrent()) { pending.current = false; setBusy(false); } }
  };
  const saveMembership = (values: { userId: string; role: Role }) => {
    if (!canManage || !permissions.grantRoles.includes(values.role) || !availableCandidates.some(candidate => candidate.id === values.userId)) return;
    void run(async isCurrent => {
      await api('projects/' + projectId + '/members', values);
      if (!isCurrent()) return;
      setOpen(false); form.resetFields(); void message.success('项目成员已保存。');
      await onChanged();
    });
  };
  const createUser = (values: { username: string; password: string; role: Role }) => {
    if (!canCreateUsers) return;
    void run(async isCurrent => {
      await api('users', { ...values, projectId });
      if (!isCurrent()) return;
      newMemberForm.resetFields(); setNewMemberOpen(false); void message.success('平台成员已创建。');
      await onChanged();
    });
  };
  const switchMemberRoleInline = (member: ProjectMember, nextRole: Role) => {
    if (!canManage || !member.canEditRole || nextRole === member.role || !permissions.grantRoles.includes(nextRole)) return;
    void run(async isCurrent => {
      await api('projects/' + projectId + '/members', { userId: member.id, role: nextRole });
      if (!isCurrent()) return;
      void message.success(`已将「${member.username}」的项目角色更新为「${roleLabel(nextRole)}」。`);
      await onChanged();
    });
  };
  const renderMemberRoleControl = (member: ProjectMember) => {
    if (canManage && member.canEditRole && permissions.grantRoles.length > 0) {
      const roleOptions = [...new Set([member.role, ...permissions.grantRoles])].map(value => ({
        value,
        label: roleLabel(value),
        disabled: !permissions.grantRoles.includes(value),
      }));
      return (
        <Select<Role>
          size="small"
          aria-label={`修改 ${member.username} 项目角色`}
          value={member.role}
          disabled={busy}
          options={roleOptions}
          onChange={val => switchMemberRoleInline(member, val)}
          style={{ width: 136 }}
        />
      );
    }
    return <StatusBadge variant="neutral">{roleLabel(member.role)}</StatusBadge>;
  };
  const closeMembership = () => { setOpen(false); form.resetFields(); };
  const closeNewMember = () => { setNewMemberOpen(false); newMemberForm.resetFields(); };
  const resetPasswordAction = (member: User) => member.id === user.id
    ? <Tooltip title="请在顶部“修改密码”修改自己的密码"><Typography.Text type="secondary">当前账号</Typography.Text></Tooltip>
    : <Button type="link" disabled={busy} onClick={() => setResetTarget({ id: member.id, username: member.username })}>重置密码</Button>;
  const closePluginDrawer = () => { setPluginDrawerOpen(false); pluginForm.resetFields(); };
  const loadPlugins = useCallback(async () => {
    const seq = ++pluginSeq.current;
    if (!projectId || accessDenied) {
      setPlugins([]);
      setPluginsLoading(false);
      return;
    }
    setPluginsLoading(true);
    try {
      const res = await api<{ plugins: PolicyPlugin[] }>('plugins?projectId=' + encodeURIComponent(projectId));
      if (!alive.current || accessLost.current || seq !== pluginSeq.current) return;
      setPlugins(Array.isArray(res.plugins) ? res.plugins : []);
    } catch (error) {
      if (!alive.current || accessLost.current || seq !== pluginSeq.current) return;
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();
      } else {
        setPlugins([]);
      }
    } finally {
      if (alive.current && seq === pluginSeq.current) setPluginsLoading(false);
    }
  }, [projectId, accessDenied, onUnauthorized]);

  const loadAudit = useCallback(async () => {
    const seq = ++auditSeq.current;
    if (!projectId || !permissions.viewAudit || accessDenied) {
      setAuditRecords([]);
      setAuditLoading(false);
      return;
    }
    setAuditLoading(true);
    try {
      const res = await api<{ audit: AuditRecord[] }>('audit?projectId=' + encodeURIComponent(projectId));
      if (!alive.current || accessLost.current || seq !== auditSeq.current) return;
      setAuditRecords(Array.isArray(res.audit) ? res.audit : []);
    } catch (error) {
      if (!alive.current || accessLost.current || seq !== auditSeq.current) return;
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();
      } else if (error instanceof ApiError && error.status === 403) {
        setAuditRecords([]);
      }
    } finally {
      if (alive.current && seq === auditSeq.current) setAuditLoading(false);
    }
  }, [projectId, permissions.viewAudit, accessDenied, onUnauthorized]);

  useEffect(() => {
    setAuditCategory('all');
    setAuditQuery('');
    void loadAudit();
    return () => { auditSeq.current += 1; };
  }, [loadAudit]);

  useEffect(() => {
    void loadPlugins();
    return () => { pluginSeq.current += 1; };
  }, [loadPlugins]);

  const installPresetPlugin = async (preset: PolicyPluginPreset) => {
    if (!canRegisterPlugins || busy || installingPluginId) return;
    const scopedId = buildScopedPluginId(preset.baseId, projectId, projectKey);
    setInstallingPluginId(preset.baseId);
    try {
      await api('plugins', {
        projectId,
        id: scopedId,
        name: preset.name,
        version: preset.version,
        stages: preset.stages,
        enforcement: preset.enforcement,
        evaluator: preset.evaluator,
        rule: preset.description,
      });
      if (!alive.current || accessLost.current) return;
      void message.success(`已启用项目门禁规则「${preset.name}」！`);
      await Promise.all([loadPlugins(), loadAudit()]);
    } catch (error) {
      if (!alive.current || accessLost.current) return;
      if (error instanceof ApiError && error.status === 409) {
        void message.info('该策略规则已登记。');
        await loadPlugins();
      } else {
        void message.error(error instanceof Error ? error.message : '登记规则失败。');
      }
    } finally {
      if (alive.current) setInstallingPluginId('');
    }
  };

  const registerCustomPlugin = (values: { id: string; name: string; version: string; stages: Stage[]; enforcement?: RuleEnforcement; rule?: string; evaluator?: string; ruleType?: 'regex_forbidden' | 'regex_required' | 'openapi_lint'; rulePattern?: string }) => {
    if (!canRegisterPlugins) return;
    const declarativeRules = values.ruleType
      ? [{
        type: values.ruleType,
        ...(values.ruleType !== 'openapi_lint' ? { pattern: (values.rulePattern || '').trim() } : {}),
        severity: values.enforcement === 'BLOCK' ? 'CRITICAL' : 'WARN',
        title: values.name.trim(),
        detail: (values.rule || values.name).trim(),
      }]
      : undefined;
    void run(async isCurrent => {
      await api('plugins', {
        projectId,
        id: values.id.trim().toLowerCase(),
        name: values.name.trim(),
        version: values.version.trim(),
        stages: values.stages,
        enforcement: values.enforcement || 'WARN',
        ...(values.rule?.trim() ? { rule: values.rule.trim() } : {}),
        ...(values.evaluator ? { evaluator: values.evaluator } : {}),
        ...(declarativeRules ? { rules: declarativeRules } : {}),
      });
      if (!isCurrent()) return;
      closePluginDrawer();
      void message.success(`已登记门禁规则「${values.name.trim()}」。`);
      await Promise.all([loadPlugins(), loadAudit()]);
    });
  };

  const removePlugin = (pluginId: string) => {
    if (!canRegisterPlugins || busy) return;
    void run(async isCurrent => {
      await api('plugins/' + encodeURIComponent(pluginId), undefined, 'DELETE');
      if (!isCurrent()) return;
      void message.success('已移除该门禁规则。');
      await Promise.all([loadPlugins(), loadAudit()]);
    });
  };

  const userDirectory = new Map<string, string>();
  for (const u of users) userDirectory.set(u.id, u.username);
  for (const m of members) userDirectory.set(m.id, m.username);
  if (user) userDirectory.set(user.id, user.username);
  const resolveActorName = (actorId: string) => userDirectory.get(actorId) || actorId;

  const taskById = new Map(tasks.map(t => [t.id, t]));
  const taskByKey = new Map(tasks.map(t => [t.jiraKey, t]));
  const resolveTargetLabel = (rec: AuditRecord): string => {
    const tid = rec.targetId;
    if (!tid) return '—';
    const matchedTask = taskById.get(tid) || taskByKey.get(tid);
    if (matchedTask) return `${matchedTask.jiraKey} · ${matchedTask.title}`;
    const matchedUser = userDirectory.get(tid);
    if (matchedUser) return `成员 ${matchedUser}`;
    if (tid === projectId) return '当前项目';
    return tid;
  };

  const filteredAudit = filterAuditRecords(auditRecords, {
    category: auditCategory,
    query: auditQuery,
    resolveActorName,
    resolveTargetLabel,
  });

  const downloadAuditFile = (format: 'csv' | 'jsonl') => {
    if (!filteredAudit.length) return;
    const content = format === 'csv'
      ? exportAuditRecordsCsv(filteredAudit, { resolveActorName, resolveTargetLabel })
      : exportAuditRecordsJsonl(filteredAudit, { resolveActorName, resolveTargetLabel });
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `taskflow-audit-${projectId}-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    void message.success(`已导出 ${filteredAudit.length} 条合规审计记录 (${format.toUpperCase()})。`);
  };

  const renderAuditTarget = (rec: AuditRecord) => {
    const tid = rec.targetId;
    if (!tid) return <Typography.Text type="secondary">—</Typography.Text>;
    const matchedTask = taskById.get(tid) || taskByKey.get(tid);
    if (matchedTask) {
      return (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          onClick={() => openTaskRoute(matchedTask.id, { from: 'members' })}
        >
          {matchedTask.jiraKey} · {matchedTask.title}
        </Button>
      );
    }
    const matchedUser = userDirectory.get(tid);
    if (matchedUser) return <Typography.Text>{matchedUser}</Typography.Text>;
    if (tid === projectId) return <Typography.Text type="secondary">当前项目</Typography.Text>;
    return (
      <Tooltip title={tid}>
        <Typography.Text code style={{ fontSize: 12 }}>{tid.length > 14 ? `${tid.slice(0, 12)}…` : tid}</Typography.Text>
      </Tooltip>
    );
  };

  const auditColumns: TableColumnsType<AuditRecord> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 172,
      render: val => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{timeText(val)}</Typography.Text>,
    },
    {
      title: '操作人',
      dataIndex: 'actorId',
      width: 132,
      render: val => <Typography.Text strong>{resolveActorName(val)}</Typography.Text>,
    },
    {
      title: '事件类型',
      dataIndex: 'action',
      width: 190,
      render: val => {
        const meta = describeAuditAction(val);
        return <StatusBadge variant={meta.badgeVariant}>{meta.label}</StatusBadge>;
      },
    },
    {
      title: '关联对象',
      key: 'target',
      render: (_, rec) => renderAuditTarget(rec),
    },
  ];

  const visibleMembers = members.filter(member => !memberSearch.trim() || `${member.username} ${roleLabel(member.role)} ${member.role}`.toLowerCase().includes(memberSearch.trim().toLowerCase()));
  const columns: TableColumnsType<ProjectMember> = [
    { title: '成员', dataIndex: 'username' },
    { title: '项目角色', dataIndex: 'role', render: (_, member) => renderMemberRoleControl(member) },
  ];
  if (accessDenied) return null;
  return <Flex vertical gap={14} className="tf-members-workspace">
    <div className="tf-members-summary">
      <Card className="tf-members-card" title="项目成员" extra={canManage && <Button type="primary" icon={<Plus size={16} />} disabled={busy || !permissions.grantRoles.length || !availableCandidates.length} onClick={() => { form.resetFields(); form.setFieldsValue({ role: permissions.grantRoles.includes('DEV') ? 'DEV' : permissions.grantRoles[0] }); setOpen(true); }}>添加成员</Button>}>
        {members.length > 2 && (
          <div style={{ marginBottom: 12, maxWidth: 320 }}>
            <Input
              prefix={<Search size={15} />}
              aria-label="搜索项目成员"
              placeholder="搜索成员用户名或角色（按 Esc 清空）"
              value={memberSearch}
              allowClear
              onChange={event => setMemberSearch(event.target.value)}
              onKeyDown={clearSearchOnEscape(memberSearch, () => setMemberSearch(''))}
            />
          </div>
        )}
        {screens.md ? <Table rowKey="id" dataSource={visibleMembers} columns={columns} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }} locale={{ emptyText: members.length ? '没有符合条件的成员。' : '当前项目暂无成员。' }} /> : <List className="tf-members-mobile-list" rowKey="id" pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }} dataSource={visibleMembers} locale={{ emptyText: members.length ? '没有符合条件的成员。' : '当前项目暂无成员。' }} renderItem={member => <List.Item><List.Item.Meta title={member.username} description={renderMemberRoleControl(member)} /></List.Item>} />}
      </Card>
      <Card title="我的项目权限" size="small" className="tf-member-permissions">
        <Descriptions size="small" column={1} items={[
          { key: 'role', label: '项目角色', children: <StatusBadge variant="neutral">{roleLabel(role)}</StatusBadge> },
          { key: 'members', label: '成员管理', children: permissions.manageMembers ? '可管理' : '只读成员信息' },
          { key: 'tasks', label: '任务分配', children: permissions.assignTasks ? '可分配' : '不可分配' },
          { key: 'connections', label: '连接管理', children: permissions.manageConnections ? '可管理' : '不可管理' },
          { key: 'plugins', label: '插件登记', children: permissions.registerPlugins ? '可登记' : '不可登记' },
          { key: 'audit', label: '审计记录', children: permissions.viewAudit ? '可查看' : '不可查看' },
          ...(permissions.manageMembers ? [{ key: 'roles', label: '可授予角色', children: permissions.grantRoles.map(roleLabel).join(' · ') || '—' }] : []),
        ]} />
      </Card>
    </div>
    {canCreateUsers && <Card className="tf-members-card" title="平台成员" extra={<Button icon={<Plus size={16} />} disabled={busy} onClick={() => { newMemberForm.resetFields(); setNewMemberOpen(true); }}>创建平台成员</Button>}>
      {screens.md ? <Table rowKey="id" dataSource={users} columns={[{ title: '成员', dataIndex: 'username' }, { title: '平台角色', dataIndex: 'role', render: value => <StatusBadge variant="neutral">{roleLabel(value)}</StatusBadge> }, { title: '操作', key: 'actions', render: (_, member) => resetPasswordAction(member) }]} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }} /> : <List className="tf-members-mobile-list" rowKey="id" pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }} dataSource={users} renderItem={member => <List.Item extra={resetPasswordAction(member)}><List.Item.Meta title={member.username} description={<StatusBadge variant="neutral">{roleLabel(member.role)}</StatusBadge>} /></List.Item>} />}
    </Card>}
    <ResetPasswordDrawer target={canCreateUsers ? resetTarget : null} onClose={() => setResetTarget(null)} onUnauthorized={onUnauthorized} onForbidden={onForbidden} />
    <Card
      className="tf-members-card"
      title={
        <Space size={8} wrap>
          <ShieldCheck size={16} />
          <span>项目门禁规则</span>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            {plugins.length} 项已生效
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size={8} wrap>
          <Button size="small" icon={<RefreshCw size={14} />} loading={pluginsLoading} onClick={() => void loadPlugins()}>
            刷新
          </Button>
          {canRegisterPlugins && (
            <Button
              size="small"
              type="primary"
              icon={<Plus size={14} />}
              disabled={busy}
              onClick={() => {
                pluginForm.resetFields();
                pluginForm.setFieldsValue({ version: '1.0.0', stages: ['TECH_SPEC', 'CODE_REVIEW'], enforcement: 'WARN' });
                setPluginDrawerOpen(true);
              }}
            >
              自定义登记
            </Button>
          )}
        </Space>
      }
    >
      <Flex vertical gap={14}>
        <Table<PolicyPlugin>
          rowKey="id"
          dataSource={plugins}
          loading={pluginsLoading}
          size="small"
          pagination={false}
          columns={[
            {
              title: '规则名称 / 要求说明',
              key: 'name',
              render: (_, p) => (
                <Flex vertical gap={2}>
                  <Space size={6} wrap>
                    <Typography.Text strong>{p.name}</Typography.Text>
                    <Tag color={p.enforcement === 'BLOCK' ? 'error' : 'warning'} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {p.enforcement === 'BLOCK' ? 'BLOCK · 违规阻断' : 'WARN · 建议提醒'}
                    </Tag>
                  </Space>
                  {p.rule && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.rule}</Typography.Text>}
                  <Typography.Text type="secondary" code style={{ fontSize: 11 }}>{p.id} · v{p.version}</Typography.Text>
                </Flex>
              ),
            },
            {
              title: '生效环节',
              key: 'stages',
              render: (_, p) => (
                <Space size={[4, 4]} wrap>
                  {(p.stages || []).map(st => (
                    <Tag key={st} color="geekblue" style={{ marginInlineEnd: 0 }}>{stageLabel(st)}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '规则状态',
              key: 'status',
              width: 150,
              render: (_, p) => (
                <StatusBadge variant={p.status === 'EXECUTABLE_DECLARATIVE' ? 'green' : 'blue'}>
                  {pluginStatusLabel(p.status)}
                </StatusBadge>
              ),
            },
            ...(canRegisterPlugins ? [{
              title: '操作',
              key: 'actions',
              width: 72,
              render: (_: unknown, p: PolicyPlugin) => (
                <Popconfirm title="移除此条门禁规则？" okText="移除" cancelText="取消" onConfirm={() => removePlugin(p.id)}>
                  <Button type="text" danger size="small" icon={<Trash2 size={14} />} aria-label={`移除规则 ${p.name}`} />
                </Popconfirm>
              ),
            }] : []),
          ]}
          scroll={{ x: 475 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前项目暂无门禁规则。" /> }}
        />
        {canRegisterPlugins && <Flex vertical gap={8}>
          <Typography.Text strong>可启用规则</Typography.Text>
          <div style={{ display: 'grid', gridTemplateColumns: screens.md ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)', gap: 10 }}>
            {POLICY_PLUGIN_PRESETS.map(preset => {
              const installed = isPresetInstalled(preset.baseId, plugins, projectId, projectKey);
              return (
                <div
                  key={preset.baseId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 12px',
                    background: 'var(--tf-raised)',
                    border: '1px solid var(--tf-border)',
                    borderRadius: 8,
                  }}
                >
                  <Flex vertical gap={4} style={{ minWidth: 0 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>{preset.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{preset.description}</Typography.Text>
                    <Space size={4} wrap>
                      {preset.stages.map(st => (
                        <Tag key={st} style={{ marginInlineEnd: 0, fontSize: 11 }}>{stageLabel(st)}</Tag>
                      ))}
                    </Space>
                  </Flex>
                  <Button
                    size="small"
                    type={installed ? 'default' : 'primary'}
                    ghost={!installed}
                    disabled={installed || busy || !!installingPluginId}
                    loading={installingPluginId === preset.baseId}
                    onClick={() => void installPresetPlugin(preset)}
                  >
                    {installed ? '已启用' : '一键启用'}
                  </Button>
                </div>
              );
            })}
          </div>
        </Flex>}
      </Flex>
    </Card>
    {permissions.viewAudit && (
      <Card
        className="tf-members-card"
        title={
          <Space size={8} wrap>
            <span>操作记录</span>
            <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
              {filteredAudit.length} / {auditRecords.length}
            </Typography.Text>
          </Space>
        }
        extra={
          <Space size={8} wrap>
            <Button size="small" icon={<Download size={14} />} disabled={!filteredAudit.length} onClick={() => downloadAuditFile('csv')}>
              导出 CSV
            </Button>
            <Button size="small" icon={<Download size={14} />} disabled={!filteredAudit.length} onClick={() => downloadAuditFile('jsonl')}>
              导出 JSONL
            </Button>
            <Button size="small" icon={<RefreshCw size={14} />} loading={auditLoading} onClick={() => void loadAudit()}>
              刷新
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <div style={{ overflowX: 'auto' }}>
            <Segmented<AuditCategory>
              aria-label="审计事件分类筛选"
              value={auditCategory}
              onChange={setAuditCategory}
              options={AUDIT_CATEGORY_OPTIONS.map(opt => ({
                value: opt.value,
                label: opt.value === 'all'
                  ? `全部事件 (${auditRecords.length})`
                  : `${opt.label} (${auditRecords.filter(r => describeAuditAction(r.action).category === opt.value).length})`,
              }))}
            />
          </div>
          <Flex gap={8} align="center" wrap>
            <Input
              prefix={<Search size={15} />}
              aria-label="搜索审计记录"
              placeholder="搜索操作人、任务或事件（支持 actor:用户名 action:动作，按 Esc 清空）"
              value={auditQuery}
              allowClear
              style={{ maxWidth: 480 }}
              onChange={e => setAuditQuery(e.target.value)}
              onKeyDown={clearSearchOnEscape(auditQuery, () => setAuditQuery(''))}
            />
            {(auditCategory !== 'all' || !!auditQuery) && (
              <Button type="text" onClick={() => { setAuditCategory('all'); setAuditQuery(''); }}>
                清空筛选
              </Button>
            )}
          </Flex>
          {screens.md ? (
            <Table<AuditRecord>
              rowKey="id"
              dataSource={filteredAudit}
              columns={auditColumns}
              loading={auditLoading}
              size="small"
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={auditRecords.length ? '没有匹配的审计记录。' : '当前项目暂无审计记录。'} /> }}
            />
          ) : (
            <List
              className="tf-members-mobile-list"
              rowKey="id"
              loading={auditLoading}
              dataSource={filteredAudit}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
              locale={{ emptyText: auditRecords.length ? '没有匹配的审计记录。' : '当前项目暂无审计记录。' }}
              renderItem={rec => {
                const meta = describeAuditAction(rec.action);
                return (
                  <List.Item>
                    <Flex vertical gap={4} style={{ width: '100%' }}>
                      <Space size={8} wrap>
                        <StatusBadge variant={meta.badgeVariant}>{meta.label}</StatusBadge>
                        <Typography.Text strong>{resolveActorName(rec.actorId)}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{timeText(rec.createdAt)}</Typography.Text>
                      </Space>
                      <div>{renderAuditTarget(rec)}</div>
                    </Flex>
                  </List.Item>
                );
              }}
            />
          )}
        </Flex>
      </Card>
    )}
    <Drawer title="添加项目成员" open={open && canManage} onClose={closeMembership} closable={!busy} maskClosable={!busy} keyboard={!busy} size={520} forceRender footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeMembership}>取消</Button><Button type="primary" loading={busy} disabled={!canManage || !permissions.grantRoles.length} onClick={() => form.submit()}>保存</Button></Flex>}>
      <Form name="project-membership" form={form} layout="vertical" disabled={busy || !canManage} onFinish={saveMembership} onKeyDown={event => { if (isSubmitShortcut(event) && !busy && canManage) { event.preventDefault(); form.submit(); } }}>
        <Form.Item label="成员" name="userId" rules={[{ required: true, message: '请选择成员。' }]}><Select placeholder="选择未加入当前项目的成员" disabled={busy || !canManage} showSearch={{ optionFilterProp: 'label' }} options={availableCandidates.map(member => ({ value: member.id, label: member.username }))} /></Form.Item>
        <Form.Item label="项目角色" name="role" rules={[{ required: true }]}><Select options={choices(permissions.grantRoles)} /></Form.Item>
      </Form>
    </Drawer>
    <Drawer title="创建平台成员" open={newMemberOpen && canCreateUsers} onClose={closeNewMember} closable={!busy} maskClosable={!busy} keyboard={!busy} size={520} forceRender footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeNewMember}>取消</Button><Button type="primary" loading={busy} disabled={!canCreateUsers} onClick={() => newMemberForm.submit()}>创建成员</Button></Flex>}>
      <Form name="new-platform-member" form={newMemberForm} layout="vertical" disabled={busy || !canCreateUsers} initialValues={{ role: 'DEV' }} onFinish={createUser} onKeyDown={event => { if (isSubmitShortcut(event) && !busy && canCreateUsers) { event.preventDefault(); newMemberForm.submit(); } }}>
        <Form.Item label="成员用户名" name="username" rules={[{ required: true, message: '请输入成员用户名。' }, { min: 3, max: 64, message: '用户名需为 3–64 个字符。' }, { pattern: /^[a-zA-Z0-9_.-]+$/, message: '用户名仅支持字母、数字和_.-。' }]}><Input autoComplete="off" maxLength={64} /></Form.Item>
        <Form.Item label="初始密码（8–256 字符）" name="password" rules={[{ required: true, message: '请输入初始密码。' }, { min: 8, max: 256, message: '密码需为 8–256 个字符。' }]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
        <Form.Item label="平台角色" name="role" rules={[{ required: true }]}><Select options={choices(ROLES)} /></Form.Item>
      </Form>
    </Drawer>
    <Drawer title="自定义自然语言门禁规则" open={pluginDrawerOpen && canRegisterPlugins} onClose={closePluginDrawer} closable={!busy} maskClosable={!busy} keyboard={!busy} size={540} forceRender footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closePluginDrawer}>取消</Button><Button type="primary" loading={busy} disabled={!canRegisterPlugins} onClick={() => pluginForm.submit()}>登记门禁规则</Button></Flex>}>
      <Form name="register-policy-plugin" form={pluginForm} layout="vertical" disabled={busy || !canRegisterPlugins} initialValues={{ version: '1.0.0', stages: ['TECH_SPEC', 'CODE_REVIEW'], enforcement: 'WARN' }} onFinish={registerCustomPlugin} onKeyDown={event => { if (isSubmitShortcut(event) && !busy && canRegisterPlugins) { event.preventDefault(); pluginForm.submit(); } }}>
        <Form.Item label="规则标识（小写字母、数字与连字符）" name="id" rules={[{ required: true, message: '请输入规则标识。' }, { pattern: /^[a-z][a-z0-9-]*$/, message: '需以小写字母开头，仅含 a-z、0-9 和 -。' }]}>
          <Input placeholder={buildScopedPluginId('offline-door-token-expiry', projectId, projectKey)} maxLength={64} />
        </Form.Item>
        <Form.Item label="规则名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入规则名称。' }]}>
          <Input placeholder="例如：离线凭证有效期与密钥轮换核验" maxLength={100} />
        </Form.Item>
        <Form.Item label="自然语言审核规则（AI 审核时将逐条对照并体现在清单中）" name="rule" rules={[{ required: true, whitespace: true, message: '请输入具体审核要求。' }]}>
          <Input.TextArea rows={3} maxLength={1000} placeholder="例如：所有涉及离线开门凭证缓存的代码与方案，必须写明失效时间校验、设备解绑清理和防重放机制。" />
        </Form.Item>
        <Form.Item label="规则强度（WARN 仅提醒 / BLOCK 违规阻断）" name="enforcement" rules={[{ required: true }]}>
          <Segmented<RuleEnforcement> options={[{ value: 'WARN', label: 'WARN · 建议提醒' }, { value: 'BLOCK', label: 'BLOCK · 违规阻断' }]} />
        </Form.Item>
        <Form.Item label="绑定交付链路阶段" name="stages" rules={[{ required: true, message: '请至少选择一个交付阶段。' }]}>
          <Select mode="multiple" options={REVIEW_STAGE_OPTIONS} placeholder="选择生效的评审阶段" />
        </Form.Item>
        <Form.Item label="内置确定性执行引擎（可选）" name="evaluator" extra="选择后评审预检与云端 AI 将自动运行该确定性检查包">
          <Select allowClear placeholder="可选：仅靠自然语言提示词审核，或绑定内置引擎" options={[
            { value: 'idempotency-contract-guard', label: '接口幂等与契约核验 (idempotency-contract-guard)' },
            { value: 'sql-migration-safety', label: 'SQL 变更与回滚门禁 (sql-migration-safety)' },
            { value: 'sensitive-log-redaction', label: '敏感凭据与日志脱敏 (sensitive-log-redaction)' },
            { value: 'canary-rollback-gate', label: '灰度放量与回滚预案 (canary-rollback-gate)' },
            { value: 'openapi-contract-lint', label: 'OpenAPI 接口契约规范检查 (openapi-contract-lint)' },
            { value: 'prd-completeness-lint', label: 'PRD 需求完整性检查 (prd-completeness-lint)' },
          ]} />
        </Form.Item>
        <Form.Item label="自定义声明式自动校验规则（可选）" name="ruleType" extra="配置后将在服务端规则引擎中实时执行并产出结构化发现项">
          <Select allowClear placeholder="可选：正则禁止、正则必含或 OpenAPI 契约校验" options={[
            { value: 'regex_forbidden', label: '正则禁用匹配 (regex_forbidden)' },
            { value: 'regex_required', label: '正则必含匹配 (regex_required)' },
            { value: 'openapi_lint', label: 'OpenAPI 规范校验 (openapi_lint)' },
          ]} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, cur) => prev.ruleType !== cur.ruleType}>
          {({ getFieldValue }) => {
            const rt = getFieldValue('ruleType');
            if (rt !== 'regex_forbidden' && rt !== 'regex_required') return null;
            return (
              <Form.Item label="匹配正则表达式" name="rulePattern" rules={[{ required: true, whitespace: true, message: '请输入正则表达式。' }]}>
                <Input placeholder="例如：http://internal\\.legacy|SELECT\\s+\\*" maxLength={300} />
              </Form.Item>
            );
          }}
        </Form.Item>
        <Form.Item label="语义化版本号" name="version" rules={[{ required: true, message: '请输入版本号。' }, { pattern: /^\d+\.\d+\.\d+$/, message: '版本号需符合 x.y.z 格式（如 1.0.0）。' }]}>
          <Input placeholder="1.0.0" maxLength={32} />
        </Form.Item>
      </Form>
    </Drawer>
  </Flex>;
};

export const ProjectCreateDrawer: React.FC<{ open: boolean; onClose: () => void; onCreated: (project: Project) => Promise<void>; onUnauthorized: () => void; onForbidden?: () => void }> = ({ open, onClose, onCreated, onUnauthorized, onForbidden }) => {
  const [form] = Form.useForm<{ key: string; name: string }>();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1; }; }, []);
  useEffect(() => { if (!open) { sequence.current += 1; pending.current = false; form.resetFields(); setBusy(false); } }, [open]);
  return <Drawer title="新建本地项目" size={520} open={open} onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy} forceRender footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} onClick={() => form.submit()}>创建项目</Button></Flex>}>
    <Form form={form} name="new-local-project" layout="vertical" disabled={busy} onKeyDown={event => { if (isSubmitShortcut(event) && !busy) { event.preventDefault(); form.submit(); } }} onFinish={async values => {
      if (!open || busy || pending.current || !alive.current) return;
      const request = ++sequence.current;
      const requestRoute = location.hash;
      const isCurrent = () => alive.current && request === sequence.current && location.hash === requestRoute;
      pending.current = true; setBusy(true);
      try {
        const data = await api<{ project: Project }>('projects', values);
        if (!isCurrent()) return;
        form.resetFields(); onClose(); void message.success('项目已创建。');
        await onCreated(data.project);
      }
      catch (error) {
        if (!isCurrent()) return;
        void message.error(error instanceof Error ? error.message : '请求失败。');
        if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
          form.resetFields(); onClose();
          if (error.status === 401) onUnauthorized(); else onForbidden?.();
        }
      }
      finally { if (isCurrent()) { pending.current = false; setBusy(false); } }
    }}>
      <Form.Item name="key" label="项目标识" rules={[{ required: true, message: '请输入项目标识。' }, { pattern: /^[A-Za-z][A-Za-z0-9_-]*$/, message: '项目标识需以字母开头，仅支持字母、数字、下划线和连字符。' }]}><Input maxLength={40} /></Form.Item>
      <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true, message: '请输入项目名称。' }]}><Input maxLength={100} /></Form.Item>
      <Flex><Typography.Text type="secondary">Jira 项目请从“平台连接”同步，这里只创建本地项目。</Typography.Text></Flex>
    </Form>
  </Drawer>;
};

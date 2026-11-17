import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Empty, Flex, Form, Grid, Input, List, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { KeyRound, Plus, RefreshCw, Search } from 'lucide-react';
import { api, ApiError, Project, timeText, User } from './workspaceApi';
import { readTogether } from './readTogether';
import { navigateWorkspace } from './workspaceNavigation';
import { StatusBadge } from '../components/Primitives';
import { ACCOUNT_PROVIDERS, AccountDraft, AccountSelection, accountProviderName, createAccount, deleteAccount, ExternalAccount, listAccounts, selectAccount, updateAccount, verifyAccount } from './accountApi';
import { authModeLabel, connectorStatusLabel } from './displayLabels';
import { clearSearchOnEscape, isSubmitShortcut } from './uiPreferences';
import './AccountsView.css';

interface AccountFormValues extends AccountDraft {}
interface LegacyConnector { provider: string; name: string; status: string; baseUrl: string; authMode: string; hasCredential: boolean; lastCheckedAt: string | null }
const sameOrigin = (left?: string, right?: string) => {
  try { return new URL(left || '').origin === new URL(right || '').origin; } catch { return false; }
};
const canVerifyAccount = (account: ExternalAccount) => account.enabled && account.canUse && (account.canVerify ?? account.capabilities?.canVerify) === true;

export const AccountsView: React.FC<{
  user: User; project?: Project; projects: Project[];
  onUnauthorized: () => void; onForbidden?: () => void; onChanged?: () => Promise<void>;
}> = ({ user, project, projects, onUnauthorized, onForbidden, onChanged }) => {
  const { message, modal } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [form] = Form.useForm<AccountFormValues>();
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [selections, setSelections] = useState<AccountSelection[]>([]);
  const [legacyConnectors, setLegacyConnectors] = useState<LegacyConnector[]>([]);
  const [filter, setFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState<string>();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExternalAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const alive = useRef(true);
  const readSequence = useRef(0);
  const mutationSequence = useRef(0);
  const pending = useRef(false);
  const dialog = useRef<{ destroy: () => void } | null>(null);
  const scope = JSON.stringify([user.id, user.role, project?.id, project?.role, project?.permissions, projects.map(item => [item.id, item.role])]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const selectedScope = Form.useWatch('scope', form) as AccountDraft['scope'] | undefined;
  const provider = Form.useWatch('provider', form) as AccountDraft['provider'] | undefined;
  const aiProvider = ACCOUNT_PROVIDERS.find(item => item.value === provider)?.ai === true;
  const authMode = Form.useWatch('authMode', form) as AccountDraft['authMode'] | undefined;
  const baseUrl = Form.useWatch('baseUrl', form) as string | undefined;
  const canCreateShared = !!project?.permissions?.manageConnections && !accessDenied;
  const credentialRequired = !editing?.hasCredential || authMode !== editing.authMode || !sameOrigin(baseUrl, editing.baseUrl);
  const isCurrentScope = (owner: string) => alive.current && currentScope.current === owner;

  const closeForm = () => { form.resetFields(); setEditing(null); setOpen(false); };
  const clear = () => {
    readSequence.current += 1; mutationSequence.current += 1; pending.current = false;
    dialog.current?.destroy(); dialog.current = null;
    setAccounts([]); setSelections([]); setLegacyConnectors([]); setBusy(false); closeForm();
  };
  const fail = (error: unknown, owner: string) => {
    if (!isCurrentScope(owner)) return;
    void message.error(error instanceof Error ? error.message : '请求失败。');
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clear(); setAccessDenied(true);
      if (error.status === 401) onUnauthorized(); else onForbidden?.();
    }
  };
  const refresh = async (owner = scope) => {
    if (!isCurrentScope(owner)) return;
    const request = ++readSequence.current;
    setLoading(true);
    try {
      const [result, legacy] = await readTogether([listAccounts(project?.id), project ? api<{ connectors: LegacyConnector[] }>('connectors?projectId=' + encodeURIComponent(project.id) + '&defaults=1') : Promise.resolve({ connectors: [] as LegacyConnector[] })]);
      if (!isCurrentScope(owner) || request !== readSequence.current) return;
      if (!Array.isArray(result.accounts) || !Array.isArray(result.selections) || !Array.isArray(legacy.connectors)) throw new Error('平台响应格式不正确。');
      setAccounts(result.accounts); setSelections(result.selections); setLegacyConnectors(legacy.connectors);
    } catch (error) { if (request === readSequence.current) fail(error, owner); }
    finally { if (isCurrentScope(owner) && request === readSequence.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readSequence.current += 1; mutationSequence.current += 1; pending.current = false; dialog.current?.destroy(); };
  }, []);
  useEffect(() => {
    clear(); setAccessDenied(false); setFilter('all'); setProviderFilter(undefined); setSearch('');
    void refresh(scope);
  }, [scope]);
  useEffect(() => {
    if (!open) return;
    if (editing && !accounts.some(account => account.id === editing.id && account.canManage) || selectedScope === 'PROJECT' && !canCreateShared) closeForm();
  }, [open, accounts, selectedScope, canCreateShared]);
  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (!alive.current || accessDenied || pending.current || currentScope.current !== scope) return;
    const request = ++mutationSequence.current; const owner = scope;
    const isCurrent = () => isCurrentScope(owner) && request === mutationSequence.current;
    pending.current = true; setBusy(true);
    try { await action(isCurrent); }
    catch (error) { if (isCurrent()) fail(error, owner); }
    finally { if (isCurrent()) { pending.current = false; setBusy(false); } }
  };
  const suggestedBase = (value: string) => value === 'jira' && project?.jira ? project.jira.baseUrl : accounts.find(account => account.provider === value && account.enabled)?.baseUrl || legacyConnectors.find(connector => connector.provider === value)?.baseUrl || ACCOUNT_PROVIDERS.find(item => item.value === value)?.defaultUrl || '';
  const beginCreate = () => {
    if (busy || accessDenied) return;
    setEditing(null); form.resetFields();
    const initialProvider = ACCOUNT_PROVIDERS.find(item => item.value === providerFilter) || ACCOUNT_PROVIDERS[0];
    form.setFieldsValue({ scope: 'PERSONAL', provider: initialProvider.value, authMode: initialProvider.authMode, baseUrl: suggestedBase(initialProvider.value) }); setOpen(true);
  };
  const beginEdit = (account: ExternalAccount) => {
    if (busy || !account.canManage) return;
    setEditing(account); form.resetFields();
    form.setFieldsValue({ name: account.name, provider: account.provider as AccountDraft['provider'], scope: account.scope, baseUrl: account.baseUrl, authMode: account.authMode, organizationId: account.organizationId }); setOpen(true);
  };
  const save = (values: AccountFormValues) => {
    if (editing && !accounts.some(account => account.id === editing.id && account.canManage) || values.scope === 'PROJECT' && !canCreateShared) return;
    void run(async isCurrent => {
      const common = { name: values.name, baseUrl: values.baseUrl, authMode: values.authMode, ...(values.username?.trim() ? { username: values.username } : {}), ...(values.token ? { token: values.token } : {}), ...(values.organizationId ? { organizationId: values.organizationId } : {}) };
      const changes = editing ? { name: values.name, ...(values.baseUrl !== editing.baseUrl ? { baseUrl: values.baseUrl } : {}), ...(values.authMode !== editing.authMode ? { authMode: values.authMode } : {}), ...(values.username?.trim() ? { username: values.username } : {}), ...(values.token ? { token: values.token } : {}), ...((values.organizationId || '') !== editing.organizationId ? { organizationId: values.organizationId || '' } : {}) } : common;
      const result = editing ? await updateAccount(editing.id, editing.version, changes) : await createAccount({ ...common, provider: values.provider, scope: values.scope, ...(values.scope === 'PROJECT' ? { projectId: project!.id } : {}) });
      if (!isCurrent()) return;
      setAccounts(current => [...current.filter(account => account.id !== result.account.id), result.account]);
      closeForm(); void message.success('账号已保存，凭据不会回显。');
      await refresh(); if (isCurrent()) await onChanged?.();
    });
  };
  const changeSelection = (selectedProvider: string, value: string) => {
    if (!project || busy) return;
    void run(async isCurrent => {
      await selectAccount(project.id, selectedProvider, value || null);
      if (!isCurrent()) return;
      setSelections(current => [...current.filter(item => item.projectId !== project.id || item.provider !== selectedProvider), ...(value ? [{ projectId: project.id, provider: selectedProvider, accountId: value }] : [])]);
      void message.success('当前项目的使用账号已更新。');
      await refresh(); if (isCurrent()) await onChanged?.();
    });
  };
  const toggle = (account: ExternalAccount) => void run(async isCurrent => {
    const result = await updateAccount(account.id, account.version, { enabled: !account.enabled });
    if (!isCurrent()) return;
    setAccounts(current => current.map(item => item.id === account.id ? result.account : item));
    void message.success(account.enabled ? '账号已停用。' : '账号已启用。'); await refresh();
  });
  const verify = (account: ExternalAccount) => void run(async isCurrent => {
    if (!canVerifyAccount(account)) return;
    let result;
    try { result = await verifyAccount(account.id, account.version, account.scope === 'PROJECT' ? account.projectId || undefined : project?.id); }
    catch (error) { if (isCurrent()) await refresh(); throw error; }
    if (!isCurrent()) return;
    if (result.account) setAccounts(current => current.map(item => item.id === account.id ? result.account! : item));
    void message.success(result.account ? `账号验证通过（${connectorStatusLabel(result.account.status)}）。` : '账号验证已完成。'); await refresh();
  });
  const remove = (account: ExternalAccount) => {
    const owner = scope;
    dialog.current?.destroy();
    dialog.current = modal.confirm({ title: `删除“${account.name}”？`, content: '删除后该账号不能继续使用。已保存的任务、材料和历史记录会保留。', okText: '删除账号', cancelText: '取消', okButtonProps: { danger: true }, onOk: async () => {
      if (!isCurrentScope(owner)) return;
      await run(async isCurrent => {
        await deleteAccount(account.id, account.version); if (!isCurrent()) return;
        setAccounts(current => current.filter(item => item.id !== account.id));
        void message.success('账号已删除。'); await refresh();
      });
    } });
  };
  const actions = (account: ExternalAccount) => <Space wrap size={4}>{canVerifyAccount(account) && <Button type="link" size="small" disabled={busy} onClick={() => verify(account)}>验证</Button>}{account.canManage && <><Button type="link" size="small" disabled={busy} onClick={() => beginEdit(account)}>编辑</Button><Button type="text" size="small" disabled={busy} onClick={() => toggle(account)}>{account.enabled ? '停用' : '启用'}</Button><Button type="text" size="small" danger disabled={busy} onClick={() => remove(account)}>删除</Button></>}</Space>;
  const scopeLabel = (account: ExternalAccount) => account.scope === 'PERSONAL' ? '我的个人账号' : projects.find(item => item.id === account.projectId)?.name || '项目共享账号';
  const visible = accounts.filter(account =>
    (!providerFilter || account.provider === providerFilter) &&
    (filter === 'all' || account.scope === filter) &&
    (!search.trim() || `${account.name} ${account.baseUrl} ${accountProviderName(account.provider)}`.toLowerCase().includes(search.trim().toLowerCase()))
  );
  const columns: TableColumnsType<ExternalAccount> = [
    { title: '账号', key: 'name', width: 260, render: (_, account) => <div className="tf-account-name"><Typography.Text strong>{account.name}</Typography.Text><Typography.Text type="secondary">{accountProviderName(account.provider)} · {scopeLabel(account)}</Typography.Text></div> },
    { title: '服务地址', dataIndex: 'baseUrl', render: value => <Typography.Text className="tf-account-url">{value}</Typography.Text> },
    { title: '状态', key: 'status', width: 180, render: (_, account) => <Flex vertical gap={6}><Space wrap size={[6, 6]}><StatusBadge variant={account.status === 'CONNECTED' ? 'green' : account.status === 'ERROR' ? 'block' : 'neutral'}>{connectorStatusLabel(account.status)}</StatusBadge>{!account.enabled && <Tag>已停用</Tag>}</Space><Typography.Text type="secondary" className="tf-account-meta">{account.lastCheckedAt ? timeText(account.lastCheckedAt) : '尚未验证'}</Typography.Text>{account.lastError && <Typography.Text type="secondary" className="tf-account-meta">{account.lastError}</Typography.Text>}</Flex> },
    { title: '操作', key: 'action', width: 232, render: (_, account) => actions(account) },
  ];
  if (accessDenied) return null;
  return <div className="tf-accounts">
    <Card className="tf-accounts-card" title="绑定的账号" extra={<Space wrap size={8}><Button icon={<RefreshCw size={15} />} loading={loading} disabled={busy} onClick={() => void refresh()}>刷新</Button><Button type="primary" icon={<Plus size={15} />} disabled={busy} onClick={beginCreate}>绑定账号</Button></Space>}>
      <Flex gap={12} wrap className="tf-account-toolbar">
        <Segmented aria-label="账号范围" value={filter} options={[{ label: '全部', value: 'all' }, { label: '我的账号', value: 'PERSONAL' }, { label: '项目共享', value: 'PROJECT' }]} onChange={value => setFilter(value)} />
        <Select aria-label="按平台筛选账号" allowClear placeholder="全部平台" value={providerFilter} options={ACCOUNT_PROVIDERS} onChange={setProviderFilter} />
        <Input
          style={{ maxWidth: 260 }}
          prefix={<Search size={15} />}
          aria-label="搜索账号"
          placeholder="搜索账号名或地址（Esc 清空）"
          value={search}
          allowClear
          onChange={event => setSearch(event.target.value)}
          onKeyDown={clearSearchOnEscape(search, () => setSearch(''))}
        />
      </Flex>
      {screens.md ? <Table rowKey="id" columns={columns} dataSource={visible} loading={loading} scroll={{ x: 860 }} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={accounts.length ? '没有符合条件的账号。' : '还没有绑定账号。'} /> }} /> : <List className="tf-account-mobile-list" rowKey="id" loading={loading} dataSource={visible} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={accounts.length ? '没有符合条件的账号。' : '还没有绑定账号。'} /> }} renderItem={account => <List.Item><div className="tf-account-name"><Typography.Text strong>{account.name}</Typography.Text><Typography.Text type="secondary">{accountProviderName(account.provider)} · {scopeLabel(account)}</Typography.Text><Typography.Text className="tf-account-url">{account.baseUrl}</Typography.Text></div><Space wrap size={[8, 8]}><StatusBadge variant={account.status === 'CONNECTED' ? 'green' : account.status === 'ERROR' ? 'block' : 'neutral'}>{connectorStatusLabel(account.status)}</StatusBadge>{!account.enabled && <Tag>已停用</Tag>}<Typography.Text type="secondary" className="tf-account-meta">{account.lastCheckedAt ? timeText(account.lastCheckedAt) : '尚未验证'}</Typography.Text></Space>{account.lastError && <Typography.Text type="secondary" className="tf-account-meta">{account.lastError}</Typography.Text>}{actions(account)}</List.Item>} />}
      <Typography.Paragraph type="secondary" className="tf-account-note">个人账号仅本人管理；项目共享账号由有权限的负责人管理。保存表示凭据已加密入库，连接可用性以实际验证和读取结果为准。</Typography.Paragraph>
    </Card>
    <Card className="tf-accounts-card" title="当前项目使用账号">
      {!project ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选择项目，再选择各平台使用的账号。" /> : <>
        <Typography.Paragraph type="secondary">{project.key} · {project.name}。以下选择仅影响你在此项目使用的身份，不会改动其他成员的选择。停用、删除或失权的已选账号不会自动回退到其他账号。</Typography.Paragraph>
        <div className="tf-account-selections">{ACCOUNT_PROVIDERS.map(item => {
          const selectedId = selections.find(selection => selection.projectId === project.id && selection.provider === item.value)?.accountId || '';
          const options = accounts.filter(account => account.provider === item.value).map(account => {
            const sourceMatches = item.value !== 'jira' || !project.jira || account.baseUrl === project.jira.baseUrl;
            return { value: account.id, label: `${account.name} · ${account.scope === 'PERSONAL' ? '个人' : '项目共享'}${!account.enabled ? ' · 已停用' : ''}${!sourceMatches ? ' · 与项目 Jira 实例不匹配' : ''}`, disabled: !account.enabled || !account.canUse || !sourceMatches };
          });
          if (selectedId && !options.some(option => option.value === selectedId)) options.push({ value: selectedId, label: '原选择已不可用，请重新选择', disabled: true });
          return <Form.Item key={item.value} label={item.label} layout="vertical" extra={item.ai ? '仅保存使用偏好，云端 AI 执行器尚未接入。' : undefined}><Select aria-label={`${item.label} 当前使用账号`} value={selectedId} loading={loading} disabled={busy || loading} options={[{ value: '', label: item.ai ? '暂不选择 AI 账号' : '使用项目默认连接', disabled: false }, ...options]} onChange={value => changeSelection(item.value, value)} /></Form.Item>;
        })}</div>
      </>}
    </Card>
    {project && <Card className="tf-accounts-card" title="已有项目默认连接"><Typography.Paragraph type="secondary">保留原有配置。未指定其他账号时，研发平台读取继续使用这些项目连接。</Typography.Paragraph><Descriptions bordered size="small" column={1} items={legacyConnectors.map(connector => ({ key: connector.provider, label: connector.name, children: <Flex vertical gap={4}><Space wrap size={[8, 8]}><StatusBadge variant={connector.status === 'CONNECTED' ? 'green' : connector.status === 'ERROR' ? 'block' : 'neutral'}>{connectorStatusLabel(connector.status)}</StatusBadge><Typography.Text type="secondary" className="tf-account-meta">{connector.hasCredential ? '已保存凭据' : '尚无凭据'}</Typography.Text></Space><Typography.Text className="tf-account-url">{connector.baseUrl || '—'}</Typography.Text></Flex> }))} /></Card>}
    <Card className="tf-accounts-card" title={<Space size={8}><KeyRound size={16} />AI 账号与本地工具</Space>}><Typography.Paragraph type="secondary">AI API 账号支持加密保存、个人与项目隔离及使用偏好管理；云端执行、额度读取和自动切换尚未接入，保存不代表模型已运行。</Typography.Paragraph><Typography.Paragraph type="secondary">Codex CLI、Claude Code、Cursor 的本地登录由各工具维护，本平台不收集 auth.json 或浏览器登录数据。</Typography.Paragraph><Button onClick={() => navigateWorkspace('local')}>前往本地 AI 接入</Button></Card>
    <Drawer forceRender title={editing ? '编辑账号' : '绑定账号'} open={open} onClose={() => { if (!pending.current) closeForm(); }} closable={!busy} maskClosable={!busy} keyboard={!busy} size={640} className="tf-account-drawer" footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={closeForm}>取消</Button><Button type="primary" loading={busy} onClick={() => form.submit()}>保存账号</Button></Flex>}>
      <Form form={form} layout="vertical" disabled={busy} onFinish={save} onKeyDown={event => { if (isSubmitShortcut(event) && !busy) { event.preventDefault(); form.submit(); } }}>
        <Form.Item name="scope" label="账号归属" rules={[{ required: true }]}><Select disabled={busy || !!editing} options={[{ value: 'PERSONAL', label: '我的个人账号' }, { value: 'PROJECT', label: '当前项目共享账号', disabled: !canCreateShared }]} /></Form.Item>
        {selectedScope === 'PROJECT' && <Typography.Paragraph type="secondary">共享到 {project?.key} · {project?.name}，项目成员可以使用，凭据不会回显。</Typography.Paragraph>}
        <Form.Item name="provider" label="平台" rules={[{ required: true }]}><Select disabled={busy || !!editing} options={ACCOUNT_PROVIDERS} onChange={value => { const definition = ACCOUNT_PROVIDERS.find(item => item.value === value); form.setFieldsValue({ authMode: definition?.authMode, baseUrl: suggestedBase(value), username: '', token: '', organizationId: '' }); }} /></Form.Item>
        <Form.Item name="name" label="账号名称" htmlFor="external-account-name" rules={[{ required: true, whitespace: true, message: '请填写易识别的账号名称。' }, { max: 100, message: '账号名称不能超过 100 个字符。' }]}><Input id="external-account-name" maxLength={100} placeholder="例如：我的 Jira 工作账号" autoComplete="off" /></Form.Item>
        <Form.Item name="baseUrl" label="服务地址" htmlFor="external-account-base-url" rules={[{ required: true, message: '请选择或填写服务地址。' }, { type: 'url', message: '请输入有效的服务地址。' }]}><Input id="external-account-base-url" placeholder="https://" autoComplete="off" /></Form.Item>
        {aiProvider ? <><Form.Item name="authMode" hidden rules={[{ required: true }]}><Input /></Form.Item><Typography.Paragraph type="secondary">保存 API 凭据供后续执行器使用；当前不会调用模型或验证额度。</Typography.Paragraph></> : <Form.Item name="authMode" label="认证方式" rules={[{ required: true }]}><Select options={['BEARER', 'BASIC', 'PRIVATE_TOKEN'].map(value => ({ value, label: authModeLabel(value) }))} onChange={() => form.setFieldsValue({ username: '', token: '' })} /></Form.Item>}
        {authMode === 'BASIC' && <Form.Item name="username" label="认证用户名" htmlFor="external-account-username" rules={[{ required: credentialRequired, message: '请输入认证用户名。' }]} extra={editing && !credentialRequired ? '用户名不会回显，留空沿用已保存身份。' : undefined}><Input id="external-account-username" autoComplete="off" /></Form.Item>}
        <Form.Item name="token" label={authMode === 'BASIC' ? '密码或访问令牌' : '访问令牌'} htmlFor="external-account-token" rules={[{ required: credentialRequired, message: '请输入此账号的访问凭据。' }]} extra={editing?.hasCredential && !credentialRequired ? '已保存凭据不回显；同服务来源与认证方式时，留空可沿用。' : '仅提交到本平台服务端加密保存，不会存入浏览器本地缓存。'}><Input.Password id="external-account-token" autoComplete="new-password" /></Form.Item>
        {provider === 'yunxiao' && <Form.Item name="organizationId" label="云效组织 ID" htmlFor="external-account-organization" rules={[{ required: true, message: '请输入云效组织 ID。' }]}><Input id="external-account-organization" autoComplete="off" /></Form.Item>}
        {editing && <Typography.Text type="secondary" className="tf-account-meta">按打开时的版本 v{editing.version} 保存，避免覆盖其他会话的修改。</Typography.Text>}
      </Form>
    </Drawer>
  </div>;
};

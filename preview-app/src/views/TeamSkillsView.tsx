import React, { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Drawer, Empty, Flex, Form, Input, Popconfirm, Space, Switch, Table, Tag, Timeline, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { FileUp, History, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, User } from './workspaceApi';

interface TeamSkill {
  id: string; projectId: string; name: string; description: string; version: number; enabled: boolean;
  updatedByName: string; createdAt: string; updatedAt: string; canManage: boolean; content?: string;
}
interface Revision { version: number; description: string; content: string; enabled: boolean; editedBy: string; editedAt: string }
interface SkillForm { name: string; description: string; content: string }

const when = (value: string) => new Date(value).toLocaleString();
const SYNC_COMMAND = 'taskflow-bridge skills-sync --target ~/.codex/skills';

export function parseSkillFile(content: string) {
  const text = content.replace(/^\uFEFF/, '');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] || '';
  const meta = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') || '';
  const name = meta('name').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return { name, description: meta('description').slice(0, 500), content: text };
}

export const TeamSkillsView: React.FC<{ user: User; projectId: string; onUnauthorized: () => void }> = ({ user, projectId, onUnauthorized }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<SkillForm>();
  const [skills, setSkills] = useState<TeamSkill[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<TeamSkill | 'new' | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    if (!projectId) { setSkills([]); return; }
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = await api<{ skills: TeamSkill[]; canManage: boolean }>(`skills?projectId=${encodeURIComponent(projectId)}`);
      if (request === sequence.current) { setSkills(data.skills); setCanManage(data.canManage); }
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setSkills([]); void refresh(); }, [projectId, user.id]);

  const openSkill = async (item: TeamSkill) => {
    setOpen(item); setEditing(false); setRevisions(null);
    try { const data = await api<{ skill: TeamSkill }>(`skills/${item.id}`); setOpen(current => current && current !== 'new' && current.id === item.id ? data.skill : current); }
    catch (error) { fail(error); }
  };
  const startEdit = (item: TeamSkill | 'new') => {
    if (item === 'new') { setOpen('new'); setRevisions(null); }
    setEditing(true);
    form.setFieldsValue(item === 'new' ? { name: '', description: '', content: '' } : { name: item.name, description: item.description, content: item.content || '' });
  };
  const loadFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 60_000) { void message.error('Skill 文件过大，正文不超过 30000 字。'); return; }
    const parsed = parseSkillFile(await file.text());
    form.setFieldsValue({ content: parsed.content, ...(parsed.description ? { description: parsed.description } : {}), ...(open === 'new' && parsed.name ? { name: parsed.name } : {}) });
  };
  const save = async (values: SkillForm) => {
    if (!open || saving) return;
    setSaving(true);
    try {
      const data = open === 'new'
        ? await api<{ skill: TeamSkill }>('skills', { projectId, name: values.name.trim(), description: values.description.trim(), content: values.content })
        : await api<{ skill: TeamSkill }>(`skills/${open.id}`, { expectedVersion: open.version, description: values.description.trim(), content: values.content }, 'PATCH');
      setOpen(data.skill); setEditing(false); setRevisions(null);
      void message.success(open === 'new' ? 'Skill 已发布，成员本机下次同步时生效。' : 'Skill 已更新，成员本机下次同步时生效。'); void refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) void message.warning(error.message);
      else fail(error);
    } finally { setSaving(false); }
  };
  const toggle = async (item: TeamSkill, enabled: boolean) => {
    try { await api(`skills/${item.id}`, { expectedVersion: item.version, enabled }, 'PATCH'); void refresh(); }
    catch (error) { fail(error); }
  };
  const remove = async (item: TeamSkill) => {
    try { await api(`skills/${item.id}`, undefined, 'DELETE'); setOpen(null); void message.success('Skill 已删除，成员本机下次同步时移除。'); void refresh(); }
    catch (error) { fail(error); }
  };
  const loadRevisions = async (item: TeamSkill) => {
    try { setRevisions((await api<{ revisions: Revision[] }>(`skills/${item.id}/revisions`)).revisions); }
    catch (error) { fail(error); }
  };

  const columns: TableColumnsType<TeamSkill> = [
    { title: 'Skill', render: (_, item) => (
      <Flex vertical gap={2}>
        <Typography.Link strong onClick={() => void openSkill(item)}>{item.name}</Typography.Link>
        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 560 }}>{item.description}</Typography.Text>
      </Flex>
    ) },
    { title: '状态', width: 110, render: (_, item) => item.canManage
      ? <Switch size="small" aria-label={`启用 ${item.name}`} checked={item.enabled} checkedChildren="启用" unCheckedChildren="停用" onChange={value => void toggle(item, value)} />
      : <Tag color={item.enabled ? 'success' : 'default'}>{item.enabled ? '启用' : '停用'}</Tag> },
    { title: '最近更新', width: 200, render: (_, item) => <Flex vertical><span>{when(item.updatedAt)}</span><Typography.Text type="secondary">{item.updatedByName} · v{item.version}</Typography.Text></Flex> },
  ];

  const current = open && open !== 'new' ? open : null;
  return (
    <Flex vertical gap={16}>
      <Alert type="info" showIcon title="团队 Skill 由项目负责人统一发布，成员本机 Bridge 自动下发" description={<span>
        成员可运行 <Typography.Text code copyable>{SYNC_COMMAND}</Typography.Text> 立即同步，或在 worker.json 配置 <Typography.Text code>skillSync</Typography.Text> 定时同步。
        只会写入以 <Typography.Text code>taskflow-</Typography.Text> 开头且带平台标记的目录，不会覆盖本机已有的 Skill；停用或删除后会在下次同步时移除。
      </span>} />
      <Flex gap={12} justify="space-between">
        <Typography.Text type="secondary">{canManage ? '你可以发布、修改和停用本项目的团队 Skill。' : '仅项目负责人和管理员可以发布或修改，成员可查看内容和历史版本。'}</Typography.Text>
        <Space>
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          {canManage ? <Button type="primary" icon={<Plus size={14} />} disabled={!projectId} onClick={() => startEdit('new')}>发布 Skill</Button> : null}
        </Space>
      </Flex>
      <Table<TeamSkill> rowKey="id" size="middle" loading={loading} dataSource={skills} columns={columns} pagination={false}
        locale={{ emptyText: <Empty description={canManage ? '还没有团队 Skill，可以上传现有 SKILL.md 发布给全组。' : '项目负责人还没有发布团队 Skill。'} /> }} />
      <input ref={fileInput} type="file" hidden accept=".md,text/markdown,text/plain" onChange={event => { void loadFile(event.target.files); event.target.value = ''; }} />
      <Drawer open={!!open} width={760} onClose={() => { setOpen(null); setEditing(false); }} destroyOnHidden
        title={editing ? (open === 'new' ? '发布团队 Skill' : `编辑 ${current?.name}`) : current?.name}
        extra={editing
          ? <Space><Button icon={<FileUp size={14} />} onClick={() => fileInput.current?.click()}>读取 SKILL.md</Button><Button onClick={() => (open === 'new' ? setOpen(null) : setEditing(false))}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Space>
          : current ? <Space>
            <Button icon={<History size={14} />} onClick={() => void loadRevisions(current)}>历史版本</Button>
            {current.canManage ? <Button icon={<Pencil size={14} />} disabled={current.content === undefined} onClick={() => startEdit(current)}>编辑</Button> : null}
            {current.canManage ? <Popconfirm title="删除后成员本机会在下次同步时移除，确定？" okText="删除" cancelText="取消" onConfirm={() => void remove(current)}><Button danger icon={<Trash2 size={14} />} aria-label="删除" /></Popconfirm> : null}
          </Space> : null}>
        {editing ? (
          <Form<SkillForm> form={form} layout="vertical" onFinish={values => void save(values)}>
            <Form.Item name="name" label="名称" extra="小写字母、数字和连字符；成员本机目录为 taskflow-<项目KEY>-<名称>。" rules={[{ required: true, message: '请填写名称' }, { pattern: /^[a-z0-9][a-z0-9-]{0,62}$/, message: '只能用小写字母、数字和连字符，且不以连字符开头' }]}>
              <Input placeholder="例如 pay-review" disabled={open !== 'new'} />
            </Form.Item>
            <Form.Item name="description" label="描述" extra="AI 依据描述判断何时使用该 Skill，写清适用场景。" rules={[{ required: true, whitespace: true, message: '请填写描述' }, { max: 500 }, { pattern: /^[^\r\n]*$/, message: '描述不能换行' }]}>
              <Input placeholder="例如 评审支付相关代码时使用：检查金额精度、幂等、回调验签" />
            </Form.Item>
            <Form.Item name="content" label="SKILL.md 正文" extra="上传文件中的 frontmatter 会在下发时替换为平台生成的 name 与 description。" rules={[{ required: true, whitespace: true, message: '请填写正文' }, { max: 30_000, message: '正文不超过 30000 字' }]}>
              <Input.TextArea autoSize={{ minRows: 16, maxRows: 32 }} style={{ fontFamily: 'var(--ant-font-family-code, monospace)' }} placeholder={'# 支付代码评审\n\n## 检查项\n- 金额统一用整数分\n- 回调必须验签并幂等'} />
            </Form.Item>
          </Form>
        ) : current ? (
          <Flex vertical gap={12}>
            <Space size={[4, 4]} wrap>
              <Tag color={current.enabled ? 'success' : 'default'}>{current.enabled ? '启用' : '停用'}</Tag>
              <Typography.Text type="secondary">{current.updatedByName} 更新于 {when(current.updatedAt)} · v{current.version}</Typography.Text>
            </Space>
            <Typography.Paragraph>{current.description}</Typography.Paragraph>
            {current.content === undefined ? <Typography.Text type="secondary">加载中…</Typography.Text>
              : <pre style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 12, borderRadius: 8, background: 'var(--ant-color-fill-quaternary)', fontSize: 13 }}>{current.content}</pre>}
            {revisions ? (
              <Flex vertical gap={8} style={{ borderTop: '1px solid var(--ant-color-border-secondary)', paddingTop: 12 }}>
                <Typography.Text strong>历史版本</Typography.Text>
                {revisions.length ? <Timeline items={revisions.map(item => ({ key: item.version, content: (
                  <details>
                    <summary>v{item.version} · {item.editedBy} · {when(item.editedAt)}{item.enabled ? '' : ' · 停用'}</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>{item.content}</pre>
                  </details>
                ) }))} /> : <Typography.Text type="secondary">还没有历史版本。</Typography.Text>}
              </Flex>
            ) : null}
          </Flex>
        ) : null}
      </Drawer>
    </Flex>
  );
};

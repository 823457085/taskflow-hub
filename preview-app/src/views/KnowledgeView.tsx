import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Drawer, Dropdown, Empty, Flex, Form, Input, Popconfirm, Select, Space, Table, Tag, Timeline, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { FileUp, History, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, User } from './workspaceApi';
import { catalogDocs, ImportDoc, markdownDoc } from './knowledgeImport';

interface KnowledgeDoc {
  id: string; projectId: string; title: string; tags: string[]; source: 'manual' | 'import'; sourceRef: string | null; version: number;
  authorName: string; updatedByName: string; createdAt: string; updatedAt: string; excerpt?: string; body?: string; canEdit: boolean; canDelete: boolean;
}
interface Revision { version: number; title: string; body: string; tags: string[]; editedBy: string; editedAt: string }
interface DocForm { title: string; body: string; tags: string[] }

const when = (value: string) => new Date(value).toLocaleString();
const IMPORT_BATCH = 50, IMPORT_BYTES = 100_000;
const importBatches = (docs: ImportDoc[]) => {
  const batches: ImportDoc[][] = [];
  let current: ImportDoc[] = [], bytes = 0;
  for (const doc of docs) {
    const size = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (current.length && (current.length >= IMPORT_BATCH || bytes + size > IMPORT_BYTES)) { batches.push(current); current = []; bytes = 0; }
    current.push(doc); bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
};

export const KnowledgeView: React.FC<{ user: User; projectId: string; onUnauthorized: () => void }> = ({ user, projectId, onUnauthorized }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<DocForm>();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<KnowledgeDoc | 'new' | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importKind = useRef<'markdown' | 'catalog'>('markdown');
  const sequence = useRef(0);

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    if (!projectId) { setDocs([]); setTags([]); return; }
    const request = ++sequence.current;
    setLoading(true);
    const params = new URLSearchParams({ projectId, limit: '200' });
    if (query.trim()) params.set('q', query.trim());
    if (tag) params.set('tag', tag);
    try {
      const data = await api<{ docs: KnowledgeDoc[]; tags: string[] }>(`knowledge?${params}`);
      if (request === sequence.current) { setDocs(data.docs); setTags(data.tags); }
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => { setDocs([]); void refresh(); }, [projectId, tag, user.id]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 300); return () => window.clearTimeout(timer); }, [query]);

  const openDoc = async (item: KnowledgeDoc) => {
    setOpen(item); setEditing(false); setRevisions(null);
    try { const data = await api<{ doc: KnowledgeDoc }>(`knowledge/${item.id}`); setOpen(current => current && current !== 'new' && current.id === item.id ? data.doc : current); }
    catch (error) { fail(error); }
  };
  const startEdit = (item: KnowledgeDoc | 'new') => {
    if (item === 'new') { setOpen('new'); setRevisions(null); }
    setEditing(true);
    form.setFieldsValue(item === 'new' ? { title: '', body: '', tags: tag ? [tag] : [] } : { title: item.title, body: item.body || '', tags: item.tags });
  };
  const save = async (values: DocForm) => {
    if (!open || saving) return;
    setSaving(true);
    try {
      const payload = { title: values.title, body: values.body || '', tags: (values.tags || []).map(item => item.trim()).filter(Boolean) };
      const data = open === 'new'
        ? await api<{ doc: KnowledgeDoc }>('knowledge', { projectId, ...payload })
        : await api<{ doc: KnowledgeDoc }>(`knowledge/${open.id}`, { expectedVersion: open.version, ...payload }, 'PATCH');
      setOpen(data.doc); setEditing(false); setRevisions(null);
      void message.success('文档已保存。'); void refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) void message.warning('文档已被他人修改，请关闭后重新打开再编辑。');
      else fail(error);
    } finally { setSaving(false); }
  };
  const remove = async (item: KnowledgeDoc) => {
    try { await api(`knowledge/${item.id}`, undefined, 'DELETE'); setOpen(null); void message.success('文档已删除。'); void refresh(); }
    catch (error) { fail(error); }
  };
  const loadRevisions = async (item: KnowledgeDoc) => {
    try { setRevisions((await api<{ revisions: Revision[] }>(`knowledge/${item.id}/revisions`)).revisions); }
    catch (error) { fail(error); }
  };
  const chooseImport = (kind: 'markdown' | 'catalog') => {
    importKind.current = kind;
    if (!fileInput.current) return;
    fileInput.current.accept = kind === 'catalog' ? '.json,application/json' : '.md,.markdown,.txt,text/markdown,text/plain';
    fileInput.current.multiple = kind === 'markdown';
    fileInput.current.value = '';
    fileInput.current.click();
  };
  const runImport = async (files: FileList | null) => {
    if (!files?.length || !projectId) return;
    setImporting(true);
    try {
      let items: ImportDoc[] = [];
      if (importKind.current === 'catalog') {
        let raw: unknown;
        try { raw = JSON.parse(await files[0].text()); } catch { throw new Error('所选文件不是合法的 JSON。'); }
        items = catalogDocs(raw);
        if (!items.length) throw new Error('没有在文件中找到系统目录，请选择 Delivery 的 .local/data/system-catalog/catalog.json。');
      } else {
        for (const file of Array.from(files)) {
          if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error(`${file.name} 不是 Markdown 文件；导入 Delivery 系统目录请使用对应菜单。`);
          if (file.size > 120_000) throw new Error(`${file.name} 超过 120KB，请拆分后再导入。`);
          items.push(markdownDoc(file.name, await file.text()));
        }
      }
      const total = { created: 0, updated: 0, unchanged: 0 };
      for (const batch of importBatches(items)) {
        const result = await api<typeof total>('knowledge/import', { projectId, docs: batch });
        total.created += result.created; total.updated += result.updated; total.unchanged += result.unchanged;
      }
      void message.success(`导入完成：新增 ${total.created}，更新 ${total.updated}，未变化 ${total.unchanged}。`);
      void refresh();
    } catch (error) { fail(error); }
    finally { setImporting(false); }
  };

  const columns: TableColumnsType<KnowledgeDoc> = [
    { title: '标题', render: (_, item) => (
      <Flex vertical gap={2}>
        <Typography.Link strong onClick={() => void openDoc(item)}>{item.title}</Typography.Link>
        {item.excerpt ? <Typography.Text type="secondary" ellipsis style={{ maxWidth: 640 }}>{item.excerpt}</Typography.Text> : null}
      </Flex>
    ) },
    { title: '标签', width: 220, render: (_, item) => <Space size={[4, 4]} wrap>{item.tags.map(name => <Tag key={name} style={{ cursor: 'pointer' }} onClick={() => setTag(name)}>{name}</Tag>)}</Space> },
    { title: '最近更新', width: 190, render: (_, item) => <Flex vertical><span>{when(item.updatedAt)}</span><Typography.Text type="secondary">{item.updatedByName} · v{item.version}{item.source === 'import' ? ' · 导入' : ''}</Typography.Text></Flex> },
  ];

  const current = open && open !== 'new' ? open : null;
  return (
    <Flex vertical gap={16}>
      <Flex gap={12} wrap justify="space-between">
        <Space wrap>
          <Input.Search aria-label="搜索知识库" allowClear placeholder="搜索标题、正文或标签" style={{ width: 280 }} value={query} onChange={event => setQuery(event.target.value)} />
          <Select aria-label="标签" allowClear placeholder="全部标签" style={{ width: 160 }} value={tag} onChange={setTag} options={tags.map(name => ({ value: name, label: name }))} />
        </Space>
        <Space>
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          <Dropdown disabled={!projectId || importing} menu={{ items: [
            { key: 'markdown', label: '导入 Markdown 文件', onClick: () => chooseImport('markdown') },
            { key: 'catalog', label: '导入 Delivery 系统目录（不含账号密码）', onClick: () => chooseImport('catalog') },
          ] }}>
            <Button icon={<FileUp size={14} />} loading={importing}>导入</Button>
          </Dropdown>
          <Button type="primary" icon={<Plus size={14} />} disabled={!projectId} onClick={() => startEdit('new')}>新建文档</Button>
        </Space>
      </Flex>
      <input ref={fileInput} type="file" hidden onChange={event => void runImport(event.target.files)} />
      <Table<KnowledgeDoc> rowKey="id" size="middle" loading={loading} dataSource={docs} columns={columns} pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <Empty description={query || tag ? '没有匹配的文档。' : '知识库还是空的。可以新建文档，或导入 Markdown 与 Delivery 系统目录；成员的本地 AI 可通过 knowledge_search 检索这里的内容。'} /> }} />
      <Drawer open={!!open} width={720} onClose={() => { setOpen(null); setEditing(false); }} destroyOnHidden
        title={editing ? (open === 'new' ? '新建文档' : '编辑文档') : current?.title}
        extra={editing
          ? <Space><Button onClick={() => (open === 'new' ? setOpen(null) : setEditing(false))}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Space>
          : current ? <Space>
            <Button icon={<History size={14} />} onClick={() => void loadRevisions(current)}>历史版本</Button>
            {current.canEdit ? <Button icon={<Pencil size={14} />} disabled={current.body === undefined} onClick={() => startEdit(current)}>编辑</Button> : null}
            {current.canDelete ? <Popconfirm title="删除这篇文档及其历史版本？" okText="删除" cancelText="取消" onConfirm={() => void remove(current)}><Button danger icon={<Trash2 size={14} />} aria-label="删除" /></Popconfirm> : null}
          </Space> : null}>
        {editing ? (
          <Form<DocForm> form={form} layout="vertical" onFinish={values => void save(values)}>
            <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '请填写标题' }, { max: 200 }]}><Input placeholder="例如 支付回调排查手册" /></Form.Item>
            <Form.Item name="tags" label="标签" rules={[{ type: 'array', max: 10, message: '最多 10 个标签' }]}>
              <Select mode="tags" tokenSeparators={[',', '，']} placeholder="输入后回车，如 SOP、支付" options={tags.map(name => ({ value: name, label: name }))} />
            </Form.Item>
            <Form.Item name="body" label="正文（Markdown）" rules={[{ max: 30_000, message: '正文不超过 30000 字' }]}>
              <Input.TextArea autoSize={{ minRows: 16, maxRows: 32 }} style={{ fontFamily: 'var(--ant-font-family-code, monospace)' }} placeholder="排查步骤、系统说明、约定规范……" />
            </Form.Item>
            <Typography.Text type="secondary">知识库内容对项目成员和其授权的本地 AI 可见，请勿填写账号密码、密钥等敏感信息。</Typography.Text>
          </Form>
        ) : current ? (
          <Flex vertical gap={12}>
            <Space size={[4, 4]} wrap>
              {current.tags.map(name => <Tag key={name}>{name}</Tag>)}
              <Typography.Text type="secondary">{current.authorName} 创建 · {current.updatedByName} 更新于 {when(current.updatedAt)} · v{current.version}</Typography.Text>
            </Space>
            {current.body === undefined ? <Typography.Text type="secondary">加载中…</Typography.Text>
              : current.body ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{current.body}</Typography.Paragraph>
              : <Typography.Text type="secondary">暂无正文。</Typography.Text>}
            {revisions ? (
              <Flex vertical gap={8} style={{ borderTop: '1px solid var(--ant-color-border-secondary)', paddingTop: 12 }}>
                <Typography.Text strong>历史版本</Typography.Text>
                {revisions.length ? <Timeline items={revisions.map(item => ({ key: item.version, content: (
                  <details>
                    <summary>v{item.version} · {item.editedBy} · {when(item.editedAt)}{item.title !== current.title ? ` · 标题「${item.title}」` : ''}</summary>
                    <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{item.body || '（空）'}</Typography.Paragraph>
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

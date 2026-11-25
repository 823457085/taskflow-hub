import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Drawer, Dropdown, Empty, Flex, Form, Input, Popconfirm, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { MenuProps, TableColumnsType } from 'antd';
import { FileUp, History, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, Project, User } from './workspaceApi';
import { readProjectRecords } from './readProjectRecords';
import { catalogDocs, ImportDoc, markdownDoc } from './knowledgeImport';
import { MarkdownPreview } from './MarkdownPreview';
import './WorkspaceRecords.css';

interface KnowledgeDoc {
  id: string; projectId: string; title: string; tags: string[]; source: 'manual' | 'import'; sourceRef: string | null; version: number;
  authorName: string; updatedByName: string; createdAt: string; updatedAt: string; excerpt?: string; body?: string; canEdit: boolean; canDelete: boolean;
}
interface Revision { version: number; title: string; body: string; tags: string[]; editedBy: string; editedAt: string }
interface DocForm { projectId?: string; title: string; body: string; tags: string[] }
type ImportKind = 'markdown' | 'catalog';
const IMPORT_OPTIONS: { kind: ImportKind; label: string }[] = [
  { kind: 'markdown', label: '导入 Markdown 文件' },
  { kind: 'catalog', label: '导入 Delivery 系统目录' },
];

const when = (value: string) => new Date(value).toLocaleString();
const PAGE_SIZE = 20;
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

export const KnowledgeView: React.FC<{ user: User; projects: Project[]; projectId: string; onUnauthorized: () => void }> = ({ user, projects, projectId, onUnauthorized }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<DocForm>();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [preferredId, setPreferredId] = useState('');
  const [detail, setDetail] = useState<KnowledgeDoc | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState<KnowledgeDoc | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<{ docId: string; items: Revision[] } | null>(null);
  const [revisionVersion, setRevisionVersion] = useState<number>();
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<{ kind: ImportKind; projectId: string } | null>(null);
  const sequence = useRef(0);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(docs.length / PAGE_SIZE)));
  const pageItems = docs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const active = pageItems.find(item => item.id === preferredId) || pageItems[0];
  const activeId = active?.id;
  const activeVersion = active?.version;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const current = active && detail?.id === active.id && detail.version >= active.version ? detail : active;
  const history = revisions?.docId === activeId ? revisions?.items : undefined;
  const revision = history?.find(item => item.version === revisionVersion) || history?.[0];
  const projectKey = (id: string) => projects.find(project => project.id === id)?.key || id;

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };
  const refresh = async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const results = await readProjectRecords(projectId ? [projectId] : projects.map(project => project.id), id => {
        const params = new URLSearchParams({ projectId: id, limit: '200' });
        if (query.trim()) params.set('q', query.trim());
        if (tag) params.set('tag', tag);
        return api<{ docs: KnowledgeDoc[]; tags: string[] }>(`knowledge?${params}`);
      });
      if (request !== sequence.current) return;
      setDocs(results.flatMap(result => result.docs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setTags([...new Set(results.flatMap(result => result.tags))].sort());
    } catch (error) { if (request === sequence.current) fail(error); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    setDocs([]);
    setPreferredId('');
    setPage(1);
    void refresh();
    return () => { sequence.current += 1; };
  }, [projectId, projects, tag, user.id]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 300); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { setEditing(null); setRevisions(null); }, [projectId, user.id]);

  useEffect(() => {
    if (!activeId) { setDetail(null); setDetailLoading(false); return; }
    let current = true;
    setDetailLoading(true);
    void api<{ doc: KnowledgeDoc }>(`knowledge/${activeId}`)
      .then(data => { if (current) setDetail(data.doc); })
      .catch(error => { if (current) fail(error); })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [activeId, activeVersion]);

  const startEdit = (item: KnowledgeDoc | 'new') => {
    setEditing(item);
    form.setFieldsValue(item === 'new'
      ? { projectId: projectId || undefined, title: '', body: '', tags: tag ? [tag] : [] }
      : { projectId: item.projectId, title: item.title, body: item.body || '', tags: item.tags });
  };
  const save = async (values: DocForm) => {
    if (!editing || saving) return;
    const targetProjectId = projectId || values.projectId;
    if (editing === 'new' && !projects.some(project => project.id === targetProjectId)) return;
    setSaving(true);
    try {
      const payload = { title: values.title, body: values.body || '', tags: (values.tags || []).map(item => item.trim()).filter(Boolean) };
      const { doc } = editing === 'new'
        ? await api<{ doc: KnowledgeDoc }>('knowledge', { projectId: targetProjectId, ...payload })
        : await api<{ doc: KnowledgeDoc }>(`knowledge/${editing.id}`, { expectedVersion: editing.version, ...payload }, 'PATCH');
      setDetail(doc);
      setPreferredId(doc.id);
      setPage(1);
      setEditing(null);
      setRevisions(null);
      void message.success('文档已保存。'); void refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        void message.warning('文档已被他人修改，请取消编辑后重新读取。');
        void refresh();
      } else fail(error);
    } finally { setSaving(false); }
  };
  const remove = async (item: KnowledgeDoc) => {
    try {
      await api(`knowledge/${item.id}`, undefined, 'DELETE');
      setDocs(items => items.filter(doc => doc.id !== item.id));
      void message.success('文档已删除。'); void refresh();
    } catch (error) { fail(error); }
  };
  const loadRevisions = async (item: KnowledgeDoc) => {
    if (revisions?.docId === item.id) { setRevisions(null); return; }
    try {
      const { revisions: items } = await api<{ revisions: Revision[] }>(`knowledge/${item.id}/revisions`);
      if (activeIdRef.current === item.id) { setRevisions({ docId: item.id, items }); setRevisionVersion(undefined); }
    } catch (error) { fail(error); }
  };
  const chooseImport = (kind: ImportKind, targetProjectId: string) => {
    importTarget.current = { kind, projectId: targetProjectId };
    if (!fileInput.current) return;
    fileInput.current.accept = kind === 'catalog' ? '.json,application/json' : '.md,.markdown,.txt,text/markdown,text/plain';
    fileInput.current.multiple = kind === 'markdown';
    fileInput.current.value = '';
    fileInput.current.click();
  };
  const runImport = async (files: FileList | null) => {
    const target = importTarget.current;
    if (!files?.length || !target || importing || (projectId && projectId !== target.projectId) ||
      !projects.some(project => project.id === target.projectId)) return;
    setImporting(true);
    try {
      let items: ImportDoc[] = [];
      if (target.kind === 'catalog') {
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
        const result = await api<typeof total>('knowledge/import', { projectId: target.projectId, docs: batch });
        total.created += result.created; total.updated += result.updated; total.unchanged += result.unchanged;
      }
      void message.success(`导入完成：新增 ${total.created}，更新 ${total.updated}，未变化 ${total.unchanged}。`);
      void refresh();
    } catch (error) { fail(error); }
    finally { setImporting(false); }
  };

  const importMenu: MenuProps['items'] = IMPORT_OPTIONS.map(({ kind, label }) => ({
    key: kind,
    label,
    ...(projectId ? { onClick: () => chooseImport(kind, projectId) } : {
      children: projects.map(project => ({
        key: `${kind}-${project.id}`, label: `${project.key} · ${project.name}`,
        onClick: () => chooseImport(kind, project.id),
      })),
    }),
  }));

  const columns: TableColumnsType<KnowledgeDoc> = [
    { title: '文档', render: (_, item) => (
      <Flex vertical gap={4}>
        <button type="button" className="tf-reading-title" title={item.title} aria-current={activeId === item.id || undefined} onClick={() => setPreferredId(item.id)}>{item.title}</button>
        {item.excerpt ? <Typography.Text type="secondary" ellipsis title={item.excerpt}>{item.excerpt}</Typography.Text> : null}
        <Space size={[8, 4]} wrap>
          {!projectId && <Tag>{projectKey(item.projectId)}</Tag>}
          {item.tags.map(name => <Button key={name} type="text" size="small" onClick={() => setTag(name)}>{name}</Button>)}
          <Typography.Text type="secondary">{item.updatedByName} · {when(item.updatedAt)}</Typography.Text>
        </Space>
      </Flex>
    ) },
  ];

  return (
    <div className="tf-record-workspace tf-knowledge-workspace">
      <div className="tf-record-toolbar">
        <div className="tf-record-filters tf-knowledge-filters">
          <Input.Search aria-label="搜索知识库" allowClear placeholder="搜索标题、正文或标签" className="tf-knowledge-search" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
          <Select aria-label="标签" allowClear placeholder="全部标签" style={{ width: 160 }} value={tag} onChange={setTag} options={tags.map(name => ({ value: name, label: name }))} />
        </div>
        <div className="tf-record-actions">
          <Button icon={<RefreshCw size={14} />} aria-label="刷新知识库" title="刷新知识库" loading={loading} onClick={() => void refresh()} />
          <Dropdown disabled={!projects.length || importing} menu={{ items: importMenu }}>
            <Button icon={<FileUp size={14} />} loading={importing}>导入</Button>
          </Dropdown>
          <Button type="primary" icon={<Plus size={14} />} disabled={!projects.length} onClick={() => startEdit('new')}>新建文档</Button>
        </div>
      </div>
      <input ref={fileInput} type="file" hidden onChange={event => void runImport(event.target.files)} />
      <div className={current ? 'tf-reading-layout tf-knowledge-reader' : 'tf-record-table'}>
        <Table<KnowledgeDoc> rowKey="id" size="small" loading={loading} dataSource={docs} columns={columns} tableLayout="fixed"
          scroll={current ? { y: 'clamp(150px, 43dvh, 520px)' } : undefined}
          pagination={{ current: currentPage, pageSize: PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage }}
          rowClassName={item => item.id === activeId ? 'tf-reading-selected' : ''}
          locale={{ emptyText: <Empty description={query || tag ? '没有匹配的文档。' : projectId ? '当前项目暂无文档。' : '暂无文档。'} /> }} />
        {current && <Card size="small"
          title={<Typography.Text strong ellipsis title={current.title}>{current.title}</Typography.Text>}
          extra={<Space size={4}>
            <Button type="text" icon={<History size={14} />} title="历史版本" aria-label="历史版本" aria-pressed={!!history} onClick={() => void loadRevisions(current)} />
            {current.canEdit ? <Button type="text" icon={<Pencil size={14} />} title="编辑文档" aria-label="编辑文档" disabled={current.body === undefined} onClick={() => startEdit(current)} /> : null}
            {current.canDelete ? <Popconfirm title="删除这篇文档及其历史版本？" okText="删除" cancelText="取消" onConfirm={() => void remove(current)}><Button danger icon={<Trash2 size={14} />} aria-label="删除" /></Popconfirm> : null}
          </Space>}>
          <Flex vertical gap={12}>
            <Space size={[8, 4]} wrap>
              {!projectId && <Tag>{projectKey(current.projectId)}</Tag>}
              {current.tags.map(name => <Tag key={name}>{name}</Tag>)}
              <Typography.Text type="secondary">{current.authorName} 创建 · {current.updatedByName} 更新于 {when(current.updatedAt)} · v{current.version}</Typography.Text>
            </Space>
            {current.body ? <MarkdownPreview content={current.body} />
              : detailLoading ? <Skeleton active paragraph={{ rows: 6 }} />
              : <Typography.Text type="secondary">{current.excerpt || '暂无正文。'}</Typography.Text>}
            {history && (
              <Flex vertical gap={8} style={{ borderTop: '1px solid var(--ant-color-border-secondary)', paddingTop: 12 }}>
                <Typography.Text strong>历史版本</Typography.Text>
                {revision ? (
                  <>
                    <Select aria-label="历史版本" value={revision.version} onChange={setRevisionVersion}
                      options={history.map(item => ({ value: item.version, label: `v${item.version} · ${item.editedBy} · ${when(item.editedAt)}` }))} />
                    {revision.title !== current.title && <Typography.Text>{revision.title}</Typography.Text>}
                    {revision.body ? <MarkdownPreview content={revision.body} /> : <Typography.Text type="secondary">暂无正文。</Typography.Text>}
                  </>
                ) : <Typography.Text type="secondary">暂无历史版本。</Typography.Text>}
              </Flex>
            )}
          </Flex>
        </Card>}
      </div>
      <Drawer open={!!editing} size="min(720px, 100vw)" onClose={() => setEditing(null)} destroyOnHidden
        title={editing === 'new' ? '新建文档' : '编辑文档'}
        extra={<Space><Button onClick={() => setEditing(null)}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Space>}>
        <Form<DocForm> form={form} layout="vertical" onFinish={values => void save(values)}>
          {!projectId && <Form.Item name="projectId" label="所属项目" rules={[{ required: true, message: '请选择所属项目' }]}>
            <Select disabled={editing !== 'new'} showSearch={{ optionFilterProp: 'label' }} options={projects.map(project => ({ value: project.id, label: `${project.key} · ${project.name}` }))} />
          </Form.Item>}
          <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '请填写标题' }, { max: 200 }]}><Input placeholder="例如 支付回调排查手册" /></Form.Item>
          <Form.Item name="tags" label="标签" rules={[{ type: 'array', max: 10, message: '最多 10 个标签' }]}>
            <Select mode="tags" tokenSeparators={[',', '，']} placeholder="输入后回车，如 SOP、支付" options={tags.map(name => ({ value: name, label: name }))} />
          </Form.Item>
          <Form.Item name="body" label="正文（Markdown）" rules={[{ max: 30_000, message: '正文不超过 30000 字' }]}>
            <Input.TextArea autoSize={{ minRows: 16, maxRows: 32 }} style={{ fontFamily: 'var(--ant-font-family-code, monospace)' }} placeholder="排查步骤、系统说明、约定规范……" />
          </Form.Item>
          <Typography.Text type="secondary">知识库内容对项目成员和其授权的本地 AI 可见，请勿填写账号密码、密钥等敏感信息。</Typography.Text>
        </Form>
      </Drawer>
    </div>
  );
};

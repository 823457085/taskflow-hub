import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Empty, Form, Input, Modal, Space, Typography } from 'antd';
import { ArrowRight, Download, FileJson, Plus, Upload } from 'lucide-react';
import { DEFAULT_CLIENT_ADAPTER, parseClientAdapter } from '../../../shared/local-client-adapter.mjs';
import type { ClientAdapterManifest } from '../../../shared/local-client-adapter.mjs';
import { CLIENT_ADAPTER_LIMIT as LIMIT, loadClientAdapters, saveClientAdapters } from './clientAdapterStorage.mjs';
import './CustomClientAdapters.css';

const jsonText = (adapter: Readonly<ClientAdapterManifest>) => JSON.stringify(adapter, null, 2) + '\n';
const validationMessage = (error: unknown) => error instanceof Error ? error.message : '客户端适配器格式无效。';

function downloadAdapter(adapter: Readonly<ClientAdapterManifest>) {
  const validated = parseClientAdapter(adapter);
  const url = URL.createObjectURL(new Blob([jsonText(validated)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${validated.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const CustomClientAdapters: React.FC<{ userId: string; onConnect: (adapter: ClientAdapterManifest) => void }> = ({ userId, onConnect }) => {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<{ manifest: string }>();
  const [registry, setRegistry] = useState<{ userId: string; adapters: ClientAdapterManifest[] }>({ userId, adapters: [] });
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const adapters = registry.userId === userId ? registry.adapters : [];
  const fileRead = useRef(0);
  const removeDialog = useRef<{ destroy: () => void } | null>(null);
  const currentRegistry = useRef(registry);
  currentRegistry.current = registry;

  useEffect(() => {
    fileRead.current += 1; removeDialog.current?.destroy(); removeDialog.current = null;
    setOpen(false); setEditingId(''); form.resetFields();
    if (fileInput.current) fileInput.current.value = '';
    let stored: ClientAdapterManifest[] = [];
    try { stored = loadClientAdapters(localStorage, userId); } catch { /* Browser storage can be disabled. */ }
    setRegistry({ userId, adapters: stored });
    return () => { fileRead.current += 1; removeDialog.current?.destroy(); removeDialog.current = null; };
  }, [userId, form]);

  const close = () => {
    fileRead.current += 1; removeDialog.current?.destroy(); removeDialog.current = null;
    setOpen(false); setEditingId(''); form.resetFields();
    if (fileInput.current) fileInput.current.value = '';
  };
  const start = (adapter?: ClientAdapterManifest) => {
    fileRead.current += 1; form.resetFields(); setEditingId(adapter?.id || '');
    if (fileInput.current) fileInput.current.value = '';
    form.setFieldsValue({ manifest: jsonText(adapter || DEFAULT_CLIENT_ADAPTER) }); setOpen(true);
  };
  const persist = (next: ClientAdapterManifest[]) => {
    try { setRegistry({ userId, adapters: saveClientAdapters(localStorage, userId, next) }); return true; }
    catch (error) { void message.error(validationMessage(error)); return false; }
  };
  const validateManifest = (value: string) => {
    const adapter = parseClientAdapter(value);
    if (editingId && adapter.id !== editingId) throw new Error('编辑时不能更改适配器 id。请另行导入新的适配器。');
    if (adapters.some(item => item.id === adapter.id && item.id !== editingId)) throw new Error('此适配器 id 已存在，请编辑原配置或使用新的 id。');
    if (!editingId && adapters.length >= LIMIT) throw new Error('最多保存 12 个适配器，请先移除不再使用的配置。');
    return adapter;
  };
  const save = ({ manifest }: { manifest: string }) => {
    if (registry.userId !== userId) return;
    try {
      const adapter = validateManifest(manifest);
      const next = editingId ? adapters.map(item => item.id === editingId ? adapter : item) : [...adapters, adapter];
      if (persist(next)) { close(); void message.success(editingId ? '适配器已保存。' : '适配器已导入，可继续接入。'); }
    } catch (error) { form.setFields([{ name: 'manifest', errors: [validationMessage(error)] }]); }
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    if (fileInput.current) fileInput.current.value = '';
    const request = ++fileRead.current;
    const owner = userId;
    form.setFieldsValue({ manifest: '' });
    try {
      if (!/\.json$/i.test(file.name) || file.size > 8192) throw new Error('请选择不超过 8 KiB 的 JSON 文件。');
      const adapter = parseClientAdapter(await file.text());
      if (request !== fileRead.current || currentUser.current !== owner) return;
      form.setFieldsValue({ manifest: jsonText(adapter) });
      await form.validateFields(['manifest']);
    } catch (error) {
      if (request === fileRead.current && currentUser.current === owner && !(error && typeof error === 'object' && 'errorFields' in error)) form.setFields([{ name: 'manifest', errors: [validationMessage(error)] }]);
    } finally { if (fileInput.current && request === fileRead.current) fileInput.current.value = ''; }
  };
  const remove = (adapter: ClientAdapterManifest) => {
    const owner = userId;
    removeDialog.current?.destroy();
    removeDialog.current = modal.confirm({ title: `移除“${adapter.name}”？`, content: '仅移除此浏览器保存的适配器配置，不会撤销已授权设备，也不会修改本机配置文件。', okText: '移除', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => {
      if (owner === currentUser.current && currentRegistry.current.userId === owner && persist(currentRegistry.current.adapters.filter(item => item.id !== adapter.id))) void message.success('适配器配置已移除。');
    } });
  };

  return <Card className="tf-custom-adapters" title={<div className="tf-custom-adapters-title"><Typography.Title level={2}>自定义客户端</Typography.Title><Typography.Text type="secondary">通过 MCP 适配本地工作台与其他客户端。</Typography.Text></div>} extra={<Space className="tf-custom-adapter-toolbar" wrap size={8}><Button icon={<Download size={15} />} onClick={() => downloadAdapter(DEFAULT_CLIENT_ADAPTER)}>下载模板</Button><Button icon={<Plus size={15} />} disabled={adapters.length >= LIMIT} onClick={() => start()}>导入适配器</Button></Space>}>
    {adapters.length ? <ul className="tf-custom-adapters-list">{adapters.map(adapter => <li key={adapter.id}>
      <div className="tf-custom-adapter-identity"><span className="tf-custom-adapter-icon"><FileJson size={20} /></span><div><Typography.Text strong>{adapter.name}</Typography.Text><Typography.Text type="secondary">{adapter.configPath} · {adapter.serversKey}</Typography.Text></div></div>
      <div className="tf-custom-adapter-actions"><Button type="link" size="small" aria-label={`编辑${adapter.name}`} onClick={() => start(adapter)}>编辑</Button><Button type="link" size="small" aria-label={`导出${adapter.name}`} onClick={() => downloadAdapter(adapter)}>导出</Button><Button type="text" size="small" aria-label={`移除${adapter.name}`} onClick={() => remove(adapter)}>移除</Button><Button size="small" aria-label={`接入${adapter.name}`} icon={<ArrowRight size={14} />} iconPlacement="end" onClick={() => onConnect(adapter)}>接入</Button></div>
    </li>)}</ul> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有自定义客户端。下载模板，按客户端配置格式修改后导入。" />}
    <Typography.Paragraph type="secondary" className="tf-custom-adapters-note">配置仅保存在当前账号的本浏览器中。适配器不包含凭据；接入后仍需单独授权设备和项目。</Typography.Paragraph>
    <Modal title={editingId ? '编辑客户端适配器' : '导入客户端适配器'} open={open && registry.userId === userId} onCancel={close} onOk={() => form.submit()} okText={editingId ? '保存' : '导入'} cancelText="取消" width={640} forceRender className="tf-custom-adapter-modal">
      <Form form={form} layout="vertical" onFinish={save}>
        <Typography.Paragraph type="secondary">只描述项目内的配置文件路径和 MCP 根节点，不支持脚本或凭据。编辑时保留原 id。</Typography.Paragraph>
        <Button icon={<Upload size={15} />} onClick={() => fileInput.current?.click()}>选择 JSON 文件</Button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="选择客户端适配器 JSON 文件" onChange={event => void readFile(event.target.files?.[0])} />
        <Form.Item name="manifest" label="适配器 JSON" htmlFor="custom-client-manifest" rules={[{ required: true, message: '请填写适配器 JSON。' }, { validator: (_, value: string) => { try { validateManifest(value); return Promise.resolve(); } catch (error) { return Promise.reject(new Error(validationMessage(error))); } } }]} extra="文件和文本均限制为 8 KiB，最多保存 12 个适配器。"><Input.TextArea id="custom-client-manifest" className="tf-code-input" rows={11} maxLength={8192} autoComplete="off" spellCheck={false} onChange={() => { fileRead.current += 1; }} /></Form.Item>
      </Form>
    </Modal>
  </Card>;
};

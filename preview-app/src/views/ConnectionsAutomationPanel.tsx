import React, { useCallback, useEffect, useState } from 'react';
import { Alert, App, Badge, Button, Card, Descriptions, Divider, Drawer, Empty, Flex, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { Bell, Bot, Check, Copy, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';
import {
  api, ApiError, CloudAiConfig, hubApiUrl, ImChannel, ImEventType, ImNotificationConfig, ImNotificationLog,
  ProjectWebhook, Stage, STAGES, timeText, WebhookEvent,
} from './workspaceApi';
import { imChannelLabel, stageLabel, webhookProviderLabel } from './displayLabels';

const IM_EVENT_OPTIONS: { value: ImEventType; label: string }[] = [
  { value: 'REPORT_SUBMITTED', label: '评审报告提交' },
  { value: 'CRITICAL_BLOCKER', label: '阻断问题告警' },
  { value: 'DECISION_MADE', label: '审批放行 / 退回' },
  { value: 'WEBHOOK_TRIGGERED', label: 'Webhook 同步触发' },
  { value: 'MR_WRITEBACK', label: 'MR 意见回写' },
];

const IM_CHANNEL_OPTIONS: { value: ImChannel; label: string }[] = [
  { value: 'feishu', label: '飞书群机器人' },
  { value: 'dingtalk', label: '钉钉群机器人' },
  { value: 'wecom', label: '企业微信机器人' },
  { value: 'generic', label: '通用 JSON Webhook' },
];

const WEBHOOK_PROVIDER_OPTIONS: { value: 'gitlab' | 'confluence' | 'generic'; label: string }[] = [
  { value: 'gitlab', label: 'GitLab Merge Request / Push' },
  { value: 'confluence', label: 'Confluence 文档变更' },
  { value: 'generic', label: '通用研发 / 文档事件' },
];

export const ConnectionsAutomationPanel: React.FC<{
  projectId: string;
  canManage: boolean;
  onUnauthorized: () => void;
}> = ({ projectId, canManage, onUnauthorized }) => {
  const { message } = App.useApp();
  const [cloudForm] = Form.useForm();
  const [webhookForm] = Form.useForm();
  const [imForm] = Form.useForm();

  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [cloudConfig, setCloudConfig] = useState<CloudAiConfig | null>(null);
  const [webhooks, setWebhooks] = useState<ProjectWebhook[]>([]);
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>([]);
  const [notifications, setNotifications] = useState<ImNotificationConfig[]>([]);
  const [imLogs, setImLogs] = useState<ImNotificationLog[]>([]);

  const [webhookDrawerOpen, setWebhookDrawerOpen] = useState(false);
  const [createdHookSecret, setCreatedHookSecret] = useState<{ url: string; secret: string } | null>(null);
  const [imDrawerOpen, setImDrawerOpen] = useState(false);
  const [editingIm, setEditingIm] = useState<ImNotificationConfig | null>(null);

  const cloudProviderType = Form.useWatch('providerType', cloudForm) as 'openai_compatible' | 'dify' | undefined;

  const loadAll = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [cloudRes, hookRes, hookEventRes, imRes, imLogRes] = await Promise.all([
        api<{ config: CloudAiConfig | null }>(`projects/${encodeURIComponent(projectId)}/cloud-ai`),
        api<{ webhooks: ProjectWebhook[] }>(`projects/${encodeURIComponent(projectId)}/webhooks`),
        api<{ events: WebhookEvent[] }>(`projects/${encodeURIComponent(projectId)}/webhook-events`),
        api<{ notifications: ImNotificationConfig[] }>(`projects/${encodeURIComponent(projectId)}/notifications`),
        api<{ logs: ImNotificationLog[] }>(`projects/${encodeURIComponent(projectId)}/notification-logs`),
      ]);
      setCloudConfig(cloudRes.config);
      setWebhooks(hookRes.webhooks || []);
      setWebhookEvents(hookEventRes.events || []);
      setNotifications(imRes.notifications || []);
      setImLogs(imLogRes.logs || []);
      if (cloudRes.config) {
        cloudForm.setFieldsValue({
          providerType: cloudRes.config.providerType,
          name: cloudRes.config.name,
          baseUrl: cloudRes.config.baseUrl,
          model: cloudRes.config.model,
          difyMode: cloudRes.config.difyMode,
          enabled: cloudRes.config.enabled,
          autoStages: cloudRes.config.autoStages,
          autoWritebackMr: cloudRes.config.autoWritebackMr,
          timeoutMs: cloudRes.config.timeoutMs,
          apiKey: '',
        });
      } else {
        cloudForm.setFieldsValue({
          providerType: 'openai_compatible',
          name: 'DeepSeek / OpenAI 评审模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          difyMode: 'workflow',
          enabled: true,
          autoStages: ['PRD', 'TECH_SPEC', 'CODE_REVIEW'],
          autoWritebackMr: false,
          timeoutMs: 60000,
          apiKey: '',
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '加载自动化配置失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const copyText = (text: string, msg: string) => {
    void navigator.clipboard.writeText(text).then(() => message.success(msg)).catch(() => message.warning('请手动复制内容'));
  };

  const saveCloudAi = async (values: Record<string, unknown>) => {
    if (!canManage || busyAction) return;
    setBusyAction('cloud-save');
    try {
      const payload: Record<string, unknown> = {
        providerType: values.providerType,
        name: values.name,
        baseUrl: values.baseUrl,
        model: values.model || '',
        difyMode: values.difyMode || 'workflow',
        enabled: !!values.enabled,
        autoStages: values.autoStages || [],
        autoWritebackMr: !!values.autoWritebackMr,
        timeoutMs: Number(values.timeoutMs || 60000),
      };
      if (typeof values.apiKey === 'string' && values.apiKey.trim()) {
        payload.apiKey = values.apiKey.trim();
      }
      const res = await api<{ config: CloudAiConfig }>(`projects/${encodeURIComponent(projectId)}/cloud-ai`, payload, 'PUT');
      setCloudConfig(res.config);
      cloudForm.setFieldValue('apiKey', '');
      void message.success('云端 AI 执行器配置已加密保存。');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '保存云端 AI 配置失败');
    } finally {
      setBusyAction('');
    }
  };

  const testCloudAi = async () => {
    if (!canManage || busyAction) return;
    setBusyAction('cloud-test');
    try {
      const res = await api<{ config: CloudAiConfig }>(`projects/${encodeURIComponent(projectId)}/cloud-ai/test`, {});
      setCloudConfig(res.config);
      void message.success('云端 AI 接口连通性验证通过！');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '云端 AI 测试失败');
      await loadAll();
    } finally {
      setBusyAction('');
    }
  };

  const createWebhook = async (values: { provider: 'gitlab' | 'confluence' | 'generic'; name: string; autoReview: boolean; secret?: string }) => {
    if (!canManage || busyAction) return;
    setBusyAction('webhook-create');
    try {
      const res = await api<{ webhook: ProjectWebhook; secret: string }>(`projects/${encodeURIComponent(projectId)}/webhooks`, {
        provider: values.provider,
        name: values.name,
        autoReview: !!values.autoReview,
        ...(values.secret?.trim() ? { secret: values.secret.trim() } : {}),
      });
      setWebhooks(prev => [res.webhook, ...prev]);
      setWebhookDrawerOpen(false);
      webhookForm.resetFields();
      setCreatedHookSecret({
        url: `${hubApiUrl()}${res.webhook.webhookPath}`,
        secret: res.secret,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '创建 Webhook 失败');
    } finally {
      setBusyAction('');
    }
  };

  const toggleWebhook = async (hook: ProjectWebhook, field: 'enabled' | 'autoReview', value: boolean) => {
    if (!canManage || busyAction) return;
    setBusyAction(`hook-${hook.id}`);
    try {
      const res = await api<{ webhook: ProjectWebhook }>(`projects/${encodeURIComponent(projectId)}/webhooks/${hook.id}`, { [field]: value }, 'PATCH');
      setWebhooks(prev => prev.map(item => item.id === hook.id ? res.webhook : item));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '更新 Webhook 失败');
    } finally {
      setBusyAction('');
    }
  };

  const deleteWebhook = async (hook: ProjectWebhook) => {
    if (!canManage || busyAction) return;
    setBusyAction(`hook-del-${hook.id}`);
    try {
      await api(`projects/${encodeURIComponent(projectId)}/webhooks/${hook.id}`, undefined, 'DELETE');
      setWebhooks(prev => prev.filter(item => item.id !== hook.id));
      void message.success('Webhook 已删除。');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '删除 Webhook 失败');
    } finally {
      setBusyAction('');
    }
  };

  const saveIm = async (values: { channel: ImChannel; name: string; webhookUrl?: string; signingSecret?: string; events: ImEventType[]; enabled: boolean }) => {
    if (!canManage || busyAction) return;
    setBusyAction('im-save');
    try {
      if (editingIm) {
        const res = await api<{ notification: ImNotificationConfig }>(
          `projects/${encodeURIComponent(projectId)}/notifications/${editingIm.id}`,
          {
            name: values.name,
            events: values.events,
            enabled: !!values.enabled,
            ...(values.webhookUrl?.trim() ? { webhookUrl: values.webhookUrl.trim() } : {}),
            ...(values.signingSecret !== undefined ? { signingSecret: values.signingSecret.trim() } : {}),
          },
          'PATCH',
        );
        setNotifications(prev => prev.map(item => item.id === editingIm.id ? res.notification : item));
        void message.success('IM 通知机器人已更新。');
      } else {
        const res = await api<{ notification: ImNotificationConfig }>(
          `projects/${encodeURIComponent(projectId)}/notifications`,
          {
            channel: values.channel,
            name: values.name,
            webhookUrl: values.webhookUrl?.trim(),
            ...(values.signingSecret?.trim() ? { signingSecret: values.signingSecret.trim() } : {}),
            events: values.events,
            enabled: !!values.enabled,
          },
        );
        setNotifications(prev => [res.notification, ...prev]);
        void message.success('IM 通知机器人已保存。');
      }
      setImDrawerOpen(false);
      setEditingIm(null);
      imForm.resetFields();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else void message.error(error instanceof Error ? error.message : '保存 IM 通知失败');
    } finally {
      setBusyAction('');
    }
  };

  const testIm = async (item: ImNotificationConfig) => {
    if (!canManage || busyAction) return;
    setBusyAction(`im-test-${item.id}`);
    try {
      await api(`projects/${encodeURIComponent(projectId)}/notifications/${item.id}/test`, {});
      void message.success(`已向「${item.name}」发送测试通知！`);
      await loadAll();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '发送测试通知失败');
      await loadAll();
    } finally {
      setBusyAction('');
    }
  };

  const deleteIm = async (item: ImNotificationConfig) => {
    if (!canManage || busyAction) return;
    setBusyAction(`im-del-${item.id}`);
    try {
      await api(`projects/${encodeURIComponent(projectId)}/notifications/${item.id}`, undefined, 'DELETE');
      setNotifications(prev => prev.filter(n => n.id !== item.id));
      void message.success('IM 通知机器人已删除。');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setBusyAction('');
    }
  };

  const webhookColumns: TableColumnsType<ProjectWebhook> = [
    {
      title: '名称与来源',
      key: 'name',
      render: (_, row) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{row.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{webhookProviderLabel(row.provider)}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: '接收地址',
      key: 'path',
      render: (_, row) => {
        const fullUrl = `${hubApiUrl()}${row.webhookPath}`;
        return (
          <Space size={4}>
            <Typography.Text code style={{ fontSize: 11 }}>{row.webhookPath}</Typography.Text>
            <Button size="small" type="text" icon={<Copy size={13} />} onClick={() => copyText(fullUrl, '已复制 Webhook 地址')} />
          </Space>
        );
      },
    },
    {
      title: '自动触发 AI',
      width: 110,
      render: (_, row) => <Switch size="small" checked={row.autoReview} disabled={!canManage || !!busyAction} onChange={val => void toggleWebhook(row, 'autoReview', val)} />,
    },
    {
      title: '启用',
      width: 80,
      render: (_, row) => <Switch size="small" checked={row.enabled} disabled={!canManage || !!busyAction} onChange={val => void toggleWebhook(row, 'enabled', val)} />,
    },
    {
      title: '最近状态',
      width: 160,
      render: (_, row) => row.lastStatus
        ? <StatusBadge variant={row.lastStatus === 'PROCESSED' ? 'green' : row.lastStatus === 'FAILED' ? 'block' : 'neutral'}>{row.lastStatus}</StatusBadge>
        : <Typography.Text type="secondary">尚未触发</Typography.Text>,
    },
    ...(canManage ? [{
      title: '操作',
      width: 80,
      render: (_: unknown, row: ProjectWebhook) => <Button size="small" type="text" danger icon={<Trash2 size={14} />} onClick={() => void deleteWebhook(row)} />,
    }] : []),
  ];

  const imColumns: TableColumnsType<ImNotificationConfig> = [
    {
      title: '机器人名称 / 渠道',
      key: 'name',
      render: (_, row) => (
        <Flex vertical gap={2}>
          <Space size={6}>
            <Typography.Text strong>{row.name}</Typography.Text>
            <Tag color="blue">{imChannelLabel(row.channel)}</Tag>
          </Space>
          <Typography.Text type="secondary" code style={{ fontSize: 11 }}>{row.urlPreview}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: '订阅事件',
      key: 'events',
      render: (_, row) => (
        <Space size={[4, 4]} wrap>
          {row.events.map(ev => <Tag key={ev} style={{ marginInlineEnd: 0 }}>{IM_EVENT_OPTIONS.find(o => o.value === ev)?.label || ev}</Tag>)}
        </Space>
      ),
    },
    {
      title: '状态',
      width: 150,
      render: (_, row) => row.lastError
        ? <StatusBadge variant="block">发送失败</StatusBadge>
        : row.lastSentAt
          ? <StatusBadge variant="green">已连通</StatusBadge>
          : <StatusBadge variant="neutral">{row.enabled ? '已启用' : '已停用'}</StatusBadge>,
    },
    ...(canManage ? [{
      title: '操作',
      width: 180,
      render: (_: unknown, row: ImNotificationConfig) => (
        <Space size={4}>
          <Button size="small" icon={<Send size={13} />} loading={busyAction === `im-test-${itemId(row)}`} onClick={() => void testIm(row)}>测试</Button>
          <Button size="small" onClick={() => {
            setEditingIm(row);
            imForm.setFieldsValue({ channel: row.channel, name: row.name, events: row.events, enabled: row.enabled, webhookUrl: '', signingSecret: undefined });
            setImDrawerOpen(true);
          }}>编辑</Button>
          <Button size="small" type="text" danger icon={<Trash2 size={14} />} onClick={() => void deleteIm(row)} />
        </Space>
      ),
    }] : []),
  ];

  return (
    <Flex vertical gap={20}>
      <Card
        loading={loading}
        title={<Space size={8}><Bot size={18} /><span>云端评审</span>{cloudConfig?.enabled ? <Badge status="success" text="已启用" /> : <Badge status="default" text="未启用" />}</Space>}
        extra={<Space size={8}>
          <Button size="small" icon={<RefreshCw size={14} />} onClick={() => void loadAll()}>刷新</Button>
          {canManage && cloudConfig && (
            <Button size="small" icon={<Check size={14} />} loading={busyAction === 'cloud-test'} onClick={() => void testCloudAi()}>连通性测试</Button>
          )}
        </Space>}
      >
        <Flex vertical gap={14}>
          {cloudConfig?.lastCheckedAt && (
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
              { key: 'checked', label: '最近测试', children: timeText(cloudConfig.lastCheckedAt) },
              { key: 'result', label: '测试状态', children: cloudConfig.lastError ? <Typography.Text type="danger">{cloudConfig.lastError}</Typography.Text> : <StatusBadge variant="green">连通正常</StatusBadge> },
            ]} />
          )}
          {!canManage && cloudConfig && <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: 'name', label: '执行器', children: cloudConfig.name },
            { key: 'model', label: '模型', children: cloudConfig.model || cloudConfig.difyMode },
            { key: 'endpoint', label: '服务地址', children: <Typography.Text className="tf-break-anywhere">{cloudConfig.baseUrl}</Typography.Text> },
            { key: 'stages', label: '自动评审', children: cloudConfig.autoStages.map(stageLabel).join('、') || '—' },
          ]} />}
          {!canManage && !cloudConfig && <Typography.Text type="secondary">当前项目尚未配置云端评审。</Typography.Text>}
          {canManage && <Form form={cloudForm} layout="vertical" disabled={!canManage || !!busyAction} onFinish={values => void saveCloudAi(values)}>
            <div className="tf-connection-form-grid">
              <Form.Item name="providerType" label="接口协议" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'openai_compatible', label: 'OpenAI 兼容协议（OpenAI / DeepSeek / 通义 / OneAPI）' },
                  { value: 'dify', label: 'Dify Workflow / 对话应用 API' },
                ]} />
              </Form.Item>
              <Form.Item name="name" label="执行器名称" rules={[{ required: true, whitespace: true, message: '请填写执行器名称' }]}>
                <Input placeholder="例如：DeepSeek 代码与方案审查" maxLength={100} />
              </Form.Item>
            </div>
            <div className="tf-connection-form-grid">
              <Form.Item name="baseUrl" label="API 服务地址" rules={[{ required: true, whitespace: true, message: '请填写 HTTPS 服务地址' }]}>
                <Input placeholder="https://api.deepseek.com 或 https://dify.example.com/v1" autoComplete="off" />
              </Form.Item>
              {(cloudProviderType || 'openai_compatible') === 'openai_compatible' ? (
                <Form.Item name="model" label="模型名称" rules={[{ required: true, whitespace: true, message: '请填写模型名' }]}>
                  <Input placeholder="deepseek-chat / gpt-4o / qwen-plus" />
                </Form.Item>
              ) : (
                <Form.Item name="difyMode" label="Dify 应用类型" rules={[{ required: true }]}>
                  <Select options={[{ value: 'workflow', label: 'Workflow 工作流 (/v1/workflows/run)' }, { value: 'chat', label: '对话应用 (/v1/chat-messages)' }]} />
                </Form.Item>
              )}
            </div>
            <Form.Item
              name="apiKey"
              label="API Key"
              extra={cloudConfig?.hasCredential ? '已加密保存 API Key；保持同一服务地址时留空即可继续沿用。' : '请填写大模型或 Dify API Key。'}
              rules={[{ required: !cloudConfig?.hasCredential, message: '请填写 API Key' }]}
            >
              <Input.Password autoComplete="new-password" placeholder="sk-... 或 app-..." />
            </Form.Item>
            <div className="tf-connection-form-grid">
              <Form.Item name="autoStages" label="Webhook 自动触发评审阶段">
                <Select mode="multiple" options={STAGES} placeholder="选择自动评审阶段" />
              </Form.Item>
              <Form.Item name="timeoutMs" label="请求超时（毫秒）">
                <InputNumber min={5000} max={180000} step={5000} style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <Space size={24} wrap style={{ marginBottom: 16 }}>
              <Form.Item name="enabled" label="启用云端 AI" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Switch />
              </Form.Item>
              <Form.Item
                name="autoWritebackMr"
                label="代码评审完成后自动回写 GitLab / Codeup MR"
                valuePropName="checked"
                style={{ marginBottom: 0 }}
              >
                <Switch />
              </Form.Item>
            </Space>
            {canManage && (
              <div>
                <Button type="primary" htmlType="submit" loading={busyAction === 'cloud-save'}>保存云端 AI 配置</Button>
              </div>
            )}
          </Form>}
        </Flex>
      </Card>

      <Card
        title={<Space size={8}><Webhook size={18} /><span>Webhook</span></Space>}
        extra={canManage && (
          <Button size="small" type="primary" icon={<Plus size={14} />} onClick={() => {
            webhookForm.resetFields();
            webhookForm.setFieldsValue({ provider: 'gitlab', autoReview: true });
            setWebhookDrawerOpen(true);
          }}>新增 Webhook</Button>
        )}
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            按 Jira 任务号关联 GitLab 或 Confluence 事件，自动评审由各 Webhook 配置。
          </Typography.Text>
          <Table<ProjectWebhook>
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 620 }}
            dataSource={webhooks}
            columns={webhookColumns}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置自动触发 Webhook" /> }}
          />
          {webhookEvents.length > 0 && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              <Typography.Text strong style={{ fontSize: 13 }}>最近 Webhook 触发记录</Typography.Text>
              <Table<WebhookEvent>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5, hideOnSinglePage: true }}
                scroll={{ x: 560 }}
                dataSource={webhookEvents}
                columns={[
                  { title: '时间', dataIndex: 'createdAt', width: 170, render: val => timeText(val) },
                  { title: '来源', dataIndex: 'eventType', width: 120 },
                  { title: '状态', dataIndex: 'status', width: 110, render: val => <StatusBadge variant={val === 'PROCESSED' ? 'green' : val === 'FAILED' ? 'block' : 'neutral'}>{val}</StatusBadge> },
                  { title: '处理摘要', dataIndex: 'summary' },
                ]}
              />
            </>
          )}
        </Flex>
      </Card>

      <Card
        title={<Space size={8}><Bell size={18} /><span>群通知</span></Space>}
        extra={canManage && (
          <Button size="small" type="primary" icon={<Plus size={14} />} onClick={() => {
            setEditingIm(null);
            imForm.resetFields();
            imForm.setFieldsValue({
              channel: 'feishu',
              events: ['REPORT_SUBMITTED', 'CRITICAL_BLOCKER', 'DECISION_MADE'],
              enabled: true,
            });
            setImDrawerOpen(true);
          }}>新增 IM 机器人</Button>
        )}
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            群机器人按订阅的事件发送通知。
          </Typography.Text>
          <Table<ImNotificationConfig>
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 620 }}
            dataSource={notifications}
            columns={imColumns}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置 IM 通知机器人" /> }}
          />
          {imLogs.length > 0 && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              <Typography.Text strong style={{ fontSize: 13 }}>最近通知发送日志</Typography.Text>
              <Table<ImNotificationLog>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5, hideOnSinglePage: true }}
                scroll={{ x: 560 }}
                dataSource={imLogs}
                columns={[
                  { title: '时间', dataIndex: 'createdAt', width: 170, render: val => timeText(val) },
                  { title: '渠道', dataIndex: 'channel', width: 110, render: val => imChannelLabel(val) },
                  { title: '状态', dataIndex: 'status', width: 90, render: val => <StatusBadge variant={val === 'SENT' ? 'green' : 'block'}>{val}</StatusBadge> },
                  { title: '摘要 / 错误', render: (_, r) => r.error ? <Typography.Text type="danger">{r.error}</Typography.Text> : r.summary },
                ]}
              />
            </>
          )}
        </Flex>
      </Card>

      <Drawer
        title="新增自动触发 Webhook"
        open={webhookDrawerOpen}
        onClose={() => setWebhookDrawerOpen(false)}
        size={480}
        footer={<Flex justify="flex-end" gap={8}><Button onClick={() => setWebhookDrawerOpen(false)}>取消</Button><Button type="primary" loading={busyAction === 'webhook-create'} onClick={() => webhookForm.submit()}>创建</Button></Flex>}
      >
        <Form form={webhookForm} layout="vertical" onFinish={vals => void createWebhook(vals)}>
          <Form.Item name="provider" label="来源平台" rules={[{ required: true }]}><Select options={WEBHOOK_PROVIDER_OPTIONS} /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}><Input placeholder="例如：订单主仓库 GitLab MR" maxLength={100} /></Form.Item>
          <Form.Item name="secret" label="验签 Secret（留空将自动生成高强度随机密钥）"><Input maxLength={256} placeholder="用于 X-Gitlab-Token 或 X-Taskflow-Signature-256" /></Form.Item>
          <Form.Item name="autoReview" label="收到变更后自动触发云端 AI 评审" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Drawer>

      <Modal
        title="Webhook 已创建（密钥仅展示一次）"
        open={!!createdHookSecret}
        onOk={() => setCreatedHookSecret(null)}
        onCancel={() => setCreatedHookSecret(null)}
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        {createdHookSecret && (
          <Flex vertical gap={12}>
            <Alert type="warning" showIcon title="请立即保存此 Secret，关闭弹窗后服务端不再明文显示。" />
            <div>
              <Typography.Text strong>Webhook URL</Typography.Text>
              <Flex gap={6} style={{ marginTop: 4 }}>
                <Input readOnly value={createdHookSecret.url} />
                <Button icon={<Copy size={14} />} onClick={() => copyText(createdHookSecret.url, '已复制 URL')}>复制</Button>
              </Flex>
            </div>
            <div>
              <Typography.Text strong>Secret Token</Typography.Text>
              <Flex gap={6} style={{ marginTop: 4 }}>
                <Input readOnly value={createdHookSecret.secret} />
                <Button icon={<Copy size={14} />} onClick={() => copyText(createdHookSecret.secret, '已复制 Secret')}>复制</Button>
              </Flex>
            </div>
          </Flex>
        )}
      </Modal>

      <Drawer
        title={editingIm ? '编辑 IM 通知机器人' : '新增 IM 通知机器人'}
        open={imDrawerOpen}
        onClose={() => { setImDrawerOpen(false); setEditingIm(null); }}
        size={520}
        footer={<Flex justify="flex-end" gap={8}><Button onClick={() => { setImDrawerOpen(false); setEditingIm(null); }}>取消</Button><Button type="primary" loading={busyAction === 'im-save'} onClick={() => imForm.submit()}>保存</Button></Flex>}
      >
        <Form form={imForm} layout="vertical" onFinish={vals => void saveIm(vals)}>
          <Form.Item name="channel" label="IM 平台" rules={[{ required: true }]}><Select disabled={!!editingIm} options={IM_CHANNEL_OPTIONS} /></Form.Item>
          <Form.Item name="name" label="机器人名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}><Input placeholder="例如：核心交易研发评审群" maxLength={100} /></Form.Item>
          <Form.Item
            name="webhookUrl"
            label="Webhook 地址"
            extra={editingIm ? '留空表示沿用原地址（含密钥）；修改时请填完整地址。' : '支持飞书、钉钉、企业微信群机器人 Webhook URL。'}
            rules={[{ required: !editingIm, message: '请填写 Webhook URL' }]}
          >
            <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." autoComplete="off" />
          </Form.Item>
          <Form.Item name="signingSecret" label="加签密钥（可选，飞书/钉钉安全加签用）">
            <Input.Password autoComplete="new-password" placeholder={editingIm?.hasSigningSecret ? '已保存加签密钥（留空保留，输入覆盖）' : 'SEC...'} />
          </Form.Item>
          <Form.Item name="events" label="推送事件" rules={[{ required: true, message: '请至少选择一项事件' }]}>
            <Select mode="multiple" options={IM_EVENT_OPTIONS} />
          </Form.Item>
          <Form.Item name="enabled" label="启用通知" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Drawer>
    </Flex>
  );
};

function itemId(item: ImNotificationConfig) {
  return item.id;
}

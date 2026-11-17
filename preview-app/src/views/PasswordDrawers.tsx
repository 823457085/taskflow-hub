import React, { useEffect, useState } from 'react';
import { App, Button, Drawer, Flex, Form, Input, Typography } from 'antd';
import { api, ApiError } from './workspaceApi';
import { isSubmitShortcut } from './uiPreferences';

const lengthRule = { min: 8, max: 256, message: '密码需为 8–256 个字符。' };

const usePasswordSubmit = (open: boolean, onClose: () => void, onUnauthorized: () => void, onForbidden?: () => void) => {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) setBusy(false); }, [open]);
  const submit = async (request: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    try { await request(); void message.success(success); onClose(); }
    catch (error) {
      void message.error(error instanceof Error ? error.message : '请求失败。');
      if (error instanceof ApiError && error.status === 401) { onClose(); onUnauthorized(); }
      else if (error instanceof ApiError && error.status === 403) { onClose(); onForbidden?.(); }
    } finally { setBusy(false); }
  };
  return { busy, submit };
};

export const ChangePasswordDrawer: React.FC<{ open: boolean; username: string; onClose: () => void; onUnauthorized: () => void }> = ({ open, username, onClose, onUnauthorized }) => {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirmPassword: string }>();
  const { busy, submit } = usePasswordSubmit(open, onClose, onUnauthorized);
  useEffect(() => { if (!open) form.resetFields(); }, [open]);
  return <Drawer title="修改密码" size={480} open={open} onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy} forceRender footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} onClick={() => form.submit()}>保存新密码</Button></Flex>}>
    <Form form={form} name="change-own-password" layout="vertical" disabled={busy} onKeyDown={event => { if (isSubmitShortcut(event) && !busy) { event.preventDefault(); form.submit(); } }}
      onFinish={values => void submit(() => api('me/password', { currentPassword: values.currentPassword, newPassword: values.newPassword }), '密码已修改，其他浏览器上的登录已退出。')}>
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: '请输入当前密码。' }]}><Input.Password autoComplete="current-password" maxLength={256} /></Form.Item>
      <Form.Item label="新密码（8–256 字符）" name="newPassword" rules={[{ required: true, message: '请输入新密码。' }, lengthRule]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
      <Form.Item label="确认新密码" name="confirmPassword" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新密码。' }, ({ getFieldValue }) => ({ validator: (_, value) => !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致。')) })]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
      <Typography.Text type="secondary">修改后，当前页面保持登录，其他浏览器和命令行登录会失效；已配对的本机 Bridge 不受影响。</Typography.Text>
    </Form>
  </Drawer>;
};

export const ResetPasswordDrawer: React.FC<{ target: { id: string; username: string } | null; onClose: () => void; onUnauthorized: () => void; onForbidden?: () => void }> = ({ target, onClose, onUnauthorized, onForbidden }) => {
  const [form] = Form.useForm<{ password: string; confirmPassword: string }>();
  const open = !!target;
  const { busy, submit } = usePasswordSubmit(open, onClose, onUnauthorized, onForbidden);
  useEffect(() => { if (!open) form.resetFields(); }, [open]);
  return <Drawer title={target ? `重置「${target.username}」的密码` : '重置密码'} size={480} open={open} onClose={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy} forceRender footer={<Flex justify="flex-end" gap={8}><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" danger loading={busy} onClick={() => form.submit()}>重置密码</Button></Flex>}>
    <Form form={form} name="reset-member-password" layout="vertical" disabled={busy} onKeyDown={event => { if (isSubmitShortcut(event) && !busy) { event.preventDefault(); form.submit(); } }}
      onFinish={values => { if (target) void submit(() => api(`users/${encodeURIComponent(target.id)}/password`, { password: values.password }), `已重置「${target.username}」的密码。`); }}>
      <Form.Item label="新密码（8–256 字符）" name="password" rules={[{ required: true, message: '请输入新密码。' }, lengthRule]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
      <Form.Item label="确认新密码" name="confirmPassword" dependencies={['password']} rules={[{ required: true, message: '请再次输入新密码。' }, ({ getFieldValue }) => ({ validator: (_, value) => !value || value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致。')) })]}><Input.Password autoComplete="new-password" maxLength={256} /></Form.Item>
      <Typography.Text type="secondary">重置后，该成员的所有登录和已配对的本机 Bridge 都会失效，需要用新密码重新登录并重新配对。请通过安全渠道把新密码告诉对方。</Typography.Text>
    </Form>
  </Drawer>;
};

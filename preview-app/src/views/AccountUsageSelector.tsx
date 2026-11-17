import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Flex, Select, Typography } from 'antd';
import { api, ApiError } from './workspaceApi';
import type { AccountList } from './accountApi';

export const AccountUsageSelector: React.FC<{
  userId: string; projectId: string; provider: string; disabled?: boolean;
  onChanging?: () => void; onChanged: () => void | Promise<void>; onUnauthorized?: () => void; onForbidden?: () => void;
  onResolved?: (accountId: string | null | undefined) => void;
}> = ({ userId, projectId, provider, disabled = false, onChanging, onChanged, onUnauthorized, onForbidden, onResolved }) => {
  const { message } = App.useApp();
  const scope = JSON.stringify([userId, projectId, provider]);
  const latest = useRef(scope); latest.current = scope;
  const callbacks = useRef({ onChanging, onChanged, onUnauthorized, onForbidden, onResolved }); callbacks.current = { onChanging, onChanged, onUnauthorized, onForbidden, onResolved };
  const sequence = useRef(0); const pending = useRef(false);
  const [result, setResult] = useState<{ scope: string; data: AccountList }>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const fail = (error: unknown) => {
    void message.error(error instanceof Error ? error.message : '请求失败。');
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      sequence.current += 1; pending.current = false; setLoading(false); setResult(undefined); callbacks.current.onResolved?.(undefined);
      if (error.status === 401) callbacks.current.onUnauthorized?.(); else callbacks.current.onForbidden?.();
    }
  };
  useEffect(() => {
    const request = ++sequence.current; pending.current = false; setLoading(true); setResult(undefined);
    callbacks.current.onResolved?.(undefined);
    if (!projectId) { setLoading(false); return; }
    void api<AccountList>(`accounts?projectId=${encodeURIComponent(projectId)}&provider=${encodeURIComponent(provider)}`).then(data => {
      if (request === sequence.current && latest.current === scope) { setResult({ scope, data }); callbacks.current.onResolved?.(data.selectedAccountId); }
    }).catch(error => {
      if (request !== sequence.current || latest.current !== scope) return;
      fail(error);
    }).finally(() => { if (request === sequence.current && latest.current === scope) setLoading(false); });
    return () => { sequence.current += 1; pending.current = false; };
  }, [scope, reload]);
  const data = result?.scope === scope ? result.data : undefined;
  const selected = data?.selectedAccountId;
  const options = [{ value: '__project_default__', label: '使用项目默认连接' }, ...(data?.accounts || []).map(account => ({ value: account.id, label: `${account.name} · ${account.scope === 'PERSONAL' ? '个人' : '项目共享'}`, disabled: !account.canUse || !account.enabled }))];
  if (selected && !options.some(option => option.value === selected)) options.push({ value: selected, label: '原账号不可用，请重新选择', disabled: true });
  const change = async (value: string) => {
    if (disabled || pending.current || !data) return;
    const request = ++sequence.current; pending.current = true; setLoading(true); callbacks.current.onResolved?.(undefined); callbacks.current.onChanging?.();
    const current = () => request === sequence.current && latest.current === scope;
    try {
      const next = await api<AccountList>('accounts/select', { projectId, provider, accountId: value === '__project_default__' ? null : value });
      if (!current()) return;
      setResult({ scope, data: next }); void message.success('本项目的账号选择已保存。');
    } catch (error) {
      if (!current()) return;
      fail(error);
    } finally {
      if (current()) {
        try {
          const fresh = await api<AccountList>(`accounts?projectId=${encodeURIComponent(projectId)}&provider=${encodeURIComponent(provider)}`);
          if (!current()) return;
          setResult({ scope, data: fresh }); callbacks.current.onResolved?.(fresh.selectedAccountId);
        } catch (error) {
          if (!current()) return;
          setResult(undefined); callbacks.current.onResolved?.(undefined);
          fail(error);
        }
        if (!current()) return;
        pending.current = false; setLoading(false);
        try { await callbacks.current.onChanged(); } catch (error) { if (current()) void message.error(error instanceof Error ? error.message : '请求失败。'); }
      }
    }
  };
  return <Flex vertical gap={8} style={{ minWidth: 0 }}><Typography.Text>使用账号</Typography.Text><Select aria-label="使用账号" style={{ width: '100%' }} showSearch={{ optionFilterProp: 'label' }} loading={loading} disabled={disabled || loading || !data || !projectId} placeholder="读取可用账号" value={data ? selected || '__project_default__' : undefined} options={options} onChange={value => void change(value)} />{!data && !loading && projectId && <Button type="link" size="small" disabled={disabled} onClick={() => setReload(value => value + 1)}>重新读取账号</Button>}<Typography.Text type="secondary" style={{ fontSize: 12 }}>选择仅对你在此项目使用该平台时生效，其他成员的身份不变。</Typography.Text></Flex>;
};

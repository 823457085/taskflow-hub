import React, { useState } from 'react';
import { Check, KeyRound, Plus, Shield, Zap } from 'lucide-react';
import {
  ComputeAccountItem,
  INITIAL_ACCOUNTS,
  RoleKey,
  USER_ROLES,
  UserProfile,
} from '../data/mockPlatformData';
import { Modal, StatusBadge } from '../components/Primitives';

export const AccountAndRbacView: React.FC<{
  currentUser: UserProfile;
  onSwitchRole: (role: RoleKey) => void;
}> = ({ currentUser, onSwitchRole }) => {
  const [accounts, setAccounts] = useState<ComputeAccountItem[]>(INITIAL_ACCOUNTS);
  const [fallbackLog, setFallbackLog] = useState<string | null>(null);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [newAccName, setNewAccName] = useState('');
  const [newAccMode, setNewAccMode] =
    useState<ComputeAccountItem['authMode']>('Codex CLI OAuth (auth.json)');

  const handleSimulate429Fallback = () => {
    if (!currentUser.permissions.canManagePluginsAndPool) return;
    setAccounts((prev) =>
      prev.map((acc) => {
        if (acc.id === 'acc-zhangsan') {
          return { ...acc, status: 'RATE_LIMITED', quotaUsedPct: 100 };
        }
        if (acc.id === 'acc-team-pool-01') {
          return { ...acc, todayTasks: acc.todayTasks + 1, quotaUsedPct: Math.min(95, acc.quotaUsedPct + 4) };
        }
        return acc;
      })
    );
    setFallbackLog(
      '[路由演示] 已将示例个人账号标记为 429 冷却，并增加团队池的模拟任务计数。未请求外部服务，实际账号授权、额度检测与路由执行待后端接入。'
    );
  };

  const handleResetAccounts = () => {
    if (!currentUser.permissions.canManagePluginsAndPool) return;
    setAccounts(INITIAL_ACCOUNTS);
    setFallbackLog(null);
  };

  const handleBindAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccName.trim()) return;
    setAccounts((prev) => [
      {
        id: `acc-${Date.now()}`,
        name: newAccName.trim(),
        owner: currentUser.userName,
        scope: '个人托管 (BYOA)',
        authMode: newAccMode,
        model: '待配置',
        status: 'STANDBY',
        quotaUsedPct: 0,
        todayTasks: 0,
      },
      ...prev,
    ]);
    setNewAccName('');
    setBindModalOpen(false);
  };

  return (
    <div className="cc-animate-in space-y-8 max-w-[1380px] mx-auto">
      {/* Part 1: Multi-Account Codex CLI & API Compute Pool */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-semibold tracking-[-0.01em] text-[#0f172a]">
              多账号 Codex / AI 算力路由池 & 多角色权限矩阵
            </h1>
            <p className="text-[14px] text-[#64748b] mt-1">
              预览个人与团队账号的管理方式、路由策略和权限矩阵。下方账号、配额及任务量均为演示数据；当前不收集凭据，不连接外部 AI 服务。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleSimulate429Fallback}
              disabled={!currentUser.permissions.canManagePluginsAndPool}
              title={currentUser.permissions.canManagePluginsAndPool ? '仅修改演示数据' : '需要架构师或发布官角色'}
              className="cc-btn cc-btn-secondary"
            >
              <Zap className="w-4 h-4 text-[#1e40af]" />
              模拟个人号 429 限流自动切换兜底池
            </button>
            {fallbackLog && (
              <button
                type="button"
                onClick={handleResetAccounts}
                disabled={!currentUser.permissions.canManagePluginsAndPool}
                className="cc-btn cc-btn-ghost !text-[13px]"
              >
                恢复初始状态
              </button>
            )}
            <button
              type="button"
              onClick={() => setBindModalOpen(true)}
              className="cc-btn cc-btn-primary"
            >
              <Plus className="w-4 h-4" />
              添加个人账号别名
            </button>
          </div>
        </div>

        {fallbackLog && (
          <p role="status" className="text-[13px] text-[#64748b] leading-[1.6]">
            {fallbackLog}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {accounts.map((acc) => (
            <div key={acc.id} className="cc-card cc-card-hover p-5 space-y-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="cc-feature-icon">
                  <KeyRound className="w-5 h-5" />
                </div>
                {acc.status === 'ACTIVE' && <StatusBadge variant="green">示例：可用</StatusBadge>}
                {acc.status === 'RATE_LIMITED' && <StatusBadge variant="warn">示例：429 冷却</StatusBadge>}
                {acc.status === 'STANDBY' && <StatusBadge variant="neutral">未验证 / 待接入</StatusBadge>}
              </div>

              <div>
                <div className="text-[12px] font-medium text-[#1e40af]">{acc.scope} · 演示</div>
                <h3 className="text-[16px] font-semibold text-[#0f172a] mt-0.5">{acc.name}</h3>
                <div className="text-[12px] text-[#64748b] mt-0.5">{acc.authMode}</div>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-[#e5e7eb]">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-[#64748b]">演示配额消耗</span>
                  <span className="font-mono font-medium text-[#0f172a]">{acc.quotaUsedPct}%</span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[#e5e7eb] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{
                      width: `${acc.quotaUsedPct}%`,
                      backgroundColor: acc.status === 'RATE_LIMITED' ? '#dc2626' : '#3b82f6',
                    }}
                  />
                </div>
                <div className="flex items-center justify-between text-[12px] text-[#64748b] pt-1">
                  <span className="font-mono">{acc.model}</span>
                  <span>模拟任务 {acc.todayTasks} 次</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Part 2: Multi-User SSO & RBAC Permission Control Matrix */}
      <div className="cc-card p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] pb-4">
          <div className="flex items-center gap-2.5">
            <Shield className="w-5 h-5 text-[#1e40af]" />
            <div>
              <h2 className="text-[18px] font-semibold text-[#0f172a]">
                角色权限矩阵（交互预览）
              </h2>
              <p className="text-[13px] text-[#64748b]">
                切换演示角色，体验评审、门禁豁免及上线操作的权限差异。此切换不代表真实登录或服务端授权。
              </p>
            </div>
          </div>
          <StatusBadge variant="blue">当前演示：{currentUser.userName}</StatusBadge>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-[#e5e7eb] bg-[#f8fafc] text-[#64748b]">
                <th className="py-3 px-4 font-medium">系统角色身份</th>
                <th className="py-3 px-4 font-medium">代表成员</th>
                <th className="py-3 px-4 font-medium">发起各阶段 AI 评审</th>
                <th className="py-3 px-4 font-medium">代码/方案阻断门禁豁免权</th>
                <th className="py-3 px-4 font-medium">测试准出签字权</th>
                <th className="py-3 px-4 font-medium">生产环境一键编排发布权</th>
                <th className="py-3 px-4 font-medium text-right">快速体验身份切换</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e5e7eb]">
              {(Object.keys(USER_ROLES) as RoleKey[]).map((rk) => {
                const r = USER_ROLES[rk];
                const isCurrent = currentUser.roleKey === rk;
                return (
                  <tr
                    key={rk}
                    className={isCurrent ? 'bg-[#eff6ff]/60' : 'hover:bg-[#f8fafc]'}
                  >
                    <td className="py-3.5 px-4 font-semibold text-[#0f172a]">{r.roleLabel}</td>
                    <td className="py-3.5 px-4 text-[#64748b]">{r.userName}</td>
                    <td className="py-3.5 px-4">
                      {r.permissions.canTriggerReview ? (
                        <StatusBadge variant="green">允许</StatusBadge>
                      ) : (
                        <StatusBadge variant="neutral">只读</StatusBadge>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      {r.permissions.canOverrideGate ? (
                        <StatusBadge variant="blue">允许 (强审计留痕)</StatusBadge>
                      ) : (
                        <span className="text-[#64748b]">禁止</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      {r.permissions.canApproveTestCase ? (
                        <StatusBadge variant="green">拥有准出权</StatusBadge>
                      ) : (
                        <span className="text-[#64748b]">—</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      {r.permissions.canExecuteRelease ? (
                        <StatusBadge variant="green">唯一生产执行权</StatusBadge>
                      ) : (
                        <span className="text-[#64748b]">锁定禁止</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => onSwitchRole(rk)}
                        className={`cc-btn !py-1 !px-3 !text-[12px] ${
                          isCurrent ? 'cc-btn-primary' : 'cc-btn-secondary'
                        }`}
                      >
                        {isCurrent && <Check className="w-3.5 h-3.5" />}
                        {isCurrent ? '当前演示角色' : '切换为此角色'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bind Personal Codex Account Modal (<= 640px Single Column) */}
      <Modal
        open={bindModalOpen}
        title="添加个人 AI 账号别名（演示）"
        subtitle="仅保存本次页面会话中的显示名称和计划接入方式。请勿填写 API Key、密码或登录态文件。"
        onClose={() => setBindModalOpen(false)}
      >
        <form onSubmit={handleBindAccount} className="space-y-4">
          <div>
            <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
              账号别名 <span className="text-[#dc2626]">*</span>
            </label>
            <input
              id="account-alias"
              aria-label="账号别名"
              maxLength={80}
              autoComplete="off"
              className="cc-input"
              placeholder={`例如：${currentUser.userName.split(' ')[0]} 的个人 Codex Pro 账号`}
              value={newAccName}
              onChange={(e) => setNewAccName(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
              计划接入方式（未验证）
            </label>
            <select
              aria-label="计划接入方式"
              className="cc-input"
              value={newAccMode}
              onChange={(e) => setNewAccMode(e.target.value as ComputeAccountItem['authMode'])}
            >
              <option value="Codex CLI OAuth (auth.json)">
                Codex CLI 登录接入（待实现）
              </option>
              <option value="OpenAI / 网关 API Key">OpenAI / 企业内部转发网关 API Key</option>
              <option value="Claude Code Enterprise Key">Claude Code / Anthropic API Key</option>
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setBindModalOpen(false)}
              className="cc-btn cc-btn-secondary"
            >
              取消
            </button>
            <button type="submit" className="cc-btn cc-btn-primary">
              添加演示别名
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

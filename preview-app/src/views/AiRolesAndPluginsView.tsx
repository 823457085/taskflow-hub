import React, { useState } from 'react';
import { Bot, Blocks, Check, Plus, TerminalSquare } from 'lucide-react';
import {
  AiRoleAgent,
  CLOUD_AI_ROLES,
  CustomPluginItem,
  INITIAL_PLUGINS,
  UserProfile,
} from '../data/mockPlatformData';
import { Modal, StatusBadge } from '../components/Primitives';

export const AiRolesAndPluginsView: React.FC<{ currentUser: UserProfile }> = ({ currentUser }) => {
  const [selectedRole, setSelectedRole] = useState<AiRoleAgent>(CLOUD_AI_ROLES[2]);
  const [plugins, setPlugins] = useState<CustomPluginItem[]>(INITIAL_PLUGINS);
  const [pluginModalOpen, setPluginModalOpen] = useState(false);
  const [newPluginName, setNewPluginName] = useState('');
  const [newPluginStage, setNewPluginStage] = useState('代码审核 / 需求上线');
  const [newPluginRuntime, setNewPluginRuntime] =
    useState<CustomPluginItem['runtime']>('CODEX_SKILL_MCP');

  const togglePlugin = (id: string) => {
    if (!currentUser.permissions.canManagePluginsAndPool) return;
    setPlugins((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))
    );
  };

  const handleAddPlugin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser.permissions.canManagePluginsAndPool || !newPluginName.trim() || !newPluginStage.trim()) return;
    setPlugins((prev) => [
      {
        id: `custom-${Date.now()}`,
        name: newPluginName.trim(),
        runtime: newPluginRuntime,
        boundStage: newPluginStage,
        hook: 'ON_STAGE_REVIEW',
        author: '当前团队自定义',
        enabled: true,
        isBeta: true,
        blockSeverity: 'CRITICAL 阻断',
        description: '本次会话新建的插件配置草稿；尚未部署、执行或同步到本地工具。',
      },
      ...prev,
    ]);
    setNewPluginName('');
    setPluginModalOpen(false);
  };

  return (
    <div className="cc-animate-in space-y-8 max-w-[1380px] mx-auto">
      {/* Section 1: Cloud Role-Based AI Digital Employees */}
      <div className="space-y-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.01em] text-[#0f172a]">
            云端多身份角色 AI 数字员工 & 自定义插件库
          </h1>
          <p className="text-[14px] text-[#64748b] mt-1">
            预览云端 AI 的角色、Skills 与工具授权配置。以下为设计示例，尚未部署运行时或执行插件。
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {CLOUD_AI_ROLES.map((role) => {
            const active = selectedRole.id === role.id;
            return (
              <button
                type="button"
                aria-pressed={active}
                key={role.id}
                onClick={() => setSelectedRole(role)}
                className={`cc-card cc-card-hover p-5 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b82f6] ${
                  active ? '!border-[#3b82f6] ring-2 ring-[#3b82f6]/20' : ''
                }`}
              >
                <div className="cc-feature-icon">
                  <Bot className="w-5 h-5" />
                </div>
                <div className="mt-3.5">
                  <div className="font-mono text-[12px] text-[#1e40af]">{role.handle}</div>
                  <h3 className="text-[16px] font-semibold text-[#0f172a] mt-0.5">{role.name}</h3>
                  <p className="text-[12px] text-[#64748b] mt-1">{role.stageLabel}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Selected AI Role Detail Card */}
        <div className="cc-card p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e5e7eb] pb-3">
              <div>
                <h2 className="text-[18px] font-semibold text-[#0f172a]">
                  {selectedRole.name} ({selectedRole.handle}) — 绑定模块化 Skills
                </h2>
                <p className="text-[13px] text-[#64748b] mt-0.5">{selectedRole.description}</p>
              </div>
              <StatusBadge variant="blue">{selectedRole.skills.length} 个核心 Skill</StatusBadge>
            </div>

            <div className="space-y-2.5">
              {selectedRole.skills.map((skill) => (
                <div
                  key={skill.id}
                  className="rounded-[8px] border border-[#e5e7eb] p-3.5 flex flex-wrap items-center justify-between gap-3 bg-[#f8fafc]"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] font-semibold text-[#1e40af]">
                        {skill.id}
                      </span>
                      <span className="text-[14px] font-medium text-[#0f172a]">{skill.name}</span>
                    </div>
                    <p className="text-[12px] text-[#64748b] mt-0.5">{skill.desc}</p>
                  </div>
                  {skill.syncedToLocal ? (
                    <StatusBadge variant="green">计划同步至本地 IDE</StatusBadge>
                  ) : (
                    <StatusBadge variant="neutral">计划仅云端执行</StatusBadge>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-5 space-y-4 border-t lg:border-t-0 lg:border-l border-[#e5e7eb] pt-4 lg:pt-0 lg:pl-6">
            <h3 className="text-[15px] font-semibold text-[#0f172a]">角色沙箱与 MCP 权限设计</h3>
            <div className="space-y-3 text-[13px]">
              <div className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-3">
                <div className="text-[#64748b] text-[12px]">默认算力池路由策略</div>
                <div className="font-medium text-[#0f172a] mt-0.5">{selectedRole.accountStrategy}</div>
              </div>
              <div className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-3">
                <div className="text-[#64748b] text-[12px]">执行环境隔离级别</div>
                <div className="font-mono text-[#0f172a] mt-0.5">{selectedRole.sandboxMode}</div>
              </div>
              <div className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-3">
                <div className="text-[#64748b] text-[12px] mb-2">计划允许的 MCP 工具</div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedRole.allowedMcpTools.map((tool) => (
                    <span
                      key={tool}
                      className="font-mono text-[11px] px-2 py-1 rounded bg-[#ffffff] border border-[#e5e7eb] text-[#1e40af]"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: Extensible Custom Plugin Ecosystem */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[22px] font-semibold text-[#0f172a]">
              可扩展自定义插件市场 (Plugin Ecosystem)
            </h2>
            <p className="text-[14px] text-[#64748b]">
              演示 Skill/MCP、容器脚本、Webhook 与 UI 插件的配置。需架构师或发布官角色才能新增、启停；当前不执行插件。
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (currentUser.permissions.canManagePluginsAndPool) setPluginModalOpen(true); }}
            disabled={!currentUser.permissions.canManagePluginsAndPool}
            title={currentUser.permissions.canManagePluginsAndPool ? '创建本次会话的配置草稿' : '需要架构师或发布官角色'}
            className="cc-btn cc-btn-primary"
          >
            <Plus className="w-4 h-4" />
            新建插件配置
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {plugins.map((plg) => (
            <div key={plg.id} className="cc-card cc-card-hover p-6 flex flex-col justify-between gap-4">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="cc-feature-icon">
                      <Blocks className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-[17px] font-semibold text-[#0f172a]">{plg.name}</h3>
                        {plg.isBeta && <StatusBadge variant="violet">实验性插件</StatusBadge>}
                      </div>
                      <div className="font-mono text-[12px] text-[#64748b]">
                        Runtime: {plg.runtime} · Hook: {plg.hook}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => togglePlugin(plg.id)}
                    disabled={!currentUser.permissions.canManagePluginsAndPool}
                    aria-pressed={plg.enabled}
                    aria-label={`${plg.name}：${plg.enabled ? '已启用（演示）' : '已停用（演示）'}`}
                    className={`cc-btn !py-1 !px-3 !text-[12px] ${
                      plg.enabled ? 'cc-btn-primary' : 'cc-btn-secondary'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                    {plg.enabled ? '已启用（演示）' : '已停用（演示）'}
                  </button>
                </div>

                <p className="text-[14px] text-[#64748b] leading-[1.6]">{plg.description}</p>
              </div>

              <div className="pt-3 border-t border-[#e5e7eb] flex flex-wrap items-center justify-between gap-2 text-[12px] text-[#64748b]">
                <span>绑定阶段：<strong className="text-[#0f172a] font-medium">{plg.boundStage}</strong></span>
                <span>门禁策略：<strong className="text-[#1e40af] font-medium">{plg.blockSeverity}</strong></span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Register Custom Plugin Modal (Single-Column <= 640px per Corporate Clean Spec) */}
      <Modal
        open={pluginModalOpen}
        title="新建流程插件配置（演示）"
        subtitle="创建配置草稿并预览阶段绑定，不会安装、执行插件或发送 Webhook。"
        onClose={() => setPluginModalOpen(false)}
      >
        <form onSubmit={handleAddPlugin} className="space-y-4">
          <div>
            <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
              插件名称 <span className="text-[#dc2626]">*</span>
            </label>
            <input
              aria-label="插件名称"
              maxLength={80}
              className="cc-input"
              placeholder="例如：OpenAPI 破坏性变更检测器 / 内部安全红线扫描"
              value={newPluginName}
              onChange={(e) => setNewPluginName(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
                插件运行时类型
              </label>
              <select
                aria-label="插件运行时类型"
                className="cc-input"
                value={newPluginRuntime}
                onChange={(e) =>
                  setNewPluginRuntime(e.target.value as CustomPluginItem['runtime'])
                }
              >
                <option value="CODEX_SKILL_MCP">CODEX_SKILL_MCP (注入 Skill 与 MCP)</option>
                <option value="CONTAINER_RUNNER">CONTAINER_RUNNER (Docker 脚本检查)</option>
                <option value="WEBHOOK">WEBHOOK (远程审批/通知服务)</option>
                <option value="UI_WIDGET">UI_WIDGET (作战室嵌入微卡片)</option>
              </select>
            </div>
            <div>
              <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
                挂载管控阶段
              </label>
              <input
                aria-label="挂载管控阶段"
                required
                className="cc-input"
                value={newPluginStage}
                onChange={(e) => setNewPluginStage(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-3 font-mono text-[12px] text-[#0f172a]">
            <div className="flex items-center gap-1.5 text-[#64748b] mb-1">
              <TerminalSquare className="w-3.5 h-3.5 text-[#1e40af]" />
              自动生成的声明式挂载预览:
            </div>
            {`kind: Plugin | runtime: ${newPluginRuntime} | stage: "${newPluginStage}"`}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setPluginModalOpen(false)}
              className="cc-btn cc-btn-secondary"
            >
              取消
            </button>
            <button type="submit" className="cc-btn cc-btn-primary">
              保存并启用演示配置
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

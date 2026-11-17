import React, { useState } from 'react';
import { Check, Copy, Laptop, RefreshCw, Terminal } from 'lucide-react';
import { StatusBadge } from '../components/Primitives';

type LocalToolKey = 'CODEX' | 'CLAUDE_CODE' | 'CURSOR';

const TOOL_CONFIGS: Record<
  LocalToolKey,
  {
    label: string;
    initCmd: string;
    configPath: string;
    rulesSyncTarget: string;
    configPreview: string;
    usageExample: string;
  }
> = {
  CODEX: {
    label: 'Codex App / Codex CLI',
    initCmd: 'rd-cli init --tool codex --space trade-core',
    configPath: '~/.codex/config.toml',
    rulesSyncTarget: './AGENTS.md & ./.agents/skills/*',
    configPreview: `[mcp_servers.rd_platform]
url = "https://rd-hub.example.invalid/mcp"
bearer_token_env_var = "RD_HUB_PAT"

# 配置示意：需平台 MCP 服务与凭据环境变量，当前未接入`,
    usageExample: `codex "认领我的 Jira 任务 ORD-204，拉取已锁定的前后端接口契约开始实现拆单逻辑，完成后同步进度"`,
  },
  CLAUDE_CODE: {
    label: 'Claude Code',
    initCmd: 'rd-cli init --tool claude --space trade-core',
    configPath: './.mcp.json & ./.claude/commands/*',
    rulesSyncTarget: './CLAUDE.md & ./.claude/skills/*',
    configPreview: `{
  "mcpServers": {
    "rd-platform": {
      "type": "http",
      "url": "https://rd-hub.example.invalid/mcp",
      "headers": { "Authorization": "Bearer \${RD_HUB_PAT}" }
    }
  }
}`,
    usageExample: `> /task-start ORD-204   # 自动切分支、更新 Jira 为开发中、注入 PRD 与黄金 API 契约\n> /fix-cr ORD-204       # 拉取云端 AI 代码审查官在 GitLab MR 上的报错行号并本地修复`,
  },
  CURSOR: {
    label: 'Cursor IDE',
    initCmd: 'rd-cli init --tool cursor --space trade-core',
    configPath: './.cursor/mcp.json',
    rulesSyncTarget: './.cursor/rules/corp-contract.mdc',
    configPreview: `{
  "mcpServers": {
    "rd-platform": {
      "url": "https://rd-hub.example.invalid/mcp",
      "headers": { "Authorization": "Bearer \${RD_HUB_PAT}" }
    }
  }
}`,
    usageExample: `在 Cursor Agent 中输入：调用 rd-platform 拉取 ORD-203 前端任务上下文，并上报当前拆单预览组件进度 100%`,
  },
};

export const LocalBridgeView: React.FC = () => {
  const [activeTool, setActiveTool] = useState<LocalToolKey>('CLAUDE_CODE');
  const [autoSyncSkills, setAutoSyncSkills] = useState(true);
  const [gitHookGuard, setGitHookGuard] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const cfg = TOOL_CONFIGS[activeTool];

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(cfg.initCmd);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2400);
  };

  return (
    /* Strictly <= 640px Single-Column Centered Form & Config Layout per StyleKit Corporate Clean Spec */
    <div className="cc-animate-in max-w-[640px] mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-[26px] font-semibold tracking-[-0.01em] text-[#0f172a]">
            连接本地 AI 编程工具
          </h1>
          <StatusBadge variant="green" pulse>接入设计预览</StatusBadge>
        </div>
        <p className="text-[14px] text-[#64748b] mt-1.5 leading-[1.6]">
          预览 Codex、Codex CLI、Claude Code 与 Cursor 的接入方式。命令、MCP 地址与设备状态为示例；尚未连接本机工具或云端服务。
        </p>
      </div>

      {/* Tool Selector Card */}
      <div className="cc-card p-6 space-y-5">
        <div>
          <label className="block text-[14px] font-medium text-[#0f172a] mb-2">
            1. 选择您本地使用的 AI 编程软件
          </label>
          <div className="grid grid-cols-3 gap-2.5">
            {(Object.keys(TOOL_CONFIGS) as LocalToolKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => { setActiveTool(key); setCopyState('idle'); }}
                aria-pressed={activeTool === key}
                className={`cc-btn !py-2.5 !px-3 !text-[13px] ${
                  activeTool === key ? 'cc-btn-primary' : 'cc-btn-secondary'
                }`}
              >
                {TOOL_CONFIGS[key].label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[14px] font-medium text-[#0f172a] mb-1.5">
            2. 桥接命令设计示意（尚未实现，请勿执行）
          </label>
          <div className="flex items-center gap-2">
            <input aria-label="桥接命令示意" readOnly value={cfg.initCmd} className="cc-input font-mono !text-[12px] bg-[#f8fafc]" />
            <button type="button" onClick={handleCopy} className="cc-btn cc-btn-primary shrink-0">
              {copyState === 'copied' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copyState === 'copied' ? '已复制示意' : '复制示意'}
            </button>
          </div>
          <p role="status" aria-live="polite" className="text-[12px] text-[#64748b] mt-1.5">
            {copyState === 'failed' ? '复制失败，请手动选择命令文本。' : copyState === 'copied' ? '示意命令已复制，当前不可执行。' : '此页面不会修改本地文件。'}
          </p>
          <p className="text-[12px] text-[#64748b] mt-1.5">
            计划配置位置： <code className="font-mono text-[#0f172a]">{cfg.configPath}</code> ；规则位置：{' '}
            <code className="font-mono text-[#0f172a]">{cfg.rulesSyncTarget}</code>
          </p>
        </div>

        <div>
          <div className="text-[13px] font-medium text-[#0f172a] mb-1.5">
            MCP 配置设计示意
          </div>
          <pre className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-3.5 font-mono text-[12px] text-[#0f172a] overflow-x-auto leading-[1.6]">
            {cfg.configPreview}
          </pre>
        </div>

        <div>
          <div className="text-[13px] font-medium text-[#0f172a] mb-1.5 flex items-center gap-1.5">
            <Terminal className="w-4 h-4 text-[#1e40af]" />
            本地任务协同对话示意
          </div>
          <pre className="rounded-[8px] bg-[#f8fafc] border border-[#e5e7eb] p-3.5 font-mono text-[12px] text-[#1e40af] whitespace-pre-wrap leading-[1.6]">
            {cfg.usageExample}
          </pre>
        </div>
      </div>

      {/* Sync Guardrails Single-Column Settings Card */}
      <div className="cc-card p-6 space-y-4">
        <h2 className="text-[18px] font-semibold text-[#0f172a]">本地与云端同步策略（演示开关）</h2>

        <div className="flex items-start justify-between gap-4 py-2 border-b border-[#e5e7eb]">
          <div>
            <div className="text-[14px] font-medium text-[#0f172a]">
              云端审查 Skills 自动同步至本地编码规则
            </div>
            <p className="text-[12px] text-[#64748b] mt-0.5">
              用于预览团队规则同步的开关状态；真实的版本同步与本地文件更新待桥接服务接入。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAutoSyncSkills(!autoSyncSkills)}
            aria-pressed={autoSyncSkills}
            aria-label="Skills 自动同步策略"
            className={`cc-btn !py-1 !px-3 !text-[12px] ${
              autoSyncSkills ? 'cc-btn-primary' : 'cc-btn-secondary'
            }`}
          >
            {autoSyncSkills ? '演示开启' : '演示关闭'}
          </button>
        </div>

        <div className="flex items-start justify-between gap-4 py-2">
          <div>
            <div className="text-[14px] font-medium text-[#0f172a]">
              本地 Git Pre-push 强制校验 Jira 任务号 & 自动上报进度心跳
            </div>
            <p className="text-[12px] text-[#64748b] mt-0.5">
              用于预览提交校验与心跳上报策略；当前不安装 Git Hook、不拦截提交，也不读取本地会话。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setGitHookGuard(!gitHookGuard)}
            aria-pressed={gitHookGuard}
            aria-label="Git 任务校验策略"
            className={`cc-btn !py-1 !px-3 !text-[12px] ${
              gitHookGuard ? 'cc-btn-primary' : 'cc-btn-secondary'
            }`}
          >
            {gitHookGuard ? '演示开启' : '演示关闭'}
          </button>
        </div>
      </div>

      {/* Active Connected Local Sessions */}
      <div className="cc-card p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-[#0f172a]">团队本地会话示例（静态数据）</h2>
          <RefreshCw className="w-4 h-4 text-[#64748b]" />
        </div>
        <div className="divide-y divide-[#e5e7eb] text-[13px]">
          {[
            { user: '张三', tool: 'Claude Code', task: 'ORD-204 (85%)', beat: '12 秒前' },
            { user: '陈晨', tool: 'Cursor IDE', task: 'ORD-203 (100%)', beat: '2 分钟前' },
            { user: '李四', tool: 'Codex CLI', task: 'USR-313 (60%)', beat: '1 分钟前' },
          ].map((sess) => (
            <div key={sess.user} className="py-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Laptop className="w-4 h-4 text-[#10b981]" />
                <span className="font-medium text-[#0f172a]">{sess.user}</span>
                <span className="text-[#64748b]">· {sess.tool}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[12px] text-[#1e40af]">{sess.task}</span>
                <span className="text-[12px] text-[#64748b]">{sess.beat}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

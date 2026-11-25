export type AiRunStepKind = 'context' | 'scan' | 'search' | 'read' | 'git' | 'test' | 'command';

export interface AiRunProgressStep {
  id: string;
  kind: AiRunStepKind;
  title: string;
  detail?: string;
  duration?: string;
  status: 'done' | 'failed' | 'running';
}

export interface ParsedAiRunOutput {
  currentActivity: string;
  steps: AiRunProgressStep[];
  totalSteps: number;
  latestThought: string;
  finalMarkdown: string;
  hasRawNoise: boolean;
}

export interface ParseAiRunOptions {
  status: string;
  mode?: string;
  actionType?: string;
  runner?: string;
  bridgePhase?: string | null;
  draftAnswer?: string;
  hasReviewDraft?: boolean;
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const HEADER_RE = /^(?:OpenAI Codex v|-{4,}|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|mcp startup:|mcp:)/i;
const HOOK_RE = /^hook:\s*/i;
const RESULT_RE = /^\s*(succeeded|exited(?:\s+(-?\d+))?)\s+in\s+([0-9.]+(?:ms|s|m)):/i;
const RUNS_PATH_RE = /\/[^\s"'`]*?\/\.runs\/[0-9a-f-]{8,}\/?/gi;
const FILE_RE = /(?:^|[\s"'`(\/])([A-Za-z0-9_.-]+\.(?:vue|tsx?|jsx?|mjs|cjs|less|scss|css|json|md|yml|yaml|sql|sh))\b/gi;

function unwrapShellCommand(raw: string): string {
  let cmd = raw.trim().replace(/\s+in\s+\/[^\r\n]+$/, '').trim();
  const shellMatch = cmd.match(/^\/(?:usr\/)?bin\/(?:zsh|bash|sh)\s+-[a-z]*c\s+([\s\S]+)$/i);
  if (shellMatch) {
    cmd = shellMatch[1].trim();
    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      cmd = cmd.slice(1, -1).replace(/\\(["'`$\\])/g, '$1');
    }
  }
  return cmd.replace(RUNS_PATH_RE, '').trim();
}

function extractFileBasenames(cmd: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  FILE_RE.lastIndex = 0;
  while ((match = FILE_RE.exec(cmd)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
      if (names.length >= 3) break;
    }
  }
  return names;
}

function classifyCommand(rawCmd: string): { kind: AiRunStepKind; title: string; detail?: string } {
  const cmd = unwrapShellCommand(rawCmd);
  const files = extractFileBasenames(cmd);
  const fileSummary = files.length ? files.join('、') : undefined;

  if (/\bcontext\.json\b/i.test(cmd) && !/\b(?:rg|grep)\s+--files\b/i.test(cmd)) {
    return { kind: 'context', title: '读取任务上下文与冻结快照', detail: fileSummary || 'context.json' };
  }
  if (/\b(?:node\s+--test|npm\s+(?:run\s+)?(?:test|build)|pnpm\s+(?:run\s+)?(?:test|build)|vitest|jest|tsc\b|vite\s+build|eslint)\b/i.test(cmd)) {
    return { kind: 'test', title: '运行测试与编译校验', detail: fileSummary };
  }
  if (/\bgit\s+(?:diff|log|show|status|rev-parse|branch)\b/i.test(cmd)) {
    const sub = cmd.match(/\bgit\s+(diff|log|show|status|rev-parse|branch)\b/i)?.[1]?.toLowerCase();
    const labelMap: Record<string, string> = {
      diff: '代码 Diff',
      log: '提交历史',
      show: '提交详情',
      status: '工作区状态',
      branch: '分支信息',
      'rev-parse': '提交版本',
    };
    return { kind: 'git', title: '核对 Git 分支与代码变更', detail: sub ? labelMap[sub] || sub : fileSummary };
  }
  if (/\b(?:rg\s+--files|find\s+|ls\s+|tree\b|pwd\s*&&\s*rg\s+--files)/i.test(cmd)) {
    return { kind: 'scan', title: '扫描项目目录与文件清单', detail: fileSummary };
  }
  if (/\b(?:rg|grep)\s+/i.test(cmd)) {
    return { kind: 'search', title: '检索关联代码与关键定义', detail: fileSummary };
  }
  if (/\b(?:nl|sed|cat|head|tail|awk|python3?|node\s+-e)\b/i.test(cmd) || files.length > 0) {
    return { kind: 'read', title: '查阅源码与配置细节', detail: fileSummary };
  }
  return { kind: 'command', title: '执行本地核查命令', detail: fileSummary };
}

function stripReviewDraftFence(markdown: string): string {
  return markdown
    .replace(/```(?:taskflow-review-draft|taskflow-subtask-draft|json)\s*[\s\S]*?```/gi, '')
    .replace(RUNS_PATH_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanThoughtText(lines: string[]): string {
  const cleaned = lines
    .map(line => line.trim())
    .filter(line => line && !HEADER_RE.test(line) && !HOOK_RE.test(line) && !line.startsWith('```') && !line.startsWith('{') && !line.startsWith('"'))
    .map(line => line.replace(/\*\*/g, '').replace(RUNS_PATH_RE, '').trim())
    .filter(Boolean);
  if (!cleaned.length) return '';
  const summary = cleaned.slice(-2).join(' ');
  return summary.length > 220 ? `${summary.slice(0, 217)}…` : summary;
}

export function parseAiRunOutput(rawOutput: string, options: ParseAiRunOptions): ParsedAiRunOutput {
  const normalized = (rawOutput || '').replace(ANSI_RE, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  let hasRawNoise = false;
  let hasStructuredTranscript = false;
  let section: 'idle' | 'user' | 'thinking' | 'exec' | 'exec-output' | 'codex' | 'tokens' = 'idle';
  const rawSteps: AiRunProgressStep[] = [];
  let activeExec: { cmd: string; stepIndex: number } | null = null;
  let currentThoughtLines: string[] = [];
  let latestThought = '';
  let currentCodexLines: string[] = [];
  const codexSegments: string[] = [];

  const flushThought = () => {
    const next = cleanThoughtText(currentThoughtLines);
    if (next) latestThought = next;
    currentThoughtLines = [];
  };
  const flushCodex = () => {
    const body = currentCodexLines.join('\n').trim();
    if (body) codexSegments.push(body);
    currentCodexLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (HOOK_RE.test(trimmed)) {
      hasRawNoise = true;
      hasStructuredTranscript = true;
      if (section === 'thinking') flushThought();
      if (section === 'codex') flushCodex();
      section = 'idle';
      continue;
    }
    if (HEADER_RE.test(trimmed)) {
      hasRawNoise = true;
      hasStructuredTranscript = true;
      continue;
    }
    if (/^tokens used$/i.test(trimmed)) {
      hasRawNoise = true;
      hasStructuredTranscript = true;
      if (section === 'thinking') flushThought();
      if (section === 'codex') flushCodex();
      section = 'tokens';
      continue;
    }
    if (section === 'tokens') {
      if (/^[\d,]+$/.test(trimmed) || !trimmed) continue;
      section = 'idle';
    }

    if (trimmed === 'user') {
      hasStructuredTranscript = true;
      hasRawNoise = true;
      if (section === 'thinking') flushThought();
      if (section === 'codex') flushCodex();
      section = 'user';
      continue;
    }
    if (trimmed === 'thinking') {
      hasStructuredTranscript = true;
      hasRawNoise = true;
      if (section === 'thinking') flushThought();
      if (section === 'codex') flushCodex();
      section = 'thinking';
      continue;
    }
    if (trimmed === 'exec') {
      hasStructuredTranscript = true;
      hasRawNoise = true;
      if (section === 'thinking') flushThought();
      if (section === 'codex') flushCodex();
      section = 'exec';
      activeExec = null;
      continue;
    }
    if (trimmed === 'codex' || trimmed === 'assistant') {
      hasStructuredTranscript = true;
      if (section === 'thinking') flushThought();
      if (section === 'codex') flushCodex();
      section = 'codex';
      continue;
    }

    if (section === 'user') {
      continue;
    }
    if (section === 'exec') {
      if (!trimmed) continue;
      if (!activeExec) {
        const classified = classifyCommand(trimmed);
        const step: AiRunProgressStep = {
          id: `step-${rawSteps.length + 1}`,
          kind: classified.kind,
          title: classified.title,
          ...(classified.detail ? { detail: classified.detail } : {}),
          status: 'running',
        };
        rawSteps.push(step);
        activeExec = { cmd: trimmed, stepIndex: rawSteps.length - 1 };
        continue;
      }
      const resMatch = line.match(RESULT_RE);
      if (resMatch) {
        const target = rawSteps[activeExec.stepIndex];
        if (target) {
          const exitCode = resMatch[2] ? Number(resMatch[2]) : 0;
          target.status = resMatch[1].toLowerCase().startsWith('succeeded') || exitCode === 0 ? 'done' : 'failed';
          target.duration = resMatch[3];
        }
        section = 'exec-output';
      }
      continue;
    }
    if (section === 'exec-output') {
      continue;
    }
    if (section === 'thinking') {
      currentThoughtLines.push(line);
      continue;
    }
    if (section === 'codex') {
      currentCodexLines.push(line);
    }
  }

  if (section === 'thinking') flushThought();
  if (section === 'codex') flushCodex();

  // If the run has already completed, mark any trailing unclosed step as done/failed rather than spinning forever.
  if (options.status !== 'RUNNING') {
    for (const step of rawSteps) {
      if (step.status === 'running') step.status = options.status === 'FAILED' ? 'failed' : 'done';
    }
  }

  // Collapse adjacent identical steps so repetitive file scans stay crisp.
  const collapsedSteps: AiRunProgressStep[] = [];
  for (const step of rawSteps) {
    const prev = collapsedSteps[collapsedSteps.length - 1];
    if (prev && prev.kind === step.kind && prev.title === step.title && prev.detail === step.detail && prev.status === step.status) {
      if (step.duration) prev.duration = step.duration;
      continue;
    }
    collapsedSteps.push(step);
  }

  let finalMarkdown = '';
  if (options.draftAnswer && options.draftAnswer.trim()) {
    finalMarkdown = options.hasReviewDraft ? stripReviewDraftFence(options.draftAnswer) : options.draftAnswer.trim().replace(RUNS_PATH_RE, '');
  } else if (codexSegments.length > 0) {
    const candidate = codexSegments[codexSegments.length - 1];
    finalMarkdown = options.hasReviewDraft ? stripReviewDraftFence(candidate) : candidate.replace(RUNS_PATH_RE, '').trim();
  } else if (!hasStructuredTranscript && normalized.trim()) {
    const plain = lines.filter(l => !HOOK_RE.test(l.trim()) && !HEADER_RE.test(l.trim())).join('\n').trim();
    finalMarkdown = options.hasReviewDraft ? stripReviewDraftFence(plain) : plain.replace(RUNS_PATH_RE, '');
  }

  const lastStep = collapsedSteps[collapsedSteps.length - 1];
  let currentActivity = '';
  if (options.status === 'RUNNING') {
    if (options.runner === 'bridge' && options.bridgePhase === 'QUEUED') {
      currentActivity = '已排队，等待本机 Bridge 领取执行（请确认本机 worker 在运行）…';
    } else if (lastStep?.kind === 'test') {
      currentActivity = '正在运行测试与编译校验…';
    } else if (lastStep?.kind === 'git') {
      currentActivity = '正在核对 Git 仓库分支与代码变更…';
    } else if (lastStep?.kind === 'context') {
      currentActivity = '正在读取任务上下文与冻结交付材料…';
    } else if (lastStep && ['scan', 'search', 'read'].includes(lastStep.kind)) {
      currentActivity = lastStep.detail ? `正在查阅关联源码：${lastStep.detail}` : '正在阅读项目源码与交付材料…';
    } else if (latestThought) {
      currentActivity = 'AI 正在综合分析材料并整理评审结论…';
    } else {
      currentActivity = '正在启动本机 AI 并读取任务快照，请稍候…';
    }
  } else if (options.status === 'SUCCEEDED') {
    currentActivity = options.hasReviewDraft
      ? 'AI 已完成核查并生成结构化评审结论（请查看上方预览卡片）。'
      : 'AI 执行已完成，以下为整理后的可读结论。';
  } else if (options.status === 'FAILED') {
    currentActivity = 'AI 执行异常中止，请查看上方错误提示或切换「原始日志」排查详情。';
  } else {
    currentActivity = 'AI 执行已停止。';
  }

  return {
    currentActivity,
    steps: collapsedSteps,
    totalSteps: rawSteps.length,
    latestThought,
    finalMarkdown,
    hasRawNoise,
  };
}

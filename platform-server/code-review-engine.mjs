const SECRET_PATTERNS = [
  { name: '硬编码私钥材料', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: '疑似硬编码云厂商或大模型密钥', re: /\b(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/ },
  { name: '疑似硬编码敏感凭据赋值', re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd|private[_-]?key)\s*[:=]\s*['"`][A-Za-z0-9+/=._-]{12,}['"`]/i },
];

const DETERMINISTIC_CODE_RULES = [
  {
    id: 'sql-injection-concat',
    severity: 'CRITICAL',
    title: '疑似存在 SQL 拼接注入风险',
    detail: '检测到在 SQL 语句中直接拼接或模板插值变量，请改用参数化占位符（PreparedStatement / ? / $1）。',
    re: /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^\n]*(?:\$\{[^}]+\}|['"]\s*\+\s*[A-Za-z_$][\w$.]*)/i,
  },
  {
    id: 'xss-unsafe-sink',
    severity: 'CRITICAL',
    title: '检测到高危 DOM/HTML 注入点',
    detail: '直接使用 dangerouslySetInnerHTML / innerHTML / document.write 赋值动态内容可能导致 XSS 漏洞，请先做转义或使用安全渲染。',
    re: /\b(?:dangerouslySetInnerHTML|innerHTML\s*=|outerHTML\s*=|document\.write\s*\()/,
  },
  {
    id: 'unsafe-dynamic-exec',
    severity: 'CRITICAL',
    title: '检测到动态代码执行或命令拼接风险',
    detail: '使用 eval / new Function 或向 exec/execSync 拼接外部字符串存在代码/命令注入风险，请改用安全参数数组（execFile/spawn）。',
    re: /\b(?:eval\s*\(|new\s+Function\s*\(|(?:exec|execSync)\s*\(\s*`[^`]*\$\{)/,
  },
  {
    id: 'sensitive-log-leak',
    severity: 'WARN',
    title: '日志输出可能泄露敏感凭据或个人隐私字段',
    detail: '日志语句中出现 password/token/secret/cardNo/idCard/phone 等敏感字段名，请确认已做脱敏掩码处理。',
    re: /\b(?:console\.(?:log|info|warn|error)|logger\.(?:info|warn|error|debug))\b[^\n]*\b(?:password|passwd|secret|token|authorization|cookie|idCard|cardNo|cvv|mobile|phone)\b/i,
  },
  {
    id: 'empty-catch-swallow',
    severity: 'WARN',
    title: '存在空 catch 块吞掉异常',
    detail: '空 catch 代码块会掩盖真实故障和状态不一致风险，建议至少记录上下文错误或显式向上传递。',
    re: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  },
  {
    id: 'debug-leftover',
    severity: 'INFO',
    title: '遗留调试断点或临时 TODO 标记',
    detail: '合入前建议清理 debugger 语句或明确登记临时 TODO/FIXME 对应的跟进任务。',
    re: /\b(?:debugger\b|TODO:|FIXME:)/,
  },
];

export function parseAddedDiffLines(diffContent) {
  if (typeof diffContent !== 'string' || !diffContent.trim()) return [];
  const trimmed = diffContent.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed?.diffs)) {
        const out = [];
        for (const item of parsed.diffs) {
          if (typeof item?.diff !== 'string') continue;
          const filePath = String(item.new_path || item.old_path || 'code-diff').replace(/^b\//, '');
          let newLine = 1;
          for (const rawLine of item.diff.split(/\r?\n/)) {
            const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
              newLine = Number(hunkMatch[1]);
              continue;
            }
            if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
              out.push({ filePath, lineNumber: newLine > 0 ? newLine : 1, text: rawLine.slice(1) });
              newLine += 1;
            } else if (rawLine.startsWith(' ') || (!rawLine.startsWith('-') && !rawLine.startsWith('\\'))) {
              newLine += 1;
            }
          }
        }
        if (out.length) return out;
      }
    } catch { /* fall through to text diff parser */ }
  }
  const lines = diffContent.split(/\r?\n/);
  const added = [];
  let currentFile = '';
  let newLine = 0;
  let inDiff = false;

  for (const rawLine of lines) {
    if (rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      if (target !== '/dev/null') {
        currentFile = target.replace(/^b\//, '');
        inDiff = true;
      }
      continue;
    }
    if (rawLine.startsWith('--- ')) continue;
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      inDiff = true;
      continue;
    }
    if (inDiff) {
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        added.push({ filePath: currentFile || 'code-diff', lineNumber: newLine > 0 ? newLine : 1, text: rawLine.slice(1) });
        newLine += 1;
      } else if (rawLine.startsWith(' ')) {
        newLine += 1;
      }
    }
  }
  return added;
}

function isNoiseTestPath(filePath) {
  return /(?:^|\/)(?:__tests__|tests?|spec)\b|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath || '');
}

export function runDeterministicCodeChecks(codeAssets = []) {
  const findings = [];
  const seen = new Set();

  const pushFinding = item => {
    const key = `${item.severity}:${item.title}:${item.location || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(item);
  };

  for (const asset of codeAssets) {
    const content = typeof asset?.content === 'string' ? asset.content : '';
    if (!content.trim()) continue;
    const addedLines = parseAddedDiffLines(content);
    const entries = addedLines.length
      ? addedLines
      : content.split(/\r?\n/).map((text, index) => ({
          filePath: asset.logicalKey && asset.logicalKey !== 'CODE' ? asset.logicalKey : (asset.title || 'CODE'),
          lineNumber: index + 1,
          text,
        }));

    for (const entry of entries) {
      const lineText = entry.text;
      if (!lineText.trim() || /^\s*(?:\/\/|\*\/?|#)/.test(lineText)) continue;
      const location = `${entry.filePath}:${entry.lineNumber}`;

      for (const secretRule of SECRET_PATTERNS) {
        if (secretRule.re.test(lineText) && !/\[REDACTED\]|\[凭据已隐藏\]|example|placeholder|fixture/i.test(lineText)) {
          pushFinding({
            severity: 'CRITICAL',
            title: `[规则引擎] ${secretRule.name}`,
            detail: '代码新增行中疑似包含未脱敏密钥、Token 或口令字面量，请立即移除并通过环境变量/密钥库注入。',
            location,
          });
        }
      }

      for (const rule of DETERMINISTIC_CODE_RULES) {
        if (rule.id === 'debug-leftover' && isNoiseTestPath(entry.filePath)) continue;
        if (rule.re.test(lineText)) {
          pushFinding({
            severity: rule.severity,
            title: `[规则引擎] ${rule.title}`,
            detail: rule.detail,
            location,
          });
        }
      }
    }
  }
  return findings.slice(0, 30);
}

export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'context';

export interface UnifiedDiffStats {
  files: string[];
  additions: number;
  deletions: number;
  hasHunks: boolean;
}

export type RevisionDiffRow =
  | { type: 'context' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number }
  | { type: 'skip'; count: number };

export interface RevisionLineDiff {
  rows: RevisionDiffRow[];
  additions: number;
  deletions: number;
  identical: boolean;
}

export type SideBySideDiffRow =
  | { kind: 'file' | 'hunk' | 'meta' | 'skip'; text: string }
  | {
      kind: 'pair';
      leftLine?: number;
      leftText?: string;
      leftType: 'del' | 'context' | 'empty';
      rightLine?: number;
      rightText?: string;
      rightType: 'add' | 'context' | 'empty';
    };

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function isUnifiedDiffContent(content: string): boolean {
  if (!content) return false;
  return /(?:^|\n)(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/.test(content);
}

export function classifyDiffLine(line: string, inHunk = true): DiffLineKind {
  if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
    return 'file';
  }
  if (HUNK_HEADER_RE.test(line)) {
    return 'hunk';
  }
  if (
    line.startsWith('index ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ')
  ) {
    return 'meta';
  }
  if (inHunk) {
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
  }
  return 'context';
}

export function parseUnifiedDiffStats(content: string): UnifiedDiffStats {
  if (!isUnifiedDiffContent(content)) {
    return { files: [], additions: 0, deletions: 0, hasHunks: false };
  }
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const fileSet = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let hasHunks = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match?.[2] && match[2] !== '/dev/null') fileSet.add(match[2]);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target && target !== '/dev/null') {
        fileSet.add(target.startsWith('b/') ? target.slice(2) : target);
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      continue;
    }
    if (HUNK_HEADER_RE.test(line)) {
      inHunk = true;
      hasHunks = true;
      continue;
    }
    if (inHunk) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }

  return {
    files: [...fileSet],
    additions,
    deletions,
    hasHunks: hasHunks || fileSet.size > 0,
  };
}

export function splitUnifiedDiffLines(content: string): { kind: DiffLineKind; text: string }[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let inHunk = false;
  return lines.map(line => {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      return { kind: 'file' as const, text: line };
    }
    if (HUNK_HEADER_RE.test(line)) {
      inHunk = true;
      return { kind: 'hunk' as const, text: line };
    }
    return { kind: classifyDiffLine(line, inHunk), text: line };
  });
}

export function buildSideBySideUnifiedDiff(content: string): SideBySideDiffRow[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const out: SideBySideDiffRow[] = [];
  let inHunk = false;
  let oldLine = 1;
  let newLine = 1;
  let delBuf: { line: number; text: string }[] = [];
  let addBuf: { line: number; text: string }[] = [];

  const flushBuffers = () => {
    const maxLen = Math.max(delBuf.length, addBuf.length);
    for (let k = 0; k < maxLen; k += 1) {
      const del = delBuf[k];
      const add = addBuf[k];
      out.push({
        kind: 'pair',
        leftLine: del?.line,
        leftText: del?.text,
        leftType: del ? 'del' : 'empty',
        rightLine: add?.line,
        rightText: add?.text,
        rightType: add ? 'add' : 'empty',
      });
    }
    delBuf = [];
    addBuf = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushBuffers();
      inHunk = false;
      out.push({ kind: 'file', text: line });
      continue;
    }
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      flushBuffers();
      inHunk = true;
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    const kind = classifyDiffLine(line, inHunk);
    if (kind === 'file' || kind === 'meta') {
      flushBuffers();
      out.push({ kind, text: line });
      continue;
    }
    if (!inHunk) {
      flushBuffers();
      if (line) out.push({ kind: 'meta', text: line });
      continue;
    }
    if (line === '\\ No newline at end of file') {
      flushBuffers();
      out.push({ kind: 'meta', text: line });
      continue;
    }
    if (kind === 'del') {
      delBuf.push({ line: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (kind === 'add') {
      addBuf.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else {
      flushBuffers();
      const body = line.startsWith(' ') ? line.slice(1) : line;
      out.push({
        kind: 'pair',
        leftLine: oldLine,
        leftText: body,
        leftType: 'context',
        rightLine: newLine,
        rightText: body,
        rightType: 'context',
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  flushBuffers();
  return out;
}

export function pairRevisionDiffSideBySide(rows: readonly RevisionDiffRow[]): SideBySideDiffRow[] {
  const out: SideBySideDiffRow[] = [];
  let delBuf: { line?: number; text: string }[] = [];
  let addBuf: { line?: number; text: string }[] = [];

  const flush = () => {
    const maxLen = Math.max(delBuf.length, addBuf.length);
    for (let k = 0; k < maxLen; k += 1) {
      const del = delBuf[k];
      const add = addBuf[k];
      out.push({
        kind: 'pair',
        leftLine: del?.line,
        leftText: del?.text,
        leftType: del ? 'del' : 'empty',
        rightLine: add?.line,
        rightText: add?.text,
        rightType: add ? 'add' : 'empty',
      });
    }
    delBuf = [];
    addBuf = [];
  };

  for (const row of rows) {
    if (row.type === 'skip') {
      flush();
      out.push({ kind: 'skip', text: `⋯ 省略 ${row.count} 行未变更上下文 ⋯` });
    } else if (row.type === 'del') {
      delBuf.push({ line: row.oldLine, text: row.text });
    } else if (row.type === 'add') {
      addBuf.push({ line: row.newLine, text: row.text });
    } else {
      flush();
      out.push({
        kind: 'pair',
        leftLine: row.oldLine,
        leftText: row.text,
        leftType: 'context',
        rightLine: row.newLine,
        rightText: row.text,
        rightType: 'context',
      });
    }
  }
  flush();
  return out;
}

export function computeRevisionLineDiff(
  oldText: string,
  newText: string,
  contextRadius = 3,
): RevisionLineDiff {
  const normOld = (oldText || '').replace(/\r\n/g, '\n');
  const normNew = (newText || '').replace(/\r\n/g, '\n');
  if (normOld === normNew) {
    return { rows: [], additions: 0, deletions: 0, identical: true };
  }

  const oldLines = normOld.split('\n');
  const newLines = normNew.split('\n');

  let prefixLen = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefixLen < maxPrefix && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(oldLines.length - prefixLen, newLines.length - prefixLen);
  while (
    suffixLen < maxSuffix &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const midOld = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const midNew = newLines.slice(prefixLen, newLines.length - suffixLen);

  type RawOp = { type: 'context' | 'add' | 'del'; text: string; oldLine?: number; newLine?: number };
  const rawOps: RawOp[] = [];

  for (let i = 0; i < prefixLen; i += 1) {
    rawOps.push({ type: 'context', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  let additions = 0;
  let deletions = 0;
  const m = midOld.length;
  const n = midNew.length;

  if (m * n <= 360_000) {
    const cols = n + 1;
    const dp = new Int32Array((m + 1) * cols);
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (midOld[i] === midNew[j]) {
          dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * cols + j];
          const right = dp[i * cols + (j + 1)];
          dp[i * cols + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        rawOps.push({
          type: 'context',
          text: midOld[i],
          oldLine: prefixLen + i + 1,
          newLine: prefixLen + j + 1,
        });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        rawOps.push({ type: 'del', text: midOld[i], oldLine: prefixLen + i + 1 });
        deletions += 1;
        i += 1;
      } else {
        rawOps.push({ type: 'add', text: midNew[j], newLine: prefixLen + j + 1 });
        additions += 1;
        j += 1;
      }
    }
    while (i < m) {
      rawOps.push({ type: 'del', text: midOld[i], oldLine: prefixLen + i + 1 });
      deletions += 1;
      i += 1;
    }
    while (j < n) {
      rawOps.push({ type: 'add', text: midNew[j], newLine: prefixLen + j + 1 });
      additions += 1;
      j += 1;
    }
  } else {
    for (let i = 0; i < m; i += 1) {
      rawOps.push({ type: 'del', text: midOld[i], oldLine: prefixLen + i + 1 });
      deletions += 1;
    }
    for (let j = 0; j < n; j += 1) {
      rawOps.push({ type: 'add', text: midNew[j], newLine: prefixLen + j + 1 });
      additions += 1;
    }
  }

  const oldSuffixStart = oldLines.length - suffixLen;
  const newSuffixStart = newLines.length - suffixLen;
  for (let k = 0; k < suffixLen; k += 1) {
    rawOps.push({
      type: 'context',
      text: oldLines[oldSuffixStart + k],
      oldLine: oldSuffixStart + k + 1,
      newLine: newSuffixStart + k + 1,
    });
  }

  // Fold long unchanged context runs so reviewers focus immediately on changes
  const rows: RevisionDiffRow[] = [];
  let idx = 0;
  while (idx < rawOps.length) {
    if (rawOps[idx].type !== 'context') {
      rows.push(rawOps[idx]);
      idx += 1;
      continue;
    }
    let end = idx;
    while (end < rawOps.length && rawOps[end].type === 'context') {
      end += 1;
    }
    const runLen = end - idx;
    const isLeading = idx === 0;
    const isTrailing = end === rawOps.length;
    const keepStart = isLeading ? 0 : contextRadius;
    const keepEnd = isTrailing ? 0 : contextRadius;
    if (runLen > keepStart + keepEnd + 1) {
      for (let k = 0; k < keepStart; k += 1) rows.push(rawOps[idx + k]);
      rows.push({ type: 'skip', count: runLen - keepStart - keepEnd });
      for (let k = end - keepEnd; k < end; k += 1) rows.push(rawOps[k]);
    } else {
      for (let k = idx; k < end; k += 1) rows.push(rawOps[k]);
    }
    idx = end;
  }

  return { rows, additions, deletions, identical: false };
}

export type RiskTier = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface AssetRiskSignal {
  code:
    | 'SECRET_PATTERN'
    | 'SCHEMA_MIGRATION'
    | 'AUTH_SECURITY'
    | 'PAYMENT_CORE'
    | 'INFRA_CONFIG'
    | 'DEBUG_LEFTOVER';
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  label: string;
}

export interface AssetRiskAnalysis {
  tier: RiskTier;
  signals: AssetRiskSignal[];
}

const SECRET_HEURISTIC_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{24,})\b|(?:api[_-]?key|client[_-]?secret|access[_-]?token|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-./+=]{12,}['"]/i;
const SCHEMA_MIGRATION_RE =
  /\b(?:ALTER\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN|CREATE\s+INDEX|TRUNCATE\s+TABLE)\b|(?:^|\/)(?:migrations?|schema|prisma)\/|\.sql\b/i;
const AUTH_SECURITY_RE =
  /(?:^|\/|\b)(?:auth|oauth|jwt|rbac|permission|acl|session|cookie|csrf|cors)(?:\/|\b|_|-)/i;
const PAYMENT_CORE_RE =
  /(?:^|\/|\b)(?:payment|pay|refund|preauth|settle|settlement|billing|ledger|wallet)(?:\/|\b|_|-)/i;
const INFRA_CONFIG_RE =
  /(?:^|[\s/`"'(])(?:Dockerfile|docker-compose|k8s|helm|nginx\.conf|\.env(?:\.\w+)?|package\.json|pom\.xml|go\.mod)\b/i;
const DEBUG_LEFTOVER_RE = /\b(?:console\.log\s*\(|debugger\s*;|\bTODO\s*:|\bFIXME\s*:)/;

export function analyzeAssetRiskSignals(content: string): AssetRiskAnalysis {
  if (!content) return { tier: 'NONE', signals: [] };

  const stats = parseUnifiedDiffStats(content);
  let activeAddedOrBody = content;
  if (stats.hasHunks) {
    const split = splitUnifiedDiffLines(content);
    activeAddedOrBody = [
      ...stats.files,
      ...split.filter(l => l.kind === 'add').map(l => l.text.slice(1)),
    ].join('\n');
  }

  const signals: AssetRiskSignal[] = [];
  if (SECRET_HEURISTIC_RE.test(activeAddedOrBody)) {
    signals.push({ code: 'SECRET_PATTERN', level: 'HIGH', label: '疑似硬编码凭据特征' });
  }
  if (SCHEMA_MIGRATION_RE.test(activeAddedOrBody)) {
    signals.push({ code: 'SCHEMA_MIGRATION', level: 'HIGH', label: '涉及库表 Schema / SQL 变更' });
  }
  if (PAYMENT_CORE_RE.test(activeAddedOrBody)) {
    signals.push({ code: 'PAYMENT_CORE', level: 'MEDIUM', label: '涉及资金/支付核心链路' });
  }
  if (AUTH_SECURITY_RE.test(activeAddedOrBody)) {
    signals.push({ code: 'AUTH_SECURITY', level: 'MEDIUM', label: '涉及认证/权限边界' });
  }
  if (INFRA_CONFIG_RE.test(activeAddedOrBody)) {
    signals.push({ code: 'INFRA_CONFIG', level: 'MEDIUM', label: '涉及部署或依赖配置' });
  }
  if (DEBUG_LEFTOVER_RE.test(activeAddedOrBody)) {
    signals.push({ code: 'DEBUG_LEFTOVER', level: 'LOW', label: '含调试日志或 TODO 标记' });
  }

  let tier: RiskTier = 'NONE';
  if (signals.some(s => s.level === 'HIGH')) tier = 'HIGH';
  else if (signals.some(s => s.level === 'MEDIUM')) tier = 'MEDIUM';
  else if (signals.length > 0) tier = 'LOW';

  return { tier, signals };
}

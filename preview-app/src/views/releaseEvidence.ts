import { parseMarkdownBlocks } from './markdownLite.ts';
import type { Asset, Gates, ReviewJob } from './workspaceApi.ts';

const AC = /\bAC[-_]\d+(?:[-_.]\d+)*[a-z]?(?![a-z0-9_-])/gi;
const TC = /\bTC[-_]\d+(?:[-_.]\d+)*[a-z]?(?![a-z0-9_-])/gi;
const ACCEPTANCE_HEADING = /^(?:[\d.]+[.、\s]+)?(?:验收(?:标准|条件|准则|项|要求)?|Acceptance Criteria)\s*[:：]?\s*$/i;
const NO_MAPPING = /未覆盖|不覆盖|待覆盖|未关联|not covered/i;

const ids = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).map(id => id.toUpperCase());
const clean = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, '').trim();
const startsWithId = (text: string, pattern: RegExp) => ids(text, pattern).find(id => text.replace(/^[\s[【(（]+/, '').toUpperCase().startsWith(id));

function documentBlocks(content: string) {
  const markdown = content
    .replace(/^\s*h([1-6])\.\s+(.+)$/gm, (_line, level: string, title: string) => '#'.repeat(Number(level)) + ' ' + title)
    .replace(/^\s*\*\*(.+?)\*\*\s*$/gm, (line, title: string) => ACCEPTANCE_HEADING.test(title) ? '## ' + title : line);
  if (!/<(?:p|h[1-6]|table|ul|ol)\b/i.test(markdown)) return parseMarkdownBlocks(markdown);
  const storage = markdown
    .replace(/<(?:ac:structured-macro)\b[^>]*ac:name="(?:code|noformat)"[^>]*>[\s\S]*?<\/ac:structured-macro>/gi, '')
    .replace(/<(?:pre|script|style)\b[^>]*>[\s\S]*?<\/(?:pre|script|style)>/gi, '')
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_line, row: string) => {
      const cells = Array.from(row.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi));
      if (!cells.length) return '\n';
      const line = '| ' + cells.map(cell => cell[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).join(' | ') + ' |';
      return '\n' + line + (cells.every(cell => cell[1].toLowerCase() === 'h') ? '\n| ' + cells.map(() => '---').join(' | ') + ' |' : '') + '\n';
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_line, level: string, title: string) => '\n\n' + '#'.repeat(Number(level)) + ' ' + title + '\n\n')
    .replace(/<li\b[^>]*>\s*<p\b[^>]*>/gi, '<li>')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:\/p|\/div|\/table|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return parseMarkdownBlocks(storage.replace(/(\|[^\n]+)\n+(?=\|)/g, '$1\n'));
}

interface Criterion {
  id: string | undefined;
  text: string;
  source: string;
}

function criteria(content: string, source: string): Criterion[] {
  const result: Criterion[] = [];
  let section: number | undefined;
  const add = (value: string, allowed: boolean) => {
    const text = clean(value);
    const id = startsWithId(text, AC);
    if (text && (id || allowed)) result.push({ id, text, source });
  };
  for (const block of documentBlocks(content)) {
    if (block.type === 'heading') {
      const title = clean(block.text);
      if (section !== undefined && block.level <= section) section = undefined;
      if (ACCEPTANCE_HEADING.test(title)) section = block.level;
      else add(title, false);
    } else if (block.type === 'table') {
      const idIndex = block.headers.findIndex(header => /^(?:AC(?:[-_ ]?ID)?|验收(?:项)?(?:编号|ID))$/i.test(clean(header)));
      for (const row of block.rows) {
        const index = idIndex < 0 ? 0 : idIndex;
        const id = startsWithId(clean(row[index] ?? ''), AC);
        if (id || section !== undefined) add([row[index], ...row.filter((_cell, position) => position !== index)].filter(Boolean).join(' · '), section !== undefined);
      }
    } else if (block.type === 'ul' || block.type === 'ol' || block.type === 'checklist') {
      for (const item of block.items) add(typeof item === 'string' ? item : item.text, section !== undefined);
    } else if (block.type === 'paragraph') {
      for (const line of block.text.split('\n')) add(line, false);
    }
  }
  return result;
}

export function acceptanceCoverage(assets: readonly Asset[], jiraDescription: unknown) {
  const prds = assets.filter(asset => asset.kind === 'PRD');
  const tests = assets.filter(asset => asset.kind === 'TEST_CASE');
  const requirements = prds.flatMap(asset => criteria(asset.content, asset.title + ' r' + asset.revision));
  if (!prds.length && typeof jiraDescription === 'string') requirements.push(...criteria(jiraDescription, 'Jira 事项描述'));
  const idCounts = new Map<string, number>();
  for (const { id } of requirements) if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  const mappings = new Map<string, Set<string>>();
  for (const asset of tests) {
    let activeCase: string | undefined;
    const record = (value: string, caseId: string | undefined) => {
      if (!caseId || NO_MAPPING.test(value)) return;
      for (const ac of ids(value, AC)) {
        const mapped = mappings.get(ac) ?? new Set();
        mapped.add(caseId + '（' + asset.title + ' r' + asset.revision + '）');
        mappings.set(ac, mapped);
      }
    };
    for (const block of documentBlocks(asset.content)) {
      if (block.type === 'heading') {
        activeCase = startsWithId(clean(block.text).replace(/^(?:用例|场景|Scenario|Test Case)\s*[:：]?\s*/i, ''), TC);
        record(block.text, activeCase);
      } else if (block.type === 'table') {
        activeCase = undefined;
        const idIndex = block.headers.findIndex(header => /^(?:TC(?:[-_ ]?ID)?|(?:测试)?用例(?:编号|ID))$/i.test(clean(header)));
        for (const row of block.rows) record(row.join(' '), startsWithId(clean(row[idIndex < 0 ? 0 : idIndex] ?? ''), TC));
      } else if (block.type === 'ul' || block.type === 'ol' || block.type === 'checklist' || block.type === 'paragraph') {
        const lines = block.type === 'paragraph' ? block.text.split('\n') : block.items.map(item => typeof item === 'string' ? item : item.text);
        for (const line of lines) {
          const item = clean(line);
          const explicitCase = startsWithId(item.replace(/^(?:用例|场景|Scenario)\s*[:：]?\s*/i, ''), TC);
          if (explicitCase) activeCase = explicitCase;
          const links = /^(?:覆盖|关联|对应|追溯|验收项|AC(?:[-_ ]?ID)?\s*[:：])/i.test(item);
          record(line, explicitCase ?? (links ? activeCase : undefined));
        }
      }
    }
  }
  return requirements.map(requirement => {
    const id = requirement.id;
    const duplicate = !!id && idCounts.get(id)! > 1;
    return {
      ...requirement,
      testCases: id && !duplicate ? [...(mappings.get(id) ?? [])] : [],
      reason: !id ? '验收项未标 AC 编号' : duplicate ? 'AC 编号重复，无法确定归属' : '未找到关联用例',
    };
  });
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const commitSha = (value: unknown) => typeof value === 'string' && SHA.test(value) ? value.toLowerCase() : undefined;

function repository(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^/\s][^\s]*)$/.exec(value);
  try {
    const url = new URL(scp ? 'ssh://' + scp[1] + '/' + scp[2] : value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.host) return undefined;
    const path = url.pathname
      .replace(/(?:\/-)?\/(?:commit|merge_requests|change)\/[^/]+\/?$/, '')
      .replace(/\/+$/, '').replace(/\.git$/, '');
    return path && path !== '/' ? url.host + path : undefined;
  } catch { return undefined; }
}

function readObject(content: string) {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function reviewedRevision(asset: Asset) {
  if (asset.logicalKey.startsWith('gitlab:gitlab_mr:')) {
    return { repository: repository(asset.sourceUrl), commit: commitSha(readObject(asset.content)?.sha) };
  }
  if (asset.logicalKey.startsWith('yunxiao:yunxiao_commit:') || asset.logicalKey.startsWith('yunxiao:yunxiao_mr:') || asset.content.startsWith('# 本地 Git 代码快照')) {
    const header = asset.content.split(/\n## /, 1)[0];
    return {
      repository: repository(asset.sourceUrl ?? header.match(/^- Git 仓库：`([^`\n]+)`$/m)?.[1]),
      commit: commitSha(header.match(/^- Commit SHA：`([^`\n]+)`$/m)?.[1]),
    };
  }
  return {};
}

export function compareJenkinsCommits(assets: readonly Asset[], jobs: readonly ReviewJob[], gates: Gates | null) {
  const gate = gates?.gates.find(item => item.stage === 'CODE_REVIEW');
  const review = gate?.status === 'PASS' ? jobs.find(job =>
    job.id === gate.jobId && job.stage === 'CODE_REVIEW' && !job.stale && job.decision?.decision === 'APPROVE'
  ) : undefined;
  const approvalAssets = Array.isArray(review?.snapshot?.assets)
    ? (review.snapshot.assets as Asset[]).filter(asset => asset?.kind === 'CODE' && typeof asset.content === 'string' && typeof asset.logicalKey === 'string')
    : [];
  const reviewed = approvalAssets.map(asset => ({ ...reviewedRevision(asset), title: asset.title }));
  const builds = assets.filter(asset => asset.kind === 'RELEASE_PLAN' && asset.logicalKey.startsWith('jenkins:jenkins_build:'));
  const details: { status: 'pass' | 'warn' | 'fail'; text: string }[] = [];
  for (const asset of builds) {
    const build = readObject(asset.content);
    const label = asset.title + (typeof build?.number === 'number' && !asset.title.endsWith('#' + build.number) ? ' #' + build.number : '');
    const checkouts = Array.isArray(build?.gitCheckouts) ? build.gitCheckouts : [];
    if (!checkouts.length || build?.building === true) {
      details.push({ status: 'warn', text: label + (build?.building === true ? ' · 构建尚未结束' : ' · 缺少 Jenkins Git 检出记录') });
      continue;
    }
    const commits = new Map<string, Set<string>>();
    const unidentified = new Set<string>();
    for (const checkout of checkouts) {
      const repo = repository(checkout?.repository);
      const commit = commitSha(checkout?.commit);
      if (!commit) continue;
      if (!repo) { unidentified.add(commit); continue; }
      const known = commits.get(repo) ?? new Set();
      known.add(commit);
      commits.set(repo, known);
    }
    if (unidentified.size || !commits.size) details.push({
      status: 'warn',
      text: label + ' · 缺少可对应仓库的完整检出证据' + (unidentified.size ? ' · Jenkins ' + [...unidentified].join(' / ') : ''),
    });
    for (const [repo, built] of commits) {
      const approved = new Set(reviewed.filter(item => item.repository === repo && item.commit).map(item => item.commit!));
      const buildSha = [...built].join(' / ');
      const reviewSha = [...approved].join(' / ');
      const comparable = built.size === 1 && approved.size === 1;
      const status = comparable ? approved.has(buildSha) ? 'pass' : 'fail' : 'warn';
      const reason = comparable ? status === 'pass' ? '一致' : '不一致'
        : !review ? '缺少有效的代码审核审批'
          : !approved.size ? '审批快照缺少该仓库的完整提交证据'
            : '该仓库存在多个提交，无法判定唯一对应关系';
      details.push({ status, text: label + ' · ' + repo + ' · Jenkins ' + buildSha + (reviewSha ? ' · 评审 ' + reviewSha : '') + ' · ' + reason });
    }
  }
  return { hasBuilds: builds.length > 0, details };
}

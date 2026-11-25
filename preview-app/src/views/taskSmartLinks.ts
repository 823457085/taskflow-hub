import type { AssetKind, ConnectorSummary, WorkTask } from './workspaceApi.ts';

export interface LocalGitRepoInfo {
  name: string;
  path: string;
  group?: string;
  branch?: string | null;
  dirty?: boolean;
  remoteUrl?: string | null;
}

export interface DetectedTaskLink {
  url: string;
  label: string;
  provider: 'confluence' | 'gitlab' | 'jenkins' | 'jira' | 'yunxiao' | 'external';
  suggestedKinds: AssetKind[];
  issueKey?: string;
}

export interface RelatedJiraIssue {
  key: string;
  relation: 'parent' | 'mentioned';
  sameProject: boolean;
  url?: string;
}

export function canImportTaskMaterial(
  connector: ConnectorSummary | undefined,
  manageConnections: boolean,
  reuseLocalCredentials: boolean,
) {
  if (!connector || connector.selectionUnavailable || connector.status === 'ACCOUNT_UNAVAILABLE') return false;
  if (connector.status === 'UNCONFIGURED') {
    return manageConnections && reuseLocalCredentials && connector.localProfileAvailable === true;
  }
  return connector.hasCredential === true && (manageConnections || !!connector.accountId);
}

export interface TaskSmartHints {
  detectedLinks: DetectedTaskLink[];
  relatedJira: RelatedJiraIssue[];
  repoHintNames: string[];
  matchedRepos: LocalGitRepoInfo[];
}

function flattenDescription(value: unknown, depth = 0, out: string[] = []): string {
  if (depth > 25 || out.join('\n').length > 65_536 || value == null) return out.join('\n');
  if (typeof value === 'string') { out.push(value); return out.join('\n'); }
  if (Array.isArray(value)) {
    for (const item of value) flattenDescription(item, depth + 1, out);
    return out.join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') out.push(record.text);
    if (typeof record.href === 'string') out.push(record.href);
    if (typeof record.url === 'string') out.push(record.url);
    if (record.attrs && typeof record.attrs === 'object') flattenDescription(record.attrs, depth + 1, out);
    if (Array.isArray(record.marks)) flattenDescription(record.marks, depth + 1, out);
    if (Array.isArray(record.content)) flattenDescription(record.content, depth + 1, out);
  }
  return out.join('\n');
}

function cleanExtractedUrl(raw: string): string | null {
  const trimmed = raw.replace(/[\]|)>'"，。；！？、）》】]+$/g, '').trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.href;
}

function classifyUrl(href: string): Omit<DetectedTaskLink, 'url'> {
  const url = new URL(href);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/pages/viewpage.action' && url.searchParams.has('pageId') ||
      /^\/spaces\/[^/]+\/pages\/[1-9]\d*/.test(path) ||
      /^\/x\/[A-Za-z0-9_-]{1,11}$/.test(path) ||
      url.hostname.toLowerCase().includes('confluence')) {
    return { label: `Confluence 文档 (${path.split('/').pop() || url.hostname})`, provider: 'confluence', suggestedKinds: ['PRD', 'TECH_SPEC'] };
  }
  if (url.hostname.toLowerCase() === 'codeup.aliyun.com') {
    const crId = path.match(/\/(?:change|merge_request|merge_requests)\/([1-9]\d*)$/)?.[1];
    if (crId) return { label: `云效 Codeup MR #${crId}`, provider: 'yunxiao', suggestedKinds: ['CODE'] };
    const sha = path.match(/\/commit\/([0-9a-f]{7,64})$/i)?.[1];
    if (sha) return { label: `云效 Codeup Commit ${sha.slice(0, 8)}`, provider: 'yunxiao', suggestedKinds: ['CODE'] };
  }
  if (/\/-\/merge_requests\/[1-9]\d*/.test(path)) {
    const iid = path.match(/\/-\/merge_requests\/([1-9]\d*)/)?.[1] || '';
    return { label: `GitLab MR !${iid}`, provider: 'gitlab', suggestedKinds: ['CODE'] };
  }
  if (/\/job\/[^/]+/.test(path) && url.hostname.toLowerCase().includes('jenkins')) {
    return { label: `Jenkins 构建 (${url.hostname})`, provider: 'jenkins', suggestedKinds: ['RELEASE_PLAN'] };
  }
  const jiraMatch = path.match(/\/browse\/([A-Z][A-Z0-9]*-[1-9]\d*)$/);
  if (jiraMatch) {
    return { label: `Jira 事项 ${jiraMatch[1]}`, provider: 'jira', suggestedKinds: ['PRD', 'TECH_SPEC'], issueKey: jiraMatch[1] };
  }
  return { label: url.hostname + (path.length > 28 ? path.slice(0, 28) + '…' : path), provider: 'external', suggestedKinds: [] };
}

export function extractTaskSmartHints(task: Pick<WorkTask, 'jiraKey' | 'title' | 'externalRef'>, repositories: readonly LocalGitRepoInfo[] = []): TaskSmartHints {
  const text = [task.title || '', flattenDescription(task.externalRef?.description)].filter(Boolean).join('\n');
  const projectPrefix = task.jiraKey.includes('-') ? task.jiraKey.split('-')[0].toUpperCase() : '';
  const jiraOrigin = (() => {
    try { return task.externalRef?.url ? new URL(task.externalRef.url).origin : ''; } catch { return ''; }
  })();

  const seenUrls = new Set<string>();
  const detectedLinks: DetectedTaskLink[] = [];
  const urlMatches = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g) || [];
  for (const raw of urlMatches) {
    const clean = cleanExtractedUrl(raw);
    if (!clean || seenUrls.has(clean)) continue;
    if (task.externalRef?.url && clean === task.externalRef.url) continue;
    seenUrls.add(clean);
    const info = classifyUrl(clean);
    if (info.issueKey === task.jiraKey) continue;
    detectedLinks.push({ url: clean, ...info });
    if (detectedLinks.length >= 12) break;
  }

  const seenJira = new Set<string>([task.jiraKey.toUpperCase()]);
  const relatedJira: RelatedJiraIssue[] = [];
  const addJira = (key: string, relation: 'parent' | 'mentioned') => {
    const upper = key.toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,15}-[1-9]\d{0,7}$/.test(upper) || seenJira.has(upper)) return;
    seenJira.add(upper);
    relatedJira.push({
      key: upper,
      relation,
      sameProject: !!projectPrefix && upper.startsWith(projectPrefix + '-'),
      ...(jiraOrigin ? { url: `${jiraOrigin}/browse/${encodeURIComponent(upper)}` } : {}),
    });
  };
  if (task.externalRef?.parentKey) addJira(task.externalRef.parentKey, 'parent');
  for (const link of detectedLinks) if (link.issueKey) addJira(link.issueKey, 'mentioned');
  const keyMatches = text.match(/\b[A-Z][A-Z0-9]{1,15}-[1-9]\d{0,7}\b/g) || [];
  for (const key of keyMatches) {
    addJira(key, 'mentioned');
    if (relatedJira.length >= 8) break;
  }

  const repoSet = new Set<string>();
  const labelPatterns = [
    /(?:仓库|代码库|工程|服务|repo|repository)\s*[：:]\s*([A-Za-z0-9._-]{2,80})/gi,
    /(?:codeup\.aliyun\.com|gitlab[^\s/]*)\/[^\s/]+(?:\/[^\s/]+)*\/([A-Za-z0-9._-]{2,80}?)(?:\.git|\/-\/|\s|$)/gi,
  ];
  for (const pattern of labelPatterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.replace(/\.git$/i, '').trim();
      if (candidate && !['http', 'https', 'jira', 'confluence'].includes(candidate.toLowerCase())) repoSet.add(candidate);
    }
  }
  const repoHintNames = [...repoSet];
  const lowerHints = repoHintNames.map(item => item.toLowerCase());
  const matchedRepos: LocalGitRepoInfo[] = [];
  for (const repo of repositories) {
    const nameLower = repo.name.toLowerCase();
    if (lowerHints.some(hint => nameLower === hint || nameLower === `${hint}-tasks`)) {
      matchedRepos.push(repo);
    }
  }
  if (!matchedRepos.length && projectPrefix) {
    const prefixLower = projectPrefix.toLowerCase();
    for (const repo of repositories) {
      if (repo.name.toLowerCase().includes(prefixLower) || (repo.group || '').toLowerCase().includes(prefixLower)) {
        matchedRepos.push(repo);
      }
    }
  }

  return { detectedLinks, relatedJira, repoHintNames, matchedRepos: matchedRepos.slice(0, 6) };
}

export function formatJiraDescriptionForDisplay(description: unknown): string {
  return flattenDescription(description)
    .split(/\r?\n/)
    .filter(line => !/^(?:JIRA_DEV_REQUIREMENT_MARKER:[ \t]*jira-dev-requirement-[\w-]+|Repository ID:[ \t]*git-[\da-f]{64})[ \t]*$/i.test(line.trim()))
    .map(line => line
      .replace(/^\*([^*]+)\*[ \t]*$/, '**$1**')
      .replace(/\[([^|\]]+)\|(https?:\/\/[^\s\]|]+)\]/g, (wikiLink, label: string, url: string) => {
        const href = cleanExtractedUrl(url.replace(/\(/g, '%28').replace(/\)/g, '%29'));
        if (!href) return wikiLink;
        const host = new URL(href).hostname.replace(/^www\./, '');
        const linkText = label === url ? (/(^|\.)figma\.(?:com|site)$/i.test(host) ? 'Figma 设计稿' : classifyUrl(href).label) : label;
        return `[${linkText}](${href})`;
      }))
    .join('\n')
    .trim();
}

export function formatJiraTaskAsMarkdown(task: Pick<WorkTask, 'jiraKey' | 'title' | 'externalRef'>): string {
  const ref = task.externalRef;
  const body = flattenDescription(ref?.description).trim();
  return [
    `# ${task.jiraKey} · ${ref?.title || task.title}`,
    ref?.type ? `- 事项类型：${ref.type}` : '',
    ref?.status ? `- Jira 状态：${ref.status}` : '',
    ref?.priority?.name ? `- 优先级：${ref.priority.name}` : '',
    ref?.parentKey ? `- 父事项：${ref.parentKey}` : '',
    ref?.url ? `- 原始链接：${ref.url}` : '',
    '',
    '## 需求与背景说明',
    body || '（Jira 原事项暂无详细文本描述，请补充验收口径）',
  ].filter(Boolean).join('\n').slice(0, 65_536);
}

export function buildAssetTemplate(
  kind: AssetKind,
  task: Pick<WorkTask, 'jiraKey' | 'title'>,
  repoPath?: string | null,
): { title: string; content: string } {
  const repoName = repoPath ? repoPath.split('/').filter(Boolean).pop() || repoPath : '待定业务仓库';
  if (kind === 'PRD') {
    return {
      title: `${task.jiraKey} 需求说明 · ${task.title}`.slice(0, 200),
      content: [
        `# ${task.jiraKey} · ${task.title}`,
        '',
        '## 1. 业务背景与目标',
        '- 解决的核心痛点与预期业务收益：',
        '',
        '## 2. 核心功能与状态流转规则',
        '- 主流程交互与关键状态迁移：',
        '- 角色与权限边界：',
        '',
        '## 3. 非目标与范围外边界（Non-Goals）',
        '- 本轮明确不做 / 暂不改动的存量逻辑（防止实现范围蔓延）：',
        '',
        '## 4. 边界条件与异常流处理',
        '- 空状态 / 并发重复提交 / 下游超时或失败提示：',
        '',
        '## 5. 验收标准（AC）',
        '- [ ] ',
      ].join('\n'),
    };
  }
  if (kind === 'TECH_SPEC') {
    return {
      title: `${task.jiraKey} 技术方案 · ${repoName}`.slice(0, 200),
      content: [
        `# ${task.jiraKey} 技术方案（${task.title}）`,
        `- 关联工程：\`${repoPath || repoName}\``,
        '',
        '## 1. 架构与模块改动范围',
        '- 涉及模块 / 页面 / 接口：',
        '- 不受影响的上下游边界：',
        '',
        '## 2. 核心接口契约（Golden Contract）与数据模型',
        '- 请求 / 响应字段、错误码与鉴权约定：',
        '- 兼容性、事务与幂等性保障：',
        '',
        '## 3. 核心时序与状态流转',
        '- ',
        '',
        '## 4. 可观测性、风险评估与回滚预案',
        '- 关键日志 / 监控告警指标：',
        '- 降级开关与应急回滚步骤：',
      ].join('\n'),
    };
  }
  if (kind === 'TEST_CASE') {
    return {
      title: `${task.jiraKey} 测试与验收用例`.slice(0, 200),
      content: [
        `# ${task.jiraKey} 测试用例（${task.title}）`,
        '',
        '## 1. 正向主流程验证',
        '- [ ] 用例 1：输入有效参数，验证主流程状态与结果符合预期',
        '',
        '## 2. 边界值与异常场景验证',
        '- [ ] 用例 2：空值 / 重复提交 / 权限不足 / 网络超时处理',
        '',
        '## 3. 存量功能回归验证',
        '- [ ] 用例 3：确认关联老流程与上下游兼容不受影响',
      ].join('\n'),
    };
  }
  if (kind === 'RELEASE_PLAN') {
    return {
      title: `${task.jiraKey} 上线与回滚计划 · ${repoName}`.slice(0, 200),
      content: [
        `# ${task.jiraKey} 上线发布计划（${task.title}）`,
        `- 发布工程：\`${repoPath || repoName}\``,
        '',
        '## 1. 发布前置检查',
        '- [ ] 配置项 / 环境变量 / SQL 变更已核对',
        '- [ ] 代码审核与测试验收已通过',
        '',
        '## 2. 发布步骤与顺序',
        '1. ',
        '',
        '## 3. 线上核验指标（Smoke Check）',
        '- [ ] 核心页面加载与关键接口响应正常',
        '',
        '## 4. 应急回滚方案',
        '- 回滚触发条件与操作步骤：',
      ].join('\n'),
    };
  }
  return {
    title: `${task.jiraKey} 代码变更说明 · ${repoName}`.slice(0, 200),
    content: `# ${task.jiraKey} 代码变更摘要\n- 仓库：${repoPath || repoName}\n\n`,
  };
}

export function detectPastedReference(raw: string): {
  provider: 'confluence' | 'gitlab' | 'jenkins' | 'jira' | 'yunxiao' | null;
  url?: string;
  issueKey?: string;
  suggestedKinds: AssetKind[];
  label: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { provider: null, suggestedKinds: [], label: '' };
  if (/^[A-Za-z][A-Za-z0-9]{0,15}-[1-9]\d{0,7}$/.test(trimmed)) {
    const key = trimmed.toUpperCase();
    return { provider: 'jira', issueKey: key, suggestedKinds: ['PRD', 'TECH_SPEC'], label: `Jira 事项 ${key}` };
  }
  const clean = cleanExtractedUrl(trimmed);
  if (!clean) return { provider: null, suggestedKinds: [], label: '' };
  const info = classifyUrl(clean);
  if (info.provider === 'external') return { provider: null, url: clean, suggestedKinds: [], label: info.label };
  return {
    provider: info.provider,
    url: clean,
    ...(info.issueKey ? { issueKey: info.issueKey } : {}),
    suggestedKinds: info.suggestedKinds,
    label: info.label,
  };
}

export function buildClipboardGitCommand(repoPath: string, mode: 'working' | 'head' = 'working'): string {
  const quoted = "'" + repoPath.replace(/'/g, "'\\''") + "'";
  return mode === 'head'
    ? `git -C ${quoted} show --stat --patch HEAD | pbcopy`
    : `(git -C ${quoted} status --short && echo "" && git -C ${quoted} diff HEAD) | pbcopy`;
}

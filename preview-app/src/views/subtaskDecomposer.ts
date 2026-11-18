import { isLocalTaskKey, type Asset, type WorkTask } from './workspaceApi.ts';

export interface SubtaskCandidate {
  jiraKey: string;
  title: string;
  type: WorkTask['type'];
  source: 'PRD' | 'TECH_SPEC' | 'JIRA' | 'STANDARD' | 'CUSTOM';
}

const JIRA_KEY_RE = /^([A-Z][A-Z0-9]*)-([1-9]\d*)$/;

const IGNORED_SECTION_RE =
  /(?:背景|概述|非目标|本次不做|不做项|不涉及|超出范围|参考资料|参考链接|附录|名词解释|修订记录|变更历史|\bnon-goals?\b|\bout\s+of\s+scope\b|\bbackground\b|\breferences?\b|\bglossary\b)/i;

const ACTIONABLE_HEADING_PARENT_RE =
  /(?:核心方案|技术方案|改造点|改动点|功能清单|需求拆解|子任务|模块拆解|实施步骤|开发任务|接口设计|前端改造|后端改造)/i;

const PLACEHOLDER_RE =
  /^(?:待补充|待完善|待确认|暂无|无|略|TBD|TODO|N\/A|填写.+|请补充.+|例如[:：].*|<.*>)$/i;

const METADATA_LINE_RE =
  /^(?:Jira\s*Key|任务号|事项号|状态|任务状态|优先级|负责人|报告人|创建时间|更新时间|所属项目|来源链接|SHA256)\s*[:：]/i;

export function parseJiraKeyParts(jiraKey: string): { prefix: string; num: number } {
  const normalized = (jiraKey || '').trim().toUpperCase();
  const match = JIRA_KEY_RE.exec(normalized);
  if (match) {
    return { prefix: match[1], num: Number.parseInt(match[2], 10) };
  }
  const prefixMatch = /^([A-Z][A-Z0-9]*)/.exec(normalized);
  return { prefix: prefixMatch?.[1] || 'TASK', num: 100 };
}

export function allocateNextJiraKeys(
  parentKey: string,
  existingKeys: Iterable<string>,
  count: number,
): string[] {
  if (count <= 0 || isLocalTaskKey(parentKey)) return [];
  const { prefix, num } = parseJiraKeyParts(parentKey);
  const taken = new Set<string>();
  for (const key of existingKeys) {
    if (typeof key === 'string' && key.trim()) {
      taken.add(key.trim().toUpperCase());
    }
  }
  taken.add(`${prefix}-${num}`);

  const allocated: string[] = [];
  let cursor = Math.max(1, num + 1);
  while (allocated.length < count && cursor < num + 100_000) {
    const candidate = `${prefix}-${cursor}`;
    if (!taken.has(candidate)) {
      allocated.push(candidate);
      taken.add(candidate);
    }
    cursor += 1;
  }
  return allocated;
}

export function inferSubtaskType(title: string): WorkTask['type'] {
  const text = (title || '').trim();
  if (/(?:修复|缺陷|故障|报错|异常修复|闪退|死锁|内存泄漏|\bbug\b|\bhotfix\b|\bfix\b)/i.test(text)) {
    return 'BUG';
  }
  if (/(?:灰度|上线|发布|回滚|放量|演练|切流|投产|\brelease\b|\bcanary\b|\brollback\b)/i.test(text)) {
    return 'RELEASE';
  }
  return 'TASK';
}

function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s·•\-_:：,，.。;；!！?？()（）[\]【】'"`]+/g, '');
}

function cleanCandidateLine(raw: string): string {
  let text = raw
    .trim()
    // Strip markdown links [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip bold/italic/code markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Strip leading tags like [FE] / 【后端】 only if followed by empty? Keep meaningful tags like 【前端】!
    .replace(/\s+/g, ' ')
    .replace(/[；;。，,]+$/g, '')
    .trim();

  if (text.length > 120) {
    text = `${text.slice(0, 117).trim()}...`;
  }
  return text;
}

function parseActionableLinesFromMarkdown(content: string): string[] {
  if (!content || typeof content !== 'string') return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const extracted: string[] = [];
  let inCodeFence = false;
  let ignoreCurrentSection = false;
  let inActionableParentSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || !trimmed) continue;

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = cleanCandidateLine(headingMatch[2].replace(/^\d+(?:\.\d+)*[.)、\s]+/, ''));
      if (level <= 2) {
        ignoreCurrentSection = IGNORED_SECTION_RE.test(headingText);
        inActionableParentSection = !ignoreCurrentSection && ACTIONABLE_HEADING_PARENT_RE.test(headingText);
      } else if (level === 3) {
        if (IGNORED_SECTION_RE.test(headingText)) {
          ignoreCurrentSection = true;
        } else if (!ignoreCurrentSection && inActionableParentSection && headingText.length >= 4) {
          extracted.push(headingText);
        }
      }
      continue;
    }

    if (ignoreCurrentSection) continue;
    // Skip markdown table rows and blockquotes
    if (trimmed.startsWith('|') || trimmed.startsWith('>')) continue;

    // Checked task items are already finished -> skip
    if (/^[-*+]\s+\[[xX]\]\s+/.test(trimmed)) continue;

    const uncheckedMatch = /^[-*+]\s+\[\s\]\s+(.+)$/.exec(trimmed);
    const bulletMatch = uncheckedMatch || /^(?:[-*+]|\d+[.)、])\s+(.+)$/.exec(trimmed);
    if (!bulletMatch) continue;

    const cleaned = cleanCandidateLine(bulletMatch[1]);
    if (cleaned.length < 4) continue;
    if (PLACEHOLDER_RE.test(cleaned)) continue;
    if (METADATA_LINE_RE.test(cleaned)) continue;
    if (/^https?:\/\/\S+$/i.test(cleaned)) continue;

    extracted.push(cleaned);
  }

  return extracted;
}

export function extractSubtaskCandidatesFromSpecs(params: {
  parentTask: WorkTask;
  assets: Asset[];
  existingTasks: WorkTask[];
  maxCount?: number;
}): SubtaskCandidate[] {
  const { parentTask, assets, existingTasks, maxCount = 8 } = params;
  const existingChildTitles = new Set(
    existingTasks
      .filter(t => t.parentId === parentTask.id)
      .map(t => normalizeTitleForDedup(t.title)),
  );
  existingChildTitles.add(normalizeTitleForDedup(parentTask.title));

  // Pick latest revision per logicalKey for TECH_SPEC and PRD
  const latestByKey = new Map<string, Asset>();
  for (const asset of assets) {
    if (asset.kind !== 'PRD' && asset.kind !== 'TECH_SPEC') continue;
    const mapKey = `${asset.kind}:${asset.logicalKey}`;
    const prev = latestByKey.get(mapKey);
    if (!prev || asset.revision > prev.revision) {
      latestByKey.set(mapKey, asset);
    }
  }

  // Prefer TECH_SPEC items first (more concrete implementation units), then PRD items
  const orderedSources: { source: SubtaskCandidate['source']; content: string }[] = [];
  for (const asset of latestByKey.values()) {
    if (asset.kind === 'TECH_SPEC') {
      orderedSources.push({ source: 'TECH_SPEC', content: asset.content });
    }
  }
  for (const asset of latestByKey.values()) {
    if (asset.kind === 'PRD') {
      orderedSources.push({ source: 'PRD', content: asset.content });
    }
  }
  if (typeof parentTask.externalRef?.description === 'string' && parentTask.externalRef.description.trim()) {
    orderedSources.push({ source: 'JIRA', content: parentTask.externalRef.description });
  }

  const rawDrafts: Omit<SubtaskCandidate, 'jiraKey'>[] = [];
  const seenTitles = new Set<string>();

  for (const src of orderedSources) {
    const items = parseActionableLinesFromMarkdown(src.content);
    for (const title of items) {
      const norm = normalizeTitleForDedup(title);
      if (!norm || existingChildTitles.has(norm) || seenTitles.has(norm)) continue;
      seenTitles.add(norm);
      rawDrafts.push({
        title,
        type: inferSubtaskType(title),
        source: src.source,
      });
      if (rawDrafts.length >= maxCount) break;
    }
    if (rawDrafts.length >= maxCount) break;
  }

  const keys = allocateNextJiraKeys(
    parentTask.jiraKey,
    existingTasks.map(t => t.jiraKey),
    rawDrafts.length,
  );

  return rawDrafts.map((item, idx) => ({
    ...item,
    jiraKey: keys[idx] ?? '',
  }));
}

export function buildStandardDeliverySubtasks(
  parentTask: WorkTask,
  existingTasks: WorkTask[],
): SubtaskCandidate[] {
  const shortParent = parentTask.title.trim().slice(0, 36);
  const prefix = shortParent ? `${shortParent} · ` : '';
  const existingChildTitles = new Set(
    existingTasks
      .filter(t => t.parentId === parentTask.id)
      .map(t => normalizeTitleForDedup(t.title)),
  );

  const templates: { suffix: string; type: WorkTask['type'] }[] = [
    { suffix: '核心接口与领域逻辑实现', type: 'TASK' },
    { suffix: '前端交互联调与状态自测', type: 'TASK' },
    { suffix: '边界用例与自动化回归验证', type: 'TASK' },
    { suffix: '灰度放量配置与上线回滚核验', type: 'RELEASE' },
  ];

  const filtered = templates
    .map(tpl => ({
      title: `${prefix}${tpl.suffix}`.slice(0, 120),
      type: tpl.type,
      source: 'STANDARD' as const,
    }))
    .filter(item => !existingChildTitles.has(normalizeTitleForDedup(item.title)));

  const keys = allocateNextJiraKeys(
    parentTask.jiraKey,
    existingTasks.map(t => t.jiraKey),
    filtered.length,
  );

  return filtered.map((item, idx) => ({
    ...item,
    jiraKey: keys[idx] ?? '',
  }));
}

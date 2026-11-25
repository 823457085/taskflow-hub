import type { Finding } from './workspaceApi.ts';

const SEVERITY_ORDER: Record<Finding['severity'], number> = { CRITICAL: 0, WARN: 1, INFO: 2 };

export function sortReviewFindings<T extends Pick<Finding, 'severity'>>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function plainReviewText(text: string): string {
  return text
    .replace(/符合\s*CRITICAL\s*定义的问题/g, ' P0 阻断问题')
    .replace(/(?<![\w./\-])CRITICAL(?![\w./\-])/g, 'P0 阻断问题')
    .replace(/(?:当前\s*)?PRD\s*的\s*(?:明确\s*)?BLOCK\s*规则失败/g, '需求评审中未通过的必查项')
    .replace(/(?<![\w./\-])BLOCK\s*规则(?![\w./\-])/g, '必查项');
}

const DETAIL_LABELS = { 问题: '哪里有问题', 影响: '会影响什么', 建议: '建议怎么改' } as const;
type DetailLabel = keyof typeof DETAIL_LABELS;

export function reviewDetailSections(detail: string): { label: string; text: string }[] {
  const text = detail.trim();
  if (!text) return [];

  const headings = [...text.matchAll(/^[ \t]*(问题|影响|建议)[ \t]*[：:][ \t]*/gm)];
  if (headings.length) {
    const intro = text.slice(0, headings[0].index).trim();
    return [
      ...(intro ? [{ label: '问题说明', text: intro }] : []),
      ...headings.map((heading, index) => ({
        label: DETAIL_LABELS[heading[1] as DetailLabel],
        text: text.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim(),
      })).filter(section => section.text),
    ];
  }

  const suggestion = /[。！？；]\s*(?=建议|请(?!(?:求|示))|需(?:要)?(?:明确|补充|确认|修正|统一))/.exec(text);
  if (suggestion) {
    const start = suggestion.index + suggestion[0].length;
    return [
      { label: '问题说明', text: text.slice(0, start).trim() },
      { label: '建议怎么改', text: text.slice(start).replace(/^建议[：:]?\s*/, '') },
    ];
  }
  return [{ label: '问题说明', text }];
}

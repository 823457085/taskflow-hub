import { isUnifiedDiffContent } from './assetDiff.ts';

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'link'; text: string; href: string };

export interface ChecklistItem {
  checked: boolean;
  text: string;
}

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'checklist'; items: ChecklistItem[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string };

const SAFE_HTTP_URL_RE = /^https?:\/\/[^\s<>"\\\u0000-\u001F\u007F]+$/i;
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const TABLE_SEPARATOR_RE = /^\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|?$/;

export function isSafeHttpUrl(url: string): boolean {
  if (!SAFE_HTTP_URL_RE.test(url.trim())) return false;
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function parsePlainUrlTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\x60|\\，。；：！？、…（）【】《》“”‘’]+/gi)) {
    const raw = match[0];
    const balance: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
    for (const [close, open] of Object.entries(CLOSING_BRACKETS)) {
      balance[close] = raw.split(open).length - raw.split(close).length;
    }
    let end = raw.length;
    while (end > 0) {
      const char = raw[end - 1];
      if (/[.,!?;:]/.test(char)) {
        end -= 1;
      } else if (balance[char] < 0) {
        balance[char] += 1;
        end -= 1;
      } else {
        break;
      }
    }
    const href = raw.slice(0, end);
    if (!isSafeHttpUrl(href)) continue;
    if (match.index > lastIndex) tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    tokens.push({ type: 'link', href, text: href });
    lastIndex = match.index + end;
  }
  if (lastIndex < text.length) tokens.push({ type: 'text', text: text.slice(lastIndex) });
  return tokens;
}

export function isLikelyMarkdown(content: string, kind?: string): boolean {
  if (!content || isUnifiedDiffContent(content)) return false;
  if (kind && ['PRD', 'TECH_SPEC', 'TEST_CASE', 'RELEASE_PLAN'].includes(kind)) {
    return true;
  }
  return /(?:^|\n)(?:#{1,4}\s+\S+|[-*+]\s+\S+|\d+\.\s+\S+|```|\|.+\|\n\|?\s*:?-{2,})/.test(content);
}

export function parseInlineTokens(text: string): InlineToken[] {
  if (!text) return [];
  const tokens: InlineToken[] = [];
  const pattern = /\x60([^\x60\n]+)\x60|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|<(https?:\/\/[^\s<>"]+)>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(...parsePlainUrlTokens(text.slice(lastIndex, match.index)));
    }
    if (match[1] !== undefined) {
      tokens.push({ type: 'code', text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const candidateHref = match[3].trim();
      if (isSafeHttpUrl(candidateHref)) {
        tokens.push({ type: 'link', text: match[2], href: candidateHref });
      } else {
        tokens.push({ type: 'text', text: match[0] });
      }
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'strong', text: match[4] });
    } else if (isSafeHttpUrl(match[5])) {
      tokens.push({ type: 'link', text: match[5], href: match[5] });
    } else {
      tokens.push({ type: 'text', text: match[0] });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(...parsePlainUrlTokens(text.slice(lastIndex)));
  }
  return tokens;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(cell => cell.trim());
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = /^(```|~~~)([^\s`~]*)/.exec(trimmed);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(4, headingMatch[1].length) as 1 | 2 | 3 | 4;
      blocks.push({ type: 'heading', level, text: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    // GFM Table
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1].trim())
    ) {
      const headers = splitTableCells(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && !/^(?:```|~~~)/.test(lines[i].trim())) {
        rows.push(splitTableCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    // Checklist (- [ ] / - [x])
    if (/^[-*+]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const items: ChecklistItem[] = [];
      while (i < lines.length) {
        const m = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(lines[i].trim());
        if (!m) break;
        items.push({ checked: m[1].toLowerCase() === 'x', text: m[2].trim() });
        i += 1;
      }
      blocks.push({ type: 'checklist', items });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+\S/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const lineTrim = lines[i].trim();
        if (/^[-*+]\s+\[[ xX]\]\s+/.test(lineTrim)) break;
        const m = /^[-*+]\s+(.+)$/.exec(lineTrim);
        if (!m) break;
        items.push(m[1].trim());
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+\S/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\d+[.)]\s+(.+)$/.exec(lines[i].trim());
        if (!m) break;
        items.push(m[1].trim());
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (
        !cur ||
        /^(?:```|~~~|#{1,6}\s|>|[-*+]\s+\S|\d+[.)]\s+\S|-{3,}$|\*{3,}$)/.test(cur) ||
        (cur.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1].trim()))
      ) {
        break;
      }
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
    } else {
      i += 1;
    }
  }

  return blocks;
}

export function summarizeMarkdownChecklists(blocks: MarkdownBlock[]): { checked: number; total: number } {
  let checked = 0;
  let total = 0;
  for (const b of blocks) {
    if (b.type === 'checklist') {
      for (const item of b.items) {
        total += 1;
        if (item.checked) checked += 1;
      }
    }
  }
  return { checked, total };
}

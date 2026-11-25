import { isUnifiedDiffContent, parseUnifiedDiffStats } from './assetDiff.ts';
import { parseMarkdownBlocks, type MarkdownBlock } from './markdownLite.ts';

const TEST_COUNT_NAMES = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;
type TestCountName = typeof TEST_COUNT_NAMES[number];
export type NodeTestSummary = Record<TestCountName, number>;

export function summarizeNodeTests(output: string): NodeTestSummary | null {
  const counts = new Map<string, number>();
  let reporter: string | undefined;
  for (const match of output.matchAll(/^[ \t]*(ℹ(?:\uFE0F)?|#)[ \t]+(tests|pass|fail|cancelled|skipped|todo)[ \t]+(\d+)[ \t]*\r?$/gm)) {
    const prefix = match[1][0];
    const key = match[2];
    const count = Number(match[3]);
    if ((reporter && reporter !== prefix) || counts.has(key) || !Number.isSafeInteger(count)) return null;
    reporter = prefix;
    counts.set(key, count);
  }
  if (counts.size !== TEST_COUNT_NAMES.length) return null;
  const [tests, pass, fail, cancelled, skipped, todo] = TEST_COUNT_NAMES.map(key => counts.get(key)!);
  return tests === pass + fail + cancelled + skipped + todo ? { tests, pass, fail, cancelled, skipped, todo } : null;
}

const META_LABELS = new Map([
  ['仓库', '仓库'],
  ['仓库目录', '仓库'],
  ['Git 仓库', '仓库地址'],
  ['分支', '分支'],
  ['当前分支', '分支'],
  ['对应分支', '对比分支'],
  ['提交', '提交'],
  ['Commit SHA', '提交'],
  ['基准提交', '基准提交'],
  ['提取范围', '提取范围'],
]);

function patchStart(lines: string[]): number {
  let fence = '';
  for (const [index, line] of lines.entries()) {
    const marker = /^(`{3}|~{3})/.exec(line.trim())?.[1];
    if (fence) {
      if (marker === fence) fence = '';
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (isUnifiedDiffContent(line) || line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) return index;
  }
  return -1;
}

type PreviewSection = { type: 'markdown'; blocks: MarkdownBlock[] }
  | { type: 'test'; code: string; counts: NodeTestSummary }
  | { type: 'diff'; code: string; files: number; additions: number; deletions: number }
  | { type: 'code'; code: string; lang: string };

export function buildCodeMaterialPreview(content: string): {
  metadata: { label: string; value: string }[];
  sections: PreviewSection[];
} {
  const metadata = new Map<string, string>();
  const sections: PreviewSection[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const diffStart = patchStart(lines);
  const beforePatch = (diffStart < 0 ? lines : lines.slice(0, diffStart)).join('\n');
  const note = diffStart < 0 ? beforePatch : beforePatch.replace(/(?:^|\n)#{1,6}\s+(?:Patch Diff|Diff|代码差异)\s*$/i, '');
  const blocks = parseMarkdownBlocks(note);
  let readMetadata = true;
  let prose: MarkdownBlock[] = [];
  const flush = () => {
    if (prose.length) sections.push({ type: 'markdown', blocks: prose });
    prose = [];
  };
  const appendCode = (code: string, lang: string) => {
    flush();
    const counts = summarizeNodeTests(code);
    if (isUnifiedDiffContent(code)) {
      const { files, additions, deletions } = parseUnifiedDiffStats(code);
      sections.push({ type: 'diff', code, files: files.length, additions, deletions });
    } else if (counts) {
      sections.push({ type: 'test', code, counts });
    } else {
      sections.push({ type: 'code', code, lang });
    }
  };

  if (blocks.every(block => block.type !== 'code') && summarizeNodeTests(note)) {
    appendCode(note, 'text');
  } else if (blocks.some(block => block.type !== 'paragraph') || diffStart >= 0) {
    for (const block of blocks) {
      if (block.type === 'heading' && block.level > 1 || block.type === 'code') readMetadata = false;
      if (block.type === 'code') {
        appendCode(block.code, block.lang);
      } else if (readMetadata && block.type === 'heading') {
        const match = /^(.*?)\s*[（(]\s*branch\s*[:：]\s*([^,，\s]+)\s*[,，]\s*commit\s*[:：]\s*([a-f\d]{7,64})\s*[）)]$/i.exec(block.text);
        if (match) {
          metadata.set('分支', match[2]);
          metadata.set('提交', match[3]);
          if (match[1]) prose.push({ ...block, text: match[1] });
        } else {
          prose.push(block);
        }
      } else if (readMetadata && block.type === 'ul') {
        const items = block.items.filter(item => {
          const [, key, raw] = /^([^:：]+)[:：]\s*(.+)$/.exec(item) ?? [];
          const label = META_LABELS.get(key?.trim());
          if (!label) return true;
          let value = raw.trim().replace(/^`(.+)`$/, '$1');
          if (key.trim() === '仓库') value = value.replace(/\s*[（(]本地目录[:：].*[）)]\s*$/, '');
          if (key.trim() === '仓库目录') value = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
          if (!metadata.has(label)) metadata.set(label, value);
          return false;
        });
        if (items.length) prose.push({ ...block, items });
      } else {
        prose.push(block);
      }
    }
    flush();
  }

  if (diffStart >= 0) appendCode(lines.slice(diffStart).join('\n'), 'diff');
  return { metadata: [...metadata].map(([label, value]) => ({ label, value })), sections };
}

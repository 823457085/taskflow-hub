const SENSITIVE_QUERY_KEY = /token|password|secret|auth|api[-_]?key|credential|signature|^sig$/i;
const SENSITIVE_HASH_PARAM = /(?:^|[?&#])(?:access_token|token|password|secret|authorization|auth|api[-_]?key|credential|signature|sig)=/i;
const DESIGN_HOST_PATTERN = /(^|\.)(figma\.com|figma\.site|axure\.cloud|axshare\.com|pixso\.cn|js\.design|modao\.cc|lanhuapp\.com|mastergo\.com)$/i;

export function safeReviewLink(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new Error('请输入有效的 HTTP 或 HTTPS 链接。');
  }
  const url = new URL(trimmed);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      [...url.searchParams.keys()].some(key => SENSITIVE_QUERY_KEY.test(key)) ||
      SENSITIVE_HASH_PARAM.test(url.hash)) {
    throw new Error('请输入不带账号或访问令牌的网页链接。');
  }
  return url;
}

export function isDesignLink(value: string): boolean {
  try {
    return DESIGN_HOST_PATTERN.test(safeReviewLink(value).hostname);
  } catch {
    return false;
  }
}

export function isFigmaLink(value: string): boolean {
  try {
    return /(^|\.)figma\.(?:com|site)$/i.test(safeReviewLink(value).hostname);
  } catch {
    return false;
  }
}

export function parseReviewSourceLinks(raw: string): { links: string[]; error?: string } {
  const normalized = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!normalized) return { links: [] };

  // Split by whitespace or common list separators (comma/semicolon/Chinese punctuation)
  // when followed by another URL or end-of-input, while keeping commas inside a single URL path intact.
  const tokens = normalized
    .split(/(?:\s+|(?:\s*[,，;；、]+\s*)(?=https?:\/\/|$))/)
    .map(part => part.trim().replace(/^<+/, '').replace(/>+$/, '').replace(/[,，;；、。]+$/, '').trim())
    .filter(Boolean);

  if (!tokens.length) return { links: [] };

  const links: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    let url: URL;
    try {
      url = safeReviewLink(token);
    } catch (error) {
      if (error instanceof Error && error.message.includes('账号或访问令牌')) {
        return { links: [], error: error.message };
      }
      return { links: [], error: '请输入有效的 HTTP 或 HTTPS 链接（多个链接可用逗号、空格或换行分隔）。' };
    }
    if (!seen.has(url.href)) {
      seen.add(url.href);
      links.push(url.href);
    }
  }
  return { links };
}

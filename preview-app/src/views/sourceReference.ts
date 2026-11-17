export type SourceProvider = 'confluence' | 'gitlab' | 'jenkins' | 'yunxiao';
export type SourceParameters =
  | { resource: 'confluence_page'; pageId: string }
  | { resource: 'gitlab_mr'; repositoryId: string; mrIid: string }
  | { resource: 'jenkins_build'; jobName: string; buildNumber: string }
  | { resource: 'yunxiao_mr'; repositoryId: string; mrLocalId: string }
  | { resource: 'yunxiao_commit'; repositoryId: string; commitSha: string };

const unsafeName = /(?:token|password|passwd|secret|authorization|api[-_]?key|auth)/i;
const invalid = () => new Error('请使用当前已配置平台的有效页面、MR 或构建链接，或切换到手动填写。');
const positive = (value: string) => /^[1-9]\d{0,15}$/.test(value);
const decodedSegment = (value: string) => {
  let result: string;
  try { result = decodeURIComponent(value); } catch { throw invalid(); }
  if (!result || result === '.' || result === '..' || /[/\\?#\x00-\x1f\x7f]/.test(result)) throw invalid();
  return result;
};

export function decodeConfluenceTinyId(tinyId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,11}$/.test(tinyId)) return null;
  let b64 = tinyId.replace(/-/g, '/').replace(/_/g, '+');
  if (b64.length % 4 === 1) return null;
  while (b64.length % 4 !== 0) b64 += '=';
  let bin: string;
  try { bin = atob(b64); } catch { return null; }
  if (!bin.length || bin.length > 8 || btoa(bin) !== b64) return null;
  const bytes = Uint8Array.from(bin, char => char.charCodeAt(0));
  if (bytes[bytes.length - 1] === 0) return null;
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  if (value <= 0n || value > 9_999_999_999_999_999n) return null;
  const pageId = value.toString();
  return positive(pageId) ? pageId : null;
}

// Parse identifiers only. Network access still uses the configured connector API.
export function parseSourceReference(provider: SourceProvider, reference: string, baseUrl: string): SourceParameters {
  if (typeof reference !== 'string' || reference.length > 2048 || /[\x00-\x1f\x7f\\]/.test(reference) || /%2e|%2f|%5c/i.test(reference)) throw invalid();
  const input = reference.trim();
  if (/(?:^|\/)\.{1,2}(?:\/|$|[?#])/.test(input)) throw invalid();
  let url: URL; let base: URL;
  try { url = new URL(input); base = new URL(baseUrl); } catch { throw invalid(); }
  const codeupWebOrigin = provider === 'yunxiao' && url.origin === 'https://codeup.aliyun.com';
  if (!['https:', 'http:'].includes(url.protocol) || !['https:', 'http:'].includes(base.protocol) || url.username || url.password || base.username || base.password || base.search || base.hash || (!codeupWebOrigin && url.origin !== base.origin)) throw invalid();
  if ([...url.searchParams.keys()].some(name => unsafeName.test(name)) || /(?:^|[?&#])(?:access_token|token|password|secret|authorization|api[-_]?key|auth)=/i.test(url.hash)) throw invalid();
  const basePath = codeupWebOrigin ? '' : base.pathname.replace(/\/+$/, '');
  if (basePath && !url.pathname.startsWith(basePath + '/')) throw invalid();
  const path = url.pathname.slice(basePath.length).replace(/\/+$/, '');

  if (provider === 'yunxiao') {
    const mrMatch = path.match(/^\/(.+)\/(?:change|merge_request|merge_requests)\/([1-9]\d*)$/);
    if (mrMatch && positive(mrMatch[2])) {
      const parts = mrMatch[1].split('/').map(decodedSegment);
      const repositoryId = parts.join('/');
      if (parts.length < 2 || repositoryId.length > 300) throw invalid();
      return { resource: 'yunxiao_mr', repositoryId, mrLocalId: mrMatch[2] };
    }
    const commitMatch = path.match(/^\/(.+)\/commit\/([0-9a-f]{7,64})$/i);
    if (commitMatch) {
      const parts = commitMatch[1].split('/').map(decodedSegment);
      const repositoryId = parts.join('/');
      if (parts.length < 2 || repositoryId.length > 300) throw invalid();
      return { resource: 'yunxiao_commit', repositoryId, commitSha: commitMatch[2] };
    }
    throw invalid();
  }

  if (provider === 'confluence') {
    let pageId: string | null = null;
    if (path === '/pages/viewpage.action' && url.searchParams.getAll('pageId').length === 1) pageId = url.searchParams.get('pageId');
    else pageId = path.match(/^\/spaces\/[^/]+\/pages\/([1-9]\d*)(?:\/.*)?$/)?.[1] || null;
    if (!pageId) {
      const tiny = path.match(/^\/x\/([A-Za-z0-9_-]{1,11})$/)?.[1];
      if (tiny) pageId = decodeConfluenceTinyId(tiny);
    }
    if (!pageId || !positive(pageId)) throw invalid();
    return { resource: 'confluence_page', pageId };
  }
  if (provider === 'gitlab') {
    const match = path.match(/^\/(.+)\/-\/merge_requests\/([1-9]\d*)(?:\/(?:diffs|commits))?$/);
    if (!match || !positive(match[2])) throw invalid();
    const parts = match[1].split('/').map(decodedSegment);
    const repositoryId = parts.join('/');
    if (parts.length < 2 || repositoryId.length > 300) throw invalid();
    return { resource: 'gitlab_mr', repositoryId, mrIid: match[2] };
  }
  if (provider === 'jenkins') {
    const parts = path.split('/').slice(1); const names: string[] = []; let index = parts[0] === 'view' && parts[1] ? 2 : 0;
    while (parts[index] === 'job' && parts[index + 1]) { names.push(decodedSegment(parts[index + 1])); index += 2; }
    const remainder = parts.slice(index);
    if (remainder.length === 2 && ['console', 'consoleFull'].includes(remainder[1])) remainder.pop();
    const buildNumber = remainder.length ? remainder[0] : 'lastSuccessfulBuild';
    const jobName = names.join('/');
    if (!names.length || jobName.length > 500 || remainder.length > 1 || !(['lastBuild', 'lastSuccessfulBuild'].includes(buildNumber) || positive(buildNumber))) throw invalid();
    return { resource: 'jenkins_build', jobName, buildNumber };
  }
  throw invalid();
}

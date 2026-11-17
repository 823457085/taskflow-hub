const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const invalid = () => new Error('请输入有效的 Jira 事项链接或任务号，例如 SAMPLE-562。');

// Parse identifiers only. Remote requests must use a configured connector URL.
export function parseJiraReference(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\x00-\x1f\x7f]/.test(value)) throw invalid();
  const text = value.trim();
  if (!text) throw invalid();
  const direct = text.toUpperCase();
  if (direct.length <= 48 && ISSUE_KEY.test(direct)) return { key: direct, url: null };
  let url;
  try { url = new URL(text); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /\s/.test(text)) throw invalid();
  for (const name of url.searchParams.keys()) {
    if (/(?:token|password|secret|authorization|api[_-]?key|access[_-]?key|auth)/i.test(name)) throw new Error('Jira 链接不能包含认证信息，请复制普通事项链接。');
  }
  if (/(?:^|[?&#])(?:access_token|token|password|secret|authorization|api[_-]?key|auth)=/i.test(url.hash)) throw new Error('Jira 链接不能包含认证信息，请复制普通事项链接。');
  const keys = [];
  const path = url.pathname.match(/\/(?:browse|issues)\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)\/?$/i);
  if (path) keys.push(path[1].toUpperCase());
  for (const name of ['selectedIssue', 'issueKey']) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) throw invalid();
    if (values.length) keys.push(values[0].toUpperCase());
  }
  if (!keys.length || keys.some(key => key.length > 48 || !ISSUE_KEY.test(key)) || new Set(keys).size !== 1) throw invalid();
  return { key: keys[0], url: url.href };
}

export function jiraReferenceMatchesSource(reference, baseUrl) {
  if (!reference.url) return true;
  try {
    const source = new URL(baseUrl); const link = new URL(reference.url);
    const prefix = source.pathname.replace(/\/+$/, '');
    return source.origin === link.origin && (link.pathname === prefix || link.pathname.startsWith(prefix + '/'));
  } catch { return false; }
}

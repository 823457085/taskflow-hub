const TOOLS = ['codex', 'codex-cli', 'claude-code', 'cursor', 'antigravity', 'custom'];
const CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_BODY_BYTES = 16384;
const invalid = () => new Error('本地接入申请无效，请在终端重新运行 connect。');

export interface LocalBridgeHandoff {
  schemaVersion: 1;
  userCode: string;
  deviceName: string;
  tool: string;
  expiresAt: string;
  suggestedProjectIds: string[];
}

export function localBridgePortFromHash(hash: string): number | undefined {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (route.get('view') !== 'local' || !route.has('localBridgePort')) return undefined;
  const values = route.getAll('localBridgePort');
  const value = values[0];
  if (values.length !== 1 || !/^[1-9]\d{3,4}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw invalid();
  return Number(value);
}

export function withoutLocalBridgePort(hash: string, expectedPort?: number): string {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (expectedPort !== undefined && (route.getAll('localBridgePort').length !== 1 || route.get('localBridgePort') !== String(expectedPort))) return hash;
  route.delete('localBridgePort');
  const next = route.toString();
  return next ? '#' + next : '';
}

export function isLocalBridgeRouteCurrent(hash: string, expectedPort?: number): boolean {
  const route = new URLSearchParams(hash.replace(/^#/, ''));
  if (route.get('view') !== 'local' || route.has('task') || route.get('mode') === 'demo') return false;
  if (!route.has('localBridgePort')) return true;
  if (expectedPort === undefined) return false;
  try { return localBridgePortFromHash(hash) === expectedPort; } catch { return false; }
}

export function parseLocalBridgeHandoff(value: unknown, now = Date.now()): LocalBridgeHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'userCode', 'deviceName', 'tool', 'expiresAt', 'suggestedProjectIds'];
  if (Object.keys(data).some(key => !fields.includes(key)) || data.schemaVersion !== 1 || typeof data.userCode !== 'string' || !CODE.test(data.userCode) ||
      typeof data.deviceName !== 'string' || !data.deviceName.trim() || data.deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(data.deviceName) ||
      typeof data.tool !== 'string' || !TOOLS.includes(data.tool) || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= now ||
      !Array.isArray(data.suggestedProjectIds) || data.suggestedProjectIds.length > 100 || data.suggestedProjectIds.some(id => typeof id !== 'string' || !PROJECT_ID.test(id))) throw invalid();
  return { schemaVersion: 1, userCode: data.userCode.toUpperCase(), deviceName: data.deviceName, tool: data.tool, expiresAt: data.expiresAt, suggestedProjectIds: [...new Set(data.suggestedProjectIds as string[])] };
}

export function assertLocalBridgeRequest(handoff: LocalBridgeHandoff, request: { deviceName: string; tool: string; expiresAt: string; status: string }) {
  if (!request || request.deviceName !== handoff.deviceName || request.tool !== handoff.tool || Date.parse(request.expiresAt) !== Date.parse(handoff.expiresAt) ||
      !['PENDING', 'APPROVED', 'DENIED', 'CONSUMED'].includes(request.status)) throw new Error('本地申请与平台配对信息不一致，请重新发起接入。');
}

export const suggestedLocalProjects = (suggested: string[], visibleProjects: { id: string }[]) => [...new Set(suggested)].filter(id => visibleProjects.some(project => project.id === id));

export function suggestRepoPathForProject(
  project: { key?: string; name?: string } | undefined | null,
  repositories: readonly { name: string; path: string }[],
): string {
  if (!project || !repositories.length) return '';
  const key = (project.key || '').trim().toLowerCase();
  const name = (project.name || '').trim().toLowerCase();
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
  const normKey = normalize(key);
  const normName = normalize(name);
  const exact = repositories.find(repo => {
    const repoLower = repo.name.trim().toLowerCase();
    const repoNorm = normalize(repo.name);
    return (!!key && (repoLower === key || (!!normKey && repoNorm === normKey))) ||
      (!!name && (repoLower === name || (!!normName && repoNorm === normName)));
  });
  if (exact) return exact.path;
  if (normKey.length >= 3) {
    const partial = repositories.find(repo => normalize(repo.name).includes(normKey));
    if (partial) return partial.path;
  }
  return '';
}

export async function readLocalBridgeHandoff(port: number, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<LocalBridgeHandoff> {
  if (localBridgePortFromHash('#view=local&localBridgePort=' + port) !== port) throw invalid();
  const timeout = AbortSignal.timeout(8000);
  let response: Response;
  try {
    response = await fetcher(`http://127.0.0.1:${port}/taskflow-pairing`, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch { throw new Error('无法读取本地接入申请，请确认终端 connect 命令仍在运行后重试。'); }
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) {
    await response.body?.cancel(); throw invalid();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let bytes = 0; let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw invalid(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch { throw invalid(); }
  finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  return parseLocalBridgeHandoff(value);
}

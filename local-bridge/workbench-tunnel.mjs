const RETRY_MS = 5000;
const WAIT_S = 25;
const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding']);

/** Relays the signed-in owner's browser requests from the platform to the local workbench, one long-poll per slot. */
export function runWorkbenchTunnel({ apiUrl, token, target, log = () => {}, signal, polls = 4, maxInflight = 64, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const local = new URL(target);
  const auth = { Authorization: `Bearer ${token}` };
  let inflight = 0;
  let stopped = false;
  let warnedOffline = false;

  const headLine = (status, pairs) => Buffer.from(`${JSON.stringify({ status, headers: pairs })}\n`);
  async function upload(id, head, body, controller) {
    async function* stream() {
      yield head;
      if (body) for await (const chunk of body) yield chunk;
    }
    try {
      const response = await fetchImpl(`${apiUrl}/api/bridge/tunnel/responses/${id}`, {
        method: 'POST', redirect: 'error', duplex: 'half', signal: controller.signal,
        headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: stream(),
      });
      await response.body?.cancel();
    } catch { /* The browser left or the platform dropped the stream. */ }
    finally { controller.abort(); }
  }

  function requestHeaders(request) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (DROP_REQUEST_HEADERS.has(name) || typeof value !== 'string') continue;
      if (name === 'origin') { headers.set(name, local.origin); continue; }
      if (name === 'referer') {
        try { const ref = new URL(value); headers.set(name, `${local.origin}${ref.pathname}${ref.search}`); } catch { /* drop malformed referer */ }
        continue;
      }
      try { headers.append(name, value); } catch { /* skip headers fetch refuses */ }
    }
    return headers;
  }

  async function handle(request) {
    const controller = new AbortController();
    const onStop = () => controller.abort();
    signal?.addEventListener('abort', onStop, { once: true });
    inflight += 1;
    try {
      if (inflight > maxInflight) {
        return await upload(request.id, headLine(503, [['content-type', 'application/json; charset=utf-8']]), [Buffer.from(JSON.stringify({ error: { code: 'BRIDGE_BUSY', message: '本机工作台同时处理的请求过多' } }))], controller);
      }
      let url;
      try { url = new URL(request.path, local); } catch { url = null; }
      if (!url || url.origin !== local.origin || typeof request.path !== 'string' || !request.path.startsWith('/')) {
        return await upload(request.id, headLine(400, [['content-type', 'text/plain; charset=utf-8']]), [Buffer.from('invalid path')], controller);
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method: request.method, headers: requestHeaders(request), redirect: 'manual', signal: controller.signal,
          ...(request.body && !['GET', 'HEAD'].includes(request.method) ? { body: Buffer.from(request.body, 'base64') } : {}),
        });
        warnedOffline = false;
      } catch {
        if (!warnedOffline && !controller.signal.aborted) { warnedOffline = true; log(`无法连接本机工作台 ${local.origin}，请确认工作台已启动`); }
        return await upload(request.id, headLine(502, [['content-type', 'text/html; charset=utf-8']]), [Buffer.from(`<!doctype html><meta charset="utf-8"><title>本机工作台未启动</title><p style="font:15px -apple-system,sans-serif;padding:32px">Bridge 在线，但连不上本机工作台（${local.origin}）。请在电脑上启动工作台后刷新。</p>`)], controller);
      }
      const pairs = [];
      for (const [name, value] of response.headers) {
        if (name === 'set-cookie') continue;
        pairs.push([name, name === 'location' && value.startsWith(local.origin) ? value.slice(local.origin.length) || '/' : value]);
      }
      for (const cookie of response.headers.getSetCookie?.() || []) pairs.push(['set-cookie', cookie]);
      await upload(request.id, headLine(response.status, pairs), response.body, controller);
    } finally {
      inflight -= 1;
      signal?.removeEventListener('abort', onStop);
    }
  }

  async function loop() {
    while (!stopped && !signal?.aborted) {
      let next;
      try {
        const response = await fetchImpl(`${apiUrl}/api/bridge/tunnel/next?wait=${WAIT_S}`, { headers: auth, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout((WAIT_S + 15) * 1000), ...(signal ? [signal] : [])]) });
        if (response.status === 401) { stopped = true; log('工作台转发已停止：设备会话已失效或已被撤销，请重新配对'); return; }
        if (response.status === 404) { await response.body?.cancel(); await sleep(60_000); continue; }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        next = await response.json();
      } catch (error) {
        if (signal?.aborted) return;
        log(`工作台转发连接平台失败：${error.message}，${RETRY_MS / 1000} 秒后重试`);
        await sleep(RETRY_MS);
        continue;
      }
      if (next?.request) void handle(next.request);
    }
  }

  log(`工作台转发已开启：网页工作台的请求将转发到本机 ${local.origin}`);
  return Promise.all(Array.from({ length: polls }, loop)).then(() => undefined);
}

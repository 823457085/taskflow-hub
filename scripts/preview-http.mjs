import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const publicDir = resolve(process.env.TASKFLOW_PUBLIC_DIR || resolve(import.meta.dirname, 'public'));
const uiPort = Number(process.env.TASKFLOW_UI_PORT || 5186);
const apiPort = Number(process.env.TASKFLOW_API_PORT || 5187);
if (![uiPort, apiPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('TaskFlow port must be 1..65535');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__taskflow/version') {
    try {
      const manifest = await readFile(resolve(import.meta.dirname, 'build.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(manifest);
    } catch { res.writeHead(503); res.end(); }
    return;
  }
  if (req.url.startsWith('/api/')) {
    const headers = { ...req.headers, host: `127.0.0.1:${apiPort}` };
    if ([`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`].includes(headers.origin) && new URL(headers.origin).host === req.headers.host) headers.origin = `http://127.0.0.1:${apiPort}`;
    const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    // A connector read validates authentication before fetching the resource;
    // both bounded remote calls must fit inside the browser/proxy request budget.
    const mergeRequestRoute = /\/merge-requests(?:[/?]|$)|^\/api\/connectors\/(?:gitlab|yunxiao)\/(?:read|import)(?:[?]|$)/.test(req.url);
    upstream.setTimeout(mergeRequestRoute ? 80_000 : req.url.startsWith('/api/connectors/') ? 35_000 : 15_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '本地基础服务连接失败，请确认 5187 端口的服务已启动。' } }));
    });
    req.pipe(upstream);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(publicDir + sep)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(target)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(target).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => { console.error(`Preview start failed: ${error.code}`); process.exitCode = 1; });
server.listen(uiPort, '127.0.0.1', () => console.log(`TaskFlow preview http://127.0.0.1:${uiPort}/`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));

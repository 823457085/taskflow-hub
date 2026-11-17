import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateUrl } from './api-client.mjs';

const run = promisify(execFile);
const projectId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

export async function openDailyChrome(url) {
  if (process.platform !== 'darwin') throw new Error('自动打开日常 Chrome 仅支持 macOS；可运行 pair 使用手动配对。');
  try { await run('/usr/bin/open', ['-a', 'Google Chrome', url], { timeout: 10000, maxBuffer: 16384 }); }
  catch { throw new Error('无法打开日常 Chrome，请确认已安装 Chrome，或运行 pair 使用手动配对。'); }
}

export async function createBrowserHandoff({ webUrl, userCode, deviceName, tool, expiresAt, suggestedProjectIds = [] }) {
  const origin = validateUrl(webUrl);
  const expires = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i.test(userCode || '') ||
      typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(deviceName) ||
      !['codex', 'codex-cli', 'claude-code', 'cursor', 'custom'].includes(tool) ||
      !Number.isFinite(expires) || expires <= Date.now() || !Array.isArray(suggestedProjectIds) ||
      suggestedProjectIds.length > 100 || suggestedProjectIds.some(id => !projectId(id))) throw new Error('本机配对确认信息不正确。');
  const payload = JSON.stringify({ schemaVersion: 1, userCode, deviceName, tool, expiresAt, suggestedProjectIds: [...new Set(suggestedProjectIds)] });
  let host;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    req.resume();
    if (req.headers.host !== host || req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.url !== '/taskflow-pairing') { res.writeHead(404).end(); return; }
    if (Date.now() >= expires) { res.writeHead(410).end(); return; }
    if (req.method === 'OPTIONS') {
      const headers = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== 'GET' || headers.some(value => !['accept', 'content-type'].includes(value))) { res.writeHead(403).end(); return; }
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      if (headers.length) res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204).end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(payload);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 16; server.maxConnections = 8;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port; host = `127.0.0.1:${port}`;
  let closing;
  const close = () => closing ||= new Promise(resolve => {
    clearTimeout(timer); server.close(() => resolve()); server.closeAllConnections();
  });
  const timer = setTimeout(() => { void close(); }, Math.min(expires - Date.now(), 2_147_483_647));
  timer.unref();
  return { port, verificationUrl: `${origin}/#view=local&localBridgePort=${port}`, close };
}

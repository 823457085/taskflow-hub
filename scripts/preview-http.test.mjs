import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('persistent preview serves assets and preserves API auth and origin boundaries', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'taskflow-preview-test-'));
  const publicDir = resolve(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(resolve(publicDir, 'index.html'), '<!doctype html><title>TaskFlow test</title>');
  writeFileSync(resolve(publicDir, 'app.js'), 'window.previewReady = true;');
  writeFileSync(resolve(directory, 'private.txt'), 'must-not-serve');
  const requests = [];
  const api = http.createServer((req, res) => {
    requests.push({ path: req.url, origin: req.headers.origin, authorization: req.headers.authorization });
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${api.address().port}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'L_ORIGIN_REJECTED' } }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'test_session=sample; HttpOnly; SameSite=Strict; Path=/' });
      res.end(JSON.stringify({ message: 'L_RETURN_UNCHANGED' }));
    }
  });
  await new Promise(resolveListen => api.listen(0, '127.0.0.1', resolveListen));
  const reserve = http.createServer();
  await new Promise(resolveListen => reserve.listen(0, '127.0.0.1', resolveListen));
  const port = reserve.address().port;
  await new Promise(resolveClose => reserve.close(resolveClose));
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'preview-http.mjs')], {
    env: { ...process.env, TASKFLOW_UI_PORT: String(port), TASKFLOW_API_PORT: String(api.address().port), TASKFLOW_PUBLIC_DIR: publicDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Preview exited before readiness'); })]);
    const indexRes = await fetch(base);
    assert.match(indexRes.headers.get('cache-control') || '', /no-store/);
    assert.match(await indexRes.text(), /TaskFlow test/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.notEqual((await fetch(`${base}/%2e%2e%2fprivate.txt`)).status, 200);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    const response = await fetch(`${base}/api/context`, { method: 'POST', headers: { Origin: base, Authorization: 'Bearer test-value', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'L_RETURN_UNCHANGED');
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal(requests.at(-1).authorization, 'Bearer test-value');
    const localhost = await fetch(`http://localhost:${port}/api/context`, { method: 'POST', headers: { Origin: `http://localhost:${port}` } });
    assert.equal(localhost.status, 200);
    const mismatch = await fetch(`${base}/api/context`, { method: 'POST', headers: { Origin: `http://localhost:${port}` } });
    assert.equal(mismatch.status, 403);
    const denied = await fetch(`${base}/api/context`, { method: 'POST', headers: { Origin: 'https://untrusted.invalid' } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.message, 'L_ORIGIN_REJECTED');
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    await new Promise(resolveClose => api.close(resolveClose));
    rmSync(directory, { recursive: true, force: true });
  }
});

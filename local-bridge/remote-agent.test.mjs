import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandResolver, pathPolicy, runFsOp, runHttpOp } from './remote-agent.mjs';

test('personal agent only serves the user home and keeps credential stores private', async t => {
  const home = mkdtempSync(join(tmpdir(), 'remote-agent-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'remote-agent-outside-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret');
  mkdirSync(join(home, '.taskflow', 'state'), { recursive: true });
  mkdirSync(join(home, 'code'));
  symlinkSync(join(home, '.ssh'), join(home, 'code', 'keys'));
  symlinkSync(outside, join(home, 'code', 'escape'));
  const policy = pathPolicy(home);

  await runFsOp(policy, 'writeFile', [join(home, 'code', 'a.txt'), { $b: Buffer.from('hi').toString('base64') }, {}]);
  assert.deepEqual(await runFsOp(policy, 'readFile', [join(home, 'code', 'a.txt'), {}]), { $b: Buffer.from('hi').toString('base64') });
  assert.equal((await runFsOp(policy, 'stat', [join(home, 'code', 'a.txt')])).size, 2);
  assert.deepEqual((await runFsOp(policy, 'readdir', [home, {}])).sort(), ['.taskflow', 'code']);
  assert.deepEqual(await runFsOp(policy, 'readdir', [join(home, '.taskflow'), {}]), []);

  for (const target of [join(home, '.ssh', 'id_ed25519'), join(home, 'code', 'keys', 'id_ed25519'), join(home, '.taskflow', 'state', 'session.json'), '/etc/passwd', join(home, 'code', 'escape', 'x')]) {
    await assert.rejects(runFsOp(policy, 'readFile', [target, {}]), { code: 'EACCES' }, target);
  }
  await assert.rejects(runFsOp(policy, 'rename', [join(home, 'code', 'a.txt'), join(outside, 'a.txt')]), { code: 'EACCES' });
  await assert.rejects(runFsOp(policy, 'symlink', [join(home, '.ssh'), join(home, 'code', 'link')]), { code: 'EACCES' });
  await assert.rejects(runFsOp(policy, 'eval', []), { code: 'ENOSYS' });
});

test('command resolver searches the usual developer locations', () => {
  const resolver = commandResolver({ home: '/nonexistent', env: { PATH: '' } });
  assert.match(resolver.resolve('sh'), /\/sh$/);
  assert.equal(resolver.resolve('definitely-not-a-command-xyz'), null);
  assert.equal(resolver.resolve('./relative'), null);
});

test('http relay only allows listed hosts and returns status/body', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } });
  };
  const value = await runHttpOp({
    url: 'https://jira.example.com/rest/api/2/myself',
    method: 'GET',
    headers: { Authorization: 'Bearer t', Host: 'evil' },
    hosts: ['jira.example.com'],
  }, fetchImpl);
  assert.equal(value.status, 200);
  assert.equal(Buffer.from(value.body, 'base64').toString('utf8'), '{"ok":true}');
  assert.equal(value.headers['content-type'], 'application/json');
  assert.equal(value.headers['set-cookie'], undefined);
  assert.equal(calls[0].headers.Host, undefined);
  await assert.rejects(runHttpOp({ url: 'https://evil.example.com/', hosts: ['jira.example.com'] }, fetchImpl), { code: 'EACCES' });
  await assert.rejects(runHttpOp({ url: 'https://user:pass@jira.example.com/', hosts: ['jira.example.com'] }, fetchImpl), { code: 'EACCES' });
});

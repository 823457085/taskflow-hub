import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlist, manageService, SERVICE_LABEL } from './service.mjs';

test('plist escapes values and runs the worker with the given environment', () => {
  const plist = buildPlist({ node: '/usr/local/bin/node', script: '/a&b/rd.mjs', args: ['--config', '/x/<w>.json'], env: { RD_HUB_STATE_DIR: '/s "q"' }, logPath: '/s/worker.log' });
  assert.match(plist, /<string>\/a&amp;b\/rd\.mjs<\/string>\n {4}<string>worker<\/string>\n {4}<string>--config<\/string>\n {4}<string>\/x\/&lt;w&gt;\.json<\/string>/);
  assert.match(plist, /<key>RD_HUB_STATE_DIR<\/key>\n {4}<string>\/s &quot;q&quot;<\/string>/);
  assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`));
});

test('install requires pairing and config, writes a private LaunchAgent and bootstraps it; status and uninstall follow launchd', async () => {
  const home = mkdtempSync(join(tmpdir(), 'taskflow-service-home-'));
  const state = join(home, 'state');
  const calls = [];
  let printed = { ok: false, stdout: '', stderr: '' };
  const run = async (file, args) => { calls.push([file, ...args]); return args[0] === 'print' ? printed : { ok: true, stdout: '', stderr: '' }; };
  const deps = { platform: 'darwin', home, uid: 501, node: '/usr/local/bin/node', env: { NODE_EXTRA_CA_CERTS: '/certs/ca.pem' }, run, state };
  try {
    await assert.rejects(manageService('install', {}, { ...deps, platform: 'linux' }), /只支持 macOS/);
    await assert.rejects(manageService('install', {}, deps), /pair/);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'session.json'), '{}');
    await assert.rejects(manageService('install', {}, deps), /worker-init/);
    writeFileSync(join(state, 'worker.json'), '{}');
    await assert.rejects(manageService('install', {}, { ...deps, env: { NODE_EXTRA_CA_CERTS: 'ca.pem' } }), /绝对路径/);

    const installed = await manageService('install', {}, deps);
    const plistPath = join(home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
    assert.equal(installed.status, 'INSTALLED');
    assert.equal(statSync(plistPath).mode & 0o777, 0o600);
    const plist = readFileSync(plistPath, 'utf8');
    assert.match(plist, /<key>NODE_EXTRA_CA_CERTS<\/key>\n {4}<string>\/certs\/ca\.pem<\/string>/);
    assert.match(plist, new RegExp(`<key>RD_HUB_STATE_DIR</key>\\n {4}<string>${state}</string>`));
    assert.deepEqual(calls, [['launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`], ['launchctl', 'bootstrap', 'gui/501', plistPath]]);

    assert.equal((await manageService('status', {}, deps)).status, 'NOT_INSTALLED');
    printed = { ok: true, stdout: 'state = running\n\tpid = 4242\n', stderr: '' };
    assert.deepEqual((await manageService('status', {}, deps)).pid, 4242);

    assert.equal((await manageService('uninstall', {}, deps)).status, 'UNINSTALLED');
    assert.equal(existsSync(plistPath), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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

    assert.match(plist, /<key>TASKFLOW_SERVICE<\/key>\n {4}<string>1<\/string>/);

    calls.length = 0;
    let busy = 2;
    const racing = async (file, args) => { calls.push(args[0]); return args[0] === 'bootstrap' && busy-- > 0 ? { ok: false, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' } : { ok: true, stdout: '', stderr: '' }; };
    assert.equal((await manageService('install', {}, { ...deps, run: racing, wait: async () => {} })).status, 'INSTALLED');
    assert.deepEqual(calls, ['bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    await assert.rejects(manageService('install', {}, { ...deps, run: async (file, args) => ({ ok: args[0] !== 'bootstrap', stdout: '', stderr: 'Bootstrap failed: 5' }), wait: async () => {} }), /加载失败/);

    mkdirSync(join(home, 'workbench-root'), { recursive: true });
    const workbenchDeps = { ...deps, run, state: join(home, 'tf', 'state') };
    await assert.rejects(manageService('install', { kind: 'workbench' }, workbenchDeps), /workbench --action install/);
    mkdirSync(join(home, 'tf', 'workbench', 'current'), { recursive: true });
    const workbench = await manageService('install', { kind: 'workbench' }, workbenchDeps);
    assert.equal(workbench.label, 'com.taskflow.workbench');
    const workbenchPlist = readFileSync(workbench.plist, 'utf8');
    assert.match(workbenchPlist, /<string>workbench<\/string>\n {4}<string>--action<\/string>\n {4}<string>run<\/string>/);
    assert.equal(workbench.log, join(home, 'tf', 'workbench', 'workbench.log'));

    assert.equal((await manageService('status', {}, deps)).status, 'NOT_INSTALLED');
    printed = { ok: true, stdout: 'state = running\n\tpid = 4242\n', stderr: '' };
    assert.deepEqual((await manageService('status', {}, deps)).pid, 4242);

    assert.equal((await manageService('uninstall', {}, deps)).status, 'UNINSTALLED');
    assert.equal(existsSync(plistPath), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

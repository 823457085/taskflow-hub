import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateStagedWorkbench, enableWorkbenchRelay, installWorkbench, parseRelease, updateBridge, workbenchEnv, workbenchVersion } from './updater.mjs';

const temp = prefix => mkdtempSync(join(tmpdir(), prefix));
function pack(files) {
  const dir = temp('taskflow-pack-src-');
  for (const [name, content] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), content); }
  const archive = join(temp('taskflow-pack-out-'), 'pkg.tgz');
  execFileSync('tar', ['czf', archive, '-C', dir, ...Object.keys(files)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const data = readFileSync(archive);
  return { data, sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
}
function hub(files) {
  const served = [];
  const fetchImpl = async url => {
    const name = new URL(url).pathname.slice(1);
    served.push(name);
    return files[name] ? new Response(files[name]) : new Response('missing', { status: 404 });
  };
  return { fetchImpl, served };
}
const v = n => String(n).repeat(12).slice(0, 12);

test('release manifest rejects malformed versions, hashes and oversized packages', () => {
  const ok = { version: v('a'), sha256: 'b'.repeat(64), size: 10 };
  assert.deepEqual(parseRelease({ bridge: ok }), { bridge: ok, workbench: null });
  for (const bad of [{}, { bridge: { ...ok, version: '1.0' } }, { bridge: { ...ok, sha256: 'x' } }, { bridge: { ...ok, size: 0 } }, { bridge: { ...ok, size: 21 * 1024 * 1024 } }, { bridge: ok, workbench: { ...ok, version: '../x' } }]) {
    assert.throws(() => parseRelease(bad), /发布清单/);
  }
});

test('bridge update verifies the package, keeps the previous app and reuses dependencies', async () => {
  const root = temp('taskflow-root-');
  mkdirSync(join(root, 'state'));
  mkdirSync(join(root, 'app', 'local-bridge', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'app', 'local-bridge', 'release.json'), JSON.stringify({ version: v('1') }));
  writeFileSync(join(root, 'app', 'local-bridge', 'package.json'), JSON.stringify({ dependencies: { dep: '1' } }));
  writeFileSync(join(root, 'app', 'local-bridge', 'node_modules', 'dep', 'index.js'), 'kept');
  const next = pack({ 'local-bridge/rd.mjs': 'new', 'local-bridge/release.json': JSON.stringify({ version: v('2') }), 'local-bridge/package.json': JSON.stringify({ dependencies: { dep: '1' } }) });
  try {
    const current = { bridge: { version: v('1'), sha256: next.sha256, size: next.size } };
    assert.equal((await updateBridge({ root, hub: 'https://hub.test', release: current, fetchImpl: hub({}).fetchImpl })).updated, false);

    const tampered = hub({ 'taskflow-bridge.tgz': Buffer.concat([next.data, Buffer.from('x')]) });
    await assert.rejects(updateBridge({ root, hub: 'https://hub.test', release: { bridge: { version: v('2'), sha256: next.sha256, size: next.size } }, fetchImpl: tampered.fetchImpl }), /大小|校验/);
    assert.equal(readFileSync(join(root, 'app', 'local-bridge', 'release.json'), 'utf8').includes(v('1')), true);
    assert.equal(existsSync(join(root, 'update.tmp')), false);

    const result = await updateBridge({ root, hub: 'https://hub.test', release: { bridge: { version: v('2'), sha256: next.sha256, size: next.size } }, fetchImpl: hub({ 'taskflow-bridge.tgz': next.data }).fetchImpl, run: async () => { throw new Error('npm should not run'); } });
    assert.deepEqual(result, { updated: true, from: v('1'), version: v('2') });
    assert.equal(readFileSync(join(root, 'app', 'local-bridge', 'rd.mjs'), 'utf8'), 'new');
    assert.equal(readFileSync(join(root, 'app', 'local-bridge', 'node_modules', 'dep', 'index.js'), 'utf8'), 'kept');
    assert.ok(existsSync(join(root, 'app.old', 'local-bridge', 'release.json')));

    const wrongVersion = pack({ 'local-bridge/rd.mjs': 'x', 'local-bridge/release.json': JSON.stringify({ version: v('9') }) });
    await assert.rejects(updateBridge({ root, hub: 'https://hub.test', release: { bridge: { version: v('3'), sha256: wrongVersion.sha256, size: wrongVersion.size } }, fetchImpl: hub({ 'taskflow-bridge.tgz': wrongVersion.data }).fetchImpl }), /不完整/);
    assert.equal(readFileSync(join(root, 'app', 'local-bridge', 'rd.mjs'), 'utf8'), 'new');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('packages with parent-directory entries are refused', async () => {
  const root = temp('taskflow-root-');
  mkdirSync(join(root, 'state'));
  const src = temp('taskflow-evil-');
  const archive = join(src, 'evil.tgz');
  execFileSync('python3', ['-c', `import tarfile,io\nt=tarfile.open(${JSON.stringify(archive)},'w:gz')\nfor n in ['local-bridge/rd.mjs','../escape.txt']:\n  d=b'x';i=tarfile.TarInfo(n);i.size=len(d);t.addfile(i,io.BytesIO(d))\nt.close()`]);
  const data = readFileSync(archive);
  try {
    await assert.rejects(updateBridge({ root, hub: 'https://hub.test', release: { bridge: { version: v('4'), sha256: createHash('sha256').update(data).digest('hex'), size: data.length } }, fetchImpl: hub({ 'taskflow-bridge.tgz': data }).fetchImpl }), /不安全路径/);
    assert.equal(existsSync(join(root, 'escape.txt')), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); }
});

test('workbench installs once with persistent env and data, then stages and activates later versions', async () => {
  const root = temp('taskflow-root-');
  const files = version => ({ 'dist/index.html': version, 'server/index.ts': '', '.env.example': 'HOST=127.0.0.1\nPORT=5199\nDELIVERY_DATA_DIR=.data\n' });
  const first = pack(files('one')), second = pack(files('two'));
  const calls = [];
  const run = async (file, args, options) => { calls.push([file, ...args, options?.cwd]); if (file === 'pnpm' && args[0] === '--version') return '12.3.4'; return ''; };
  const release = (version, item) => ({ bridge: null, workbench: { version, sha256: item.sha256, size: item.size } });
  const server = hub({ 'taskflow-workbench.tgz': first.data });
  try {
    const installed = await installWorkbench({ root, hub: 'https://hub.test', release: release(v('a'), first), port: 5299, fetchImpl: server.fetchImpl, run });
    assert.deepEqual(installed, { changed: true, version: v('a'), active: true });
    assert.equal(readlinkSync(join(root, 'workbench', 'current')), join('releases', v('a')));
    const env = readFileSync(join(root, 'workbench', '.env'), 'utf8');
    assert.match(env, /^PORT=5299$/m);
    assert.match(env, new RegExp(`^DELIVERY_DATA_DIR=${join(root, 'workbench', 'data')}$`, 'm'));
    assert.match(env, /^HOST=127\.0\.0\.1$/m);
    assert.deepEqual(calls.at(-1), ['pnpm', 'install', '--frozen-lockfile', join(root, 'workbench', 'releases', v('a'))]);
    writeFileSync(join(root, 'workbench', '.env'), env + 'JIRA_API_TOKEN=kept\n');

    assert.equal((await installWorkbench({ root, hub: 'https://hub.test', release: release(v('a'), first), fetchImpl: server.fetchImpl, run })).changed, false);

    const staged = await installWorkbench({ root, hub: 'https://hub.test', release: release(v('b'), second), fetchImpl: hub({ 'taskflow-workbench.tgz': second.data }).fetchImpl, run });
    assert.deepEqual(staged, { changed: true, version: v('b'), active: false });
    assert.deepEqual(await workbenchVersion(root), { current: v('a'), next: v('b') });
    assert.equal(await activateStagedWorkbench(root), v('b'));
    assert.deepEqual(await workbenchVersion(root), { current: v('b'), next: null });
    assert.equal(readFileSync(join(root, 'workbench', 'current', 'dist', 'index.html'), 'utf8'), 'two');
    assert.equal(existsSync(join(root, 'workbench', 'releases', v('a'))), false);
    assert.match(readFileSync(join(root, 'workbench', '.env'), 'utf8'), /JIRA_API_TOKEN=kept/);

    calls.length = 0;
    const failing = async (file, args) => { if (args.includes('install')) throw new Error('pnpm failed'); return ''; };
    await assert.rejects(installWorkbench({ root, hub: 'https://hub.test', release: release(v('c'), first), fetchImpl: server.fetchImpl, run: failing }), /pnpm failed/);
    assert.equal(existsSync(join(root, 'workbench', 'releases', v('c'))), false);
    assert.deepEqual(await workbenchVersion(root), { current: v('b'), next: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workbench env fills port and data paths, relay is added to worker config only once', async () => {
  assert.equal(workbenchEnv('', { port: 5288, data: '/d' }), '\nPORT=5288\nDELIVERY_DATA_DIR=/d\nDELIVERY_SOURCE_DATA_DIR=/d/source');
  const dir = temp('taskflow-relay-'), config = join(dir, 'worker.json');
  writeFileSync(config, JSON.stringify({ projects: {} }), { mode: 0o600 });
  try {
    assert.equal(await enableWorkbenchRelay(config, 5300), true);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).workbench, { url: 'http://127.0.0.1:5300' });
    assert.equal(await enableWorkbenchRelay(config), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

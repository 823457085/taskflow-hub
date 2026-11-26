import test from 'node:test';
import assert from 'node:assert/strict';
import { localBridgePortFromHash, withoutLocalBridgePort, isLocalBridgeRouteCurrent, parseLocalBridgeHandoff, assertLocalBridgeRequest, suggestedLocalProjects, suggestRepoPathForProject, readLocalBridgeHandoff } from '../preview-app/src/views/localBridgeHandoff.ts';

const fixture = () => ({ schemaVersion: 1, userCode: 'ABCD-EFGH', deviceName: 'My workstation', tool: 'custom', expiresAt: new Date(Date.now() + 60_000).toISOString(), suggestedProjectIds: ['p1', 'p2', 'p1'] });

test('only one canonical unprivileged numeric port on the local route becomes a fixed loopback handoff', () => {
  assert.equal(localBridgePortFromHash('#view=local&localBridgePort=49152'), 49152);
  assert.equal(localBridgePortFromHash('#view=tasks&localBridgePort=49152'), undefined);
  assert.equal(localBridgePortFromHash('#view=local'), undefined);
  for (const value of ['0', '80', '1023', '65536', '049152', '-1234', '1e4', '49152/path', 'https://outside.invalid', '49152&localBridgePort=49153']) assert.throws(() => localBridgePortFromHash('#view=local&localBridgePort=' + value));
  assert.equal(withoutLocalBridgePort('#view=local&localBridgePort=49152&from=tasks', 49152), '#view=local&from=tasks');
  assert.equal(withoutLocalBridgePort('#view=local&localBridgePort=49153', 49152), '#view=local&localBridgePort=49153');
  assert.equal(isLocalBridgeRouteCurrent('#view=local', 49152), true);
  assert.equal(isLocalBridgeRouteCurrent('#view=local&localBridgePort=49152', 49152), true);
  for (const hash of ['#view=tasks', '#view=local&task=old-task', '#view=local&mode=demo', '#view=local&localBridgePort=49153', '#view=local&localBridgePort=bad']) assert.equal(isLocalBridgeRouteCurrent(hash, 49152), false);
  assert.equal(isLocalBridgeRouteCurrent('#view=local&localBridgePort=49152'), false);
});

test('handoff payload validation rejects unexpected credential fields, invalid identities, scopes and expired requests without echoing data', () => {
  const valid = fixture(); assert.deepEqual(parseLocalBridgeHandoff(valid).suggestedProjectIds, ['p1', 'p2']);
  assert.equal(parseLocalBridgeHandoff(valid).replacesExisting, undefined);
  assert.equal(parseLocalBridgeHandoff({ ...valid, replacesExisting: true }).replacesExisting, true);
  for (const replacesExisting of [false, 'true', { token: 'private-value' }]) assert.throws(() => parseLocalBridgeHandoff({ ...valid, replacesExisting }));
  for (const patch of [{ schemaVersion: 2 }, { userCode: 'private-value' }, { deviceCode: 'private-value' }, { token: 'private-value' }, { deviceName: '\nprivate-value' }, { tool: 'unknown' }, { expiresAt: new Date(Date.now() - 1).toISOString() }, { suggestedProjectIds: ['../private-value'] }, { suggestedProjectIds: Array(101).fill('p1') }]) assert.throws(() => parseLocalBridgeHandoff({ ...valid, ...patch }), error => !error.message.includes('private-value'));
  for (const value of [null, [], 1, 'private-value']) assert.throws(() => parseLocalBridgeHandoff(value));
  assert.deepEqual(suggestedLocalProjects(['p1', 'p2', 'p1', 'other-project'], [{ id: 'p2' }, { id: 'p3' }]), ['p2']);
});

test('platform inspection must match the declared request before offering approval', () => {
  const handoff = parseLocalBridgeHandoff(fixture()); const request = { deviceName: handoff.deviceName, tool: handoff.tool, expiresAt: handoff.expiresAt, status: 'PENDING' };
  assert.doesNotThrow(() => assertLocalBridgeRequest(handoff, request));
  for (const patch of [{ deviceName: 'Other machine' }, { tool: 'codex-cli' }, { expiresAt: new Date(Date.now() + 5000).toISOString() }, { status: 'unexpected' }]) assert.throws(() => assertLocalBridgeRequest(handoff, { ...request, ...patch }));
});

test('handoff fetch cannot send platform cookies or follow redirects and limits untrusted response bytes', async () => {
  const handoff = fixture();
  const got = await readLocalBridgeHandoff(49152, undefined, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:49152/taskflow-pairing'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.mode, 'cors'); assert.ok(options.signal);
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    return Response.json(handoff);
  });
  assert.equal(got.userCode, handoff.userCode);
  const maximum = { ...fixture(), deviceName: 'a'.repeat(80), suggestedProjectIds: Array.from({ length: 100 }, (_, index) => 'a'.repeat(77) + String(index).padStart(3, '0')) };
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) > 8192);
  assert.equal((await readLocalBridgeHandoff(49152, undefined, async () => Response.json(maximum))).suggestedProjectIds.length, 100);
  let cancelled = false;
  await assert.rejects(readLocalBridgeHandoff(49152, undefined, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } })));
  assert.equal(cancelled, true);
  await assert.rejects(readLocalBridgeHandoff(49152, undefined, async () => new Response('<html>not a pairing</html>', { headers: { 'Content-Type': 'text/html' } })));
  await assert.rejects(readLocalBridgeHandoff(80, undefined, async () => { throw new Error('must not reach fetch'); }));
});

test('suggestRepoPathForProject matches local Git repositories by project key or name safely', () => {
  const repos = [
    { name: 'demo-gateway-service', path: '/Users/dev/work/demo-gateway-service' },
    { name: 'settlement_core', path: '/Users/dev/work/settlement_core' },
    { name: 'ui', path: '/Users/dev/work/ui' },
  ];
  assert.equal(
    suggestRepoPathForProject({ key: 'SETTLEMENT_CORE', name: '清结算核心' }, repos),
    '/Users/dev/work/settlement_core',
  );
  assert.equal(
    suggestRepoPathForProject({ key: 'DEMO', name: '支付网关' }, repos),
    '/Users/dev/work/demo-gateway-service',
  );
  assert.equal(suggestRepoPathForProject({ key: 'AB', name: '不匹配短标识' }, repos), '');
  assert.equal(suggestRepoPathForProject(null, repos), '');
  assert.equal(suggestRepoPathForProject({ key: 'DEMO', name: '支付' }, []), '');
});

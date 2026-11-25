import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient } from '../preview-app/src/views/workspaceApi.ts';

test('createApiClient deduplicates GETs cleanly without unhandled rejections on error', async () => {
  const rejections = [];
  const onUnhandled = reason => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let calls = 0;
    const api = createApiClient(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: '接口不存在' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const first = api('workbench/status');
    const second = api('workbench/status');
    const results = await Promise.allSettled([first, second]);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls, 1, 'concurrent identical GET requests share one in-flight fetch');
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'rejected');
    assert.ok(results[0].reason instanceof ApiError);
    assert.equal(results[0].reason.status, 404);
    assert.equal(rejections.length, 0, 'caught GET rejections must not emit unhandledRejection');

    const retried = await api('workbench/status');
    assert.deepEqual(retried, { ok: true });
    assert.equal(calls, 2, 'failed GET entry is evicted from in-flight cache before retry');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('preserves action-specific connector denial codes alongside the server message', async () => {
  const api = createApiClient(async () => Response.json({
    error: { code: 'CONNECTOR_FORBIDDEN', message: '当前角色无法读取此连接' },
  }, { status: 403 }));
  await assert.rejects(api('connectors/confluence/import', {}), {
    status: 403, code: 'CONNECTOR_FORBIDDEN', message: '当前角色无法读取此连接',
  });
});

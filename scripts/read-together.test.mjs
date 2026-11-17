import test from 'node:test';
import assert from 'node:assert/strict';
import { readTogether } from '../preview-app/src/views/readTogether.ts';

test('concurrent reads retain original values in input order', async () => {
  const first = { id: 'first' }; const second = { id: 'second' };
  let resolveFirst;
  const delayed = new Promise(resolve => { resolveFirst = resolve; });
  const result = readTogether([delayed, Promise.resolve(second)]);
  resolveFirst(first);
  const values = await result;
  assert.equal(values[0], first); assert.equal(values[1], second);
});

test('a later 401 takes priority over an earlier service error and keeps its original message', async () => {
  const serviceError = Object.assign(new Error('upstream unavailable'), { status: 500 });
  const authError = Object.assign(new Error('L401 原始认证文案'), { status: 401 });
  let rejectAuth;
  let settled = false;
  const delayed = new Promise((_, reject) => { rejectAuth = reject; });
  const result = readTogether([Promise.reject(serviceError), delayed]);
  void result.catch(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  rejectAuth(authError);
  await assert.rejects(result, error => error === authError && error.message === 'L401 原始认证文案');
});

test('403 outranks ordinary failures while 401 outranks 403', async () => {
  const ordinary = new Error('L500');
  const forbidden = Object.assign(new Error('L403 原始权限文案'), { status: 403 });
  const unauthorized = Object.assign(new Error('L401'), { status: 401 });
  await assert.rejects(readTogether([Promise.reject(ordinary), Promise.reject(forbidden)]), error => error === forbidden);
  await assert.rejects(readTogether([Promise.reject(forbidden), Promise.reject(unauthorized)]), error => error === unauthorized);
});

test('without an access failure, the first original rejection is preserved', async () => {
  const first = new Error('L001 原始失败文案'); const second = new Error('L002');
  await assert.rejects(readTogether([Promise.reject(first), Promise.reject(second)]), error => error === first && error.message === 'L001 原始失败文案');
});

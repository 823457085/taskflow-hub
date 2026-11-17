import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CLIENT_ADAPTER } from '../shared/local-client-adapter.mjs';
import { loadClientAdapters, saveClientAdapters } from '../preview-app/src/views/clientAdapterStorage.mjs';

const fixture = () => {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('client adapters stay isolated by user and save only parsed metadata', () => {
  const storage = fixture();
  saveClientAdapters(storage, 'alice', [DEFAULT_CLIENT_ADAPTER]);
  assert.deepEqual(loadClientAdapters(storage, 'alice'), [DEFAULT_CLIENT_ADAPTER]);
  assert.deepEqual(loadClientAdapters(storage, 'bob'), []);
  saveClientAdapters(storage, 'bob', [{ ...DEFAULT_CLIENT_ADAPTER, id: 'other', name: '其他客户端' }]);
  saveClientAdapters(storage, 'alice', []);
  assert.equal(loadClientAdapters(storage, 'bob')[0].id, 'other');
  assert.deepEqual(loadClientAdapters(storage, 'alice'), []);
});

test('stored corruption, duplicate ids, too many records and executable fields fail closed', () => {
  const storage = fixture();
  for (const raw of ['{', '{}', 'x'.repeat(100001), JSON.stringify([DEFAULT_CLIENT_ADAPTER, DEFAULT_CLIENT_ADAPTER]), JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ ...DEFAULT_CLIENT_ADAPTER, id: `client-${i}` }))), JSON.stringify([{ ...DEFAULT_CLIENT_ADAPTER, command: 'untrusted' }])]) {
    storage.setItem('taskflow:local-client-adapters:v1:alice', raw);
    assert.deepEqual(loadClientAdapters(storage, 'alice'), []);
  }
  assert.throws(() => saveClientAdapters(storage, 'alice', [DEFAULT_CLIENT_ADAPTER, DEFAULT_CLIENT_ADAPTER]), /重复/);
  assert.throws(() => saveClientAdapters(storage, 'alice', [{ ...DEFAULT_CLIENT_ADAPTER, token: 'not-a-real-secret' }]), /六个字段/);
  assert.throws(() => saveClientAdapters(storage, 'alice', Array.from({ length: 13 }, (_, i) => ({ ...DEFAULT_CLIENT_ADAPTER, id: `client-${i}` }))), /12/);
});

test('browser storage denial is safe to read and reports a fixed write error', () => {
  const storage = { getItem() { throw new Error('private detail'); }, setItem() { throw new Error('private detail'); } };
  assert.deepEqual(loadClientAdapters(storage, 'alice'), []);
  assert.throws(() => saveClientAdapters(storage, 'alice', [DEFAULT_CLIENT_ADAPTER]), error => error.message === '无法保存到本浏览器，请检查浏览器存储设置。');
});

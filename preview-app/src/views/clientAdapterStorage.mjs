import { parseClientAdapter } from '../../../shared/local-client-adapter.mjs';

export const CLIENT_ADAPTER_LIMIT = 12;
const storageKey = userId => `taskflow:local-client-adapters:v1:${userId}`;

function validatedList(value) {
  if (!Array.isArray(value) || value.length > CLIENT_ADAPTER_LIMIT) throw new Error('最多保存 12 个客户端适配器。');
  const adapters = value.map(item => parseClientAdapter(item));
  if (new Set(adapters.map(item => item.id)).size !== adapters.length) throw new Error('客户端适配器 id 不能重复。');
  return adapters;
}

export function loadClientAdapters(storage, userId) {
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw || raw.length > 100_000) return [];
    return validatedList(JSON.parse(raw));
  } catch { return []; }
}

export function saveClientAdapters(storage, userId, value) {
  const adapters = validatedList(value);
  try { storage.setItem(storageKey(userId), JSON.stringify(adapters)); }
  catch { throw new Error('无法保存到本浏览器，请检查浏览器存储设置。'); }
  return adapters;
}

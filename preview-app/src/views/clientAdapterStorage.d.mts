import type { ClientAdapterManifest } from '../../../shared/local-client-adapter.mjs';
interface AdapterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const CLIENT_ADAPTER_LIMIT: 12;
export function loadClientAdapters(storage: AdapterStorage, userId: string): ClientAdapterManifest[];
export function saveClientAdapters(storage: AdapterStorage, userId: string, value: unknown): ClientAdapterManifest[];

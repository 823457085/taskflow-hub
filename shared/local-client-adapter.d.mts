export interface ClientAdapterManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  configPath: string;
  serversKey: string;
  includeType: boolean;
}
export const DEFAULT_CLIENT_ADAPTER: Readonly<ClientAdapterManifest>;
export function parseClientAdapter(value: unknown): ClientAdapterManifest;

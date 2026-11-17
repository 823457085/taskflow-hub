import { api } from './workspaceApi';

export type AccountProvider = 'jira' | 'confluence' | 'gitlab' | 'jenkins' | 'yunxiao' | 'openai' | 'anthropic' | 'custom-ai';
export type AccountAuthMode = 'BEARER' | 'BASIC' | 'PRIVATE_TOKEN' | 'NONE';
export interface ExternalAccount {
  id: string; provider: string; name: string; scope: 'PERSONAL' | 'PROJECT';
  ownerId: string | null; projectId: string | null; baseUrl: string; authMode: AccountAuthMode;
  organizationId: string; enabled: boolean; status: string; hasCredential: boolean; version: number;
  createdAt: string; updatedAt: string; lastCheckedAt: string | null; lastError: string | null;
  canManage: boolean; canUse: boolean; canVerify?: boolean;
  kind?: 'PLATFORM' | 'AI_API'; capabilities?: { canVerify: boolean; canRead: boolean; canExecute: boolean };
}
export interface AccountSelection { projectId: string; provider: string; accountId: string | null }
export interface AccountList { accounts: ExternalAccount[]; selections: AccountSelection[]; selectedAccountId: string | null; selectionUnavailable: boolean }
export interface AccountDraft {
  name: string; provider: AccountProvider; scope: 'PERSONAL' | 'PROJECT'; projectId?: string;
  baseUrl: string; authMode: AccountAuthMode; username?: string; token?: string; organizationId?: string;
}
export const ACCOUNT_PROVIDERS: { value: AccountProvider; label: string; authMode: AccountAuthMode; ai?: boolean; defaultUrl?: string }[] = [
  { value: 'jira', label: 'Jira', authMode: 'BEARER' },
  { value: 'confluence', label: 'Confluence', authMode: 'BEARER' },
  { value: 'gitlab', label: 'GitLab', authMode: 'PRIVATE_TOKEN' },
  { value: 'jenkins', label: 'Jenkins', authMode: 'BASIC' },
  { value: 'yunxiao', label: '云效', authMode: 'PRIVATE_TOKEN' },
  { value: 'openai', label: 'OpenAI API', authMode: 'BEARER', ai: true, defaultUrl: 'https://api.openai.com' },
  { value: 'anthropic', label: 'Anthropic API', authMode: 'BEARER', ai: true, defaultUrl: 'https://api.anthropic.com' },
  { value: 'custom-ai', label: '自定义 AI API', authMode: 'BEARER', ai: true },
];
export const accountProviderName = (provider: string) => ACCOUNT_PROVIDERS.find(item => item.value === provider)?.label || provider;
export const listAccounts = (projectId?: string) => api<AccountList>('accounts' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : ''));
export const createAccount = (draft: AccountDraft) => api<{ account: ExternalAccount }>('accounts', draft);
export const updateAccount = (id: string, expectedVersion: number, draft: Partial<Omit<AccountDraft, 'provider' | 'scope' | 'projectId'>> & { enabled?: boolean }) => api<{ account: ExternalAccount }>('accounts/' + encodeURIComponent(id), { expectedVersion, ...draft }, 'PATCH');
export const deleteAccount = (id: string, expectedVersion: number) => api<void>('accounts/' + encodeURIComponent(id) + '?expectedVersion=' + expectedVersion, undefined, 'DELETE');
export const selectAccount = (projectId: string, provider: string, accountId: string | null) => api<unknown>('accounts/select', { projectId, provider, accountId });
export const verifyAccount = (id: string, expectedVersion: number, projectId?: string) => api<{ account?: ExternalAccount; identity?: { displayName?: string; name?: string } }>('accounts/' + encodeURIComponent(id) + '/test', { expectedVersion, ...(projectId ? { projectId } : {}) });

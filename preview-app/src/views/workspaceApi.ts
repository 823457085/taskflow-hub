import type { Role, ProjectPermissions } from './workspacePermissions.ts';
import type { OverviewFlowTelemetry } from './deliveryMetrics.ts';
export * from './workspacePermissions.ts';
export type { OverviewFlowTelemetry } from './deliveryMetrics.ts';
export type Stage = 'PRD' | 'TECH_SPEC' | 'CODE_REVIEW' | 'TEST_CASE' | 'RELEASE';
export type AssetKind = 'PRD' | 'TECH_SPEC' | 'CODE' | 'TEST_CASE' | 'RELEASE_PLAN';
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
export type ExecutionMode = 'HUMAN_REVIEW' | 'LOCAL_REPORT' | 'CLOUD_AI';
export interface User { id: string; username: string; role: Role }
export interface ProjectMember extends User { canEditRole: boolean }
export type MemberCandidate = Pick<User, 'id' | 'username'>;
export interface JiraProject {
  id: string; key: string; name: string; baseUrl: string;
  category: { id: string; name: string; description?: string } | null;
  projectTypeKey?: string;
}
export interface Project { id: string; key: string; name: string; role: Role; permissions?: ProjectPermissions; jira?: JiraProject | null }
export const projectGroup = (project: Project) => {
  if (!project.jira) return { id: 'local', name: '本地项目', basis: 'local' };
  if (project.jira.category) return { id: `category:${project.jira.category.id}`, name: project.jira.category.name, basis: 'category' };
  const prefix = project.name.includes('-') ? project.name.split('-')[0] : '';
  return prefix ? { id: `name:${prefix}`, name: prefix, basis: 'name' } : { id: 'ungrouped', name: '未分组', basis: 'name' };
};
export interface JiraIssueMetadata {
  type?: string; issueType?: { id: string; name: string; subtask?: boolean };
  project?: { id: string; key: string; name: string }; parentKey?: string | null;
  priority?: { id: string; name: string } | null;
  components?: { id: string; name: string }[];
  fixVersions?: { id: string; name: string; released?: boolean }[];
  labels?: string[]; assignee?: { id: string; name: string; displayName?: string } | null;
}
export interface WorkTask {
  id: string; jiraKey: string; title: string; projectId: string; parentId: string | null;
  type: 'STORY' | 'TASK' | 'BUG' | 'RELEASE'; assigneeId: string | null; ownerId: string;
  status: TaskStatus; version: number; progress: number; lastSummary: string; updatedAt: string;
  externalRef?: ({ provider: string; key: string; title: string; description: unknown; status: string; url: string; version: string } & JiraIssueMetadata) | null;
}
export interface Asset {
  id: string; taskId: string; projectId: string; kind: AssetKind; logicalKey: string;
  title: string; content: string; sourceUrl: string | null; revision: number; sha256: string;
  actorId: string; createdAt: string;
}
export interface Finding {
  id: string; severity: 'CRITICAL' | 'WARN' | 'INFO'; title: string; detail: string; location: string | null;
  waiver: null | { id: string; reason: string; actorId: string; createdAt: string };
}
export interface ReviewJob {
  id: string; taskId: string; projectId: string; stage: Stage; executionMode: ExecutionMode;
  status: string; actorId: string; createdAt: string; inputHash: string; persona: string;
  skills: string[]; executor: string; snapshot: Record<string, unknown>; stale: boolean; soloMode?: boolean;
  report: null | { id: string; summary: string; source: string; tool: string | null; evidence: string | null; actorId: string; createdAt: string };
  findings: Finding[];
  decision: null | { id: string; decision: string; reason: string; actorId: string; createdAt: string };
}
export interface CodeupMrItem {
  id: string; localId: string; repositoryId: string; name: string; title: string;
  state: string; sourceBranch: string; targetBranch: string; repositoryName: string;
  authorName: string; updatedAt: string; detailUrl: string;
}
export interface Gates { overall: string; gates: { stage: Stage; status: string; jobId?: string; reason?: string }[] }
export interface ProgressEvent { id: string; actorId: string; tool: string; deviceId?: string; progress: number; summary: string; branch?: string; createdAt: string }
export interface TaskDetailBundle { task: WorkTask; context: TaskContext; assets: Asset[]; gates: Gates; jobs: ReviewJob[] }
export interface Device { deviceId: string; taskId: string; actorId: string; tool: string; status: string; lastSeen: string; online: boolean }
export interface ProjectWorkspace { projectId: string; repoPath: string; defaultTarget: string; updatedAt: string }
export interface HostBridgeDevice {
  id: string; deviceName: string; tool: string; status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  createdAt: string; lastSeenAt: string | null; expiresAt: string; projectIds: string[]; scope: 'LOCAL_BRIDGE';
}
export interface HostBridgeStatus {
  supported: boolean; connected: boolean;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'DISCONNECTED' | 'UNSUPPORTED' | 'INVALID' | 'OTHER_USER';
  device: HostBridgeDevice | null; suggestedProjectIds: string[];
}
export type LocalAiRunner = 'local' | 'workbench' | 'bridge';
export type LocalAiEngineId = 'codex' | 'antigravity' | 'cursor' | 'claude';
export interface LocalAutomationEngine { id: LocalAiEngineId; label: string; tool: string; available: boolean }
export interface BridgeDevice {
  id: string; deviceName: string; tool: string; projectIds: string[];
  lastSeenAt: string | null; expiresAt: string; online: boolean;
}
export interface TeamAgent {
  id: string; deviceName: string; tool: string; owner: { id: string; username: string };
  lastSeenAt: string | null; online: boolean; teamDispatch: boolean; mine: boolean; dispatchable: boolean;
}
export interface LocalAutomationCapabilities {
  supported: boolean;
  deployment?: 'local' | 'server';
  runners?: LocalAiRunner[];
  bridgeModes?: ('read' | 'develop' | 'review')[];
  devices?: BridgeDevice[];
  engines: LocalAutomationEngine[];
  apps: { cursor: boolean; terminal: boolean; finder: boolean; workbenchUrl: string };
}
export interface LocalGitRepo {
  name: string; path: string; group?: string; branch?: string | null; dirty?: boolean; remoteUrl?: string | null;
}
export interface ProjectGitStatus {
  configured: boolean; accessible: boolean; tccProtected: boolean; repoPath: string | null;
  branch?: string | null; head?: string | null; shortHead?: string | null; subject?: string;
  remoteUrl?: string | null; dirtyCount?: number; dirtyFiles?: string[];
  recentCommits?: { hash: string; subject: string; committedAt: string }[];
  constitutionFiles?: string[];
  reason?: string;
}
export interface LocalAiRunDraft {
  summary: string; evidence?: string;
  findings: { severity: Finding['severity']; title: string; detail: string; location?: string }[];
  autoSubmitted?: boolean;
}
export interface LocalAiRun {
  id: string; taskId: string; projectId: string; jobId: string | null; actorId: string;
  mode: 'read' | 'develop' | 'review'; engine: LocalAiEngineId; tool: string; repoPath: string | null;
  runner?: LocalAiRunner; workbenchUrl?: string;
  deviceId?: string; deviceName?: string | null; deviceOwner?: { id: string; username: string } | null; bridgePhase?: 'QUEUED' | 'CLAIMED' | 'EXECUTING' | null; cancelRequested?: boolean;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'; exitCode: number | null;
  output: string; draft: LocalAiRunDraft | null; error: string | null;
  startedAt: string; finishedAt: string | null; updatedAt: string;
}
export interface ConnectorSummary {
  provider: 'jira' | 'confluence' | 'gitlab' | 'jenkins' | 'yunxiao';
  name: string; status: string; baseUrl?: string; localProfileAvailable?: boolean;
  selectionUnavailable?: boolean; lastError?: string; accountId?: string; accountName?: string;
}
export interface TaskContext { task: WorkTask; assets: Asset[]; progressEvents: ProgressEvent[]; devices: Device[]; integrationStatus: string; workspace?: ProjectWorkspace | null }
export const STAGES: { value: Stage; label: string }[] = [
  { value: 'PRD', label: '需求评审' }, { value: 'TECH_SPEC', label: '技术方案审核' },
  { value: 'CODE_REVIEW', label: '代码审核' }, { value: 'TEST_CASE', label: '测试用例评审' },
  { value: 'RELEASE', label: '上线审核' },
];
export const REVIEW_ROLES: Record<Stage, Role[]> = {
  PRD: ['ADMIN', 'LEAD', 'PM'], TECH_SPEC: ['ADMIN', 'LEAD', 'DEV'],
  CODE_REVIEW: ['ADMIN', 'LEAD', 'DEV'], TEST_CASE: ['ADMIN', 'LEAD', 'QA'], RELEASE: ['ADMIN', 'SRE'],
};
export const APPROVE_ROLES: Record<Stage, Role[]> = {
  PRD: ['ADMIN', 'LEAD', 'PM'], TECH_SPEC: ['ADMIN', 'LEAD'],
  CODE_REVIEW: ['ADMIN', 'LEAD'], TEST_CASE: ['ADMIN', 'LEAD', 'QA'], RELEASE: ['ADMIN', 'SRE'],
};
export const ASSET_ROLES: Record<AssetKind, Role[]> = {
  PRD: ['ADMIN', 'LEAD', 'PM'], TECH_SPEC: ['ADMIN', 'LEAD', 'DEV'], CODE: ['ADMIN', 'LEAD', 'DEV'],
  TEST_CASE: ['ADMIN', 'LEAD', 'QA'], RELEASE_PLAN: ['ADMIN', 'LEAD', 'SRE'],
};
export interface OverviewSummaryJob {
  id: string; taskId: string; projectId: string; stage: Stage; executionMode: ExecutionMode;
  status: string; actorId: string; createdAt: string; stale: boolean; soloMode?: boolean;
  hasBlockingFindings?: boolean; prerequisitesBlocked?: boolean;
  report: null | { id: string; actorId: string; source: string; tool: string | null; createdAt: string };
  decision: null;
}
export interface OverviewStageStat {
  approved: number;
  pendingApproval: number;
  awaitingReport: number;
  changesRequested: number;
}
export interface OverviewSummary {
  reviewCount: number;
  assetCount: number;
  openBlockersCount?: number;
  stageBreakdown?: Partial<Record<Stage, OverviewStageStat>>;
  flowTelemetry?: OverviewFlowTelemetry;
  pendingJobs: OverviewSummaryJob[];
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export const hubApiUrl = (): string => location.port === '5186' ? 'http://127.0.0.1:5187' : location.origin;
export const hubHostLabel = (): string => location.host;
export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
  const inFlightGets = new Map<string, Promise<unknown>>();
  return async function apiClient<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const canDedupe = method === 'GET' && body === undefined;
    if (canDedupe) {
      const existing = inFlightGets.get(path);
      if (existing) return existing as Promise<T>;
    }
    const execute = (async (): Promise<T> => {
      let response: Response;
      try {
        const mergeRequestRoute = /\/merge-requests(?:[/?]|$)|^connectors\/(?:gitlab|yunxiao)\/(?:read|import)(?:[?]|$)/.test(path);
        response = await fetchImpl(`/api/${path}`, {
          method, credentials: 'same-origin', signal: AbortSignal.timeout(mergeRequestRoute ? 85_000 : path.startsWith('connectors/') || path.includes('/ai-runs') || path.includes('/from-git') ? 40_000 : 15_000),
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch { throw new ApiError('本地基础服务连接失败，请确认 5187 端口的服务已启动。', 0); }
      if (response.status === 204) return undefined as T;
      let data: T & { error?: { message?: string } };
      try { data = await response.json(); }
      catch { throw new ApiError('本地服务响应格式不正确。', response.status); }
      if (!response.ok) throw new ApiError(typeof data.error?.message === 'string' ? data.error.message : `请求失败（HTTP ${response.status}）。`, response.status);
      return data;
    })();
    if (canDedupe) {
      inFlightGets.set(path, execute);
      void execute.finally(() => { if (inFlightGets.get(path) === execute) inFlightGets.delete(path); });
    }
    return execute;
  };
}
export const api = createApiClient();
export const timeText = (value?: string) => value ? new Date(value).toLocaleString() : '—';
export const memberName = (members: User[], id?: string | null) => id ? members.find(user => user.id === id)?.username || id : '未指派';

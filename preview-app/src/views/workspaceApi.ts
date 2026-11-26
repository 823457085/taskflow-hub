import type { Role, ProjectPermissions } from './workspacePermissions.ts';
import type { OverviewFlowTelemetry } from './deliveryMetrics.ts';
export * from './workspacePermissions.ts';
export type { OverviewFlowTelemetry } from './deliveryMetrics.ts';
/** Five completion-gate stages. */
export type GateStage = 'PRD' | 'TECH_SPEC' | 'CODE_REVIEW' | 'TEST_CASE' | 'RELEASE';
/** Review stages: the five gates plus the advisory 任务拆分审核 (TASK_BREAKDOWN). */
export type Stage = GateStage | 'TASK_BREAKDOWN';
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
export const isLocalTaskKey = (value: string): boolean => /^LOCAL-T[0-9A-F]{32}$/.test(value);
export interface WorkTask {
  id: string; jiraKey: string; title: string; projectId: string; parentId: string | null;
  type: 'STORY' | 'TASK' | 'BUG' | 'RELEASE'; assigneeId: string | null; ownerId: string;
  status: TaskStatus; version: number; progress: number; lastSummary: string; updatedAt: string;
  externalRef?: ({ provider: string; key: string; title: string; description: unknown; status: string; url: string; version: string } & JiraIssueMetadata) | null;
}
export const isChildTask = (task: Pick<WorkTask, 'parentId' | 'externalRef'>) =>
  !!task.parentId || task.externalRef?.issueType?.subtask === true;

export interface Asset {
  id: string; taskId: string; projectId: string; kind: AssetKind; logicalKey: string;
  title: string; content: string; sourceUrl: string | null; revision: number; sha256: string;
  actorId: string; createdAt: string;
}
export type FindingCategory = 'CORRECTNESS' | 'SECURITY' | 'SPEC_ALIGN' | 'CONTRACT' | 'TESTS' | 'MAINTAINABILITY';
export type RiskLevel = 'low' | 'medium' | 'high';
export type RuleEnforcement = 'WARN' | 'BLOCK';
export interface WalkthroughItem { file: string; summary: string; risk?: RiskLevel }
export interface ClarifyQuestion { id: string; question: string; impact?: string; owner?: string; resolved?: boolean }
export interface ReportMeta {
  riskLevel?: RiskLevel;
  effortScore?: number;
  coverageMetrics?: { coveragePrd?: number; traceAc?: number };
  walkthrough?: WalkthroughItem[];
  compliance?: { compliant: string[]; missing: string[]; manualCheck: string[] };
  clarifyQuestions?: ClarifyQuestion[];
}
export interface Finding {
  id: string; severity: 'CRITICAL' | 'WARN' | 'INFO'; title: string; detail: string; location: string | null;
  category?: FindingCategory; confidence?: number; ruleId?: string;
  suggestedPatch?: { before: string; after: string };
  waiver: null | { id: string; reason: string; actorId: string; createdAt: string };
}
export interface ReviewJob {
  reviewRequired?: boolean;
  id: string; taskId: string; projectId: string; stage: Stage; executionMode: ExecutionMode;
  status: string; actorId: string; createdAt: string; inputHash: string; persona: string;
  skills: string[]; executor: string; snapshot: Record<string, unknown>; stale: boolean; soloMode?: boolean;
  report: null | { id: string; summary: string; source: string; tool: string | null; evidence: string | null; actorId: string; createdAt: string; verdict?: ReportVerdict | null; score?: number | null; checklist?: ChecklistItem[]; meta?: ReportMeta };
  findings: Finding[];
  decision: null | { id: string; decision: string; reason: string; actorId: string; createdAt: string };
}
export interface CodeupMrItem {
  id: string; localId: string; repositoryId: string; name: string; title: string;
  state: string; sourceBranch: string; targetBranch: string; repositoryName: string;
  authorName: string; updatedAt: string; detailUrl: string;
}
export interface Gates { overall: string; gates: { stage: GateStage; status: string; jobId?: string; reason?: string }[] }
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
  bindingRevision?: string;
}
export type LocalAiRunner = 'local' | 'workbench' | 'bridge';
export type LocalAiEngineId = 'codex' | 'antigravity' | 'cursor' | 'claude';
export interface LocalAutomationEngine {
  id: LocalAiEngineId; label: string; tool: string; available: boolean;
  supportsModel?: boolean; defaultModel?: string | null;
}
export interface BridgeDevice {
  id: string; deviceName: string; tool: string; projectIds: string[];
  lastSeenAt: string | null; expiresAt: string; online: boolean; modelEngines?: string[];
}
export interface TeamAgent {
  id: string; deviceName: string; tool: string; owner: { id: string; username: string };
  lastSeenAt: string | null; online: boolean; teamDispatch: boolean; mine: boolean; dispatchable: boolean; modelEngines?: string[];
}
export interface LocalAutomationCapabilities {
  supported: boolean;
  deployment?: 'local' | 'server';
  runners?: LocalAiRunner[];
  bridgeModes?: ('read' | 'develop' | 'review')[];
  devices?: BridgeDevice[];
  engines: LocalAutomationEngine[];
  apps: { cursor: boolean; terminal: boolean; finder: boolean; workbenchUrl: string; workbenchSupportsModel?: boolean; workbenchProjectIds?: string[] };
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
export interface SubtaskDraftItem {
  title: string; type: WorkTask['type']; roleHint?: string; estimateDays?: number; after?: string[]; covers?: string[];
}
export interface LocalAiRunDraft {
  summary: string; evidence?: string;
  findings: {
    severity: Finding['severity']; title: string; detail: string; location?: string;
    category?: FindingCategory; confidence?: number; ruleId?: string;
    suggestedPatch?: { before: string; after: string };
  }[];
  autoSubmitted?: boolean;
  verdict?: ReportVerdict; score?: number; checklist?: ChecklistItem[]; meta?: ReportMeta;
  subtasks?: SubtaskDraftItem[]; rationale?: string; answer?: string;
}
export type SkillScopeId =
  | 'PRD_REVIEW'
  | 'JIRA_GEN'
  | 'TECH_SPEC_GEN'
  | 'TECH_SPEC_REVIEW'
  | 'CODE_GEN'
  | 'CODE_REVIEW'
  | 'TEST_CASE'
  | 'RELEASE';
export interface SkillScopeMeta {
  id: SkillScopeId;
  label: string;
  group: 'review' | 'generate' | 'quality';
  description: string;
}
export interface SkillAttachmentFile {
  path: string;
  content: string;
}
export interface TeamSkillItem {
  id: string;
  projectId: string | null;
  name: string;
  title?: string;
  description: string;
  scopes: SkillScopeId[];
  source: string;
  visibility: 'TEAM' | 'PERSONAL';
  fileCount: number;
  version: number;
  enabled: boolean;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
  content?: string;
  files?: SkillAttachmentFile[];
}
export interface LocalAiRun {
  id: string; taskId: string; projectId: string; jobId: string | null; actorId: string;
  mode: 'read' | 'develop' | 'review'; engine: LocalAiEngineId; tool: string; repoPath: string | null;
  model?: string | null; effectiveModel?: string | null;
  actionType?: 'DEFAULT' | 'CHAIN_ANALYZE' | 'REVIEW_ASK' | 'SUBTASK_DRAFT' | 'TECH_SPEC_GEN' | 'TEST_CASE_GEN';
  appliedSkills?: string[];
  askFindingId?: string; askQuestion?: string; worktreeBranch?: string; worktreePath?: string;
  runner?: LocalAiRunner; workbenchUrl?: string;
  deviceId?: string; deviceName?: string | null; deviceOwner?: { id: string; username: string } | null; bridgePhase?: 'QUEUED' | 'CLAIMED' | 'EXECUTING' | null; cancelRequested?: boolean;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'; exitCode: number | null;
  output: string; draft: LocalAiRunDraft | null; error: string | null;
  startedAt: string; finishedAt: string | null; updatedAt: string;
}
export interface ConnectorSummary {
  provider: 'jira' | 'confluence' | 'gitlab' | 'jenkins' | 'yunxiao';
  name: string; status: string; baseUrl?: string; localProfileAvailable?: boolean;
  selectionUnavailable?: boolean; hasCredential?: boolean; lastError?: string; accountId?: string; accountName?: string;
}
export interface TaskContext { task: WorkTask; assets: Asset[]; progressEvents: ProgressEvent[]; devices: Device[]; integrationStatus: string; workspace?: ProjectWorkspace | null }
export interface CloudAiConfig {
  projectId: string;
  providerType: 'openai_compatible' | 'dify';
  name: string;
  baseUrl: string;
  model: string;
  difyMode: 'workflow' | 'chat';
  hasCredential: boolean;
  enabled: boolean;
  autoStages: Stage[];
  autoWritebackMr: boolean;
  timeoutMs: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}
export interface ProjectWebhook {
  id: string;
  projectId: string;
  provider: 'gitlab' | 'confluence' | 'generic';
  name: string;
  secretPreview: string;
  enabled: boolean;
  autoReview: boolean;
  createdBy: string;
  createdAt: string;
  lastTriggeredAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  webhookPath: string;
}
export interface WebhookEvent {
  id: string;
  webhookId: string;
  projectId: string;
  provider: string;
  eventType: string;
  taskId: string | null;
  status: string;
  summary: string;
  createdAt: string;
}
export type ImChannel = 'feishu' | 'dingtalk' | 'wecom' | 'generic';
export type ImEventType = 'REPORT_SUBMITTED' | 'CRITICAL_BLOCKER' | 'DECISION_MADE' | 'WEBHOOK_TRIGGERED' | 'MR_WRITEBACK';
export interface ImNotificationConfig {
  id: string;
  projectId: string;
  channel: ImChannel;
  name: string;
  urlPreview: string;
  hasSigningSecret: boolean;
  events: ImEventType[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}
export interface ImNotificationLog {
  id: string;
  imWebhookId: string;
  projectId: string;
  channel: string;
  eventType: string;
  status: string;
  summary: string;
  error: string | null;
  createdAt: string;
}
export interface MrWritebackRecord {
  id: string;
  taskId: string;
  assetId: string;
  jobId: string;
  provider: string;
  postedCount: number;
  inlineCount: number;
  summaryPosted: boolean;
  actorId: string;
  mode: 'MANUAL' | 'AUTO';
  createdAt: string;
}
export interface PrecheckResult {
  findings: { severity: Finding['severity']; title: string; detail: string; location?: string }[];
  executedPlugins: string[];
  checks: string[];
}
export interface ApiSpecImportResult {
  asset: Asset;
  specSummary: {
    format: string;
    title: string;
    version: string;
    endpointCount: number;
    endpoints: { method: string; path: string; summary?: string; hasSecurity: boolean; hasErrorResponse: boolean }[];
  };
  findings: { severity: Finding['severity']; title: string; detail: string; location?: string }[];
}
export const STAGES: { value: GateStage; label: string }[] = [
  { value: 'PRD', label: '需求评审' }, { value: 'TECH_SPEC', label: '技术方案审核' },
  { value: 'CODE_REVIEW', label: '代码审核' }, { value: 'TEST_CASE', label: '测试用例评审' },
  { value: 'RELEASE', label: '上线审核' },
];
/** Review stages in delivery-chain order (需求 → 任务拆分 → 方案 → 代码 → 测试 → 上线). */
export const REVIEW_STAGE_OPTIONS: { value: Stage; label: string }[] = [
  { value: 'PRD', label: '需求评审' }, { value: 'TASK_BREAKDOWN', label: '任务拆分审核' }, { value: 'TECH_SPEC', label: '技术方案审核' },
  { value: 'CODE_REVIEW', label: '代码审核' }, { value: 'TEST_CASE', label: '测试用例评审' }, { value: 'RELEASE', label: '上线审核' },
];
export const REVIEW_ROLES: Record<Stage, Role[]> = {
  PRD: ['ADMIN', 'LEAD', 'PM', 'DEV'], TASK_BREAKDOWN: ['ADMIN', 'LEAD', 'DEV', 'PM'], TECH_SPEC: ['ADMIN', 'LEAD', 'DEV'],
  CODE_REVIEW: ['ADMIN', 'LEAD', 'DEV'], TEST_CASE: ['ADMIN', 'LEAD', 'QA', 'DEV'], RELEASE: ['ADMIN', 'SRE', 'DEV'],
};
export const APPROVE_ROLES: Record<Stage, Role[]> = {
  PRD: ['ADMIN', 'LEAD', 'PM'], TASK_BREAKDOWN: ['ADMIN', 'LEAD'], TECH_SPEC: ['ADMIN', 'LEAD'],
  CODE_REVIEW: ['ADMIN', 'LEAD'], TEST_CASE: ['ADMIN', 'LEAD', 'QA'], RELEASE: ['ADMIN', 'SRE'],
};
export const ASSET_ROLES: Record<AssetKind, Role[]> = {
  PRD: ['ADMIN', 'LEAD', 'PM', 'DEV'], TECH_SPEC: ['ADMIN', 'LEAD', 'DEV'], CODE: ['ADMIN', 'LEAD', 'DEV'],
  TEST_CASE: ['ADMIN', 'LEAD', 'QA', 'DEV'], RELEASE_PLAN: ['ADMIN', 'LEAD', 'SRE', 'DEV'],
};
export interface OverviewSummaryJob {
  reviewRequired?: boolean;
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
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
        const longRunningRoute = /\/merge-requests(?:[/?]|$)|^connectors\/(?:gitlab|yunxiao)\/(?:read|import)(?:[?]|$)|\/cloud-execute$|\/writeback$|\/import-api-spec$|\/cloud-ai\/test$/.test(path);
        response = await fetchImpl(`/api/${path}`, {
          method, credentials: 'same-origin', signal: AbortSignal.timeout(longRunningRoute ? 85_000 : path.startsWith('connectors/') || path.includes('/ai-runs') || path.includes('/from-git') ? 40_000 : 15_000),
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch { throw new ApiError('本地基础服务连接失败，请确认 5187 端口的服务已启动。', 0); }
      if (response.status === 204) return undefined as T;
      let data: T & { error?: { message?: string; code?: string } };
      try { data = await response.json(); }
      catch { throw new ApiError('本地服务响应格式不正确。', response.status); }
      if (!response.ok) throw new ApiError(typeof data.error?.message === 'string' ? data.error.message : `请求失败（HTTP ${response.status}）。`, response.status, data.error?.code);
      return data;
    })();
    if (canDedupe) {
      inFlightGets.set(path, execute);
      const clearInFlight = () => { if (inFlightGets.get(path) === execute) inFlightGets.delete(path); };
      void execute.then(clearInFlight, clearInFlight);
    }
    return execute;
  };
}
export const api = createApiClient();
// 已登录时经登录交接打开网页工作台；仅本地预览（localhost）在失败时退回本机 5288。
export function openWorkbench(path = '/agent') {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  const go = (url: string) => { if (tab) tab.location.replace(url); else window.location.assign(url); };
  void api<{ url: string }>('workbench/codes', { return: path })
    .then(result => go(result.url))
    .catch(() => {
      if (['localhost', '127.0.0.1'].includes(location.hostname)) return go(`http://127.0.0.1:5288${path}`);
      tab?.close();
    });
}
export const timeText = (value?: string) => value ? new Date(value).toLocaleString() : '—';
export const memberName = (members: User[], id?: string | null) => id ? members.find(user => user.id === id)?.username || id : '未指派';

export type ReportVerdict = 'PASS' | 'CONDITIONAL' | 'FAIL';
export interface ChecklistItem { item: string; result: 'PASS' | 'WARN' | 'FAIL' | 'NA'; note: string; ref?: string }
export type ChainLinkId = 'REQUIREMENT' | 'BREAKDOWN' | 'TECH_SPEC' | 'CODE' | 'TEST' | 'RELEASE';
export type ChainLinkStatus = 'LINKED' | 'MISSING' | 'READY' | 'REVIEWING' | 'AWAITING_DECISION' | 'PASS' | 'CONDITIONAL' | 'CHANGES_REQUESTED' | 'BLOCKED' | 'STALE';
export interface ChainObject { type: string; label: string; url?: string | null; meta?: string | null; key?: string; taskId?: string; assetId?: string; kind?: AssetKind; assignee?: string | null }
export interface ChainCheck { id: string; label: string; ok: boolean | null; level: 'required' | 'advice'; detail: string }
export interface ChainNextAction { type: 'ADD_INPUT' | 'ADD_SUBTASKS' | 'AI_REVIEW' | 'DECIDE' | 'FIX' | 'VIEW'; label: string; stage?: Stage; jobId?: string; assetKind?: AssetKind }
export interface ChainReview {
  jobId: string; status: string; stale: boolean; createdAt: string; executionMode: ExecutionMode;
  verdict: ReportVerdict | null; score: number | null; summary: string; tool: string | null; reportedAt: string | null; checklist: ChecklistItem[]; meta?: ReportMeta;
  findings: { critical: number; warn: number; info: number; waived: number; items: { id: string; severity: Finding['severity']; title: string; detail: string; location: string | null; waived: boolean; category?: FindingCategory; confidence?: number; ruleId?: string; suggestedPatch?: { before: string; after: string } }[] };
  decision: { decision: string; reason: string; createdAt: string } | null;
}
export interface ChainDelta {
  assetId: string; kind: AssetKind; linkId: ChainLinkId | null; title: string;
  fromRevision: number; toRevision: number; additions: number; deletions: number;
  changedHeadings: string[]; previewLines: { kind: '+' | '-'; text: string }[];
}
export interface ChainConflict {
  id: string; severity: Finding['severity']; category?: FindingCategory; title: string; detail: string; linkIds: ChainLinkId[];
}
export interface ChainAnalysis {
  metrics: { coveragePrd: number | null; traceAc: number | null; clarifyOpenCount: number; constitutionCount: number; customRuleCount: number; conflictCount: number };
  constitutionFiles: string[];
  conflicts: ChainConflict[];
}
export interface ChainLink {
  id: ChainLinkId; index: number; stage: Stage; title: string; purpose: string; focus: string[]; advisory: boolean;
  status: ChainLinkStatus; statusLabel: string; gateReason: string; missing: string[];
  objects: ChainObject[]; checks: ChainCheck[]; delta?: ChainDelta | null; review: ChainReview | null; next: ChainNextAction | null;
}
export type ChainStatusMap = Record<Stage, ChainLinkStatus>;
export interface ChainChild { id: string; jiraKey: string; title: string; status: TaskStatus; jiraStatus: string | null; assignee: string | null; url: string | null; links: ChainStatusMap | null }
export interface DeliveryChain {
  generatedAt: string;
  task: { id: string; jiraKey: string; title: string; url: string | null; status: TaskStatus; jiraStatus: string | null; assignee: string | null; projectId: string; fixVersions: string[] };
  parent: { id: string; jiraKey: string; title: string } | null;
  requirementKeys: string[];
  overall: { status: 'PASS' | 'BLOCKED' | 'IN_PROGRESS' | 'NOT_REQUIRED'; passed: number; total: number; score: number | null; currentLinkId: ChainLinkId | null; blockers: { linkId: ChainLinkId; link: string; kind: string; title: string; detail: string }[] };
  links: ChainLink[]; children: ChainChild[];
  traceability: { point: string; result: ChecklistItem['result']; note: string; tasks: { key: string; title: string | null; taskId: string | null; links: ChainStatusMap | null }[] }[];
  deltas?: ChainDelta[];
  analysis?: ChainAnalysis;
}
export const CHAIN_STAGE_ORDER: Stage[] = ['PRD', 'TASK_BREAKDOWN', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE'];
export const CHAIN_STAGE_SHORT: Record<Stage, string> = { PRD: '需求', TASK_BREAKDOWN: '拆分', TECH_SPEC: '方案', CODE_REVIEW: '代码', TEST_CASE: '测试', RELEASE: '上线' };

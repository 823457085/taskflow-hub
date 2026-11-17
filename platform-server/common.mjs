import { createHash } from 'node:crypto';
export const ROLES = ['ADMIN', 'DEV', 'QA', 'LEAD', 'SRE', 'PM'];
export const PROJECT_ROLES = ['DEV', 'QA', 'LEAD', 'SRE', 'PM'];
export const STAGES = ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE', 'RELEASE'];
export const KINDS = ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN'];
export const TOOLS = ['codex', 'codex-cli', 'claude-code', 'cursor', 'custom'];
export const REVIEW_ROLES = { ADMIN: STAGES, LEAD: ['PRD', 'TECH_SPEC', 'CODE_REVIEW', 'TEST_CASE'], DEV: ['TECH_SPEC', 'CODE_REVIEW'], QA: ['TEST_CASE'], SRE: ['RELEASE'], PM: ['PRD'] };
export const APPROVAL_ROLES = { PRD: ['ADMIN', 'LEAD', 'PM'], TECH_SPEC: ['ADMIN', 'LEAD'], CODE_REVIEW: ['ADMIN', 'LEAD'], TEST_CASE: ['ADMIN', 'LEAD', 'QA'], RELEASE: ['ADMIN', 'SRE'] };
export const ASSET_ROLES = { PRD: ['ADMIN', 'LEAD', 'PM'], TECH_SPEC: ['ADMIN', 'LEAD', 'DEV'], CODE: ['ADMIN', 'LEAD', 'DEV'], TEST_CASE: ['ADMIN', 'LEAD', 'QA'], RELEASE_PLAN: ['ADMIN', 'LEAD', 'SRE'] };
export const STAGE_AGENTS = {
  PRD: { persona: 'ai-pm', skills: ['prd-completeness-audit', 'state-machine-validator'] },
  TECH_SPEC: { persona: 'ai-architect', skills: ['prd-techspec-align', 'golden-contract-extractor'] },
  CODE_REVIEW: { persona: 'ai-reviewer', skills: ['cross-repo-contract-diff', 'fe-security-and-perf'] },
  TEST_CASE: { persona: 'ai-qa', skills: ['ac-blackbox-coverage', 'whitebox-branch-scanner'] },
  RELEASE: { persona: 'ai-sre', skills: ['release-rbom-audit', 'release-dependency-check'] },
};
export class ApiError extends Error { constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; } }
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
export const sha = value => createHash('sha256').update(value).digest('hex');
export const fullGitSha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
export function publicGitRemote(value) {
  if (typeof value !== 'string' || !value || /[\s`\\]/.test(value)) return null;
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^/\s][^\s]*)$/.exec(value);
  try {
    const url = new URL(scp ? 'ssh://' + scp[1] + '/' + scp[2] : value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.host || !url.pathname || url.pathname === '/') return null;
    return url.protocol + '//' + url.host + url.pathname;
  } catch { return null; }
}
export function textField(value, name, { min = 1, max = 200, preserve = false } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(400, 'INVALID_INPUT', `${name}格式不正确`);
  return preserve ? value : value.trim();
}
export const publicUser = user => ({ id: user.id, username: user.username, role: user.role });
export function bumpParentContexts(db, parentIds) {
  const now = new Date().toISOString();
  for (const id of new Set(parentIds.filter(Boolean))) db.prepare('UPDATE tasks SET version=version+1,context_version=context_version+1,updated_at=? WHERE id=?').run(now, id);
}
export const taskRow = row => row && ({ id: row.id, jiraKey: row.jira_key, title: row.title, jiraStatus: row.jira_verified ? 'verified' : 'unverified', externalRef: row.external_ref ? JSON.parse(row.external_ref) : null, ownerId: row.owner_id, projectId: row.project_id, parentId: row.parent_id, type: row.task_type, assigneeId: row.assignee_id, status: row.status, version: row.version, contextVersion: row.context_version, createdAt: row.created_at, progress: row.progress, lastSummary: row.last_summary, updatedAt: row.updated_at });
export const assetRow = row => ({ id: row.id, taskId: row.task_id, projectId: row.project_id, kind: row.kind, logicalKey: row.logical_key, title: row.title, content: row.content, sourceUrl: row.source_url, revision: row.revision, sha256: row.sha256, actorId: row.actor_id, createdAt: row.created_at });

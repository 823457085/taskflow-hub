import test from 'node:test';
import assert from 'node:assert/strict';
import { canQuickApproveReview, isTaskFrozen, requiresTaskReview } from '../preview-app/src/views/taskAvailability.ts';

const node = (id, status = 'OPEN', parentId = null) => ({ id, status, parentId });

test('completed tasks and descendants of completed ancestors are frozen', () => {
  const root = node('root', 'DONE');
  const child = node('child', 'IN_PROGRESS', 'root');
  const leaf = node('leaf', 'OPEN', 'child');
  const tasks = [root, child, leaf];
  for (const task of tasks) assert.equal(isTaskFrozen(task, tasks), true);
});

test('missing tasks, missing parents and cyclic ancestry fail closed', () => {
  assert.equal(isTaskFrozen(undefined, []), true);
  const orphan = node('orphan', 'OPEN', 'missing');
  assert.equal(isTaskFrozen(orphan, [orphan]), true);
  const self = node('self', 'OPEN', 'self');
  assert.equal(isTaskFrozen(self, [self]), true);
  const a = node('a', 'OPEN', 'b');
  const b = node('b', 'IN_PROGRESS', 'a');
  const descendant = node('descendant', 'IN_REVIEW', 'a');
  for (const task of [a, b, descendant]) assert.equal(isTaskFrozen(task, [a, b, descendant]), true);
});

test('open roots and open ancestry remain available without changing inputs', () => {
  const tasks = Object.freeze([
    Object.freeze(node('leaf', 'IN_REVIEW', 'middle')),
    Object.freeze(node('root')),
    Object.freeze(node('middle', 'IN_PROGRESS', 'root')),
  ]);
  const original = structuredClone(tasks);
  for (const task of tasks) assert.equal(isTaskFrozen(task, tasks), false);
  assert.deepEqual(tasks, original);
  assert.equal(isTaskFrozen(node('standalone'), []), false);
});

test('canQuickApproveReview enforces independence/soloMode, role, critical findings, staleness and RELEASE upstream gates', () => {
  const activeTask = { id: 't1', status: 'IN_REVIEW', parentId: null, assigneeId: 'dev-1' };
  const doneTask = { id: 't2', status: 'DONE', parentId: null, assigneeId: 'dev-1' };
  const tasks = [activeTask, doneTask];

  const baseJob = {
    stage: 'CODE_REVIEW',
    stale: false,
    soloMode: false,
    report: { id: 'r1', summary: 'ok', source: 'LOCAL_TOOL', tool: 'codex-cli', evidence: null, actorId: 'dev-1', createdAt: '2026-11-14T10:00:00Z' },
    decision: null,
    findings: [],
    snapshot: {},
  };

  // Independent LEAD can quick-approve
  assert.equal(canQuickApproveReview(baseJob, activeTask, tasks, { id: 'lead-1' }, 'LEAD'), true);
  // QA cannot approve CODE_REVIEW (APPROVE_ROLES.CODE_REVIEW = ADMIN | LEAD)
  assert.equal(canQuickApproveReview(baseJob, activeTask, tasks, { id: 'qa-1' }, 'QA'), false);
  // Self-report without soloMode cannot quick-approve
  assert.equal(canQuickApproveReview(baseJob, activeTask, tasks, { id: 'dev-1' }, 'ADMIN'), false);
  // Solo mode allows single-account admin/lead to quick-approve
  assert.equal(canQuickApproveReview({ ...baseJob, soloMode: true }, activeTask, tasks, { id: 'dev-1' }, 'ADMIN'), true);
  // Stale or already decided or missing report cannot quick-approve
  assert.equal(canQuickApproveReview({ ...baseJob, stale: true }, activeTask, tasks, { id: 'lead-1' }, 'LEAD'), false);
  assert.equal(canQuickApproveReview({ ...baseJob, report: null }, activeTask, tasks, { id: 'lead-1' }, 'LEAD'), false);
  assert.equal(canQuickApproveReview({ ...baseJob, decision: { id: 'd1', decision: 'APPROVE', reason: 'ok', actorId: 'lead-1', createdAt: '' } }, activeTask, tasks, { id: 'lead-1' }, 'LEAD'), false);
  // Frozen task cannot quick-approve
  assert.equal(canQuickApproveReview(baseJob, doneTask, tasks, { id: 'lead-1' }, 'LEAD'), false);

  // Unwaived CRITICAL blocks quick-approve; waived CRITICAL allows quick-approve
  const unwaivedCritical = {
    ...baseJob,
    findings: [{ id: 'f1', severity: 'CRITICAL', title: 'Bug', detail: 'Boom', location: null, waiver: null }],
  };
  assert.equal(canQuickApproveReview(unwaivedCritical, activeTask, tasks, { id: 'lead-1' }, 'LEAD'), false);
  const waivedCritical = {
    ...baseJob,
    findings: [{ id: 'f1', severity: 'CRITICAL', title: 'Bug', detail: 'Boom', location: null, waiver: { id: 'w1', reason: 'Accepted', actorId: 'lead-1', createdAt: '' } }],
  };
  assert.equal(canQuickApproveReview(waivedCritical, activeTask, tasks, { id: 'lead-1' }, 'LEAD'), true);

  // RELEASE requires upstreamApprovals in snapshot to be PASS
  const blockedRelease = {
    ...baseJob,
    stage: 'RELEASE',
    snapshot: { upstreamApprovals: [{ stage: 'PRD', status: 'PASS' }, { stage: 'CODE_REVIEW', status: 'PENDING' }] },
  };
  assert.equal(canQuickApproveReview(blockedRelease, activeTask, tasks, { id: 'sre-1' }, 'SRE'), false);
  const readyRelease = {
    ...baseJob,
    stage: 'RELEASE',
    snapshot: { upstreamApprovals: [{ stage: 'PRD', status: 'PASS' }, { stage: 'TECH_SPEC', status: 'PASS' }, { stage: 'CODE_REVIEW', status: 'PASS' }, { stage: 'TEST_CASE', status: 'PASS' }] },
  };
  assert.equal(canQuickApproveReview(readyRelease, activeTask, tasks, { id: 'sre-1' }, 'SRE'), true);
});

test('main tasks own reviews and Jira subtasks only supply linked context', () => {
  const jiraMain = { ...node('VMS-748'), externalRef: { provider: 'jira', parentKey: 'VMS-747', issueType: { subtask: false } } };
  const jiraOrphan = { ...node('VMS-750'), externalRef: { provider: 'jira', parentKey: 'VMS-748', issueType: { subtask: true } } };
  const linkedChild = node('VMS-800', 'OPEN', 'VMS-748');

  assert.equal(requiresTaskReview(jiraMain, 'PRD'), true);
  assert.equal(requiresTaskReview(jiraMain, 'TASK_BREAKDOWN'), false);
  assert.equal(requiresTaskReview(node('local'), 'TASK_BREAKDOWN'), true);
  assert.equal(requiresTaskReview(linkedChild, 'PRD'), false);
  assert.equal(requiresTaskReview(jiraOrphan, 'PRD'), false);

  const reportJob = { stage: 'PRD', report: { actorId: 'author' }, findings: [] };
  const approver = { id: 'lead' };
  assert.equal(canQuickApproveReview(reportJob, jiraMain, [jiraMain], approver, 'LEAD'), true);
  assert.equal(canQuickApproveReview({ ...reportJob, reviewRequired: false }, jiraMain, [jiraMain], approver, 'LEAD'), false);
  assert.equal(canQuickApproveReview(reportJob, linkedChild, [jiraMain, linkedChild], approver, 'LEAD'), false);
});

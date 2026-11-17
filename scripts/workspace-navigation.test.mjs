import test from 'node:test';
import assert from 'node:assert/strict';
import { assetKindFromRoute, clearTaskRoute, currentWorkspaceSection, navigateWorkspace, openTaskRoute, reviewStageFromRoute, SECTION_LABELS, taskReturnFilters } from '../preview-app/src/views/workspaceNavigation.ts';

function environment(t, hash = '') {
  const previousLocation = globalThis.location; const previousWindow = globalThis.window;
  const previousHistory = globalThis.history; const previousHashEvent = globalThis.HashChangeEvent;
  const scrolls = [];
  let currentHash = hash;
  globalThis.location = { pathname: '/', search: '', get hash() { return currentHash; }, set hash(value) { currentHash = value && !value.startsWith('#') ? '#' + value : value; } };
  globalThis.window = { scrollTo: options => scrolls.push(options), dispatchEvent: () => true };
  globalThis.history = { state: null, replaceState: (_, __, url) => { location.hash = new URL(url, 'http://localhost').hash; } };
  globalThis.HashChangeEvent = class { constructor(type) { this.type = type; } };
  t.after(() => { globalThis.location = previousLocation; globalThis.window = previousWindow; globalThis.history = previousHistory; globalThis.HashChangeEvent = previousHashEvent; });
  return scrolls;
}

test('workspace modules have distinct routes and old task links still open task details', t => {
  environment(t);
  assert.equal(currentWorkspaceSection(), 'overview');
  for (const section of Object.keys(SECTION_LABELS)) {
    location.hash = '#view=' + section;
    assert.equal(currentWorkspaceSection(), section);
  }
  for (const invalid of ['__proto__', 'constructor', 'unknown']) {
    location.hash = '#view=' + invalid;
    assert.equal(currentWorkspaceSection(), 'overview');
  }
  location.hash = '#task=legacy-task';
  assert.equal(currentWorkspaceSection(), 'tasks');
});

test('invalid task links return to tasks and notify the shell of replaced routes', t => {
  environment(t, '#view=reviews&task=missing&job=old&tab=reviews&from=assets');
  const sections = [];
  window.dispatchEvent = event => { assert.equal(event.type, 'hashchange'); sections.push(currentWorkspaceSection()); return true; };
  assert.equal(currentWorkspaceSection(), 'tasks');
  clearTaskRoute();
  assert.equal(location.hash, '#view=tasks');
  assert.deepEqual(sections, ['tasks']);
  clearTaskRoute();
  assert.equal(sections.length, 1);
});

test('switching a module clears task, report, tab and return context', t => {
  const scrolls = environment(t, '#view=tasks&task=a&job=b&tab=reviews&from=assets');
  navigateWorkspace('reviews');
  assert.equal(location.hash, '#view=reviews');
  assert.equal(currentWorkspaceSection(), 'reviews');
  assert.deepEqual(scrolls, [{ top: 0, behavior: 'instant' }]);
});

test('center links retain the exact task, panel, report and return module', t => {
  environment(t, '#view=reviews');
  openTaskRoute('task-123', { tab: 'reviews', jobId: 'report-456', from: 'reviews' });
  const route = new URLSearchParams(location.hash.slice(1));
  assert.equal(currentWorkspaceSection(), 'tasks');
  assert.equal(route.get('task'), 'task-123');
  assert.equal(route.get('tab'), 'reviews');
  assert.equal(route.get('job'), 'report-456');
  assert.equal(route.get('from'), 'reviews');
  openTaskRoute('task-789', { tab: 'assets', from: 'assets' });
  const material = new URLSearchParams(location.hash.slice(1));
  assert.equal(material.get('task'), 'task-789');
  assert.equal(material.get('tab'), 'assets');
  assert.equal(material.get('from'), 'assets');
  assert.equal(material.has('job'), false);
});

test('workflow guide links open the exact stage or material filter and discard old task context', t => {
  environment(t, '#view=tasks&task=old&job=old-report&tab=reviews');
  navigateWorkspace('reviews', { stage: 'CODE_REVIEW' });
  assert.equal(location.hash, '#view=reviews&stage=CODE_REVIEW');
  assert.equal(reviewStageFromRoute(), 'CODE_REVIEW');
  assert.equal(assetKindFromRoute(), undefined);
  navigateWorkspace('assets', { kind: 'RELEASE_PLAN' });
  assert.equal(location.hash, '#view=assets&kind=RELEASE_PLAN');
  assert.equal(assetKindFromRoute(), 'RELEASE_PLAN');
  assert.equal(reviewStageFromRoute(), undefined);
  navigateWorkspace('reviews');
  assert.equal(location.hash, '#view=reviews');
  assert.equal(reviewStageFromRoute(), undefined);
});

test('workflow filters ignore unknown values and never leak into another module', t => {
  environment(t);
  for (const hash of ['#view=reviews&stage=__proto__', '#view=assets&kind=constructor', '#view=tasks&stage=PRD&kind=CODE']) {
    assert.equal(reviewStageFromRoute(hash), undefined);
    assert.equal(assetKindFromRoute(hash), undefined);
  }
  navigateWorkspace('local', { stage: 'PRD', kind: 'CODE' });
  assert.equal(location.hash, '#view=local');
  navigateWorkspace('reviews', { stage: 'unknown' });
  assert.equal(location.hash, '#view=reviews');
});

test('returning from a task or child task restores the originating workflow filter', t => {
  environment(t, '#view=reviews&stage=CODE_REVIEW');
  openTaskRoute('parent', { tab: 'reviews', from: 'reviews' });
  assert.deepEqual(taskReturnFilters(), { stage: 'CODE_REVIEW' });
  openTaskRoute('child', { tab: 'reviews', from: 'reviews' });
  assert.deepEqual(taskReturnFilters(), { stage: 'CODE_REVIEW' });
  navigateWorkspace('reviews', taskReturnFilters());
  assert.equal(location.hash, '#view=reviews&stage=CODE_REVIEW');
  navigateWorkspace('assets', { kind: 'TEST_CASE' });
  openTaskRoute('asset-task', { tab: 'assets', from: 'assets' });
  assert.deepEqual(taskReturnFilters(), { kind: 'TEST_CASE' });
  navigateWorkspace('assets', taskReturnFilters());
  assert.equal(location.hash, '#view=assets&kind=TEST_CASE');
});

test('invalid task routes clear workflow return metadata and reject mismatched filters', t => {
  environment(t, '#view=tasks&task=missing&from=reviews&fromStage=PRD&fromKind=CODE');
  assert.deepEqual(taskReturnFilters(), { stage: 'PRD' });
  assert.deepEqual(taskReturnFilters('#view=tasks&task=x&from=local&fromStage=PRD'), {});
  assert.deepEqual(taskReturnFilters('#view=tasks&task=x&from=reviews&fromStage=constructor'), {});
  clearTaskRoute();
  assert.equal(location.hash, '#view=tasks');
});

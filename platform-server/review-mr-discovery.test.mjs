import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { discoverReviewMrs } from './review-mr-discovery.mjs';

test('scans the bound Codeup repo for requirement and child Jira keys', async t => {
  const repoPath = mkdtempSync(join(tmpdir(), 'taskflow-review-mrs-'));
  t.after(() => rmSync(repoPath, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture');
  git('branch', 'feature/app/VMS-747');
  git('remote', 'add', 'origin', 'git@codeup.aliyun.com:org/team/merchant-front.git');

  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE tasks (id TEXT, project_id TEXT, jira_key TEXT, parent_id TEXT);
    INSERT INTO tasks VALUES ('root', 'vms', 'VMS-748', NULL),
      ('child', 'vms', 'VMS-750', 'root'), ('other', 'other-project', 'VMS-751', 'root');
  `);
  const task = {
    id: 'root', projectId: 'vms', jiraKey: 'VMS-748',
    externalRef: { description: '*需求来源*\n产品需求 VMS-747\n\n*影响范围*\n仓库：merchant-front' },
  };
  const user = { id: 'reviewer' };
  const row = { account: { id: 'personal' }, auth_mode: 'PRIVATE_TOKEN', base_url: 'https://openapi-rdc.aliyuncs.com', organization_id: 'org' };
  const requests = [];
  const entry = (localId, title, fields = {}) => ({ localId, projectId: 10001, title, state: 'MERGED', ...fields });
  const connectorsInternal = {
    selectedRow(actor, projectId, provider) {
      assert.deepEqual([actor, projectId, provider], [user, 'vms', 'yunxiao']);
      return row;
    },
    validateSelected(actor, selection) {
      assert.equal(actor, user);
      assert.equal(selection, row);
    },
    async remote(provider, selection, path) {
      assert.equal(provider, 'yunxiao');
      assert.equal(selection, row);
      requests.push(path);
      if (path.endsWith('/repositories/org%2Fteam%2Fmerchant-front')) return { data: { id: 10001 } };
      const page = new URL(path, row.base_url).searchParams.get('page');
      if (page === '1') return { nextPage: '2', data: [
        entry(21, 'Adyen account separation', { sourceBranch: 'feature/app/VMS-747' }),
        entry(22, 'VMS-748 wrong repository', { projectId: 10002 }),
        entry(23, 'VMS-751 different project'),
        entry(24, 'VMS-748 closed without merge', { state: 'CLOSED' }),
        entry(25, 'VMS-7480 different Jira key'),
      ] };
      return { data: [entry(26, 'VMS-750 follow-up', { state: 'UNDER_REVIEW' })] };
    },
  };

  const result = await discoverReviewMrs({ db, task, user, repoPath, connectorsInternal,
    projectRole: () => 'MEMBER', reauthorize: () => user });

  assert.deepEqual(requests, [
    '/oapi/v1/codeup/organizations/org/repositories/org%2Fteam%2Fmerchant-front',
    '/oapi/v1/codeup/organizations/org/changeRequests?page=1&perPage=50&projectIds=10001&orderBy=updated_at&sort=desc',
    '/oapi/v1/codeup/organizations/org/changeRequests?page=2&perPage=50&projectIds=10001&orderBy=updated_at&sort=desc',
  ]);
  assert.deepEqual(result, {
    candidates: [
      { url: 'https://codeup.aliyun.com/org/team/merchant-front/change/21', title: 'Adyen account separation', provider: 'yunxiao', taskKeys: ['VMS-747'], state: 'MERGED' },
      { url: 'https://codeup.aliyun.com/org/team/merchant-front/change/26', title: 'VMS-750 follow-up', provider: 'yunxiao', taskKeys: ['VMS-750'], state: 'UNDER_REVIEW' },
    ],
    branches: [{ name: 'feature/app/VMS-747', commit: git('rev-parse', 'HEAD'), taskKeys: ['VMS-747'] }],
    sources: ['local', 'yunxiao'],
    incomplete: false,
  });
});

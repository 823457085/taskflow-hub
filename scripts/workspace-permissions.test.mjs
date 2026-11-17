import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlatformPermissions, normalizeProjectPermissions, NO_PLATFORM_PERMISSIONS, NO_PROJECT_PERMISSIONS } from '../preview-app/src/views/workspacePermissions.ts';

test('missing or partial permission responses fail closed and always supply a role list', () => {
  for (const input of [undefined, null, {}, [], 'ADMIN', 1]) {
    assert.deepEqual(normalizePlatformPermissions(input), NO_PLATFORM_PERMISSIONS);
    assert.deepEqual(normalizeProjectPermissions(input), NO_PROJECT_PERMISSIONS);
  }
  assert.deepEqual(normalizeProjectPermissions({ assignTasks: true }), { ...NO_PROJECT_PERMISSIONS, assignTasks: true });
  assert.deepEqual(normalizeProjectPermissions({ grantRoles: null }).grantRoles, []);
});

test('truthy values cannot turn permission flags into grants', () => {
  const values = { manageMembers: 'true', assignTasks: 1, manageConnections: [], registerPlugins: {}, viewAudit: 'false', grantRoles: ['ADMIN', 'DEV', 'DEV', 'invalid', null, {}] };
  assert.deepEqual(normalizeProjectPermissions(values), { ...NO_PROJECT_PERMISSIONS, grantRoles: ['DEV'] });
  assert.deepEqual(normalizePlatformPermissions({ manageUsers: 'ADMIN', createProjects: 1, syncJiraProjects: [], reuseLocalCredentials: {} }), NO_PLATFORM_PERMISSIONS);
});

test('valid server grants are preserved without borrowing the response array', () => {
  const roles = ['DEV', 'QA', 'PM'];
  const input = { manageMembers: true, assignTasks: true, manageConnections: true, registerPlugins: true, viewAudit: true, grantRoles: roles };
  const result = normalizeProjectPermissions(input);
  assert.deepEqual(result, input);
  roles.push('SRE');
  assert.deepEqual(result.grantRoles, ['DEV', 'QA', 'PM']);
  assert.deepEqual(normalizeProjectPermissions({ grantRoles: ['LEAD', 'SRE'] }).grantRoles, ['LEAD', 'SRE']);
  assert.deepEqual(normalizePlatformPermissions({ manageUsers: true, createProjects: true, syncJiraProjects: true, reuseLocalCredentials: true }), { manageUsers: true, createProjects: true, syncJiraProjects: true, reuseLocalCredentials: true });
});

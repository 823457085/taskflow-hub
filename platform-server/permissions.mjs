import { PROJECT_ROLES, fail } from './common.mjs';

export function globalPermissions(user) {
  const admin = user.role === 'ADMIN' && !user.localDevice;
  return { manageUsers: admin, createProjects: admin, syncJiraProjects: admin, reuseLocalCredentials: admin };
}

export function projectPermissions(user, role) {
  const manage = !user.localDevice && ['ADMIN', 'LEAD'].includes(role);
  return {
    manageMembers: manage,
    assignTasks: !user.localDevice && ['ADMIN', 'LEAD', 'PM'].includes(role),
    manageConnections: manage,
    registerPlugins: manage,
    viewAudit: manage,
    grantRoles: manage ? role === 'ADMIN' ? [...PROJECT_ROLES] : ['DEV', 'QA', 'PM'] : [],
  };
}

export function canEditMemberRole(user, role, target, currentRole) {
  if (!projectPermissions(user, role).manageMembers) return false;
  if (role === 'ADMIN') return true;
  return target.id !== user.id && target.role !== 'ADMIN' && !['LEAD', 'SRE'].includes(currentRole);
}

export function assertMemberRoleChange(user, role, target, currentRole, nextRole) {
  const permissions = projectPermissions(user, role);
  if (!permissions.manageMembers) fail(403, 'FORBIDDEN', '当前角色无权管理项目成员');
  if (!PROJECT_ROLES.includes(nextRole)) fail(400, 'INVALID_ROLE', '项目角色不受支持');
  if (!permissions.grantRoles.includes(nextRole)) fail(403, 'ROLE_GRANT_FORBIDDEN', '当前角色无权授予此项目角色');
  if (!canEditMemberRole(user, role, target, currentRole)) fail(403, 'MEMBER_ROLE_PROTECTED', '当前角色无权修改此成员的项目角色');
}

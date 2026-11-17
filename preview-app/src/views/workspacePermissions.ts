export type Role = 'ADMIN' | 'DEV' | 'QA' | 'LEAD' | 'SRE' | 'PM';
export const ROLES: Role[] = ['ADMIN', 'DEV', 'QA', 'LEAD', 'SRE', 'PM'];
export const PROJECT_ROLES: Role[] = ['DEV', 'QA', 'LEAD', 'SRE', 'PM'];
export interface PlatformPermissions { manageUsers: boolean; createProjects: boolean; syncJiraProjects: boolean; reuseLocalCredentials: boolean }
export interface ProjectPermissions { manageMembers: boolean; assignTasks: boolean; manageConnections: boolean; registerPlugins: boolean; viewAudit: boolean; grantRoles: Role[] }
export const NO_PLATFORM_PERMISSIONS: PlatformPermissions = { manageUsers: false, createProjects: false, syncJiraProjects: false, reuseLocalCredentials: false };
export const NO_PROJECT_PERMISSIONS: ProjectPermissions = { manageMembers: false, assignTasks: false, manageConnections: false, registerPlugins: false, viewAudit: false, grantRoles: [] };
export function normalizePlatformPermissions(value: unknown): PlatformPermissions {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { manageUsers: input.manageUsers === true, createProjects: input.createProjects === true, syncJiraProjects: input.syncJiraProjects === true, reuseLocalCredentials: input.reuseLocalCredentials === true };
}
export function normalizeProjectPermissions(value: unknown): ProjectPermissions {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    manageMembers: input.manageMembers === true, assignTasks: input.assignTasks === true,
    manageConnections: input.manageConnections === true, registerPlugins: input.registerPlugins === true, viewAudit: input.viewAudit === true,
    grantRoles: Array.isArray(input.grantRoles) ? [...new Set(input.grantRoles.filter((role): role is Role => PROJECT_ROLES.includes(role)))] : [],
  };
}

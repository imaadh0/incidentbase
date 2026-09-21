export const organizationRoles = ['OWNER', 'ADMIN', 'RESPONDER', 'REPORTER'] as const;

export type OrganizationRole = (typeof organizationRoles)[number];

export const organizationPermissions = [
  'organization:read',
  'organization:update',
  'members:read',
  'members:invite',
  'members:manage',
  'policies:read',
  'policies:manage',
  'incidents:create',
  'incidents:read',
  'incidents:operate-assigned',
  'incidents:override',
  'incidents:reopen',
  'audit:read',
  'notifications:manage',
] as const;

export type OrganizationPermission = (typeof organizationPermissions)[number];

const memberPermissions = [
  'organization:read',
  'members:read',
  'policies:read',
  'incidents:create',
  'incidents:read',
] as const satisfies readonly OrganizationPermission[];

const permissionsByRole: Readonly<Record<OrganizationRole, ReadonlySet<OrganizationPermission>>> = {
  OWNER: new Set(organizationPermissions),
  ADMIN: new Set([
    ...memberPermissions,
    'organization:update',
    'members:invite',
    'members:manage',
    'policies:manage',
    'incidents:operate-assigned',
    'incidents:override',
    'incidents:reopen',
    'audit:read',
    'notifications:manage',
  ]),
  RESPONDER: new Set([...memberPermissions, 'incidents:operate-assigned']),
  REPORTER: new Set(memberPermissions),
};

export function hasPermission(role: OrganizationRole, permission: OrganizationPermission): boolean {
  return permissionsByRole[role].has(permission);
}

export function canManageMembership(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  if (!hasPermission(actorRole, 'members:manage')) {
    return false;
  }

  return actorRole === 'OWNER' || targetRole !== 'OWNER';
}

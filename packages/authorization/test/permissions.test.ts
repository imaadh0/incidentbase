import { describe, expect, it } from 'vitest';

import {
  canManageMembership,
  hasPermission,
  organizationPermissions,
  organizationRoles,
} from '../src/index.js';

describe('organization authorization matrix', () => {
  it.each(organizationRoles)('defines every permission for %s', (role) => {
    const results = Object.fromEntries(
      organizationPermissions.map((permission) => [permission, hasPermission(role, permission)]),
    );

    expect(Object.keys(results)).toHaveLength(organizationPermissions.length);
  });

  it('allows only owners and admins to manage ordinary members', () => {
    expect(canManageMembership('OWNER', 'RESPONDER')).toBe(true);
    expect(canManageMembership('ADMIN', 'RESPONDER')).toBe(true);
    expect(canManageMembership('RESPONDER', 'REPORTER')).toBe(false);
    expect(canManageMembership('REPORTER', 'REPORTER')).toBe(false);
  });

  it('allows only an owner to manage another owner', () => {
    expect(canManageMembership('OWNER', 'OWNER')).toBe(true);
    expect(canManageMembership('ADMIN', 'OWNER')).toBe(false);
  });

  it('keeps reporter and responder operational permissions distinct', () => {
    expect(hasPermission('REPORTER', 'incidents:operate-assigned')).toBe(false);
    expect(hasPermission('RESPONDER', 'incidents:operate-assigned')).toBe(true);
    expect(hasPermission('RESPONDER', 'incidents:override')).toBe(false);
  });
});

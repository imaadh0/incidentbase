import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  MembershipStatus,
  OrganizationRole,
  TenantAccessDeniedError,
  TenantUnitOfWork,
} from '../src/index.js';
import { resetTestDatabase } from './reset-test-database.js';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase.sequential('tenant database boundary', () => {
  if (testDatabaseUrl === undefined) {
    return;
  }

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const unitOfWork = new TenantUnitOfWork(database);

  const ids = {
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    organizationWithoutOwner: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    suspended: randomUUID(),
    replacementOwner: randomUUID(),
    membershipA: randomUUID(),
    membershipB: randomUUID(),
    suspendedMembership: randomUUID(),
    invitationB: randomUUID(),
    refreshSessionB: randomUUID(),
  };

  beforeAll(async () => {
    await resetTestDatabase(database);

    await database.user.createMany({
      data: [
        { id: ids.ownerA, email: 'owner-a@example.test', displayName: 'Owner A' },
        { id: ids.ownerB, email: 'owner-b@example.test', displayName: 'Owner B' },
        {
          id: ids.suspended,
          email: 'suspended@example.test',
          displayName: 'Suspended User',
        },
        {
          id: ids.replacementOwner,
          email: 'replacement@example.test',
          displayName: 'Replacement Owner',
        },
      ],
    });

    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationA, slug: 'organization-a', name: 'Organization A' },
      });
      await transaction.organizationMembership.createMany({
        data: [
          {
            id: ids.membershipA,
            organizationId: ids.organizationA,
            userId: ids.ownerA,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
          },
          {
            id: ids.suspendedMembership,
            organizationId: ids.organizationA,
            userId: ids.suspended,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.SUSPENDED,
          },
        ],
      });
    });

    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationB, slug: 'organization-b', name: 'Organization B' },
      });
      await transaction.organizationMembership.create({
        data: {
          id: ids.membershipB,
          organizationId: ids.organizationB,
          userId: ids.ownerB,
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
        },
      });
      await transaction.organizationInvitation.create({
        data: {
          id: ids.invitationB,
          organizationId: ids.organizationB,
          email: 'invitee@example.test',
          role: OrganizationRole.REPORTER,
          tokenHash: `invitation-${ids.invitationB}`,
          invitedByUserId: ids.ownerB,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await transaction.refreshSession.create({
        data: {
          id: ids.refreshSessionB,
          organizationId: ids.organizationB,
          userId: ids.ownerB,
          tokenHash: `session-${ids.refreshSessionB}`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('hides every other tenant resource from direct ID guesses', async () => {
    const result = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      async (tenant) => ({
        organization: await tenant.organizations.findById(ids.organizationB),
        membership: await tenant.memberships.findById(ids.membershipB),
        invitation: await tenant.invitations.findById(ids.invitationB),
        refreshSession: await tenant.refreshSessions.findById(ids.refreshSessionB),
      }),
    );

    expect(result).toEqual({
      organization: null,
      membership: null,
      invitation: null,
      refreshSession: null,
    });
  });

  it('rejects a valid user selecting an organization where they are not a member', async () => {
    await expect(
      unitOfWork.withTenant(
        { organizationId: ids.organizationB, userId: ids.ownerA },
        async (tenant) => tenant.memberships.list(),
      ),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
  });

  it('rejects suspended membership contexts before repository work runs', async () => {
    let operationRan = false;

    await expect(
      unitOfWork.withTenant({ organizationId: ids.organizationA, userId: ids.suspended }, () => {
        operationRan = true;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);

    expect(operationRan).toBe(false);
  });

  it('blocks cross-tenant relationships with composite foreign keys', async () => {
    await expect(
      unitOfWork.withTenant(
        { organizationId: ids.organizationA, userId: ids.ownerA },
        async ({ transaction }) =>
          transaction.organizationInvitation.create({
            data: {
              organizationId: ids.organizationA,
              email: 'cross-tenant@example.test',
              role: OrganizationRole.REPORTER,
              tokenHash: `cross-tenant-${randomUUID()}`,
              invitedByUserId: ids.ownerB,
              expiresAt: new Date(Date.now() + 60_000),
            },
          }),
      ),
    ).rejects.toThrow();
  });

  it('prevents a committed state without an active owner', async () => {
    await expect(
      database.organizationMembership.update({
        where: {
          organizationId_userId: {
            organizationId: ids.organizationA,
            userId: ids.ownerA,
          },
        },
        data: { role: OrganizationRole.ADMIN },
      }),
    ).rejects.toThrow(/must retain at least one active owner/u);

    await expect(
      database.organization.create({
        data: {
          id: ids.organizationWithoutOwner,
          slug: 'organization-without-owner',
          name: 'Organization Without Owner',
        },
      }),
    ).rejects.toThrow(/must retain at least one active owner/u);
  });

  it('allows an atomic owner transfer', async () => {
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.organizationMembership.create({
          data: {
            organizationId: ids.organizationA,
            userId: ids.replacementOwner,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
          },
        });
        await transaction.organizationMembership.update({
          where: {
            organizationId_userId: {
              organizationId: ids.organizationA,
              userId: ids.ownerA,
            },
          },
          data: { role: OrganizationRole.ADMIN },
        });
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps the runtime role unprivileged and separate from table ownership', async () => {
    const roles = await database.$queryRaw<
      Array<{ rolbypassrls: boolean; rolcanlogin: boolean; rolname: string; rolsuper: boolean }>
    >`
      SELECT rolname, rolsuper, rolcanlogin, rolbypassrls
      FROM pg_roles
      WHERE rolname = 'incidentbase_runtime'
    `;
    const runtimeOwnedTables = await database.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM pg_class
      WHERE relkind = 'r'
        AND relowner = 'incidentbase_runtime'::regrole
    `;

    expect(roles).toEqual([
      {
        rolname: 'incidentbase_runtime',
        rolsuper: false,
        rolcanlogin: false,
        rolbypassrls: false,
      },
    ]);
    expect(runtimeOwnedTables[0]?.count).toBe(0n);
  });
});

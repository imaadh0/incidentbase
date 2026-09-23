import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuthenticationRepository,
  createDatabaseClient,
  MembershipStatus,
  OrganizationRole,
} from '../src/index.js';
import { resetTestDatabase } from './reset-test-database.js';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase.sequential('authentication database boundary', () => {
  if (testDatabaseUrl === undefined) {
    return;
  }

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const authentication = new AuthenticationRepository(database);
  const ids = {
    family: randomUUID(),
    invitedUser: randomUUID(),
    membership: randomUUID(),
    organization: randomUUID(),
    owner: randomUUID(),
    refresh: randomUUID(),
    replacementRefresh: randomUUID(),
  };

  beforeAll(async () => {
    await resetTestDatabase(database);

    await authentication.registerOwner({
      displayName: 'Auth Owner',
      email: 'auth-owner@example.test',
      membershipId: ids.membership,
      organizationId: ids.organization,
      organizationName: 'Auth Organization',
      organizationSlug: 'auth-organization',
      passwordHash: 'argon2-test-hash',
      userId: ids.owner,
    });
  });

  afterAll(async () => {
    await database.$disconnect();
  });

  it('registers an organization and active owner atomically', async () => {
    await expect(authentication.findLoginIdentity(' AUTH-OWNER@example.test ')).resolves.toEqual({
      displayName: 'Auth Owner',
      email: 'auth-owner@example.test',
      id: ids.owner,
      passwordHash: 'argon2-test-hash',
    });

    await expect(authentication.listMemberships(ids.owner)).resolves.toEqual([
      {
        membershipId: ids.membership,
        organizationId: ids.organization,
        organizationName: 'Auth Organization',
        organizationSlug: 'auth-organization',
        role: OrganizationRole.OWNER,
        status: MembershipStatus.ACTIVE,
      },
    ]);
  });

  it('rotates refresh tokens and revokes the entire family on reuse', async () => {
    await authentication.createRefreshSession({
      expiresAt: new Date(Date.now() + 60_000),
      familyId: ids.family,
      organizationId: ids.organization,
      sessionId: ids.refresh,
      tokenHash: 'initial-refresh-token-hash',
      userId: ids.owner,
    });

    await expect(
      authentication.rotateRefreshSession({
        currentTokenHash: 'initial-refresh-token-hash',
        expiresAt: new Date(Date.now() + 120_000),
        newSessionId: ids.replacementRefresh,
        newTokenHash: 'replacement-refresh-token-hash',
      }),
    ).resolves.toMatchObject({ outcome: 'ROTATED', userId: ids.owner });

    await expect(
      authentication.rotateRefreshSession({
        currentTokenHash: 'initial-refresh-token-hash',
        expiresAt: new Date(Date.now() + 120_000),
        newSessionId: randomUUID(),
        newTokenHash: 'attacker-refresh-token-hash',
      }),
    ).resolves.toMatchObject({ outcome: 'REUSED', userId: ids.owner });

    const family = await database.refreshSession.findMany({
      where: { familyId: ids.family },
      orderBy: { createdAt: 'asc' },
    });
    expect(family).toHaveLength(2);
    expect(family.every((session) => session.revokedAt !== null)).toBe(true);
    expect(family.every((session) => session.revokedReason === 'REUSE_DETECTED')).toBe(true);
  });

  it('accepts only a current invitation for the matching normalized email', async () => {
    await database.user.create({
      data: {
        displayName: 'Invited User',
        email: 'invited@example.test',
        id: ids.invitedUser,
        passwordHash: 'argon2-test-hash',
      },
    });
    await database.organizationInvitation.createMany({
      data: [
        {
          email: 'invited@example.test',
          expiresAt: new Date(Date.now() + 60_000),
          invitedByUserId: ids.owner,
          organizationId: ids.organization,
          role: OrganizationRole.RESPONDER,
          tokenHash: 'valid-invitation-hash',
        },
        {
          email: 'invited@example.test',
          expiresAt: new Date(Date.now() - 60_000),
          invitedByUserId: ids.owner,
          organizationId: ids.organization,
          role: OrganizationRole.REPORTER,
          tokenHash: 'expired-invitation-hash',
        },
      ],
    });

    await expect(
      authentication.acceptInvitation('valid-invitation-hash', ids.invitedUser, randomUUID()),
    ).resolves.toEqual({ outcome: 'ACCEPTED', organizationId: ids.organization });
    await expect(
      authentication.acceptInvitation('expired-invitation-hash', ids.invitedUser, randomUUID()),
    ).resolves.toEqual({ outcome: 'EXPIRED', organizationId: ids.organization });

    const membership = await database.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: ids.organization,
          userId: ids.invitedUser,
        },
      },
    });
    expect(membership).toMatchObject({
      role: OrganizationRole.RESPONDER,
      status: MembershipStatus.ACTIVE,
    });
  });
});

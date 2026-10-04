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

  it('consumes a reset once and invalidates the old password and sessions atomically', async () => {
    await authentication.markEmailVerified(ids.owner);
    await authentication.createRefreshSession({
      expiresAt: new Date(Date.now() + 60_000),
      familyId: randomUUID(),
      organizationId: ids.organization,
      sessionId: randomUUID(),
      tokenHash: 'reset-test-refresh',
      userId: ids.owner,
    });
    await expect(
      authentication.preparePasswordReset(
        'missing@example.test',
        'unknown-reset',
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBe(false);
    await expect(
      authentication.preparePasswordReset(
        'auth-owner@example.test',
        'superseded-reset',
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBe(true);
    await authentication.preparePasswordReset(
      'auth-owner@example.test',
      'current-reset',
      new Date(Date.now() + 60_000),
    );
    await expect(
      authentication.consumePasswordReset('superseded-reset', 'new-hash'),
    ).resolves.toBeNull();
    const results = await Promise.all([
      authentication.consumePasswordReset('current-reset', 'new-hash'),
      authentication.consumePasswordReset('current-reset', 'another-hash'),
    ]);
    expect(results.filter((value) => value === ids.owner)).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    await expect(authentication.authVersion(ids.owner)).resolves.toBe(1);
    await expect(
      authentication.findLoginIdentity('auth-owner@example.test'),
    ).resolves.toMatchObject({ passwordHash: 'new-hash' });
    await expect(
      authentication.rotateRefreshSession({
        currentTokenHash: 'reset-test-refresh',
        expiresAt: new Date(Date.now() + 60_000),
        newSessionId: randomUUID(),
        newTokenHash: 'reset-test-replacement',
      }),
    ).resolves.toMatchObject({ outcome: 'REUSED' });
    await expect(
      authentication.preparePasswordReset(
        'auth-owner@example.test',
        'expired-reset',
        new Date(Date.now() - 1000),
      ),
    ).resolves.toBe(true);
    await expect(
      authentication.consumePasswordReset('expired-reset', 'never-used'),
    ).resolves.toBeNull();
  });

  it('allows an existing account without an email verification timestamp to reset', async () => {
    const userId = randomUUID();
    await database.user.create({
      data: {
        id: userId,
        displayName: 'Legacy User',
        email: 'legacy-user@example.test',
        passwordHash: 'old-hash',
      },
    });
    await expect(
      authentication.preparePasswordReset(
        ' LEGACY-USER@example.test ',
        'legacy-reset',
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBe(true);
    await expect(authentication.consumePasswordReset('legacy-reset', 'new-hash')).resolves.toBe(
      userId,
    );
    const resetUser = await database.user.findUniqueOrThrow({ where: { id: userId } });
    expect(resetUser.passwordHash).toBe('new-hash');
    expect(resetUser.emailVerifiedAt).toBeInstanceOf(Date);
  });
});

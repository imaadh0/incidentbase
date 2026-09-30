import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Redis } from 'ioredis';

import { AccessTokenService, hashOpaqueToken, hashPassword } from '@incidentbase/auth';
import { apiEnvironmentSchema, parseEnvironment } from '@incidentbase/config';
import {
  AuthenticationRepository,
  createDatabaseClient,
  MembershipStatus,
  OrganizationRole,
  TenantUnitOfWork,
} from '@incidentbase/database';
import { createLogger, createServiceMetrics } from '@incidentbase/observability';

import { AuthenticationService } from '../src/auth/authentication-service.js';
import { PendingRegistrationStore } from '../src/auth/pending-registration.js';
import type { EmailSender } from '../src/email/sender.js';
import { authenticateRequest } from '../src/auth/request-authentication.js';
import { createApp } from '../src/create-app.js';
import { resetTestDatabase } from './reset-test-database.js';

const testDatabaseUrl = process.env.API_TEST_DATABASE_URL;
const runtimeTestDatabaseUrl = process.env.API_TEST_RUNTIME_DATABASE_URL;
if (testDatabaseUrl !== undefined && runtimeTestDatabaseUrl === undefined) {
  throw new Error('API_TEST_RUNTIME_DATABASE_URL is required when API_TEST_DATABASE_URL is set.');
}
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;
const accountResponseSchema = z.object({
  data: z.object({
    memberships: z.array(
      z.object({
        organizationId: z.uuid(),
        role: z.enum(['OWNER', 'ADMIN', 'RESPONDER', 'REPORTER']),
        status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']),
      }),
    ),
    user: z.object({ email: z.string(), id: z.uuid() }),
  }),
});
const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

function cookieValue(setCookies: string[], name: string): string {
  const cookie = setCookies.find((candidate) => candidate.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`Missing ${name} cookie.`);
  return cookie.split(';', 1)[0] ?? '';
}

function responseCookies(response: request.Response): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

describeWithDatabase.sequential('authentication and membership API', () => {
  if (testDatabaseUrl === undefined) return;

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const runtimeDatabase = createDatabaseClient({ connectionString: runtimeTestDatabaseUrl! });
  const repository = new AuthenticationRepository(runtimeDatabase);
  const redis = new Redis(process.env.API_TEST_REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
  });
  const emails: Array<{ to: string; text: string }> = [];
  let failEmail = false;
  const emailSender: EmailSender = {
    send(to, content) {
      if (failEmail) return Promise.reject(new Error('Provider unavailable'));
      emails.push({ to, text: content.text });
      return Promise.resolve();
    },
  };
  const accessTokens = new AccessTokenService({
    audience: 'incidentbase-api',
    issuer: 'incidentbase',
    secret: 'api-test-secret-that-is-at-least-32-characters',
  });
  const service = new AuthenticationService({
    accessTokens,
    refreshTokenTtlSeconds: 3600,
    repository,
    pendingRegistrations: new PendingRegistrationStore(
      redis,
      'api-test-secret-that-is-at-least-32-characters',
    ),
    emailSender,
  });
  const environment = parseEnvironment('api', apiEnvironmentSchema, {
    ACCESS_TOKEN_TTL_SECONDS: '900',
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    COOKIE_SECURE: 'false',
    DATABASE_URL: testDatabaseUrl,
    JWT_SECRET: 'api-test-secret-that-is-at-least-32-characters',
    LOG_LEVEL: 'fatal',
    METRICS_TOKEN: 'a-secure-test-token-with-32-characters',
    NODE_ENV: 'test',
    OTEL_ENABLED: 'false',
    REDIS_URL: 'redis://localhost:6379',
    REFRESH_TOKEN_TTL_SECONDS: '3600',
    WEB_ORIGIN: 'http://localhost:3000',
  });
  const app = createApp({
    authentication: { accessTokens, service },
    emailSender,
    environment,
    logger: createLogger({ level: 'fatal', service: 'api-auth-test' }),
    metrics: createServiceMetrics('api-auth-test'),
    tenantBoundary: {
      resolvePrincipal: (incomingRequest) => authenticateRequest(incomingRequest, accessTokens),
      unitOfWork: new TenantUnitOfWork(runtimeDatabase),
    },
  });
  let registeredCookies: string[] = [];
  let registeredUserId = '';

  beforeAll(async () => {
    await redis.connect();
    await resetTestDatabase(database);
  });

  afterAll(async () => {
    redis.disconnect();
    await runtimeDatabase.$disconnect();
    await database.$disconnect();
  });

  it('registers an owner and stores an Argon2id password hash', async () => {
    const started = await request(app).post('/auth/register').send({
      displayName: 'Registered Owner',
      email: ' REGISTERED@example.test ',
      organizationName: 'Registered Organization',
      organizationSlug: 'registered-organization',
      password: 'correct horse battery staple',
    });
    expect(started.status, started.text).toBe(202);
    expect(responseCookies(started)).toHaveLength(0);
    const pendingId = z
      .object({ data: z.object({ pendingId: z.uuid() }) })
      .parse(started.body as unknown).data.pendingId;
    const code = /code is (\d{6})/u.exec(emails.at(-1)?.text ?? '')?.[1];
    expect(code).toBeDefined();
    const response = await request(app)
      .post('/auth/verify-email')
      .send({ pendingId, code })
      .expect(200);

    registeredCookies = responseCookies(response);
    const body = accountResponseSchema.parse(response.body as unknown);
    registeredUserId = body.data.user.id;
    expect(registeredCookies.some((cookie) => cookie.startsWith('incidentbase_access='))).toBe(
      true,
    );
    expect(registeredCookies.some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    expect(body.data.memberships[0]).toMatchObject({
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
    });

    const user = await database.user.findUniqueOrThrow({ where: { id: registeredUserId } });
    expect(user.email).toBe('registered@example.test');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('uses one generic failure for unknown emails and wrong passwords', async () => {
    const unknown = await request(app)
      .post('/auth/login')
      .send({ email: 'unknown@example.test', password: 'wrong password' })
      .expect(401);
    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ email: 'registered@example.test', password: 'wrong password' })
      .expect(401);

    expect(errorResponseSchema.parse(unknown.body as unknown).error.message).toBe(
      errorResponseSchema.parse(wrongPassword.body as unknown).error.message,
    );
  });

  it('returns the current user and memberships from the access cookie', async () => {
    const accessCookie = cookieValue(registeredCookies, 'incidentbase_access');
    const response = await request(app).get('/auth/me').set('Cookie', accessCookie).expect(200);

    const body = accountResponseSchema.parse(response.body as unknown);
    expect(body.data.user).toMatchObject({
      email: 'registered@example.test',
      id: registeredUserId,
    });
    expect(body.data.memberships).toHaveLength(1);
  });

  it('returns a stable conflict for duplicate registration', async () => {
    const response = await request(app)
      .post('/auth/register')
      .send({
        displayName: 'Duplicate Owner',
        email: 'registered@example.test',
        organizationName: 'Duplicate Organization',
        organizationSlug: 'duplicate-organization',
        password: 'another correct horse password',
      })
      .expect(409);

    expect(errorResponseSchema.parse(response.body as unknown).error.code).toBe(
      'INVITATION_EMAIL_EXISTS',
    );
  });

  it('requires a valid, single-use verification code', async () => {
    const started = await request(app)
      .post('/auth/register')
      .send({
        displayName: 'Code Test',
        email: 'code-test@example.test',
        organizationName: 'Code Test Team',
        organizationSlug: 'code-test-team',
        password: 'safe-password',
      })
      .expect(202);
    const pendingId = z
      .object({ data: z.object({ pendingId: z.uuid() }) })
      .parse(started.body as unknown).data.pendingId;
    const code = /code is (\d{6})/u.exec(emails.at(-1)?.text ?? '')?.[1];
    await request(app)
      .post('/auth/verify-email')
      .send({ pendingId, code: '999999' === code ? '000000' : '999999' })
      .expect(400);
    await request(app).post('/auth/verify-email').send({ pendingId, code }).expect(200);
    await request(app).post('/auth/verify-email').send({ pendingId, code }).expect(410);
  });

  it('expires codes and limits incorrect attempts and resends', async () => {
    async function start(email: string, slug: string) {
      const response = await request(app)
        .post('/auth/register')
        .send({
          displayName: 'Verification Test',
          email,
          organizationName: 'Verification Test',
          organizationSlug: slug,
          password: 'safe-password',
        })
        .expect(202);
      return z.object({ data: z.object({ pendingId: z.uuid() }) }).parse(response.body as unknown)
        .data.pendingId;
    }
    const first = await start('expired-code@example.test', 'expired-code');
    await request(app).post('/auth/resend-verification').send({ pendingId: first }).expect(429);
    await redis.del(`auth:pending:${first}`);
    await request(app)
      .post('/auth/verify-email')
      .send({ pendingId: first, code: '123456' })
      .expect(410);
    const second = await start('attempts@example.test', 'attempts-test');
    const validCode = /code is (\d{6})/u.exec(emails.at(-1)?.text ?? '')?.[1];
    const invalidCode = validCode === '123456' ? '654321' : '123456';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request(app)
        .post('/auth/verify-email')
        .send({ pendingId: second, code: invalidCode })
        .expect(400);
    }
    await request(app)
      .post('/auth/verify-email')
      .send({ pendingId: second, code: invalidCode })
      .expect(410);
    await request(app)
      .post('/auth/verify-email')
      .send({ pendingId: second, code: validCode })
      .expect(410);
  });

  it('creates a 24-hour invitation and emails the same copyable link', async () => {
    const membership = await database.organizationMembership.findFirstOrThrow({
      where: { userId: registeredUserId },
    });
    const csrfCookie = cookieValue(registeredCookies, 'incidentbase_csrf');
    const csrfToken = csrfCookie.slice(csrfCookie.indexOf('=') + 1);
    const response = await request(app)
      .post(`/organizations/${membership.organizationId}/invitations`)
      .set('Cookie', [cookieValue(registeredCookies, 'incidentbase_access'), csrfCookie])
      .set('x-csrf-token', csrfToken)
      .send({ email: 'emailed@example.test', role: 'RESPONDER', delivery: 'EMAIL' })
      .expect(201);
    const invitation = z
      .object({
        data: z.object({
          token: z.string(),
          delivery: z.literal('SENT'),
          expiresAt: z.iso.datetime(),
        }),
      })
      .parse(response.body as unknown).data;
    expect(new Date(invitation.expiresAt).getTime() - Date.now()).toBeGreaterThan(
      23 * 60 * 60 * 1000,
    );
    expect(new Date(invitation.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    expect(emails.at(-1)?.text).toContain(`/sign-in?invitation=${invitation.token}`);
    expect(emails.at(-1)?.text).toContain('24 hours');
  });

  it('keeps a copyable invitation when email delivery fails', async () => {
    const membership = await database.organizationMembership.findFirstOrThrow({
      where: { userId: registeredUserId },
    });
    const csrfCookie = cookieValue(registeredCookies, 'incidentbase_csrf');
    const csrfToken = csrfCookie.slice(csrfCookie.indexOf('=') + 1);
    failEmail = true;
    try {
      const response = await request(app)
        .post(`/organizations/${membership.organizationId}/invitations`)
        .set('Cookie', [cookieValue(registeredCookies, 'incidentbase_access'), csrfCookie])
        .set('x-csrf-token', csrfToken)
        .send({ email: 'fallback@example.test', role: 'REPORTER', delivery: 'EMAIL' })
        .expect(201);
      const result = z
        .object({ data: z.object({ token: z.string(), delivery: z.literal('FAILED') }) })
        .parse(response.body as unknown).data;
      await request(app).get(`/invitations/${result.token}`).expect(200);
    } finally {
      failEmail = false;
    }
  });

  it('requires CSRF for cookie-authenticated mutations', async () => {
    await request(app)
      .post('/auth/logout')
      .set(
        'Cookie',
        registeredCookies.map((cookie) => cookie.split(';', 1)[0] ?? ''),
      )
      .expect(403);
  });

  it('rotates refresh tokens and detects reuse of the previous token', async () => {
    const csrfCookie = cookieValue(registeredCookies, 'incidentbase_csrf');
    const csrfToken = csrfCookie.slice(csrfCookie.indexOf('=') + 1);
    const originalRefresh = cookieValue(registeredCookies, 'incidentbase_refresh');
    const refreshCookies = [originalRefresh, csrfCookie];

    const refreshed = await request(app)
      .post('/auth/refresh')
      .set('Cookie', refreshCookies)
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(cookieValue(responseCookies(refreshed), 'incidentbase_refresh')).not.toBe(
      originalRefresh,
    );

    await request(app)
      .post('/auth/refresh')
      .set('Cookie', refreshCookies)
      .set('x-csrf-token', csrfToken)
      .expect(401);

    const sessions = await database.refreshSession.findMany({
      where: { userId: registeredUserId },
    });
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    expect(sessions.every((session) => session.revokedReason === 'REUSE_DETECTED')).toBe(true);
  });

  it('accepts a matching invitation and rejects an expired invitation', async () => {
    const secondOwner = randomUUID();
    const secondOrganization = randomUUID();
    await repository.registerOwner({
      displayName: 'Second Owner',
      email: 'second-owner@example.test',
      membershipId: randomUUID(),
      organizationId: secondOrganization,
      organizationName: 'Second Organization',
      organizationSlug: 'second-organization',
      passwordHash: 'not-used-in-this-test',
      userId: secondOwner,
    });
    const validToken = 'v'.repeat(43);
    const expiredToken = 'e'.repeat(43);
    await database.organizationInvitation.createMany({
      data: [
        {
          email: 'registered@example.test',
          expiresAt: new Date(Date.now() + 60_000),
          invitedByUserId: secondOwner,
          organizationId: secondOrganization,
          role: OrganizationRole.RESPONDER,
          tokenHash: hashOpaqueToken(validToken),
        },
        {
          email: 'registered@example.test',
          expiresAt: new Date(Date.now() - 60_000),
          invitedByUserId: secondOwner,
          organizationId: secondOrganization,
          role: OrganizationRole.REPORTER,
          tokenHash: hashOpaqueToken(expiredToken),
        },
      ],
    });

    const accessCookie = cookieValue(registeredCookies, 'incidentbase_access');
    const csrfCookie = cookieValue(registeredCookies, 'incidentbase_csrf');
    const csrfToken = csrfCookie.slice(csrfCookie.indexOf('=') + 1);
    const preview = await request(app).get(`/invitations/${validToken}`).expect(200);
    expect(preview.body).toMatchObject({
      data: {
        email: 'registered@example.test',
        hasAccount: true,
        organizationName: 'Second Organization',
        outcome: 'AVAILABLE',
        role: OrganizationRole.RESPONDER,
      },
    });
    expect((await request(app).get(`/invitations/${expiredToken}`).expect(200)).body).toMatchObject(
      {
        data: { outcome: 'EXPIRED' },
      },
    );
    const wrongUser = randomUUID();
    await database.user.create({
      data: {
        displayName: 'Wrong Invitee',
        email: 'wrong-invitee@example.test',
        id: wrongUser,
      },
    });
    const wrongToken = await accessTokens.issue(wrongUser);
    const wrongEmail = await request(app)
      .post(`/invitations/${validToken}/accept`)
      .set('authorization', `Bearer ${wrongToken}`)
      .set('Cookie', csrfCookie)
      .set('x-csrf-token', csrfToken)
      .expect(403);
    expect(errorResponseSchema.parse(wrongEmail.body as unknown).error.code).toBe(
      'INVITATION_EMAIL_MISMATCH',
    );

    const accepted = await request(app)
      .post(`/invitations/${validToken}/accept`)
      .set('Cookie', [accessCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(200);
    expect(accountResponseSchema.parse(accepted.body as unknown).data.memberships).toContainEqual(
      expect.objectContaining({
        role: OrganizationRole.RESPONDER,
        status: MembershipStatus.ACTIVE,
      }),
    );
    const used = await request(app)
      .post(`/invitations/${validToken}/accept`)
      .set('Cookie', [accessCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(410);
    expect(errorResponseSchema.parse(used.body as unknown).error.code).toBe('INVITATION_USED');
    expect((await request(app).get(`/invitations/${validToken}`).expect(200)).body).toMatchObject({
      data: { outcome: 'USED' },
    });
    const expired = await request(app)
      .post(`/invitations/${expiredToken}/accept`)
      .set('Cookie', [accessCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(410);
    expect(errorResponseSchema.parse(expired.body as unknown).error.code).toBe(
      'INVITATION_EXPIRED',
    );

    const membership = await database.organizationMembership.findUnique({
      where: {
        organizationId_userId: { organizationId: secondOrganization, userId: registeredUserId },
      },
    });
    expect(membership).toMatchObject({
      role: OrganizationRole.RESPONDER,
      status: MembershipStatus.ACTIVE,
    });
  });

  it('creates an invited account directly in the inviting organization and consumes its token', async () => {
    const owner = randomUUID();
    const organizationId = randomUUID();
    await repository.registerOwner({
      displayName: 'Invitation Owner',
      email: 'invitation-owner@example.test',
      membershipId: randomUUID(),
      organizationId,
      organizationName: 'Inviting Team',
      organizationSlug: 'inviting-team',
      passwordHash: 'not-used-in-this-test',
      userId: owner,
    });
    const token = 'n'.repeat(43);
    await database.organizationInvitation.create({
      data: {
        email: 'new-invitee@example.test',
        expiresAt: new Date(Date.now() + 60_000),
        invitedByUserId: owner,
        organizationId,
        role: OrganizationRole.REPORTER,
        tokenHash: hashOpaqueToken(token),
      },
    });
    const organizationCountBefore = await database.organization.count();
    expect((await request(app).get(`/invitations/${token}`).expect(200)).body).toMatchObject({
      data: { email: 'new-invitee@example.test', hasAccount: false, outcome: 'AVAILABLE' },
    });
    const wrong = await request(app)
      .post(`/invitations/${token}/register`)
      .send({
        displayName: 'Wrong Email',
        email: 'other@example.test',
        password: 'safe-password',
      })
      .expect(403);
    expect(errorResponseSchema.parse(wrong.body as unknown).error.code).toBe(
      'INVITATION_EMAIL_MISMATCH',
    );
    const started = await request(app)
      .post(`/invitations/${token}/register`)
      .send({
        displayName: 'New Invitee',
        email: 'new-invitee@example.test',
        password: 'safe-password',
      })
      .expect(202);
    const pendingId = z
      .object({ data: z.object({ pendingId: z.uuid() }) })
      .parse(started.body as unknown).data.pendingId;
    const code = /code is (\d{6})/u.exec(emails.at(-1)?.text ?? '')?.[1];
    const accepted = await request(app)
      .post('/auth/verify-email')
      .send({ pendingId, code })
      .expect(200);
    const body = accountResponseSchema.parse(accepted.body as unknown);
    expect(body.data.memberships).toEqual([
      expect.objectContaining({
        organizationId,
        role: OrganizationRole.REPORTER,
        status: MembershipStatus.ACTIVE,
      }),
    ]);
    expect(await database.organization.count()).toBe(organizationCountBefore);
    const reused = await request(app)
      .post(`/invitations/${token}/register`)
      .send({
        displayName: 'Another Invitee',
        email: 'new-invitee@example.test',
        password: 'safe-password',
      })
      .expect(410);
    expect(errorResponseSchema.parse(reused.body as unknown).error.code).toBe('INVITATION_USED');
  });

  it('signs in an existing account with no membership through its invitation', async () => {
    const owner = randomUUID();
    const organizationId = randomUUID();
    const userId = randomUUID();
    await repository.registerOwner({
      displayName: 'Existing Invite Owner',
      email: 'existing-invite-owner@example.test',
      membershipId: randomUUID(),
      organizationId,
      organizationName: 'Existing Invite Team',
      organizationSlug: 'existing-invite-team',
      passwordHash: 'not-used-in-this-test',
      userId: owner,
    });
    await database.user.create({
      data: {
        id: userId,
        displayName: 'Existing Invitee',
        email: 'existing-invitee@example.test',
        passwordHash: await hashPassword('safe-password'),
      },
    });
    const token = 's'.repeat(43);
    await database.organizationInvitation.create({
      data: {
        email: 'existing-invitee@example.test',
        expiresAt: new Date(Date.now() + 60_000),
        invitedByUserId: owner,
        organizationId,
        role: OrganizationRole.ADMIN,
        tokenHash: hashOpaqueToken(token),
      },
    });
    const response = await request(app)
      .post(`/invitations/${token}/login`)
      .send({
        email: 'existing-invitee@example.test',
        password: 'safe-password',
      })
      .expect(200);
    expect(accountResponseSchema.parse(response.body as unknown).data.memberships).toEqual([
      expect.objectContaining({
        organizationId,
        role: OrganizationRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
    ]);
    expect(
      responseCookies(response).some((cookie) => cookie.startsWith('incidentbase_access=')),
    ).toBe(true);
  });

  it.each([
    [OrganizationRole.OWNER, 201],
    [OrganizationRole.ADMIN, 201],
    [OrganizationRole.RESPONDER, 403],
    [OrganizationRole.REPORTER, 403],
  ] as const)('enforces invitation permission for %s', async (role, expectedStatus) => {
    const user = randomUUID();
    const organization = randomUUID();
    const owner = randomUUID();
    await database.user.createMany({
      data: [
        {
          displayName: `${role} User`,
          email: `${role.toLowerCase()}-${user}@example.test`,
          id: user,
        },
        { displayName: 'Matrix Owner', email: `owner-${owner}@example.test`, id: owner },
      ],
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: {
          id: organization,
          name: `${role} Organization`,
          slug: `${role.toLowerCase()}-${organization}`,
        },
      });
      await transaction.organizationMembership.createMany({
        data: [
          {
            organizationId: organization,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
            userId: owner,
          },
          {
            organizationId: organization,
            role,
            status: MembershipStatus.ACTIVE,
            userId: user,
          },
        ],
      });
    });
    const token = await accessTokens.issue(user);

    await request(app)
      .post(`/organizations/${organization}/invitations`)
      .set('authorization', `Bearer ${token}`)
      .send({ email: `invite-${user}@example.test`, role: OrganizationRole.REPORTER })
      .expect(expectedStatus);
  });

  it('prevents an admin managing an owner and preserves the final active owner', async () => {
    const owner = randomUUID();
    const admin = randomUUID();
    const organization = randomUUID();
    let ownerMembershipId = '';
    await database.user.createMany({
      data: [
        { displayName: 'Boundary Owner', email: `boundary-owner-${owner}@example.test`, id: owner },
        { displayName: 'Boundary Admin', email: `boundary-admin-${admin}@example.test`, id: admin },
      ],
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: organization, name: 'Boundary Organization', slug: `boundary-${organization}` },
      });
      const createdOwner = await transaction.organizationMembership.create({
        data: {
          organizationId: organization,
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
          userId: owner,
        },
      });
      ownerMembershipId = createdOwner.id;
      await transaction.organizationMembership.create({
        data: {
          organizationId: organization,
          role: OrganizationRole.ADMIN,
          status: MembershipStatus.ACTIVE,
          userId: admin,
        },
      });
    });

    const adminToken = await accessTokens.issue(admin);
    await request(app)
      .patch(`/organizations/${organization}/members/${ownerMembershipId}`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ role: OrganizationRole.ADMIN })
      .expect(403);

    const ownerToken = await accessTokens.issue(owner);
    const response = await request(app)
      .patch(`/organizations/${organization}/members/${ownerMembershipId}`)
      .set('authorization', `Bearer ${ownerToken}`)
      .send({ status: MembershipStatus.SUSPENDED })
      .expect(409);
    expect(errorResponseSchema.parse(response.body as unknown).error.code).toBe(
      'LAST_OWNER_REQUIRED',
    );
  });
});

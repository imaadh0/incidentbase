import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AccessTokenService, hashOpaqueToken } from '@incidentbase/auth';
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
  const accessTokens = new AccessTokenService({
    audience: 'incidentbase-api',
    issuer: 'incidentbase',
    secret: 'api-test-secret-that-is-at-least-32-characters',
  });
  const service = new AuthenticationService({
    accessTokens,
    refreshTokenTtlSeconds: 3600,
    repository,
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
    await resetTestDatabase(database);
  });

  afterAll(async () => {
    await runtimeDatabase.$disconnect();
    await database.$disconnect();
  });

  it('registers an owner and stores an Argon2id password hash', async () => {
    const response = await request(app).post('/auth/register').send({
      displayName: 'Registered Owner',
      email: ' REGISTERED@example.test ',
      organizationName: 'Registered Organization',
      organizationSlug: 'registered-organization',
      password: 'correct horse battery staple',
    });
    expect(response.status, response.text).toBe(201);

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
      'REGISTRATION_CONFLICT',
    );
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
    await request(app)
      .post(`/invitations/${validToken}/accept`)
      .set('Cookie', [accessCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(200);
    await request(app)
      .post(`/invitations/${expiredToken}/accept`)
      .set('Cookie', [accessCookie, csrfCookie])
      .set('x-csrf-token', csrfToken)
      .expect(400);

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

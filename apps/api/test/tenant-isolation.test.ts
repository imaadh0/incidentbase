import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseEnvironment, apiEnvironmentSchema } from '@incidentbase/config';
import {
  createDatabaseClient,
  MembershipStatus,
  OrganizationRole,
  TenantUnitOfWork,
} from '@incidentbase/database';
import { createLogger, createServiceMetrics } from '@incidentbase/observability';

import { createApp } from '../src/create-app.js';

const testDatabaseUrl = process.env.API_TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;
const errorResponseSchema = z.object({
  error: z.object({ code: z.string() }),
});

describeWithDatabase.sequential('API tenant isolation boundary', () => {
  if (testDatabaseUrl === undefined) {
    return;
  }

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const ids = {
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    suspended: randomUUID(),
    membershipA: randomUUID(),
    membershipB: randomUUID(),
  };

  const environment = parseEnvironment('api', apiEnvironmentSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    WEB_ORIGIN: 'http://localhost:3000',
    REDIS_URL: 'redis://localhost:6379',
    METRICS_TOKEN: 'a-secure-test-token-with-32-characters',
    OTEL_ENABLED: 'false',
  });

  const principals = new Map([
    ['owner-a-token', { userId: ids.ownerA }],
    ['owner-b-token', { userId: ids.ownerB }],
    ['suspended-token', { userId: ids.suspended }],
  ]);
  const app = createApp({
    environment,
    logger: createLogger({ level: 'fatal', service: 'api-tenant-test' }),
    metrics: createServiceMetrics('api-tenant-test'),
    tenantBoundary: {
      resolvePrincipal: (incomingRequest) => {
        const authorization = incomingRequest.header('authorization');
        const token = authorization?.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : undefined;
        return Promise.resolve(token === undefined ? null : (principals.get(token) ?? null));
      },
      unitOfWork: new TenantUnitOfWork(database),
    },
  });

  beforeAll(async () => {
    await database.organization.deleteMany();
    await database.user.deleteMany();
    await database.user.createMany({
      data: [
        { id: ids.ownerA, email: 'api-owner-a@example.test', displayName: 'API Owner A' },
        { id: ids.ownerB, email: 'api-owner-b@example.test', displayName: 'API Owner B' },
        {
          id: ids.suspended,
          email: 'api-suspended@example.test',
          displayName: 'API Suspended User',
        },
      ],
    });

    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationA, slug: 'api-organization-a', name: 'API Organization A' },
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
            organizationId: ids.organizationA,
            userId: ids.suspended,
            role: OrganizationRole.REPORTER,
            status: MembershipStatus.SUSPENDED,
          },
        ],
      });
    });

    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationB, slug: 'api-organization-b', name: 'API Organization B' },
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
    });
  });

  afterAll(async () => {
    await database.organization.deleteMany();
    await database.user.deleteMany();
    await database.$disconnect();
  });

  it('returns a same-tenant membership to an active member', async () => {
    const response = await request(app)
      .get(`/organizations/${ids.organizationA}/memberships/${ids.membershipA}`)
      .set('authorization', 'Bearer owner-a-token')
      .expect(200);

    expect(response.body).toMatchObject({
      data: {
        id: ids.membershipA,
        organizationId: ids.organizationA,
        userId: ids.ownerA,
      },
    });
  });

  it('returns 404 for a direct membership ID guess from another tenant', async () => {
    const response = await request(app)
      .get(`/organizations/${ids.organizationA}/memberships/${ids.membershipB}`)
      .set('authorization', 'Bearer owner-a-token')
      .expect(404);

    expect(errorResponseSchema.parse(response.body).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns the same 404 when an active user guesses another organization', async () => {
    const response = await request(app)
      .get(`/organizations/${ids.organizationB}/memberships/${ids.membershipB}`)
      .set('authorization', 'Bearer owner-a-token')
      .expect(404);

    expect(errorResponseSchema.parse(response.body).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns the same 404 for a suspended member', async () => {
    const response = await request(app)
      .get(`/organizations/${ids.organizationA}/memberships/${ids.membershipA}`)
      .set('authorization', 'Bearer suspended-token')
      .expect(404);

    expect(errorResponseSchema.parse(response.body).error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('requires an authenticated principal', async () => {
    const response = await request(app)
      .get(`/organizations/${ids.organizationA}/memberships/${ids.membershipA}`)
      .expect(401);

    expect(errorResponseSchema.parse(response.body).error.code).toBe('UNAUTHORIZED');
  });
});

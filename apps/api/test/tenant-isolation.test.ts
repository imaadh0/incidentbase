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
import { resetTestDatabase } from './reset-test-database.js';

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
    responder: randomUUID(),
    membershipA: randomUUID(),
    membershipB: randomUUID(),
  };

  const environment = parseEnvironment('api', apiEnvironmentSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    METRICS_TOKEN: 'a-secure-test-token-with-32-characters',
    JWT_SECRET: 'a-secure-test-jwt-secret-with-32-characters',
    COOKIE_SECURE: 'false',
    NOTIFICATION_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    OTEL_ENABLED: 'false',
  });

  const principals = new Map([
    ['owner-a-token', { userId: ids.ownerA }],
    ['owner-b-token', { userId: ids.ownerB }],
    ['suspended-token', { userId: ids.suspended }],
    ['responder-token', { userId: ids.responder }],
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
    await resetTestDatabase(database);
    await database.user.createMany({
      data: [
        { id: ids.ownerA, email: 'api-owner-a@example.test', displayName: 'API Owner A' },
        { id: ids.ownerB, email: 'api-owner-b@example.test', displayName: 'API Owner B' },
        {
          id: ids.suspended,
          email: 'api-suspended@example.test',
          displayName: 'API Suspended User',
        },
        { id: ids.responder, email: 'api-responder@example.test', displayName: 'API Responder' },
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
          {
            organizationId: ids.organizationA,
            userId: ids.responder,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.ACTIVE,
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

  it('redacts webhook secrets and rejects cross-tenant settings access', async () => {
    const settingsUrl = `/organizations/${ids.organizationA}/notification-settings`;
    const update = await request(app)
      .put(settingsUrl)
      .set('authorization', 'Bearer owner-a-token')
      .send({
        slackEnabled: true,
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/secret',
        emailEnabled: true,
      })
      .expect(200);
    expect(update.body).toMatchObject({
      data: { slackEnabled: true, slackConfigured: true, emailEnabled: true },
    });
    expect(JSON.stringify(update.body)).not.toContain('secret');
    const read = await request(app)
      .get(settingsUrl)
      .set('authorization', 'Bearer owner-a-token')
      .expect(200);
    expect(JSON.stringify(read.body)).not.toContain('secret');
    await request(app)
      .get(`/organizations/${ids.organizationB}/notification-settings`)
      .set('authorization', 'Bearer owner-a-token')
      .expect(404);
    await request(app).get(settingsUrl).set('authorization', 'Bearer suspended-token').expect(404);
    await request(app).get(settingsUrl).set('authorization', 'Bearer responder-token').expect(403);
    await request(app)
      .get(`/organizations/${ids.organizationA}/notification-deliveries`)
      .set('authorization', 'Bearer responder-token')
      .expect(403);
  });

  it('rejects spoofed webhook hosts and rate-limits test delivery requests', async () => {
    const settingsUrl = `/organizations/${ids.organizationA}/notification-settings`;
    await request(app)
      .put(settingsUrl)
      .set('authorization', 'Bearer owner-a-token')
      .send({ slackWebhookUrl: 'https://hooks.slack.com.evil.test/services/T/B/token' })
      .expect(400);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post(`${settingsUrl}/test`)
        .set('authorization', 'Bearer owner-a-token')
        .send({})
        .expect(202);
    }
    await request(app)
      .post(`${settingsUrl}/test`)
      .set('authorization', 'Bearer owner-a-token')
      .send({})
      .expect(429);
  });
});

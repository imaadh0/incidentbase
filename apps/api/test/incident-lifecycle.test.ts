import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiEnvironmentSchema, parseEnvironment } from '@incidentbase/config';
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
const runtimeTestDatabaseUrl = process.env.API_TEST_RUNTIME_DATABASE_URL;
if (testDatabaseUrl !== undefined && runtimeTestDatabaseUrl === undefined) {
  throw new Error('API_TEST_RUNTIME_DATABASE_URL is required when API_TEST_DATABASE_URL is set.');
}
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;
const incidentResponseSchema = z.object({
  data: z.object({
    assignedMembershipId: z.uuid(),
    escalationGeneration: z.number(),
    id: z.uuid(),
    policyVersionId: z.uuid(),
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED']),
    version: z.number().int(),
  }),
});
const policyResponseSchema = z.object({
  data: z.object({ id: z.uuid(), activeVersionId: z.uuid() }),
});
const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), details: z.unknown().optional() }),
});
const timelineResponseSchema = z.object({
  data: z.array(z.object({ action: z.string(), id: z.string(), metadata: z.unknown() })),
});

describeWithDatabase.sequential('policy and incident lifecycle API', () => {
  if (testDatabaseUrl === undefined) return;

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const runtimeDatabase = createDatabaseClient({ connectionString: runtimeTestDatabaseUrl! });
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    admin: randomUUID(),
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    reporter: randomUUID(),
    responder1: randomUUID(),
    responder2: randomUUID(),
    suspended: randomUUID(),
    adminMembership: randomUUID(),
    ownerMembershipA: randomUUID(),
    ownerMembershipB: randomUUID(),
    reporterMembership: randomUUID(),
    responderMembership1: randomUUID(),
    responderMembership2: randomUUID(),
    suspendedMembership: randomUUID(),
  };
  const principals = new Map([
    ['owner-a', { userId: ids.ownerA }],
    ['owner-b', { userId: ids.ownerB }],
    ['admin', { userId: ids.admin }],
    ['reporter', { userId: ids.reporter }],
    ['responder-1', { userId: ids.responder1 }],
    ['responder-2', { userId: ids.responder2 }],
    ['suspended', { userId: ids.suspended }],
  ]);
  const environment = parseEnvironment('api', apiEnvironmentSchema, {
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    COOKIE_SECURE: 'false',
    DATABASE_URL: runtimeTestDatabaseUrl,
    JWT_SECRET: 'api-test-secret-that-is-at-least-32-characters',
    LOG_LEVEL: 'fatal',
    METRICS_TOKEN: 'a-secure-test-token-with-32-characters',
    NODE_ENV: 'test',
    OTEL_ENABLED: 'false',
    REDIS_URL: 'redis://localhost:6379',
    WEB_ORIGIN: 'http://localhost:3000',
  });
  const app = createApp({
    environment,
    logger: createLogger({ level: 'fatal', service: 'api-incident-test' }),
    metrics: createServiceMetrics('api-incident-test'),
    tenantBoundary: {
      resolvePrincipal: (incomingRequest) => {
        const authorization = incomingRequest.header('authorization');
        const token = authorization?.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : undefined;
        return Promise.resolve(token === undefined ? null : (principals.get(token) ?? null));
      },
      unitOfWork: new TenantUnitOfWork(runtimeDatabase),
    },
  });

  beforeAll(async () => {
    await resetTestDatabase(database);
    await database.user.createMany({
      data: [
        { id: ids.ownerA, email: `api-owner-a-${suffix}@example.test`, displayName: 'Owner A' },
        { id: ids.ownerB, email: `api-owner-b-${suffix}@example.test`, displayName: 'Owner B' },
        { id: ids.admin, email: `api-admin-${suffix}@example.test`, displayName: 'Admin' },
        {
          id: ids.reporter,
          email: `api-reporter-${suffix}@example.test`,
          displayName: 'Reporter',
        },
        {
          id: ids.responder1,
          email: `api-responder-1-${suffix}@example.test`,
          displayName: 'Responder 1',
        },
        {
          id: ids.responder2,
          email: `api-responder-2-${suffix}@example.test`,
          displayName: 'Responder 2',
        },
        {
          id: ids.suspended,
          email: `api-suspended-${suffix}@example.test`,
          displayName: 'Suspended',
        },
      ],
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationA, name: 'API Lifecycle A', slug: `api-life-a-${suffix}` },
      });
      await transaction.organizationMembership.createMany({
        data: [
          membership(ids.ownerMembershipA, ids.organizationA, ids.ownerA, OrganizationRole.OWNER),
          membership(ids.adminMembership, ids.organizationA, ids.admin, OrganizationRole.ADMIN),
          membership(
            ids.reporterMembership,
            ids.organizationA,
            ids.reporter,
            OrganizationRole.REPORTER,
          ),
          membership(
            ids.responderMembership1,
            ids.organizationA,
            ids.responder1,
            OrganizationRole.RESPONDER,
          ),
          membership(
            ids.responderMembership2,
            ids.organizationA,
            ids.responder2,
            OrganizationRole.RESPONDER,
          ),
          {
            ...membership(
              ids.suspendedMembership,
              ids.organizationA,
              ids.suspended,
              OrganizationRole.RESPONDER,
            ),
            status: MembershipStatus.SUSPENDED,
          },
        ],
      });
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationB, name: 'API Lifecycle B', slug: `api-life-b-${suffix}` },
      });
      await transaction.organizationMembership.create({
        data: membership(
          ids.ownerMembershipB,
          ids.organizationB,
          ids.ownerB,
          OrganizationRole.OWNER,
        ),
      });
    });
  });

  afterAll(async () => {
    await runtimeDatabase.$disconnect();
    await database.$disconnect();
  });

  it('allows only administrators to configure immutable policy revisions', async () => {
    await request(app)
      .post(`/organizations/${ids.organizationA}/policies`)
      .set('authorization', 'Bearer reporter')
      .send(policyBody(ids.responderMembership1))
      .expect(403);
    await request(app)
      .post(`/organizations/${ids.organizationA}/policies`)
      .set('authorization', 'Bearer responder-1')
      .send(policyBody(ids.responderMembership1))
      .expect(403);

    const created = await request(app)
      .post(`/organizations/${ids.organizationA}/policies`)
      .set('authorization', 'Bearer owner-a')
      .send(policyBody(ids.responderMembership1))
      .expect(201);
    const policy = policyResponseSchema.parse(created.body as unknown).data;

    await request(app)
      .get(`/organizations/${ids.organizationA}/policies`)
      .set('authorization', 'Bearer reporter')
      .expect(200);
    await request(app)
      .post(`/organizations/${ids.organizationA}/policies/${policy.id}/revisions`)
      .set('authorization', 'Bearer admin')
      .send({ ...policyBody(ids.responderMembership2), name: 'Primary revision 2' })
      .expect(201);

    const archive = await request(app)
      .post(`/organizations/${ids.organizationA}/policies/${policy.id}/archive`)
      .set('authorization', 'Bearer owner-a')
      .expect(409);
    expect(errorResponseSchema.parse(archive.body as unknown).error.code).toBe(
      'DEFAULT_POLICY_ARCHIVE_FORBIDDEN',
    );
  });

  it('routes reporter-created incidents through the default policy', async () => {
    const incident = await createIncident('Reporter-created incident');
    expect(incident).toMatchObject({
      assignedMembershipId: ids.responderMembership2,
      status: 'OPEN',
      version: 1,
    });

    await request(app)
      .get(`/organizations/${ids.organizationA}/incidents/${incident.id}`)
      .set('authorization', 'Bearer reporter')
      .expect(200)
      .expect('ETag', '"1"');
  });

  it('enforces every role at incident command boundaries', async () => {
    const incident = await createIncident('Role matrix incident');
    const url = `/organizations/${ids.organizationA}/incidents/${incident.id}/acknowledge`;

    await request(app)
      .post(url)
      .set('authorization', 'Bearer reporter')
      .set('if-match', '"1"')
      .expect(403);
    await request(app)
      .post(url)
      .set('authorization', 'Bearer responder-1')
      .set('if-match', '"1"')
      .expect(403);
    await request(app).post(url).set('authorization', 'Bearer responder-2').expect(428);

    const acknowledgedResponse = await request(app)
      .post(url)
      .set('authorization', 'Bearer responder-2')
      .set('if-match', '"1"')
      .expect(200);
    const acknowledged = incidentResponseSchema.parse(acknowledgedResponse.body as unknown).data;
    expect(acknowledged.status).toBe('ACKNOWLEDGED');

    const investigating = await command(
      incident.id,
      'start-investigation',
      acknowledged.version,
      'responder-2',
    );
    const resolved = await command(incident.id, 'resolve', investigating.version, 'responder-2');

    await request(app)
      .post(`/organizations/${ids.organizationA}/incidents/${incident.id}/reopen`)
      .set('authorization', 'Bearer reporter')
      .set('if-match', `"${resolved.version}"`)
      .expect(403);
    const reopened = await command(incident.id, 'reopen', resolved.version, 'admin');
    expect(reopened).toMatchObject({ escalationGeneration: 1, status: 'OPEN' });
  });

  it('returns one success and one current-state conflict for simultaneous acknowledgements', async () => {
    const incident = await createIncident('Concurrent API acknowledgement');
    const url = `/organizations/${ids.organizationA}/incidents/${incident.id}/acknowledge`;
    const acknowledge = () =>
      request(app)
        .post(url)
        .set('authorization', 'Bearer responder-2')
        .set('if-match', `"${incident.version}"`);

    const responses = await Promise.all([acknowledge(), acknowledge()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    const parsed = errorResponseSchema.parse(conflict.body as unknown);
    expect(parsed.error).toMatchObject({ code: 'INCIDENT_VERSION_CONFLICT' });
    expect(parsed.error.details).toBeDefined();
  });

  it('records explicit administrator overrides and rejects stale writes', async () => {
    const incident = await createIncident('Override API incident');
    const acknowledged = await command(incident.id, 'acknowledge', incident.version, 'admin');

    const stale = await request(app)
      .patch(`/organizations/${ids.organizationA}/incidents/${incident.id}`)
      .set('authorization', 'Bearer owner-a')
      .set('if-match', `"${incident.version}"`)
      .send({ title: 'Stale title' })
      .expect(409);
    expect(errorResponseSchema.parse(stale.body as unknown).error.code).toBe(
      'INCIDENT_VERSION_CONFLICT',
    );

    const timelineResponse = await request(app)
      .get(`/organizations/${ids.organizationA}/incidents/${incident.id}/timeline`)
      .set('authorization', 'Bearer reporter')
      .expect(200);
    const timeline = timelineResponseSchema.parse(timelineResponse.body as unknown).data;
    expect(timeline).toHaveLength(2);
    expect(timeline.at(-1)?.metadata).toMatchObject({ override: true });
    expect(acknowledged.status).toBe('ACKNOWLEDGED');
  });

  it('allows only administrators to reassign to an active responder', async () => {
    const incident = await createIncident('Reassignment incident');
    const url = `/organizations/${ids.organizationA}/incidents/${incident.id}/reassign`;
    await request(app)
      .post(url)
      .set('authorization', 'Bearer reporter')
      .set('if-match', '"1"')
      .send({ membershipId: ids.responderMembership1 })
      .expect(403);
    await request(app)
      .post(url)
      .set('authorization', 'Bearer responder-2')
      .set('if-match', '"1"')
      .send({ membershipId: ids.responderMembership1 })
      .expect(403);

    const reassignedResponse = await request(app)
      .post(url)
      .set('authorization', 'Bearer owner-a')
      .set('if-match', '"1"')
      .send({ membershipId: ids.responderMembership1 })
      .expect(200);
    const reassigned = incidentResponseSchema.parse(reassignedResponse.body as unknown).data;
    expect(reassigned).toMatchObject({
      assignedMembershipId: ids.responderMembership1,
      escalationGeneration: 1,
      status: 'OPEN',
    });
  });

  it('returns indistinguishable not-found responses for tenant guesses and suspensions', async () => {
    const policyB = await request(app)
      .post(`/organizations/${ids.organizationB}/policies`)
      .set('authorization', 'Bearer owner-b')
      .send(policyBody(ids.ownerMembershipB))
      .expect(400);
    expect(errorResponseSchema.parse(policyB.body as unknown).error.code).toBe('VALIDATION_FAILED');

    const localIncident = await createIncident('Isolation API incident');
    const foreignOrganization = await request(app)
      .get(`/organizations/${ids.organizationA}/incidents/${localIncident.id}`)
      .set('authorization', 'Bearer owner-b')
      .expect(404);
    const suspended = await request(app)
      .get(`/organizations/${ids.organizationA}/incidents/${localIncident.id}`)
      .set('authorization', 'Bearer suspended')
      .expect(404);
    expect(errorResponseSchema.parse(foreignOrganization.body as unknown).error.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(errorResponseSchema.parse(suspended.body as unknown).error.code).toBe(
      'RESOURCE_NOT_FOUND',
    );
  });

  async function createIncident(title: string) {
    const response = await request(app)
      .post(`/organizations/${ids.organizationA}/incidents`)
      .set('authorization', 'Bearer reporter')
      .send({ description: `${title} description`, severity: 'SEV2', title })
      .expect(201);
    return incidentResponseSchema.parse(response.body as unknown).data;
  }

  async function command(
    incidentId: string,
    name: 'acknowledge' | 'reopen' | 'resolve' | 'start-investigation',
    version: number,
    token: string,
  ) {
    const response = await request(app)
      .post(`/organizations/${ids.organizationA}/incidents/${incidentId}/${name}`)
      .set('authorization', `Bearer ${token}`)
      .set('if-match', `"${version}"`)
      .expect(200);
    return incidentResponseSchema.parse(response.body as unknown).data;
  }

  function policyBody(responderMembershipId: string) {
    return {
      makeDefault: true,
      name: 'Primary policy',
      steps: [{ responderMembershipId, waitSeconds: 60 }],
    };
  }

  function membership(id: string, organizationId: string, userId: string, role: OrganizationRole) {
    return { id, organizationId, role, status: MembershipStatus.ACTIVE, userId };
  }
});

import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import pino from 'pino';
import { io as createSocket, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccessTokenService } from '@incidentbase/auth';
import {
  REALTIME_INCIDENT_EVENT,
  REALTIME_REDIS_CHANNEL,
  REALTIME_TOAST_EVENT,
  type RealtimeIncidentEvent,
} from '@incidentbase/contracts';
import {
  createDatabaseClient,
  MembershipStatus,
  OrganizationRole,
  TenantUnitOfWork,
} from '@incidentbase/database';

import { createRealtimeGateway, type RealtimeGateway } from '../src/realtime/realtime-gateway.js';
import { resetTestDatabase } from './reset-test-database.js';

const migrationUrl = process.env.API_TEST_DATABASE_URL;
const runtimeUrl = process.env.API_TEST_RUNTIME_DATABASE_URL;
const redisUrl = process.env.WORKER_TEST_REDIS_URL;
const enabled = migrationUrl !== undefined && runtimeUrl !== undefined && redisUrl !== undefined;
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration.sequential('Socket.io tenant isolation', () => {
  if (!enabled) return;

  const database = createDatabaseClient({ connectionString: migrationUrl });
  const runtimeDatabase = createDatabaseClient({ connectionString: runtimeUrl });
  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const tokens = new AccessTokenService({
    audience: 'incidentbase-api',
    issuer: 'incidentbase',
    secret: 'realtime-test-secret-at-least-thirty-two-characters',
  });
  const ids = {
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    ownerA: randomUUID(),
    ownerAMembership: randomUUID(),
    ownerB: randomUUID(),
    ownerBMembership: randomUUID(),
    suspended: randomUUID(),
    suspendedMembership: randomUUID(),
  };
  let httpServer: HttpServer;
  let gateway: RealtimeGateway;
  let address: string;

  beforeAll(async () => {
    await resetTestDatabase(database);
    await database.user.createMany({
      data: [
        { id: ids.ownerA, displayName: 'Owner A', email: 'socket-owner-a@example.test' },
        { id: ids.ownerB, displayName: 'Owner B', email: 'socket-owner-b@example.test' },
        { id: ids.suspended, displayName: 'Suspended', email: 'socket-suspended@example.test' },
      ],
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.createMany({
        data: [
          { id: ids.organizationA, name: 'Socket A', slug: `socket-a-${randomUUID()}` },
          { id: ids.organizationB, name: 'Socket B', slug: `socket-b-${randomUUID()}` },
        ],
      });
      await transaction.organizationMembership.createMany({
        data: [
          {
            id: ids.ownerAMembership,
            organizationId: ids.organizationA,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
            userId: ids.ownerA,
          },
          {
            id: ids.ownerBMembership,
            organizationId: ids.organizationB,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
            userId: ids.ownerB,
          },
          {
            id: ids.suspendedMembership,
            organizationId: ids.organizationA,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.SUSPENDED,
            userId: ids.suspended,
          },
        ],
      });
    });

    httpServer = createServer((_request, response) => response.end('ok'));
    gateway = await createRealtimeGateway({
      accessTokens: tokens,
      httpServer,
      logger: pino({ enabled: false }),
      redisUrl,
      tenantUnitOfWork: new TenantUnitOfWork(runtimeDatabase),
      webOrigin: 'http://127.0.0.1',
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const bound = httpServer.address();
    if (bound === null || typeof bound === 'string') throw new Error('Socket server did not bind.');
    address = `http://127.0.0.1:${bound.port}`;
  });

  afterAll(async () => {
    await gateway.close();
    await publisher.quit();
    await runtimeDatabase.$disconnect();
    await database.$disconnect();
  });

  it('denies guessed and suspended organization room joins', async () => {
    const owner = await connect(ids.ownerA);
    await expect(joinOrganization(owner, ids.organizationA)).resolves.toBe(true);
    await expect(joinOrganization(owner, ids.organizationB)).resolves.toBe(false);
    owner.disconnect();

    const suspended = await connect(ids.suspended);
    await expect(joinOrganization(suspended, ids.organizationA)).resolves.toBe(false);
    suspended.disconnect();
  });

  it('delivers invalidations only to the organization room and toasts only to the user room', async () => {
    const ownerA = await connect(ids.ownerA);
    const ownerB = await connect(ids.ownerB);
    await joinOrganization(ownerA, ids.organizationA);
    await joinOrganization(ownerB, ids.organizationB);

    const event: RealtimeIncidentEvent = {
      auditId: '91',
      eventId: randomUUID(),
      eventType: 'incident.escalated',
      incidentId: randomUUID(),
      organizationId: ids.organizationA,
      recipientUserId: ids.ownerA,
      referenceNumber: 19,
      status: 'OPEN',
      title: 'Tenant-safe realtime event',
      version: 2,
    };
    const invalidation = onceEvent(ownerA, REALTIME_INCIDENT_EVENT);
    const toast = onceEvent(ownerA, REALTIME_TOAST_EVENT);
    let leaked = false;
    ownerB.on(REALTIME_INCIDENT_EVENT, () => {
      leaked = true;
    });

    await publisher.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(event));
    await expect(invalidation).resolves.toEqual(event);
    await expect(toast).resolves.toEqual(event);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(leaked).toBe(false);
    ownerA.disconnect();
    ownerB.disconnect();
  });

  it('revalidates membership before every broadcast', async () => {
    await database.organizationMembership.update({
      where: {
        organizationId_id: {
          id: ids.suspendedMembership,
          organizationId: ids.organizationA,
        },
      },
      data: { status: MembershipStatus.ACTIVE },
    });
    const responder = await connect(ids.suspended);
    await expect(joinOrganization(responder, ids.organizationA)).resolves.toBe(true);
    await database.organizationMembership.update({
      where: {
        organizationId_id: {
          id: ids.suspendedMembership,
          organizationId: ids.organizationA,
        },
      },
      data: { status: MembershipStatus.SUSPENDED },
    });

    let received = false;
    responder.on(REALTIME_INCIDENT_EVENT, () => {
      received = true;
    });
    await publisher.publish(
      REALTIME_REDIS_CHANNEL,
      JSON.stringify({
        auditId: '92',
        eventId: randomUUID(),
        eventType: 'incident.updated',
        incidentId: randomUUID(),
        organizationId: ids.organizationA,
        recipientUserId: ids.suspended,
        referenceNumber: 20,
        status: 'OPEN',
        title: 'Membership revalidation',
        version: 2,
      } satisfies RealtimeIncidentEvent),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toBe(false);
    responder.disconnect();
  });

  async function connect(userId: string): Promise<Socket> {
    const token = await tokens.issue(userId);
    const socket = createSocket(address, {
      extraHeaders: { Cookie: `incidentbase_access=${token}` },
      forceNew: true,
      path: '/socket.io',
      transports: ['websocket'],
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
});

function joinOrganization(socket: Socket, organizationId: string): Promise<boolean> {
  return new Promise((resolve) => {
    socket.emit('organization:join', { organizationId }, (result: { ok: boolean }) => {
      resolve(result.ok);
    });
  });
}

function onceEvent(socket: Socket, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2_000);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

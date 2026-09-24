import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  IncidentSeverity,
  MembershipStatus,
  OrganizationRole,
  TenantUnitOfWork,
  WorkerUnitOfWork,
} from '../src/index.js';
import { resetTestDatabase } from './reset-test-database.js';

const testUrl = process.env.DATABASE_TEST_URL;
const workerUrl = process.env.WORKER_TEST_DATABASE_URL;
const describeWithDatabase = testUrl && workerUrl ? describe : describe.skip;

describeWithDatabase.sequential('durable notification staging and retry boundary', () => {
  if (!testUrl || !workerUrl) return;
  const database = createDatabaseClient({ connectionString: testUrl });
  const workerDatabase = createDatabaseClient({ connectionString: workerUrl });
  const tenant = new TenantUnitOfWork(database);
  const worker = new WorkerUnitOfWork(workerDatabase);
  const ids = {
    organization: randomUUID(),
    owner: randomUUID(),
    responder: randomUUID(),
    ownerMembership: randomUUID(),
    responderMembership: randomUUID(),
  };
  let eventId: string;
  let incidentId: string;

  beforeAll(async () => {
    await resetTestDatabase(database);
    await database.user.createMany({
      data: [
        { id: ids.owner, email: 'notification-owner@example.test', displayName: 'Owner' },
        {
          id: ids.responder,
          email: 'notification-responder@example.test',
          displayName: 'Responder',
        },
      ],
    });
    await database.$transaction(async (tx) => {
      await tx.organization.create({
        data: { id: ids.organization, slug: 'notification-test', name: 'Notification Test' },
      });
      await tx.organizationMembership.createMany({
        data: [
          {
            id: ids.ownerMembership,
            organizationId: ids.organization,
            userId: ids.owner,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
          },
          {
            id: ids.responderMembership,
            organizationId: ids.organization,
            userId: ids.responder,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.ACTIVE,
          },
        ],
      });
    });
    await tenant.withTenant(
      { organizationId: ids.organization, userId: ids.owner },
      async (context) => {
        await context.policies.create({
          organizationId: ids.organization,
          actorMembershipId: ids.ownerMembership,
          name: 'Primary',
          description: 'Test',
          makeDefault: true,
          steps: [{ responderMembershipId: ids.responderMembership, waitSeconds: 60 }],
        });
        await context.transaction.notificationSetting.create({
          data: { organizationId: ids.organization, emailEnabled: true },
        });
        const incident = await context.incidents.create({
          organizationId: ids.organization,
          reporterMembershipId: ids.ownerMembership,
          severity: IncidentSeverity.SEV2,
          title: 'Database unavailable',
          description: 'Test incident',
        });
        incidentId = incident.id;
      },
    );
    const event = await database.outboxEvent.findFirstOrThrow({
      where: { organizationId: ids.organization, eventType: 'incident.created' },
    });
    eventId = event.id;
  });

  afterAll(async () => {
    await database.$disconnect();
    await workerDatabase.$disconnect();
  });

  it('stages one email per active assignee and suppresses duplicate relay attempts', async () => {
    const event = await database.outboxEvent.findFirstOrThrow({
      where: { organizationId: ids.organization, id: eventId },
    });
    const claimed = {
      organizationId: event.organizationId,
      eventId: event.id,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      eventType: event.eventType,
      payload: event.payload,
      attempts: 1,
    };
    await worker.stageIncidentNotifications(claimed);
    await worker.stageIncidentNotifications(claimed);
    const rows = await database.notificationDelivery.findMany({
      where: { organizationId: ids.organization, eventId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'EMAIL',
      recipient: 'notification-responder@example.test',
    });
  });

  it('claims, retries, and marks delivery sent without a second claim', async () => {
    const [claimed] = await worker.claimNotificationDeliveries(10);
    expect(claimed?.eventId).toBe(eventId);
    await worker.finishNotificationDelivery(claimed!, null, 'Provider returned HTTP 503.', true);
    const retry = await database.notificationDelivery.findFirstOrThrow({
      where: { organizationId: ids.organization, eventId },
    });
    expect(retry).toMatchObject({ status: 'PENDING', attempts: 1 });
    await database.notificationDelivery.update({
      where: { organizationId_id: { organizationId: ids.organization, id: retry.id } },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    const [second] = await worker.claimNotificationDeliveries(10);
    expect(second?.deliveryId).toBe(claimed?.deliveryId);
    await worker.finishNotificationDelivery(second!, 'email-123', null, false);
    expect(await worker.claimNotificationDeliveries(10)).toEqual([]);
    expect(
      (
        await database.notificationDelivery.findFirstOrThrow({
          where: { organizationId: ids.organization, eventId },
        })
      ).status,
    ).toBe('SENT');
  });

  it('alerts active Owners/Admins once when an escalation chain is exhausted', async () => {
    const exhaustedEventId = randomUUID();
    await database.outboxEvent.create({
      data: {
        id: exhaustedEventId,
        organizationId: ids.organization,
        aggregateType: 'incident',
        aggregateId: incidentId,
        eventType: 'incident.escalation-exhausted',
        payload: { assignedMembershipId: ids.responderMembership, status: 'OPEN', version: 2 },
        deduplicationKey: `exhausted:${exhaustedEventId}`,
      },
    });
    const event = {
      organizationId: ids.organization,
      eventId: exhaustedEventId,
      aggregateType: 'incident',
      aggregateId: incidentId,
      eventType: 'incident.escalation-exhausted',
      payload: {},
      attempts: 1,
    };
    await worker.stageIncidentNotifications(event);
    await worker.stageIncidentNotifications(event);
    const deliveries = await database.notificationDelivery.findMany({
      where: {
        organizationId: ids.organization,
        eventId: exhaustedEventId,
      },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channel: 'EMAIL',
      recipient: 'notification-owner@example.test',
    });
  });

  it('terminalizes an expired final lease instead of leaving it processing forever', async () => {
    const delivery = await database.notificationDelivery.findFirstOrThrow({
      where: { organizationId: ids.organization, status: 'PENDING' },
    });
    await database.notificationDelivery.update({
      where: { organizationId_id: { organizationId: ids.organization, id: delivery.id } },
      data: { status: 'PROCESSING', attempts: 8, availableAt: new Date(Date.now() - 1_000) },
    });
    expect(await worker.claimNotificationDeliveries(10)).toEqual([]);
    expect((await database.notificationDelivery.findFirstOrThrow({
      where: { organizationId: ids.organization, id: delivery.id },
    })).status).toBe('FAILED');
  });
});

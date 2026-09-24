import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  IncidentConflictError,
  IncidentSeverity,
  MembershipStatus,
  OrganizationRole,
  TenantUnitOfWork,
  WorkerUnitOfWork,
} from '../src/index.js';
import { resetTestDatabase } from './reset-test-database.js';

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const workerDatabaseUrl = process.env.WORKER_TEST_DATABASE_URL;
if (testDatabaseUrl !== undefined && workerDatabaseUrl === undefined) {
  throw new Error('WORKER_TEST_DATABASE_URL is required when DATABASE_TEST_URL is set.');
}
const describeWithDatabase = testDatabaseUrl === undefined ? describe.skip : describe;

describeWithDatabase.sequential('worker escalation serialization', () => {
  if (testDatabaseUrl === undefined) return;

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const workerDatabase = createDatabaseClient({ connectionString: workerDatabaseUrl! });
  const tenant = new TenantUnitOfWork(database);
  const worker = new WorkerUnitOfWork(workerDatabase);
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    organization: randomUUID(),
    owner: randomUUID(),
    ownerMembership: randomUUID(),
    reporter: randomUUID(),
    reporterMembership: randomUUID(),
    responder1: randomUUID(),
    responder2: randomUUID(),
    responder3: randomUUID(),
    responderMembership1: randomUUID(),
    responderMembership2: randomUUID(),
    responderMembership3: randomUUID(),
  };

  beforeAll(async () => {
    await resetTestDatabase(database);
    await database.user.createMany({
      data: [
        { id: ids.owner, email: `worker-owner-${suffix}@example.test`, displayName: 'Owner' },
        {
          id: ids.reporter,
          email: `worker-reporter-${suffix}@example.test`,
          displayName: 'Reporter',
        },
        {
          id: ids.responder1,
          email: `worker-responder-1-${suffix}@example.test`,
          displayName: 'Responder 1',
        },
        {
          id: ids.responder2,
          email: `worker-responder-2-${suffix}@example.test`,
          displayName: 'Responder 2',
        },
        {
          id: ids.responder3,
          email: `worker-responder-3-${suffix}@example.test`,
          displayName: 'Responder 3',
        },
      ],
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organization, name: 'Worker Test', slug: `worker-test-${suffix}` },
      });
      await transaction.organizationMembership.createMany({
        data: [
          membership(ids.ownerMembership, ids.owner, OrganizationRole.OWNER),
          membership(ids.reporterMembership, ids.reporter, OrganizationRole.REPORTER),
          membership(ids.responderMembership1, ids.responder1, OrganizationRole.RESPONDER),
          membership(ids.responderMembership2, ids.responder2, OrganizationRole.RESPONDER),
          membership(ids.responderMembership3, ids.responder3, OrganizationRole.RESPONDER),
        ],
      });
    });
    await tenant.withTenant({ organizationId: ids.organization, userId: ids.owner }, (context) =>
      context.policies.create({
        actorMembershipId: ids.ownerMembership,
        makeDefault: true,
        name: 'Worker escalation chain',
        organizationId: ids.organization,
        steps: [
          { responderMembershipId: ids.responderMembership1, waitSeconds: 60 },
          { responderMembershipId: ids.responderMembership2, waitSeconds: 60 },
          { responderMembershipId: ids.responderMembership3, waitSeconds: 60 },
        ],
      }),
    );
  });

  afterAll(async () => {
    await workerDatabase.$disconnect();
    await database.$disconnect();
  });

  it('serializes overlapping workers and makes duplicate jobs harmless', async () => {
    const expectation = await createDueIncident('Overlapping workers');
    const results = await Promise.all([worker.process(expectation), worker.process(expectation)]);

    expect(results.map((result) => result.outcome).sort()).toEqual(['ESCALATED', 'STALE']);
    const state = await database.incident.findUniqueOrThrow({
      where: {
        organizationId_id: { id: expectation.incidentId, organizationId: ids.organization },
      },
    });
    expect(state).toMatchObject({
      assignedMembershipId: ids.responderMembership2,
      currentEscalationStep: 1,
      version: 2,
    });
    expect(
      await database.auditLog.count({
        where: { action: 'incident.escalated', incidentId: expectation.incidentId },
      }),
    ).toBe(1);
  });

  it('requires scoped worker context and rejects cross-tenant ID guessing', async () => {
    const expectation = await createDueIncident('Tenant boundary');
    const roleRows = await workerDatabase.$queryRaw<
      Array<{ bypassRls: boolean; currentUser: string; ownsTenantTables: bigint }>
    >`
      SELECT current_user AS "currentUser",
             role.rolbypassrls AS "bypassRls",
             COUNT(table_class.oid) FILTER (
               WHERE namespace.nspname = 'public'
                 AND table_class.relname IN ('incidents', 'audit_logs', 'outbox_events')
                 AND table_class.relowner = role.oid
             ) AS "ownsTenantTables"
      FROM pg_roles AS role
      LEFT JOIN pg_class AS table_class ON table_class.relowner = role.oid
      LEFT JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
      WHERE role.rolname = current_user
      GROUP BY role.rolbypassrls
    `;
    const role = roleRows[0];
    if (role === undefined) throw new Error('Worker login role was not found.');

    expect(role.currentUser).not.toBe('incidentbase_worker');
    expect(role.bypassRls).toBe(false);
    expect(role.ownsTenantTables).toBe(0n);
    expect(await workerDatabase.incident.findMany()).toEqual([]);
    await expect(worker.process({ ...expectation, organizationId: randomUUID() })).resolves.toEqual(
      { outcome: 'STALE' },
    );
  });

  it('serializes acknowledgement racing an escalation job', async () => {
    const expectation = await createDueIncident('Acknowledgement race');
    const acknowledge = tenant.withTenant(
      { organizationId: ids.organization, userId: ids.responder1 },
      (context) =>
        context.incidents.acknowledge(expectation.incidentId, 1, {
          membershipId: ids.responderMembership1,
          override: false,
        }),
    );
    const [acknowledgement, escalation] = await Promise.allSettled([
      acknowledge,
      worker.process(expectation),
    ]);
    const final = await database.incident.findUniqueOrThrow({
      where: {
        organizationId_id: { id: expectation.incidentId, organizationId: ids.organization },
      },
    });

    if (acknowledgement.status === 'fulfilled') {
      expect(escalation).toMatchObject({ status: 'fulfilled', value: { outcome: 'STALE' } });
      expect(final.status).toBe('ACKNOWLEDGED');
    } else {
      expect(acknowledgement.reason).toBeInstanceOf(IncidentConflictError);
      expect(escalation).toMatchObject({ status: 'fulfilled', value: { outcome: 'ESCALATED' } });
      expect(final.assignedMembershipId).toBe(ids.responderMembership2);
    }
    expect(final.version).toBe(2);
  });

  it('skips inactive responders and emits exhaustion exactly once', async () => {
    const expectation = await createDueIncident('Inactive responder');
    await database.organizationMembership.update({
      where: {
        organizationId_id: {
          id: ids.responderMembership2,
          organizationId: ids.organization,
        },
      },
      data: { status: MembershipStatus.SUSPENDED },
    });

    const escalation = await worker.process(expectation);
    expect(escalation.outcome).toBe('ESCALATED');
    if (escalation.outcome !== 'ESCALATED') throw new Error('Expected escalation.');
    expect(escalation.incident).toMatchObject({
      assignedMembershipId: ids.responderMembership3,
      currentEscalationStep: 2,
    });
    expect(
      await database.auditLog.count({
        where: {
          action: 'incident.escalation-responder-skipped',
          incidentId: expectation.incidentId,
        },
      }),
    ).toBe(1);

    const dueFinal = await makeDue(escalation.incident.id);
    const exhausted = await worker.process(dueFinal);
    const duplicate = await worker.process(dueFinal);
    expect(exhausted.outcome).toBe('EXHAUSTED');
    if (exhausted.outcome !== 'EXHAUSTED') throw new Error('Expected chain exhaustion.');
    expect(exhausted.incident.assignedMembershipId).toBe(ids.responderMembership3);
    expect(duplicate.outcome).toBe('STALE');
    const exhaustionEvents = await database.outboxEvent.findMany({
      where: { aggregateId: expectation.incidentId, eventType: 'incident.escalation-exhausted' },
    });
    expect(exhaustionEvents).toHaveLength(1);
    expect(exhaustionEvents[0]?.payload).toMatchObject({
      alertRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN],
    });

    await database.organizationMembership.update({
      where: {
        organizationId_id: {
          id: ids.responderMembership2,
          organizationId: ids.organization,
        },
      },
      data: { status: MembershipStatus.ACTIVE },
    });
  });

  it('discovers missing scheduled work through reconciliation', async () => {
    const expectation = await createDueIncident('Reconciliation candidate');
    const candidates = await worker.reconciliationCandidates(new Date(Date.now() + 60_000));

    expect(candidates).toContainEqual(expectation);
  });

  it('claims committed outbox work through the restricted relay boundary', async () => {
    await createDueIncident('Outbox relay candidate');
    const [claimed] = await worker.claimOutboxEvents(1);
    expect(claimed).toMatchObject({ attempts: 1 });
    if (claimed === undefined) throw new Error('Expected a claimed outbox event.');

    await worker.publishOutboxEvent(claimed.organizationId, claimed.eventId);
    const stored = await database.outboxEvent.findUniqueOrThrow({
      where: {
        organizationId_id: {
          id: claimed.eventId,
          organizationId: claimed.organizationId,
        },
      },
    });
    expect(stored).toMatchObject({ attempts: 1, status: 'PUBLISHED' });
    expect(stored.processedAt).not.toBeNull();
  });

  async function createDueIncident(title: string) {
    const incident = await tenant.withTenant(
      { organizationId: ids.organization, userId: ids.reporter },
      (context) =>
        context.incidents.create({
          description: `${title} description`,
          organizationId: ids.organization,
          reporterMembershipId: ids.reporterMembership,
          severity: IncidentSeverity.SEV2,
          title,
        }),
    );
    return makeDue(incident.id);
  }

  async function makeDue(incidentId: string) {
    const expectedDeadline = new Date(Date.now() - 1_000);
    const incident = await database.incident.update({
      where: { organizationId_id: { id: incidentId, organizationId: ids.organization } },
      data: { nextEscalationAt: expectedDeadline },
    });
    return {
      expectedDeadline,
      expectedStep: incident.currentEscalationStep,
      generation: incident.escalationGeneration,
      incidentId,
      organizationId: ids.organization,
    };
  }

  function membership(id: string, userId: string, role: OrganizationRole) {
    return {
      id,
      organizationId: ids.organization,
      role,
      status: MembershipStatus.ACTIVE,
      userId,
    };
  }
});

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  IncidentConflictError,
  IncidentSeverity,
  IncidentStatus,
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

describeWithDatabase.sequential('policy and incident lifecycle repository', () => {
  if (testDatabaseUrl === undefined) return;

  const database = createDatabaseClient({ connectionString: testDatabaseUrl });
  const unitOfWork = new TenantUnitOfWork(database);
  const workerDatabase = createDatabaseClient({ connectionString: workerDatabaseUrl! });
  const worker = new WorkerUnitOfWork(workerDatabase);
  let resolutionSummaryId: string;
  let reopenedIncidentId: string;
  let reopenedIncidentVersion: number;
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    reporterA: randomUUID(),
    responderA1: randomUUID(),
    responderA2: randomUUID(),
    responderB: randomUUID(),
    ownerMembershipA: randomUUID(),
    ownerMembershipB: randomUUID(),
    reporterMembershipA: randomUUID(),
    responderMembershipA1: randomUUID(),
    responderMembershipA2: randomUUID(),
    responderMembershipB: randomUUID(),
  };

  beforeAll(async () => {
    await resetTestDatabase(database);
    await database.user.createMany({
      data: [
        { id: ids.ownerA, email: `owner-a-${suffix}@example.test`, displayName: 'Owner A' },
        { id: ids.ownerB, email: `owner-b-${suffix}@example.test`, displayName: 'Owner B' },
        {
          id: ids.reporterA,
          email: `reporter-a-${suffix}@example.test`,
          displayName: 'Reporter A',
        },
        {
          id: ids.responderA1,
          email: `responder-a1-${suffix}@example.test`,
          displayName: 'Responder A1',
        },
        {
          id: ids.responderA2,
          email: `responder-a2-${suffix}@example.test`,
          displayName: 'Responder A2',
        },
        {
          id: ids.responderB,
          email: `responder-b-${suffix}@example.test`,
          displayName: 'Responder B',
        },
      ],
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationA, name: 'Lifecycle A', slug: `lifecycle-a-${suffix}` },
      });
      await transaction.organizationMembership.createMany({
        data: [
          {
            id: ids.ownerMembershipA,
            organizationId: ids.organizationA,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
            userId: ids.ownerA,
          },
          {
            id: ids.reporterMembershipA,
            organizationId: ids.organizationA,
            role: OrganizationRole.REPORTER,
            status: MembershipStatus.ACTIVE,
            userId: ids.reporterA,
          },
          {
            id: ids.responderMembershipA1,
            organizationId: ids.organizationA,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.ACTIVE,
            userId: ids.responderA1,
          },
          {
            id: ids.responderMembershipA2,
            organizationId: ids.organizationA,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.ACTIVE,
            userId: ids.responderA2,
          },
        ],
      });
    });
    await database.$transaction(async (transaction) => {
      await transaction.organization.create({
        data: { id: ids.organizationB, name: 'Lifecycle B', slug: `lifecycle-b-${suffix}` },
      });
      await transaction.organizationMembership.createMany({
        data: [
          {
            id: ids.ownerMembershipB,
            organizationId: ids.organizationB,
            role: OrganizationRole.OWNER,
            status: MembershipStatus.ACTIVE,
            userId: ids.ownerB,
          },
          {
            id: ids.responderMembershipB,
            organizationId: ids.organizationB,
            role: OrganizationRole.RESPONDER,
            status: MembershipStatus.ACTIVE,
            userId: ids.responderB,
          },
        ],
      });
    });
  });

  afterAll(async () => {
    await workerDatabase.$disconnect();
    await database.$disconnect();
  });

  it('creates immutable revisions and keeps existing incidents on their original snapshot', async () => {
    const policy = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) =>
        tenant.policies.create({
          actorMembershipId: ids.ownerMembershipA,
          makeDefault: true,
          name: 'Primary',
          organizationId: ids.organizationA,
          steps: [{ responderMembershipId: ids.responderMembershipA1, waitSeconds: 60 }],
        }),
    );
    expect(policy?.activeVersion?.revision).toBe(1);

    const firstIncident = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.reporterA },
      (tenant) =>
        tenant.incidents.create({
          description: 'The first incident',
          organizationId: ids.organizationA,
          reporterMembershipId: ids.reporterMembershipA,
          severity: IncidentSeverity.SEV2,
          title: 'First incident',
        }),
    );

    const revised = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) =>
        tenant.policies.createRevision(policy!.id, {
          actorMembershipId: ids.ownerMembershipA,
          name: 'Primary revised',
          organizationId: ids.organizationA,
          steps: [{ responderMembershipId: ids.responderMembershipA2, waitSeconds: 120 }],
        }),
    );
    expect(revised?.activeVersion?.revision).toBe(2);
    expect(revised?.versions).toHaveLength(2);

    const secondPolicy = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) =>
        tenant.policies.create({
          actorMembershipId: ids.ownerMembershipA,
          makeDefault: false,
          name: 'Secondary',
          organizationId: ids.organizationA,
          steps: [{ responderMembershipId: ids.responderMembershipA1, waitSeconds: 30 }],
        }),
    );
    await expect(
      database.escalationPolicy.update({
        where: {
          organizationId_id: { id: policy!.id, organizationId: ids.organizationA },
        },
        data: { activeVersionId: secondPolicy!.activeVersionId },
      }),
    ).rejects.toThrow();

    const [unchanged, secondIncident] = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.reporterA },
      async (tenant) => [
        await tenant.incidents.findById(firstIncident.id),
        await tenant.incidents.create({
          description: 'The second incident',
          organizationId: ids.organizationA,
          reporterMembershipId: ids.reporterMembershipA,
          severity: IncidentSeverity.SEV3,
          title: 'Second incident',
        }),
      ],
    );
    expect(unchanged?.policyVersionId).toBe(firstIncident.policyVersionId);
    expect(unchanged?.assignedMembershipId).toBe(ids.responderMembershipA1);
    expect(secondIncident.policyVersionId).toBe(revised?.activeVersionId);
    expect(secondIncident.assignedMembershipId).toBe(ids.responderMembershipA2);

    await expect(
      database.escalationPolicyVersion.update({
        where: {
          organizationId_id: {
            id: firstIncident.policyVersionId,
            organizationId: ids.organizationA,
          },
        },
        data: { revision: 99 },
      }),
    ).rejects.toThrow(/append-only/u);
  });

  it('enforces exact state transitions and records mutations atomically', async () => {
    const incident = await createIncident('Lifecycle command incident');

    await expect(
      unitOfWork.withTenant(
        { organizationId: ids.organizationA, userId: ids.responderA2 },
        (tenant) =>
          tenant.incidents.resolve(incident.id, incident.version, {
            membershipId: ids.responderMembershipA2,
            override: false,
          }),
      ),
    ).rejects.toBeInstanceOf(IncidentConflictError);

    const acknowledged = await commandAsResponder(incident.id, incident.version, 'acknowledge');
    const investigating = await commandAsResponder(
      incident.id,
      acknowledged.version,
      'investigate',
    );
    const resolved = await commandAsResponder(incident.id, investigating.version, 'resolve');
    expect(resolved.status).toBe(IncidentStatus.RESOLVED);
    const summaries = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) => tenant.incidents.summaries(incident.id),
    );
    expect(summaries).toMatchObject([{ lifecycleGeneration: 0, status: 'PENDING', attempts: 0 }]);
    resolutionSummaryId = summaries[0]!.id;

    const counts = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      async (tenant) => ({
        audit: await tenant.transaction.auditLog.count({ where: { incidentId: incident.id } }),
        outbox: await tenant.transaction.outboxEvent.count({
          where: { aggregateId: incident.id },
        }),
      }),
    );
    expect(counts).toEqual({ audit: 4, outbox: 4 });

    const reopened = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) => tenant.incidents.reopen(incident.id, resolved.version, ids.ownerMembershipA),
    );
    expect(reopened).toMatchObject({
      escalationGeneration: 1,
      lifecycleGeneration: 1,
      status: IncidentStatus.OPEN,
    });
    reopenedIncidentId = reopened.id;
    reopenedIncidentVersion = reopened.version;
    expect(
      await unitOfWork.withTenant(
        { organizationId: ids.organizationA, userId: ids.ownerA },
        (tenant) => tenant.incidents.summaries(incident.id),
      ),
    ).toHaveLength(1);
  });

  it('bounds summary timeline at resolution and marks final provider failure unavailable', async () => {
    const [claimed] = await worker.claimIncidentSummaries(10);
    expect(claimed?.summaryId).toBe(resolutionSummaryId);
    const timeline = await worker.summaryTimeline(claimed!);
    expect(timeline.at(-1)?.action).toBe('incident.resolved');
    expect(timeline.map((entry) => entry.action)).not.toContain('incident.reopened');
    expect(timeline.some((entry) => entry.actorName === 'Responder A2')).toBe(true);
    await worker.finishIncidentSummary(claimed!, null, null, 'TIMEOUT_OR_NETWORK');
    const first = await database.incidentSummary.findFirstOrThrow({
      where: { id: resolutionSummaryId },
    });
    expect(first).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      errorCategory: 'TIMEOUT_OR_NETWORK',
    });
    await database.incidentSummary.update({
      where: {
        organizationId_id: {
          organizationId: ids.organizationA,
          id: resolutionSummaryId,
        },
      },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    const [second] = await worker.claimIncidentSummaries(10);
    expect(second?.summaryId).toBe(resolutionSummaryId);
    await worker.finishIncidentSummary(second!, null, null, 'MALFORMED_OUTPUT');
    expect(
      await database.incidentSummary.findFirstOrThrow({ where: { id: resolutionSummaryId } }),
    ).toMatchObject({ status: 'UNAVAILABLE', attempts: 2, errorCategory: 'MALFORMED_OUTPUT' });
    expect(await worker.claimIncidentSummaries(10)).toEqual([]);
  });

  it('stores a completed summary for a reopened generation without replacing the unavailable prior one', async () => {
    const acknowledged = await commandAsResponder(
      reopenedIncidentId,
      reopenedIncidentVersion,
      'acknowledge',
    );
    const investigating = await commandAsResponder(
      reopenedIncidentId,
      acknowledged.version,
      'investigate',
    );
    await commandAsResponder(reopenedIncidentId, investigating.version, 'resolve');
    const [claimed] = await worker.claimIncidentSummaries(10);
    expect(claimed).toMatchObject({
      incidentId: reopenedIncidentId,
      lifecycleGeneration: 1,
      attempts: 1,
    });
    await worker.finishIncidentSummary(
      claimed!,
      'Responder A2 acknowledged and resolved the reopened incident.',
      'llama-3.3-70b-versatile',
      null,
    );
    const summaries = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) => tenant.incidents.summaries(reopenedIncidentId),
    );
    expect(summaries).toMatchObject([
      { lifecycleGeneration: 1, status: 'COMPLETED', attempts: 1 },
      { lifecycleGeneration: 0, status: 'UNAVAILABLE', attempts: 2 },
    ]);
    expect(summaries[0]?.text).toContain('Responder A2');
    const otherTenant = await unitOfWork.withTenant(
      { organizationId: ids.organizationB, userId: ids.ownerB },
      ({ transaction }) =>
        transaction.incidentSummary.findFirst({ where: { id: claimed!.summaryId } }),
    );
    expect(otherTenant).toBeNull();
  });

  it('allows only one simultaneous acknowledgement of the same version', async () => {
    const incident = await createIncident('Concurrent acknowledgement');
    const acknowledge = () =>
      unitOfWork.withTenant(
        { organizationId: ids.organizationA, userId: ids.responderA2 },
        (tenant) =>
          tenant.incidents.acknowledge(incident.id, incident.version, {
            membershipId: ids.responderMembershipA2,
            override: false,
          }),
      );

    const results = await Promise.allSettled([acknowledge(), acknowledge()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection?.status).toBe('rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(IncidentConflictError);
    }
  });

  it('records administrator overrides and rejects stale versions', async () => {
    const incident = await createIncident('Override incident');
    const overridden = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) =>
        tenant.incidents.acknowledge(incident.id, incident.version, {
          membershipId: ids.ownerMembershipA,
          override: true,
        }),
    );
    expect(overridden.status).toBe(IncidentStatus.ACKNOWLEDGED);

    await expect(
      unitOfWork.withTenant({ organizationId: ids.organizationA, userId: ids.ownerA }, (tenant) =>
        tenant.incidents.updateDetails(
          incident.id,
          incident.version,
          { membershipId: ids.ownerMembershipA, override: true },
          { title: 'Stale title' },
        ),
      ),
    ).rejects.toBeInstanceOf(IncidentConflictError);

    const timeline = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) => tenant.incidents.timeline(incident.id, undefined, 50),
    );
    expect(timeline.at(-1)?.metadata).toMatchObject({ override: true });
  });

  it('hides cross-tenant incident identifiers and keeps audit rows append-only', async () => {
    const policyB = await unitOfWork.withTenant(
      { organizationId: ids.organizationB, userId: ids.ownerB },
      (tenant) =>
        tenant.policies.create({
          actorMembershipId: ids.ownerMembershipB,
          makeDefault: true,
          name: 'Other tenant policy',
          organizationId: ids.organizationB,
          steps: [{ responderMembershipId: ids.responderMembershipB, waitSeconds: 60 }],
        }),
    );
    expect(policyB).not.toBeNull();
    const foreignIncident = await unitOfWork.withTenant(
      { organizationId: ids.organizationB, userId: ids.ownerB },
      (tenant) =>
        tenant.incidents.create({
          description: 'Other tenant',
          organizationId: ids.organizationB,
          reporterMembershipId: ids.ownerMembershipB,
          severity: IncidentSeverity.SEV4,
          title: 'Other tenant incident',
        }),
    );

    const hidden = await unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.ownerA },
      (tenant) => tenant.incidents.findById(foreignIncident.id),
    );
    expect(hidden).toBeNull();

    const audit = await database.auditLog.findFirstOrThrow({
      where: { incidentId: foreignIncident.id },
    });
    await expect(
      database.auditLog.update({ where: { id: audit.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/append-only/u);
    await expect(database.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow(
      /append-only/u,
    );
    await expect(
      unitOfWork.withTenant({ organizationId: ids.organizationB, userId: ids.ownerB }, (tenant) =>
        tenant.transaction.auditLog.update({
          where: { id: audit.id },
          data: { action: 'runtime-tamper' },
        }),
      ),
    ).rejects.toThrow();
  });

  async function createIncident(title: string) {
    return unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.reporterA },
      (tenant) =>
        tenant.incidents.create({
          description: `${title} description`,
          organizationId: ids.organizationA,
          reporterMembershipId: ids.reporterMembershipA,
          severity: IncidentSeverity.SEV2,
          title,
        }),
    );
  }

  async function commandAsResponder(
    incidentId: string,
    version: number,
    command: 'acknowledge' | 'investigate' | 'resolve',
  ) {
    return unitOfWork.withTenant(
      { organizationId: ids.organizationA, userId: ids.responderA2 },
      (tenant) => {
        const actor = { membershipId: ids.responderMembershipA2, override: false };
        if (command === 'acknowledge') {
          return tenant.incidents.acknowledge(incidentId, version, actor);
        }
        if (command === 'investigate') {
          return tenant.incidents.startInvestigation(incidentId, version, actor);
        }
        return tenant.incidents.resolve(incidentId, version, actor);
      },
    );
  }
});

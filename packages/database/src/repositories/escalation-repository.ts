import { randomUUID } from 'node:crypto';

import {
  AuditActorType,
  IncidentStatus,
  MembershipStatus,
  OrganizationRole,
  type Incident,
  type Prisma,
} from '../generated/prisma/client.js';

export interface EscalationExpectation {
  expectedDeadline: Date;
  expectedStep: number;
  generation: number;
  incidentId: string;
  organizationId: string;
}

export type ReconciliationCandidate = EscalationExpectation;

export type EscalationOutcome =
  | { outcome: 'STALE' }
  | { incident: Incident; next: EscalationExpectation; outcome: 'ESCALATED' }
  | { incident: Incident; outcome: 'EXHAUSTED' };

interface LockedIncident {
  assignedMembershipId: string;
  currentEscalationStep: number;
  escalationGeneration: number;
  firstEscalatedAt: Date | null;
  id: string;
  nextEscalationAt: Date | null;
  organizationId: string;
  policyVersionId: string;
  status: IncidentStatus;
  version: number;
}

export class EscalationRepository {
  public constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly organizationId: string,
  ) {}

  public async process(expectation: EscalationExpectation): Promise<EscalationOutcome> {
    if (expectation.organizationId !== this.organizationId) return { outcome: 'STALE' };

    const rows = await this.transaction.$queryRaw<LockedIncident[]>`
      SELECT id,
             organization_id AS "organizationId",
             status,
             assigned_membership_id AS "assignedMembershipId",
             policy_version_id AS "policyVersionId",
             current_escalation_step AS "currentEscalationStep",
             escalation_generation AS "escalationGeneration",
             next_escalation_at AS "nextEscalationAt",
             first_escalated_at AS "firstEscalatedAt",
             version
      FROM incidents
      WHERE organization_id = ${this.organizationId}::UUID
        AND id = ${expectation.incidentId}::UUID
      FOR UPDATE
    `;
    const locked = rows[0];
    if (!isCurrentExpectation(locked, expectation)) return { outcome: 'STALE' };

    const steps = await this.transaction.escalationPolicyStep.findMany({
      where: {
        organizationId: this.organizationId,
        policyVersionId: locked.policyVersionId,
        position: { gt: locked.currentEscalationStep },
      },
      orderBy: { position: 'asc' },
    });
    const skipped: number[] = [];

    for (const step of steps) {
      const membership = await this.transaction.organizationMembership.findFirst({
        where: {
          id: step.responderMembershipId,
          organizationId: this.organizationId,
          role: OrganizationRole.RESPONDER,
          status: MembershipStatus.ACTIVE,
        },
      });
      if (membership === null) {
        skipped.push(step.position);
        await this.transaction.auditLog.create({
          data: {
            action: 'incident.escalation-responder-skipped',
            actorType: AuditActorType.SYSTEM,
            incidentId: locked.id,
            metadata: {
              generation: locked.escalationGeneration,
              position: step.position,
              responderMembershipId: step.responderMembershipId,
            },
            organizationId: this.organizationId,
          },
        });
        continue;
      }

      const now = new Date();
      const nextDeadline = addSeconds(now, step.waitSeconds);
      const incident = await this.transaction.incident.update({
        where: {
          organizationId_id: { id: locked.id, organizationId: this.organizationId },
        },
        data: {
          assignedMembershipId: step.responderMembershipId,
          currentEscalationStep: step.position,
          firstEscalatedAt: locked.firstEscalatedAt ?? now,
          nextEscalationAt: nextDeadline,
          version: { increment: 1 },
        },
      });
      await this.recordEvent(incident, 'incident.escalated', {
        fromMembershipId: locked.assignedMembershipId,
        generation: incident.escalationGeneration,
        skippedPositions: skipped,
        step: step.position,
        toMembershipId: incident.assignedMembershipId,
      });
      return {
        incident,
        next: {
          expectedDeadline: nextDeadline,
          expectedStep: step.position,
          generation: incident.escalationGeneration,
          incidentId: incident.id,
          organizationId: incident.organizationId,
        },
        outcome: 'ESCALATED',
      };
    }

    const now = new Date();
    const incident = await this.transaction.incident.update({
      where: { organizationId_id: { id: locked.id, organizationId: this.organizationId } },
      data: {
        escalationExhaustedAt: now,
        firstEscalatedAt: locked.firstEscalatedAt ?? now,
        nextEscalationAt: null,
        version: { increment: 1 },
      },
    });
    await this.recordEvent(incident, 'incident.escalation-exhausted', {
      alertRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN],
      assignedMembershipId: incident.assignedMembershipId,
      generation: incident.escalationGeneration,
      skippedPositions: skipped,
    });
    return { incident, outcome: 'EXHAUSTED' };
  }

  private async recordEvent(
    incident: Incident,
    action: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    const audit = await this.transaction.auditLog.create({
      data: {
        action,
        actorType: AuditActorType.SYSTEM,
        incidentId: incident.id,
        metadata: { ...metadata, resultingVersion: incident.version },
        organizationId: this.organizationId,
      },
    });
    await this.transaction.outboxEvent.create({
      data: {
        aggregateId: incident.id,
        aggregateType: 'incident',
        deduplicationKey: `${action}:${incident.id}:${incident.escalationGeneration}:${incident.currentEscalationStep}`,
        eventType: action,
        id: randomUUID(),
        organizationId: this.organizationId,
        payload: {
          auditId: audit.id.toString(),
          incidentId: incident.id,
          ...metadata,
          status: incident.status,
          version: incident.version,
        },
      },
    });
  }
}

function isCurrentExpectation(
  incident: LockedIncident | undefined,
  expectation: EscalationExpectation,
): incident is LockedIncident {
  return (
    incident !== undefined &&
    incident.status === IncidentStatus.OPEN &&
    incident.escalationGeneration === expectation.generation &&
    incident.currentEscalationStep === expectation.expectedStep &&
    incident.nextEscalationAt !== null &&
    incident.nextEscalationAt.getTime() === expectation.expectedDeadline.getTime() &&
    incident.nextEscalationAt.getTime() <= Date.now()
  );
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

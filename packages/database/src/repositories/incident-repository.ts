import { randomUUID } from 'node:crypto';

import {
  AuditActorType,
  IncidentStatus,
  MembershipStatus,
  OrganizationRole,
  type Incident,
  type IncidentSeverity,
  type Prisma,
} from '../generated/prisma/client.js';

export class IncidentNotFoundError extends Error {
  public constructor() {
    super('The incident is unavailable.');
    this.name = 'IncidentNotFoundError';
  }
}

export class IncidentConflictError extends Error {
  public constructor(public readonly current: Incident) {
    super('The incident changed before this command could be applied.');
    this.name = 'IncidentConflictError';
  }
}

export class DefaultEscalationPolicyRequiredError extends Error {
  public constructor() {
    super('An active default escalation policy is required.');
    this.name = 'DefaultEscalationPolicyRequiredError';
  }
}

export class InvalidIncidentAssigneeError extends Error {
  public constructor() {
    super('The selected assignee must be an active responder.');
    this.name = 'InvalidIncidentAssigneeError';
  }
}

interface IncidentActor {
  membershipId: string;
  override: boolean;
}

export class IncidentRepository {
  public constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly organizationId: string,
  ) {}

  public list(status?: IncidentStatus): Promise<Incident[]> {
    return this.transaction.incident.findMany({
      where: { organizationId: this.organizationId, ...(status === undefined ? {} : { status }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  public findById(id: string): Promise<Incident | null> {
    return this.transaction.incident.findFirst({
      where: { id, organizationId: this.organizationId },
    });
  }

  public async create(input: {
    description: string;
    organizationId: string;
    reporterMembershipId: string;
    severity: IncidentSeverity;
    title: string;
  }): Promise<Incident> {
    if (input.organizationId !== this.organizationId) throw new IncidentNotFoundError();
    const organization = await this.transaction.organization.update({
      where: { id: input.organizationId },
      data: { nextIncidentNumber: { increment: 1 } },
      select: { defaultEscalationPolicyId: true, nextIncidentNumber: true },
    });
    if (organization.defaultEscalationPolicyId === null) {
      throw new DefaultEscalationPolicyRequiredError();
    }

    const policy = await this.transaction.escalationPolicy.findFirst({
      where: {
        archivedAt: null,
        id: organization.defaultEscalationPolicyId,
        organizationId: this.organizationId,
      },
      include: {
        activeVersion: { include: { steps: { orderBy: { position: 'asc' } } } },
      },
    });
    const version = policy?.activeVersion;
    const firstStep = version?.steps[0];
    if (version === null || version === undefined || firstStep === undefined) {
      throw new DefaultEscalationPolicyRequiredError();
    }

    const incident = await this.transaction.incident.create({
      data: {
        assignedMembershipId: firstStep.responderMembershipId,
        description: input.description,
        id: randomUUID(),
        nextEscalationAt: addSeconds(new Date(), firstStep.waitSeconds),
        organizationId: input.organizationId,
        policyVersionId: version.id,
        referenceNumber: organization.nextIncidentNumber - 1,
        reporterMembershipId: input.reporterMembershipId,
        severity: input.severity,
        title: input.title,
      },
    });
    await this.recordMutation(incident, 'incident.created', input.reporterMembershipId, false, {
      assignedMembershipId: incident.assignedMembershipId,
      policyRevision: version.revision,
    });
    return incident;
  }

  public updateDetails(
    id: string,
    expectedVersion: number,
    actor: IncidentActor,
    data: {
      description?: string | undefined;
      severity?: IncidentSeverity | undefined;
      title?: string | undefined;
    },
  ): Promise<Incident> {
    return this.applyCommand({
      action: 'incident.details-updated',
      actor,
      data: {
        ...(data.description === undefined ? {} : { description: data.description }),
        ...(data.severity === undefined ? {} : { severity: data.severity }),
        ...(data.title === undefined ? {} : { title: data.title }),
      },
      expectedVersion,
      id,
      where: {},
    });
  }

  public acknowledge(id: string, expectedVersion: number, actor: IncidentActor): Promise<Incident> {
    return this.applyCommand({
      action: 'incident.acknowledged',
      actor,
      data: {
        acknowledgedAt: new Date(),
        nextEscalationAt: null,
        status: IncidentStatus.ACKNOWLEDGED,
      },
      expectedVersion,
      id,
      where: {
        ...(actor.override ? {} : { assignedMembershipId: actor.membershipId }),
        status: IncidentStatus.OPEN,
      },
    });
  }

  public startInvestigation(
    id: string,
    expectedVersion: number,
    actor: IncidentActor,
  ): Promise<Incident> {
    return this.applyCommand({
      action: 'incident.investigation-started',
      actor,
      data: { investigatingAt: new Date(), status: IncidentStatus.INVESTIGATING },
      expectedVersion,
      id,
      where: {
        ...(actor.override ? {} : { assignedMembershipId: actor.membershipId }),
        status: IncidentStatus.ACKNOWLEDGED,
      },
    });
  }

  public resolve(id: string, expectedVersion: number, actor: IncidentActor): Promise<Incident> {
    return this.applyCommand({
      action: 'incident.resolved',
      actor,
      data: { resolvedAt: new Date(), status: IncidentStatus.RESOLVED },
      expectedVersion,
      id,
      where: {
        ...(actor.override ? {} : { assignedMembershipId: actor.membershipId }),
        status: IncidentStatus.INVESTIGATING,
      },
    });
  }

  public async reopen(
    id: string,
    expectedVersion: number,
    actorMembershipId: string,
  ): Promise<Incident> {
    const current = await this.transaction.incident.findFirst({
      where: { id, organizationId: this.organizationId },
      include: {
        policyVersion: { include: { steps: { orderBy: { position: 'asc' }, take: 1 } } },
      },
    });
    if (current === null) throw new IncidentNotFoundError();
    const firstStep = current.policyVersion.steps[0];
    if (firstStep === undefined) throw new DefaultEscalationPolicyRequiredError();

    return this.applyCommand({
      action: 'incident.reopened',
      actor: { membershipId: actorMembershipId, override: true },
      data: {
        acknowledgedAt: null,
        assignedMembershipId: firstStep.responderMembershipId,
        currentEscalationStep: 0,
        escalationExhaustedAt: null,
        escalationGeneration: { increment: 1 },
        firstEscalatedAt: null,
        investigatingAt: null,
        nextEscalationAt: addSeconds(new Date(), firstStep.waitSeconds),
        resolvedAt: null,
        status: IncidentStatus.OPEN,
      },
      expectedVersion,
      id,
      where: { status: IncidentStatus.RESOLVED },
    });
  }

  public async reassign(
    id: string,
    expectedVersion: number,
    actorMembershipId: string,
    assignedMembershipId: string,
  ): Promise<Incident> {
    const [assignee, current] = await Promise.all([
      this.transaction.organizationMembership.findFirst({
        where: {
          id: assignedMembershipId,
          organizationId: this.organizationId,
          role: OrganizationRole.RESPONDER,
          status: MembershipStatus.ACTIVE,
        },
      }),
      this.transaction.incident.findFirst({
        where: { id, organizationId: this.organizationId },
        include: {
          policyVersion: { include: { steps: { orderBy: { position: 'asc' }, take: 1 } } },
        },
      }),
    ]);
    if (assignee === null) throw new InvalidIncidentAssigneeError();
    if (current === null) throw new IncidentNotFoundError();
    const firstStep = current.policyVersion.steps[0];
    if (firstStep === undefined) throw new DefaultEscalationPolicyRequiredError();

    return this.applyCommand({
      action: 'incident.reassigned',
      actor: { membershipId: actorMembershipId, override: true },
      data: {
        acknowledgedAt: null,
        assignedMembershipId,
        currentEscalationStep: -1,
        escalationExhaustedAt: null,
        escalationGeneration: { increment: 1 },
        firstEscalatedAt: null,
        investigatingAt: null,
        nextEscalationAt: addSeconds(new Date(), firstStep.waitSeconds),
        resolvedAt: null,
        status: IncidentStatus.OPEN,
      },
      expectedVersion,
      id,
      metadata: { assignedMembershipId },
      where: { status: { not: IncidentStatus.RESOLVED } },
    });
  }

  public timeline(incidentId: string, after: bigint | undefined, limit: number) {
    return this.transaction.auditLog.findMany({
      where: {
        incidentId,
        organizationId: this.organizationId,
        ...(after === undefined ? {} : { id: { gt: after } }),
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  private async applyCommand(input: {
    action: string;
    actor: IncidentActor;
    data: Prisma.IncidentUncheckedUpdateManyInput;
    expectedVersion: number;
    id: string;
    metadata?: Prisma.InputJsonObject;
    where: Prisma.IncidentWhereInput;
  }): Promise<Incident> {
    const result = await this.transaction.incident.updateMany({
      where: {
        id: input.id,
        organizationId: this.organizationId,
        version: input.expectedVersion,
        ...input.where,
      },
      data: { ...input.data, version: { increment: 1 } },
    });
    const current = await this.transaction.incident.findFirst({
      where: { id: input.id, organizationId: this.organizationId },
    });
    if (current === null) throw new IncidentNotFoundError();
    if (result.count === 0) throw new IncidentConflictError(current);

    await this.recordMutation(
      current,
      input.action,
      input.actor.membershipId,
      input.actor.override,
      input.metadata,
    );
    return current;
  }

  private async recordMutation(
    incident: Incident,
    action: string,
    actorMembershipId: string,
    override: boolean,
    metadata: Prisma.InputJsonObject = {},
  ): Promise<void> {
    const audit = await this.transaction.auditLog.create({
      data: {
        action,
        actorMembershipId,
        actorType: AuditActorType.USER,
        incidentId: incident.id,
        metadata: { ...metadata, override, resultingVersion: incident.version },
        organizationId: incident.organizationId,
      },
    });
    await this.transaction.outboxEvent.create({
      data: {
        aggregateId: incident.id,
        aggregateType: 'incident',
        deduplicationKey: `${action}:${incident.id}:${incident.version}`,
        eventType: action,
        id: randomUUID(),
        organizationId: incident.organizationId,
        payload: {
          auditId: audit.id.toString(),
          incidentId: incident.id,
          status: incident.status,
          version: incident.version,
        },
      },
    });
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

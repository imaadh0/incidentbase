import { randomUUID } from 'node:crypto';

import {
  AuditActorType,
  MembershipStatus,
  OrganizationRole,
  type Prisma,
} from '../generated/prisma/client.js';

export interface EscalationPolicyStepInput {
  responderMembershipId: string;
  waitSeconds: number;
}

interface PolicyInput {
  actorMembershipId: string;
  description?: string | undefined;
  name: string;
  organizationId: string;
  steps: readonly EscalationPolicyStepInput[];
}

export class InvalidPolicyResponderError extends Error {
  public constructor() {
    super('Every policy step must reference a distinct active responder membership.');
    this.name = 'InvalidPolicyResponderError';
  }
}

export class PolicyUnavailableError extends Error {
  public constructor() {
    super('The escalation policy is unavailable.');
    this.name = 'PolicyUnavailableError';
  }
}

export class DefaultPolicyArchiveError extends Error {
  public constructor() {
    super('The default escalation policy cannot be archived.');
    this.name = 'DefaultPolicyArchiveError';
  }
}

export class EscalationPolicyRepository {
  public constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly organizationId: string,
  ) {}

  public list() {
    return this.transaction.escalationPolicy.findMany({
      include: {
        activeVersion: { include: { steps: { orderBy: { position: 'asc' } } } },
      },
      orderBy: { createdAt: 'asc' },
      where: { organizationId: this.organizationId },
    });
  }

  public findById(id: string) {
    return this.transaction.escalationPolicy.findFirst({
      where: { id, organizationId: this.organizationId },
      include: {
        activeVersion: { include: { steps: { orderBy: { position: 'asc' } } } },
        versions: {
          include: { steps: { orderBy: { position: 'asc' } } },
          orderBy: { revision: 'desc' },
        },
      },
    });
  }

  public async create(input: PolicyInput & { makeDefault: boolean }) {
    if (input.organizationId !== this.organizationId) throw new PolicyUnavailableError();
    await this.assertResponders(input.steps);
    const policyId = randomUUID();
    const versionId = randomUUID();

    await this.transaction.escalationPolicy.create({
      data: {
        ...(input.description === undefined ? {} : { description: input.description }),
        id: policyId,
        name: input.name,
        nextRevision: 2,
        organizationId: input.organizationId,
      },
    });
    await this.createVersionRows(input.organizationId, policyId, versionId, 1, input.steps);
    await this.transaction.escalationPolicy.update({
      where: { organizationId_id: { id: policyId, organizationId: input.organizationId } },
      data: { activeVersionId: versionId },
    });

    const organization = await this.transaction.organization.findUnique({
      where: { id: input.organizationId },
      select: { defaultEscalationPolicyId: true },
    });
    if (input.makeDefault || organization?.defaultEscalationPolicyId === null) {
      await this.transaction.organization.update({
        where: { id: input.organizationId },
        data: { defaultEscalationPolicyId: policyId },
      });
    }

    await this.recordChange({
      action: 'policy.created',
      actorMembershipId: input.actorMembershipId,
      aggregateId: policyId,
      eventType: 'policy.created',
      metadata: { policyId, revision: 1 },
      organizationId: input.organizationId,
      version: 1,
    });
    return this.findById(policyId);
  }

  public async createRevision(policyId: string, input: PolicyInput) {
    if (input.organizationId !== this.organizationId) throw new PolicyUnavailableError();
    await this.assertResponders(input.steps);
    const updated = await this.transaction.$queryRaw<Array<{ revision: number }>>`
      UPDATE escalation_policies
      SET next_revision = next_revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE organization_id = ${input.organizationId}::UUID
        AND id = ${policyId}::UUID
        AND archived_at IS NULL
      RETURNING next_revision - 1 AS revision
    `;
    const revision = updated[0]?.revision;
    if (revision === undefined) throw new PolicyUnavailableError();

    const versionId = randomUUID();
    await this.createVersionRows(input.organizationId, policyId, versionId, revision, input.steps);
    await this.transaction.escalationPolicy.update({
      where: { organizationId_id: { id: policyId, organizationId: input.organizationId } },
      data: {
        activeVersionId: versionId,
        ...(input.description === undefined ? {} : { description: input.description }),
        name: input.name,
      },
    });
    await this.recordChange({
      action: 'policy.revised',
      actorMembershipId: input.actorMembershipId,
      aggregateId: policyId,
      eventType: 'policy.revised',
      metadata: { policyId, revision },
      organizationId: input.organizationId,
      version: revision,
    });
    return this.findById(policyId);
  }

  public async setDefault(organizationId: string, policyId: string, actorMembershipId: string) {
    if (organizationId !== this.organizationId) throw new PolicyUnavailableError();
    const policy = await this.transaction.escalationPolicy.findFirst({
      where: { archivedAt: null, id: policyId, organizationId: this.organizationId },
    });
    if (policy === null || policy.activeVersionId === null) throw new PolicyUnavailableError();

    await this.transaction.organization.update({
      where: { id: organizationId },
      data: { defaultEscalationPolicyId: policyId },
    });
    await this.recordChange({
      action: 'policy.default-selected',
      actorMembershipId,
      aggregateId: policyId,
      eventType: 'policy.default-selected',
      metadata: { policyId },
      organizationId,
      version: policy.nextRevision - 1,
    });
    return this.findById(policyId);
  }

  public async archive(organizationId: string, policyId: string, actorMembershipId: string) {
    if (organizationId !== this.organizationId) throw new PolicyUnavailableError();
    const organization = await this.transaction.organization.findUnique({
      where: { id: organizationId },
      select: { defaultEscalationPolicyId: true },
    });
    if (organization?.defaultEscalationPolicyId === policyId) {
      throw new DefaultPolicyArchiveError();
    }
    const result = await this.transaction.escalationPolicy.updateMany({
      where: { archivedAt: null, id: policyId, organizationId: this.organizationId },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) throw new PolicyUnavailableError();

    await this.recordChange({
      action: 'policy.archived',
      actorMembershipId,
      aggregateId: policyId,
      eventType: 'policy.archived',
      metadata: { policyId },
      organizationId,
      version: 0,
    });
  }

  private async assertResponders(steps: readonly EscalationPolicyStepInput[]): Promise<void> {
    const responderIds = [...new Set(steps.map((step) => step.responderMembershipId))];
    const count = await this.transaction.organizationMembership.count({
      where: {
        id: { in: responderIds },
        organizationId: this.organizationId,
        role: OrganizationRole.RESPONDER,
        status: MembershipStatus.ACTIVE,
      },
    });
    if (responderIds.length !== steps.length || count !== steps.length) {
      throw new InvalidPolicyResponderError();
    }
  }

  private async createVersionRows(
    organizationId: string,
    policyId: string,
    versionId: string,
    revision: number,
    steps: readonly EscalationPolicyStepInput[],
  ): Promise<void> {
    await this.transaction.escalationPolicyVersion.create({
      data: { id: versionId, organizationId, policyId, revision },
    });
    await this.transaction.escalationPolicyStep.createMany({
      data: steps.map((step, position) => ({
        id: randomUUID(),
        organizationId,
        policyVersionId: versionId,
        position,
        responderMembershipId: step.responderMembershipId,
        waitSeconds: step.waitSeconds,
      })),
    });
  }

  private async recordChange(input: {
    action: string;
    actorMembershipId: string;
    aggregateId: string;
    eventType: string;
    metadata: Prisma.InputJsonValue;
    organizationId: string;
    version: number;
  }): Promise<void> {
    const audit = await this.transaction.auditLog.create({
      data: {
        action: input.action,
        actorMembershipId: input.actorMembershipId,
        actorType: AuditActorType.USER,
        metadata: input.metadata,
        organizationId: input.organizationId,
      },
    });
    await this.transaction.outboxEvent.create({
      data: {
        aggregateId: input.aggregateId,
        aggregateType: 'escalation-policy',
        deduplicationKey: `${input.eventType}:${input.aggregateId}:${input.version}:${audit.id}`,
        eventType: input.eventType,
        id: randomUUID(),
        organizationId: input.organizationId,
        payload: { auditId: audit.id.toString(), policyId: input.aggregateId },
      },
    });
  }
}

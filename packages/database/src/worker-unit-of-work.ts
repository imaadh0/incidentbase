import type { Prisma } from './generated/prisma/client.js';
import type { DatabaseClient } from './client.js';
import {
  EscalationRepository,
  type EscalationExpectation,
  type EscalationOutcome,
  type ReconciliationCandidate,
} from './repositories/escalation-repository.js';

export interface WorkerOrganizationContext {
  organizationId: string;
}

export interface WorkerTransaction {
  escalation: EscalationRepository;
  transaction: Prisma.TransactionClient;
}

export interface ClaimedOutboxEvent {
  aggregateId: string;
  aggregateType: string;
  attempts: number;
  eventId: string;
  eventType: string;
  organizationId: string;
  payload: unknown;
}

export interface RealtimeIncidentDetails {
  recipientUserId?: string | undefined;
  referenceNumber: number;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED';
  title: string;
  version: number;
}

export class WorkerUnitOfWork {
  public constructor(private readonly client: DatabaseClient) {}

  public withOrganization<T>(
    context: WorkerOrganizationContext,
    operation: (worker: WorkerTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE incidentbase_worker');
      await transaction.$queryRaw`
        SELECT set_config('app.current_organization_id', ${context.organizationId}, true)
      `;
      return operation({
        escalation: new EscalationRepository(transaction, context.organizationId),
        transaction,
      });
    });
  }

  public process(expectation: EscalationExpectation): Promise<EscalationOutcome> {
    return this.withOrganization({ organizationId: expectation.organizationId }, (worker) =>
      worker.escalation.process(expectation),
    );
  }

  public reconciliationCandidates(
    horizon: Date,
    limit = 1_000,
  ): Promise<ReconciliationCandidate[]> {
    return this.client.$queryRaw<ReconciliationCandidate[]>`
      SELECT organization_id AS "organizationId",
             incident_id AS "incidentId",
             escalation_generation AS "generation",
             current_escalation_step AS "expectedStep",
             next_escalation_at AS "expectedDeadline"
      FROM app.worker_reconciliation_candidates(${horizon}, ${limit})
    `;
  }

  public claimOutboxEvents(limit = 100): Promise<ClaimedOutboxEvent[]> {
    return this.client.$queryRaw<ClaimedOutboxEvent[]>`
      SELECT organization_id AS "organizationId",
             event_id AS "eventId",
             aggregate_type AS "aggregateType",
             aggregate_id AS "aggregateId",
             event_type AS "eventType",
             payload,
             attempts
      FROM app.worker_claim_outbox_events(${limit})
    `;
  }

  public async publishOutboxEvent(organizationId: string, eventId: string): Promise<void> {
    await this.client.$queryRaw`
      SELECT app.worker_publish_outbox_event(${organizationId}::UUID, ${eventId}::UUID)::text
    `;
  }

  public async retryOutboxEvent(
    organizationId: string,
    eventId: string,
    message: string,
  ): Promise<void> {
    await this.client.$queryRaw`
      SELECT app.worker_retry_outbox_event(
        ${organizationId}::UUID,
        ${eventId}::UUID,
        ${message}
      )::text
    `;
  }

  public realtimeIncidentDetails(
    organizationId: string,
    incidentId: string,
    recipientMembershipId?: string,
  ): Promise<RealtimeIncidentDetails | null> {
    return this.withOrganization({ organizationId }, async ({ transaction }) => {
      const incident = await transaction.incident.findFirst({
        where: { id: incidentId, organizationId },
        select: { referenceNumber: true, status: true, title: true, version: true },
      });
      if (incident === null) return null;
      const recipient =
        recipientMembershipId === undefined
          ? null
          : await transaction.organizationMembership.findFirst({
              where: { id: recipientMembershipId, organizationId },
              select: { userId: true },
            });
      return {
        ...incident,
        ...(recipient === null ? {} : { recipientUserId: recipient.userId }),
      };
    });
  }
}

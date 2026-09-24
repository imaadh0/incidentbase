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

export interface ClaimedNotificationDelivery {
  organizationId: string;
  deliveryId: string;
  eventId: string;
  channel: 'EMAIL' | 'SLACK' | 'DISCORD';
  recipient: string;
  deliveryKey: string;
  subject: string;
  body: string;
  attempts: number;
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

  public async stageIncidentNotifications(event: ClaimedOutboxEvent): Promise<void> {
    const assignmentEvents = new Set([
      'incident.created',
      'incident.reassigned',
      'incident.reopened',
      'incident.escalated',
    ]);
    if (
      event.aggregateType !== 'incident' ||
      (!assignmentEvents.has(event.eventType) &&
        event.eventType !== 'incident.escalation-exhausted')
    )
      return;

    await this.withOrganization(
      { organizationId: event.organizationId },
      async ({ transaction }) => {
        const settings = await transaction.notificationSetting.findUnique({
          where: { organizationId: event.organizationId },
        });
        if (
          settings === null ||
          (!settings.emailEnabled && !settings.slackEnabled && !settings.discordEnabled)
        )
          return;
        const incident = await transaction.incident.findFirst({
          where: { organizationId: event.organizationId, id: event.aggregateId },
          select: { title: true, referenceNumber: true },
        });
        if (incident === null) return;
        const payload =
          typeof event.payload === 'object' &&
          event.payload !== null &&
          !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const exhausted = event.eventType === 'incident.escalation-exhausted';
        const assignedId = payload.assignedMembershipId;
        if (!exhausted && typeof assignedId !== 'string')
          throw new Error('Notification event has no assignee.');
        const subject = exhausted
          ? `Incident #${incident.referenceNumber} escalation exhausted`
          : `Incident #${incident.referenceNumber} assigned to you`;
        const body = `${subject}: ${incident.title}`;
        const rows: Array<{ membershipId: string; email: string }> = settings.emailEnabled
          ? await transaction.$queryRaw`
            SELECT membership_id AS "membershipId", email
            FROM app.worker_notification_recipients(
              ${event.organizationId}::UUID, ${exhausted ? null : assignedId}::UUID
            )
          `
          : [];
        const deliveries = [
          ...rows.map((row) => ({
            organizationId: event.organizationId,
            eventId: event.eventId,
            channel: 'EMAIL' as const,
            recipient: row.email,
            deliveryKey: `${event.eventId}:EMAIL:${row.membershipId}`,
            subject,
            body,
          })),
          ...(settings.slackEnabled
            ? [
                {
                  organizationId: event.organizationId,
                  eventId: event.eventId,
                  channel: 'SLACK' as const,
                  recipient: 'Slack webhook',
                  deliveryKey: `${event.eventId}:SLACK`,
                  subject,
                  body,
                },
              ]
            : []),
          ...(settings.discordEnabled
            ? [
                {
                  organizationId: event.organizationId,
                  eventId: event.eventId,
                  channel: 'DISCORD' as const,
                  recipient: 'Discord webhook',
                  deliveryKey: `${event.eventId}:DISCORD`,
                  subject,
                  body,
                },
              ]
            : []),
        ];
        if (deliveries.length > 0)
          await transaction.notificationDelivery.createMany({
            data: deliveries,
            skipDuplicates: true,
          });
      },
    );
  }

  public claimNotificationDeliveries(limit = 100): Promise<ClaimedNotificationDelivery[]> {
    return this.client.$queryRaw`
      SELECT organization_id AS "organizationId", delivery_id AS "deliveryId",
        event_id AS "eventId", channel, recipient, delivery_key AS "deliveryKey",
        subject, body, attempts
      FROM app.worker_claim_notification_deliveries(${limit})
    `;
  }

  public async finishNotificationDelivery(
    delivery: ClaimedNotificationDelivery,
    providerId: string | null,
    error: string | null,
    retryable: boolean,
  ): Promise<void> {
    await this.client.$queryRaw`
      SELECT app.worker_finish_notification_delivery(
        ${delivery.organizationId}::UUID, ${delivery.deliveryId}::UUID,
        ${providerId}, ${error}, ${retryable}
      )::text
    `;
  }

  public notificationWebhookCiphertext(
    organizationId: string,
    channel: 'SLACK' | 'DISCORD',
  ): Promise<string | null> {
    return this.withOrganization({ organizationId }, async ({ transaction }) => {
      const settings = await transaction.notificationSetting.findUnique({
        where: { organizationId },
      });
      if (settings === null) return null;
      return channel === 'SLACK'
        ? settings.slackEnabled
          ? settings.slackWebhookCiphertext
          : null
        : settings.discordEnabled
          ? settings.discordWebhookCiphertext
          : null;
    });
  }
}

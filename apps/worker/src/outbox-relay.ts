import {
  REALTIME_REDIS_CHANNEL,
  realtimeIncidentEventSchema,
  type RealtimeIncidentEvent,
} from '@incidentbase/contracts';
import type { ClaimedOutboxEvent, WorkerUnitOfWork } from '@incidentbase/database';

interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

type OutboxSource = Pick<
  WorkerUnitOfWork,
  'claimOutboxEvents' | 'publishOutboxEvent' | 'realtimeIncidentDetails' | 'retryOutboxEvent'
>;

export interface OutboxRelayResult {
  failed: number;
  published: number;
}

export class OutboxRelay {
  public constructor(
    private readonly unitOfWork: OutboxSource,
    private readonly publisher: RedisPublisher,
    private readonly batchSize: number,
  ) {}

  public async runOnce(): Promise<OutboxRelayResult> {
    const events = await this.unitOfWork.claimOutboxEvents(this.batchSize);
    let failed = 0;
    let published = 0;

    for (const event of events) {
      try {
        const realtimeEvent = await this.toRealtimeEvent(event);
        if (realtimeEvent !== null) {
          await this.publisher.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(realtimeEvent));
        }
        await this.unitOfWork.publishOutboxEvent(event.organizationId, event.eventId);
        published += 1;
      } catch (error: unknown) {
        failed += 1;
        await this.unitOfWork.retryOutboxEvent(
          event.organizationId,
          event.eventId,
          error instanceof Error ? error.message : 'Unknown outbox relay failure',
        );
      }
    }

    return { failed, published };
  }

  private async toRealtimeEvent(event: ClaimedOutboxEvent): Promise<RealtimeIncidentEvent | null> {
    if (event.aggregateType !== 'incident') return null;
    const payload = asRecord(event.payload);
    const auditId = readString(payload, 'auditId');
    const recipientMembershipId = readString(payload, 'assignedMembershipId', false);
    const details = await this.unitOfWork.realtimeIncidentDetails(
      event.organizationId,
      event.aggregateId,
      recipientMembershipId,
    );
    if (details === null) return null;

    return realtimeIncidentEventSchema.parse({
      auditId,
      eventId: event.eventId,
      eventType: event.eventType,
      incidentId: event.aggregateId,
      organizationId: event.organizationId,
      ...(details.recipientUserId === undefined
        ? {}
        : { recipientUserId: details.recipientUserId }),
      referenceNumber: details.referenceNumber,
      status: readString(payload, 'status'),
      title: details.title,
      version: readNumber(payload, 'version'),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Outbox payload must be an object.');
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const field = value[key];
  if (typeof field === 'string') return field;
  if (!required && field === undefined) return undefined;
  throw new Error(`Outbox payload field ${key} must be a string.`);
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') {
    throw new Error(`Outbox payload field ${key} must be a number.`);
  }
  return field;
}

import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { REALTIME_REDIS_CHANNEL, realtimeIncidentEventSchema } from '@incidentbase/contracts';
import type { ClaimedOutboxEvent, WorkerUnitOfWork } from '@incidentbase/database';

import { OutboxRelay } from '../src/outbox-relay.js';

function incidentEvent(): ClaimedOutboxEvent {
  return {
    aggregateId: randomUUID(),
    aggregateType: 'incident',
    attempts: 1,
    eventId: randomUUID(),
    eventType: 'incident.assigned',
    organizationId: randomUUID(),
    payload: {
      assignedMembershipId: randomUUID(),
      auditId: '42',
      status: 'OPEN',
      version: 2,
    },
  };
}

describe('outbox relay', () => {
  it('publishes a committed incident invalidation and completes the outbox event', async () => {
    const event = incidentEvent();
    const publish = vi.fn<(channel: string, message: string) => Promise<number>>(() =>
      Promise.resolve(1),
    );
    const source = createSource(event);
    const relay = new OutboxRelay(source, { publish }, 25);

    await expect(relay.runOnce()).resolves.toEqual({ failed: 0, published: 1 });
    expect(source.claimOutboxEvents).toHaveBeenCalledWith(25);
    expect(publish).toHaveBeenCalledOnce();
    const [channel, message] = publish.mock.calls[0] ?? [];
    expect(channel).toBe(REALTIME_REDIS_CHANNEL);
    expect(realtimeIncidentEventSchema.parse(JSON.parse(message ?? 'null'))).toMatchObject({
      auditId: '42',
      eventId: event.eventId,
      incidentId: event.aggregateId,
      organizationId: event.organizationId,
    });
    expect(source.publishOutboxEvent).toHaveBeenCalledWith(event.organizationId, event.eventId);
    expect(source.retryOutboxEvent).not.toHaveBeenCalled();
  });

  it('returns failed work to the durable outbox when Redis publication fails', async () => {
    const event = incidentEvent();
    const source = createSource(event);
    const relay = new OutboxRelay(
      source,
      { publish: vi.fn(() => Promise.reject(new Error('Redis unavailable'))) },
      25,
    );

    await expect(relay.runOnce()).resolves.toEqual({ failed: 1, published: 0 });
    expect(source.publishOutboxEvent).not.toHaveBeenCalled();
    expect(source.retryOutboxEvent).toHaveBeenCalledWith(
      event.organizationId,
      event.eventId,
      'Redis unavailable',
    );
  });
});

function createSource(event: ClaimedOutboxEvent) {
  return {
    claimOutboxEvents: vi.fn(() => Promise.resolve([event])),
    publishOutboxEvent: vi.fn(() => Promise.resolve()),
    realtimeIncidentDetails: vi.fn(() =>
      Promise.resolve({
        recipientUserId: randomUUID(),
        referenceNumber: 17,
        status: 'OPEN' as const,
        title: 'Database latency',
        version: 2,
      }),
    ),
    retryOutboxEvent: vi.fn(() => Promise.resolve()),
  } satisfies Pick<
    WorkerUnitOfWork,
    'claimOutboxEvents' | 'publishOutboxEvent' | 'realtimeIncidentDetails' | 'retryOutboxEvent'
  >;
}

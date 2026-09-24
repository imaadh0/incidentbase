import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NotificationSecretCodec,
  type ClaimedNotificationDelivery,
  type WorkerUnitOfWork,
} from '@incidentbase/database';
import { NotificationDeliveryProcessor } from '../src/notification-delivery.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

const key = '0123456789abcdef'.repeat(4);
const organizationId = randomUUID();
const codec = new NotificationSecretCodec(key);

function delivery(channel: ClaimedNotificationDelivery['channel']): ClaimedNotificationDelivery {
  return {
    organizationId,
    deliveryId: randomUUID(),
    eventId: randomUUID(),
    channel,
    recipient: channel === 'EMAIL' ? 'oncall@example.test' : `${channel} webhook`,
    deliveryKey: randomUUID(),
    subject: 'Incident assigned',
    body: 'Incident #42: Database outage',
    attempts: 1,
  };
}

async function mockProvider(
  handler: (request: { path: string; body: unknown; headers: Record<string, unknown> }) => {
    status: number;
    body: string;
    contentType?: string;
  },
) {
  server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const result = handler({
        path: request.url ?? '',
        body: JSON.parse(raw) as unknown,
        headers: request.headers,
      });
      response.writeHead(result.status, {
        'content-type': result.contentType ?? 'application/json',
      });
      response.end(result.body);
    })();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No mock address.');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const fetcher: typeof fetch = (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    return fetch(`${endpoint}${url.pathname}${url.search}`, init);
  };
  return { endpoint, fetcher };
}

function source(deliveries: ClaimedNotificationDelivery[], ciphertext: string | null = null) {
  return {
    claimNotificationDeliveries: vi.fn(() => Promise.resolve(deliveries.splice(0))),
    finishNotificationDelivery: vi.fn(() => Promise.resolve()),
    notificationWebhookCiphertext: vi.fn(() => Promise.resolve(ciphertext)),
  } satisfies Pick<
    WorkerUnitOfWork,
    'claimNotificationDeliveries' | 'finishNotificationDelivery' | 'notificationWebhookCiphertext'
  >;
}

describe('notification delivery with mock providers', () => {
  it('sends Resend email with a stable idempotency key and records provider ID', async () => {
    const item = delivery('EMAIL');
    const requests: unknown[] = [];
    const mock = await mockProvider((request) => {
      requests.push(request);
      return { status: 200, body: JSON.stringify({ id: 'email-123' }) };
    });
    const db = source([item]);
    const processor = new NotificationDeliveryProcessor(db, {
      encryptionKey: key,
      resendApiKey: 'test',
      resendFromEmail: 'alerts@example.test',
      resendEndpoint: `${mock.endpoint}/emails`,
      fetcher: mock.fetcher,
    });
    expect(await processor.runOnce()).toEqual({ sent: 1, failed: 0 });
    expect(db.finishNotificationDelivery).toHaveBeenCalledWith(item, 'email-123', null, false);
    expect(requests).toMatchObject([
      { path: '/emails', headers: { 'idempotency-key': item.deliveryKey } },
    ]);
  });

  it('sends Slack and Discord webhook payloads through allowlisted encrypted URLs', async () => {
    const slack = delivery('SLACK');
    const discord = delivery('DISCORD');
    const requests: Array<{ path: string; body: unknown }> = [];
    const mock = await mockProvider((request) => {
      requests.push(request);
      return request.path.startsWith('/services/')
        ? { status: 200, body: 'ok', contentType: 'text/plain' }
        : { status: 200, body: JSON.stringify({ id: 'message-123' }) };
    });
    const slackDb = source(
      [slack],
      codec.encrypt(organizationId, 'SLACK', 'https://hooks.slack.com/services/T/B/secret'),
    );
    const discordDb = source(
      [discord],
      codec.encrypt(organizationId, 'DISCORD', 'https://discord.com/api/webhooks/123/token'),
    );
    const options = { encryptionKey: key, fetcher: mock.fetcher };
    expect(await new NotificationDeliveryProcessor(slackDb, options).runOnce()).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(await new NotificationDeliveryProcessor(discordDb, options).runOnce()).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(requests).toMatchObject([
      { path: '/services/T/B/secret', body: { text: slack.body } },
      { path: '/api/webhooks/123/token?wait=true', body: { content: discord.body } },
    ]);
    expect(discordDb.finishNotificationDelivery).toHaveBeenCalledWith(
      discord,
      'message-123',
      null,
      false,
    );
  });

  it('classifies provider timeouts, malformed responses and permanent errors without throwing', async () => {
    const item = delivery('EMAIL');
    const db = source([item]);
    const mock = await mockProvider(() => ({ status: 200, body: 'not json' }));
    const options = {
      encryptionKey: key,
      resendApiKey: 'test',
      resendFromEmail: 'alerts@example.test',
      resendEndpoint: `${mock.endpoint}/emails`,
      fetcher: mock.fetcher,
    };
    expect(await new NotificationDeliveryProcessor(db, options).runOnce()).toEqual({
      sent: 0,
      failed: 1,
    });
    expect(db.finishNotificationDelivery).toHaveBeenCalledWith(
      item,
      null,
      'Provider returned malformed JSON.',
      true,
    );

    const permanent = source([delivery('EMAIL')]);
    const badRequest = new NotificationDeliveryProcessor(permanent, {
      ...options,
      fetcher: () => Promise.resolve(new Response('bad', { status: 400 })),
    });
    expect(await badRequest.runOnce()).toEqual({ sent: 0, failed: 1 });
    expect(permanent.finishNotificationDelivery).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'Provider returned HTTP 400.',
      false,
    );

    const timedOut = source([delivery('EMAIL')]);
    const timeout = new NotificationDeliveryProcessor(timedOut, {
      ...options,
      fetcher: () => Promise.reject(new Error('timeout with secret URL')),
    });
    expect(await timeout.runOnce()).toEqual({ sent: 0, failed: 1 });
    expect(timedOut.finishNotificationDelivery).toHaveBeenCalledWith(
      expect.anything(),
      null,
      'Provider request timed out or failed.',
      true,
    );
  });
});

import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ClaimedIncidentSummary,
  SummaryTimelineEntry,
  WorkerUnitOfWork,
} from '@incidentbase/database';
import { buildSummaryPrompt, IncidentSummaryProcessor } from '../src/incident-summary.js';

const summary: ClaimedIncidentSummary = {
  organizationId: randomUUID(),
  summaryId: randomUUID(),
  incidentId: randomUUID(),
  lifecycleGeneration: 0,
  resolutionAuditId: 123n,
  inputTitle: 'API unavailable',
  inputDescription: 'Requests failed for six minutes.',
  attempts: 1,
};
const timeline: SummaryTimelineEntry[] = [
  {
    auditId: 1n,
    action: 'incident.created',
    occurredAt: new Date('2026-09-25T10:00:00Z'),
    actorName: 'Reporter',
  },
  {
    auditId: 2n,
    action: 'incident.resolved',
    occurredAt: new Date('2026-09-25T10:06:00Z'),
    actorName: 'Responder',
  },
];

function source(items: ClaimedIncidentSummary[]) {
  return {
    claimIncidentSummaries: vi.fn(() => Promise.resolve(items.splice(0))),
    summaryTimeline: vi.fn(() => Promise.resolve(timeline)),
    finishIncidentSummary: vi.fn(() => Promise.resolve()),
  } satisfies Pick<
    WorkerUnitOfWork,
    'claimIncidentSummaries' | 'summaryTimeline' | 'finishIncidentSummary'
  >;
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

async function mockGroq(
  handler: (body: unknown) => { status: number; body: string },
): Promise<string> {
  server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const result = handler(JSON.parse(raw) as unknown);
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
    })();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock address');
  return `http://127.0.0.1:${address.port}/openai/v1/chat/completions`;
}

const options = { apiKey: 'mock-key', model: 'llama-3.3-70b-versatile', timeoutMs: 1_000 };

describe('incident AI summary worker', () => {
  it('sends a bounded factual prompt and stores a validated summary', async () => {
    const bodies: unknown[] = [];
    const endpoint = await mockGroq((body) => {
      bodies.push(body);
      return {
        status: 200,
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'The API failed at 10:00 and Responder resolved it at 10:06.',
                }),
              },
            },
          ],
        }),
      };
    });
    const db = source([{ ...summary }]);
    const processor = new IncidentSummaryProcessor(db, { ...options, endpoint });
    expect(await processor.runOnce()).toEqual({ completed: 1, failed: 0 });
    expect(db.finishIncidentSummary).toHaveBeenCalledWith(
      summary,
      'The API failed at 10:00 and Responder resolved it at 10:06.',
      options.model,
      null,
    );
    expect(bodies).toMatchObject([
      {
        model: options.model,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system' }, { role: 'user' }],
      },
    ]);
    expect(JSON.stringify(bodies)).toContain('Responder');
  });

  it('classifies malformed provider output, HTTP failure, and timeout without leaking raw bodies', async () => {
    const endpoint = await mockGroq(() => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }),
    }));
    const malformed = source([{ ...summary }]);
    expect(
      await new IncidentSummaryProcessor(malformed, { ...options, endpoint }).runOnce(),
    ).toEqual({ completed: 0, failed: 1 });
    expect(malformed.finishIncidentSummary).toHaveBeenCalledWith(
      summary,
      null,
      null,
      'MALFORMED_OUTPUT',
    );

    const unavailable = source([{ ...summary }]);
    expect(
      await new IncidentSummaryProcessor(unavailable, {
        ...options,
        fetcher: () => Promise.resolve(new Response('secret provider body', { status: 503 })),
      }).runOnce(),
    ).toEqual({ completed: 0, failed: 1 });
    expect(unavailable.finishIncidentSummary).toHaveBeenCalledWith(
      summary,
      null,
      null,
      'PROVIDER_UNAVAILABLE',
    );

    const timeout = source([{ ...summary }]);
    expect(
      await new IncidentSummaryProcessor(timeout, {
        ...options,
        fetcher: () => Promise.reject(new Error('API key leaked')),
      }).runOnce(),
    ).toEqual({ completed: 0, failed: 1 });
    expect(timeout.finishIncidentSummary).toHaveBeenCalledWith(
      summary,
      null,
      null,
      'TIMEOUT_OR_NETWORK',
    );
  });

  it('bounds timeline and incident text before sending to the provider', () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      ...timeline[0]!,
      auditId: BigInt(index),
      actorName: 'X'.repeat(500),
      action: 'Y'.repeat(500),
    }));
    const prompt = buildSummaryPrompt(
      { ...summary, inputTitle: 'T'.repeat(500), inputDescription: 'D'.repeat(5_000) },
      many,
    );
    expect(prompt.length).toBeLessThanOrEqual(12_150);
    expect(prompt).not.toContain('X'.repeat(81));
    expect(prompt).not.toContain('D'.repeat(1_001));
  });
});

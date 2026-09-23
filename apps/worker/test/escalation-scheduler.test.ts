import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EscalationExpectation } from '@incidentbase/database';

import { EscalationScheduler, escalationJobId } from '../src/escalation-scheduler.js';

const redisUrl = process.env.WORKER_TEST_REDIS_URL;
const describeWithRedis = redisUrl === undefined ? describe.skip : describe;

describeWithRedis.sequential('escalation queue scheduling', () => {
  if (redisUrl === undefined) return;

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(`incidentbase-escalation-test-${randomUUID()}`, { connection });
  const expectation: EscalationExpectation = {
    expectedDeadline: new Date(Date.now() + 60_000),
    expectedStep: 0,
    generation: 0,
    incidentId: randomUUID(),
    organizationId: randomUUID(),
  };
  const reconciliationCandidates = vi.fn<() => Promise<EscalationExpectation[]>>();
  const scheduler = new EscalationScheduler(queue, { reconciliationCandidates }, 86_400);

  beforeAll(async () => {
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  it('deduplicates repeated scheduling with a deterministic job id', async () => {
    await scheduler.schedule(expectation);
    await scheduler.schedule(expectation);

    const jobs = await queue.getJobs(['delayed', 'waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(escalationJobId(expectation));
  });

  it('recreates missing delayed work during reconciliation', async () => {
    await queue.drain(true);
    reconciliationCandidates.mockResolvedValueOnce([expectation]);
    expect(await scheduler.reconcile()).toBe(1);
    expect(await queue.getJob(escalationJobId(expectation))).not.toBeUndefined();

    await queue.drain(true);
    expect(await queue.getJob(escalationJobId(expectation))).toBeUndefined();
    reconciliationCandidates.mockResolvedValueOnce([expectation]);
    await scheduler.reconcile();
    expect(await queue.getJob(escalationJobId(expectation))).not.toBeUndefined();
  });
});

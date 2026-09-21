import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createJobProcessor } from '../src/job-router.js';

const envelope = {
  organizationId: '1cd1b8f9-8fc0-4da8-8b2a-7a3d5313c9a6',
  requestId: '87edce64-65d0-4878-8aac-c65a5a289fd9',
  version: 1,
};

function createJob(name: string, data: unknown): Job {
  return { id: 'job-1', name, data } as Job;
}

describe('job router', () => {
  it('validates the envelope and payload before invoking a handler', async () => {
    const handle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const processor = createJobProcessor(
      {
        test: {
          payloadSchema: z.object({ incidentId: z.uuid() }),
          handle,
        },
      },
      pino({ enabled: false }),
    );

    await processor(
      createJob('test', {
        ...envelope,
        payload: { incidentId: '5cd67e52-c90d-49f9-9308-28699651217a' },
      }),
    );

    expect(handle).toHaveBeenCalledOnce();
  });

  it('classifies unknown jobs as permanent failures', async () => {
    const processor = createJobProcessor({}, pino({ enabled: false }));

    await expect(processor(createJob('unknown', envelope))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('rejects malformed external job input before calling a handler', async () => {
    const handle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const processor = createJobProcessor(
      {
        test: { payloadSchema: z.object({ incidentId: z.uuid() }), handle },
      },
      pino({ enabled: false }),
    );

    await expect(
      processor(createJob('test', { ...envelope, payload: { incidentId: 'not-a-uuid' } })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(handle).not.toHaveBeenCalled();
  });
});

import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { ZodType } from 'zod';

import { jobEnvelopeSchema, type JobEnvelope } from '@incidentbase/contracts';

export interface JobHandler<TPayload = unknown> {
  handle: (envelope: JobEnvelope & { payload: TPayload }) => Promise<void>;
  payloadSchema: ZodType<TPayload>;
}

export type JobHandlers = Readonly<Record<string, JobHandler>>;

export function createJobProcessor(handlers: JobHandlers, logger: Logger) {
  return async (job: Job): Promise<void> => {
    const handler = handlers[job.name];
    if (handler === undefined) {
      throw new UnrecoverableError(`No handler is registered for job type: ${job.name}`);
    }

    const envelopeResult = jobEnvelopeSchema.safeParse(job.data);
    if (!envelopeResult.success) {
      throw new UnrecoverableError(`Invalid envelope for job type: ${job.name}`);
    }

    const payloadResult = handler.payloadSchema.safeParse(envelopeResult.data.payload);
    if (!payloadResult.success) {
      throw new UnrecoverableError(`Invalid payload for job type: ${job.name}`);
    }

    const envelope = { ...envelopeResult.data, payload: payloadResult.data };
    logger.info(
      {
        jobId: job.id,
        jobName: job.name,
        organizationId: envelope.organizationId,
        requestId: envelope.requestId,
      },
      'Processing job',
    );
    await handler.handle(envelope);
  };
}

import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { WorkerEnvironment } from '@incidentbase/config';
import type { TelemetryHandle } from '@incidentbase/observability';

import { createJobProcessor, type JobHandlers } from './job-router.js';
import { registerShutdownHandlers } from './shutdown.js';

export const JOB_QUEUE_NAME = 'incidentbase-jobs';

interface StartWorkerOptions {
  environment: WorkerEnvironment;
  handlers?: JobHandlers;
  logger: Logger;
  telemetry: TelemetryHandle;
}

export async function startWorker(options: StartWorkerOptions): Promise<void> {
  const connection = new Redis(options.environment.REDIS_URL, {
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });

  connection.on('error', (error: Error) => {
    options.logger.error({ err: error }, 'Worker Redis connection error');
  });

  await connection.connect();
  await connection.ping();

  const worker = new Worker(
    JOB_QUEUE_NAME,
    createJobProcessor(options.handlers ?? {}, options.logger),
    {
      concurrency: options.environment.WORKER_CONCURRENCY,
      connection,
    },
  );

  worker.on('error', (error) => {
    options.logger.error({ err: error }, 'BullMQ worker error');
  });
  worker.on('failed', (job, error) => {
    options.logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'BullMQ job failed');
  });

  registerShutdownHandlers({
    logger: options.logger,
    timeoutMs: options.environment.SHUTDOWN_TIMEOUT_MS,
    close: async () => {
      await worker.close();
      await connection.quit();
      await options.telemetry.shutdown();
    },
  });

  await worker.waitUntilReady();
  options.logger.info(
    { concurrency: options.environment.WORKER_CONCURRENCY, queue: JOB_QUEUE_NAME },
    'Worker is ready',
  );
}

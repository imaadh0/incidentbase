import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { WorkerEnvironment } from '@incidentbase/config';
import { createDatabaseClient, WorkerUnitOfWork } from '@incidentbase/database';
import type { TelemetryHandle } from '@incidentbase/observability';

import { createJobProcessor, type JobHandlers } from './job-router.js';
import { createEscalationJobHandler } from './escalation-handler.js';
import { ESCALATION_JOB_NAME, EscalationScheduler } from './escalation-scheduler.js';
import { JOB_QUEUE_NAME } from './queue.js';
import { OutboxRelay } from './outbox-relay.js';
import { registerShutdownHandlers } from './shutdown.js';

export { JOB_QUEUE_NAME } from './queue.js';

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

  const database = createDatabaseClient({ connectionString: options.environment.DATABASE_URL });
  await database.$queryRaw`SELECT 1`;
  const unitOfWork = new WorkerUnitOfWork(database);
  const queue = new Queue(JOB_QUEUE_NAME, { connection });
  const scheduler = new EscalationScheduler(
    queue,
    unitOfWork,
    options.environment.ESCALATION_SCHEDULE_HORIZON_SECONDS,
  );
  const outboxRelay = new OutboxRelay(
    unitOfWork,
    connection,
    options.environment.OUTBOX_RELAY_BATCH_SIZE,
  );
  const handlers = options.handlers ?? {
    [ESCALATION_JOB_NAME]: createEscalationJobHandler(unitOfWork, scheduler),
  };

  const worker = new Worker(JOB_QUEUE_NAME, createJobProcessor(handlers, options.logger), {
    concurrency: options.environment.WORKER_CONCURRENCY,
    connection,
  });

  worker.on('error', (error) => {
    options.logger.error({ err: error }, 'BullMQ worker error');
  });
  worker.on('failed', (job, error) => {
    options.logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'BullMQ job failed');
  });

  const reconcile = async (): Promise<void> => {
    try {
      const candidates = await scheduler.reconcile();
      options.logger.info({ candidates }, 'Escalation reconciliation completed');
    } catch (error: unknown) {
      options.logger.error({ err: error }, 'Escalation reconciliation failed');
    }
  };
  const reconciliationTimer = setInterval(
    () => void reconcile(),
    options.environment.ESCALATION_RECONCILIATION_INTERVAL_MS,
  );
  reconciliationTimer.unref();

  let relayRunning = false;
  const relayOutbox = async (): Promise<void> => {
    if (relayRunning) return;
    relayRunning = true;
    try {
      const result = await outboxRelay.runOnce();
      if (result.failed > 0 || result.published > 0) {
        options.logger.info(result, 'Outbox relay completed');
      }
    } catch (error: unknown) {
      options.logger.error({ err: error }, 'Outbox relay failed');
    } finally {
      relayRunning = false;
    }
  };
  const outboxTimer = setInterval(
    () => void relayOutbox(),
    options.environment.OUTBOX_RELAY_INTERVAL_MS,
  );
  outboxTimer.unref();

  registerShutdownHandlers({
    logger: options.logger,
    timeoutMs: options.environment.SHUTDOWN_TIMEOUT_MS,
    close: async () => {
      clearInterval(reconciliationTimer);
      clearInterval(outboxTimer);
      await worker.close();
      await queue.close();
      await database.$disconnect();
      await connection.quit();
      await options.telemetry.shutdown();
    },
  });

  await worker.waitUntilReady();
  await reconcile();
  await relayOutbox();
  options.logger.info(
    { concurrency: options.environment.WORKER_CONCURRENCY, queue: JOB_QUEUE_NAME },
    'Worker is ready',
  );
}

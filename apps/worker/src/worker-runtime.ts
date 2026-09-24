import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { WorkerEnvironment } from '@incidentbase/config';
import { createDatabaseClient, WorkerUnitOfWork } from '@incidentbase/database';
import { createServiceMetrics, type TelemetryHandle } from '@incidentbase/observability';

import { createJobProcessor, type JobHandlers } from './job-router.js';
import { createEscalationJobHandler } from './escalation-handler.js';
import { ESCALATION_JOB_NAME, EscalationScheduler } from './escalation-scheduler.js';
import { JOB_QUEUE_NAME } from './queue.js';
import { OutboxRelay } from './outbox-relay.js';
import { NotificationDeliveryProcessor } from './notification-delivery.js';
import { IncidentSummaryProcessor } from './incident-summary.js';
import { registerShutdownHandlers } from './shutdown.js';
import { startWorkerHealthServer } from './health-server.js';

export { JOB_QUEUE_NAME } from './queue.js';

interface StartWorkerOptions {
  environment: WorkerEnvironment;
  handlers?: JobHandlers;
  logger: Logger;
  telemetry: TelemetryHandle;
}

export async function startWorker(options: StartWorkerOptions): Promise<void> {
  if (!options.environment.NOTIFICATION_ENCRYPTION_KEY) {
    throw new Error('NOTIFICATION_ENCRYPTION_KEY is required for the notification worker.');
  }
  const metrics = createServiceMetrics('worker');
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
  const notificationProcessor = new NotificationDeliveryProcessor(unitOfWork, {
    encryptionKey: options.environment.NOTIFICATION_ENCRYPTION_KEY,
    resendApiKey: options.environment.RESEND_API_KEY,
    resendFromEmail: options.environment.RESEND_FROM_EMAIL,
  });
  const summaryProcessor = new IncidentSummaryProcessor(unitOfWork, {
    apiKey: options.environment.GROQ_API_KEY,
    model: options.environment.GROQ_MODEL,
    timeoutMs: options.environment.GROQ_TIMEOUT_MS,
  });
  const handlers = options.handlers ?? {
    [ESCALATION_JOB_NAME]: createEscalationJobHandler(unitOfWork, scheduler, metrics),
  };

  const worker = new Worker(JOB_QUEUE_NAME, createJobProcessor(handlers, options.logger), {
    concurrency: options.environment.WORKER_CONCURRENCY,
    connection,
  });

  worker.on('error', (error) => {
    options.logger.error({ err: error }, 'BullMQ worker error');
  });
  worker.on('failed', (job, error) => {
    metrics.jobFailures.inc();
    options.logger.error({ err: error, jobId: job?.id, jobName: job?.name }, 'BullMQ job failed');
  });

  const reconcile = async (): Promise<void> => {
    try {
      const candidates = await scheduler.reconcile();
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
      metrics.queueDepth.set((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0));
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

  let deliveriesRunning = false;
  const processDeliveries = async (): Promise<void> => {
    if (deliveriesRunning) return;
    deliveriesRunning = true;
    try {
      const result = await notificationProcessor.runOnce();
      if (result.sent)
        metrics.providerOutcomes.inc({ provider: 'notifications', outcome: 'sent' }, result.sent);
      if (result.failed)
        metrics.providerOutcomes.inc(
          { provider: 'notifications', outcome: 'failed_attempt' },
          result.failed,
        );
      if (result.sent || result.failed)
        options.logger.info(result, 'Notification delivery batch completed');
    } catch (error: unknown) {
      options.logger.error({ err: error }, 'Notification delivery batch failed');
    } finally {
      deliveriesRunning = false;
    }
  };
  const deliveryTimer = setInterval(
    () => void processDeliveries(),
    options.environment.NOTIFICATION_DELIVERY_INTERVAL_MS,
  );
  deliveryTimer.unref();

  let summariesRunning = false;
  const processSummaries = async (): Promise<void> => {
    if (summariesRunning) return;
    summariesRunning = true;
    try {
      const result = await summaryProcessor.runOnce();
      if (result.completed)
        metrics.providerOutcomes.inc({ provider: 'groq', outcome: 'completed' }, result.completed);
      if (result.failed)
        metrics.providerOutcomes.inc(
          { provider: 'groq', outcome: 'failed_attempt' },
          result.failed,
        );
      if (result.completed || result.failed)
        options.logger.info(result, 'Incident summary batch completed');
    } catch (error: unknown) {
      options.logger.error({ err: error }, 'Incident summary batch failed');
    } finally {
      summariesRunning = false;
    }
  };
  const summaryTimer = setInterval(
    () => void processSummaries(),
    options.environment.SUMMARY_INTERVAL_MS,
  );
  summaryTimer.unref();

  let ready = false;
  const healthServer = await startWorkerHealthServer({
    host: options.environment.WORKER_HEALTH_HOST,
    port: options.environment.WORKER_HEALTH_PORT,
    logger: options.logger,
    metrics,
    metricsToken: options.environment.METRICS_TOKEN,
    readinessChecks: {
      startup: () => (ready ? Promise.resolve() : Promise.reject(new Error('Starting'))),
      database: async () => {
        await database.$queryRaw`SELECT 1`;
      },
      redis: async () => {
        await connection.ping();
      },
    },
  });

  registerShutdownHandlers({
    logger: options.logger,
    timeoutMs: options.environment.SHUTDOWN_TIMEOUT_MS,
    close: async () => {
      ready = false;
      clearInterval(reconciliationTimer);
      clearInterval(outboxTimer);
      clearInterval(deliveryTimer);
      clearInterval(summaryTimer);
      await healthServer.close();
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
  await processDeliveries();
  await processSummaries();
  ready = true;
  options.logger.info(
    { concurrency: options.environment.WORKER_CONCURRENCY, queue: JOB_QUEUE_NAME },
    'Worker is ready',
  );
}

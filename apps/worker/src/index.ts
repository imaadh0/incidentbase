import { parseEnvironment, workerEnvironmentSchema } from '@incidentbase/config';
import { createLogger, startTelemetry } from '@incidentbase/observability';

async function main(): Promise<void> {
  const environment = parseEnvironment('worker', workerEnvironmentSchema, process.env);
  const telemetry = startTelemetry({
    enabled: environment.OTEL_ENABLED,
    serviceName: 'incidentbase-worker',
    ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { endpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });
  const logger = createLogger({ level: environment.LOG_LEVEL, service: 'worker' });

  // BullMQ and Redis load after telemetry so their instrumentation can patch first.
  const { startWorker } = await import('./worker-runtime.js');
  await startWorker({ environment, logger, telemetry });
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'fatal', service: 'worker-bootstrap' });
  logger.fatal({ err: error }, 'Worker startup failed');
  process.exitCode = 1;
});

import { apiEnvironmentSchema, parseEnvironment } from '@incidentbase/config';
import { createLogger, startTelemetry } from '@incidentbase/observability';

async function main(): Promise<void> {
  const environment = parseEnvironment('api', apiEnvironmentSchema, process.env);
  const telemetry = startTelemetry({
    enabled: environment.OTEL_ENABLED,
    serviceName: 'incidentbase-api',
    ...(environment.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { endpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });
  const logger = createLogger({ level: environment.LOG_LEVEL, service: 'api' });

  // Express and its instrumented dependencies load only after telemetry starts.
  const { startApiServer } = await import('./server.js');
  await startApiServer({ environment, logger, telemetry });
}

main().catch((error: unknown) => {
  const logger = createLogger({ level: 'fatal', service: 'api-bootstrap' });
  logger.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
});

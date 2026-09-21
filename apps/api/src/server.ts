import { createServer } from 'node:http';

import type { ApiEnvironment } from '@incidentbase/config';
import { createServiceMetrics, type TelemetryHandle } from '@incidentbase/observability';
import type { Logger } from 'pino';

import { createApp } from './create-app.js';
import { registerShutdownHandlers } from './shutdown.js';

interface StartApiServerOptions {
  environment: ApiEnvironment;
  logger: Logger;
  telemetry: TelemetryHandle;
}

export async function startApiServer(options: StartApiServerOptions): Promise<void> {
  const metrics = createServiceMetrics('api');
  const app = createApp({ environment: options.environment, logger: options.logger, metrics });
  const server = createServer(app);

  registerShutdownHandlers({
    logger: options.logger,
    timeoutMs: options.environment.SHUTDOWN_TIMEOUT_MS,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await options.telemetry.shutdown();
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.environment.API_PORT, options.environment.API_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  options.logger.info(
    { host: options.environment.API_HOST, port: options.environment.API_PORT },
    'API is listening',
  );
}

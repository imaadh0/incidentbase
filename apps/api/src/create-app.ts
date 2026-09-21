import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import type { ApiEnvironment } from '@incidentbase/config';
import type { ServiceMetrics } from '@incidentbase/observability';

import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createRequestMetricsMiddleware } from './middleware/request-metrics.js';
import { createHealthRouter, type ReadinessCheck } from './routes/health.js';

export interface CreateAppOptions {
  environment: ApiEnvironment;
  logger: Logger;
  metrics: ServiceMetrics;
  readinessChecks?: Readonly<Record<string, ReadinessCheck>>;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      credentials: true,
      origin: options.environment.WEB_ORIGIN,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(createRequestContextMiddleware(options.logger));
  app.use(createRequestMetricsMiddleware(options.metrics));
  app.use(
    createHealthRouter({
      logger: options.logger,
      metricsRegistry: options.metrics.registry,
      metricsToken: options.environment.METRICS_TOKEN,
      ...(options.readinessChecks === undefined
        ? {}
        : { readinessChecks: options.readinessChecks }),
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

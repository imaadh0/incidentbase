import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import type { ApiEnvironment } from '@incidentbase/config';
import type { TenantUnitOfWork } from '@incidentbase/database';
import type { ServiceMetrics } from '@incidentbase/observability';

import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createRequestMetricsMiddleware } from './middleware/request-metrics.js';
import { createHealthRouter, type ReadinessCheck } from './routes/health.js';
import {
  createTenantMembershipRouter,
  type TenantPrincipalResolver,
} from './routes/tenant-memberships.js';

export interface TenantBoundaryOptions {
  resolvePrincipal: TenantPrincipalResolver;
  unitOfWork: TenantUnitOfWork;
}

export interface CreateAppOptions {
  environment: ApiEnvironment;
  logger: Logger;
  metrics: ServiceMetrics;
  readinessChecks?: Readonly<Record<string, ReadinessCheck>>;
  tenantBoundary?: TenantBoundaryOptions;
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
  if (options.tenantBoundary !== undefined) {
    app.use(createTenantMembershipRouter(options.tenantBoundary));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

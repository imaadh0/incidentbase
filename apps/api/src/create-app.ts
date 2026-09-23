import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';

import type { ApiEnvironment } from '@incidentbase/config';
import type { AccessTokenService } from '@incidentbase/auth';
import type { TenantUnitOfWork } from '@incidentbase/database';
import type { ServiceMetrics } from '@incidentbase/observability';

import { createErrorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestContextMiddleware } from './middleware/request-context.js';
import { createRequestMetricsMiddleware } from './middleware/request-metrics.js';
import { createHealthRouter, type ReadinessCheck } from './routes/health.js';
import { createAuthRouter } from './routes/auth.js';
import type { AuthenticationService } from './auth/authentication-service.js';
import {
  createTenantMembershipRouter,
  type TenantPrincipalResolver,
} from './routes/tenant-memberships.js';
import { createTenantIncidentRouter } from './routes/tenant-incidents.js';

export interface TenantBoundaryOptions {
  resolvePrincipal: TenantPrincipalResolver;
  unitOfWork: TenantUnitOfWork;
}

export interface AuthenticationOptions {
  accessTokens: AccessTokenService;
  service: AuthenticationService;
}

export interface CreateAppOptions {
  environment: ApiEnvironment;
  logger: Logger;
  metrics: ServiceMetrics;
  readinessChecks?: Readonly<Record<string, ReadinessCheck>>;
  tenantBoundary?: TenantBoundaryOptions;
  authentication?: AuthenticationOptions;
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
  app.use(createRequestContextMiddleware(options.logger));
  app.use(express.json({ limit: '1mb' }));
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
  if (options.authentication !== undefined) {
    app.use(
      createAuthRouter({
        accessTokenTtlSeconds: options.environment.ACCESS_TOKEN_TTL_SECONDS,
        accessTokens: options.authentication.accessTokens,
        cookieSecure: options.environment.COOKIE_SECURE,
        refreshTokenTtlSeconds: options.environment.REFRESH_TOKEN_TTL_SECONDS,
        service: options.authentication.service,
      }),
    );
  }
  if (options.tenantBoundary !== undefined) {
    app.use(createTenantMembershipRouter(options.tenantBoundary));
    app.use(createTenantIncidentRouter(options.tenantBoundary));
  }
  app.use(notFoundHandler);
  app.use(createErrorHandler(options.logger));

  return app;
}

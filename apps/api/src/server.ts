import { createServer } from 'node:http';

import type { ApiEnvironment } from '@incidentbase/config';
import { createServiceMetrics, type TelemetryHandle } from '@incidentbase/observability';
import { AccessTokenService } from '@incidentbase/auth';
import {
  AuthenticationRepository,
  createDatabaseClient,
  TenantUnitOfWork,
} from '@incidentbase/database';
import type { Logger } from 'pino';

import { createApp } from './create-app.js';
import { registerShutdownHandlers } from './shutdown.js';
import { AuthenticationService } from './auth/authentication-service.js';
import { authenticateRequest } from './auth/request-authentication.js';

interface StartApiServerOptions {
  environment: ApiEnvironment;
  logger: Logger;
  telemetry: TelemetryHandle;
}

export async function startApiServer(options: StartApiServerOptions): Promise<void> {
  const metrics = createServiceMetrics('api');
  const database = createDatabaseClient({ connectionString: options.environment.DATABASE_URL });
  const accessTokens = new AccessTokenService({
    audience: options.environment.AUTH_AUDIENCE,
    expiresInSeconds: options.environment.ACCESS_TOKEN_TTL_SECONDS,
    issuer: options.environment.AUTH_ISSUER,
    secret: options.environment.JWT_SECRET,
  });
  const authentication = new AuthenticationService({
    accessTokens,
    refreshTokenTtlSeconds: options.environment.REFRESH_TOKEN_TTL_SECONDS,
    repository: new AuthenticationRepository(database),
  });
  const app = createApp({
    authentication: { accessTokens, service: authentication },
    environment: options.environment,
    logger: options.logger,
    metrics,
    readinessChecks: {
      database: async () => {
        await database.$queryRaw`SELECT 1`;
      },
    },
    tenantBoundary: {
      resolvePrincipal: (request) => authenticateRequest(request, accessTokens),
      unitOfWork: new TenantUnitOfWork(database),
    },
  });
  const server = createServer(app);

  registerShutdownHandlers({
    logger: options.logger,
    timeoutMs: options.environment.SHUTDOWN_TIMEOUT_MS,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await database.$disconnect();
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

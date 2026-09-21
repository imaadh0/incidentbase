import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import type { Logger } from 'pino';
import type { Registry } from 'prom-client';

export type ReadinessCheck = () => Promise<void>;

interface HealthRouterOptions {
  logger: Logger;
  metricsRegistry: Registry;
  metricsToken: string;
  readinessChecks?: Readonly<Record<string, ReadinessCheck>>;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) {
    return false;
  }

  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

export function createHealthRouter(options: HealthRouterOptions): Router {
  const router = Router();

  router.get('/health/live', (_request, response) => {
    response.json({
      service: 'api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health/ready', async (_request, response) => {
    const checks = Object.entries(options.readinessChecks ?? {});
    const results = await Promise.allSettled(checks.map(([, check]) => check()));
    const failedChecks = results.flatMap((result, index) =>
      result.status === 'rejected' ? [checks[index]?.[0] ?? 'unknown'] : [],
    );

    if (failedChecks.length > 0) {
      options.logger.warn({ failedChecks }, 'Readiness check failed');
      response.status(503).json({
        service: 'api',
        status: 'degraded',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    response.json({
      service: 'api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/metrics', async (request, response) => {
    const authorization = request.header('authorization');
    const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

    if (!tokenMatches(candidate, options.metricsToken)) {
      response.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Valid metrics credentials are required.',
          requestId: response.locals.requestId,
        },
      });
      return;
    }

    response.setHeader('content-type', options.metricsRegistry.contentType);
    response.send(await options.metricsRegistry.metrics());
  });

  return router;
}

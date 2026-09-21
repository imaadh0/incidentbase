import type { RequestHandler } from 'express';

import type { ServiceMetrics } from '@incidentbase/observability';

export function createRequestMetricsMiddleware(metrics: ServiceMetrics): RequestHandler {
  return (request, response, next) => {
    const stopTimer = metrics.httpRequestDuration.startTimer();

    response.once('finish', () => {
      const matchedRoute = request.route as { path?: unknown } | undefined;
      const route = typeof matchedRoute?.path === 'string' ? matchedRoute.path : 'unmatched';

      stopTimer({
        method: request.method,
        route,
        status_code: response.statusCode.toString(),
      });
    });

    next();
  };
}

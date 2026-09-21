import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

export interface ServiceMetrics {
  httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  unhandledErrors: Counter<'source'>;
  registry: Registry;
}

export function createServiceMetrics(serviceName: string): ServiceMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry, prefix: 'incidentbase_' });

  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'incidentbase_http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      registers: [registry],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    }),
    unhandledErrors: new Counter({
      name: 'incidentbase_unhandled_errors_total',
      help: 'Unhandled process-boundary errors that initiated shutdown',
      labelNames: ['source'],
      registers: [registry],
    }),
  };
}

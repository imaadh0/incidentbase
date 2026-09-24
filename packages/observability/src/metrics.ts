import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface ServiceMetrics {
  httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  unhandledErrors: Counter<'source'>;
  rateLimitDecisions: Counter<'bucket' | 'outcome'>;
  activeSockets: Gauge<string>;
  queueDepth: Gauge<string>;
  jobFailures: Counter<string>;
  escalationDelay: Histogram<string>;
  providerOutcomes: Counter<'provider' | 'outcome'>;
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
    rateLimitDecisions: new Counter({
      name: 'incidentbase_rate_limit_decisions_total',
      help: 'Rate-limit allow, reject, and dependency outcomes',
      labelNames: ['bucket', 'outcome'],
      registers: [registry],
    }),
    activeSockets: new Gauge({
      name: 'incidentbase_active_sockets',
      help: 'Currently connected Socket.io clients',
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: 'incidentbase_queue_depth',
      help: 'Waiting, delayed, and active escalation jobs',
      registers: [registry],
    }),
    jobFailures: new Counter({
      name: 'incidentbase_job_failures_total',
      help: 'BullMQ escalation jobs that failed',
      registers: [registry],
    }),
    escalationDelay: new Histogram({
      name: 'incidentbase_escalation_delay_seconds',
      help: 'Delay between escalation deadline and successful routing',
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900],
      registers: [registry],
    }),
    providerOutcomes: new Counter({
      name: 'incidentbase_provider_outcomes_total',
      help: 'Completed and failed outbound provider work',
      labelNames: ['provider', 'outcome'],
      registers: [registry],
    }),
  };
}

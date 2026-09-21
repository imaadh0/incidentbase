import { z } from 'zod';

const runtimeSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

const telemetryRequirement = {
  check: (environment: {
    OTEL_ENABLED: boolean;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  }) => !environment.OTEL_ENABLED || environment.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined,
  message: 'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED is true',
  path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
};

export const apiEnvironmentSchema = runtimeSchema
  .extend({
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().max(65_535).default(4000),
    WEB_ORIGIN: z.url(),
    REDIS_URL: z.url(),
    METRICS_TOKEN: z.string().min(32),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .refine(telemetryRequirement.check, telemetryRequirement);

export const workerEnvironmentSchema = runtimeSchema
  .extend({
    REDIS_URL: z.url(),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .refine(telemetryRequirement.check, telemetryRequirement);

export const webEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_API_BASE_URL: z.string().startsWith('/').default('/api/v1'),
});

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type WebEnvironment = z.infer<typeof webEnvironmentSchema>;

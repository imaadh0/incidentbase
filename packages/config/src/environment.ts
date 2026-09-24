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
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    WEB_ORIGIN: z.url(),
    DATABASE_URL: z.string().startsWith('postgresql://'),
    REDIS_URL: z.url(),
    METRICS_TOKEN: z.string().min(32),
    JWT_SECRET: z.string().min(32),
    AUTH_ISSUER: z.string().min(1).default('incidentbase'),
    AUTH_AUDIENCE: z.string().min(1).default('incidentbase-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24 * 90)
      .default(60 * 60 * 24 * 30),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    NOTIFICATION_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-f\d]{64}$/iu)
      .optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .refine(telemetryRequirement.check, telemetryRequirement);

export const workerEnvironmentSchema = runtimeSchema
  .extend({
    DATABASE_URL: z.string().startsWith('postgresql://'),
    REDIS_URL: z.url(),
    METRICS_TOKEN: z.string().min(32),
    WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().max(65_535).default(4001),
    ESCALATION_RECONCILIATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    ESCALATION_SCHEDULE_HORIZON_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(604_800)
      .default(86_400),
    OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    NOTIFICATION_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-f\d]{64}$/iu)
      .optional(),
    NOTIFICATION_DELIVERY_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    RESEND_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    RESEND_FROM_EMAIL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.email().optional(),
    ),
    GROQ_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    GROQ_MODEL: z.string().min(1).default('llama-3.3-70b-versatile'),
    GROQ_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
    SUMMARY_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .refine(telemetryRequirement.check, telemetryRequirement);

export const webEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_API_BASE_URL: z.string().startsWith('/').default('/api/v1'),
  NEXT_OUTPUT_MODE: z.enum(['default', 'standalone']).default('default'),
});

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type WebEnvironment = z.infer<typeof webEnvironmentSchema>;

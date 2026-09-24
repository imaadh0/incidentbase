import { describe, expect, it } from 'vitest';

import {
  apiEnvironmentSchema,
  ConfigurationError,
  parseEnvironment,
  workerEnvironmentSchema,
} from '../src/index.js';

const validEnvironment = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  API_HOST: '127.0.0.1',
  API_PORT: '4000',
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://incidentbase:password@localhost:5432/incidentbase',
  REDIS_URL: 'redis://localhost:6379',
  METRICS_TOKEN: 'a-secure-test-token-with-32-characters',
  JWT_SECRET: 'a-secure-test-jwt-secret-with-32-characters',
  COOKIE_SECURE: 'false',
  OTEL_ENABLED: 'false',
};

describe('parseEnvironment', () => {
  it('coerces and returns valid service configuration', () => {
    const result = parseEnvironment('api', apiEnvironmentSchema, validEnvironment);

    expect(result.API_PORT).toBe(4000);
    expect(result.OTEL_ENABLED).toBe(false);
  });

  it('reports field names without exposing invalid secret values', () => {
    const secret = 'short-secret-value';

    expect(() =>
      parseEnvironment('api', apiEnvironmentSchema, {
        ...validEnvironment,
        METRICS_TOKEN: secret,
      }),
    ).toThrow(ConfigurationError);

    try {
      parseEnvironment('api', apiEnvironmentSchema, {
        ...validEnvironment,
        METRICS_TOKEN: secret,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain('METRICS_TOKEN');
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('requires an exporter endpoint when telemetry is enabled', () => {
    expect(() =>
      parseEnvironment('api', apiEnvironmentSchema, {
        ...validEnvironment,
        OTEL_ENABLED: 'true',
      }),
    ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it('requires a restricted database URL for the worker', () => {
    const result = parseEnvironment('worker', workerEnvironmentSchema, {
      DATABASE_URL: 'postgresql://incidentbase_worker_app:password@localhost:5432/incidentbase',
      OTEL_ENABLED: 'false',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(result.ESCALATION_RECONCILIATION_INTERVAL_MS).toBe(30_000);
    expect(result.ESCALATION_SCHEDULE_HORIZON_SECONDS).toBe(86_400);
    expect(result.OUTBOX_RELAY_BATCH_SIZE).toBe(100);
    expect(result.OUTBOX_RELAY_INTERVAL_MS).toBe(1_000);
  });
});

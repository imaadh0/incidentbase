import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseEnvironment, apiEnvironmentSchema } from '@incidentbase/config';
import { healthStatusSchema } from '@incidentbase/contracts';
import { createLogger, createServiceMetrics } from '@incidentbase/observability';

import { createApp } from '../src/create-app.js';

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

function createTestApp(readinessChecks = {}) {
  const environment = parseEnvironment('api', apiEnvironmentSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    API_HOST: '127.0.0.1',
    API_PORT: '4000',
    WEB_ORIGIN: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://incidentbase:password@localhost:5432/incidentbase',
    REDIS_URL: 'redis://localhost:6379',
    METRICS_TOKEN: 'a-secure-test-token-with-32-characters',
    JWT_SECRET: 'a-secure-test-jwt-secret-with-32-characters',
    COOKIE_SECURE: 'false',
    OTEL_ENABLED: 'false',
  });

  return createApp({
    environment,
    logger: createLogger({ level: 'fatal', service: 'api-test' }),
    metrics: createServiceMetrics('api-test'),
    readinessChecks,
  });
}

describe('API foundation', () => {
  it('returns a validated liveness document and request ID', async () => {
    const response = await request(createTestApp()).get('/health/live').expect(200);

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    const body = healthStatusSchema.parse(response.body as unknown);
    expect(body).toMatchObject({ service: 'api', status: 'ok' });
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('keeps the reverse proxy request ID for correlated logs', async () => {
    const proxyRequestId = '0123456789abcdef0123456789abcdef';
    const response = await request(createTestApp())
      .get('/health/live')
      .set('x-request-id', proxyRequestId)
      .expect(200);
    expect(response.headers['x-request-id']).toBe(proxyRequestId);
  });

  it('reports degraded readiness without exposing dependency errors', async () => {
    const response = await request(
      createTestApp({ database: () => Promise.reject(new Error('secret connection details')) }),
    )
      .get('/health/ready')
      .expect(503);

    const body = healthStatusSchema.parse(response.body as unknown);
    expect(body).toMatchObject({ service: 'api', status: 'degraded' });
    expect(JSON.stringify(body)).not.toContain('secret connection details');
  });

  it('protects metrics and gives unknown routes a stable error shape', async () => {
    const app = createTestApp();

    const metricsResponse = await request(app).get('/metrics').expect(401);
    const missingResponse = await request(app).get('/missing').expect(404);

    const metricsBody = errorResponseSchema.parse(metricsResponse.body as unknown);
    const missingBody = errorResponseSchema.parse(missingResponse.body as unknown);
    expect(metricsBody.error.code).toBe('UNAUTHORIZED');
    expect(missingBody.error.code).toBe('ROUTE_NOT_FOUND');
    expect(missingBody.error.requestId).toEqual(expect.any(String));
  });
});

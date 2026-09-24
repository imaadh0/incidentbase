import { describe, expect, it } from 'vitest';

import { createLogger, createServiceMetrics } from '@incidentbase/observability';

import { startWorkerHealthServer } from '../src/health-server.js';

const token = 'a-secure-test-token-with-32-characters';

describe('worker health and metrics server', () => {
  it('reports readiness when dependencies are healthy', async () => {
    const server = await startWorkerHealthServer({
      host: '127.0.0.1',
      port: 0,
      logger: createLogger({ service: 'worker-health-test', level: 'fatal' }),
      metrics: createServiceMetrics('worker-ready-test'),
      metricsToken: token,
      readinessChecks: { database: () => Promise.resolve(), redis: () => Promise.resolve() },
    });
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/health/ready`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('redacts dependency errors and protects metrics', async () => {
    const metrics = createServiceMetrics('worker-health-test');
    const server = await startWorkerHealthServer({
      host: '127.0.0.1',
      port: 0,
      logger: createLogger({ service: 'worker-health-test', level: 'fatal' }),
      metrics,
      metricsToken: token,
      readinessChecks: {
        database: () => Promise.reject(new Error('secret database address')),
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${origin}/health/live`)).status).toBe(200);
      const readiness = await fetch(`${origin}/health/ready`);
      expect(readiness.status).toBe(503);
      expect(await readiness.text()).not.toContain('secret database address');
      expect((await fetch(`${origin}/metrics`)).status).toBe(401);
      const authorized = await fetch(`${origin}/metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toContain('incidentbase_queue_depth');
    } finally {
      await server.close();
    }
  });
});

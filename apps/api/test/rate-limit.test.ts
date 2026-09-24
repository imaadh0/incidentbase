import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@incidentbase/observability';

import {
  createRateLimitMiddleware,
  RedisRateLimitStore,
  type RateLimitStore,
} from '../src/middleware/rate-limit.js';

const redisUrl = process.env.WORKER_TEST_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis('Redis sliding-window rate limits', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('allows exactly the quota under concurrent requests and expires the window', async () => {
    const store = new RedisRateLimitStore(redis);
    const key = `test:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.consume(key, 10, 1_000)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(2);
    expect(results.at(-1)?.retryAfterMs).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await store.consume(key, 10, 1_000)).allowed).toBe(true);
  });
});

describe('rate-limit middleware', () => {
  const logger = createLogger({ service: 'rate-test', level: 'fatal' });
  const resolvePrincipal = () => Promise.resolve({ userId: 'a-user' });

  it('uses separate login, creation, and command quotas', async () => {
    const counts = new Map<string, number>();
    const store: RateLimitStore = {
      consume: (key, limit) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return Promise.resolve({ allowed: count <= limit, retryAfterMs: 20_000 });
      },
    };
    const app = makeApp(store);
    for (let index = 0; index < 10; index += 1) await request(app).post('/auth/login').expect(204);
    const denied = await request(app).post('/auth/login').expect(429);
    expect(denied.headers['retry-after']).toBe('20');
    await request(app).post('/auth/login/').expect(429);
    const org = '6c9b9696-350c-4e42-ae78-9175d777cfdc';
    for (let index = 0; index < 10; index += 1)
      await request(app).post(`/organizations/${org}/incidents`).expect(204);
    await request(app).post(`/organizations/${org}/incidents`).expect(429);
    await request(app).post(`/organizations/${org}/incidents/${org}/resolve`).expect(204);
  });

  it('fails closed for login but leaves emergency incident commands available when Redis fails', async () => {
    const store: RateLimitStore = { consume: () => Promise.reject(new Error('Redis down')) };
    const app = makeApp(store);
    await request(app).post('/auth/login').expect(503);
    const org = '6c9b9696-350c-4e42-ae78-9175d777cfdc';
    await request(app).post(`/organizations/${org}/incidents/${org}/acknowledge`).expect(204);
  });

  function makeApp(store: RateLimitStore) {
    const app = express();
    app.use(createRateLimitMiddleware({ store, resolvePrincipal, logger }));
    app.post('/auth/login', (_incoming, response) => response.status(204).send());
    app.post('/organizations/:organizationId/incidents', (_incoming, response) =>
      response.status(204).send(),
    );
    app.post(
      '/organizations/:organizationId/incidents/:incidentId/:command',
      (_incoming, response) => response.status(204).send(),
    );
    app.use(
      (
        error: unknown,
        _incoming: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => {
        void _next;
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
            ? error.statusCode
            : 500;
        response.status(statusCode).json({ error: { code: 'TEST' } });
      },
    );
    return app;
  }
});
import { randomUUID } from 'node:crypto';

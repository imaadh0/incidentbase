import { createHash, randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ServiceMetrics } from '@incidentbase/observability';

import type { TenantPrincipalResolver } from '../routes/tenant-memberships.js';
import { ApplicationError } from '../errors/application-error.js';

const incidentCollection = /^\/organizations\/([0-9a-f-]{36})\/incidents$/iu;
const incidentCommand =
  /^\/organizations\/([0-9a-f-]{36})\/incidents\/[0-9a-f-]{36}\/(acknowledge|start-investigation|resolve|reopen|reassign)$/iu;

// Redis TIME makes windows consistent across API replicas. One atomic script
// removes expired requests, checks the quota, then records this request.
const slidingWindowScript = `
local now = redis.call('TIME')
local milliseconds = now[1] * 1000 + math.floor(now[2] / 1000)
local cutoff = milliseconds - tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(oldest[2]) + tonumber(ARGV[1]) - milliseconds)}
end
redis.call('ZADD', KEYS[1], milliseconds, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return {1, 0}
`;

export interface RateLimitStore {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

export class RedisRateLimitStore implements RateLimitStore {
  public constructor(private readonly redis: Redis) {}

  public async consume(key: string, limit: number, windowMs: number) {
    const result: unknown = await this.redis.eval(
      slidingWindowScript,
      1,
      `incidentbase:rate:${key}`,
      windowMs.toString(),
      limit.toString(),
      randomUUID(),
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid rate-limit result');
    const [allowed, retryAfterMs] = result as unknown[];
    if (typeof allowed !== 'number' || typeof retryAfterMs !== 'number')
      throw new Error('Invalid rate-limit result');
    return { allowed: allowed === 1, retryAfterMs };
  }
}

export function createRateLimitMiddleware(options: {
  store: RateLimitStore;
  resolvePrincipal: TenantPrincipalResolver;
  logger: Logger;
  metrics?: ServiceMetrics;
}): RequestHandler {
  return (request, response, next) => {
    void (async () => {
      if (request.method !== 'POST') return next();
      const path = request.path.replace(/\/+$/u, '').toLowerCase();
      const login = path === '/auth/login';
      const creation = incidentCollection.exec(path);
      const command = incidentCommand.exec(path);
      if (!login && creation === null && command === null) return next();
      const organizationId = creation?.[1] ?? command?.[1];
      if (organizationId !== undefined && !z.uuid().safeParse(organizationId).success)
        return next();
      const principal = login ? null : await options.resolvePrincipal(request);
      if (!login && principal === null) return next();
      const dimension = login
        ? `ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`
        : `member:${organizationId}:${principal!.userId}`;
      const bucket = login ? 'login' : creation !== null ? 'incident-create' : 'incident-command';
      const key = `${bucket}:${createHash('sha256').update(dimension).digest('hex')}`;
      const limit = login ? 10 : creation !== null ? 10 : 30;
      const windowMs = login ? 900_000 : 60_000;
      try {
        const result = await options.store.consume(key, limit, windowMs);
        if (!result.allowed) {
          options.metrics?.rateLimitDecisions.inc({ bucket, outcome: 'rejected' });
          response.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
          return next(
            new ApplicationError({
              code: 'RATE_LIMITED',
              message: 'Too many requests. Please try again shortly.',
              statusCode: 429,
            }),
          );
        }
        options.metrics?.rateLimitDecisions.inc({ bucket, outcome: 'allowed' });
      } catch (error: unknown) {
        options.metrics?.rateLimitDecisions.inc({ bucket, outcome: 'store_error' });
        options.logger.warn({ err: error, bucket }, 'Rate limit store unavailable');
        if (login)
          return next(
            new ApplicationError({
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'Sign-in is temporarily unavailable.',
              statusCode: 503,
            }),
          );
        // Incident operations remain available during a Redis outage.
      }
      return next();
    })().catch(next);
  };
}

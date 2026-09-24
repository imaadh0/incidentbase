import { timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from 'pino';
import type { ServiceMetrics } from '@incidentbase/observability';

interface WorkerHealthOptions {
  host: string;
  port: number;
  logger: Logger;
  metrics: ServiceMetrics;
  metricsToken: string;
  readinessChecks: Readonly<Record<string, () => Promise<void>>>;
}

export interface WorkerHealthServer {
  port: number;
  close(): Promise<void>;
}

export async function startWorkerHealthServer(
  options: WorkerHealthOptions,
): Promise<WorkerHealthServer> {
  const server = createServer((request, response) => {
    void serve(
      request.url ?? '/',
      request.method ?? '',
      request.headers.authorization,
      response,
    ).catch((error: unknown) => {
      options.logger.error({ err: error }, 'Worker health response failed');
      if (!response.headersSent) sendJson(response, 503, 'degraded');
      else response.destroy();
    });
  });

  async function serve(
    url: string,
    method: string,
    authorization: string | undefined,
    response: ServerResponse,
  ) {
    const path = new URL(url, 'http://worker.local').pathname;
    if (method !== 'GET') return sendJson(response, 404, 'not_found');
    if (path === '/health/live') return sendJson(response, 200, 'ok');
    if (path === '/health/ready') {
      const checks = Object.entries(options.readinessChecks);
      const results = await Promise.allSettled(checks.map(([, check]) => check()));
      const failedChecks = results.flatMap((result, index) =>
        result.status === 'rejected' ? [checks[index]?.[0] ?? 'unknown'] : [],
      );
      if (failedChecks.length > 0)
        options.logger.warn({ failedChecks }, 'Worker readiness degraded');
      return sendJson(
        response,
        failedChecks.length > 0 ? 503 : 200,
        failedChecks.length > 0 ? 'degraded' : 'ok',
      );
    }
    if (path === '/metrics') {
      const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      if (!tokenMatches(candidate, options.metricsToken))
        return sendJson(response, 401, 'unauthorized');
      const body = await options.metrics.registry.metrics();
      response.writeHead(200, { 'content-type': options.metrics.registry.contentType });
      response.end(body);
      return;
    }
    return sendJson(response, 404, 'not_found');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendJson(response: ServerResponse, status: number, state: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({ service: 'worker', status: state, timestamp: new Date().toISOString() }),
  );
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const actual = Buffer.from(candidate);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

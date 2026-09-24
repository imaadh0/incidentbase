import type { Server as HttpServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { Server } from 'socket.io';
import { z } from 'zod';

import type { AccessTokenService } from '@incidentbase/auth';
import {
  REALTIME_INCIDENT_EVENT,
  REALTIME_REDIS_CHANNEL,
  REALTIME_TOAST_EVENT,
  realtimeIncidentEventSchema,
} from '@incidentbase/contracts';
import { TenantAccessDeniedError, type TenantUnitOfWork } from '@incidentbase/database';

import { accessCookieName, readCookieHeader } from '../auth/request-authentication.js';

const organizationJoinSchema = z.object({ organizationId: z.uuid() });
type JoinAcknowledgement = (result: { ok: boolean }) => void;

interface RealtimeGatewayOptions {
  accessTokens: AccessTokenService;
  httpServer: HttpServer;
  logger: Logger;
  redisUrl: string;
  tenantUnitOfWork: TenantUnitOfWork;
  webOrigin: string;
}

export interface RealtimeGateway {
  close(): Promise<void>;
}

export async function createRealtimeGateway(
  options: RealtimeGatewayOptions,
): Promise<RealtimeGateway> {
  const publisher = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const adapterSubscriber = publisher.duplicate();
  const eventSubscriber = publisher.duplicate();
  await Promise.all([
    publisher.ping(),
    adapterSubscriber.ping(),
    eventSubscriber.subscribe(REALTIME_REDIS_CHANNEL),
  ]);

  const io = new Server(options.httpServer, {
    cors: { credentials: true, origin: options.webOrigin },
    path: '/socket.io',
  });
  io.adapter(createAdapter(publisher, adapterSubscriber));

  io.use((socket, next) => {
    void (async () => {
      const token = readCookieHeader(socket.handshake.headers.cookie, accessCookieName);
      const principal = token === undefined ? null : await options.accessTokens.verify(token);
      if (principal === null) {
        next(new Error('Authentication required'));
        return;
      }
      (socket.data as { userId?: string }).userId = principal.userId;
      next();
    })();
  });

  io.on('connection', (socket) => {
    const userId = readSocketUserId(socket.data);
    if (userId === null) {
      socket.disconnect(true);
      return;
    }
    void socket.join(userRoom(userId));

    socket.on(
      'organization:join',
      async (input: unknown, acknowledge?: JoinAcknowledgement): Promise<void> => {
        const parsed = organizationJoinSchema.safeParse(input);
        if (!parsed.success) {
          acknowledge?.({ ok: false });
          return;
        }
        try {
          await options.tenantUnitOfWork.withTenant(
            { organizationId: parsed.data.organizationId, userId },
            () => Promise.resolve(undefined),
          );
          for (const room of socket.rooms) {
            if (room.startsWith('organization:')) await socket.leave(room);
          }
          await socket.join(organizationRoom(parsed.data.organizationId));
          acknowledge?.({ ok: true });
        } catch (error: unknown) {
          if (!(error instanceof TenantAccessDeniedError)) {
            options.logger.error({ err: error }, 'Socket organization join failed');
          }
          acknowledge?.({ ok: false });
        }
      },
    );
  });

  eventSubscriber.on('message', (channel, message) => {
    if (channel !== REALTIME_REDIS_CHANNEL) return;
    const parsed = realtimeIncidentEventSchema.safeParse(safeJsonParse(message));
    if (!parsed.success) {
      options.logger.warn({ channel }, 'Ignored malformed realtime event');
      return;
    }
    void broadcastEvent(parsed.data).catch((error: unknown) => {
      options.logger.error({ err: error }, 'Realtime event broadcast failed');
    });
  });

  async function broadcastEvent(
    event: ReturnType<typeof realtimeIncidentEventSchema.parse>,
  ): Promise<void> {
    const organizationSockets = await io.local
      .in(organizationRoom(event.organizationId))
      .fetchSockets();
    for (const socket of organizationSockets) {
      const userId = readSocketUserId(socket.data);
      if (userId === null) continue;
      if (await remainsActive(userId, event.organizationId)) {
        socket.emit(REALTIME_INCIDENT_EVENT, event);
      } else {
        socket.leave(organizationRoom(event.organizationId));
      }
    }

    if (event.recipientUserId === undefined) return;
    const recipientSockets = await io.local.in(userRoom(event.recipientUserId)).fetchSockets();
    if (!(await remainsActive(event.recipientUserId, event.organizationId))) return;
    for (const socket of recipientSockets) socket.emit(REALTIME_TOAST_EVENT, event);
  }

  async function remainsActive(userId: string, organizationId: string): Promise<boolean> {
    try {
      await options.tenantUnitOfWork.withTenant({ organizationId, userId }, () =>
        Promise.resolve(undefined),
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof TenantAccessDeniedError) return false;
      throw error;
    }
  }

  return {
    close: async () => {
      await io.close();
      await Promise.all([publisher.quit(), adapterSubscriber.quit(), eventSubscriber.quit()]);
    },
  };
}

function readSocketUserId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('userId' in data)) return null;
  return typeof data.userId === 'string' ? data.userId : null;
}

function organizationRoom(organizationId: string): string {
  return `organization:${organizationId}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

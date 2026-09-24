import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';

import { hasPermission } from '@incidentbase/authorization';
import {
  NotificationSecretCodec,
  TenantAccessDeniedError,
  type TenantTransaction,
  type TenantUnitOfWork,
} from '@incidentbase/database';

import { hasValidCsrfToken } from '../auth/request-authentication.js';
import { ApplicationError } from '../errors/application-error.js';
import type { TenantPrincipalResolver } from './tenant-memberships.js';

const parametersSchema = z.object({ organizationId: z.uuid() });
const settingsSchema = z.strictObject({
  emailEnabled: z.boolean().optional(),
  slackEnabled: z.boolean().optional(),
  discordEnabled: z.boolean().optional(),
  slackWebhookUrl: z.url().nullable().optional(),
  discordWebhookUrl: z.url().nullable().optional(),
});
const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface Options {
  resolvePrincipal: TenantPrincipalResolver;
  unitOfWork: TenantUnitOfWork;
  encryptionKey: string;
}

export function createTenantNotificationRouter(options: Options): Router {
  const router = Router();
  const codec = new NotificationSecretCodec(options.encryptionKey);

  async function withAdmin<T>(
    request: Request,
    action: (tenant: TenantTransaction, organizationId: string) => Promise<T>,
  ): Promise<T> {
    const parsed = parametersSchema.safeParse(request.params);
    if (!parsed.success) throw resourceNotFound();
    const principal = await options.resolvePrincipal(request);
    if (principal === null)
      throw applicationError('UNAUTHORIZED', 'Authentication is required.', 401);
    try {
      return await options.unitOfWork.withTenant(
        { organizationId: parsed.data.organizationId, userId: principal.userId },
        async (tenant) => {
          if (!hasPermission(tenant.actorMembership.role, 'notifications:manage')) {
            throw applicationError(
              'FORBIDDEN',
              'Notification administration requires Owner or Admin.',
              403,
            );
          }
          return action(tenant, parsed.data.organizationId);
        },
      );
    } catch (error: unknown) {
      if (error instanceof TenantAccessDeniedError) throw resourceNotFound();
      throw error;
    }
  }

  router.get('/organizations/:organizationId/notification-settings', async (request, response) => {
    const data = await withAdmin(request, async ({ transaction }, organizationId) => {
      const settings = await transaction.notificationSetting.findUnique({
        where: { organizationId },
      });
      return publicSettings(settings);
    });
    response.json({ data });
  });

  router.put('/organizations/:organizationId/notification-settings', async (request, response) => {
    requireCsrf(request);
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success)
      throw applicationError('VALIDATION_FAILED', 'The notification settings are invalid.', 400);
    const data = await withAdmin(
      request,
      async ({ transaction, actorMembership }, organizationId) => {
        const current = await transaction.notificationSetting.findUnique({
          where: { organizationId },
        });
        const slackCiphertext =
          parsed.data.slackWebhookUrl === undefined
            ? (current?.slackWebhookCiphertext ?? null)
            : parsed.data.slackWebhookUrl === null
              ? null
              : encrypt('SLACK', parsed.data.slackWebhookUrl);
        const discordCiphertext =
          parsed.data.discordWebhookUrl === undefined
            ? (current?.discordWebhookCiphertext ?? null)
            : parsed.data.discordWebhookUrl === null
              ? null
              : encrypt('DISCORD', parsed.data.discordWebhookUrl);
        const emailEnabled = parsed.data.emailEnabled ?? current?.emailEnabled ?? false;
        const slackEnabled = parsed.data.slackEnabled ?? current?.slackEnabled ?? false;
        const discordEnabled = parsed.data.discordEnabled ?? current?.discordEnabled ?? false;
        if ((slackEnabled && !slackCiphertext) || (discordEnabled && !discordCiphertext)) {
          throw applicationError('VALIDATION_FAILED', 'Enabled webhooks require a URL.', 400);
        }
        const settings = await transaction.notificationSetting.upsert({
          where: { organizationId },
          create: {
            organizationId,
            emailEnabled,
            slackEnabled,
            discordEnabled,
            slackWebhookCiphertext: slackCiphertext,
            discordWebhookCiphertext: discordCiphertext,
          },
          update: {
            emailEnabled,
            slackEnabled,
            discordEnabled,
            slackWebhookCiphertext: slackCiphertext,
            discordWebhookCiphertext: discordCiphertext,
          },
        });
        await transaction.auditLog.create({
          data: {
            organizationId,
            actorMembershipId: actorMembership.id,
            actorType: 'USER',
            action: 'notification.settings-updated',
            metadata: { emailEnabled, slackEnabled, discordEnabled },
          },
        });
        return publicSettings(settings);

        function encrypt(channel: 'SLACK' | 'DISCORD', url: string): string {
          try {
            return codec.encrypt(organizationId, channel, url);
          } catch {
            throw applicationError(
              'VALIDATION_FAILED',
              'Webhook URL must use an approved provider host.',
              400,
            );
          }
        }
      },
    );
    response.json({ data });
  });

  router.post(
    '/organizations/:organizationId/notification-settings/test',
    async (request, response) => {
      requireCsrf(request);
      const data = await withAdmin(
        request,
        async ({ transaction, actorMembership }, organizationId) => {
          await transaction.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::UUID FOR UPDATE`;
          const count = await transaction.auditLog.count({
            where: {
              organizationId,
              action: 'notification.test-requested',
              createdAt: { gte: new Date(Date.now() - 3_600_000) },
            },
          });
          if (count >= 5)
            throw applicationError('RATE_LIMITED', 'Test notification limit reached.', 429);
          const settings = await transaction.notificationSetting.findUnique({
            where: { organizationId },
          });
          if (
            settings === null ||
            (!settings.emailEnabled && !settings.slackEnabled && !settings.discordEnabled)
          ) {
            throw applicationError(
              'VALIDATION_FAILED',
              'Enable at least one notification channel first.',
              400,
            );
          }
          const eventId = randomUUID();
          await transaction.auditLog.create({
            data: {
              organizationId,
              actorMembershipId: actorMembership.id,
              actorType: 'USER',
              action: 'notification.test-requested',
              metadata: { eventId },
            },
          });
          await transaction.outboxEvent.create({
            data: {
              id: eventId,
              organizationId,
              aggregateType: 'notification-test',
              aggregateId: actorMembership.id,
              eventType: 'notification.test-requested',
              payload: { requestedBy: actorMembership.id },
              deduplicationKey: `notification-test:${eventId}`,
            },
          });
          const common = {
            organizationId,
            eventId,
            subject: 'IncidentBase test notification',
            body: 'Your IncidentBase notification channel is working.',
          };
          const channels = [
            ...(settings.emailEnabled
              ? [
                  {
                    ...common,
                    channel: 'EMAIL' as const,
                    recipient:
                      (
                        await transaction.user.findUnique({
                          where: { id: actorMembership.userId },
                          select: { email: true },
                        })
                      )?.email ?? '',
                    deliveryKey: `${eventId}:EMAIL:${actorMembership.id}`,
                  },
                ]
              : []),
            ...(settings.slackEnabled
              ? [
                  {
                    ...common,
                    channel: 'SLACK' as const,
                    recipient: 'Slack webhook',
                    deliveryKey: `${eventId}:SLACK`,
                  },
                ]
              : []),
            ...(settings.discordEnabled
              ? [
                  {
                    ...common,
                    channel: 'DISCORD' as const,
                    recipient: 'Discord webhook',
                    deliveryKey: `${eventId}:DISCORD`,
                  },
                ]
              : []),
          ];
          await transaction.notificationDelivery.createMany({ data: channels });
          return { eventId, queued: channels.length };
        },
      );
      response.status(202).json({ data });
    },
  );

  router.get(
    '/organizations/:organizationId/notification-deliveries',
    async (request, response) => {
      const query = deliveriesQuerySchema.safeParse(request.query);
      if (!query.success) throw applicationError('VALIDATION_FAILED', 'The query is invalid.', 400);
      const data = await withAdmin(request, async ({ transaction }, organizationId) =>
        transaction.notificationDelivery.findMany({
          where: { organizationId },
          select: {
            id: true,
            eventId: true,
            channel: true,
            recipient: true,
            status: true,
            attempts: true,
            providerId: true,
            lastError: true,
            createdAt: true,
            sentAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: query.data.limit,
        }),
      );
      response.json({ data });
    },
  );

  return router;
}

function publicSettings(
  settings: {
    emailEnabled: boolean;
    slackEnabled: boolean;
    discordEnabled: boolean;
    slackWebhookCiphertext: string | null;
    discordWebhookCiphertext: string | null;
  } | null,
) {
  return {
    emailEnabled: settings?.emailEnabled ?? false,
    slackEnabled: settings?.slackEnabled ?? false,
    discordEnabled: settings?.discordEnabled ?? false,
    slackConfigured: !!settings?.slackWebhookCiphertext,
    discordConfigured: !!settings?.discordWebhookCiphertext,
  };
}

function applicationError(code: string, message: string, statusCode: number): ApplicationError {
  return new ApplicationError({ code, message, statusCode });
}
function resourceNotFound(): ApplicationError {
  return applicationError('RESOURCE_NOT_FOUND', 'The requested resource does not exist.', 404);
}
function requireCsrf(request: Request): void {
  if (request.header('authorization')?.startsWith('Bearer ') === true) return;
  if (!hasValidCsrfToken(request))
    throw applicationError('CSRF_VALIDATION_FAILED', 'A valid CSRF token is required.', 403);
}

import { Router, type Request } from 'express';
import { z } from 'zod';

import { createOpaqueToken, hashOpaqueToken } from '@incidentbase/auth';
import { canManageMembership, hasPermission } from '@incidentbase/authorization';
import { invitationRequestSchema, membershipUpdateRequestSchema } from '@incidentbase/contracts';
import { TenantAccessDeniedError, type TenantUnitOfWork } from '@incidentbase/database';

import { ApplicationError } from '../errors/application-error.js';
import { hasValidCsrfToken } from '../auth/request-authentication.js';

const routeParametersSchema = z.object({
  membershipId: z.uuid(),
  organizationId: z.uuid(),
});

const organizationParametersSchema = z.object({ organizationId: z.uuid() });

export interface TenantPrincipal {
  userId: string;
}

export type TenantPrincipalResolver = (request: Request) => Promise<TenantPrincipal | null>;

interface TenantMembershipRouterOptions {
  resolvePrincipal: TenantPrincipalResolver;
  unitOfWork: TenantUnitOfWork;
}

function unavailableResourceError(): ApplicationError {
  return new ApplicationError({
    code: 'RESOURCE_NOT_FOUND',
    message: 'The requested resource does not exist.',
    statusCode: 404,
  });
}

export function createTenantMembershipRouter(options: TenantMembershipRouterOptions): Router {
  const router = Router();

  async function requirePrincipal(request: Request): Promise<TenantPrincipal> {
    const principal = await options.resolvePrincipal(request);
    if (principal === null) {
      throw new ApplicationError({
        code: 'UNAUTHORIZED',
        message: 'Authentication is required.',
        statusCode: 401,
      });
    }
    return principal;
  }

  router.get('/organizations/:organizationId/members', async (request, response) => {
    const principal = await requirePrincipal(request);
    const parameters = organizationParametersSchema.safeParse(request.params);
    if (!parameters.success) throw unavailableResourceError();

    try {
      const memberships = await options.unitOfWork.withTenant(
        { organizationId: parameters.data.organizationId, userId: principal.userId },
        (tenant) => tenant.memberships.list(),
      );
      response.json({
        data: memberships.map(({ displayName, id, organizationId, role, status, userId }) => ({
          displayName,
          id,
          organizationId,
          role,
          status,
          userId,
        })),
      });
    } catch (error: unknown) {
      if (error instanceof TenantAccessDeniedError) throw unavailableResourceError();
      throw error;
    }
  });

  router.post('/organizations/:organizationId/invitations', async (request, response) => {
    requireMutationCsrf(request);
    const principal = await requirePrincipal(request);
    const parameters = organizationParametersSchema.safeParse(request.params);
    const body = invitationRequestSchema.safeParse(request.body);
    if (!parameters.success) throw unavailableResourceError();
    if (!body.success) {
      throw new ApplicationError({
        code: 'VALIDATION_FAILED',
        message: 'The request body is invalid.',
        statusCode: 400,
      });
    }

    const token = createOpaqueToken();
    try {
      const invitation = await options.unitOfWork.withTenant(
        { organizationId: parameters.data.organizationId, userId: principal.userId },
        async (tenant) => {
          const actorRole = tenant.actorMembership.role;
          if (
            !hasPermission(actorRole, 'members:invite') ||
            (body.data.role === 'OWNER' && actorRole !== 'OWNER')
          ) {
            throw forbiddenError();
          }
          return tenant.invitations.create({
            email: body.data.email,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            invitedByUserId: principal.userId,
            organizationId: parameters.data.organizationId,
            role: body.data.role,
            tokenHash: hashOpaqueToken(token),
          });
        },
      );
      response.status(201).json({
        data: {
          email: invitation.email,
          expiresAt: invitation.expiresAt.toISOString(),
          id: invitation.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
          token,
        },
      });
    } catch (error: unknown) {
      if (error instanceof TenantAccessDeniedError) throw unavailableResourceError();
      throw error;
    }
  });

  router.patch(
    '/organizations/:organizationId/members/:membershipId',
    async (request, response) => {
      requireMutationCsrf(request);
      const principal = await requirePrincipal(request);
      const parameters = routeParametersSchema.safeParse(request.params);
      const body = membershipUpdateRequestSchema.safeParse(request.body);
      if (!parameters.success) throw unavailableResourceError();
      if (!body.success) {
        throw new ApplicationError({
          code: 'VALIDATION_FAILED',
          message: 'The request body is invalid.',
          statusCode: 400,
        });
      }

      try {
        const membership = await options.unitOfWork.withTenant(
          { organizationId: parameters.data.organizationId, userId: principal.userId },
          async (tenant) => {
            const target = await tenant.memberships.findById(parameters.data.membershipId);
            if (
              target === null ||
              !canManageMembership(tenant.actorMembership.role, target.role) ||
              (body.data.role === 'OWNER' && tenant.actorMembership.role !== 'OWNER')
            ) {
              throw target === null ? unavailableResourceError() : forbiddenError();
            }
            return tenant.memberships.update(
              parameters.data.organizationId,
              parameters.data.membershipId,
              {
                ...(body.data.role === undefined ? {} : { role: body.data.role }),
                ...(body.data.status === undefined ? {} : { status: body.data.status }),
              },
            );
          },
        );
        response.json({ data: membership });
      } catch (error: unknown) {
        handleMembershipMutationError(error);
      }
    },
  );

  router.delete(
    '/organizations/:organizationId/members/:membershipId',
    async (request, response) => {
      requireMutationCsrf(request);
      const principal = await requirePrincipal(request);
      const parameters = routeParametersSchema.safeParse(request.params);
      if (!parameters.success) throw unavailableResourceError();

      try {
        await options.unitOfWork.withTenant(
          { organizationId: parameters.data.organizationId, userId: principal.userId },
          async (tenant) => {
            const target = await tenant.memberships.findById(parameters.data.membershipId);
            if (target === null || !canManageMembership(tenant.actorMembership.role, target.role)) {
              throw target === null ? unavailableResourceError() : forbiddenError();
            }
            await tenant.memberships.delete(
              parameters.data.organizationId,
              parameters.data.membershipId,
            );
          },
        );
        response.status(204).send();
      } catch (error: unknown) {
        handleMembershipMutationError(error);
      }
    },
  );

  router.get(
    '/organizations/:organizationId/memberships/:membershipId',
    async (request, response) => {
      const principal = await requirePrincipal(request);

      const parameters = routeParametersSchema.safeParse(request.params);
      if (!parameters.success) {
        throw unavailableResourceError();
      }

      try {
        const membership = await options.unitOfWork.withTenant(
          {
            organizationId: parameters.data.organizationId,
            userId: principal.userId,
          },
          (tenant) => tenant.memberships.findById(parameters.data.membershipId),
        );

        if (membership === null) {
          throw unavailableResourceError();
        }

        response.json({
          data: {
            id: membership.id,
            organizationId: membership.organizationId,
            role: membership.role,
            status: membership.status,
            userId: membership.userId,
          },
        });
      } catch (error: unknown) {
        if (error instanceof TenantAccessDeniedError) {
          throw unavailableResourceError();
        }
        throw error;
      }
    },
  );

  return router;
}

function forbiddenError(): ApplicationError {
  return new ApplicationError({
    code: 'FORBIDDEN',
    message: 'The authenticated member cannot perform this action.',
    statusCode: 403,
  });
}

function requireMutationCsrf(request: Request): void {
  if (request.header('authorization')?.startsWith('Bearer ') === true) {
    return;
  }
  if (!hasValidCsrfToken(request)) {
    throw new ApplicationError({
      code: 'CSRF_VALIDATION_FAILED',
      message: 'A valid CSRF token is required.',
      statusCode: 403,
    });
  }
}

function handleMembershipMutationError(error: unknown): never {
  if (error instanceof TenantAccessDeniedError) throw unavailableResourceError();
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    String(error.message).includes('must retain at least one active owner')
  ) {
    throw new ApplicationError({
      code: 'LAST_OWNER_REQUIRED',
      message: 'The organization must retain at least one active Owner.',
      statusCode: 409,
    });
  }
  throw error;
}

import { Router, type Request } from 'express';
import { z } from 'zod';

import { TenantAccessDeniedError, type TenantUnitOfWork } from '@incidentbase/database';

import { ApplicationError } from '../errors/application-error.js';

const routeParametersSchema = z.object({
  membershipId: z.uuid(),
  organizationId: z.uuid(),
});

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

  router.get(
    '/organizations/:organizationId/memberships/:membershipId',
    async (request, response) => {
      const principal = await options.resolvePrincipal(request);
      if (principal === null) {
        throw new ApplicationError({
          code: 'UNAUTHORIZED',
          message: 'Authentication is required.',
          statusCode: 401,
        });
      }

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

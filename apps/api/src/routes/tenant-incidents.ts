import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { hasPermission } from '@incidentbase/authorization';
import {
  createEscalationPolicyRequestSchema,
  createEscalationPolicyRevisionRequestSchema,
  createIncidentRequestSchema,
  incidentListQuerySchema,
  reassignIncidentRequestSchema,
  setDefaultEscalationPolicyRequestSchema,
  timelineQuerySchema,
  updateIncidentRequestSchema,
} from '@incidentbase/contracts';
import {
  DefaultEscalationPolicyRequiredError,
  DefaultPolicyArchiveError,
  IncidentConflictError,
  IncidentNotFoundError,
  InvalidIncidentAssigneeError,
  InvalidPolicyResponderError,
  PolicyUnavailableError,
  TenantAccessDeniedError,
  type TenantTransaction,
  type TenantUnitOfWork,
} from '@incidentbase/database';

import { hasValidCsrfToken } from '../auth/request-authentication.js';
import { ApplicationError } from '../errors/application-error.js';
import type { TenantPrincipalResolver } from './tenant-memberships.js';

const organizationParametersSchema = z.object({ organizationId: z.uuid() });
const policyParametersSchema = z.object({ organizationId: z.uuid(), policyId: z.uuid() });
const incidentParametersSchema = z.object({ incidentId: z.uuid(), organizationId: z.uuid() });

interface TenantIncidentRouterOptions {
  resolvePrincipal: TenantPrincipalResolver;
  unitOfWork: TenantUnitOfWork;
}

export function createTenantIncidentRouter(options: TenantIncidentRouterOptions): Router {
  const router = Router();

  router.get('/organizations/:organizationId/policies', async (request, response) => {
    const organizationId = parseOrganizationId(request);
    const result = await withTenant(request, organizationId, options, async (tenant) => {
      requirePermission(tenant, 'policies:read');
      const organization = await tenant.organizations.findById(organizationId);
      return {
        defaultPolicyId: organization?.defaultEscalationPolicyId ?? null,
        policies: await tenant.policies.list(),
      };
    });
    response.json({ data: result });
  });

  router.post('/organizations/:organizationId/policies', async (request, response) => {
    requireMutationCsrf(request);
    const organizationId = parseOrganizationId(request);
    const body = parseBody(createEscalationPolicyRequestSchema, request.body);
    const policy = await withTenant(request, organizationId, options, async (tenant) => {
      requirePermission(tenant, 'policies:manage');
      return tenant.policies.create({
        actorMembershipId: tenant.actorMembership.id,
        organizationId,
        ...body,
      });
    });
    response.status(201).json({ data: policy });
  });

  router.post(
    '/organizations/:organizationId/policies/:policyId/revisions',
    async (request, response) => {
      requireMutationCsrf(request);
      const parameters = parseParameters(policyParametersSchema, request.params);
      const body = parseBody(createEscalationPolicyRevisionRequestSchema, request.body);
      const policy = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          requirePermission(tenant, 'policies:manage');
          return tenant.policies.createRevision(parameters.policyId, {
            actorMembershipId: tenant.actorMembership.id,
            organizationId: parameters.organizationId,
            ...body,
          });
        },
      );
      response.status(201).json({ data: policy });
    },
  );

  router.put('/organizations/:organizationId/default-policy', async (request, response) => {
    requireMutationCsrf(request);
    const organizationId = parseOrganizationId(request);
    const body = parseBody(setDefaultEscalationPolicyRequestSchema, request.body);
    const policy = await withTenant(request, organizationId, options, async (tenant) => {
      requirePermission(tenant, 'policies:manage');
      return tenant.policies.setDefault(organizationId, body.policyId, tenant.actorMembership.id);
    });
    response.json({ data: policy });
  });

  router.post(
    '/organizations/:organizationId/policies/:policyId/archive',
    async (request, response) => {
      requireMutationCsrf(request);
      const parameters = parseParameters(policyParametersSchema, request.params);
      await withTenant(request, parameters.organizationId, options, async (tenant) => {
        requirePermission(tenant, 'policies:manage');
        await tenant.policies.archive(
          parameters.organizationId,
          parameters.policyId,
          tenant.actorMembership.id,
        );
      });
      response.status(204).send();
    },
  );

  router.get('/organizations/:organizationId/incidents', async (request, response) => {
    const organizationId = parseOrganizationId(request);
    const query = parseQuery(incidentListQuerySchema, request.query);
    const incidents = await withTenant(request, organizationId, options, async (tenant) => {
      requirePermission(tenant, 'incidents:read');
      return tenant.incidents.list(query.status);
    });
    response.json({ data: incidents });
  });

  router.post('/organizations/:organizationId/incidents', async (request, response) => {
    requireMutationCsrf(request);
    const organizationId = parseOrganizationId(request);
    const body = parseBody(createIncidentRequestSchema, request.body);
    const incident = await withTenant(request, organizationId, options, async (tenant) => {
      requirePermission(tenant, 'incidents:create');
      return tenant.incidents.create({
        ...body,
        organizationId,
        reporterMembershipId: tenant.actorMembership.id,
      });
    });
    sendIncident(response, 201, incident);
  });

  router.get('/organizations/:organizationId/incidents/:incidentId', async (request, response) => {
    const parameters = parseParameters(incidentParametersSchema, request.params);
    const incident = await withTenant(
      request,
      parameters.organizationId,
      options,
      async (tenant) => {
        requirePermission(tenant, 'incidents:read');
        const found = await tenant.incidents.findById(parameters.incidentId);
        if (found === null) throw unavailableResourceError();
        return found;
      },
    );
    sendIncident(response, 200, incident);
  });

  router.patch(
    '/organizations/:organizationId/incidents/:incidentId',
    async (request, response) => {
      requireMutationCsrf(request);
      const parameters = parseParameters(incidentParametersSchema, request.params);
      const expectedVersion = parseIfMatch(request);
      const body = parseBody(updateIncidentRequestSchema, request.body);
      const incident = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          requirePermission(tenant, 'incidents:override');
          return tenant.incidents.updateDetails(
            parameters.incidentId,
            expectedVersion,
            {
              membershipId: tenant.actorMembership.id,
              override: true,
            },
            body,
          );
        },
      );
      sendIncident(response, 200, incident);
    },
  );

  addOperationalCommand(router, options, 'acknowledge', (tenant, id, version, override) =>
    tenant.incidents.acknowledge(id, version, {
      membershipId: tenant.actorMembership.id,
      override,
    }),
  );
  addOperationalCommand(router, options, 'start-investigation', (tenant, id, version, override) =>
    tenant.incidents.startInvestigation(id, version, {
      membershipId: tenant.actorMembership.id,
      override,
    }),
  );
  addOperationalCommand(router, options, 'resolve', (tenant, id, version, override) =>
    tenant.incidents.resolve(id, version, {
      membershipId: tenant.actorMembership.id,
      override,
    }),
  );

  router.post(
    '/organizations/:organizationId/incidents/:incidentId/reopen',
    async (request, response) => {
      requireMutationCsrf(request);
      const parameters = parseParameters(incidentParametersSchema, request.params);
      const expectedVersion = parseIfMatch(request);
      const incident = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          requirePermission(tenant, 'incidents:reopen');
          return tenant.incidents.reopen(
            parameters.incidentId,
            expectedVersion,
            tenant.actorMembership.id,
          );
        },
      );
      sendIncident(response, 200, incident);
    },
  );

  router.post(
    '/organizations/:organizationId/incidents/:incidentId/reassign',
    async (request, response) => {
      requireMutationCsrf(request);
      const parameters = parseParameters(incidentParametersSchema, request.params);
      const expectedVersion = parseIfMatch(request);
      const body = parseBody(reassignIncidentRequestSchema, request.body);
      const incident = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          requirePermission(tenant, 'incidents:override');
          return tenant.incidents.reassign(
            parameters.incidentId,
            expectedVersion,
            tenant.actorMembership.id,
            body.membershipId,
          );
        },
      );
      sendIncident(response, 200, incident);
    },
  );

  router.get(
    '/organizations/:organizationId/incidents/:incidentId/timeline',
    async (request, response) => {
      const parameters = parseParameters(incidentParametersSchema, request.params);
      const query = parseQuery(timelineQuerySchema, request.query);
      const timeline = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          requirePermission(tenant, 'incidents:read');
          if ((await tenant.incidents.findById(parameters.incidentId)) === null) {
            throw unavailableResourceError();
          }
          return tenant.incidents.timeline(
            parameters.incidentId,
            query.after === undefined ? undefined : BigInt(query.after),
            query.limit,
          );
        },
      );
      response.json({
        data: timeline.map((entry) => ({ ...entry, id: entry.id.toString() })),
      });
    },
  );

  router.get(
    '/organizations/:organizationId/incidents/:incidentId/summaries',
    async (request, response) => {
      const parameters = parseParameters(incidentParametersSchema, request.params);
      const summaries = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          requirePermission(tenant, 'incidents:read');
          if ((await tenant.incidents.findById(parameters.incidentId)) === null) {
            throw unavailableResourceError();
          }
          return tenant.incidents.summaries(parameters.incidentId);
        },
      );
      response.json({ data: summaries });
    },
  );

  return router;
}

function addOperationalCommand(
  router: Router,
  options: TenantIncidentRouterOptions,
  command: string,
  execute: (
    tenant: TenantTransaction,
    incidentId: string,
    expectedVersion: number,
    override: boolean,
  ) => Promise<unknown>,
): void {
  router.post(
    `/organizations/:organizationId/incidents/:incidentId/${command}`,
    async (request, response) => {
      requireMutationCsrf(request);
      const parameters = parseParameters(incidentParametersSchema, request.params);
      const expectedVersion = parseIfMatch(request);
      const incident = await withTenant(
        request,
        parameters.organizationId,
        options,
        async (tenant) => {
          const override = hasPermission(tenant.actorMembership.role, 'incidents:override');
          if (
            !override &&
            !hasPermission(tenant.actorMembership.role, 'incidents:operate-assigned')
          ) {
            throw forbiddenError();
          }
          const current = await tenant.incidents.findById(parameters.incidentId);
          if (current === null) throw unavailableResourceError();
          if (!override && current.assignedMembershipId !== tenant.actorMembership.id) {
            throw forbiddenError();
          }
          return execute(tenant, parameters.incidentId, expectedVersion, override);
        },
      );
      sendIncident(response, 200, incident);
    },
  );
}

async function withTenant<T>(
  request: Request,
  organizationId: string,
  options: TenantIncidentRouterOptions,
  operation: (tenant: TenantTransaction) => Promise<T>,
): Promise<T> {
  const principal = await options.resolvePrincipal(request);
  if (principal === null) {
    throw new ApplicationError({
      code: 'UNAUTHORIZED',
      message: 'Authentication is required.',
      statusCode: 401,
    });
  }
  try {
    return await options.unitOfWork.withTenant(
      { organizationId, userId: principal.userId },
      operation,
    );
  } catch (error: unknown) {
    mapTenantError(error);
  }
}

function mapTenantError(error: unknown): never {
  if (error instanceof TenantAccessDeniedError || error instanceof IncidentNotFoundError) {
    throw unavailableResourceError();
  }
  if (error instanceof IncidentConflictError) {
    throw new ApplicationError({
      code: 'INCIDENT_VERSION_CONFLICT',
      details: { current: error.current },
      message: 'The incident changed before this command could be applied.',
      statusCode: 409,
    });
  }
  if (error instanceof DefaultEscalationPolicyRequiredError) {
    throw new ApplicationError({
      code: 'DEFAULT_POLICY_REQUIRED',
      message: error.message,
      statusCode: 409,
    });
  }
  if (error instanceof DefaultPolicyArchiveError) {
    throw new ApplicationError({
      code: 'DEFAULT_POLICY_ARCHIVE_FORBIDDEN',
      message: error.message,
      statusCode: 409,
    });
  }
  if (
    error instanceof InvalidPolicyResponderError ||
    error instanceof InvalidIncidentAssigneeError
  ) {
    throw new ApplicationError({
      code: 'VALIDATION_FAILED',
      message: error.message,
      statusCode: 400,
    });
  }
  if (error instanceof PolicyUnavailableError) throw unavailableResourceError();
  throw error;
}

function requirePermission(
  tenant: TenantTransaction,
  permission: Parameters<typeof hasPermission>[1],
): void {
  if (!hasPermission(tenant.actorMembership.role, permission)) throw forbiddenError();
}

function parseOrganizationId(request: Request): string {
  return parseParameters(organizationParametersSchema, request.params).organizationId;
}

function parseParameters<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailableResourceError();
  return result.data;
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApplicationError({
      code: 'VALIDATION_FAILED',
      message: 'The request body is invalid.',
      statusCode: 400,
    });
  }
  return result.data;
}

function parseQuery<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApplicationError({
      code: 'VALIDATION_FAILED',
      message: 'The query parameters are invalid.',
      statusCode: 400,
    });
  }
  return result.data;
}

function parseIfMatch(request: Request): number {
  const match = /^"([1-9]\d*)"$/u.exec(request.header('if-match') ?? '');
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new ApplicationError({
      code: 'PRECONDITION_REQUIRED',
      message: 'A current quoted incident version is required in If-Match.',
      statusCode: 428,
    });
  }
  return version;
}

function sendIncident(response: Response, statusCode: number, incident: unknown): void {
  if (
    typeof incident === 'object' &&
    incident !== null &&
    'version' in incident &&
    typeof incident.version === 'number'
  ) {
    response.set('ETag', `"${incident.version}"`);
  }
  response.status(statusCode).json({ data: incident });
}

function unavailableResourceError(): ApplicationError {
  return new ApplicationError({
    code: 'RESOURCE_NOT_FOUND',
    message: 'The requested resource does not exist.',
    statusCode: 404,
  });
}

function forbiddenError(): ApplicationError {
  return new ApplicationError({
    code: 'FORBIDDEN',
    message: 'The authenticated member cannot perform this action.',
    statusCode: 403,
  });
}

function requireMutationCsrf(request: Request): void {
  if (request.header('authorization')?.startsWith('Bearer ') === true) return;
  if (!hasValidCsrfToken(request)) {
    throw new ApplicationError({
      code: 'CSRF_VALIDATION_FAILED',
      message: 'A valid CSRF token is required.',
      statusCode: 403,
    });
  }
}

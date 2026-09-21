import type { Prisma } from './generated/prisma/client.js';
import { InvitationRepository } from './repositories/invitation-repository.js';
import { MembershipRepository } from './repositories/membership-repository.js';
import { OrganizationRepository } from './repositories/organization-repository.js';
import { RefreshSessionRepository } from './repositories/refresh-session-repository.js';
import type { DatabaseClient } from './client.js';

export interface TenantContext {
  organizationId: string;
  userId: string;
}

export interface TenantTransaction {
  invitations: InvitationRepository;
  memberships: MembershipRepository;
  organizations: OrganizationRepository;
  refreshSessions: RefreshSessionRepository;
  transaction: Prisma.TransactionClient;
}

export class TenantAccessDeniedError extends Error {
  public constructor() {
    super('The requested tenant context is unavailable.');
    this.name = 'TenantAccessDeniedError';
  }
}

export class TenantUnitOfWork {
  public constructor(private readonly client: DatabaseClient) {}

  public withTenant<T>(
    context: TenantContext,
    operation: (tenant: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE incidentbase_runtime');
      await transaction.$queryRaw`
        SELECT
          set_config('app.current_user_id', ${context.userId}, true),
          set_config('app.current_organization_id', ${context.organizationId}, true)
      `;

      const membership = await transaction.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: context.organizationId,
            userId: context.userId,
          },
        },
        select: { id: true },
      });

      if (membership === null) {
        throw new TenantAccessDeniedError();
      }

      return operation({
        invitations: new InvitationRepository(transaction),
        memberships: new MembershipRepository(transaction),
        organizations: new OrganizationRepository(transaction),
        refreshSessions: new RefreshSessionRepository(transaction),
        transaction,
      });
    });
  }
}

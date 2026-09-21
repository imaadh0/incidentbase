import type { Prisma } from './generated/prisma/client.js';
import type { DatabaseClient } from './client.js';

export interface LoginIdentity {
  displayName: string;
  email: string;
  id: string;
  passwordHash: string | null;
}

export type CurrentUserIdentity = Omit<LoginIdentity, 'passwordHash'>;

export interface AuthMembership {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: 'OWNER' | 'ADMIN' | 'RESPONDER' | 'REPORTER';
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
}

export type RefreshRotationOutcome =
  'ROTATED' | 'INVALID' | 'REUSED' | 'EXPIRED' | 'MEMBERSHIP_INACTIVE';

export interface RefreshRotationResult {
  familyId: string | null;
  organizationId: string | null;
  outcome: RefreshRotationOutcome;
  userId: string | null;
}

export type InvitationAcceptanceOutcome = 'ACCEPTED' | 'INVALID' | 'EXPIRED' | 'EMAIL_MISMATCH';

export interface InvitationAcceptanceResult {
  organizationId: string | null;
  outcome: InvitationAcceptanceOutcome;
}

interface RegisterOwnerInput {
  displayName: string;
  email: string;
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  passwordHash: string;
  userId: string;
}

interface CreateRefreshSessionInput {
  expiresAt: Date;
  familyId: string;
  organizationId: string;
  sessionId: string;
  tokenHash: string;
  userId: string;
}

interface RotateRefreshSessionInput {
  currentTokenHash: string;
  expiresAt: Date;
  newSessionId: string;
  newTokenHash: string;
}

export class AuthenticationRepository {
  public constructor(private readonly client: DatabaseClient) {}

  private withRuntimeRole<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE incidentbase_runtime');
      return operation(transaction);
    });
  }

  public registerOwner(input: RegisterOwnerInput): Promise<void> {
    return this.withRuntimeRole(async (transaction) => {
      await transaction.$queryRaw`
        SELECT app.auth_register_owner(
          ${input.userId}::uuid,
          ${input.email},
          ${input.displayName},
          ${input.passwordHash},
          ${input.organizationId}::uuid,
          ${input.organizationSlug},
          ${input.organizationName},
          ${input.membershipId}::uuid
        )::text
      `;
    });
  }

  public findLoginIdentity(email: string): Promise<LoginIdentity | null> {
    return this.withRuntimeRole(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{ display_name: string; email: string; id: string; password_hash: string | null }>
      >`
        SELECT * FROM app.auth_login_identity(${email})
      `;
      const identity = rows[0];
      return identity === undefined
        ? null
        : {
            displayName: identity.display_name,
            email: identity.email,
            id: identity.id,
            passwordHash: identity.password_hash,
          };
    });
  }

  public listMemberships(userId: string): Promise<AuthMembership[]> {
    return this.withRuntimeRole(async (transaction) => {
      await this.applyUserContext(transaction, userId);
      const rows = await transaction.$queryRaw<
        Array<{
          membership_id: string;
          organization_id: string;
          organization_name: string;
          organization_slug: string;
          role: AuthMembership['role'];
          status: AuthMembership['status'];
        }>
      >`
        SELECT * FROM app.auth_list_memberships(${userId}::uuid)
      `;
      return rows.map((row) => ({
        membershipId: row.membership_id,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        organizationSlug: row.organization_slug,
        role: row.role,
        status: row.status,
      }));
    });
  }

  public findCurrentIdentity(userId: string): Promise<CurrentUserIdentity | null> {
    return this.withRuntimeRole(async (transaction) => {
      await this.applyUserContext(transaction, userId);
      const rows = await transaction.$queryRaw<
        Array<{ display_name: string; email: string; id: string }>
      >`
        SELECT * FROM app.auth_current_identity(${userId}::uuid)
      `;
      const identity = rows[0];
      return identity === undefined
        ? null
        : { displayName: identity.display_name, email: identity.email, id: identity.id };
    });
  }

  public createRefreshSession(input: CreateRefreshSessionInput): Promise<void> {
    return this.withRuntimeRole(async (transaction) => {
      await this.applyUserContext(transaction, input.userId);
      await transaction.$queryRaw`
        SELECT app.auth_create_refresh_session(
          ${input.userId}::uuid,
          ${input.organizationId}::uuid,
          ${input.sessionId}::uuid,
          ${input.familyId}::uuid,
          ${input.tokenHash},
          ${input.expiresAt}
        )::text
      `;
    });
  }

  public rotateRefreshSession(input: RotateRefreshSessionInput): Promise<RefreshRotationResult> {
    return this.withRuntimeRole(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{
          family_id: string | null;
          organization_id: string | null;
          outcome: RefreshRotationOutcome;
          user_id: string | null;
        }>
      >`
        SELECT * FROM app.auth_rotate_refresh_session(
          ${input.currentTokenHash},
          ${input.newSessionId}::uuid,
          ${input.newTokenHash},
          ${input.expiresAt}
        )
      `;
      const result = rows[0];
      if (result === undefined) {
        throw new Error('Refresh rotation did not return an outcome.');
      }
      return {
        familyId: result.family_id,
        organizationId: result.organization_id,
        outcome: result.outcome,
        userId: result.user_id,
      };
    });
  }

  public revokeRefreshSession(tokenHash: string): Promise<void> {
    return this.withRuntimeRole(async (transaction) => {
      await transaction.$queryRaw`SELECT app.auth_revoke_refresh_session(${tokenHash})::text`;
    });
  }

  public revokeAllSessions(userId: string): Promise<void> {
    return this.withRuntimeRole(async (transaction) => {
      await this.applyUserContext(transaction, userId);
      await transaction.$queryRaw`SELECT app.auth_revoke_all_sessions(${userId}::uuid)::text`;
    });
  }

  public acceptInvitation(
    tokenHash: string,
    userId: string,
    membershipId: string,
  ): Promise<InvitationAcceptanceResult> {
    return this.withRuntimeRole(async (transaction) => {
      await this.applyUserContext(transaction, userId);
      const rows = await transaction.$queryRaw<
        Array<{ organization_id: string | null; outcome: InvitationAcceptanceOutcome }>
      >`
        SELECT * FROM app.auth_accept_invitation(
          ${tokenHash},
          ${userId}::uuid,
          ${membershipId}::uuid
        )
      `;
      const result = rows[0];
      if (result === undefined) {
        throw new Error('Invitation acceptance did not return an outcome.');
      }
      return { organizationId: result.organization_id, outcome: result.outcome };
    });
  }

  private async applyUserContext(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await transaction.$queryRaw`
      SELECT set_config('app.current_user_id', ${userId}, true)
    `;
  }
}

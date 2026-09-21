import { randomUUID } from 'node:crypto';

import {
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
} from '@incidentbase/auth';
import type { AccessTokenService } from '@incidentbase/auth';
import type {
  AuthMembership,
  AuthenticationRepository,
  CurrentUserIdentity,
} from '@incidentbase/database';

const genericAuthenticationMessage = 'The supplied credentials are invalid.';
const invalidPasswordSentinel =
  '$argon2id$v=19$m=19456,t=2,p=1$mTDsvn9W1J4IYEEbb3NPAQ$B0p3u6de8qoClba0rUiMsKNW6CBW0Khiclz3Sbu4VmE';

export class AuthenticationServiceError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_CREDENTIALS'
      | 'NO_ACTIVE_MEMBERSHIP'
      | 'INVALID_REFRESH_TOKEN'
      | 'INVITATION_INVALID'
      | 'INVITATION_EXPIRED'
      | 'INVITATION_EMAIL_MISMATCH'
      | 'USER_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'AuthenticationServiceError';
  }
}

export interface AccountView {
  memberships: AuthMembership[];
  user: CurrentUserIdentity;
}

export interface SessionResult extends AccountView {
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
}

interface AuthenticationServiceOptions {
  accessTokens: AccessTokenService;
  refreshTokenTtlSeconds: number;
  repository: AuthenticationRepository;
}

export class AuthenticationService {
  public constructor(private readonly options: AuthenticationServiceOptions) {}

  public async register(input: {
    displayName: string;
    email: string;
    organizationName: string;
    organizationSlug: string;
    password: string;
  }): Promise<SessionResult> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    await this.options.repository.registerOwner({
      displayName: input.displayName,
      email: input.email,
      membershipId: randomUUID(),
      organizationId,
      organizationName: input.organizationName,
      organizationSlug: input.organizationSlug,
      passwordHash: await hashPassword(input.password),
      userId,
    });
    return this.createSession(userId, organizationId);
  }

  public async login(email: string, password: string): Promise<SessionResult> {
    const identity = await this.options.repository.findLoginIdentity(email);
    const passwordMatches = await verifyPassword(
      identity?.passwordHash ?? invalidPasswordSentinel,
      password,
    );
    if (identity === null || identity.passwordHash === null || !passwordMatches) {
      throw new AuthenticationServiceError('INVALID_CREDENTIALS', genericAuthenticationMessage);
    }

    const memberships = await this.options.repository.listMemberships(identity.id);
    const activeMembership = memberships.find((membership) => membership.status === 'ACTIVE');
    if (activeMembership === undefined) {
      throw new AuthenticationServiceError('NO_ACTIVE_MEMBERSHIP', genericAuthenticationMessage);
    }

    return this.createSession(identity.id, activeMembership.organizationId);
  }

  public async refresh(refreshToken: string): Promise<SessionResult> {
    const replacementToken = createOpaqueToken();
    const rotation = await this.options.repository.rotateRefreshSession({
      currentTokenHash: hashOpaqueToken(refreshToken),
      expiresAt: this.refreshExpiry(),
      newSessionId: randomUUID(),
      newTokenHash: hashOpaqueToken(replacementToken),
    });

    if (rotation.outcome !== 'ROTATED' || rotation.userId === null) {
      throw new AuthenticationServiceError(
        'INVALID_REFRESH_TOKEN',
        'The refresh session is invalid or expired.',
      );
    }

    const account = await this.getAccount(rotation.userId);
    return {
      ...account,
      accessToken: await this.options.accessTokens.issue(rotation.userId),
      csrfToken: createOpaqueToken(),
      refreshToken: replacementToken,
    };
  }

  public async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken !== undefined) {
      await this.options.repository.revokeRefreshSession(hashOpaqueToken(refreshToken));
    }
  }

  public revokeAll(userId: string): Promise<void> {
    return this.options.repository.revokeAllSessions(userId);
  }

  public getAccount(userId: string): Promise<AccountView> {
    return Promise.all([
      this.options.repository.findCurrentIdentity(userId),
      this.options.repository.listMemberships(userId),
    ]).then(([user, memberships]) => {
      if (user === null) {
        throw new AuthenticationServiceError('USER_NOT_FOUND', 'Authentication is required.');
      }
      return { memberships, user };
    });
  }

  public async acceptInvitation(token: string, userId: string): Promise<AccountView> {
    const result = await this.options.repository.acceptInvitation(
      hashOpaqueToken(token),
      userId,
      randomUUID(),
    );
    if (result.outcome !== 'ACCEPTED') {
      const errors = {
        EMAIL_MISMATCH: new AuthenticationServiceError(
          'INVITATION_EMAIL_MISMATCH',
          'The invitation belongs to another account.',
        ),
        EXPIRED: new AuthenticationServiceError(
          'INVITATION_EXPIRED',
          'The invitation has expired.',
        ),
        INVALID: new AuthenticationServiceError(
          'INVITATION_INVALID',
          'The invitation is invalid or has already been used.',
        ),
      } as const;
      throw errors[result.outcome];
    }
    return this.getAccount(userId);
  }

  private async createSession(userId: string, organizationId: string): Promise<SessionResult> {
    const refreshToken = createOpaqueToken();
    await this.options.repository.createRefreshSession({
      expiresAt: this.refreshExpiry(),
      familyId: randomUUID(),
      organizationId,
      sessionId: randomUUID(),
      tokenHash: hashOpaqueToken(refreshToken),
      userId,
    });
    const account = await this.getAccount(userId);
    return {
      ...account,
      accessToken: await this.options.accessTokens.issue(userId),
      csrfToken: createOpaqueToken(),
      refreshToken,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.options.refreshTokenTtlSeconds * 1000);
  }
}

import { randomUUID } from 'node:crypto';
import { verificationEmail } from '@incidentbase/contracts';

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
  InvitationPreview,
} from '@incidentbase/database';
import type { EmailSender } from '../email/sender.js';
import type { PendingRegistrationStore } from './pending-registration.js';

const genericAuthenticationMessage = 'The supplied credentials are invalid.';
const invalidPasswordSentinel =
  '$argon2id$v=19$m=19456,t=2,p=1$mTDsvn9W1J4IYEEbb3NPAQ$B0p3u6de8qoClba0rUiMsKNW6CBW0Khiclz3Sbu4VmE';

export class VerificationDeliveryError extends Error {
  public constructor() {
    super('The verification email could not be sent. Please try again.');
  }
}

export class AuthenticationServiceError extends Error {
  public constructor(
    public readonly code:
      | 'INVALID_CREDENTIALS'
      | 'NO_ACTIVE_MEMBERSHIP'
      | 'INVALID_REFRESH_TOKEN'
      | 'INVITATION_INVALID'
      | 'INVITATION_EXPIRED'
      | 'INVITATION_EMAIL_MISMATCH'
      | 'INVITATION_USED'
      | 'INVITATION_EMAIL_EXISTS'
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
  pendingRegistrations?: PendingRegistrationStore;
  emailSender?: EmailSender;
}

export class AuthenticationService {
  public constructor(private readonly options: AuthenticationServiceOptions) {}

  public async startRegistration(
    input: {
      displayName: string;
      email: string;
      organizationName: string;
      organizationSlug: string;
      password: string;
    },
    invitationToken?: string,
  ): Promise<{ pendingId: string; email: string }> {
    const store = this.options.pendingRegistrations;
    const sender = this.options.emailSender;
    if (!store || !sender) throw new VerificationDeliveryError();
    if (invitationToken) {
      const preview = await this.previewInvitation(invitationToken);
      if (!preview)
        throw new AuthenticationServiceError('INVITATION_INVALID', 'The invitation is invalid.');
      if (preview.outcome === 'EXPIRED')
        throw new AuthenticationServiceError('INVITATION_EXPIRED', 'The invitation has expired.');
      if (preview.outcome === 'USED')
        throw new AuthenticationServiceError(
          'INVITATION_USED',
          'This invitation has already been used.',
        );
      if (preview.email !== input.email)
        throw new AuthenticationServiceError(
          'INVITATION_EMAIL_MISMATCH',
          'The invitation belongs to another email address.',
        );
    }
    if (await this.options.repository.findLoginIdentity(input.email)) {
      throw new AuthenticationServiceError(
        'INVITATION_EMAIL_EXISTS',
        'An account with this email already exists. Sign in instead.',
      );
    }
    const { pendingId, code } = await store.create({
      kind: invitationToken ? 'INVITEE' : 'OWNER',
      displayName: input.displayName,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      ...(invitationToken
        ? { invitationToken }
        : { organizationName: input.organizationName, organizationSlug: input.organizationSlug }),
    });
    try {
      await sender.send(input.email, verificationEmail(code), `verification-${pendingId}-1`);
    } catch {
      await store.delete(pendingId);
      throw new VerificationDeliveryError();
    }
    return { pendingId, email: input.email };
  }

  public async resendVerification(pendingId: string): Promise<void> {
    const store = this.options.pendingRegistrations;
    const sender = this.options.emailSender;
    if (!store || !sender) throw new VerificationDeliveryError();
    const { email, code } = await store.resend(pendingId);
    try {
      await sender.send(email, verificationEmail(code), `verification-${pendingId}-${Date.now()}`);
    } catch {
      throw new VerificationDeliveryError();
    }
  }

  public async verifyRegistration(pendingId: string, code: string): Promise<SessionResult> {
    const store = this.options.pendingRegistrations;
    if (!store) throw new Error('Email verification is unavailable.');
    const pending = await store.verify(pendingId, code);
    const userId = randomUUID();
    let organizationId: string;
    try {
      if (pending.kind === 'INVITEE' && pending.invitationToken) {
        const result = await this.options.repository.registerInvitee({
          displayName: pending.displayName,
          email: pending.email,
          membershipId: randomUUID(),
          passwordHash: pending.passwordHash,
          tokenHash: hashOpaqueToken(pending.invitationToken),
          userId,
        });
        if (result.outcome !== 'ACCEPTED' || !result.organizationId) {
          throw new AuthenticationServiceError(
            result.outcome === 'EXPIRED'
              ? 'INVITATION_EXPIRED'
              : result.outcome === 'USED'
                ? 'INVITATION_USED'
                : result.outcome === 'EMAIL_MISMATCH'
                  ? 'INVITATION_EMAIL_MISMATCH'
                  : 'INVITATION_INVALID',
            result.outcome === 'EXPIRED'
              ? 'The invitation has expired.'
              : result.outcome === 'USED'
                ? 'This invitation has already been used.'
                : 'The invitation is no longer available.',
          );
        }
        organizationId = result.organizationId;
      } else if (pending.organizationName && pending.organizationSlug) {
        organizationId = randomUUID();
        await this.options.repository.registerOwner({
          displayName: pending.displayName,
          email: pending.email,
          membershipId: randomUUID(),
          organizationId,
          organizationName: pending.organizationName,
          organizationSlug: pending.organizationSlug,
          passwordHash: pending.passwordHash,
          userId,
        });
      } else throw new Error('Pending registration is invalid.');
      await this.options.repository.markEmailVerified(userId);
      const session = await this.createSession(userId, organizationId);
      await store.delete(pendingId);
      return session;
    } finally {
      await store.release(pendingId);
    }
  }

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
    const identity = await this.authenticateCredentials(email, password);

    const memberships = await this.options.repository.listMemberships(identity.id);
    const activeMembership = memberships.find((membership) => membership.status === 'ACTIVE');
    if (activeMembership === undefined) {
      throw new AuthenticationServiceError('NO_ACTIVE_MEMBERSHIP', genericAuthenticationMessage);
    }

    return this.createSession(identity.id, activeMembership.organizationId);
  }

  public async loginInvitee(
    token: string,
    email: string,
    password: string,
  ): Promise<SessionResult> {
    const identity = await this.authenticateCredentials(email, password);
    const organizationId = await this.acceptInvitationForUser(token, identity.id);
    return this.createSession(identity.id, organizationId);
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
    await this.acceptInvitationForUser(token, userId);
    return this.getAccount(userId);
  }

  private async acceptInvitationForUser(token: string, userId: string): Promise<string> {
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
        USED: new AuthenticationServiceError(
          'INVITATION_USED',
          'This invitation has already been used.',
        ),
        INVALID: new AuthenticationServiceError(
          'INVITATION_INVALID',
          'The invitation is invalid or has already been used.',
        ),
      } as const;
      throw errors[result.outcome];
    }
    if (result.organizationId === null) throw new Error('Accepted invitation has no organization.');
    return result.organizationId;
  }

  private async authenticateCredentials(email: string, password: string) {
    const identity = await this.options.repository.findLoginIdentity(email);
    const passwordMatches = await verifyPassword(
      identity?.passwordHash ?? invalidPasswordSentinel,
      password,
    );
    if (identity === null || identity.passwordHash === null || !passwordMatches) {
      throw new AuthenticationServiceError('INVALID_CREDENTIALS', genericAuthenticationMessage);
    }
    return identity;
  }

  public async previewInvitation(
    token: string,
  ): Promise<(InvitationPreview & { hasAccount: boolean }) | null> {
    const invitation = await this.options.repository.previewInvitation(hashOpaqueToken(token));
    if (invitation === null) return null;
    const identity = await this.options.repository.findLoginIdentity(invitation.email);
    return { ...invitation, hasAccount: identity !== null };
  }

  public async registerInvitee(
    token: string,
    input: {
      displayName: string;
      email: string;
      password: string;
    },
  ): Promise<SessionResult> {
    const userId = randomUUID();
    const result = await this.options.repository.registerInvitee({
      displayName: input.displayName,
      email: input.email,
      membershipId: randomUUID(),
      passwordHash: await hashPassword(input.password),
      tokenHash: hashOpaqueToken(token),
      userId,
    });
    if (result.outcome !== 'ACCEPTED') {
      const errors = {
        EMAIL_MISMATCH: new AuthenticationServiceError(
          'INVITATION_EMAIL_MISMATCH',
          'The invitation belongs to another email address.',
        ),
        EXPIRED: new AuthenticationServiceError(
          'INVITATION_EXPIRED',
          'The invitation has expired.',
        ),
        INVALID: new AuthenticationServiceError('INVITATION_INVALID', 'The invitation is invalid.'),
        USED: new AuthenticationServiceError(
          'INVITATION_USED',
          'This invitation has already been used.',
        ),
        EMAIL_EXISTS: new AuthenticationServiceError(
          'INVITATION_EMAIL_EXISTS',
          'An account with this email already exists. Sign in instead.',
        ),
      } as const;
      throw errors[result.outcome];
    }
    if (result.organizationId === null) throw new Error('Accepted invitation has no organization.');
    return this.createSession(userId, result.organizationId);
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

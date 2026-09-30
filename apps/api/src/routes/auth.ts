import { Router, type Request, type Response } from 'express';

import type { AccessTokenService } from '@incidentbase/auth';
import {
  inviteeRegistrationRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  verificationRequestSchema,
  resendVerificationRequestSchema,
} from '@incidentbase/contracts';

import { ApplicationError } from '../errors/application-error.js';
import {
  AuthenticationServiceError,
  VerificationDeliveryError,
  type AuthenticationService,
  type SessionResult,
} from '../auth/authentication-service.js';
import {
  accessCookieName,
  authenticateRequest,
  csrfCookieName,
  hasValidCsrfToken,
  readCookie,
  refreshCookieName,
} from '../auth/request-authentication.js';
import { PendingRegistrationError } from '../auth/pending-registration.js';

export interface AuthRouterOptions {
  accessTokenTtlSeconds: number;
  accessTokens: AccessTokenService;
  cookieSecure: boolean;
  refreshTokenTtlSeconds: number;
  service: AuthenticationService;
}

function invalidRequest(): ApplicationError {
  return new ApplicationError({
    code: 'VALIDATION_FAILED',
    message: 'The request body is invalid.',
    statusCode: 400,
  });
}

function authenticationRequired(): ApplicationError {
  return new ApplicationError({
    code: 'UNAUTHORIZED',
    message: 'Authentication is required.',
    statusCode: 401,
  });
}

function requireCsrf(request: Request): void {
  if (!hasValidCsrfToken(request)) {
    throw new ApplicationError({
      code: 'CSRF_VALIDATION_FAILED',
      message: 'A valid CSRF token is required.',
      statusCode: 403,
    });
  }
}

function setSessionCookies(
  response: Response,
  session: SessionResult,
  options: AuthRouterOptions,
): void {
  const common = { sameSite: 'strict' as const, secure: options.cookieSecure };
  response.cookie(accessCookieName, session.accessToken, {
    ...common,
    httpOnly: true,
    maxAge: options.accessTokenTtlSeconds * 1000,
    path: '/',
  });
  response.cookie(refreshCookieName, session.refreshToken, {
    ...common,
    httpOnly: true,
    maxAge: options.refreshTokenTtlSeconds * 1000,
    path: '/api/v1/auth',
  });
  response.cookie(csrfCookieName, session.csrfToken, {
    ...common,
    httpOnly: false,
    maxAge: options.refreshTokenTtlSeconds * 1000,
    path: '/',
  });
}

function clearSessionCookies(response: Response, options: AuthRouterOptions): void {
  const common = { sameSite: 'strict' as const, secure: options.cookieSecure };
  response.clearCookie(accessCookieName, { ...common, httpOnly: true, path: '/' });
  response.clearCookie(refreshCookieName, {
    ...common,
    httpOnly: true,
    path: '/api/v1/auth',
  });
  response.clearCookie(csrfCookieName, { ...common, httpOnly: false, path: '/' });
}

function mapServiceError(error: AuthenticationServiceError): ApplicationError {
  if (error.code.startsWith('INVITATION_')) {
    return new ApplicationError({
      code: error.code,
      message: error.message,
      statusCode:
        error.code === 'INVITATION_EMAIL_MISMATCH'
          ? 403
          : error.code === 'INVITATION_EMAIL_EXISTS'
            ? 409
            : error.code === 'INVITATION_EXPIRED' || error.code === 'INVITATION_USED'
              ? 410
              : 400,
    });
  }
  return new ApplicationError({ code: 'UNAUTHORIZED', message: error.message, statusCode: 401 });
}

function mapPendingError(error: PendingRegistrationError): ApplicationError {
  return new ApplicationError({
    code: `VERIFICATION_${error.code}`,
    message: error.message,
    statusCode: error.code === 'COOLDOWN' ? 429 : error.code === 'INVALID' ? 400 : 410,
  });
}

function mapDeliveryError(error: VerificationDeliveryError): ApplicationError {
  return new ApplicationError({
    code: 'VERIFICATION_EMAIL_UNAVAILABLE',
    message: error.message,
    statusCode: 503,
  });
}

async function requirePrincipal(request: Request, accessTokens: AccessTokenService) {
  const principal = await authenticateRequest(request, accessTokens);
  if (principal === null) {
    throw authenticationRequired();
  }
  return principal;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();

  router.get('/invitations/:token', async (request, response) => {
    const token = typeof request.params.token === 'string' ? request.params.token : undefined;
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidRequest();
    const invitation = await options.service.previewInvitation(token);
    if (invitation === null) {
      throw new ApplicationError({
        code: 'INVITATION_INVALID',
        message: 'The invitation is invalid.',
        statusCode: 404,
      });
    }
    response.set('Cache-Control', 'no-store');
    response.json({ data: invitation });
  });

  router.post('/invitations/:token/register', async (request, response) => {
    const token = typeof request.params.token === 'string' ? request.params.token : undefined;
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidRequest();
    const body = inviteeRegistrationRequestSchema.safeParse(request.body);
    if (!body.success) throw invalidRequest();
    try {
      const pending = await options.service.startRegistration(
        {
          ...body.data,
          organizationName: '',
          organizationSlug: '',
        },
        token,
      );
      response.status(202).json({ data: pending });
    } catch (error: unknown) {
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      if (error instanceof VerificationDeliveryError) throw mapDeliveryError(error);
      if (isUniqueConstraintError(error)) {
        throw new ApplicationError({
          code: 'INVITATION_EMAIL_EXISTS',
          message: 'An account with this email already exists. Sign in instead.',
          statusCode: 409,
        });
      }
      throw error;
    }
  });

  router.post('/invitations/:token/login', async (request, response) => {
    const token = typeof request.params.token === 'string' ? request.params.token : undefined;
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidRequest();
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) throw invalidRequest();
    try {
      const session = await options.service.loginInvitee(
        token,
        body.data.email,
        body.data.password,
      );
      setSessionCookies(response, session, options);
      response.json({ data: { memberships: session.memberships, user: session.user } });
    } catch (error: unknown) {
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      if (error instanceof VerificationDeliveryError) throw mapDeliveryError(error);
      throw error;
    }
  });

  router.post('/auth/register', async (request, response) => {
    const body = registerRequestSchema.safeParse(request.body);
    if (!body.success) throw invalidRequest();
    try {
      const pending = await options.service.startRegistration(body.data);
      response.status(202).json({ data: pending });
    } catch (error: unknown) {
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      if (error instanceof VerificationDeliveryError) throw mapDeliveryError(error);
      if (isUniqueConstraintError(error)) {
        throw new ApplicationError({
          code: 'REGISTRATION_CONFLICT',
          message: 'The email or organization slug is already registered.',
          statusCode: 409,
        });
      }
      throw error;
    }
  });

  router.post('/auth/verify-email', async (request, response) => {
    const body = verificationRequestSchema.safeParse(request.body);
    if (!body.success) throw invalidRequest();
    try {
      const session = await options.service.verifyRegistration(body.data.pendingId, body.data.code);
      setSessionCookies(response, session, options);
      response.json({ data: { memberships: session.memberships, user: session.user } });
    } catch (error: unknown) {
      if (error instanceof PendingRegistrationError) throw mapPendingError(error);
      if (error instanceof VerificationDeliveryError) throw mapDeliveryError(error);
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      if (isUniqueConstraintError(error)) {
        throw new ApplicationError({
          code: 'REGISTRATION_CONFLICT',
          message: 'This account or organization already exists.',
          statusCode: 409,
        });
      }
      throw error;
    }
  });

  router.post('/auth/resend-verification', async (request, response) => {
    const body = resendVerificationRequestSchema.safeParse(request.body);
    if (!body.success) throw invalidRequest();
    try {
      await options.service.resendVerification(body.data.pendingId);
      response.status(204).send();
    } catch (error: unknown) {
      if (error instanceof PendingRegistrationError) throw mapPendingError(error);
      if (error instanceof VerificationDeliveryError) throw mapDeliveryError(error);
      throw error;
    }
  });

  router.post('/auth/login', async (request, response) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) throw invalidRequest();
    try {
      const session = await options.service.login(body.data.email, body.data.password);
      setSessionCookies(response, session, options);
      response.json({ data: { memberships: session.memberships, user: session.user } });
    } catch (error: unknown) {
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      throw error;
    }
  });

  router.post('/auth/refresh', async (request, response) => {
    requireCsrf(request);
    const refreshToken = readCookie(request, refreshCookieName);
    if (refreshToken === undefined) throw authenticationRequired();
    try {
      const session = await options.service.refresh(refreshToken);
      setSessionCookies(response, session, options);
      response.json({ data: { memberships: session.memberships, user: session.user } });
    } catch (error: unknown) {
      clearSessionCookies(response, options);
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      throw error;
    }
  });

  router.post('/auth/logout', async (request, response) => {
    requireCsrf(request);
    await options.service.logout(readCookie(request, refreshCookieName));
    clearSessionCookies(response, options);
    response.status(204).send();
  });

  router.post('/auth/logout-all', async (request, response) => {
    requireCsrf(request);
    const principal = await requirePrincipal(request, options.accessTokens);
    await options.service.revokeAll(principal.userId);
    clearSessionCookies(response, options);
    response.status(204).send();
  });

  router.get('/auth/me', async (request, response) => {
    const principal = await requirePrincipal(request, options.accessTokens);
    const account = await options.service.getAccount(principal.userId);
    response.json({ data: account });
  });

  router.post('/invitations/:token/accept', async (request, response) => {
    requireCsrf(request);
    const principal = await requirePrincipal(request, options.accessTokens);
    const token = typeof request.params.token === 'string' ? request.params.token : undefined;
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw invalidRequest();
    try {
      const account = await options.service.acceptInvitation(token, principal.userId);
      response.json({ data: account });
    } catch (error: unknown) {
      if (error instanceof AuthenticationServiceError) throw mapServiceError(error);
      throw error;
    }
  });

  return router;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002') return true;
  if (code !== 'P2010' || !('meta' in error)) return false;
  const meta = (error as { meta?: unknown }).meta;
  return JSON.stringify(meta).includes('23505');
}

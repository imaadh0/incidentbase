import type { Request } from 'express';

import { AccessTokenService, verifyCsrfToken } from '@incidentbase/auth';

export const accessCookieName = 'incidentbase_access';
export const refreshCookieName = 'incidentbase_refresh';
export const csrfCookieName = 'incidentbase_csrf';

export function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.header('cookie');
  if (cookieHeader === undefined) {
    return undefined;
  }

  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0) {
      continue;
    }
    const candidateName = segment.slice(0, separator).trim();
    if (candidateName === name) {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export function readAccessToken(request: Request): string | undefined {
  const authorization = request.header('authorization');
  if (authorization?.startsWith('Bearer ') === true) {
    return authorization.slice('Bearer '.length);
  }
  return readCookie(request, accessCookieName);
}

export async function authenticateRequest(
  request: Request,
  accessTokens: AccessTokenService,
): Promise<{ userId: string } | null> {
  const token = readAccessToken(request);
  return token === undefined ? null : accessTokens.verify(token);
}

export function hasValidCsrfToken(request: Request): boolean {
  return verifyCsrfToken(readCookie(request, csrfCookieName), request.header('x-csrf-token'));
}

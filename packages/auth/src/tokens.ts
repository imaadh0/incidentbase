import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const accessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  tokenUse: z.literal('access'),
  authVersion: z.number().int().nonnegative(),
});

export interface AccessTokenClaims {
  userId: string;
}

export interface AccessTokenServiceOptions {
  audience: string;
  expiresInSeconds?: number;
  issuer: string;
  secret: string;
  getAuthVersion?: (userId: string) => Promise<number | null>;
}

export class AccessTokenService {
  private readonly audience: string;
  private readonly expiresInSeconds: number;
  private readonly issuer: string;
  private readonly key: Uint8Array;
  private readonly getAuthVersion: ((userId: string) => Promise<number | null>) | undefined;

  public constructor(options: AccessTokenServiceOptions) {
    this.audience = options.audience;
    this.expiresInSeconds = options.expiresInSeconds ?? 900;
    this.issuer = options.issuer;
    this.key = new TextEncoder().encode(options.secret);
    this.getAuthVersion = options.getAuthVersion;
  }

  public async issue(userId: string): Promise<string> {
    const authVersion = this.getAuthVersion ? await this.getAuthVersion(userId) : 0;
    if (authVersion === null) throw new Error('Account does not exist.');
    return new SignJWT({ tokenUse: 'access', authVersion })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.expiresInSeconds}s`)
      .sign(this.key);
  }

  public async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const result = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        audience: this.audience,
        issuer: this.issuer,
      });
      const claims = accessTokenClaimsSchema.safeParse(result.payload);
      if (!claims.success) return null;
      if (this.getAuthVersion) {
        const current = await this.getAuthVersion(claims.data.sub);
        if (current === null || current !== claims.data.authVersion) return null;
      }
      return { userId: claims.data.sub };
    } catch {
      return null;
    }
  }
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (cookieToken === undefined || headerToken === undefined) {
    return false;
  }

  const cookieBuffer = Buffer.from(cookieToken, 'utf8');
  const headerBuffer = Buffer.from(headerToken, 'utf8');
  return cookieBuffer.length === headerBuffer.length && timingSafeEqual(cookieBuffer, headerBuffer);
}

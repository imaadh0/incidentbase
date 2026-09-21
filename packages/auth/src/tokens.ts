import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const accessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  tokenUse: z.literal('access'),
});

export interface AccessTokenClaims {
  userId: string;
}

export interface AccessTokenServiceOptions {
  audience: string;
  expiresInSeconds?: number;
  issuer: string;
  secret: string;
}

export class AccessTokenService {
  private readonly audience: string;
  private readonly expiresInSeconds: number;
  private readonly issuer: string;
  private readonly key: Uint8Array;

  public constructor(options: AccessTokenServiceOptions) {
    this.audience = options.audience;
    this.expiresInSeconds = options.expiresInSeconds ?? 900;
    this.issuer = options.issuer;
    this.key = new TextEncoder().encode(options.secret);
  }

  public issue(userId: string): Promise<string> {
    return new SignJWT({ tokenUse: 'access' })
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
      return claims.success ? { userId: claims.data.sub } : null;
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

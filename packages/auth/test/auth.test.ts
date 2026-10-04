import { describe, expect, it } from 'vitest';

import {
  AccessTokenService,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyCsrfToken,
  verifyPassword,
} from '../src/index.js';

const tokenService = new AccessTokenService({
  audience: 'incidentbase-api',
  issuer: 'incidentbase',
  secret: 'test-secret-that-is-at-least-32-characters-long',
});

describe('authentication primitives', () => {
  it('hashes passwords with Argon2id and rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/u);
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('issues and verifies a bounded access token', async () => {
    const userId = '4cff43d8-2f5d-48d6-814e-7f13309f5d51';
    const token = await tokenService.issue(userId);

    await expect(tokenService.verify(token)).resolves.toEqual({ userId });
    await expect(tokenService.verify(`${token}tampered`)).resolves.toBeNull();
  });

  it('rejects access tokens after the account auth version changes', async () => {
    const userId = '4cff43d8-2f5d-48d6-814e-7f13309f5d51';
    let version = 0;
    const service = new AccessTokenService({
      audience: 'incidentbase-api',
      issuer: 'incidentbase',
      secret: 'test-secret-that-is-at-least-32-characters-long',
      getAuthVersion: () => Promise.resolve(version),
    });
    const original = await service.issue(userId);
    await expect(service.verify(original)).resolves.toEqual({ userId });
    version = 1;
    await expect(service.verify(original)).resolves.toBeNull();
    const replacement = await service.issue(userId);
    await expect(service.verify(replacement)).resolves.toEqual({ userId });
  });

  it('generates opaque tokens and stores only deterministic hashes', () => {
    const token = createOpaqueToken();

    expect(token).toHaveLength(43);
    expect(hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
  });

  it('requires matching cookie and header CSRF tokens', () => {
    expect(verifyCsrfToken('csrf-token', 'csrf-token')).toBe(true);
    expect(verifyCsrfToken('csrf-token', 'different')).toBe(false);
    expect(verifyCsrfToken(undefined, 'csrf-token')).toBe(false);
  });
});

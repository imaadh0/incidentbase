import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

export type PendingRegistration = {
  kind: 'OWNER' | 'INVITEE';
  displayName: string;
  email: string;
  passwordHash: string;
  organizationName?: string;
  organizationSlug?: string;
  invitationToken?: string;
};

type StoredRegistration = PendingRegistration & {
  codeHash: string;
  attempts: number;
  sentAt: number;
};

export class PendingRegistrationError extends Error {
  public constructor(
    public readonly code: 'INVALID' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'COOLDOWN',
  ) {
    super(
      {
        INVALID: 'The verification code is incorrect.',
        EXPIRED: 'The verification code has expired. Start again.',
        TOO_MANY_ATTEMPTS: 'Too many incorrect codes. Start again.',
        COOLDOWN: 'Wait 60 seconds before requesting another code.',
      }[code],
    );
  }
}

export class PendingRegistrationStore {
  public constructor(
    private readonly redis: Redis,
    private readonly secret: string,
  ) {}

  private key(id: string): string {
    return `auth:pending:${id}`;
  }
  private hash(id: string, code: string): string {
    return createHmac('sha256', this.secret).update(`${id}:${code}`).digest('hex');
  }

  public async create(
    registration: PendingRegistration,
  ): Promise<{ pendingId: string; code: string }> {
    const pendingId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const stored: StoredRegistration = {
      ...registration,
      codeHash: this.hash(pendingId, code),
      attempts: 0,
      sentAt: Date.now(),
    };
    await this.redis.set(this.key(pendingId), JSON.stringify(stored), 'EX', 600);
    return { pendingId, code };
  }

  public delete(pendingId: string): Promise<number> {
    return this.redis.del(this.key(pendingId));
  }

  public async resend(pendingId: string): Promise<{ email: string; code: string }> {
    const key = this.key(pendingId);
    const raw = await this.redis.get(key);
    if (!raw) throw new PendingRegistrationError('EXPIRED');
    const stored = JSON.parse(raw) as StoredRegistration;
    if (stored.attempts >= 5) throw new PendingRegistrationError('TOO_MANY_ATTEMPTS');
    if (Date.now() - stored.sentAt < 60_000) throw new PendingRegistrationError('COOLDOWN');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const next: StoredRegistration = {
      ...stored,
      codeHash: this.hash(pendingId, code),
      sentAt: Date.now(),
    };
    const result = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2], 'EX', 600) return 1",
      1,
      key,
      raw,
      JSON.stringify(next),
    );
    if (result !== 1) throw new PendingRegistrationError('INVALID');
    return { email: stored.email, code };
  }

  public async verify(pendingId: string, code: string): Promise<PendingRegistration> {
    const key = this.key(pendingId);
    const raw = await this.redis.get(key);
    if (!raw) throw new PendingRegistrationError('EXPIRED');
    const stored = JSON.parse(raw) as StoredRegistration;
    if (stored.attempts >= 5) throw new PendingRegistrationError('TOO_MANY_ATTEMPTS');
    const actual = Buffer.from(this.hash(pendingId, code), 'hex');
    const expected = Buffer.from(stored.codeHash, 'hex');
    if (!timingSafeEqual(actual, expected)) {
      const next: StoredRegistration = { ...stored, attempts: stored.attempts + 1 };
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL') return 1",
        1,
        key,
        raw,
        JSON.stringify(next),
      );
      throw new PendingRegistrationError(next.attempts >= 5 ? 'TOO_MANY_ATTEMPTS' : 'INVALID');
    }
    const locked = await this.redis.set(`${key}:lock`, '1', 'EX', 30, 'NX');
    if (locked !== 'OK') throw new PendingRegistrationError('INVALID');
    return stored;
  }

  public async release(pendingId: string): Promise<void> {
    await this.redis.del(`${this.key(pendingId)}:lock`);
  }
}

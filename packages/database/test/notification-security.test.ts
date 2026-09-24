import { describe, expect, it } from 'vitest';

import { NotificationSecretCodec, validateWebhookUrl } from '../src/notification-security.js';

const key = '0123456789abcdef'.repeat(4);
const organizationId = '30559cad-e02d-4ca2-9b23-d149ba280294';

describe('notification webhook secret boundary', () => {
  it('encrypts with tenant/channel authentication and never stores plaintext', () => {
    const codec = new NotificationSecretCodec(key);
    const url = 'https://hooks.slack.com/services/T123/B123/secret';
    const encrypted = codec.encrypt(organizationId, 'SLACK', url);
    expect(encrypted).not.toContain('secret');
    expect(codec.decrypt(organizationId, 'SLACK', encrypted)).toBe(url);
    expect(() =>
      codec.decrypt('e3aa2be8-10ea-4344-9933-bcf84489e0e0', 'SLACK', encrypted),
    ).toThrow();
    expect(() => codec.decrypt(organizationId, 'DISCORD', encrypted)).toThrow();
  });

  it('rejects non-provider URLs and URL authority tricks', () => {
    const invalid = [
      'http://hooks.slack.com/services/T/B/x',
      'https://hooks.slack.com.evil.test/services/T/B/x',
      'https://hooks.slack.com@evil.test/services/T/B/x',
      'https://hooks.slack.com:444/services/T/B/x',
      'https://127.0.0.1/services/T/B/x',
    ];
    for (const url of invalid) expect(() => validateWebhookUrl('SLACK', url)).toThrow();
    expect(validateWebhookUrl('DISCORD', 'https://discord.com/api/webhooks/123/token')).toContain(
      '/api/webhooks/123/token',
    );
  });
});

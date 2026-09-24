import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type WebhookChannel = 'SLACK' | 'DISCORD';

export function validateWebhookUrl(channel: WebhookChannel, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid webhook URL.');
  }
  const hosts =
    channel === 'SLACK'
      ? ['hooks.slack.com', 'hooks.slack-gov.com']
      : ['discord.com', 'discordapp.com'];
  const path =
    channel === 'SLACK'
      ? /^\/services\/[A-Za-z0-9/_-]+$/u
      : /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/u;
  if (
    url.protocol !== 'https:' ||
    !hosts.includes(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !path.test(url.pathname)
  ) {
    throw new Error('Webhook URL must be an approved HTTPS provider endpoint.');
  }
  return url.toString();
}

export class NotificationSecretCodec {
  private readonly key: Buffer;

  public constructor(hexKey: string) {
    if (!/^[a-f\d]{64}$/iu.test(hexKey))
      throw new Error('Notification encryption key must be 32 bytes in hex.');
    this.key = Buffer.from(hexKey, 'hex');
  }

  public encrypt(organizationId: string, channel: WebhookChannel, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${organizationId}:${channel}`));
    const ciphertext = Buffer.concat([
      cipher.update(validateWebhookUrl(channel, value), 'utf8'),
      cipher.final(),
    ]);
    return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  public decrypt(organizationId: string, channel: WebhookChannel, value: string): string {
    const [version, iv, tag, ciphertext] = value.split(':');
    if (version !== 'v1' || iv === undefined || tag === undefined || ciphertext === undefined)
      throw new Error('Invalid encrypted webhook.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${organizationId}:${channel}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return validateWebhookUrl(
      channel,
      Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
  }
}

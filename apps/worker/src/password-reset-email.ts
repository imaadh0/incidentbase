import { createHash, randomBytes } from 'node:crypto';

import type { DatabaseClient } from '@incidentbase/database';
import { passwordResetEmail } from '@incidentbase/contracts';

export class PasswordResetEmailProcessor {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly options: {
      apiKey?: string | undefined;
      from?: string | undefined;
      origin: string;
      endpoint?: string | undefined;
      fetcher?: typeof fetch;
    },
  ) {}

  public async send(email: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const prepared = await this.database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL ROLE incidentbase_worker');
      const rows = await transaction.$queryRaw<Array<{ prepared: boolean }>>`
        SELECT app.auth_prepare_password_reset(
          ${email}, ${hash}, ${new Date(Date.now() + 30 * 60_000)}
        ) AS prepared
      `;
      return rows[0]?.prepared ?? false;
    });
    if (!prepared) return;
    if (!this.options.apiKey || !this.options.from)
      throw new Error('Reset email is not configured.');
    const url = new URL('/reset-password', this.options.origin);
    url.searchParams.set('token', token);
    const content = passwordResetEmail(url.toString());
    const response = await (this.options.fetcher ?? fetch)(
      this.options.endpoint ?? 'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': `password-reset-${hash}`,
        },
        body: JSON.stringify({
          from: `IncidentBase <${this.options.from}>`,
          to: [email],
          subject: content.subject,
          text: content.text,
          html: content.html,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`Reset email provider returned HTTP ${response.status}.`);
  }
}

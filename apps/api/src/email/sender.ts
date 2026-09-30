import type { EmailContent } from '@incidentbase/contracts';

export interface EmailSender {
  send(to: string, content: EmailContent, key: string): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  public constructor(
    private readonly apiKey: string | undefined,
    private readonly from: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = 'https://api.resend.com/emails',
  ) {}

  public async send(to: string, content: EmailContent, key: string): Promise<void> {
    if (!this.apiKey || !this.from) throw new Error('Email delivery is not configured.');
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({
        from: `IncidentBase <${this.from}>`,
        to: [to],
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
  }
}

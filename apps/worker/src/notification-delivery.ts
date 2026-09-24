import type { ClaimedNotificationDelivery, WorkerUnitOfWork } from '@incidentbase/database';
import { NotificationSecretCodec } from '@incidentbase/database';

type DeliverySource = Pick<
  WorkerUnitOfWork,
  'claimNotificationDeliveries' | 'finishNotificationDelivery' | 'notificationWebhookCiphertext'
>;

export interface DeliveryProviderOptions {
  encryptionKey: string;
  resendApiKey?: string | undefined;
  resendFromEmail?: string | undefined;
  fetcher?: typeof fetch;
  resendEndpoint?: string;
  timeoutMs?: number;
}

export class NotificationDeliveryProcessor {
  private readonly codec: NotificationSecretCodec;
  private readonly fetcher: typeof fetch;

  public constructor(
    private readonly source: DeliverySource,
    private readonly options: DeliveryProviderOptions,
    private readonly batchSize = 100,
  ) {
    this.codec = new NotificationSecretCodec(options.encryptionKey);
    this.fetcher = options.fetcher ?? fetch;
  }

  public async runOnce(): Promise<{ sent: number; failed: number }> {
    const deliveries = await this.source.claimNotificationDeliveries(this.batchSize);
    let sent = 0;
    let failed = 0;
    for (const delivery of deliveries) {
      try {
        const providerId = await this.send(delivery);
        await this.source.finishNotificationDelivery(delivery, providerId, null, false);
        sent += 1;
      } catch (error: unknown) {
        const classified =
          error instanceof DeliveryError
            ? error
            : new DeliveryError('Provider request failed.', true);
        await this.source.finishNotificationDelivery(
          delivery,
          null,
          classified.message,
          classified.retryable,
        );
        failed += 1;
      }
    }
    return { sent, failed };
  }

  private async send(delivery: ClaimedNotificationDelivery): Promise<string> {
    let endpoint: string;
    let headers: Record<string, string> = { 'content-type': 'application/json' };
    let body: string;
    if (delivery.channel === 'EMAIL') {
      if (!this.options.resendApiKey || !this.options.resendFromEmail) {
        throw new DeliveryError('Email provider is not configured.', false);
      }
      endpoint = this.options.resendEndpoint ?? 'https://api.resend.com/emails';
      headers = {
        ...headers,
        authorization: `Bearer ${this.options.resendApiKey}`,
        'idempotency-key': delivery.deliveryKey,
      };
      body = JSON.stringify({
        from: this.options.resendFromEmail,
        to: [delivery.recipient],
        subject: delivery.subject,
        text: delivery.body,
      });
    } else {
      const ciphertext = await this.source.notificationWebhookCiphertext(
        delivery.organizationId,
        delivery.channel,
      );
      if (ciphertext === null) throw new DeliveryError('Webhook is no longer configured.', false);
      endpoint = this.codec.decrypt(delivery.organizationId, delivery.channel, ciphertext);
      if (delivery.channel === 'SLACK') body = JSON.stringify({ text: delivery.body });
      else {
        const url = new URL(endpoint);
        url.searchParams.set('wait', 'true');
        endpoint = url.toString();
        body = JSON.stringify({ content: delivery.body });
      }
    }
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch {
      throw new DeliveryError('Provider request timed out or failed.', true);
    }
    if (!response.ok) {
      throw new DeliveryError(
        `Provider returned HTTP ${response.status}.`,
        response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500,
      );
    }
    if (delivery.channel === 'SLACK') {
      const result = await response.text();
      if (result.trim() !== 'ok')
        throw new DeliveryError('Provider returned an invalid response.', true);
      return delivery.deliveryKey;
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new DeliveryError('Provider returned malformed JSON.', true);
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      !('id' in result) ||
      typeof result.id !== 'string' ||
      !result.id
    ) {
      throw new DeliveryError('Provider returned an invalid response.', true);
    }
    return result.id;
  }
}

class DeliveryError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

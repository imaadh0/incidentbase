import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

describe('logger redaction contract', () => {
  it('redacts credential-shaped fields', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        callback();
      },
    });
    const logger = pino(
      {
        redact: {
          paths: ['password', 'refreshToken'],
          censor: '[REDACTED]',
        },
      },
      destination,
    );

    logger.info({ password: 'secret', refreshToken: 'token' }, 'credentials received');
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('token');
  });
});

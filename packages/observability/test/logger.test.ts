import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

describe('logger redaction contract', () => {
  it('redacts credential-shaped fields', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
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

import { describe, expect, it } from 'vitest';

import { PASSWORD_MIN_LENGTH, passwordSchema } from './auth.js';

describe('registration password length', () => {
  it('accepts a ten-character password and rejects passwords shorter than eight characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(passwordSchema.safeParse('1234567').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(true);
    expect(passwordSchema.safeParse('1234567890').success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { invitationEmail, notificationEmail, verificationEmail } from '../src/email.js';

describe('IncidentBase email templates', () => {
  it('renders an accessible action and escapes organization names', () => {
    const email = invitationEmail({
      organizationName: '<script>alert(1)</script>',
      role: 'RESPONDER',
      url: 'https://incidentbase.space/sign-in?invitation=abc',
    });
    expect(email.html).toContain('background:#070c12');
    expect(email.html).toContain('https://incidentbase.space/sign-in?invitation=abc');
    expect(email.html).not.toContain('<script>');
    expect(email.text).toContain('24 hours');
  });

  it('puts verification codes in both HTML and text without links', () => {
    const email = verificationEmail('012345');
    expect(email.html).toContain('012345');
    expect(email.text).toContain('012345');
    expect(email.text).toContain('10 minutes');
  });

  it('escapes notification content', () => {
    const email = notificationEmail('Incident update', '<img src=x onerror=alert(1)>');
    expect(email.html).not.toContain('<img');
    expect(email.text).toContain('<img');
  });
});

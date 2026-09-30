export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

function layout(
  title: string,
  introduction: string,
  detail: string,
  action?: { label: string; url: string },
): string {
  const button = action
    ? `<a href="${escapeHtml(action.url)}" style="display:inline-block;background:#46d7ff;color:#031016;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:9px;margin:22px 0">${escapeHtml(action.label)}</a>`
    : '';
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;padding:32px 14px;background:#070c12;font-family:Arial,Helvetica,sans-serif;color:#edf4fb"><div style="max-width:560px;margin:auto;border:1px solid #213044;border-radius:16px;background:#0d151f;padding:36px"><div style="color:#46d7ff;font-size:13px;letter-spacing:2px;font-weight:700">◆ INCIDENTBASE</div><h1 style="font-size:28px;line-height:1.2;margin:32px 0 12px;color:#edf4fb">${escapeHtml(title)}</h1><p style="color:#b9c7d6;line-height:1.6">${escapeHtml(introduction)}</p><div style="background:#121d29;border:1px solid #213044;border-radius:10px;padding:18px;margin:20px 0;color:#edf4fb;line-height:1.6">${detail}</div>${button}<p style="color:#90a2b7;font-size:13px;line-height:1.5">If you did not expect this message, you can ignore it.</p></div><p style="max-width:560px;margin:20px auto;color:#65788e;font-size:12px">IncidentBase · Keep the response moving.</p></body></html>`;
}

export function invitationEmail(input: {
  organizationName: string;
  role: string;
  url: string;
}): EmailContent {
  const subject = `Join ${input.organizationName} on IncidentBase`;
  const text = `You have been invited to ${input.organizationName} as ${input.role.toLowerCase()}. This invitation expires in 24 hours. Open ${input.url} to join. If you did not expect this invitation, ignore this email.`;
  return {
    subject,
    text,
    html: layout(
      `Join ${input.organizationName}`,
      `You have been invited as ${input.role.toLowerCase()} to collaborate on IncidentBase.`,
      'This invitation is valid for 24 hours and can be used once.',
      { label: 'Accept invitation', url: input.url },
    ),
  };
}

export function verificationEmail(code: string): EmailContent {
  return {
    subject: 'Verify your IncidentBase email',
    text: `Your IncidentBase verification code is ${code}. It expires in 10 minutes. If you did not create an account, ignore this email.`,
    html: layout(
      'Verify your email',
      'Enter this code in IncidentBase to finish creating your account.',
      `<div style="color:#46d7ff;font-size:32px;font-weight:700;letter-spacing:8px;text-align:center">${escapeHtml(code)}</div><div style="color:#90a2b7;text-align:center;font-size:13px">Expires in 10 minutes</div>`,
    ),
  };
}

export function notificationEmail(subject: string, body: string): EmailContent {
  return {
    subject,
    text: body,
    html: layout(
      subject,
      'An update from your IncidentBase workspace.',
      `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>`,
    ),
  };
}

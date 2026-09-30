import { expect, test, type Browser, type Page, type Response } from '@playwright/test';

type Account = {
  memberships: { membershipId: string; organizationId: string; organizationName: string }[];
};
type Incident = {
  id: string;
  assignedMembershipId: string;
  currentEscalationStep: number;
  status: string;
  version: number;
};
type ApiResult<T> = { status: number; data?: T; error?: { code: string } };

const password = 'Milestone10-password-2026!';

test('registration explains invalid fields inline and accepts a ten-character password', async ({
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create workspace' }).first().click();
  const form = page.locator('form');
  await form.getByRole('button', { name: 'Create workspace' }).click();
  await expect(form.getByText('Enter your name.')).toBeVisible();
  await expect(form.getByText('Enter your email address.')).toBeVisible();
  await expect(form.getByText('Enter your password.', { exact: true })).toBeVisible();

  await form.getByLabel('Your name').fill('Short Password Owner');
  await form.getByLabel('Organization name').fill('Short Password Workspace');
  await form.getByLabel('Organization slug').fill(`short-${suffix}`);
  await form.getByLabel('Email').fill(`short-${suffix}@example.test`);
  await form.getByLabel('Password', { exact: true }).fill('1234567');
  await form.getByRole('button', { name: 'Create workspace' }).click();
  await expect(form.getByText('Use at least 8 characters.')).toBeVisible();

  await form.getByLabel('Password', { exact: true }).fill('1234567890');
  await form.getByLabel('Confirm password').fill('1234567890');
  await expect(form.getByText('Use at least 8 characters.')).toHaveCount(0);
  await form.getByRole('button', { name: 'Create workspace' }).click();
  await verifyEmail(page, `short-${suffix}@example.test`);
  await expect(page).toHaveURL(/\/app$/);
});

test('a new invitee opens account creation and confirms the password before joining', async ({
  browser,
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await register(
    page,
    'Invitation Test Owner',
    `invite-owner-${suffix}@example.test`,
    `invite-owner-${suffix}`,
  );
  const email = `new-invitee-${suffix}@example.test`;
  const link = await invite(page, email);
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080',
  });
  try {
    const invitee = await context.newPage();
    await invitee.goto(link);
    await expect(invitee.getByRole('button', { name: 'Create account', exact: true })).toHaveClass(
      /active/u,
    );
    await expect(
      invitee.getByRole('heading', { name: 'Join Invitation Test Owner workspace' }),
    ).toBeVisible();
    const form = invitee.locator('form');
    await expect(form.getByLabel('Email')).toHaveValue(email);
    await expect(form.getByLabel('Email')).toHaveAttribute('readonly', '');
    await expect(form.getByLabel('Organization name')).toHaveCount(0);
    await form.getByLabel('Your name').fill('New Invitee');
    await form.getByLabel('Password', { exact: true }).fill(password);
    await form.getByLabel('Confirm password').fill('different-password');
    await form.getByRole('button', { name: 'Create account and join' }).click();
    await expect(form.getByText('Passwords do not match.')).toBeVisible();
    await form.getByLabel('Confirm password').fill(password);
    await form.getByRole('button', { name: 'Create account and join' }).click();
    await verifyEmail(invitee, email);
    await expect(invitee).toHaveURL(/\/app$/);
    const account = await api<Account>(invitee, '/auth/me');
    expect(account.status).toBe(200);
    expect(account.data!.memberships).toEqual([
      expect.objectContaining({ organizationId: owner.organizationId }),
    ]);
  } finally {
    await context.close();
  }
});

test('an owner can email an invitation and still copy its link', async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await register(
    page,
    'Email Invite Owner',
    `email-owner-${suffix}@example.test`,
    `email-owner-${suffix}`,
  );
  const email = `recipient-${suffix}@example.test`;
  await page.getByRole('link', { name: 'Administration' }).click();
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Send email' }) });
  await form.getByLabel('Email').fill(email);
  await form.getByRole('button', { name: 'Send email' }).click();
  await expect(
    page.getByText('Invitation email sent. You can also copy the link below.'),
  ).toBeVisible();
  const link = (await page.locator('.invitation-link code').textContent())!;
  const captureUrl = process.env.E2E_MAIL_CAPTURE_URL ?? 'http://127.0.0.1:8080/__e2e_mail';
  const response = await fetch(`${captureUrl}/messages?to=${encodeURIComponent(email)}`);
  const result = (await response.json()) as { data: { text: string } | null };
  expect(result.data?.text).toContain(link);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy invitation link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
});

test('an existing invitee opens sign-in and lands in the inviting organization', async ({
  browser,
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await register(
    page,
    'Existing Invite Owner',
    `existing-invite-owner-${suffix}@example.test`,
    `existing-invite-owner-${suffix}`,
  );
  const responder = await createResponder(
    browser,
    page,
    'Existing Invitee',
    `existing-invitee-${suffix}`,
  );
  try {
    expect(responder.account.memberships).toEqual(
      expect.arrayContaining([expect.objectContaining({ organizationId: owner.organizationId })]),
    );
    expect(
      await responder.page.evaluate(() => localStorage.getItem('incidentbase.organization')),
    ).toBe(owner.organizationId);
  } finally {
    await responder.context.close();
  }
});

test('mobile navigation and incident severity select remain usable', async ({ page }) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await register(page, 'Mobile Owner', `mobile-${suffix}@example.test`, `mobile-${suffix}`);
  await page.setViewportSize({ width: 375, height: 780 });

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Workspace menu' });
  await expect(menu.getByRole('link', { name: 'Administration' })).toBeVisible();
  await menu.getByRole('link', { name: 'Administration' }).click();
  await expect(page).toHaveURL(/\/app\/administration$/);
  await expect(page.getByRole('heading', { name: 'Organization settings' })).toBeVisible();

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace menu' })
    .getByRole('link', { name: 'Overview' })
    .click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('link', { name: 'View all incidents' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace menu' })
    .getByRole('link', { name: 'Incidents' })
    .click();
  await expect(page).toHaveURL(/\/app\/incidents$/);
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Workspace menu' }).getByRole('link', { name: 'Incidents' }),
  ).toHaveClass(/active/);
  await page.getByRole('button', { name: 'Close navigation menu' }).click();
  await expect(page.getByRole('heading', { name: 'Incident queue' })).toBeVisible();
  await page.getByRole('button', { name: 'New incident' }).click();
  const form = page.getByRole('dialog', { name: 'Start the response' }).locator('form');
  const beforeSelect = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    width: document.documentElement.clientWidth,
  }));
  await form.getByRole('combobox', { name: 'Severity' }).click();
  const afterSelect = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    width: document.documentElement.clientWidth,
  }));
  expect(afterSelect).toEqual(beforeSelect);
  await page.getByRole('option', { name: 'SEV1' }).click();
  expect(
    await form.evaluate((element) => new FormData(element as HTMLFormElement).get('severity')),
  ).toBe('SEV1');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test('demo sidebar background continues to the bottom of long pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.goto('/demo');
  const shell = await page.locator('.app-shell').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  expect(shell).not.toBeNull();
  expect(sidebar).not.toBeNull();
  expect(Math.abs(shell!.y + shell!.height - sidebar!.y - sidebar!.height)).toBeLessThan(2);
});

async function api<T>(
  page: Page,
  path: string,
  method = 'GET',
  body?: object,
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const csrf = document.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith('incidentbase_csrf='))
        ?.split('=')[1];
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = (await response.json()) as { data?: T; error?: { code: string } };
      return { status: response.status, ...payload };
    },
    { path, method, body },
  );
}

async function register(page: Page, name: string, email: string, slug: string) {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Create workspace' }).first().click();
  const form = page.locator('form');
  await form.getByLabel('Your name').fill(name);
  await form.getByLabel('Organization name').fill(`${name} workspace`);
  await form.getByLabel('Organization slug').fill(slug);
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await form.getByLabel('Confirm password').fill(password);
  await form.getByRole('button', { name: 'Create workspace' }).click();
  await verifyEmail(page, email);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: 'Response overview' })).toBeVisible();
  const account = await api<Account>(page, '/auth/me');
  expect(account.status).toBe(200);
  return account.data!.memberships[0]!;
}

async function verifyEmail(page: Page, email: string) {
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  const captureUrl = process.env.E2E_MAIL_CAPTURE_URL ?? 'http://127.0.0.1:8080/__e2e_mail';
  const response = await fetch(`${captureUrl}/messages?to=${encodeURIComponent(email)}`);
  if (!response.ok) throw new Error(`Mail capture returned HTTP ${response.status}.`);
  const result = (await response.json()) as { data: { text: string } | null };
  const code = /code is (\d{6})/u.exec(result.data?.text ?? '')?.[1];
  if (!code) throw new Error(`No verification code was captured for ${email}.`);
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
}

async function invite(owner: Page, email: string) {
  await owner.getByRole('link', { name: 'Administration' }).click();
  const form = owner
    .locator('form')
    .filter({ has: owner.getByRole('button', { name: 'Create link' }) });
  await form.getByLabel('Email').fill(email);
  await form.getByRole('combobox', { name: 'Role' }).click();
  await owner.getByRole('option', { name: 'Responder' }).click();
  await form.getByRole('button', { name: 'Create link' }).click();
  const link = owner.locator('.invitation-link code');
  await expect(link).toContainText('/sign-in?invitation=');
  const invitationUrl = (await link.textContent())!;
  await owner.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await owner.getByRole('button', { name: 'Copy invitation link' }).click();
  await expect(owner.getByRole('button', { name: 'Copy invitation link' })).toContainText('Copied');
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(invitationUrl);
  return invitationUrl;
}

async function acceptInvitation(page: Page, link: string, email: string) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto(link);
  const form = page.locator('form');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true }).first()).toHaveClass(
    /active/u,
  );
  await expect(form.getByLabel('Email')).toHaveValue(email);
  await expect(form.getByLabel('Email')).toHaveAttribute('readonly', '');
  await form.getByLabel('Password').fill(password);
  const responses: Promise<{ action: string; status: number; error: unknown }>[] = [];
  const recordAuthResponse = (response: Response) => {
    const path = new URL(response.url()).pathname;
    const action = /\/invitations\/[^/]+\/login$/u.test(path) ? 'invitation login' : null;
    if (!action) return;
    responses.push(
      response
        .json()
        .then((body: { error?: unknown }) => ({
          action,
          status: response.status(),
          error: body.error,
        }))
        .catch(() => ({ action, status: response.status(), error: null })),
    );
  };
  page.on('response', recordAuthResponse);
  await form.getByRole('button', { name: 'Sign in' }).click();
  try {
    await expect(page).toHaveURL(/\/app$/, { timeout: 10_000 });
  } catch {
    const alerts = await page.getByRole('alert').allTextContents();
    throw new Error(
      `Invitation sign-in did not complete: ${JSON.stringify({ responses: await Promise.all(responses), alerts })}`,
    );
  } finally {
    page.off('response', recordAuthResponse);
  }
}

async function createResponder(browser: Browser, owner: Page, name: string, slug: string) {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080',
  });
  const page = await context.newPage();
  const email = `${slug}@example.test`;
  const ownMembership = await register(page, name, email, slug);
  const link = await invite(owner, email);
  await acceptInvitation(page, link, email);
  const account = await api<Account>(page, '/auth/me');
  expect(account.status).toBe(200);
  return { context, page, ownOrganizationId: ownMembership.organizationId, account: account.data! };
}

test('onboarding through resolution, with tenant denial and reconnect recovery', async ({
  browser,
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await register(
    page,
    'Acceptance Owner',
    `owner-${suffix}@example.test`,
    `owner-${suffix}`,
  );
  const first = await createResponder(browser, page, 'First Responder', `first-${suffix}`);
  const second = await createResponder(browser, page, 'Second Responder', `second-${suffix}`);
  const firstMembership = first.account.memberships.find(
    (m) => m.organizationId === owner.organizationId,
  )!;
  const secondMembership = second.account.memberships.find(
    (m) => m.organizationId === owner.organizationId,
  )!;

  // The owner cannot discover an incident collection in the responder's separate workspace.
  expect((await api(page, `/organizations/${first.ownOrganizationId}/incidents`)).status).toBe(404);

  await page.reload();
  await page.getByRole('link', { name: 'Administration' }).click();
  await page.getByRole('tab', { name: 'Policies' }).click();
  const policyForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Create policy' }) });
  await policyForm.getByLabel('Name').fill(`Acceptance policy ${suffix}`);
  await policyForm.getByRole('combobox', { name: 'Responder' }).first().click();
  await page.getByRole('option', { name: 'First Responder' }).click();
  await policyForm.getByLabel('Escalate after (seconds)').first().fill('15');
  await policyForm.getByRole('button', { name: 'Add escalation step' }).click();
  await policyForm.getByRole('combobox', { name: 'Responder' }).nth(1).click();
  await page.getByRole('option', { name: 'Second Responder' }).click();
  await policyForm.getByLabel('Escalate after (seconds)').nth(1).fill('2');
  await policyForm.getByLabel('Make this the default policy').check();
  await policyForm.getByRole('button', { name: 'Create policy' }).click();
  await expect(page.getByRole('status')).toContainText('Policy created.');

  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'New incident' }).click();
  const title = `Acceptance incident ${suffix}`;
  const create = page.getByRole('dialog', { name: 'Start the response' });
  await create.getByLabel('Title').fill(title);
  await create.getByLabel('Description').fill('Verify assignment, escalation and resolution.');
  await create.getByRole('button', { name: 'Create incident' }).click();
  await expect(page.getByRole('dialog', { name: /Incident INC-/ })).toContainText(title);

  const list = await api<Incident[]>(page, `/organizations/${owner.organizationId}/incidents`);
  expect(list.status).toBe(200);
  const incident = list.data!.find((item) => item.id && item.status === 'OPEN')!;
  const path = `/organizations/${owner.organizationId}/incidents/${incident.id}`;
  expect(incident.assignedMembershipId).toBe(firstMembership.membershipId);
  expect((await api(first.page, path)).status).toBe(200);
  expect(
    (await api(page, `/organizations/${first.ownOrganizationId}/incidents/${incident.id}`)).status,
  ).toBe(404);

  // An unassigned responder cannot acknowledge the incident.
  const denied = await second.page.evaluate(
    async ({ path, version }) => {
      const csrf = document.cookie.match(/(?:^|; )incidentbase_csrf=([^;]+)/)?.[1];
      const response = await fetch(`/api/v1${path}/acknowledge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'If-Match': `"${version}"`, 'x-csrf-token': decodeURIComponent(csrf ?? '') },
      });
      return response.status;
    },
    { path, version: incident.version },
  );
  expect(denied).toBe(403);

  await expect
    .poll(
      async () => {
        const current = await api<Incident>(page, path);
        return current.data?.assignedMembershipId;
      },
      { timeout: 60_000 },
    )
    .toBe(secondMembership.membershipId);
  await expect(page.getByRole('dialog', { name: /Incident INC-/ })).toContainText('Escalated', {
    timeout: 15_000,
  });

  await second.page.getByRole('combobox', { name: 'Organization' }).click();
  await second.page.getByRole('option', { name: 'Acceptance Owner workspace' }).click();
  await second.page.getByRole('button', { name: new RegExp(title) }).click();
  const detail = second.page.getByRole('dialog', { name: /Incident INC-/ });
  await detail.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(detail.getByRole('button', { name: 'Start investigation' })).toBeVisible();
  await detail.getByRole('button', { name: 'Start investigation' }).click();
  await expect(detail.getByRole('button', { name: 'Resolve' })).toBeVisible();
  await detail.getByRole('button', { name: 'Resolve' }).click();
  await expect.poll(async () => (await api<Incident>(page, path)).data?.status).toBe('RESOLVED');
  await expect
    .poll(
      async () => {
        const result = await api<{ status: string }[]>(page, `${path}/summaries`);
        return result.data?.[0]?.status;
      },
      { timeout: 30_000 },
    )
    .toBe('UNAVAILABLE');

  // A reconnect must discover state committed while the browser was offline.
  await page.getByRole('button', { name: 'Close detail' }).click();
  await page.context().setOffline(true);
  const created = await api<Incident>(
    second.page,
    `/organizations/${owner.organizationId}/incidents`,
    'POST',
    {
      title: `Reconnect incident ${suffix}`,
      description: 'Created while the owner browser is offline.',
      severity: 'SEV3',
    },
  );
  expect(created.status).toBe(201);
  await page.context().setOffline(false);
  await expect(
    page.getByRole('button', { name: new RegExp(`Reconnect incident ${suffix}`) }),
  ).toBeVisible({ timeout: 30_000 });

  await first.context.close();
  await second.context.close();
});

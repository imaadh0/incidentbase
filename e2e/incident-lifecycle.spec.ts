import { expect, test, type Browser, type Page } from '@playwright/test';

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
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: 'Response overview' })).toBeVisible();
  const account = await api<Account>(page, '/auth/me');
  expect(account.status).toBe(200);
  return account.data!.memberships[0]!;
}

async function invite(owner: Page, email: string) {
  await owner.getByRole('button', { name: 'Administration' }).click();
  const form = owner
    .locator('form')
    .filter({ has: owner.getByRole('button', { name: 'Create invitation' }) });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Role').selectOption('RESPONDER');
  await form.getByRole('button', { name: 'Create invitation' }).click();
  const link = owner.locator('.invitation-link code');
  await expect(link).toContainText('/sign-in?invitation=');
  return (await link.textContent())!;
}

async function acceptInvitation(page: Page, link: string, email: string) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto(link);
  const form = page.locator('form');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
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
  await page.getByRole('button', { name: 'Administration' }).click();
  await page.getByRole('tab', { name: 'Policies' }).click();
  const policyForm = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Create policy' }) });
  await policyForm.getByLabel('Name').fill(`Acceptance policy ${suffix}`);
  await policyForm.getByLabel('Responder').first().selectOption(firstMembership.membershipId);
  await policyForm.getByLabel('Escalate after (seconds)').first().fill('15');
  await policyForm.getByRole('button', { name: 'Add escalation step' }).click();
  await policyForm.getByLabel('Responder').nth(1).selectOption(secondMembership.membershipId);
  await policyForm.getByLabel('Escalate after (seconds)').nth(1).fill('2');
  await policyForm.getByLabel('Make this the default policy').check();
  await policyForm.getByRole('button', { name: 'Create policy' }).click();
  await expect(page.getByRole('status')).toContainText('Policy created.');

  await page.getByRole('button', { name: 'Overview' }).click();
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

  await second.page.getByLabel('Organization').selectOption(owner.organizationId);
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

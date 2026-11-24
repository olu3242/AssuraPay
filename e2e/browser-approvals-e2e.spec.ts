import { expect, test, type Page } from '@playwright/test';

/**
 * browser-approvals-e2e — `/approvals` is a screen that reads the platform, not a heading.
 *
 * `/approvals` was a heading and a sentence with no queue, and it is where the Engine 09 notification
 * emails send a release approver: "a release approval is waiting for you" led to a page showing no
 * approvals. These assertions are about what makes the replacement trustworthy rather than merely
 * present — that it distinguishes the states it is in, and never shows a figure it did not read.
 *
 * ## What the founder cannot do, and why that is the first assertion
 *
 * `WORKSPACE_ADMINISTRATOR` is the only bootstrappable role, and it "deliberately holds no
 * certification, release or payment key, so founding a workspace does not create a principal who can
 * move money alone". It therefore holds no `executions:read` either, so a freshly founded owner is
 * *refused* the inbox. That refusal is the policy working, and this suite asserts it — found by
 * clicking, when a test written to expect an empty queue got `ENFORCEMENT_PERMISSION_DENIED`
 * instead. A screen that rendered an empty queue there would have reported "nothing is waiting for
 * you" to someone who is not permitted to know, which is the one failure mode worse than showing
 * nothing.
 *
 * The queue is then reached the way a real deployment reaches it: the administrator uses the
 * authority it does hold — `roles:assign` — to grant an execution role through the governed route,
 * and the screen fills. Nothing here calls an engine directly and no test-only branch is used; §19
 * forbids environment-specific business truth, and a suite that arranged its own preconditions
 * through a back door would certify the back door.
 *
 * The authorization rule *inside* the queue — that an entry is offered only to a holder of the
 * required role, and that work belonging to others is counted rather than listed — is certified
 * against real rows under forced row-level security in
 * `packages/database-testing/src/approval-inbox.postgres.test.ts`. Driving a commercial commitment
 * all the way to its release gate by clicking is a later journey and not this one's claim.
 */

function uniqueEmail(label: string): string {
  return `approvals-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

/** Registers, signs in, founds an organization and activates its workspace. Returns the workspace id. */
async function foundWorkspace(page: Page, label: string): Promise<string> {
  // The bootstrap journey, because there is no other way to reach an active workspace context: a
  // permission is evaluated against a workspace-scoped grant, and forced row-level security returns
  // nothing to a caller without one.
  await page.goto('/start');
  await page.getByTestId('email').fill(uniqueEmail(label));
  await page.getByTestId('display-name').fill(`Approvals ${label}`);
  await page.getByTestId('register').click();
  await expect(page.getByTestId('outcome-ok')).toBeVisible();
  await page.getByTestId('sign-in').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
  await page.getByTestId('organization-name').fill(`Approvals ${label} Organization`);
  await page.getByTestId('found-tenant').click();
  await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');
  const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
  expect(workspaceId).not.toHaveLength(0);
  await page.getByTestId(`activate-${workspaceId}`).click();
  await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
  return workspaceId;
}

/**
 * A single-use identity assertion, minted the way the application's own client mints one.
 *
 * Acting routes consume an assertion, so one authorises exactly one request and a cached one is
 * refused on the second. Each caller below therefore mints its own.
 */
async function assertion(page: Page, workspaceId: string): Promise<string> {
  const response = await page.request.post('/api/v1/auth/assertion', { data: { workspaceId } });
  expect(response.ok(), 'minting an identity assertion must succeed for a signed-in caller').toBe(true);
  return ((await response.json()) as { assertion: string }).assertion;
}

/** The founding administrator grants an execution role, through the route that governs granting. */
async function grantExecutionRole(page: Page, workspaceId: string, userId: string): Promise<void> {
  const response = await page.request.post('/api/v1/roles/assignments', {
    headers: { 'x-assurapay-identity-assertion': await assertion(page, workspaceId) },
    data: { userId, role: 'EXECUTION_MANAGER' },
  });
  // Asserted rather than assumed: assignment "is refused when the resulting permission set would
  // breach segregation of duties", so a 201 here is the policy stating that administering a
  // workspace and reading its executions may be held together.
  expect(response.status(), await response.text()).toBe(201);
}

test.describe('browser-approvals-e2e: the screen states its own condition', () => {
  test('tells a visitor with no session to sign in, rather than showing an empty queue', async ({
    page,
  }) => {
    await page.goto('/approvals');

    // Signed out is not the same fact as "no approvals", and the screen says which one it is.
    await expect(page.getByTestId('approvals-signed-out')).toBeVisible();
    await expect(page.getByTestId('approvals-empty')).toHaveCount(0);
    await expect(page.getByTestId('approval-entry')).toHaveCount(0);
  });

  test('refuses the founding administrator in words, because that role holds no execution key', async ({
    page,
  }) => {
    await foundWorkspace(page, 'founder');
    await page.goto('/approvals');

    // Deny by default, surfaced rather than swallowed. The founder is an administrator, not an
    // execution participant, so the honest answer is "you cannot see approvals here" — never an
    // empty queue, which would be a statement about work this caller may not be told about.
    await expect(page.getByTestId('approvals-forbidden')).toBeVisible();
    await expect(page.getByTestId('approvals-forbidden')).toContainText('ENFORCEMENT_PERMISSION_DENIED');
    // And it names the remedy, so a person who cannot act knows to ask someone rather than to keep
    // refreshing a page that will never fill.
    await expect(page.getByTestId('approvals-forbidden')).toContainText(
      'Ask a workspace administrator for the role that approves releases.',
    );
    await expect(page.getByTestId('approvals-empty')).toHaveCount(0);
    await expect(page.getByTestId('approval-entry')).toHaveCount(0);
  });

  test('shows an honest empty queue once an execution role is granted, read through the caller’s own assertion', async ({
    page,
  }) => {
    const workspaceId = await foundWorkspace(page, 'empty');
    const userId = (await page.getByTestId('session-user').innerText()).trim();
    await grantExecutionRole(page, workspaceId, userId);

    await page.goto('/approvals');

    // Reached the platform and got an answer. Getting this far exercises the whole chain the screen
    // depends on: the session route, a freshly minted single-use identity assertion, the gateway's
    // permission check on `executions:read`, and a workspace-scoped read under forced row-level
    // security. A failure in any of them renders a different state than this one.
    await expect(page.getByTestId('approval-inbox')).toBeVisible();
    await expect(page.getByTestId('approvals-empty')).toBeVisible();
    await expect(page.getByTestId('approvals-empty')).toContainText('Nothing is waiting for you');

    // Not a refusal dressed as an empty queue, and not an error.
    await expect(page.getByTestId('approvals-forbidden')).toHaveCount(0);
    await expect(page.getByTestId('approvals-error')).toHaveCount(0);
    await expect(page.getByTestId('approvals-signed-out')).toHaveCount(0);

    // A new workspace has no execution in flight, so nothing is waiting on anyone else either — and
    // the screen says that rather than implying work it cannot see.
    await expect(page.getByTestId('approvals-empty')).toContainText(
      'No execution step in this workspace is currently waiting for a decision.',
    );
    await expect(page.getByTestId('approval-entry')).toHaveCount(0);
    await expect(page.getByTestId('approvals-waiting-on-others')).toHaveCount(0);
  });

  test('keeps the deep link from the notification email on the caller’s own queue', async ({ page }) => {
    const workspaceId = await foundWorkspace(page, 'deeplink');
    const userId = (await page.getByTestId('session-user').innerText()).trim();
    await grantExecutionRole(page, workspaceId, userId);

    // `?task=` is the shape the Engine 09 email sends — `/approvals?task={id}`. It highlights an item
    // in the reader's own queue; it does not fetch the named task. So a link naming a task this
    // caller does not hold shows them their own queue, which here is empty.
    await page.goto('/approvals?task=00000000-0000-0000-0000-000000000000');

    await expect(page.getByTestId('approvals-empty')).toBeVisible();
    await expect(page.getByTestId('approval-entry')).toHaveCount(0);
    // Specifically not a lookup of the id in the URL: no error, no refusal, and no row conjured for it.
    await expect(page.getByTestId('approvals-error')).toHaveCount(0);
    await expect(page.getByTestId('approvals-forbidden')).toHaveCount(0);
  });
});

test.describe('browser-approvals-e2e: the route behind the screen', () => {
  test('refuses the inbox with no session', async ({ request }) => {
    // Deny by default. The screen's signed-out state is a courtesy; this is the enforcement.
    const response = await request.get('/api/v1/approvals');
    expect(response.ok()).toBe(false);
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('refuses the inbox when the caller presents a session cookie but no identity assertion', async ({
    page,
  }) => {
    const workspaceId = await foundWorkspace(page, 'no-assertion');
    const userId = (await page.getByTestId('session-user').innerText()).trim();
    await grantExecutionRole(page, workspaceId, userId);

    // The session cookie alone must not authenticate the route, even for a caller who now holds the
    // permission. Reading identity from a cookie or header was recorded as "a complete
    // authentication and authorization bypass on every route that used it", so the gateway
    // authenticates only a signed assertion — and this request carries the cookie without one.
    const cookies = await page.context().cookies();
    expect(
      cookies.find((cookie) => cookie.name === 'assurapay_session'),
      'the sign-in must have set a session cookie for this assertion to be meaningful',
    ).toBeTruthy();

    const response = await page.request.get('/api/v1/approvals');
    expect(response.ok()).toBe(false);
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('refuses an assertion that was not issued by this deployment', async ({ page }) => {
    const workspaceId = await foundWorkspace(page, 'forged');
    const userId = (await page.getByTestId('session-user').innerText()).trim();
    await grantExecutionRole(page, workspaceId, userId);

    const response = await page.request.get('/api/v1/approvals', {
      headers: { 'x-assurapay-identity-assertion': 'not.a.signed.assertion' },
    });
    expect(response.ok()).toBe(false);
  });

  test('accepts a replayed assertion on the read path, which is the documented behaviour and a gap', async ({
    page,
  }) => {
    const workspaceId = await foundWorkspace(page, 'replay');
    const userId = (await page.getByTestId('session-user').innerText()).trim();
    await grantExecutionRole(page, workspaceId, userId);

    const headers = { 'x-assurapay-identity-assertion': await assertion(page, workspaceId) };
    const first = await page.request.get('/api/v1/approvals', { headers });
    expect(first.ok(), await first.text()).toBe(true);

    // Asserted as it is, not as it ought to be.
    //
    // `requestContext` "verifies without consuming, so it is safe on every request and leaves the
    // assertion's single use available to an acting path" — so a replay on a *read* is intended.
    // What is not intended is that the acting path never runs: `actingRequestContext` is exported
    // and has no callers, so every route authenticates without consuming and the gateway's
    // `ASSERTION_REPLAYED` refusal, which its own unit tests prove works, is unreachable over HTTP.
    // An assertion is therefore replayable within its validity window on acting routes too,
    // including the decision route this screen posts to.
    //
    // This test pins the live behaviour so the gap is visible and so wiring the consuming context
    // fails here loudly rather than silently breaking a client. It asserts no claim that replay is
    // safe. Recorded as a finding rather than fixed in passing, because changing the context class
    // of every acting route is not a change to make inside a screen.
    const replayed = await page.request.get('/api/v1/approvals', { headers });
    expect(replayed.ok()).toBe(true);
  });
});

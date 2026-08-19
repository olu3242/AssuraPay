import { expect, test } from '@playwright/test';

/**
 * browser-auth-e2e — registration, sign-in, tenant founding, workspace context, sign-out, and the refusals.
 *
 * The first browser certification AssuraPay has ever had. Before this suite the application had 163 API routes
 * and no browser caller of any of them, so "the platform works" had never been demonstrated through the surface
 * a user actually touches. `docs/product/RC1_GAP_MATRIX.md` records the measurement that established it.
 *
 * Every assertion here goes through the real production build against real PostgreSQL, and every state change is
 * made by clicking. Nothing calls an engine directly, and no test-only branch exists in the routes these clicks
 * reach — §19 of the RC1 brief forbids environment-specific business truth, and a browser suite that arranged
 * its own preconditions through a back door would certify the back door.
 *
 * ## Why this journey first
 *
 * It is the only one that can be first. 156 of the 163 routes are permission-gated; a permission is evaluated
 * against a grant, a grant is workspace-scoped, and forced row-level security returns nothing to a caller with
 * no workspace. Until a browser can register, sign in and reach an active workspace context, no other browser
 * journey has a scope to run in.
 */

/** A distinct identity per run, so the suite never depends on a previous one's rows. */
function uniqueEmail(label: string): string {
  return `rc1-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@assurapay.test`;
}

test.describe('browser-auth-e2e: the bootstrap journey', () => {
  test('registers, signs in, founds an organization, and activates a workspace context', async ({ page }) => {
    const email = uniqueEmail('bootstrap');

    await page.goto('/start');
    await expect(page.getByTestId('bootstrap-console')).toBeVisible();
    // Nothing is claimed before anything happens.
    await expect(page.getByTestId('session-absent')).toBeVisible();

    await page.getByTestId('email').fill(email);
    await page.getByTestId('display-name').fill('RC1 Bootstrap Owner');
    await page.getByTestId('register').click();
    await expect(page.getByTestId('outcome-ok')).toContainText('Registration succeeded');

    await page.getByTestId('sign-in').click();
    await expect(page.getByTestId('outcome-ok')).toContainText('Sign-in succeeded');

    // The cookie itself, asserted rather than inferred from a 200. `assurapay_session` is set `Secure`, so on an
    // origin the browser does not trust it would be dropped silently and every assertion below would fail in a
    // way that looks like an application defect rather than a harness one.
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === 'assurapay_session');
    expect(session, 'the login route must set assurapay_session').toBeTruthy();
    expect(session?.httpOnly, 'the session cookie must be HttpOnly').toBe(true);

    // Signed in, and honest about having no tenant yet: registration does not create one.
    await expect(page.getByTestId('session-summary')).toBeVisible();
    await expect(page.getByTestId('session-user')).not.toBeEmpty();
    await expect(page.getByTestId('no-memberships')).toBeVisible();

    await page.getByTestId('organization-name').fill('RC1 Bootstrap Organization');
    await page.getByTestId('found-tenant').click();
    await expect(page.getByTestId('outcome-ok')).toContainText('Tenant founding succeeded');

    // The founding route mints the tenant, its first workspace and the caller's OWNER membership. The membership
    // list is read back from `/v1/me/workspaces` under the caller's own session, so this is the platform's
    // answer rather than the form's.
    const memberships = page.getByTestId('membership');
    await expect(memberships).toHaveCount(1);
    const workspaceId = (await page.getByTestId('membership-workspace').innerText()).trim();
    expect(workspaceId).not.toHaveLength(0);

    await page.getByTestId(`activate-${workspaceId}`).click();
    await expect(page.getByTestId('outcome-ok')).toContainText('Context activation succeeded');
    await expect(page.getByTestId('session-workspace')).toHaveText(workspaceId);
    // A tenant the caller never named: the route mints it, which is what makes the identity-class route safe.
    await expect(page.getByTestId('session-tenant')).not.toHaveText('— none yet —');
  });

  test('a signed-in session survives a reload, because it lives in the database and not in the page', async ({
    page,
  }) => {
    const email = uniqueEmail('reload');

    await page.goto('/start');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('display-name').fill('RC1 Reload Owner');
    await page.getByTestId('register').click();
    await expect(page.getByTestId('outcome-ok')).toBeVisible();
    await page.getByTestId('sign-in').click();
    await expect(page.getByTestId('session-summary')).toBeVisible();

    const userId = (await page.getByTestId('session-user').innerText()).trim();

    await page.reload();
    // Resolved again from the cookie through `GET /v1/auth/session`, which reads the durable session row. No
    // client state carries across a reload, so this is the store answering.
    await expect(page.getByTestId('session-summary')).toBeVisible();
    await expect(page.getByTestId('session-user')).toHaveText(userId);
  });

  test('signs out, and the session stops resolving', async ({ page }) => {
    const email = uniqueEmail('signout');

    await page.goto('/start');
    await page.getByTestId('email').fill(email);
    await page.getByTestId('display-name').fill('RC1 Sign-out Owner');
    await page.getByTestId('register').click();
    await expect(page.getByTestId('outcome-ok')).toBeVisible();
    await page.getByTestId('sign-in').click();
    await expect(page.getByTestId('session-summary')).toBeVisible();

    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('session-absent')).toBeVisible();

    await page.reload();
    // Revocation is durable, not a cleared cookie: the row is revoked, so presenting the token again resolves
    // nothing even if a client kept it.
    await expect(page.getByTestId('session-absent')).toBeVisible();
  });
});

test.describe('browser-auth-e2e: the refusals', () => {
  test('refuses an unauthenticated session lookup', async ({ request }) => {
    const response = await request.get('/api/v1/auth/session');
    expect(response.ok()).toBe(false);
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('refuses a permission-gated route with no session', async ({ request }) => {
    // Deny-by-default, from outside any session. 156 of the 163 routes are in this class.
    const response = await request.get('/api/v1/agreements');
    expect(response.ok()).toBe(false);
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('refuses sign-in for an identity that was never registered', async ({ request }) => {
    const response = await request.post('/api/v1/auth/login', {
      data: { email: uniqueEmail('never-registered') },
    });
    expect(response.ok()).toBe(false);
  });

  test('reports liveness and readiness', async ({ request }) => {
    // §15 asks for both, and both already existed. Readiness is the meaningful one: it is the endpoint that
    // refuses when the schema the store routes to is absent, so a 200 here is a statement about the database.
    expect((await request.get('/api/health/live')).ok()).toBe(true);
    // A 200 here is a statement about the database: readiness refuses when the schema the store routes to is
    // absent, and it refuses a durable deployment whose TLS is not stated — which is how this suite discovered
    // it had been pointed at a plaintext connection.
    expect((await request.get('/api/health/ready')).ok()).toBe(true);
  });
});

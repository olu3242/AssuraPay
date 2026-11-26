#!/usr/bin/env node
/**
 * Provisions one identity that can act as every persona, for manual testing.
 *
 * ## What this gives you, and what it cannot
 *
 * One account, one tenant, and **one workspace per persona**. The account is the founding
 * administrator of each — the role this platform calls an administrator, which onboards parties,
 * assigns roles and publishes policy and holds no certification, release or payment key — and in each
 * workspace it additionally holds that persona's catalogue roles.
 *
 * You change persona by changing workspace, in the switcher already in the application header.
 *
 * It cannot give you one workspace holding every persona's authority, because the platform refuses
 * that: `grantRole` rejects an assignment whose resulting permission set breaches
 * `SEGREGATION_CATALOGUE` and answers `CATALOGUE_SEGREGATION_CONFLICT`. See `persona-test-roles.mjs`
 * for the whole argument. That refusal is not in the way of testing — it is one of the things worth
 * testing.
 *
 * ## It drives the real routes
 *
 * Every step is an HTTP call to the running deployment: register, verify, log in, mint an assertion,
 * found, create, activate, assign. Nothing is written to a table directly. So the grants it creates
 * carry the same audit records, domain events and row-level security as any grant an operator makes by
 * hand — and if a step is refused, that refusal is the product telling the truth rather than a seed
 * script routing around it.
 *
 * ## Usage
 *
 *   node scripts/provision-persona-tester.mjs --email you@example.com [--base-url http://localhost:3000]
 *
 * The address is a parameter and is never committed: it is a person's email, and this file is in a
 * repository. `ASSURAPAY_TESTER_EMAIL` and `ASSURAPAY_BASE_URL` work too.
 *
 * Re-running is safe. Registration of an existing address is reported and stepped over, and a repeated
 * role assignment grants nothing new — the route answers `{ granted: 0 }`.
 *
 * ## It needs a deployment that returns the verification token
 *
 * Engine 09 is deferred, so a deployment with no mail channel declares
 * `ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL=DIRECT_RETURN` and `POST /v1/auth/register` returns the
 * token to the caller instead of emailing it. Without that, this script cannot complete verification
 * and says so rather than pretending the account is ready.
 */

import { FOUNDING_ROLE, PERSONA_TEST_WORKSPACES } from './persona-test-roles.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith('--')) continue;
  const [name, inline] = argument.slice(2).split('=');
  args.set(name, inline ?? process.argv[++index]);
}

const EMAIL = args.get('email') ?? process.env.ASSURAPAY_TESTER_EMAIL;
const BASE = (args.get('base-url') ?? process.env.ASSURAPAY_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ORG = args.get('org') ?? 'Persona Test Organization';

if (!EMAIL) {
  console.error('provision-persona-tester: --email is required (or set ASSURAPAY_TESTER_EMAIL).');
  process.exit(2);
}

/** One jar for the whole run: the session is a cookie, exactly as it is in a browser. */
const cookies = new Map();

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function absorb(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(method, path, body, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  const jar = cookieHeader();
  if (jar) headers.cookie = jar;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  absorb(response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

/** The failure code the API returned, so the log names the reason rather than a status number. */
function reasonOf(result) {
  const body = result.body ?? {};
  return body.code ?? body.error?.code ?? body.error ?? body.message ?? `HTTP ${result.status}`;
}

function fail(step, result) {
  console.error(`\n  ✗ ${step}: ${reasonOf(result)}`);
  if (result.body && Object.keys(result.body).length) {
    console.error(`    ${JSON.stringify(result.body).slice(0, 500)}`);
  }
  process.exit(1);
}

/**
 * Mints a fresh assertion, optionally for a named workspace.
 *
 * Fresh per call, because an acting route consumes the one it is given. Scoped to a workspace where one
 * is named: `issueAssertionForSession` refuses a workspace the caller is not an active member of, so
 * the refusal comes from proven membership rather than from a route trusting a body field.
 */
async function assertion(workspaceId) {
  const minted = await call('POST', '/api/v1/auth/assertion', workspaceId ? { workspaceId } : {});
  if (!minted.ok) fail(`minting an assertion${workspaceId ? ` for ${workspaceId}` : ''}`, minted);
  return { 'x-assurapay-identity-assertion': minted.body.assertion };
}

async function main() {
  console.log(`\nProvisioning a persona tester`);
  console.log(`  deployment  ${BASE}`);
  console.log(`  identity    ${EMAIL}\n`);

  const ready = await call('GET', '/api/health/ready');
  if (!ready.ok) fail('the deployment is not ready', ready);

  // ---- identity -----------------------------------------------------------
  const registered = await call('POST', '/api/v1/auth/register', {
    email: EMAIL,
    displayName: 'Persona Tester',
  });

  if (registered.ok) {
    const token = registered.body?.emailVerificationToken;
    if (!token) {
      console.error(
        '\n  ✗ this deployment delivers the verification token by mail, so the address must be\n' +
          '    verified from the inbox before the rest of this can run. Set\n' +
          '    ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL=DIRECT_RETURN to provision without a mail channel.',
      );
      process.exit(1);
    }
    const verified = await call('POST', '/api/v1/auth/verify-email', {
      userId: registered.body.id,
      token,
    });
    if (!verified.ok) fail('verifying the address', verified);
    console.log('  ✓ registered and verified');
  } else {
    // Already registered is the ordinary case on a re-run, not an error.
    console.log(`  · registration skipped (${reasonOf(registered)})`);
  }

  const signedIn = await call('POST', '/api/v1/auth/login', { email: EMAIL });
  if (!signedIn.ok) fail('signing in', signedIn);
  const session = await call('GET', '/api/v1/auth/session');
  if (!session.ok) fail('reading the session', session);
  const userId = session.body.userId;
  console.log(`  ✓ signed in as ${userId}`);

  // ---- tenant -------------------------------------------------------------
  //
  // `POST /v1/tenants` mints the tenant, its first workspace and the caller's OWNER membership.
  // `POST /v1/workspaces/{id}/found` writes that workspace's first permission grant — without it the
  // owner of a brand-new organization can do nothing in it, because every other route is
  // permission-gated and there is no grant to evaluate.
  const slug = `persona-test-${Date.now().toString(36)}`;
  const tenant = await call(
    'POST',
    '/api/v1/tenants',
    { name: ORG, slug, workspaceType: 'ORGANIZATION' },
    await assertion(),
  );
  if (!tenant.ok) fail('founding the organization', tenant);
  const rootWorkspaceId = tenant.body?.workspace?.id;
  if (!rootWorkspaceId) fail('founding the organization', { status: 500, body: tenant.body });

  const founded = await call(
    'POST',
    `/api/v1/workspaces/${encodeURIComponent(rootWorkspaceId)}/found`,
    {},
    await assertion(rootWorkspaceId),
  );
  if (!founded.ok) fail('founding the administration', founded);
  console.log(`  ✓ organization founded — administering workspace ${rootWorkspaceId}`);

  // ---- one workspace per persona -----------------------------------------
  const provisioned = [];
  for (const entry of PERSONA_TEST_WORKSPACES) {
    // Created from the root workspace's context: `workspaces:create` is a permission the founding
    // role holds, and the tenant comes from the authorized context rather than from the body.
    const activateRoot = await call(
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(rootWorkspaceId)}/activate-context`,
      {},
      await assertion(rootWorkspaceId),
    );
    if (!activateRoot.ok) fail('activating the administering workspace', activateRoot);

    const created = await call(
      'POST',
      '/api/v1/workspaces',
      {
        // The persona leads. These names are read in a `<select>` in the header, which truncates —
        // and every one of them sharing an organization-name prefix meant the switcher showed nine
        // identical truncations of the only word that mattered.
        name: `${entry.label} — ${ORG}`,
        slug: `${slug}-${entry.workspace}`,
        workspaceType: 'ORGANIZATION',
      },
      await assertion(rootWorkspaceId),
    );
    if (!created.ok) fail(`creating the ${entry.workspace} workspace`, created);
    const workspaceId = created.body.id;

    const foundedOne = await call(
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/found`,
      {},
      await assertion(workspaceId),
    );
    if (!foundedOne.ok) fail(`founding the ${entry.workspace} workspace`, foundedOne);

    // Role assignment acts inside the caller's *own* active workspace, never a body field — so the
    // context has to move to the workspace being granted in.
    const activate = await call(
      'POST',
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activate-context`,
      {},
      await assertion(workspaceId),
    );
    if (!activate.ok) fail(`activating the ${entry.workspace} workspace`, activate);

    const assigned = [];
    for (const role of entry.roles) {
      const grant = await call(
        'POST',
        '/api/v1/roles/assignments',
        { userId, role },
        await assertion(workspaceId),
      );
      // A segregation refusal here is the platform working. Reported as such and not retried.
      if (!grant.ok) fail(`assigning ${role} in ${entry.workspace}`, grant);
      assigned.push(`${role}(+${grant.body.granted})`);
    }

    provisioned.push({ ...entry, workspaceId, assigned });
    console.log(
      `  ✓ ${entry.label.padEnd(14)} ${workspaceId}  ${[FOUNDING_ROLE, ...entry.roles].join(' + ')}`,
    );
  }

  // Leave the session in the administering workspace, which is where a tester starts.
  await call(
    'POST',
    `/api/v1/workspaces/${encodeURIComponent(rootWorkspaceId)}/activate-context`,
    {},
    await assertion(rootWorkspaceId),
  );

  console.log(`\n  Sign in at ${BASE}/start with ${EMAIL} — no password; this deployment's`);
  console.log(`  login is address-based. Switch persona with the Workspace control in the header.\n`);
  console.log(`  workspace view            roles beyond the founding administrator`);
  for (const entry of provisioned) {
    const view = entry.workspace === 'approver' ? '/approvals' : `/workspace/${entry.workspace}`;
    console.log(`  ${view.padEnd(25)} ${entry.roles.length ? entry.roles.join(', ') : '—'}`);
  }
  console.log(
    `\n  No workspace above holds two segregated duties. That is not a choice this script made:\n` +
      `  the role-assignment route refuses one that would.\n`,
  );
}

main().catch((error) => {
  console.error(`\nprovision-persona-tester failed: ${error?.message ?? error}`);
  process.exit(1);
});

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { e2eDatabaseUrl } from './e2e/database.ts';

/**
 * The browser certification gate.
 *
 * Its own config rather than a flag on the vitest projects, for the same reason `vitest.postgres.config.ts` is
 * separate: these suites require a real database *and* a real built application, and they must never be able to
 * pass by skipping. `provisionE2eDatabase()` below throws when `ASSURAPAY_TEST_DATABASE_URL` is unset, and it
 * runs while this module is being evaluated — so a machine with no PostgreSQL fails before Playwright collects a
 * single test, rather than reporting zero tests as a pass.
 *
 * ## Against the production build, not the dev server
 *
 * `pnpm build && pnpm start`. RC1's claim is that the lifecycle works "through the actual production
 * composition boundary", and the dev server is a different composition: different module resolution, different
 * error handling, no production environment gate. A browser suite green against `next dev` would not support the
 * claim the suite exists to make. The cost is a slow first run, which is why the web server is reused locally
 * and rebuilt in CI.
 *
 * ## localhost, deliberately
 *
 * `POST /v1/auth/login` sets `assurapay_session` with `Secure`, so the origin has to be one the browser treats
 * as trustworthy or the cookie is silently dropped and every authenticated assertion fails for a reason that
 * looks like an application bug. Chromium counts `http://localhost` as a secure context, so the suite runs
 * there — and `browser-auth-e2e.spec.ts` asserts the cookie is actually present rather than inferring it from a
 * 200, because "silently dropped" is exactly the failure that would otherwise pass as something else.
 *
 * ## One worker
 *
 * These journeys found tenants and activate workspace contexts against one database. Running them in parallel
 * would make each suite's visible state depend on what another happened to be doing, which is the same reason
 * the PostgreSQL config is single-fork.
 */
const PORT = Number(process.env.ASSURAPAY_E2E_PORT ?? 3100);
// `apps/web`'s own `start` script hardcodes `--port 3000`, so `PORT` in the environment is ignored and a config
// that only set it would start the app on 3000 and then wait ten minutes for 3100. The port is passed to
// `next start` explicitly instead — measured, not assumed: the first run of this suite timed out for exactly
// that reason.
/** The development image's pre-installed Chromium, when this is running there. */
const PINNED_CHROMIUM = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((candidate) =>
  existsSync(candidate),
);

// Started from the **repository root** with the app directory as an argument, not from `apps/web`.
//
// `defaultMigrationsDirectory()` in `packages/runtime` resolves `supabase/migrations` against
// `process.cwd()`, and the repository's own `start` script runs `next start` inside `apps/web` — where that
// directory does not exist. Readiness therefore fails with
// `ENOENT: scandir '.../apps/web/supabase/migrations'`, which this harness found the first time it got far
// enough past the TLS gate to reach it. `next start <dir>` keeps the cwd at the root while still finding the
// build output, so the path resolves. The finding is recorded in `docs/product/RC1_GAP_MATRIX.md`: a
// deployment that starts the app from the app directory has a readiness endpoint that can never report ready.
// Provisioning is a step *in the start command*, not a `globalSetup`, and that ordering is the whole
// point rather than a style preference.
//
// Playwright launches `webServer` concurrently with global setup, so a harness that migrated in
// `globalSetup` was racing the application's own startup. The first version leaned on
// `/api/health/ready` to bridge the gap — readiness answers 503 until the schema is present — but the
// runtime does not retry: it fails startup once, caches
// `RUNTIME_MIGRATIONS_PENDING: 1 required migration(s) have not been applied`, and never recovers. So
// readiness never turns green and the run dies ten minutes later on a webServer timeout.
//
// That race was invisible for several runs because the database already carried a full schema from
// the previous one, and it appeared the moment a migration was added — which is to say it would have
// appeared in CI, on every run, since CI always starts from a fresh database. Sequencing the two with
// `&&` removes the race instead of timing it: the application cannot start until the schema it
// verifies at startup exists. It also runs exactly once, which is what `globalSetup` was chosen for
// over module scope in the first place.
const PROVISION_COMMAND =
  'pnpm vitest run --config vitest.postgres.config.ts e2e/e2e-database.postgres.test.ts';
const START_COMMAND = `pnpm build && ${PROVISION_COMMAND} && pnpm exec next start apps/web --hostname 127.0.0.1 --port ${PORT}`;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // No `globalSetup`. Provisioning moved into `webServer.command` because Playwright runs global setup
  // concurrently with the web server, and the application verifies its schema at startup — see the
  // note on `PROVISION_COMMAND`.
  // Only `.spec.ts`. `e2e/e2e-database.postgres.test.ts` is a vitest suite that lives here because it
  // provisions this gate's database; without this, Playwright collects it and fails on
  // "Vitest cannot be imported in a CommonJS module".
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Traces and screenshots on failure only: a green run should not produce artefacts nobody reads.
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Conditional, and it has to be. The development image ships Chromium at a pinned path and forbids
        // `playwright install`, so the executable is named rather than resolved by revision — a Playwright
        // version bump would otherwise fail with a download error. CI has no such path: it runs
        // `playwright install chromium`, which puts the browser where Playwright expects it. Pinning
        // unconditionally would have made the config work in exactly one of the two places.
        launchOptions: PINNED_CHROMIUM ? { executablePath: PINNED_CHROMIUM } : {},
      },
    },
  ],
  webServer: {
    command: START_COMMAND,
    // Readiness, not liveness, and under `/api` — the route lives at `app/api/health/ready/route.ts`, so a
    // request to `/health/ready` is a 404 and an earlier version of this config waited ten minutes on one.
    //
    // Readiness rather than liveness because `/api/health/live` answers 200 with no database at all: waiting on
    // it let the suite start against a database global setup had not created yet. Readiness answers 503 until
    // the schema is present and compatible, so this wait is what makes the harness independent of whether
    // Playwright starts the server before or after global setup.
    url: `${BASE_URL}/api/health/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      NODE_ENV: 'production',
      // The durable runtime, which is the point: the suite certifies the composition that refuses to fall back
      // to memory. The start command has already migrated this database; see PROVISION_COMMAND.
      ASSURAPAY_DATABASE_URL: e2eDatabaseUrl(),
      // Stated, because the durable-environment gate requires it to be: `loadPersistenceConfig` refuses a
      // durable deployment that inherits a TLS default and refuses one that disables TLS. Running the browser
      // suite against a plaintext database would have meant either weakening that gate or certifying a
      // composition production cannot use, so the local instance serves TLS and this states `require`. The
      // certificate is self-signed, which `require` accepts and `verify-full` would not — the distinction the
      // config already draws.
      ASSURAPAY_DATABASE_SSL: process.env.ASSURAPAY_E2E_DATABASE_SSL ?? 'require',
      // Stated for the same reason TLS is, and it is a deployment property rather than a test
      // switch: Engine 09 (Notification & Communication) is deferred, so this deployment has no way
      // to email a verification token and declares that `POST /v1/auth/register` returns it to the
      // caller instead. A staging deployment without SMTP sets exactly this. The business rule does
      // not change with it — the token is still required, single-use and expiring — which is what
      // keeps this on the allowed side of §19's line between infrastructure and business truth.
      ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL: 'DIRECT_RETURN',
      // The assertion keyring, which every deployment must supply and this one had not.
      //
      // Found the same way the other two blockers were — by clicking. `POST /v1/tenants` and
      // `POST /v1/auth/logout` are identity-class routes, so they mint a signed assertion through
      // the identity gateway, and an unconfigured deployment fails closed with
      // `ASSERTION_KEYRING_REQUIRED`. That refusal is correct: `assertions.ts` deliberately has no
      // default secret, because a default would mean every deployment signs with a value anyone
      // can read out of the repository.
      //
      // Generated per run rather than committed. A fixed secret in version control is a real one
      // once someone copies this file into a deployment, and nothing here needs it to be stable —
      // the keyring only has to outlive the process it signs for.
      IDENTITY_ASSERTION_KEYS: `e2e:${randomBytes(32).toString('hex')}`,
      IDENTITY_ASSERTION_ACTIVE_KEY_ID: 'e2e',
      IDENTITY_ASSERTION_ISSUER: 'assurapay-e2e',
      IDENTITY_ASSERTION_AUDIENCE: 'assurapay-web',
      // One process, so process-local replay protection is the accurate statement rather than a
      // relaxation: `loadGatewayConfig` requires distributed replay protection under
      // `NODE_ENV=production` precisely because a multi-instance deployment cannot detect replay
      // in memory. This deployment is a single `next start`, which can. A horizontally scaled
      // deployment must not set this, and the variable is named so that saying so is unavoidable.
      IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY: 'true',
    },
  },
});

import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRecord } from '@assurapay/shared';
import { IdentityService } from '@assurapay/identity';
import {
  PermissionService,
  TrustStoreMembershipReader,
  enforcePermission,
} from '@assurapay/permissions';
import { verifyAuditChain } from '@assurapay/audit-ledger';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from '@assurapay/database-testing';
import type { TestDatabase } from '@assurapay/database-testing';
import {
  ProtectedWorkGateError,
  RuntimeStartupError,
  createPersistenceRuntime,
  requirePersistenceReady,
} from './persistence-runtime';
import type {
  PersistenceRuntime,
  RuntimeEvidence,
} from './persistence-runtime';
import { loadPersistenceConfig } from './config';
import { applyMigrations, withTrustScope } from '@assurapay/database';

/**
 * The scope these suites write under.
 *
 * The harness applies the tenancy policies by default, because that is the set a host
 * requires to start. So even a test about runtime lifecycle has to establish a scope before it
 * writes — which is the same requirement production has, and better than opting out of the
 * policies to make the test simpler.
 */
const SCOPE = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  actorId: 'user-1',
};

/**
 * integration: the production composition path, against real PostgreSQL.
 *
 * Nothing here constructs `PostgresTrustStore` directly. Everything goes through
 * `createPersistenceRuntime`, because the claim being certified is that the *production
 * path* works — a test that built the store itself would prove the store works and say
 * nothing about how a host obtains one.
 */

// Asserted at module load, so a run with no database says so once rather than failing every
// test on a connection error.
requireTestDatabaseUrl();

const disposables: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose();
});

/**
 * An isolated database with the full migration set, and a configuration pointed at it.
 *
 * A whole database rather than a schema, and every migration rather than the trust subset,
 * because readiness is now a claim about more tables than the trust ones. `PostgresTrustStore`
 * routes Batch A's sixteen Engine 31-40 collections to purpose-built tables created by
 * `202608030006` and `202608030007`, so those tables are part of `REQUIRED_STORE_TABLES` and a
 * host missing them is correctly unready. The historical set is not schema-relocatable — one of
 * its functions is `SECURITY DEFINER` with `SET search_path=public` — so a schema-isolated
 * harness cannot hold them, and a readiness assertion made against one would have been asserting
 * that a database the runtime refuses to serve is ready.
 *
 * The cost is about a second per database, measured, which is what a fresh database plus
 * twenty-six migrations takes on this cluster.
 */
async function isolatedDatabase(): Promise<{
  database: TestDatabase;
  url: string;
}> {
  const database = await createTestDatabaseInstance();
  disposables.push(() => database.dispose());
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return { database, url: database.url };
}

function productionEnvironment(
  url: string,
  overrides: Record<string, string | undefined> = {},
) {
  return {
    // A durable class, so the memory adapter is refused and the strict rules apply. TLS is
    // disabled only because the test server is a local socket; the configuration still had
    // to state it, which is the property under test in config.test.ts.
    ASSURAPAY_DEPLOYMENT: 'staging',
    ASSURAPAY_DATABASE_URL: url,
    ASSURAPAY_DATABASE_SSL: 'require',
    ...overrides,
  };
}

async function startRuntime(
  url: string,
  overrides: Record<string, string | undefined> = {},
  evidence?: RuntimeEvidence[],
): Promise<PersistenceRuntime> {
  // `require` would need a TLS server; the pool config is exercised in full by the
  // configuration suite, so the runtime tests use a reachable local server.
  const config = loadPersistenceConfig(productionEnvironment(url, overrides));
  const runtime = await createPersistenceRuntime({
    config: { ...config, ssl: 'disable' },
    onEvidence: (entry) => evidence?.push(entry),
  });
  disposables.push(() => runtime.dispose());
  return runtime;
}

const openSockets = () =>
  process.getActiveResourcesInfo().filter((kind) => kind.startsWith('TCP'))
    .length;

/**
 * Waits for the socket count to return to `baseline`, then asserts it did.
 *
 * A leak is a handle that never goes away. The driver closes a socket asynchronously
 * after `end()` resolves — measurably ~50ms after a refused connection — so asserting on
 * the next tick would fail on timing rather than on a leak, and a test that fails for the
 * wrong reason gets deleted rather than fixed. The bound is what makes this an assertion
 * instead of a wait: a genuine leak still fails, one second later.
 */
async function expectNoSocketLeak(baseline: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (openSockets() > baseline && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(openSockets(), 'a socket outlived the runtime that opened it').toBe(
    baseline,
  );
}

const context = (workspaceId: string, userId: string) => ({
  actorUserId: userId,
  sessionId: 'session-1',
  identityAssuranceLevel: 'IAL2_VERIFIED' as const,
  activeWorkspaceId: workspaceId,
  tenantId: 'tenant-1',
  memberships: [workspaceId],
  correlationId: 'corr-1',
});

describe('integration: the runtime is the only path to a store', () => {
  it('produces a PostgreSQL-backed store from production-like configuration', async () => {
    const { url } = await isolatedDatabase();
    const runtime = await startRuntime(url);

    expect(runtime.adapter).toBe('postgres');
    expect(runtime.getState()).toBe('ready');
    expect(runtime.config.deployment).toBe('staging');
    expect(runtime.runtimeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports ready only after connectivity, migrations and schema all check out', async () => {
    const { url } = await isolatedDatabase();
    const evidence: RuntimeEvidence[] = [];
    const runtime = await startRuntime(url, {}, evidence);

    // Order matters: marking ready after connectivity alone would accept work against a
    // reachable database with no tables.
    const events = evidence.map((entry) => entry.event);
    expect(events).toEqual([
      'runtime.initializing',
      'runtime.connected',
      'runtime.schema-verified',
      'runtime.ready',
    ]);
    expect((await runtime.checkReadiness()).ready).toBe(true);
  });

  it('emits no secret in its evidence', async () => {
    const { url } = await isolatedDatabase();
    const evidence: RuntimeEvidence[] = [];
    await startRuntime(url, {}, evidence);

    const serialised = JSON.stringify(evidence);
    expect(serialised).not.toContain('postgres://');
    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('127.0.0.1');
  });
});

describe('integration: a durable environment never falls back to memory', () => {
  it('fails to start when the database is unreachable, rather than substituting a store', async () => {
    // The failure mode this whole capability exists to prevent. A fallback would keep the
    // application answering while every grant and audit record written from then on was
    // discarded — an outage that presents as success.
    const error = await createPersistenceRuntime({
      config: {
        ...loadPersistenceConfig(
          productionEnvironment('postgres://nobody:nothing@127.0.0.1:1/absent'),
        ),
        ssl: 'disable',
        connectTimeoutSeconds: 2,
        startupTimeoutSeconds: 3,
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeStartupError);
    expect((error as RuntimeStartupError).code).toBe(
      'RUNTIME_DATABASE_UNREACHABLE',
    );
  });

  it('refuses to start against a database with no schema', async () => {
    // Reachable is not enough. A host that started here would fail mid-request with a
    // missing-table error, after the caller had been told the request was accepted.
    //
    // Migrated first, then tables dropped, so the two failure modes stay distinguishable: a
    // database that was never migrated reports MIGRATIONS_PENDING, and this test is about the
    // other one — the ledger says the schema is current and the tables are not there.
    const { database, url } = await isolatedDatabase();
    await database.sql.unsafe(
      'DROP TABLE trust_records, trust_audit_records CASCADE',
    );

    const error = await createPersistenceRuntime({
      config: {
        ...loadPersistenceConfig(productionEnvironment(url)),
        ssl: 'disable',
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeStartupError);
    expect((error as RuntimeStartupError).code).toBe(
      'RUNTIME_SCHEMA_INCOMPATIBLE',
    );
  });

  it('leaks no connection when startup fails', async () => {
    // A failed startup holding a pool open would deny a retry the connections it needs.
    const before = openSockets();

    await createPersistenceRuntime({
      config: {
        ...loadPersistenceConfig(
          productionEnvironment('postgres://nobody:nothing@127.0.0.1:1/absent'),
        ),
        ssl: 'disable',
        connectTimeoutSeconds: 2,
        startupTimeoutSeconds: 3,
      },
    }).catch(() => undefined);

    await expectNoSocketLeak(before);
  });
});

describe('integration: protected work is gated on readiness as well as authorization', () => {
  it('refuses protected work once the runtime is shutting down', async () => {
    const { url } = await isolatedDatabase();
    const runtime = await startRuntime(url);

    await runtime.dispose();

    const error = await requirePersistenceReady(runtime).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProtectedWorkGateError);
    expect((error as ProtectedWorkGateError).readiness.code).toBe(
      'POOL_CLOSED',
    );
  });

  it('reports unready when the required schema goes away after startup', async () => {
    // Readiness is checked live rather than cached. A probe answering from a startup
    // snapshot would report healthy straight through an outage.
    const { database, url } = await isolatedDatabase();
    const runtime = await startRuntime(url);
    expect((await runtime.checkReadiness()).ready).toBe(true);

    await database.sql.unsafe('DROP TABLE trust_records CASCADE');

    const readiness = await runtime.checkReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.code).toBe('SCHEMA_INCOMPATIBLE');
    expect(runtime.getState()).toBe('degraded');
    // Still alive: liveness is about the process, and killing a healthy process because
    // its database blinked loses in-flight work and fixes nothing.
    expect(runtime.isAlive()).toBe(true);
  });

  it('carries no secret in an unready response', async () => {
    const { database, url } = await isolatedDatabase();
    const runtime = await startRuntime(url);
    await database.sql.unsafe('DROP TABLE trust_records CASCADE');

    const readiness = await runtime.checkReadiness();
    expect(JSON.stringify(readiness)).not.toContain('postgres://');
    expect(JSON.stringify(readiness)).not.toMatch(/password/i);
  });
});

describe('integration: the full trust application, composed through the runtime', () => {
  it('recovers workspace, membership, grants and audit through a second runtime', async () => {
    const { url } = await isolatedDatabase();

    // Runtime A: found a workspace, admit a member, grant a permission, act.
    const first = await startRuntime(url);
    const workspaceId = 'workspace-1';
    const userId = 'user-1';

    // Scoped, because the harness applies the tenancy policies by default — the same set a
    // host requires to start. A test that opted out of them would prove durability against a
    // schema no deployment runs.
    await withTrustScope(SCOPE, async () => {
      await first.store.append('trustWorkspaces', {
        id: workspaceId,
        tenantId: 'tenant-1',
        name: 'Workspace',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        version: 1,
      });
      await first.store.append('memberships', {
        id: 'membership-1',
        workspaceId,
        userId,
        status: 'ACTIVE',
        role: 'OWNER',
        createdAt: new Date().toISOString(),
        version: 1,
      });

      const permissions = new PermissionService(first.store);
      await permissions.grant(context(workspaceId, userId), {
        userId,
        permissionKey: 'settlement:approve',
        effect: 'ALLOW',
        scopeType: 'WORKSPACE',
        sourceType: 'ROLE',
        sourceId: 'OWNER',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      });

      // A protected operation, enforced at the composition root exactly as a route would.
      const authorized = await enforcePermission(
        { ...context(workspaceId, userId), memberships: [] },
        { permissionKey: 'settlement:approve' },
        {
          memberships: new TrustStoreMembershipReader(first.store),
          permissions,
          store: first.store,
        },
      );
      expect(authorized.memberships).toEqual([workspaceId]);
    });

    await first.dispose();

    // Runtime B: a wholly new runtime, new pool, same database.
    const second = await startRuntime(url);
    const rebuilt = new PermissionService(second.store);

    await withTrustScope(SCOPE, async () => {
      expect(await second.store.list('trustWorkspaces')).toHaveLength(1);
      expect(
        (
          await rebuilt.evaluate(
            context(workspaceId, userId),
            'settlement:approve',
          )
        ).allowed,
      ).toBe(true);

      // Authorization still works against recovered state, not just the rows being present.
      const reauthorized = await enforcePermission(
        { ...context(workspaceId, userId), memberships: [] },
        { permissionKey: 'settlement:approve' },
        {
          memberships: new TrustStoreMembershipReader(second.store),
          permissions: rebuilt,
          store: second.store,
        },
      );
      expect(reauthorized.memberships).toEqual([workspaceId]);

      const audits = await second.store.list<AuditRecord>('auditRecords');
      expect(audits.length).toBeGreaterThan(0);
      expect(verifyAuditChain(audits).valid).toBe(true);
    });
  });

  it('keeps an identity durable across runtimes, so a session survives a deploy', async () => {
    const { url } = await isolatedDatabase();

    const first = await startRuntime(url);
    const registered = await withTrustScope(SCOPE, async () => {
      const identities = new IdentityService(first.store);
      const identity = await identities.register({
        email: 'owner@example.test',
        displayName: 'Owner',
        correlationId: 'corr-1',
      });
      await identities.activate(identity.id, 'corr-2');
      return identity;
    });
    await first.dispose();

    const second = await startRuntime(url);
    await withTrustScope(SCOPE, async () => {
      const recovered = new IdentityService(second.store);
      const login = await recovered.login({
        email: 'owner@example.test',
        rawSessionToken: 'raw-token',
        correlationId: 'corr-3',
      });

      expect(login.session.userId).toBe(registered.id);
      expect(
        verifyAuditChain(await second.store.list<AuditRecord>('auditRecords'))
          .valid,
      ).toBe(true);
    });
  });

  it('closes every connection on shutdown, and is idempotent about it', async () => {
    const { database, url } = await isolatedDatabase();
    const before = openSockets();
    const runtime = await startRuntime(url);
    await withTrustScope(SCOPE, () => runtime.store.list('parties'));
    expect(openSockets()).toBeGreaterThan(before);

    // Twice, because a shutdown handler can fire more than once and a second call must not
    // throw on a pool that is already closed.
    await runtime.dispose();
    await runtime.dispose();

    expect(runtime.getState()).toBe('disposed');
    await expectNoSocketLeak(before);
    await database.dispose();
  });
});

describe('integration: a development runtime is memory-backed and says so', () => {
  it('reports the memory adapter without touching a database', async () => {
    const runtime = await createPersistenceRuntime({
      config: loadPersistenceConfig({ ASSURAPAY_DEPLOYMENT: 'development' }),
    });
    disposables.push(() => runtime.dispose());

    expect(runtime.adapter).toBe('memory');
    expect((await runtime.checkReadiness()).ready).toBe(true);
    // Named, so nothing downstream can mistake it for durable storage.
    expect(runtime.config.deployment).toBe('development');
  });
});

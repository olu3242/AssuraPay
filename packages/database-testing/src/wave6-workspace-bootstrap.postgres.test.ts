import { afterAll, describe, expect, it } from 'vitest';
import {
  PostgresStoreError,
  PostgresTrustStore,
  applyMigrations,
  withTrustScope,
} from '@assurapay/database';
import { OrganizationService } from '@assurapay/organizations';
import type { SqlClient } from '@assurapay/database';
import { createTestDatabaseInstance, migrationsDirectory, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: a durable deployment can be founded, which it could not before.
 *
 * The test this suite exists for is `founds a tenant, its workspace and the owner membership`. Before Batch J
 * that sequence failed with `42501: new row violates row-level security policy for table "trust_tenants"`,
 * because `OrganizationService.createWorkspace` minted a fresh tenant per workspace and the store's on-demand
 * tenant insert therefore fell outside the caller's scope. Nothing called the method, so nothing had ever
 * found out — and since the only route that created a workspace was file-backed and refused in every durable
 * deployment class, 161 durable routes were individually correct and collectively unreachable.
 *
 * That claim can only be checked here. Against `InMemoryTrustStore` there is no policy to violate.
 *
 * See `docs/persistence/DOMAIN_STORE_RETIREMENT.md`.
 */

requireTestDatabaseUrl();

const TENANT = 'tenant-j';
const OTHER_TENANT = 'tenant-j-other';
const FOUNDER = 'user-founder';

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

/** One database per describe block — a database per test exhausts the connection allowance. */
function sharedDatabase(): () => Promise<TestDatabase> {
  let pending: Promise<TestDatabase> | undefined;
  return () => (pending ??= migratedDatabase());
}

function organizations(database: TestDatabase) {
  return new OrganizationService(new PostgresTrustStore(database.sql));
}

/** Raw SQL under a tenant scope. Every table below forces row-level security. */
function raw<T>(
  database: TestDatabase,
  work: (tx: SqlClient) => Promise<T>,
  tenantId: string = TENANT,
): Promise<T> {
  return database.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return await work(tx);
  });
}

function attempt<T>(work: Promise<T>): Promise<T | unknown> {
  return work.catch((caught: unknown) => caught);
}

const workspaceInput = (o: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  workspaceType: 'ORGANIZATION' as const,
  name: 'Founder Construction',
  slug: 'founder-construction',
  ownerUserId: FOUNDER,
  defaultCurrency: 'NGN',
  timezone: 'Africa/Lagos',
  countryCode: 'NG',
  correlationId: 'corr-founding',
  ...o,
});

describe('integration: founding a tenant on the durable store', () => {
  const seeded = sharedDatabase();

  it('founds a tenant, its workspace and the owner membership', async () => {
    const database = await seeded();
    // The scope the route enters: the tenant being founded. It is minted server-side and never supplied by
    // the caller, which is what makes entering it safe — the scope is empty by construction.
    const workspace = await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      organizations(database).createWorkspace(workspaceInput()),
    );

    expect(workspace.tenantId).toBe(TENANT);
    expect(workspace.status).toBe('ACTIVE');
    // `correlationId` identifies the request, not the workspace. `...input` had been spreading it onto the
    // persisted aggregate.
    expect(workspace).not.toHaveProperty('correlationId');

    const rows = await raw(database, (tx) =>
      tx<{ workspace_id: string; tenant_id: string }[]>`
        SELECT workspace_id, tenant_id FROM trust_workspaces
      `,
    );
    expect(rows).toEqual([{ workspace_id: workspace.id, tenant_id: TENANT }]);

    // The owner membership, without which the founder cannot activate a context and every subsequent route
    // denies them.
    const memberships = await raw(database, (tx) =>
      tx<{ user_id: string; status: string; role: string | null }[]>`
        SELECT user_id, status, role FROM trust_memberships WHERE workspace_id = ${workspace.id}
      `,
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ user_id: FOUNDER, status: 'ACTIVE' });
  }, 300_000);

  it('activates a context for the founder, and refuses one for anybody else', async () => {
    const database = await seeded();
    const service = organizations(database);
    const [workspace] = await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      service.listAuthorizedWorkspaces(FOUNDER),
    );
    // The whole point of founding: the sequence that was unreachable now completes, so the founder can enter
    // the workspace that every other route requires.
    const context = await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      service.activateContext(FOUNDER, workspace.id, 'session-1', 'IAL1_BASIC'),
    );
    expect(context).toMatchObject({ actorUserId: FOUNDER, tenantId: TENANT });
    expect(context.activeWorkspaceId).toBe(workspace.id);

    const refused = await withTrustScope({ tenantId: TENANT, actorId: 'user-stranger' }, () =>
      attempt(service.activateContext('user-stranger', workspace.id, 'session-2', 'IAL1_BASIC')),
    );
    expect(String(refused)).toContain('WORKSPACE_ACCESS_DENIED');
  }, 300_000);

  it('holds more than one workspace in one tenant', async () => {
    const database = await seeded();
    const second = await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      organizations(database).createWorkspace(
        workspaceInput({ name: 'Founder Civils', slug: 'founder-civils' }),
      ),
    );
    expect(second.tenantId).toBe(TENANT);
    // This is what the composite `(tenant_id, workspace_id)` keys every batch from A to I carries have always
    // assumed, and what a tenant minted per workspace made impossible.
    const count = await raw(database, (tx) =>
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM trust_workspaces WHERE tenant_id = ${TENANT}`,
    );
    expect(count[0].n).toBe(2);
  }, 300_000);
});

describe('integration: a workspace slug is unique within its tenant', () => {
  const seeded = sharedDatabase();

  it('refuses a duplicate slug in the same tenant, by index rather than by a read', async () => {
    const database = await seeded();
    await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      organizations(database).createWorkspace(workspaceInput()),
    );

    // Through the engine first: the caller gets a named error rather than a constraint.
    const refused = await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      attempt(organizations(database).createWorkspace(workspaceInput({ name: 'Another' }))),
    );
    expect(String(refused)).toContain('WORKSPACE_SLUG_EXISTS');

    // And by direct statement, which is the half that survives concurrency. The engine's check is a
    // read-then-write: two transactions both read an empty set and both proceed, and only the index refuses
    // the second. `202608110013` is that index, and it is on `payload->>'slug'` because `trust_workspaces`
    // keeps the slug in its payload — the only slug *column* is on the deprecated `workspaces` table, which
    // is why the rule had been enforced on the shape with no reader.
    const collision = await attempt(
      raw(database, (tx) =>
        tx`INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest, version)
           VALUES ('ws-collide', ${TENANT}, 'ACTIVE',
                   ${tx.json({ id: 'ws-collide', slug: 'founder-construction' } as never)}, 'digest', 1)`,
      ),
    );
    expect(String(collision)).toContain('trust_workspaces_tenant_slug_unique');
  }, 300_000);

  it('accepts the same slug in a different tenant', async () => {
    const database = await seeded();
    // Per tenant rather than global, deliberately. A global slug would tell one tenant that another holds a
    // name, and would let whichever tenant claimed it first hold it against every other tenant on the
    // deployment — the cross-tenant denial of service `202608110010` removed six instances of.
    const elsewhere = await withTrustScope({ tenantId: OTHER_TENANT, actorId: 'user-other' }, () =>
      organizations(database).createWorkspace(
        workspaceInput({ tenantId: OTHER_TENANT, ownerUserId: 'user-other' }),
      ),
    );
    expect(elsewhere.slug).toBe('founder-construction');
    expect(elsewhere.tenantId).toBe(OTHER_TENANT);
  }, 300_000);
});

describe('integration: an out-of-scope write is a scope error, not an outage', () => {
  const seeded = sharedDatabase();

  it('reports PERSISTENCE_SCOPE_INVALID when a policy refuses the row', async () => {
    const database = await seeded();
    // Naming a tenant the caller is not scoped to. This is the exact failure that made founding impossible,
    // and it used to arrive as `PERSISTENCE_UNAVAILABLE` — an outage, inviting a retry that can never
    // succeed, on the one defect that stopped a deployment starting.
    const refused = (await withTrustScope({ tenantId: TENANT, actorId: FOUNDER }, () =>
      attempt(
        organizations(database).createWorkspace(
          workspaceInput({ tenantId: 'tenant-not-mine', slug: 'elsewhere' }),
        ),
      ),
    )) as PostgresStoreError;

    expect(refused.code).toBe('PERSISTENCE_SCOPE_INVALID');
    expect(String(refused)).toContain('row-level security policy');
  }, 300_000);

  it('still reports a missing grant as unavailable', async () => {
    const database = await seeded();
    // The other half of SQLSTATE 42501, and the reason the split is on the message rather than the code: a
    // runtime role with no privilege on a table is a genuine operational fault, and an operator needs to see
    // it as one. `assurapay_app` holds no privilege on the deprecated compatibility tables — which
    // `certifySchemaOwnership` verifies — so this reaches the same SQLSTATE by the other route.
    const failure = await attempt(
      raw(database, (tx) => tx`SELECT set_config('role', 'assurapay_app', true)`.then(() => tx`
        SELECT 1 FROM workspace_memberships LIMIT 1
      `)),
    );
    // Either the role does not exist in this fixture or it is refused; what must not happen is a
    // policy-refusal message, which would mean the two faults had been conflated again.
    expect(String(failure)).not.toContain('row-level security policy');
  }, 300_000);
});

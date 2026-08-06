import { afterEach, describe, expect, it } from 'vitest';
import {
  PostgresTrustStore,
  payloadDigest,
  RLS_GOVERNED_TABLES,
  assertCrossTenantDenied,
  assertCrossTenantWriteDenied,
  assertUnscopedReadDenied,
  certifyRowLevelSecurity,
  readRlsState,
  withTrustScope,
} from '@assurapay/database';
import type { SqlClient } from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: Row Level Security, certified against a live instance.
 *
 * The defect being corrected was found here rather than by reading SQL. One hundred tables
 * carried `ENABLE ROW LEVEL SECURITY` and a policy requiring
 * `workspace_id = current_workspace_id()`. Inserting a membership, clearing
 * `app.workspace_id` and counting rows returned **one** — because `ENABLE` does not
 * constrain a table's owner and the application role owned every table. A policy that is
 * present but bypassed is worse than none, since it is read as protection.
 *
 * Every probe here therefore runs as a role that does *not* own the tables, which is the
 * shape a real application connection has.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const PROBE_ROLE = 'assurapay_app';

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b' };

/**
 * A schema with the RLS migration applied and two tenants' data in it.
 *
 * Seeded as the owner with `FORCE` temporarily lifted: the fixture's job is to create the
 * state the probes then fail to cross, and seeding through the policies would mean the setup
 * silently depended on the thing under test.
 */
async function seededDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
  databases.push(database);

  await withoutForcedRls(database.sql, async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await database.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenant.tenantId})`;
      const workspace = seeded({
        id: tenant.workspaceId,
        tenantId: tenant.tenantId,
        status: 'ACTIVE',
      });
      await database.sql`
        INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
        VALUES (${tenant.workspaceId}, ${tenant.tenantId}, 'ACTIVE', ${database.sql.json(workspace.record)}, ${workspace.digest})
      `;
      const membership = seeded({
        id: `membership-${tenant.tenantId}`,
        workspaceId: tenant.workspaceId,
        userId: 'user-1',
        status: 'ACTIVE',
      });
      await database.sql`
        INSERT INTO trust_memberships (membership_id, workspace_id, user_id, status, payload, payload_digest)
        VALUES (
          ${`membership-${tenant.tenantId}`}, ${tenant.workspaceId}, 'user-1', 'ACTIVE',
          ${database.sql.json(membership.record)}, ${membership.digest}
        )
      `;
      const grant = seeded({
        id: `grant-${tenant.tenantId}`,
        workspaceId: tenant.workspaceId,
        userId: 'user-1',
        permissionKey: 'settlement:approve',
        effect: 'ALLOW',
      });
      await database.sql`
        INSERT INTO trust_permission_grants (
          grant_id, workspace_id, user_id, permission_key, effect, scope_type,
          source_type, source_id, effective_from, payload, payload_digest
        ) VALUES (
          ${`grant-${tenant.tenantId}`}, ${tenant.workspaceId}, 'user-1', 'settlement:approve',
          'ALLOW', 'WORKSPACE', 'ROLE', 'OWNER', now(), ${database.sql.json(grant.record)}, ${grant.digest}
        )
      `;
      // One chain, two tenants. The chain is global by construction — position N+1 commits
      // to what position N said — so tenant B's record links to tenant A's. That is what
      // makes the RLS question interesting rather than trivial: the rows are interleaved in
      // one sequence and only the policy separates them.
      const position = tenant === TENANT_A ? 1 : 2;
      await database.sql`
        INSERT INTO trust_audit_records (
          audit_id, chain_position, tenant_id, workspace_id, actor_id, event_type,
          aggregate_type, aggregate_id, correlation_id, previous_hash, integrity_hash
        ) VALUES (
          ${`audit-${tenant.tenantId}`}, ${position}, ${tenant.tenantId},
          ${tenant.workspaceId}, 'user-1', 'Seeded', 'Thing', 'thing-1', 'corr-1',
          ${position === 1 ? null : `hash-${TENANT_A.tenantId}`},
          ${`hash-${tenant.tenantId}`}
        )
      `;
    }
  });

  return database;
}

/**
 * A payload and its real digest.
 *
 * The store verifies the digest on read, so a fixture writing an arbitrary string would fail with
 * PERSISTENCE_CORRUPT_RECORD — correctly, since that is the tamper check working. Seeding
 * has to produce records the store would itself have written.
 */
function seeded(record: Record<string, unknown>): { record: Record<string, unknown>; digest: string } {
  return { record, digest: payloadDigest(record) };
}

/** Lifts FORCE for the duration of a fixture, then restores it. */
async function withoutForcedRls(sql: SqlClient, operation: () => Promise<void>): Promise<void> {
  for (const table of RLS_GOVERNED_TABLES)
    await sql.unsafe(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
  try {
    await operation();
  } finally {
    for (const table of RLS_GOVERNED_TABLES)
      await sql.unsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  }
}

const probeContext = { role: PROBE_ROLE, ...TENANT_A, actorId: 'user-1' };

describe('integration: the policies are actually in force', () => {
  it('enables and forces row-level security on every governed table', async () => {
    // `FORCE` is the whole difference between a policy that protects and one that reads as
    // protection. Without it the owner — and any connection using the owning credential —
    // sees everything.
    const database = await seededDatabase();
    const { flags, policies } = await readRlsState(database.sql, database.schema);

    for (const table of RLS_GOVERNED_TABLES) {
      expect(flags.get(table)?.enabled, `${table} enabled`).toBe(true);
      expect(flags.get(table)?.forced, `${table} forced`).toBe(true);
      expect((policies.get(table) ?? []).length, `${table} policies`).toBeGreaterThan(0);
    }
  });

  it('subjects even the table owner to its own policies', async () => {
    // The original defect, asserted directly. The owner, with no scope set, must now see
    // nothing — where before this capability it saw every row.
    const database = await seededDatabase();

    await database.sql`SELECT set_config('app.tenant_id', '', false)`;
    const [visible] = await database.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trust_workspaces
    `;
    expect(visible.n).toBe('0');
  });

  it('certifies clean, through the same module a deployment gate would call', async () => {
    const database = await seededDatabase();
    const certification = await certifyRowLevelSecurity(database.sql, {
      schema: database.schema,
      probe: { context: probeContext, foreign: TENANT_B },
    });

    expect(certification.findings).toEqual([]);
    expect(certification.certified).toBe(true);
    expect(certification.checkedTables.sort()).toEqual([...RLS_GOVERNED_TABLES].sort());
  });
});

describe('integration: a tenant cannot read across the boundary', () => {
  it('denies every cross-tenant read while permitting the caller’s own', async () => {
    const database = await seededDatabase();
    expect(await assertCrossTenantDenied(database.sql, probeContext, TENANT_B)).toEqual([]);
  });

  it('denies a cross-tenant write, not only a read', async () => {
    // `USING` and `WITH CHECK` are different clauses. A policy with only `USING` hides other
    // tenants' rows while letting a caller *insert* into their scope — worse than a read
    // leak, because it plants data the owning tenant cannot see the origin of.
    const database = await seededDatabase();
    expect(await assertCrossTenantWriteDenied(database.sql, probeContext, TENANT_B)).toEqual([]);
  });

  it('denies everything to a caller with no scope at all', async () => {
    // The state a connection is in before anything sets it, and therefore the state a bug
    // leaves it in.
    const database = await seededDatabase();
    expect(await assertUnscopedReadDenied(database.sql, PROBE_ROLE)).toEqual([]);
  });

  it('reports a finding when a policy is dropped, rather than certifying anyway', async () => {
    // A certification that cannot fail is not evidence. This removes a real policy and
    // expects the module to say so.
    const database = await seededDatabase();
    await database.sql.unsafe(
      'DROP POLICY trust_permission_grants_tenant_scope ON trust_permission_grants',
    );

    const certification = await certifyRowLevelSecurity(database.sql, {
      schema: database.schema,
      probe: { context: probeContext, foreign: TENANT_B },
    });

    expect(certification.certified).toBe(false);
    expect(certification.findings.map((finding) => finding.code)).toContain('RLS_NO_POLICY');
  });

  it('reports a finding when FORCE is lifted, which is the original defect', async () => {
    const database = await seededDatabase();
    await database.sql.unsafe('ALTER TABLE trust_workspaces NO FORCE ROW LEVEL SECURITY');

    const certification = await certifyRowLevelSecurity(database.sql, { schema: database.schema });

    expect(certification.certified).toBe(false);
    const finding = certification.findings.find((entry) => entry.code === 'RLS_NOT_FORCED');
    expect(finding?.table).toBe('trust_workspaces');
    expect(finding?.detail).toContain('owner bypasses');
  });
});

describe('integration: the store carries scope, so the application still works', () => {
  it('reads its own tenant’s records through the ambient scope', async () => {
    // Forced RLS without scope propagation would deny everything and break the application.
    // The store sets the session variables from the ambient scope the composition root
    // establishes.
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);

    const workspaces = await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: 'user-1' },
      () => store.list<{ id: string }>('trustWorkspaces'),
    );

    expect(workspaces).toHaveLength(1);
  });

  it('cannot see the other tenant’s records from within a scope', async () => {
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);

    const grants = await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: 'user-1' },
      () => store.list<{ workspaceId: string }>('permissionGrants'),
    );

    expect(grants).toHaveLength(1);
    expect(grants[0].workspaceId).toBe(TENANT_A.workspaceId);
  });

  it('reads nothing outside a scope, rather than everything', async () => {
    // The honest failure mode of ambient scope. A path that forgets to establish one gets
    // no rows — not another tenant's.
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);

    // Owner connection, so this is FORCE doing the work rather than a role grant.
    expect(await store.list('trustWorkspaces')).toEqual([]);
  });

  it('does not leak scope onto the next operation through a pooled connection', async () => {
    // `set_config(..., true)` is transaction-local. A global set would leave tenant A's
    // scope on the connection for whatever request it served next — a cross-tenant read with
    // no bug in any policy.
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);

    await withTrustScope({ tenantId: TENANT_A.tenantId, actorId: 'user-1' }, () =>
      store.list('trustWorkspaces'),
    );

    const [leaked] = await database.sql<{ tenant: string | null }[]>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant
    `;
    expect(leaked.tenant).toBeNull();
  });

  it('scopes a whole transaction once, and the writes inside it', async () => {
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);

    await withTrustScope(
      { tenantId: TENANT_A.tenantId, workspaceId: TENANT_A.workspaceId, actorId: 'user-1' },
      () =>
        store.transaction(async (tx) => {
          await tx.append('parties', {
            id: 'party-1',
            tenantId: TENANT_A.tenantId,
            workspaceId: TENANT_A.workspaceId,
            name: 'Acme',
          });
          expect(await tx.list('parties')).toHaveLength(1);
        }),
    );

    const recovered = await withTrustScope({ tenantId: TENANT_A.tenantId }, () =>
      store.list<{ id: string }>('parties'),
    );
    expect(recovered.map((party) => party.id)).toEqual(['party-1']);
  });

  it('refuses a write attributed to another tenant, from inside a legitimate scope', async () => {
    // The policy's WITH CHECK, reached through the store rather than through raw SQL.
    const database = await seededDatabase();
    const store = new PostgresTrustStore(database.sql);

    await expect(
      withTrustScope({ tenantId: TENANT_A.tenantId, actorId: 'user-1' }, () =>
        store.append('parties', {
          id: 'planted',
          tenantId: TENANT_B.tenantId,
          workspaceId: TENANT_B.workspaceId,
          name: 'Planted',
        }),
      ),
    ).rejects.toThrow();
  });
});

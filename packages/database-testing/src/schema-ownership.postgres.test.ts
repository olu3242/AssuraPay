import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRecord } from '@assurapay/shared';
import {
  COMPATIBILITY_OBJECTS,
  PostgresTrustStore,
  RETIRED_TRUST_HISTORICAL_TABLES,
  applyMigrations,
  canonicalTables,
  certifyRowLevelSecurity,
  certifySchemaOwnership,
  readMigrations,
  verifySchemaCompatibility,
  withTrustScope,
} from '@assurapay/database';
import type { SqlClient } from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from './index';
import type { TestDatabase } from './index';

/**
 * integration: schema ownership, certified against a live instance.
 *
 * Two databases have to reach the same canonical state by different routes, and this suite is
 * both. A fresh database applies every migration including reconciliation. An existing one
 * applies migrations *through the RLS baseline*, is then seeded as a real deployment would
 * have been, and only then receives reconciliation — which is the path every already-running
 * database will take, and the only one that can show the retirement is safe rather than
 * merely that a fresh install looks tidy.
 *
 * The refusal test is the one that matters most. This capability retires tables on the
 * evidence that nothing has ever written them; if that evidence does not hold for some
 * database, the migration must stop rather than reconcile it into silence.
 *
 * These use `createTestDatabaseInstance` — a whole database rather than a schema — because the
 * historical migrations are not schema-relocatable: one defines a `SECURITY DEFINER` function
 * with `SET search_path=public`, whose body PostgreSQL compiles at creation time against that
 * path.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function freshDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  return database;
}

/** Applies every migration up to but excluding reconciliation — the pre-reconciliation state. */
async function applyThroughRlsBaseline(sql: SqlClient): Promise<void> {
  const migrations = readMigrations(migrationsDirectory()).filter(
    (migration) => !migration.id.startsWith('202608080001'),
  );
  await sql.begin(async (tx) => {
    await tx`
      CREATE TABLE IF NOT EXISTS trust_migration_ledger (
        migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_by TEXT NOT NULL,
        execution_ms INTEGER NOT NULL, ordinal INTEGER NOT NULL
      )`;
    for (const migration of migrations) {
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
        VALUES (${migration.id}, ${migration.checksum}, 'upgrade-rehearsal', 0, ${migration.ordinal})
        ON CONFLICT (migration_id) DO NOTHING`;
    }
  });
}

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'workspace-a', actorId: 'user-a' };

/** Writes real trust state through the canonical store, inside a tenant scope. */
async function seedCanonicalTrustState(sql: SqlClient): Promise<void> {
  const store = new PostgresTrustStore(sql);
  await withTrustScope(SCOPE, async () => {
    await store.append('trustWorkspaces', {
      id: SCOPE.workspaceId,
      tenantId: SCOPE.tenantId,
      name: 'Workspace A',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      version: 1,
    });
    await store.audit({
      tenantId: SCOPE.tenantId,
      workspaceId: SCOPE.workspaceId,
      actorId: SCOPE.actorId,
      // A permission key, which is exactly what the historical `audit_records.aggregate_id`
      // UUID column could not hold. The conflict is in the fixture on purpose.
      eventType: 'PermissionGranted',
      aggregateType: 'PermissionGrant',
      aggregateId: 'settlement:approve',
      correlationId: 'corr-1',
      metadata: {},
    });
  });
}

describe('integration: a fresh database reaches canonical ownership', () => {
  it('applies every migration and certifies ownership with no findings', async () => {
    const database = await freshDatabase();
    const outcomes = await applyMigrations(database.sql, migrationsDirectory(), {
      appliedBy: 'integration-test',
    });
    expect(outcomes.filter((outcome) => outcome.applied)).toHaveLength(outcomes.length);

    const certification = await certifySchemaOwnership(database.sql, { schema: 'public' });
    expect(certification.findings).toEqual([]);
    expect(certification.certified).toBe(true);
    expect(certification.observed).toEqual({
      canonicalPresent: canonicalTables().length,
      retiredPresent: 0,
      compatibilityPresent: COMPATIBILITY_OBJECTS.length,
    });
  }, 240_000);

  it('leaves no retired table behind, and keeps every retained one', async () => {
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    const rows = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const present = new Set(rows.map((row) => row.table_name));

    expect(RETIRED_TRUST_HISTORICAL_TABLES.filter((table) => present.has(table))).toEqual([]);
    for (const entry of COMPATIBILITY_OBJECTS) expect(present.has(entry.table)).toBe(true);
  }, 240_000);

  it('records the reconciliation as a required migration, so a host cannot start without it', async () => {
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    const compatibility = await verifySchemaCompatibility(database.sql, migrationsDirectory());
    expect(compatibility.pendingRequired).toEqual([]);
    expect(compatibility.compatible).toBe(true);
  }, 240_000);

  it('marks every retained object as deprecated in the database itself', async () => {
    // A reader with a psql prompt and no access to this repository is the audience. A table
    // that looks canonical and is not is how the duplicate model got used in the first place.
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    for (const entry of COMPATIBILITY_OBJECTS) {
      const [comment] = await database.sql<{ description: string | null }[]>`
        SELECT obj_description(${`public.${entry.table}`}::regclass, 'pg_class') AS description
      `;
      expect(comment.description ?? '').toContain('DEPRECATED');
      expect(comment.description ?? '').toContain(entry.retirementCondition);
    }
  }, 240_000);
});

describe('integration: an existing database upgrades safely', () => {
  it('reaches the same canonical state as a fresh one, with trust data intact', async () => {
    const database = await freshDatabase();
    await applyThroughRlsBaseline(database.sql);
    await seedCanonicalTrustState(database.sql);

    const before = await withTrustScope(SCOPE, () =>
      new PostgresTrustStore(database.sql).list<{ id: string }>('trustWorkspaces'),
    );
    expect(before.map((entry) => entry.id)).toEqual([SCOPE.workspaceId]);

    const outcomes = await applyMigrations(database.sql, migrationsDirectory(), {
      appliedBy: 'integration-test',
    });
    // Only reconciliation is new; everything else is already in the ledger.
    expect(outcomes.filter((outcome) => outcome.applied).map((outcome) => outcome.id)).toEqual([
      '202608080001_trust_schema_ownership_reconciliation',
    ]);

    const certification = await certifySchemaOwnership(database.sql, { schema: 'public' });
    expect(certification.findings).toEqual([]);

    const after = await withTrustScope(SCOPE, () =>
      new PostgresTrustStore(database.sql).list<{ id: string }>('trustWorkspaces'),
    );
    expect(after.map((entry) => entry.id)).toEqual([SCOPE.workspaceId]);
  }, 240_000);

  it('keeps the audit chain verifiable across the upgrade, non-UUID identifier and all', async () => {
    // The identifier that could not be stored in the historical model is still there, still
    // hashed, still chained, after the model that could not hold it is gone.
    const database = await freshDatabase();
    await applyThroughRlsBaseline(database.sql);
    await seedCanonicalTrustState(database.sql);

    const store = new PostgresTrustStore(database.sql);
    const before = await withTrustScope(SCOPE, () => store.list<AuditRecord>('auditRecords'));
    expect(before).toHaveLength(1);
    expect(before[0].aggregateId).toBe('settlement:approve');

    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    const after = await withTrustScope(SCOPE, () => store.list<AuditRecord>('auditRecords'));
    expect(after).toHaveLength(1);
    expect(after[0].integrityHash).toBe(before[0].integrityHash);

    // And the chain still extends, which a retirement that disturbed the tail would break.
    await withTrustScope(SCOPE, () =>
      store.audit({
        tenantId: SCOPE.tenantId,
        workspaceId: SCOPE.workspaceId,
        actorId: SCOPE.actorId,
        eventType: 'PermissionRevoked',
        aggregateType: 'PermissionGrant',
        aggregateId: 'settlement:approve',
        correlationId: 'corr-2',
        metadata: {},
      }),
    );
    const extended = await withTrustScope(SCOPE, () => store.list<AuditRecord>('auditRecords'));
    expect(extended).toHaveLength(2);
    expect(extended[1].previousHash).toBe(extended[0].integrityHash);
  }, 240_000);

  it('refuses, without dropping anything, when a historical table holds rows', async () => {
    // The whole safety argument for retirement. "These tables are empty" is a claim about
    // every database that will ever apply this migration, and a migration that assumed it and
    // was wrong would destroy data in silence.
    const database = await freshDatabase();
    await applyThroughRlsBaseline(database.sql);
    await database.sql`
      INSERT INTO permission_definitions
        (permission_key, object_key, action, description, risk_level, status)
      VALUES ('settlement:approve', 'settlement', 'approve', 'seeded', 'HIGH', 'ACTIVE')
    `;

    await expect(
      applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' }),
    ).rejects.toThrow(/TRUST_SCHEMA_RECONCILIATION_REFUSED/);

    // Nothing dropped, nothing lost: the refusal happens before any DROP, inside the
    // migration runner's single transaction.
    const rows = await database.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM permission_definitions
    `;
    expect(rows[0].n).toBe(1);
    const present = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${[...RETIRED_TRUST_HISTORICAL_TABLES]})
    `;
    expect(present).toHaveLength(RETIRED_TRUST_HISTORICAL_TABLES.length);
  }, 240_000);

  it('names the offending table and its row count in the refusal', async () => {
    // An operator reading this in a deployment log has to know what to look at.
    const database = await freshDatabase();
    await applyThroughRlsBaseline(database.sql);
    await database.sql`
      INSERT INTO permission_definitions
        (permission_key, object_key, action, description, risk_level, status)
      VALUES ('settlement:approve', 'settlement', 'approve', 'seeded', 'HIGH', 'ACTIVE')
    `;

    let message = '';
    try {
      await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
    }

    expect(message).toContain('permission_definitions=1');
    expect(message).toContain('Nothing has been dropped');
  }, 240_000);
});

describe('integration: reconciliation does not weaken the certified boundary', () => {
  it('leaves row-level security certified on the canonical tables', async () => {
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    const certification = await certifyRowLevelSecurity(database.sql, { schema: 'public' });
    expect(certification.findings).toEqual([]);
  }, 240_000);

  it('reports a retired table that came back, rather than certifying anyway', async () => {
    // A certification that cannot fail is not evidence. Recreating one is the realistic
    // regression: a future migration, or an operator restoring an old dump.
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
    await database.sql.unsafe('CREATE TABLE audit_records (id UUID PRIMARY KEY)');

    const certification = await certifySchemaOwnership(database.sql, { schema: 'public' });
    expect(certification.certified).toBe(false);
    const finding = certification.findings.find(
      (entry) => entry.code === 'OWNERSHIP_RETIRED_TABLE_PRESENT',
    );
    expect(finding?.table).toBe('audit_records');
  }, 240_000);

  it('reports a canonical table whose FORCE was lifted', async () => {
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
    await database.sql.unsafe('ALTER TABLE trust_workspaces NO FORCE ROW LEVEL SECURITY');

    const certification = await certifySchemaOwnership(database.sql, { schema: 'public' });
    expect(certification.findings.map((entry) => entry.code)).toContain(
      'OWNERSHIP_CANONICAL_RLS_NOT_FORCED',
    );
  }, 240_000);

  it('reports a deprecated table the runtime role can write', async () => {
    // The dual-write path this capability exists to close. Granting it is how it would
    // reappear, so the certification has to notice.
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    const role = `probe_owner_${Date.now().toString(36)}`;
    await database.sql.unsafe(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await database.sql.unsafe(`GRANT INSERT ON workspaces TO "${role}"`);
      const certification = await certifySchemaOwnership(database.sql, {
        schema: 'public',
        runtimeRole: role,
      });
      const finding = certification.findings.find(
        (entry) => entry.code === 'OWNERSHIP_DEPRECATED_TABLE_WRITABLE',
      );
      expect(finding?.table).toBe('workspaces');
      expect(finding?.detail).toContain('INSERT');
    } finally {
      // Revoking the one grant is what makes the role droppable: a role cannot be dropped
      // while a privilege depends on it, and `DROP OWNED BY` would need membership this
      // connection deliberately does not hold.
      await database.sql.unsafe(`REVOKE ALL ON workspaces FROM "${role}"`);
      await database.sql.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  }, 240_000);

  it('grants the runtime role nothing on any deprecated object', async () => {
    // The positive form of the same property, against the role a deployment actually uses.
    const database = await freshDatabase();
    await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });

    const deprecated = [
      ...RETIRED_TRUST_HISTORICAL_TABLES,
      ...COMPATIBILITY_OBJECTS.map((entry) => entry.table),
    ];
    const grants = await database.sql<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'assurapay_app' AND table_schema = 'public'
        AND table_name = ANY(${deprecated})
    `;
    expect(grants).toEqual([]);
  }, 240_000);
});

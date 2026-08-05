import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRecord, TrustPersistence } from '@assurapay/shared';
import { auditIntegrityHash } from '@assurapay/shared';
import { PostgresTrustStore, PostgresStoreError } from '@assurapay/database';
import { TRUST_PERSISTENCE_CONFORMANCE, runTrustPersistenceConformance } from '@assurapay/database';
import type { ConformanceCollections } from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';
import { checkConnectivity } from '@assurapay/database';

/**
 * integration: the durable store, against a real PostgreSQL instance.
 *
 * Nothing here is mocked. There is no in-memory fallback and no skip: without
 * `ASSURAPAY_TEST_DATABASE_URL` the suite fails, because a green run that never
 * reached a database is not evidence that anything is durable.
 *
 * The conformance checks are the same module `InMemoryTrustStore` runs, imported
 * rather than restated, so the two implementations are held to one standard.
 */

// Fails loudly at collection time when no database is configured.
requireTestDatabaseUrl();

const databases: TestDatabase[] = [];

async function freshDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  databases.push(database);
  return database;
}

afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const workspaceContext = { tenantId: 'tenant-1', workspaceId: 'workspace-1' };

/**
 * Collections the shared checks write to when the store is PostgreSQL.
 *
 * Real mapped collections, because the adapter refuses a name it has no table for —
 * which is the behaviour under test elsewhere, not a limitation to work around here.
 * `absent` names a collection the store maps but nothing in a check ever writes to.
 */
const POSTGRES_CONFORMANCE_COLLECTIONS: ConformanceCollections = {
  primary: 'parties',
  secondary: 'sessions',
  tertiary: 'devices',
  absent: 'consents',
};

async function seedWorkspace(store: TrustPersistence, overrides: Partial<Record<string, string>> = {}) {
  const workspaceId = overrides.workspaceId ?? workspaceContext.workspaceId;
  const tenantId = overrides.tenantId ?? workspaceContext.tenantId;
  await store.append('trustWorkspaces', {
    id: workspaceId,
    tenantId,
    name: 'Workspace',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    version: 1,
  });
  return { workspaceId, tenantId };
}

function auditInput(overrides: Partial<AuditRecord> = {}) {
  return {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    actorId: 'user-1',
    eventType: 'ThingHappened',
    aggregateType: 'Thing',
    aggregateId: 'thing-1',
    correlationId: 'corr-1',
    metadata: {} as Record<string, unknown>,
    ...overrides,
  };
}

describe('integration: the database really is PostgreSQL', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await freshDatabase();
  });

  it('reports a PostgreSQL server version, so the adapter is not talking to a stand-in', async () => {
    const connectivity = await checkConnectivity(database.sql);
    expect(connectivity.reachable).toBe(true);
    expect(connectivity.serverVersion).toContain('PostgreSQL');
  });

  it('created the tables the store requires through the migration runner', async () => {
    const rows = await database.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${database.schema} ORDER BY table_name
    `;
    const names = rows.map((row) => row.table_name);
    for (const table of [
      'trust_audit_records',
      'trust_memberships',
      'trust_outbox_events',
      'trust_permission_grants',
      'trust_records',
      'trust_tenants',
      'trust_workspaces',
    ])
      expect(names, table).toContain(table);
  });

  it('enforces its constraints in the database, not only in the adapter', async () => {
    // Asserted through raw SQL rather than the store: a constraint that only the
    // adapter checks is absent for anything else with a connection.
    const constraints = await database.sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE connamespace = ${database.schema}::regnamespace AND contype IN ('c', 'f', 'u')
    `;
    expect(constraints.length).toBeGreaterThan(10);
  });
});

describe('integration: TrustPersistence conformance — PostgresTrustStore', () => {
  // The same checks the in-memory store passes, each against its own schema so no
  // check can observe another's writes.
  for (const check of TRUST_PERSISTENCE_CONFORMANCE) {
    it(check.name, async () => {
      const database = await createTestDatabase();
      try {
        await check.run(new PostgresTrustStore(database.sql), POSTGRES_CONFORMANCE_COLLECTIONS);
      } finally {
        await database.dispose();
      }
    });
  }

  it('passes every check when run through the shared runner', async () => {
    const created: TestDatabase[] = [];
    const results = await runTrustPersistenceConformance({
      collections: POSTGRES_CONFORMANCE_COLLECTIONS,
      async create() {
        const database = await createTestDatabase();
        created.push(database);
        return new PostgresTrustStore(database.sql);
      },
      async dispose() {
        const database = created.pop();
        if (database) await database.dispose();
      },
    });

    expect(results.filter((result) => !result.passed)).toEqual([]);
  });
});

describe('integration: durability survives losing the process', () => {
  it('recovers workspace, membership, grants and audit through a second pool', async () => {
    // The point of the test: one store's writes must be visible to a different store
    // on a different connection pool after the first is disposed. Anything that holds
    // state in the object graph passes every single-instance test and fails this one.
    const databaseUrl = requireTestDatabaseUrl();
    const database = await freshDatabase();

    const first = new PostgresTrustStore(database.sql);
    await seedWorkspace(first);
    await first.append('memberships', {
      id: 'membership-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      status: 'ACTIVE',
      role: 'OWNER',
      createdAt: new Date().toISOString(),
      version: 1,
    });
    await first.append('permissionGrants', {
      id: 'grant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      permissionKey: 'settlement:approve',
      effect: 'ALLOW',
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE',
      sourceId: 'OWNER',
      effectiveFrom: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    await first.audit(auditInput({ eventType: 'WorkspaceFounded' }));

    // A wholly separate pool against the same schema.
    const { createPostgresPool } = await import('@assurapay/database');
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    const secondPool = createPostgresPool({ databaseUrl: url.toString(), max: 2 });
    try {
      const second = new PostgresTrustStore(secondPool.sql);

      expect(await second.list('trustWorkspaces')).toHaveLength(1);
      const memberships = await second.list<{ userId: string; status: string }>('memberships');
      expect(memberships).toEqual([expect.objectContaining({ userId: 'user-1', status: 'ACTIVE' })]);
      const grants = await second.list<{ permissionKey: string }>('permissionGrants');
      expect(grants.map((grant) => grant.permissionKey)).toEqual(['settlement:approve']);

      const audits = await second.list<AuditRecord>('auditRecords');
      expect(audits).toHaveLength(1);
      expect(chainIsValid(audits)).toBe(true);
    } finally {
      await secondPool.dispose();
    }
  });

  it('leaves no open handle once the pool is disposed', async () => {
    // Measured as a delta rather than an absolute count: other suites in this file
    // hold their own pools until `afterAll`, and asserting zero process-wide would
    // pass or fail on test ordering rather than on whether this pool was released.
    const sockets = () =>
      process.getActiveResourcesInfo().filter((kind) => kind.startsWith('TCP')).length;

    const before = sockets();
    const database = await createTestDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);
    expect(sockets(), 'a live pool holds at least one socket').toBeGreaterThan(before);

    await database.dispose();
    expect(sockets()).toBe(before);
  });
});

describe('integration: transactions are real', () => {
  it('commits every write when the operation resolves', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    await store.transaction(async (tx) => {
      await tx.append('permissionGrants', grantFixture('grant-commit'));
      await tx.audit(auditInput({ eventType: 'GrantIssued' }));
    });

    expect(await store.list('permissionGrants')).toHaveLength(1);
    expect(await store.list('auditRecords')).toHaveLength(1);
  });

  it('rolls back the mutation and its audit together when the operation throws', async () => {
    // Mutation and audit are coupled: a committed grant with no audit record is an
    // unexplained authority change, and an audit record for a grant that does not
    // exist is a false history.
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    await expect(
      store.transaction(async (tx) => {
        await tx.append('permissionGrants', grantFixture('grant-rollback'));
        await tx.audit(auditInput({ eventType: 'GrantIssued' }));
        throw new Error('DOMAIN_REJECTED');
      }),
    ).rejects.toThrow();

    expect(await store.list('permissionGrants')).toEqual([]);
    expect(await store.list('auditRecords')).toEqual([]);
  });

  it('rolls back on a rejected promise as well as a thrown error', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    await expect(
      store.transaction(async (tx) => {
        await tx.append('permissionGrants', grantFixture('grant-reject'));
        return Promise.reject(new Error('REJECTED'));
      }),
    ).rejects.toThrow();

    expect(await store.list('permissionGrants')).toEqual([]);
  });

  it('joins a nested transaction to the outer one rather than opening a savepoint', async () => {
    // A savepoint would let the inner rollback report success while the outer
    // transaction committed the rest — a partially applied transaction, described as
    // undone.
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    await expect(
      store.transaction(async (outer) => {
        await outer.append('permissionGrants', grantFixture('grant-outer'));
        await outer.transaction(async (inner) => {
          await inner.append('permissionGrants', grantFixture('grant-inner'));
        });
        throw new Error('OUTER_FAILED');
      }),
    ).rejects.toThrow();

    // Neither survives: the inner writes belonged to the outer transaction.
    expect(await store.list('permissionGrants')).toEqual([]);
  });

  it('makes a write invisible outside the transaction until it commits', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    await store.transaction(async (tx) => {
      await tx.append('permissionGrants', grantFixture('grant-isolated'));
      // Read through the outer store, on a different connection.
      expect(await store.list('permissionGrants')).toEqual([]);
      expect(await tx.list('permissionGrants')).toHaveLength(1);
    });

    expect(await store.list('permissionGrants')).toHaveLength(1);
  });
});

describe('integration: the audit chain holds under concurrency and tampering', () => {
  it('appends a fork-free chain when writers are concurrent', async () => {
    // The in-memory store avoided interleaving by serialising callers. A database has
    // genuinely concurrent writers and cannot; the lock in `audit` is what makes the
    // chain single-threaded at the point it matters.
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        store.audit(auditInput({ eventType: `Event${index}` })),
      ),
    );

    const records = await store.list<AuditRecord>('auditRecords');
    expect(records).toHaveLength(12);

    // One predecessor claimed once: a fork shows up as a duplicate previousHash.
    const predecessors = records.map((record) => record.previousHash).filter(Boolean);
    expect(new Set(predecessors).size).toBe(predecessors.length);
    expect(chainIsValid(records)).toBe(true);
  });

  it('refuses an update or delete on history at the database level', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    const record = await store.audit(auditInput());

    await expect(
      database.sql`UPDATE trust_audit_records SET event_type = 'Rewritten' WHERE audit_id = ${record.id}`,
    ).rejects.toThrow(/append-only|APPEND_ONLY/i);
    await expect(
      database.sql`DELETE FROM trust_audit_records WHERE audit_id = ${record.id}`,
    ).rejects.toThrow(/append-only|APPEND_ONLY/i);
  });

  it('detects a tampered record after reconnecting', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await store.audit(auditInput({ eventType: 'First' }));
    await store.audit(auditInput({ eventType: 'Second' }));

    expect(chainIsValid(await store.list<AuditRecord>('auditRecords'))).toBe(true);

    // The append-only trigger blocks UPDATE, so tampering has to go around it — which
    // is exactly what an attacker with database access would do. Disabling the trigger
    // is the realistic threat model, and verification must still catch the edit.
    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records DISABLE TRIGGER trust_audit_records_append_only',
    );
    await database.sql`
      UPDATE trust_audit_records SET metadata = ${database.sql.json({ tampered: true })}
      WHERE chain_position = 1
    `;
    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records ENABLE TRIGGER trust_audit_records_append_only',
    );

    expect(chainIsValid(await store.list<AuditRecord>('auditRecords'))).toBe(false);
  });
});

describe('integration: tenancy and scope cannot be crossed', () => {
  it('refuses a workspace whose tenant does not exist as a relationship', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await expect(
      store.append('trustWorkspaces', {
        id: 'workspace-untenanted',
        name: 'No tenant',
        status: 'ACTIVE',
      }),
    ).rejects.toThrow('PERSISTENCE_SCOPE_INVALID');
  });

  it('refuses a membership in a workspace that does not exist', async () => {
    // The foreign key is what makes an accidental cross-tenant membership unstorable
    // rather than merely unlikely.
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await expect(
      store.append('memberships', {
        id: 'membership-orphan',
        workspaceId: 'workspace-missing',
        userId: 'user-1',
        status: 'ACTIVE',
      }),
    ).rejects.toThrow('PERSISTENCE_SCOPE_INVALID');
  });

  it('refuses a grant in a workspace that does not exist', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await expect(store.append('permissionGrants', grantFixture('grant-orphan'))).rejects.toThrow(
      'PERSISTENCE_SCOPE_INVALID',
    );
  });

  it('keeps two tenants’ workspaces distinguishable by their tenant column', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store, { workspaceId: 'workspace-a', tenantId: 'tenant-a' });
    await seedWorkspace(store, { workspaceId: 'workspace-b', tenantId: 'tenant-b' });

    const rows = await database.sql<{ workspace_id: string; tenant_id: string }[]>`
      SELECT workspace_id, tenant_id FROM trust_workspaces ORDER BY workspace_id
    `;
    expect(rows).toEqual([
      { workspace_id: 'workspace-a', tenant_id: 'tenant-a' },
      { workspace_id: 'workspace-b', tenant_id: 'tenant-b' },
    ]);
  });
});

describe('integration: concurrency produces one winner', () => {
  it('allows exactly one active membership per principal and workspace', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_unused, index) =>
        store.append('memberships', {
          id: `membership-${index}`,
          workspaceId: 'workspace-1',
          userId: 'user-1',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(await store.list('memberships')).toHaveLength(1);
  });

  it('allows exactly one bootstrap per workspace', async () => {
    // A preceding "are there any grants" read cannot establish this under concurrency.
    // A primary key can.
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        database.sql`
          INSERT INTO trust_bootstrap_state (workspace_id, founder_user_id, role, grant_count, correlation_id)
          VALUES ('workspace-1', 'user-1', 'OWNER', 3, 'corr-1')
        `,
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects the identical grant twice while allowing the same key at another scope', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await seedWorkspace(store);

    await store.append('permissionGrants', grantFixture('grant-1'));
    await expect(store.append('permissionGrants', grantFixture('grant-2'))).rejects.toThrow(
      'PERSISTENCE_DUPLICATE_RECORD',
    );

    // Same permission, different scope: legitimate, and must still be storable.
    await store.append('permissionGrants', {
      ...grantFixture('grant-3'),
      scopeId: 'contract-9',
    });
    expect(await store.list('permissionGrants')).toHaveLength(2);
  });

  it('makes an idempotency key durably unique', async () => {
    const database = await freshDatabase();
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        database.sql`
          INSERT INTO trust_idempotency_keys (scope, idempotency_key, result_digest)
          VALUES ('release', 'key-1', 'digest')
        `,
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('integration: failures are reported, never swallowed', () => {
  it('refuses a collection it has no mapping for', async () => {
    // The alternative — accepting it — writes authorization-relevant state somewhere
    // nothing reads, which is indistinguishable from losing it.
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await expect(store.append('releaseRequests', { id: 'release-1' })).rejects.toThrow(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
    );
  });

  it('refuses a record with no id rather than generating one', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await expect(store.append('parties', { name: 'No id' })).rejects.toThrow(
      'PERSISTENCE_RECORD_ID_REQUIRED',
    );
  });

  it('refuses to create through replace, because a state transition needs a prior state', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await expect(store.replace('parties', { id: 'party-missing' })).rejects.toThrow(
      'PERSISTENCE_RECORD_NOT_FOUND',
    );
  });

  it('reports an unavailable database instead of returning an empty result', async () => {
    // The failure mode that matters most: an empty list from a broken connection reads
    // as "no grants", and deny-by-default then turns an outage into a silent
    // authorization change.
    const database = await createTestDatabase();
    const store = new PostgresTrustStore(database.sql);
    await database.dispose();

    await expect(store.list('parties')).rejects.toBeInstanceOf(PostgresStoreError);
  });

  it('never puts a connection string in an error message', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    const error = await store
      .append('memberships', { id: 'm', workspaceId: 'missing', userId: 'u', status: 'ACTIVE' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PostgresStoreError);
    expect(String(error)).not.toMatch(/postgres:\/\//);
    expect(String(error)).not.toMatch(/password/i);
  });
});

describe('integration: stored records are returned as written', () => {
  it('round-trips a record without handing back a live reference', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await store.append('parties', { id: 'party-1', name: 'Acme', tags: ['a', 'b'] });

    const [first] = await store.list<{ name: string; tags: string[] }>('parties');
    first.name = 'Edited';
    first.tags.push('c');

    const [second] = await store.list<{ name: string; tags: string[] }>('parties');
    expect(second.name).toBe('Acme');
    expect(second.tags).toEqual(['a', 'b']);
  });

  it('detects a payload edited around the adapter', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    await store.append('parties', { id: 'party-1', name: 'Acme' });

    await database.sql`
      UPDATE trust_records SET payload = ${database.sql.json({ id: 'party-1', name: 'Tampered' })}
      WHERE collection = 'parties' AND record_id = 'party-1'
    `;

    await expect(store.list('parties')).rejects.toThrow('PERSISTENCE_CORRUPT_RECORD');
  });

  it('preserves insertion order, which every "latest record" read depends on', async () => {
    const database = await freshDatabase();
    const store = new PostgresTrustStore(database.sql);
    for (const id of ['a', 'b', 'c', 'd'])
      await store.append('parties', { id, name: id.toUpperCase() });

    const parties = await store.list<{ id: string }>('parties');
    expect(parties.map((party) => party.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

/**
 * Chain verification, locally.
 *
 * `verifyAuditChain` lives in `@assurapay/audit-ledger`, which depends on this package —
 * importing it here would make the dependency graph cyclic, and the architecture
 * validator says so. The equivalent assertion is made through the canonical hash in
 * `@assurapay/shared` instead; `packages/audit-ledger` carries the test that runs the
 * real verifier over a Postgres-written chain, where the dependency direction allows it.
 */
function chainIsValid(records: readonly AuditRecord[]): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  return records.every((record, index) => {
    if (auditIntegrityHash(record, digest) !== record.integrityHash) return false;
    const expectedPredecessor = index === 0 ? undefined : records[index - 1].integrityHash;
    return record.previousHash === expectedPredecessor;
  });
}

function grantFixture(id: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    userId: 'user-1',
    permissionKey: 'settlement:approve',
    effect: 'ALLOW',
    scopeType: 'WORKSPACE',
    sourceType: 'ROLE',
    sourceId: 'OWNER',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

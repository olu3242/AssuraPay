import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRecord } from '@assurapay/shared';
import { InMemoryTrustStore, PostgresTrustStore } from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from '@assurapay/database-testing';
import type { TestDatabase } from '@assurapay/database-testing';
import { verifyAuditChain } from './index';

/**
 * The audit chain, written durably and verified by Engine 08's own verifier.
 *
 * `packages/database` cannot import this package — the dependency runs the other way —
 * so this is where a Postgres-written chain meets the real `verifyAuditChain`. It is the
 * assertion that matters most for durability: a chain is only evidence if the thing that
 * checks it agrees with the thing that wrote it, across a process boundary.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function freshStore() {
  const database = await createTestDatabase();
  databases.push(database);
  return { database, store: new PostgresTrustStore(database.sql) };
}

function auditInput(eventType: string) {
  return {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    actorId: 'user-1',
    eventType,
    aggregateType: 'Thing',
    aggregateId: 'thing-1',
    correlationId: 'corr-1',
    metadata: {} as Record<string, unknown>,
  };
}

describe('integration: Engine 08 verifies a durably written chain', () => {
  it('accepts a chain written through PostgreSQL', async () => {
    const { store } = await freshStore();
    for (const event of ['First', 'Second', 'Third']) await store.audit(auditInput(event));

    const verification = verifyAuditChain(await store.list<AuditRecord>('auditRecords'));
    expect(verification).toMatchObject({ valid: true, checked: 3, findings: [] });
    expect(verification.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a chain written in memory and one written durably, identically', async () => {
    // The two stores must agree on the hash, or moving from one to the other silently
    // invalidates every record already written. Before the canonical hash they did not:
    // the digest depended on the key order of the writer's object literal, which a
    // relational adapter rebuilding a record from columns cannot reproduce.
    const { store: durable } = await freshStore();
    const memory = new InMemoryTrustStore();

    for (const event of ['First', 'Second']) {
      await durable.audit(auditInput(event));
      await memory.audit(auditInput(event));
    }

    const durableRecords = await durable.list<AuditRecord>('auditRecords');
    const memoryRecords = await memory.list<AuditRecord>('auditRecords');

    expect(verifyAuditChain(durableRecords).valid).toBe(true);
    expect(verifyAuditChain(memoryRecords).valid).toBe(true);
    // Ids and timestamps differ; the structure of the linkage does not.
    expect(durableRecords.map((record) => record.previousHash === undefined)).toEqual(
      memoryRecords.map((record) => record.previousHash === undefined),
    );
  });

  it('reports a tampered durable record, having reconnected to the database', async () => {
    const { database, store } = await freshStore();
    await store.audit(auditInput('First'));
    await store.audit(auditInput('Second'));

    // Around the append-only trigger, which is the realistic threat: someone with
    // database credentials rather than someone calling the API.
    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records DISABLE TRIGGER trust_audit_records_append_only',
    );
    await database.sql`
      UPDATE trust_audit_records SET event_type = 'Rewritten' WHERE chain_position = 2
    `;
    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records ENABLE TRIGGER trust_audit_records_append_only',
    );

    const verification = verifyAuditChain(await store.list<AuditRecord>('auditRecords'));
    expect(verification.valid).toBe(false);
    expect(verification.findings.map((finding) => finding.kind)).toContain('hash-mismatch');
    // The record's position is reported, so an auditor can locate it without a scan.
    expect(verification.findings[0].index).toBe(1);
  });

  it('cannot have its linkage severed at all, even with the trigger disabled', async () => {
    // Two defences, and this asserts the first. Severing a record's link to its
    // predecessor is refused by a check constraint, not merely detected afterwards: only
    // position 1 may have no predecessor, so `previous_hash = NULL` anywhere else is an
    // unstorable row. An attacker with database credentials who disables the append-only
    // trigger still cannot write it.
    const { database, store } = await freshStore();
    await store.audit(auditInput('First'));
    await store.audit(auditInput('Second'));

    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records DISABLE TRIGGER trust_audit_records_append_only',
    );
    try {
      await expect(
        database.sql`UPDATE trust_audit_records SET previous_hash = NULL WHERE chain_position = 2`,
      ).rejects.toThrow(/trust_audit_records_genesis/);
    } finally {
      await database.sql.unsafe(
        'ALTER TABLE trust_audit_records ENABLE TRIGGER trust_audit_records_append_only',
      );
    }

    expect(verifyAuditChain(await store.list<AuditRecord>('auditRecords')).valid).toBe(true);
  });

  it('reports a predecessor hash rewritten to another value', async () => {
    // The second defence. Repointing a record at a different predecessor satisfies every
    // constraint — it is still non-null, still unique — so the database cannot refuse it,
    // and detection falls to the hash the record commits to.
    const { database, store } = await freshStore();
    await store.audit(auditInput('First'));
    await store.audit(auditInput('Second'));

    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records DISABLE TRIGGER trust_audit_records_append_only',
    );
    await database.sql`
      UPDATE trust_audit_records SET previous_hash = repeat('0', 64) WHERE chain_position = 2
    `;
    await database.sql.unsafe(
      'ALTER TABLE trust_audit_records ENABLE TRIGGER trust_audit_records_append_only',
    );

    const verification = verifyAuditChain(await store.list<AuditRecord>('auditRecords'));
    expect(verification.valid).toBe(false);
    expect(verification.findings.map((finding) => finding.kind)).toContain('link-broken');
  });
});

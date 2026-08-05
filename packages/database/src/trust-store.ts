import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';
import { auditIntegrityHash, redactAuditMetadata } from '@assurapay/shared';

/**
 * In-memory implementation of the governed persistence boundary.
 *
 * Every method is `async` and genuinely returns a promise, even though the work
 * completes immediately. That is the point: the type contract must force callers
 * to await, or the first durable adapter would break every one of them. No
 * artificial delay is added — the guarantee is about the contract, not latency.
 *
 * This store is for deterministic testing and local development. It is not
 * durable, and `transaction` simulates atomicity with a snapshot rather than
 * providing ACID guarantees; a rollback here restores process memory and nothing
 * more.
 */
export class InMemoryTrustStore implements TrustPersistence {
  private collections = new Map<string, unknown[]>();

  /**
   * Reads are deep copies, not just a fresh array.
   *
   * A shallow copy handed out live references to the stored records, so any caller
   * that read a collection could edit it in place — including `auditRecords`, with
   * no write call and nothing to audit. `append` already cloned on write; reads
   * were the open side, and CLAUDE.md constraint 3 forbids mutating history at all.
   */
  async list<T>(collection: string): Promise<T[]> {
    return structuredClone(this.collections.get(collection) ?? []) as T[];
  }

  async append<T>(collection: string, value: T): Promise<void> {
    this.collections.set(collection, [
      ...(this.collections.get(collection) ?? []),
      structuredClone(value),
    ]);
  }

  async replace<T extends { id: string }>(collection: string, value: T): Promise<void> {
    const entries = (this.collections.get(collection) ?? []) as T[];
    const index = entries.findIndex((entry) => entry.id === value.id);
    if (index < 0) throw new Error(`${collection} record not found`);
    const updated = [...entries];
    updated[index] = structuredClone(value);
    this.collections.set(collection, updated);
  }

  async audit(
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    const records = (this.collections.get('auditRecords') ?? []) as AuditRecord[];
    const previousHash = records.at(-1)?.integrityHash;
    const createdAt = new Date().toISOString();
    const safeMetadata = redactAuditMetadata(input.metadata);
    // Hashed through the shared canonical function rather than over this object's key
    // order, so a record written here verifies when read back from a durable store that
    // rebuilt it from columns.
    const integrityHash = auditIntegrityHash(
      { ...input, metadata: safeMetadata, createdAt, previousHash },
      (value) => createHash('sha256').update(value).digest('hex'),
    );
    const record = {
      id: randomUUID(),
      ...input,
      metadata: safeMetadata,
      createdAt,
      integrityHash,
      previousHash,
    };
    await this.append('auditRecords', record);
    return record;
  }

  async emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent> {
    const event = { id: randomUUID(), ...input, occurredAt: new Date().toISOString() };
    await this.append('outboxEvents', event);
    return event;
  }

  /**
   * Runs `operation` against a transaction-scoped view of this store.
   *
   * Atomicity is simulated by snapshotting every collection before the callback and
   * restoring it on rejection. Honest about what that is: it protects process
   * memory, not a database, and a durable adapter must implement this with the
   * engine's own transaction rather than by copying state.
   *
   * The scoped repository is revoked once the transaction settles, so a callback
   * that captures it cannot write through it afterwards — a leak that would place
   * writes outside any transaction while appearing to be inside one.
   */
  async transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      [...this.collections].map(([name, values]) => [name, [...values]] as [string, unknown[]]),
    );
    const scoped = new ScopedTrustStore(this);

    try {
      const result = await operation(scoped);
      return result;
    } catch (error) {
      this.collections = snapshot;
      throw error;
    } finally {
      scoped.revoke();
    }
  }
}

/**
 * A transaction-scoped view that stops working once the transaction settles.
 *
 * Nested transactions join the outer one rather than opening a second: a nested
 * rollback that only undid the inner writes would leave the outer transaction
 * partially applied, which is the failure mode this contract exists to prevent.
 */
class ScopedTrustStore implements TrustPersistence {
  private active = true;

  constructor(private readonly inner: TrustPersistence) {}

  revoke(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error('TRANSACTION_SCOPE_EXPIRED');
    }
  }

  async list<T>(collection: string): Promise<T[]> {
    this.assertActive();
    return await this.inner.list<T>(collection);
  }

  async append<T>(collection: string, value: T): Promise<void> {
    this.assertActive();
    return await this.inner.append(collection, value);
  }

  async replace<T extends { id: string }>(collection: string, value: T): Promise<void> {
    this.assertActive();
    return await this.inner.replace(collection, value);
  }

  async audit(
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    this.assertActive();
    return await this.inner.audit(input);
  }

  async emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent> {
    this.assertActive();
    return await this.inner.emit(input);
  }

  async transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T> {
    this.assertActive();
    return await operation(this);
  }
}

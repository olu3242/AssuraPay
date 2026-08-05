import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';

export class InMemoryTrustStore implements TrustPersistence {
  private readonly collections = new Map<string, unknown[]>();
  /**
   * Reads are deep copies, not just a fresh array.
   *
   * A shallow copy handed out live references to the stored records, so any caller
   * that read a collection could edit it in place — including `auditRecords`, with
   * no write call and nothing to audit. `append` already cloned on write; reads
   * were the open side, and CLAUDE.md constraint 3 forbids mutating history at all.
   */
  list<T>(collection: string): T[] { return structuredClone(this.collections.get(collection) ?? []) as T[]; }
  append<T>(collection: string, value: T): void { this.collections.set(collection, [...(this.collections.get(collection) ?? []), structuredClone(value)]); }
  replace<T extends { id: string }>(collection: string, value: T): void {
    const entries = this.list<T>(collection); const index = entries.findIndex((entry) => entry.id === value.id);
    if (index < 0) throw new Error(`${collection} record not found`); entries[index] = structuredClone(value); this.collections.set(collection, entries);
  }
  audit(input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>): AuditRecord {
    const records = this.list<AuditRecord>('auditRecords'); const previousHash = records.at(-1)?.integrityHash; const createdAt = new Date().toISOString();
    const safeMetadata = Object.fromEntries(Object.entries(input.metadata).filter(([key]) => !/(password|token|otp|secret|account|identityNumber)/i.test(key)));
    const integrityHash = createHash('sha256').update(JSON.stringify({ ...input, metadata: safeMetadata, createdAt, previousHash })).digest('hex');
    const record = { id: randomUUID(), ...input, metadata: safeMetadata, createdAt, integrityHash, previousHash }; this.append('auditRecords', record); return record;
  }
  emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): OutboxEvent { const event = { id: randomUUID(), ...input, occurredAt: new Date().toISOString() }; this.append('outboxEvents', event); return event; }
}

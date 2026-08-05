export type AssuranceLevel = 'IAL0_UNVERIFIED' | 'IAL1_BASIC' | 'IAL2_VERIFIED' | 'IAL3_HIGH_ASSURANCE';
export type RequestContext = { actorUserId: string; sessionId: string; identityAssuranceLevel: AssuranceLevel; activeWorkspaceId?: string; tenantId?: string; organizationId?: string; memberships: string[]; correlationId: string };
export type AuditRecord = { id: string; tenantId?: string; workspaceId?: string; actorId: string; eventType: string; aggregateType: string; aggregateId: string; correlationId: string; metadata: Record<string, unknown>; createdAt: string; integrityHash: string; previousHash?: string };
export type OutboxEvent = { id: string; tenantId?: string; workspaceId?: string; aggregateType: string; aggregateId: string; eventType: string; eventVersion: number; payload: Record<string, unknown>; correlationId: string; occurredAt: string; publishedAt?: string };

/**
 * The governed persistence boundary.
 *
 * Every method is asynchronous, including reads. The previous contract was
 * synchronous throughout, which made a durable adapter impossible to write
 * honestly: network I/O cannot satisfy a signature that returns a value rather
 * than a promise, so no Postgres implementation could exist without changing this
 * interface and every call path behind it. CLAUDE.md's claim that Postgres could
 * be swapped without touching engine logic was not true as built.
 *
 * Reads are async too, deliberately. A contract where reads happen to be
 * synchronous because the in-memory store can satisfy them would leak that
 * implementation's characteristics into every caller, and the first durable
 * adapter would break all of them.
 *
 * There is no synchronous compatibility layer and no `T | Promise<T>` union: a
 * caller that forgets to await must fail to compile, which a permissive union
 * would prevent.
 */
export interface TrustPersistence {
  list<T>(collection: string): Promise<T[]>;
  append<T>(collection: string, value: T): Promise<void>;
  replace<T extends { id: string }>(collection: string, value: T): Promise<void>;
  audit(input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>): Promise<AuditRecord>;
  emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent>;
  /**
   * Runs `operation` against a transaction-scoped repository.
   *
   * The callback receives the repository it must use; writes through the outer
   * repository are not part of the transaction. A rejection rolls back every write
   * made through the scoped repository, and the scoped repository is refused after
   * the transaction settles, so it cannot leak into later work.
   */
  transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T>;
}

/**
 * Metadata keys whose values must never enter the audit trail.
 *
 * History is append-only, so a secret written into it cannot be redacted afterwards —
 * the only safe moment to drop it is before the record is hashed and stored.
 */
export const AUDIT_REDACTED_METADATA = /(password|token|otp|secret|account|identityNumber)/i;

/** Drops secret-shaped metadata keys. Applied before hashing, never after. */
export function redactAuditMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !AUDIT_REDACTED_METADATA.test(key)),
  );
}

/**
 * The canonical audit integrity hash.
 *
 * Computed over sorted keys. The previous implementation hashed
 * `JSON.stringify({...input, ...})`, which made the digest depend on the key order of
 * whatever object literal the calling engine happened to write — two engines recording
 * the same logical event with their fields in a different order produced different
 * hashes for identical content. Worse, it made the hash unreproducible by any store
 * that normalizes: a relational adapter reads columns and rebuilds the record, and
 * cannot know the order the original literal used, so a chain written through one store
 * failed verification when read through the other.
 *
 * Defined here, in the package both stores and the ledger verifier depend on, so there
 * is one definition rather than three that must be kept in agreement.
 */
export function auditIntegrityHash(
  record: Omit<AuditRecord, 'id' | 'integrityHash'>,
  digest: (value: string) => string,
): string {
  return digest(
    canonicalJson({
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      actorId: record.actorId,
      eventType: record.eventType,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      correlationId: record.correlationId,
      metadata: record.metadata,
      createdAt: record.createdAt,
      previousHash: record.previousHash,
    }),
  );
}

/**
 * Serializes a value with object keys in sorted order.
 *
 * `undefined` properties are dropped rather than serialized, so an optional field left
 * unset hashes the same as one absent entirely — otherwise `tenantId: undefined` and no
 * `tenantId` at all would be different records.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function requireAuthenticatedIdentity(context?: RequestContext): asserts context is RequestContext {
  if (!context?.actorUserId || !context.sessionId) throw new Error('UNAUTHENTICATED');
}
export function requireActiveWorkspace(context: RequestContext): asserts context is RequestContext & { activeWorkspaceId: string; tenantId: string } {
  requireAuthenticatedIdentity(context);
  if (!context.activeWorkspaceId || !context.tenantId || !context.memberships.includes(context.activeWorkspaceId)) throw new Error('ACTIVE_WORKSPACE_REQUIRED');
}
export type MaskingMode = 'NONE' | 'PARTIAL' | 'FULL' | 'TOKENIZED' | 'LAST_FOUR';

/**
 * Masks a sensitive value for display.
 *
 * The partial modes reveal a fixed number of characters, which only masks anything
 * when the value is longer than what they reveal. `LAST_FOUR` of a four-character
 * account reference is the whole reference, and `PARTIAL` reveals the first two and
 * last two, so anything up to four characters is fully exposed. Both fall back to
 * full redaction rather than returning the input decorated with asterisks, because
 * the caller has already decided this value must not be shown in full and a short
 * value is not a licence to show it.
 */
export function maskValue(value: string, mode: MaskingMode) {
  if (mode === 'NONE') return value;
  if (mode === 'TOKENIZED') return '[TOKENIZED]';
  if (mode === 'FULL') return '[REDACTED]';
  if (value.length <= 4) return '[REDACTED]';
  return mode === 'LAST_FOUR'
    ? `****${value.slice(-4)}`
    : `${value.slice(0, 2)}***${value.slice(-2)}`;
}

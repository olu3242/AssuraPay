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

export function requireAuthenticatedIdentity(context?: RequestContext): asserts context is RequestContext {
  if (!context?.actorUserId || !context.sessionId) throw new Error('UNAUTHENTICATED');
}
export function requireActiveWorkspace(context: RequestContext): asserts context is RequestContext & { activeWorkspaceId: string; tenantId: string } {
  requireAuthenticatedIdentity(context);
  if (!context.activeWorkspaceId || !context.tenantId || !context.memberships.includes(context.activeWorkspaceId)) throw new Error('ACTIVE_WORKSPACE_REQUIRED');
}
export function maskValue(value: string, mode: 'NONE' | 'PARTIAL' | 'FULL' | 'TOKENIZED' | 'LAST_FOUR') {
  if (mode === 'NONE') return value;
  if (mode === 'LAST_FOUR') return `****${value.slice(-4)}`;
  if (mode === 'PARTIAL') return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return mode === 'TOKENIZED' ? '[TOKENIZED]' : '[REDACTED]';
}

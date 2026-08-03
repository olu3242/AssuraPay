export type AssuranceLevel = 'IAL0_UNVERIFIED' | 'IAL1_BASIC' | 'IAL2_VERIFIED' | 'IAL3_HIGH_ASSURANCE';
export type RequestContext = { actorUserId: string; sessionId: string; identityAssuranceLevel: AssuranceLevel; activeWorkspaceId?: string; tenantId?: string; organizationId?: string; memberships: string[]; correlationId: string };
export type AuditRecord = { id: string; tenantId?: string; workspaceId?: string; actorId: string; eventType: string; aggregateType: string; aggregateId: string; correlationId: string; metadata: Record<string, unknown>; createdAt: string; integrityHash: string; previousHash?: string };
export type OutboxEvent = { id: string; tenantId?: string; workspaceId?: string; aggregateType: string; aggregateId: string; eventType: string; eventVersion: number; payload: Record<string, unknown>; correlationId: string; occurredAt: string; publishedAt?: string };

export interface TrustPersistence {
  list<T>(collection: string): T[];
  append<T>(collection: string, value: T): void;
  replace<T extends { id: string }>(collection: string, value: T): void;
  audit(input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>): AuditRecord;
  emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): OutboxEvent;
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

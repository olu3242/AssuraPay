import { randomUUID } from 'node:crypto';

export * from './enforcement';
export * from './catalogue';

import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { maskValue, requireActiveWorkspace } from '@assurapay/shared';
export type Effect = 'ALLOW' | 'DENY' | 'CONDITIONAL';
export type PermissionGrant = { id: string; workspaceId: string; userId: string; permissionKey: string; effect: Effect; scopeType: string; scopeId?: string; sourceType: 'ROLE' | 'PERMISSION_SET' | 'DELEGATION'; sourceId: string; effectiveFrom: string; effectiveTo?: string; createdAt: string };
export type FieldPermission = { id: string; workspaceId: string; principalId: string; objectKey: string; fieldKey: string; canView: boolean; canExport: boolean; maskingMode: 'NONE' | 'PARTIAL' | 'FULL' | 'TOKENIZED' | 'LAST_FOUR'; priority: number; createdAt: string };
export type Delegation = { id: string; workspaceId: string; delegatorUserId: string; delegateUserId: string; delegatedPermissions: string[]; scopeType: string; scopeId?: string; authorityLimitMinor?: number; currency?: string; reason: string; status: 'ACTIVE' | 'REVOKED' | 'EXPIRED'; effectiveFrom: string; effectiveTo: string; approvedBy?: string; createdAt: string; version: number };
export type AuthorityRule = { id: string; workspaceId: string; transactionType: string; requiredPermission: string; maximumValueMinor?: number; currency?: string; requiredApprovalCount: number; independenceRequired: boolean; status: 'ACTIVE' | 'INACTIVE'; createdAt: string; version: number };
export type SegregationRule = { id: string; workspaceId: string; ruleKey: string; firstPermission: string; conflictingPermission: string; severity: string; enforcementMode: 'WARN' | 'BLOCK'; status: 'ACTIVE' | 'INACTIVE'; createdAt: string; version: number };
export type PermissionDecision = { allowed: boolean; permissionKey: string; reasons: string[]; grants: string[]; denials: string[] };
export class PermissionService {
  constructor(private readonly store: TrustPersistence) {}

  /**
   * Every permission key this caller currently holds in its active workspace.
   *
   * Exists because nothing could answer "what may I do?". `evaluate` answers it one key at a time and
   * `permissions:evaluate` gates even that behind a key only an administrator holds, so an ordinary caller had
   * no way to learn its own authority — and an interface that wants to show someone only the surfaces they can
   * use had to either guess or show everything and let the gateway refuse.
   *
   * Reuses this service's own rules rather than restating them, which is the whole point of putting it here:
   * the same effective window, the same scope match, and the same DENY-beats-ALLOW precedence `evaluate` uses.
   * A reimplementation in the web layer would drift, and the drift would appear as navigation offering a
   * destination the gateway refuses, or hiding one it would have allowed.
   *
   * One pass over the grants rather than one per key. Asking `evaluate` for each of ~190 route keys would read
   * the whole collection ~190 times for a question that is a single grouping.
   *
   * It discloses nothing: the caller's own keys, in the workspace it is already scoped to, which it could
   * establish anyway by attempting each route. It does not confer anything either — this is a read, and every
   * route still enforces its own requirement.
   */
  async effectiveKeys(context: RequestContext): Promise<string[]> {
    requireActiveWorkspace(context);
    const now = Date.now();
    const mine = (await this.store.list<PermissionGrant>('permissionGrants')).filter(
      (entry) =>
        entry.workspaceId === context.activeWorkspaceId &&
        entry.userId === context.actorUserId &&
        Date.parse(entry.effectiveFrom) <= now &&
        (!entry.effectiveTo || Date.parse(entry.effectiveTo) > now),
    );
    // An explicit DENY on a key removes it however many ALLOWs stand beside it, matching `evaluate`.
    const denied = new Set(mine.filter((entry) => entry.effect === 'DENY').map((entry) => entry.permissionKey));
    return [
      ...new Set(
        mine
          .filter((entry) => entry.effect === 'ALLOW' && !denied.has(entry.permissionKey))
          .map((entry) => entry.permissionKey),
      ),
    ].sort();
  }
  async grant(context: RequestContext, input: Omit<PermissionGrant, 'id' | 'workspaceId' | 'createdAt'>) { requireActiveWorkspace(context); const grant: PermissionGrant = { id: randomUUID(), workspaceId: context.activeWorkspaceId, ...input, createdAt: new Date().toISOString() }; await this.store.append('permissionGrants', grant); await this.store.audit({ tenantId: context.tenantId, workspaceId: context.activeWorkspaceId, actorId: context.actorUserId, eventType: 'PermissionSetAssigned', aggregateType: 'PermissionGrant', aggregateId: grant.id, correlationId: context.correlationId, metadata: { permissionKey: input.permissionKey, effect: input.effect } }); return grant; }
  async evaluate(context: RequestContext, permissionKey: string, scopeId?: string): Promise<PermissionDecision> { requireActiveWorkspace(context); const now = Date.now(); const grants = (await this.store.list<PermissionGrant>('permissionGrants')).filter((entry) => entry.workspaceId === context.activeWorkspaceId && entry.userId === context.actorUserId && entry.permissionKey === permissionKey && Date.parse(entry.effectiveFrom) <= now && (!entry.effectiveTo || Date.parse(entry.effectiveTo) > now) && (!entry.scopeId || entry.scopeId === scopeId)); const denials = grants.filter((entry) => entry.effect === 'DENY'); const allowances = grants.filter((entry) => entry.effect === 'ALLOW'); const allowed = denials.length === 0 && allowances.length > 0; return { allowed, permissionKey, reasons: denials.length ? ['EXPLICIT_DENY'] : allowances.length ? ['APPLICABLE_ALLOW'] : ['DENY_BY_DEFAULT'], grants: allowances.map((entry) => entry.id), denials: denials.map((entry) => entry.id) }; }
  async requirePermission(context: RequestContext, permissionKey: string, scopeId?: string) { const decision = await this.evaluate(context, permissionKey, scopeId); if (!decision.allowed) { await this.store.audit({ tenantId: context.tenantId, workspaceId: context.activeWorkspaceId, actorId: context.actorUserId, eventType: 'PermissionDenied', aggregateType: 'Permission', aggregateId: permissionKey, correlationId: context.correlationId, metadata: { reasons: decision.reasons } }); throw new Error(`PERMISSION_DENIED:${permissionKey}`); } return decision; }
  async createFieldPermission(context: RequestContext, input: Omit<FieldPermission, 'id' | 'workspaceId' | 'createdAt'>) { requireActiveWorkspace(context); const permission: FieldPermission = { id: randomUUID(), workspaceId: context.activeWorkspaceId, ...input, createdAt: new Date().toISOString() }; await this.store.append('fieldPermissions', permission); return permission; }
  async serializeFields(context: RequestContext, objectKey: string, record: Record<string, unknown>) { requireActiveWorkspace(context); const rules = (await this.store.list<FieldPermission>('fieldPermissions')).filter((entry) => entry.workspaceId === context.activeWorkspaceId && entry.principalId === context.actorUserId && entry.objectKey === objectKey).sort((a, b) => b.priority - a.priority); const output: Record<string, unknown> = {}; for (const [key, value] of Object.entries(record)) { const rule = rules.find((entry) => entry.fieldKey === key); if (rule && !rule.canView) continue; output[key] = rule && typeof value === 'string' ? maskValue(value, rule.maskingMode) : value; } return output; }
  async createDelegation(context: RequestContext, input: { delegateUserId: string; delegatedPermissions: string[]; scopeType: string; scopeId?: string; authorityLimitMinor?: number; currency?: string; reason: string; effectiveFrom: string; effectiveTo: string; approvedBy?: string }) { requireActiveWorkspace(context); if (Date.parse(input.effectiveTo) <= Date.parse(input.effectiveFrom)) throw new Error('INVALID_DELEGATION_PERIOD'); for (const permission of input.delegatedPermissions) await this.requirePermission(context, permission, input.scopeId); const delegation: Delegation = { id: randomUUID(), workspaceId: context.activeWorkspaceId, delegatorUserId: context.actorUserId, ...input, status: Date.parse(input.effectiveTo) <= Date.now() ? 'EXPIRED' : 'ACTIVE', createdAt: new Date().toISOString(), version: 1 }; await this.store.append('delegations', delegation); for (const permissionKey of input.delegatedPermissions) await this.store.append<PermissionGrant>('permissionGrants', { id: randomUUID(), workspaceId: context.activeWorkspaceId, userId: input.delegateUserId, permissionKey, effect: 'ALLOW', scopeType: input.scopeType, scopeId: input.scopeId, sourceType: 'DELEGATION', sourceId: delegation.id, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, createdAt: delegation.createdAt }); return delegation; }
  async createSegregationRule(context: RequestContext, input: Omit<SegregationRule, 'id' | 'workspaceId' | 'createdAt' | 'version'>) { requireActiveWorkspace(context); const rule: SegregationRule = { id: randomUUID(), workspaceId: context.activeWorkspaceId, ...input, createdAt: new Date().toISOString(), version: 1 }; await this.store.append('segregationRules', rule); return rule; }
  async assertNoSegregationConflict(context: RequestContext, permissions: string[]) { requireActiveWorkspace(context); const conflict = (await this.store.list<SegregationRule>('segregationRules')).find((entry) => entry.workspaceId === context.activeWorkspaceId && entry.status === 'ACTIVE' && entry.enforcementMode === 'BLOCK' && permissions.includes(entry.firstPermission) && permissions.includes(entry.conflictingPermission)); if (conflict) { await this.store.audit({ tenantId: context.tenantId, workspaceId: context.activeWorkspaceId, actorId: context.actorUserId, eventType: 'SegregationOfDutiesViolationDetected', aggregateType: 'SegregationRule', aggregateId: conflict.id, correlationId: context.correlationId, metadata: { ruleKey: conflict.ruleKey } }); throw new Error('SEGREGATION_OF_DUTIES_VIOLATION'); } }
  async createAuthorityRule(context: RequestContext, input: Omit<AuthorityRule, 'id' | 'workspaceId' | 'createdAt' | 'version'>) { requireActiveWorkspace(context); const rule: AuthorityRule = { id: randomUUID(), workspaceId: context.activeWorkspaceId, ...input, createdAt: new Date().toISOString(), version: 1 }; await this.store.append('authorityRules', rule); return rule; }
  async requireAuthority(context: RequestContext, transactionType: string, valueMinor: number, currency: string) { if (!Number.isSafeInteger(valueMinor) || valueMinor < 0) throw new Error('INVALID_MINOR_UNITS'); const rule = (await this.store.list<AuthorityRule>('authorityRules')).find((entry) => entry.workspaceId === context.activeWorkspaceId && entry.transactionType === transactionType && entry.status === 'ACTIVE'); if (!rule) throw new Error('AUTHORITY_DENIED'); await this.requirePermission(context, rule.requiredPermission); if (rule.currency && rule.currency !== currency) throw new Error('AUTHORITY_CURRENCY_MISMATCH'); if (rule.maximumValueMinor !== undefined && valueMinor > rule.maximumValueMinor) throw new Error('AUTHORITY_LIMIT_EXCEEDED'); return rule; }
}

import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireAuthenticatedIdentity } from '@assurapay/shared';
import type { PermissionDecision } from './index';

/**
 * Engine 03 — permission enforcement.
 *
 * Applied at the composition root, never inside an engine. An engine receives an
 * already-authorized context; it does not decide whether the caller may act.
 *
 * This is the counterpart to the identity gateway. The gateway proves *who* the
 * caller is and deliberately refuses to resolve membership, emitting an empty
 * `RequestContext.memberships`. Enforcement is what resolves membership from the
 * authoritative record and evaluates permission, so authorization is established
 * by data rather than asserted by a signature.
 *
 * Deny by default, per CLAUDE.md: absent an applicable ALLOW grant, the answer is
 * no.
 */

export type PermissionEnforcementErrorCode =
  | 'ENFORCEMENT_UNAUTHENTICATED'
  | 'ENFORCEMENT_WORKSPACE_CONTEXT_REQUIRED'
  | 'ENFORCEMENT_MEMBERSHIP_REQUIRED'
  | 'ENFORCEMENT_PERMISSION_DENIED'
  | 'ENFORCEMENT_SEGREGATION_VIOLATION';

/** Stable codes so callers branch on the reason, never on message text. */
export class PermissionEnforcementError extends Error {
  readonly code: PermissionEnforcementErrorCode;
  readonly detail?: string;

  constructor(code: PermissionEnforcementErrorCode, detail?: string) {
    super(code);
    this.name = 'PermissionEnforcementError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The authoritative membership record, read structurally.
 *
 * `packages/permissions` is a trust-foundation package and may not import
 * `@assurapay/organizations`, so the shape is declared here and read from the
 * shared `memberships` collection that engine 02 owns. Only the fields
 * enforcement actually needs are named.
 */
type MembershipRecord = {
  workspaceId: string;
  userId: string;
  status: string;
};

/**
 * Resolves which workspaces a user is actively a member of.
 *
 * An interface rather than a concrete read so a durable implementation can replace
 * the in-store one without touching enforcement.
 */
export interface WorkspaceMembershipReader {
  activeWorkspaceIds(userId: string): Promise<string[]>;
}

/** Reads active memberships from the authoritative `memberships` collection. */
export class TrustStoreMembershipReader implements WorkspaceMembershipReader {
  constructor(private readonly store: TrustPersistence) {}

  async activeWorkspaceIds(userId: string): Promise<string[]> {
    return (await this.store
      .list<MembershipRecord>('memberships'))
      .filter((record) => record.userId === userId && record.status === 'ACTIVE')
      .map((record) => record.workspaceId)
      .sort();
  }
}

/**
 * The permission authority enforcement delegates decisions to.
 *
 * Structural rather than a concrete import of `PermissionService`, so enforcement
 * does not create an import cycle within the package and can be tested against a
 * decision stub.
 */
export interface PermissionAuthority {
  requirePermission(
    context: RequestContext,
    permissionKey: string,
    scopeId?: string,
  ): Promise<PermissionDecision>;
  /**
   * Non-throwing decision, used to establish which of a requirement's conflicting
   * permissions the caller actually holds.
   */
  evaluate(
    context: RequestContext,
    permissionKey: string,
    scopeId?: string,
  ): Promise<PermissionDecision>;
  assertNoSegregationConflict(
    context: RequestContext,
    permissions: string[],
  ): Promise<void>;
}

export type PermissionRequirement = {
  permissionKey: string;
  scopeId?: string;
  /**
   * Permissions that must not be held alongside `permissionKey`. Checked through
   * the authority's segregation rules.
   */
  segregatedFrom?: string[];
};

export type EnforcementAuthorities = {
  memberships: WorkspaceMembershipReader;
  permissions: PermissionAuthority;
  store: TrustPersistence;
};

/**
 * Resolves membership for a verified identity, returning a context whose
 * `memberships` reflect the authoritative record.
 *
 * Any membership list on the incoming context is discarded, never merged. The
 * gateway emits an empty list, but a caller constructing a context by hand could
 * supply one, and trusting it would reintroduce exactly the bypass the gateway
 * removed. Membership is read, never accepted.
 */
export async function resolveMemberships(
  identity: RequestContext,
  memberships: WorkspaceMembershipReader,
): Promise<RequestContext> {
  requireIdentity(identity);
  return {
    ...identity,
    memberships: await memberships.activeWorkspaceIds(identity.actorUserId),
  };
}

/**
 * Enforces a permission requirement and returns the authorized context.
 *
 * Order matters and each step fails closed:
 *   1. the caller is authenticated;
 *   2. a workspace and tenant are in context;
 *   3. membership in that workspace is proven by the authoritative record;
 *   4. the permission is granted, deny-by-default;
 *   5. no blocking segregation-of-duties conflict applies.
 *
 * The returned context carries resolved memberships, so a downstream engine's
 * `requireActiveWorkspace` succeeds on proven membership rather than on a claim.
 */
export async function enforcePermission(
  identity: RequestContext,
  requirement: PermissionRequirement,
  authorities: EnforcementAuthorities,
): Promise<RequestContext> {
  requireIdentity(identity);

  if (!identity.activeWorkspaceId?.trim() || !identity.tenantId?.trim()) {
    throw new PermissionEnforcementError(
      'ENFORCEMENT_WORKSPACE_CONTEXT_REQUIRED',
      'activeWorkspaceId and tenantId are required',
    );
  }

  const authorized = await resolveMemberships(identity, authorities.memberships);

  if (!authorized.memberships.includes(identity.activeWorkspaceId)) {
    await authorities.store.audit({
      tenantId: identity.tenantId,
      workspaceId: identity.activeWorkspaceId,
      actorId: identity.actorUserId,
      eventType: 'WorkspaceMembershipDenied',
      aggregateType: 'Membership',
      aggregateId: identity.activeWorkspaceId,
      correlationId: identity.correlationId,
      metadata: {
        reason: 'NO_ACTIVE_MEMBERSHIP',
        permissionKey: requirement.permissionKey,
      },
    });
    throw new PermissionEnforcementError(
      'ENFORCEMENT_MEMBERSHIP_REQUIRED',
      `no active membership in ${identity.activeWorkspaceId}`,
    );
  }

  try {
    await authorities.permissions.requirePermission(
      authorized,
      requirement.permissionKey,
      requirement.scopeId,
    );
  } catch (error) {
    // The authority already audits its own denial; re-shape the failure into a
    // stable enforcement code without restating the reason.
    throw new PermissionEnforcementError(
      'ENFORCEMENT_PERMISSION_DENIED',
      requirement.permissionKey,
    );
  }

  if (requirement.segregatedFrom && requirement.segregatedFrom.length > 0) {
    // Only conflicting permissions the caller actually holds are in play. Passing
    // the requirement's declared conflicts instead would make the rule fire for
    // every caller once the rule existed, including the compliant one holding a
    // single side — which reads as strict but renders the permission unusable and
    // pressures an operator into deleting the rule.
    // Decisions are resolved before filtering. A `.filter` predicate cannot await,
    // and an unawaited promise is always truthy, so every declared conflict would
    // read as held and the rule would fire for a caller holding none of them.
    const decisions = await Promise.all(
      requirement.segregatedFrom.map((permissionKey) =>
        authorities.permissions.evaluate(authorized, permissionKey, requirement.scopeId),
      ),
    );
    const heldConflicts = requirement.segregatedFrom.filter(
      (_permissionKey, index) => decisions[index].allowed,
    );

    if (heldConflicts.length > 0) {
      try {
        await authorities.permissions.assertNoSegregationConflict(authorized, [
          requirement.permissionKey,
          ...heldConflicts,
        ]);
      } catch {
        throw new PermissionEnforcementError(
          'ENFORCEMENT_SEGREGATION_VIOLATION',
          requirement.permissionKey,
        );
      }
    }
  }

  return authorized;
}

function requireIdentity(identity: RequestContext): void {
  try {
    requireAuthenticatedIdentity(identity);
  } catch {
    throw new PermissionEnforcementError('ENFORCEMENT_UNAUTHENTICATED');
  }
}

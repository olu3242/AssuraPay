import {
  PERMISSION_CATALOGUE,
  requireRole,
  type PermissionGrant,
  type WorkspaceBootstrap,
} from '@assurapay/permissions';
import type { RequestContext } from '@assurapay/shared';
import {
  assignRole,
  bootstrapFoundingAdministrator,
  trustStore,
} from './trust-app';

/**
 * Grant administration.
 *
 * The catalogue could found a workspace and assign roles, but only in-process:
 * nothing reached it over HTTP. So a running deployment had a correct policy, a
 * way to authenticate, and no way for an operator to grant anybody anything —
 * every permission-class route stayed unsatisfiable.
 *
 * Three routes close that, and the interesting one is founding. It cannot require
 * a permission, because it is what creates the first permission; requiring one
 * would restore the deadlock exactly. It is therefore identity-class, and safe
 * only because `bootstrapWorkspaceGrants` refuses unless the caller is already an
 * ACTIVE OWNER of the workspace and the workspace holds no grant yet. The route
 * adds nothing to those guards and weakens none of them — in particular the
 * founder is the authenticated caller, never a value from the request.
 */

export type GrantAdministrationRoute = {
  template: string;
  method: string;
  access: 'identity' | 'permission';
  rationale: string;
};

/**
 * The routes this capability adds, stated as data so the suite can assert the
 * policy table classes each one the way it is documented here.
 */
export const GRANT_ADMINISTRATION_ROUTES: readonly GrantAdministrationRoute[] = Object.freeze([
  {
    template: '/api/v1/workspaces/[id]/found',
    method: 'POST',
    access: 'identity',
    rationale:
      'Founding creates the first grant, so it cannot require one. Authenticated only; the owner-membership and no-existing-grant guards in bootstrapWorkspaceGrants are what make it safe.',
  },
  {
    template: '/api/v1/roles',
    method: 'GET',
    access: 'permission',
    rationale:
      'Reading the catalogue reveals the shape of the authorization model, including which roles hold money-movement keys.',
  },
  {
    template: '/api/v1/roles/assignments',
    method: 'POST',
    access: 'permission',
    rationale:
      'Assigning a role is the act of granting authority, and is refused when the resulting permission set would breach segregation of duties.',
  },
]);

type WorkspaceRecord = { id: string; tenantId: string; status: string };

export type GrantAdministrationErrorCode =
  | 'GRANT_ADMIN_WORKSPACE_UNKNOWN'
  | 'GRANT_ADMIN_USER_REQUIRED';

export class GrantAdministrationError extends Error {
  readonly code: GrantAdministrationErrorCode;
  readonly detail?: string;

  constructor(code: GrantAdministrationErrorCode, detail?: string) {
    super(code);
    this.name = 'GrantAdministrationError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Grants the founding administrator of a workspace to the authenticated caller.
 *
 * The founder is `context.actorUserId`. There is deliberately no way to found on
 * someone else's behalf: that would turn the one path with no authorizing caller
 * into a way to hand authority to an arbitrary account.
 *
 * The tenant is read from the workspace record rather than the context, because an
 * identity-class caller need not have selected a workspace yet — that is the state
 * a founder is normally in.
 */
export function foundWorkspace(
  context: RequestContext,
  workspaceId: string,
): WorkspaceBootstrap {
  const workspace = trustStore
    .list<WorkspaceRecord>('trustWorkspaces')
    .find((entry) => entry.id === workspaceId && entry.status === 'ACTIVE');
  if (!workspace) {
    throw new GrantAdministrationError('GRANT_ADMIN_WORKSPACE_UNKNOWN', workspaceId);
  }

  return bootstrapFoundingAdministrator({
    tenantId: workspace.tenantId,
    workspaceId: workspace.id,
    founderUserId: context.actorUserId,
    correlationId: context.correlationId,
  });
}

export type RoleAssignmentInput = {
  userId: string;
  role: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  scopeId?: string;
};

/**
 * Assigns a catalogue role within the caller's active workspace.
 *
 * The workspace is the caller's own active one, never a value from the request:
 * enforcement proved membership and permission there, and accepting a workspace id
 * from the body would let an administrator of one workspace grant roles in another.
 */
export function assignWorkspaceRole(
  context: RequestContext,
  input: RoleAssignmentInput,
): PermissionGrant[] {
  if (!input?.userId?.trim()) {
    throw new GrantAdministrationError('GRANT_ADMIN_USER_REQUIRED');
  }
  // Resolved here so an unknown role fails before anything is written, with the
  // catalogue's own error code rather than a partial assignment.
  requireRole(input.role);

  return assignRole(context, {
    userId: input.userId,
    role: input.role,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    scopeId: input.scopeId,
  });
}

export type RoleSummary = {
  role: string;
  title: string;
  rationale: string;
  bootstrappable: boolean;
  permissionKeys: string[];
};

/**
 * The catalogue, as an operator needs to see it to choose a role.
 *
 * Returns the rationale alongside the keys: an operator picking between
 * SETTLEMENT_APPROVER and PAYMENT_OPERATOR needs to know they are segregated, and
 * a bare key list does not say so.
 */
export function listRoles(): RoleSummary[] {
  return PERMISSION_CATALOGUE.map((definition) => ({
    role: definition.role,
    title: definition.title,
    rationale: definition.rationale,
    bootstrappable: definition.bootstrappable,
    permissionKeys: [...definition.permissionKeys],
  }));
}

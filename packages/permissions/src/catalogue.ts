import { randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
import type { PermissionDecision, PermissionGrant, SegregationRule } from './index';

/**
 * Engine 03 — the permission grant catalogue.
 *
 * Route policy names the permission every API route requires, and enforcement
 * denies by default. Between the two there was nothing that could create a grant:
 * `PermissionService.grant` needs an already-authorized workspace context, and no
 * caller can be authorized in a workspace that holds no grants. A correct policy
 * over an empty grant table denies everything, forever.
 *
 * This module closes that circle in the only place it can be closed safely — at
 * workspace founding, against a membership that already exists — and gives every
 * subsequent grant a bounded, reviewable shape:
 *
 *   - `PERMISSION_CATALOGUE` is the closed set of roles and the keys each may hold.
 *     A key no role names cannot be granted, so the authorization surface is an
 *     inventory rather than an open string space.
 *   - `SEGREGATION_CATALOGUE` is the canonical set of duty pairs no principal may
 *     hold together.
 *   - `bootstrapWorkspaceGrants` grants the founding administrator without an
 *     authorizing caller, once per workspace.
 *   - `grantRole` is the ordinary path: authorized, and refused when the resulting
 *     permission set would breach segregation of duties.
 *
 * Roles are deliberately not hierarchical and there is no superuser. A role that
 * held every key would make every segregation rule vacuous, so the founding
 * administrator administers — it onboards parties, assigns roles and publishes
 * policy — and holds no certification, release or payment key at all.
 */

export type CatalogueErrorCode =
  | 'CATALOGUE_BOOTSTRAP_DISABLED'
  | 'CATALOGUE_UNKNOWN_ROLE'
  | 'CATALOGUE_ROLE_NOT_BOOTSTRAPPABLE'
  | 'CATALOGUE_MEMBERSHIP_REQUIRED'
  | 'CATALOGUE_ALREADY_BOOTSTRAPPED'
  | 'CATALOGUE_SEGREGATION_CONFLICT'
  | 'CATALOGUE_CONFIG_INVALID';

/** Stable codes so callers branch on the reason, never on message text. */
export class CatalogueError extends Error {
  readonly code: CatalogueErrorCode;
  readonly detail?: string;

  constructor(code: CatalogueErrorCode, detail?: string) {
    super(code);
    this.name = 'CatalogueError';
    this.code = code;
    this.detail = detail;
  }
}

export type RoleDefinition = {
  /** Stable identifier recorded as a grant's `sourceId`. */
  role: string;
  title: string;
  /** Why the role exists and what it deliberately excludes. */
  rationale: string;
  /**
   * Whether the role may be granted with no authorizing caller. Only true for the
   * founding administrator: any other role obtained that way would be a privilege
   * escalation path that skipped both membership and permission checks.
   */
  bootstrappable: boolean;
  permissionKeys: readonly string[];
};

/**
 * A duty pair no single principal may hold.
 *
 * Stated once here, and mirrored by the route table's `segregatedFrom`
 * declarations so a request carries its own conflict set. The two are kept in step
 * by a test rather than by convention.
 */
export type SegregationDefinition = {
  ruleKey: string;
  firstPermission: string;
  conflictingPermission: string;
  severity: 'HIGH' | 'CRITICAL';
  rationale: string;
};

/**
 * The duty pairs that must hold in every workspace.
 *
 * Each is a case where one principal completing both steps would remove the only
 * independent check on money leaving, or on work being declared done by whoever
 * did it.
 */
export const SEGREGATION_CATALOGUE: readonly SegregationDefinition[] = Object.freeze([
  {
    ruleKey: 'release-approval-vs-payment-execution',
    firstPermission: 'release-requests:evaluate',
    conflictingPermission: 'payment-instructions:submit',
    severity: 'CRITICAL',
    rationale:
      'Approving a release and submitting the instruction that moves the money is the primary maker-checker boundary in settlement.',
  },
  {
    ruleKey: 'authorization-vs-payment-execution',
    firstPermission: 'authorization-decisions:approve',
    conflictingPermission: 'payment-instructions:submit',
    severity: 'CRITICAL',
    rationale:
      'Authorising the underlying transaction and executing it would let one principal originate and complete a payment.',
  },
  {
    ruleKey: 'reservation-release-vs-release-approval',
    firstPermission: 'fund-reservations:release',
    conflictingPermission: 'release-requests:evaluate',
    severity: 'CRITICAL',
    rationale:
      'Releasing a reservation at the provider is treasury operation; approving the release request is the control over it.',
  },
  {
    ruleKey: 'invoice-origination-vs-approval',
    firstPermission: 'invoices:create',
    conflictingPermission: 'invoices:approve',
    severity: 'HIGH',
    rationale: 'Raising an invoice and approving it is self-approval of a claim for payment.',
  },
  {
    ruleKey: 'certification-request-vs-decision',
    firstPermission: 'certification-requests:create',
    conflictingPermission: 'certification-requests:decide',
    severity: 'HIGH',
    rationale:
      'Certification is the evidence that work is done; whoever asks for it must not be the one who grants it.',
  },
]);

/**
 * The roles the platform grants, and the keys each holds.
 *
 * Keys are enumerated rather than derived from a verb grammar. `submit` is
 * authoring on a contract draft and money movement on a payment instruction, so
 * any rule that assigned keys by verb would hand payment execution to whoever
 * drafts contracts. The cost of enumeration is that a new route must be added to a
 * role; that is the intended cost, and a test makes forgetting it fail.
 */
export const PERMISSION_CATALOGUE: readonly RoleDefinition[] = Object.freeze([
  {
    role: 'WORKSPACE_ADMINISTRATOR',
    title: 'Workspace administrator',
    rationale:
      'Founding role. Administers the workspace — onboarding, role assignment, legal policy — and deliberately holds no certification, release or payment key, so founding a workspace does not create a principal who can move money alone.',
    bootstrappable: true,
    permissionKeys: [
      'workspaces:create',
      'workspaces:activate-context',
      'organizations:create',
      'parties:create',
      'parties:request-verification',
      'permissions:evaluate',
      'legal:create',
      'legal:accept',
      'contract-templates:create-version',
      'approval-thresholds:create',
      'kpi-definitions:create',
      'kpi-definitions:retire',
      'model-registrations:create',
      'model-registrations:deprecate',
    ],
  },
  {
    role: 'CONTRACT_AUTHOR',
    title: 'Contract author',
    rationale:
      'Drafts and negotiates agreements. Cannot approve what it drafts: contract approval and authorization decisions belong to CONTRACT_APPROVER.',
    bootstrappable: false,
    permissionKeys: [
      'agreement-contracts:create',
      'agreement-intelligence:create',
      'agreement-intelligence:publish',
      'clauses:create',
      'contract-analysis:create',
      'contract-drafts:submit',
      'contract-repository:search',
      'contract-risks:create',
      'contract-versions:create',
      'contracts:create',
      'contracts:read',
      'negotiation-rounds:create',
      'signature-packages:create',
      'renewal-assessments:create',
      'approval-requests:create',
      'change-requests:create',
      'change-requests:submit',
    ],
  },
  {
    role: 'CONTRACT_APPROVER',
    title: 'Contract approver',
    rationale:
      'Independent decision on agreements and change. Holds authorization-decisions:approve, which segregation rules keep apart from payment execution.',
    bootstrappable: false,
    permissionKeys: [
      'contracts:approve',
      'contracts:read',
      'authorization-decisions:create',
      'authorization-decisions:approve',
      'authorization-decisions:reject',
      'approval-requests:decide',
      'change-requests:decide',
      'change-requests:implement',
      'recommendations:create',
      'recommendations:decide',
    ],
  },
  {
    role: 'PERFORMANCE_PLANNER',
    title: 'Performance planner',
    rationale:
      'Defines what done means before execution starts — blueprints, milestones, definition-of-done packages, acceptance criteria and quality plans. Writes the standard, does not judge against it.',
    bootstrappable: false,
    permissionKeys: [
      'performance-blueprints:create',
      'performance-blueprints:activate',
      'blueprint-milestones:create',
      'blueprint-milestones:declare-dependencies',
      'blueprint-milestones:compute-critical-path',
      'milestones:create',
      'milestones:assurance',
      'definitions-of-done:create',
      'definitions-of-done:publish',
      'definitions-of-done:evaluate',
      'definition-of-done-packages:create',
      'definition-of-done-packages:publish',
      'acceptance-criteria:create',
      'acceptance-criteria:confirm',
      'deliverables:create',
      'deliverables:confirm',
      'scope-items:create',
      'scope-items:confirm',
      'success-metrics:create',
      'success-metrics:confirm',
      'evidence-requirements:create',
      'quality-plans:create',
      'validation-tests:create',
      'evaluation-records:create',
      'performance-baselines:create',
      'performance-baselines:record-variance',
      'dependencies:create',
    ],
  },
  {
    role: 'EXECUTION_MANAGER',
    title: 'Execution manager',
    rationale:
      'Runs the work and reports on it. Raises certification requests but cannot decide them, which is the certification segregation rule.',
    bootstrappable: false,
    permissionKeys: [
      'execution-workspaces:create',
      'execution-workspaces:activate',
      'execution-workspaces:suspend',
      'execution-workspaces:resume',
      'execution-workspaces:submit',
      'executions:create',
      'executions:transition',
      'work-items:create',
      'work-items:transition',
      'progress-records:create',
      'issues:create',
      'issues:escalate',
      'issues:close',
      'defects:create',
      'defects:resolve',
      'defects:close',
      'defects:record-root-cause',
      'inspections:create',
      'inspections:complete',
      'corrective-action-plans:create',
      'corrective-action-plans:complete',
      'corrective-action-plans:verify',
      'drift-alerts:create',
      'drift-alerts:acknowledge',
      'drift-alerts:resolve',
      'quality-gate-evaluations:create',
      'dependencies:resolve',
      'certification-requests:create',
      'evidence-packages:create',
      'change-requests:implement',
    ],
  },
  {
    role: 'CERTIFIER',
    title: 'Completion certifier',
    rationale:
      'Independently judges whether work meets its definition of done, and establishes payment eligibility. Cannot raise the certification request it decides, and holds no release or payment key.',
    bootstrappable: false,
    permissionKeys: [
      'certification-requests:decide',
      'certification-requests:issue',
      'completion-certificates:create',
      'completion-certificates:verify',
      'completion-certificates:revoke',
      'evidence-packages:verify',
      'acceptance-decisions:create',
      'payment-eligibilities:create',
      'payment-eligibility:blockers',
      'payment-triggers:create',
      'payment-triggers:propose',
      'payment-triggers:evaluate',
      'payment-trigger-rules:create',
      'payment-trigger-rules:activate',
      'payment-trigger-rules:evaluate',
    ],
  },
  {
    role: 'SETTLEMENT_APPROVER',
    title: 'Settlement approver',
    rationale:
      'Approves entitlement and release against certified work. Segregated from payment execution and from releasing the reservation itself, so approval and disbursement are never the same principal.',
    bootstrappable: false,
    permissionKeys: [
      'financial-entitlements:create',
      'financial-entitlements:confirm',
      'funding-commitments:create',
      'funding-commitments:confirm',
      'release-requests:create',
      'release-requests:evaluate',
      'release-requests:cancel',
      'invoices:approve',
      'invoices:reject',
    ],
  },
  {
    role: 'PAYMENT_OPERATOR',
    title: 'Payment operator',
    rationale:
      'Executes instructions against the certified Financial Provider and keeps the books. Segregated from every approval key: this role can move money the platform has already authorized, and cannot authorize it.',
    bootstrappable: false,
    permissionKeys: [
      'payment-instructions:create',
      'payment-instructions:submit',
      'payment-instructions:refresh-status',
      'payment-instructions:reverse',
      'fund-reservations:create',
      'fund-reservations:release',
      'fund-reservations:cancel',
      'ledger-entries:create',
      'reconciliation-records:create',
      'final-settlement-accounts:create',
      'final-settlement-accounts:close',
      'financial-closure-certificates:create',
      'invoices:create',
    ],
  },
  {
    role: 'DISPUTE_MANAGER',
    title: 'Dispute manager',
    rationale:
      'Handles contested execution end to end. Kept separate from settlement so a dispute outcome is not decided by whoever benefits from releasing.',
    bootstrappable: false,
    permissionKeys: [
      'disputes:create',
      'disputes:add-evidence',
      'disputes:add-position',
      'disputes:decide',
      'disputes:appeal',
      'disputes:close',
    ],
  },
  {
    role: 'ASSURANCE_ANALYST',
    title: 'Assurance analyst',
    rationale:
      'Produces the intelligence and reporting surface. Reads and derives; holds no key that changes contract, certification or settlement state.',
    bootstrappable: false,
    permissionKeys: [
      'contracts:read',
      'contract-repository:search',
      'dashboard-snapshots:create',
      'portfolio-snapshots:create',
      'performance-scorecards:create',
      'execution-assurance-indices:create',
      'settlement-assurance-indices:create',
      'execution-forecasts:create',
      'execution-forecasts:review',
      'financial-forecasts:create',
      'financial-forecasts:review',
      'kpi-values:create',
      'model-feedback:create',
      'workflow-intelligence:create',
    ],
  },
]);

/** Every key any role may grant. A key absent here cannot be granted at all. */
export function catalogueKeys(): string[] {
  return [
    ...new Set(PERMISSION_CATALOGUE.flatMap((definition) => [...definition.permissionKeys])),
  ].sort();
}

/** Role names, sorted, for configuration validation and operator tooling. */
export function catalogueRoles(): string[] {
  return PERMISSION_CATALOGUE.map((definition) => definition.role).sort();
}

/** Resolves a role by name, failing with a stable code rather than returning undefined. */
export function requireRole(role: string): RoleDefinition {
  const definition = PERMISSION_CATALOGUE.find((entry) => entry.role === role);
  if (!definition) {
    throw new CatalogueError('CATALOGUE_UNKNOWN_ROLE', role);
  }
  return definition;
}

/**
 * The duty pairs fully contained in a permission set.
 *
 * Order-insensitive: a rule is breached whether the principal acquired the
 * approval key or the execution key first.
 */
export function segregationConflicts(
  permissionKeys: Iterable<string>,
): SegregationDefinition[] {
  const held = new Set(permissionKeys);
  return SEGREGATION_CATALOGUE.filter(
    (rule) => held.has(rule.firstPermission) && held.has(rule.conflictingPermission),
  );
}

export type CatalogueConfig = {
  /**
   * Whether the unauthenticated founding path is available. A deployment that
   * provisions workspaces and grants externally turns it off, so the one code path
   * that grants without a caller cannot be reached at all.
   */
  bootstrapEnabled: boolean;
  /** The role the founding path grants. Must be a bootstrappable catalogue role. */
  bootstrapRole: string;
};

const DEFAULT_BOOTSTRAP_ROLE = 'WORKSPACE_ADMINISTRATOR';

/**
 * Reads catalogue configuration, defaulting to a founding path that is available
 * but narrow.
 *
 * Defaulting it off would leave a fresh deployment with no way to obtain the first
 * administrator, which in practice invites a hand-written grant with none of the
 * guards below. The path is defaulted on and constrained instead: one workspace,
 * one already-active owner membership, one bootstrappable role, once.
 */
export function loadCatalogueConfig(
  env: Record<string, string | undefined> = {},
): CatalogueConfig {
  const flag = env.PERMISSION_BOOTSTRAP_ENABLED?.trim().toLowerCase();
  if (flag !== undefined && !['true', 'false', '1', '0', ''].includes(flag)) {
    throw new CatalogueError(
      'CATALOGUE_CONFIG_INVALID',
      'PERMISSION_BOOTSTRAP_ENABLED must be true or false',
    );
  }

  const bootstrapRole = env.PERMISSION_BOOTSTRAP_ROLE?.trim() || DEFAULT_BOOTSTRAP_ROLE;
  const definition = PERMISSION_CATALOGUE.find((entry) => entry.role === bootstrapRole);
  if (!definition) {
    throw new CatalogueError('CATALOGUE_CONFIG_INVALID', `unknown role ${bootstrapRole}`);
  }
  if (!definition.bootstrappable) {
    throw new CatalogueError(
      'CATALOGUE_CONFIG_INVALID',
      `${bootstrapRole} may not be granted without an authorizing caller`,
    );
  }

  return {
    bootstrapEnabled: flag === undefined || flag === '' ? true : ['true', '1'].includes(flag),
    bootstrapRole,
  };
}

/**
 * The membership record, read structurally.
 *
 * `packages/permissions` is a trust-foundation package and may not import
 * `@assurapay/organizations`, so only the fields the catalogue reads are named.
 */
type MembershipRecord = {
  workspaceId: string;
  userId: string;
  membershipType: string;
  status: string;
};

export type WorkspaceBootstrap = {
  workspaceId: string;
  founderUserId: string;
  role: string;
  permissionKeys: string[];
  grantIds: string[];
  segregationRuleIds: string[];
};

export type BootstrapInput = {
  tenantId: string;
  workspaceId: string;
  founderUserId: string;
  correlationId: string;
  /** Defaults to the configured bootstrap role. */
  role?: string;
  effectiveFrom?: string;
  now?: () => Date;
};

/**
 * Grants the founding administrator, and installs the segregation rules every
 * workspace must carry.
 *
 * This is the only path that creates a grant with no authorizing caller, so every
 * one of its preconditions is a refusal rather than a warning:
 *
 *   1. the founding path is enabled by configuration;
 *   2. the role is one the catalogue marks bootstrappable;
 *   3. the founder already holds an ACTIVE OWNER membership in the workspace —
 *      this does not create membership, it requires one, so founding cannot invent
 *      a principal;
 *   4. the workspace holds no permission grant yet.
 *
 * The fourth is what keeps it from being a standing escalation route: once any
 * grant exists the workspace has an administrator, and further roles go through
 * `grantRole` with a caller who must already be permitted.
 *
 * Segregation rules are installed before the grants they constrain, so no window
 * exists in which the founding grants are in place and the rules are not.
 */
export function bootstrapWorkspaceGrants(
  store: TrustPersistence,
  input: BootstrapInput,
  config: CatalogueConfig = loadCatalogueConfig(),
): WorkspaceBootstrap {
  if (!config.bootstrapEnabled) {
    throw new CatalogueError(
      'CATALOGUE_BOOTSTRAP_DISABLED',
      'PERMISSION_BOOTSTRAP_ENABLED is false',
    );
  }

  const definition = requireRole(input.role ?? config.bootstrapRole);
  if (!definition.bootstrappable) {
    throw new CatalogueError('CATALOGUE_ROLE_NOT_BOOTSTRAPPABLE', definition.role);
  }

  const membership = store
    .list<MembershipRecord>('memberships')
    .find(
      (record) =>
        record.workspaceId === input.workspaceId &&
        record.userId === input.founderUserId &&
        record.membershipType === 'OWNER' &&
        record.status === 'ACTIVE',
    );
  if (!membership) {
    throw new CatalogueError(
      'CATALOGUE_MEMBERSHIP_REQUIRED',
      `${input.founderUserId} is not an active owner of ${input.workspaceId}`,
    );
  }

  const existing = store
    .list<PermissionGrant>('permissionGrants')
    .some((grant) => grant.workspaceId === input.workspaceId);
  if (existing) {
    throw new CatalogueError('CATALOGUE_ALREADY_BOOTSTRAPPED', input.workspaceId);
  }

  const clock = input.now ?? (() => new Date());
  const createdAt = clock().toISOString();
  const effectiveFrom = input.effectiveFrom ?? createdAt;

  const segregationRuleIds = installSegregationRules(store, input.workspaceId, createdAt);

  const grantIds = definition.permissionKeys.map((permissionKey) => {
    const grant: PermissionGrant = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      userId: input.founderUserId,
      permissionKey,
      effect: 'ALLOW',
      scopeType: 'WORKSPACE',
      sourceType: 'ROLE',
      sourceId: definition.role,
      effectiveFrom,
      createdAt,
    };
    store.append('permissionGrants', grant);
    return grant.id;
  });

  // One audit record for the founding act, plus the per-grant trail the service
  // writes on the ordinary path. The founding record is what an auditor looks for
  // to answer "where did this workspace's first authority come from".
  store.audit({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    actorId: input.founderUserId,
    eventType: 'WorkspaceGrantsBootstrapped',
    aggregateType: 'PermissionGrant',
    aggregateId: input.workspaceId,
    correlationId: input.correlationId,
    metadata: {
      role: definition.role,
      permissionKeys: [...definition.permissionKeys],
      grantCount: grantIds.length,
      segregationRuleCount: segregationRuleIds.length,
      authorizedBy: 'FOUNDING_MEMBERSHIP',
    },
  });

  store.emit({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    aggregateType: 'PermissionGrant',
    aggregateId: input.workspaceId,
    eventType: 'WorkspaceGrantsBootstrapped',
    eventVersion: 1,
    payload: { role: definition.role, founderUserId: input.founderUserId },
    correlationId: input.correlationId,
  });

  return {
    workspaceId: input.workspaceId,
    founderUserId: input.founderUserId,
    role: definition.role,
    permissionKeys: [...definition.permissionKeys],
    grantIds,
    segregationRuleIds,
  };
}

/**
 * Installs any catalogue segregation rule the workspace is missing.
 *
 * Additive by rule key: an existing rule is left alone rather than replaced, since
 * a workspace may have tightened `enforcementMode` and rewriting it here would
 * quietly loosen a control.
 */
function installSegregationRules(
  store: TrustPersistence,
  workspaceId: string,
  createdAt: string,
): string[] {
  const present = new Set(
    store
      .list<SegregationRule>('segregationRules')
      .filter((rule) => rule.workspaceId === workspaceId)
      .map((rule) => rule.ruleKey),
  );

  return SEGREGATION_CATALOGUE.filter((definition) => !present.has(definition.ruleKey)).map(
    (definition) => {
      const rule: SegregationRule = {
        id: randomUUID(),
        workspaceId,
        ruleKey: definition.ruleKey,
        firstPermission: definition.firstPermission,
        conflictingPermission: definition.conflictingPermission,
        severity: definition.severity,
        enforcementMode: 'BLOCK',
        status: 'ACTIVE',
        createdAt,
        version: 1,
      };
      store.append('segregationRules', rule);
      return rule.id;
    },
  );
}

/**
 * The permission surface `grantRole` needs.
 *
 * Structural rather than a concrete import of `PermissionService`, so the
 * catalogue does not create an import cycle inside the package and can be tested
 * against a stub.
 */
export interface RoleGrantAuthority {
  grant(
    context: RequestContext,
    input: Omit<PermissionGrant, 'id' | 'workspaceId' | 'createdAt'>,
  ): PermissionGrant;
  evaluate(
    context: RequestContext,
    permissionKey: string,
    scopeId?: string,
  ): PermissionDecision;
}

export type GrantRoleInput = {
  userId: string;
  role: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  scopeType?: string;
  scopeId?: string;
};

/**
 * Grants a role to a user on the ordinary, authorized path.
 *
 * The caller's own authority is checked by enforcement before this is reached; what
 * this adds is the check enforcement cannot make, because enforcement sees one
 * request at a time: whether the *resulting* permission set breaches segregation of
 * duties. Refusing here is preventive — the conflicting state is never written —
 * and leaves the enforcement-time check as a second line rather than the only one.
 *
 * Keys already held are not re-granted. A repeated call is therefore a no-op rather
 * than a growing pile of duplicate grants, and the returned list says what actually
 * changed.
 */
export function grantRole(
  authority: RoleGrantAuthority,
  store: TrustPersistence,
  context: RequestContext,
  input: GrantRoleInput,
): PermissionGrant[] {
  requireActiveWorkspace(context);
  const definition = requireRole(input.role);

  const held = heldPermissionKeys(store, context.activeWorkspaceId, input.userId);
  const conflicts = segregationConflicts([...held, ...definition.permissionKeys]);
  if (conflicts.length > 0) {
    store.audit({
      tenantId: context.tenantId,
      workspaceId: context.activeWorkspaceId,
      actorId: context.actorUserId,
      eventType: 'SegregationOfDutiesViolationDetected',
      aggregateType: 'PermissionGrant',
      aggregateId: input.userId,
      correlationId: context.correlationId,
      metadata: {
        role: definition.role,
        ruleKeys: conflicts.map((conflict) => conflict.ruleKey),
        blockedAt: 'GRANT',
      },
    });
    throw new CatalogueError(
      'CATALOGUE_SEGREGATION_CONFLICT',
      conflicts.map((conflict) => conflict.ruleKey).join(','),
    );
  }

  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();

  return definition.permissionKeys
    .filter((permissionKey) => !held.has(permissionKey))
    .map((permissionKey) =>
      authority.grant(context, {
        userId: input.userId,
        permissionKey,
        effect: 'ALLOW',
        scopeType: input.scopeType ?? 'WORKSPACE',
        scopeId: input.scopeId,
        sourceType: 'ROLE',
        sourceId: definition.role,
        effectiveFrom,
        effectiveTo: input.effectiveTo,
      }),
    );
}

/**
 * The permission keys a user currently holds in a workspace.
 *
 * Read from grants rather than from role membership, because delegation writes
 * grants without a role: a delegated payment key must count towards a segregation
 * conflict just as a role-granted one does.
 */
export function heldPermissionKeys(
  store: TrustPersistence,
  workspaceId: string,
  userId: string,
  at: Date = new Date(),
): Set<string> {
  const now = at.getTime();
  return new Set(
    store
      .list<PermissionGrant>('permissionGrants')
      .filter(
        (grant) =>
          grant.workspaceId === workspaceId &&
          grant.userId === userId &&
          grant.effect === 'ALLOW' &&
          Date.parse(grant.effectiveFrom) <= now &&
          (!grant.effectiveTo || Date.parse(grant.effectiveTo) > now),
      )
      .map((grant) => grant.permissionKey),
  );
}

import type { PermissionRequirement } from '@assurapay/permissions';

/**
 * Engine 03 — route-level permission policy.
 *
 * The authorization policy table for the HTTP surface. Every route is classified
 * explicitly; there is no default that lets an unmapped route through.
 *
 * This module is deliberately pure — a table and a resolver, no engines and no
 * composition-root imports — so the policy can be tested and reviewed on its own.
 * Enforcement lives in `trust-app.ts`, which composes this with the identity
 * gateway and the permission authority.
 *
 * ## Three classes, stated rather than inferred
 *
 * - `public` — no authentication. Only sign-in and registration: you cannot be
 *   authenticated in order to authenticate.
 * - `identity` — authenticated, no permission required. Reserved for routes that
 *   read the caller's own identity or membership. Requiring a permission here
 *   would be circular, since permission evaluation needs membership.
 * - `permission` — an explicit `resource:action` requirement, deny-by-default.
 *
 * ## Keys
 *
 * `resource:action`, where resource is the collection segment and action is the
 * operation. A trailing path segment names the action (`/[id]/approve` →
 * `approve`); a bare collection takes `create` for POST and `read` for GET.
 * Noun-shaped segments are normalised to the verb they perform, so
 * `/[id]/decisions` is `decide`, not `decisions`.
 *
 * ## Segregation of duties
 *
 * Money movement carries explicit conflicts, per CLAUDE.md constraint 2: the
 * principal who approves a release may not be the one who executes the payment,
 * and the principal who drafts an artefact may not be the one who decides it.
 * These are checked through the permission authority's segregation rules, so an
 * empty rule set means they are recorded here but not yet enforced by data.
 */

export type RouteAccess =
  | { access: 'public' }
  | { access: 'identity' }
  | ({ access: 'permission' } & PermissionRequirement);

export type RouteAccessErrorCode = 'ROUTE_NOT_MAPPED' | 'ROUTE_METHOD_NOT_MAPPED';

/**
 * Raised when no policy covers a request. Fail closed: an unmapped route is a
 * denial, never an implicit allow, so adding a route without a policy entry is a
 * visible failure rather than a silent hole.
 */
export class RouteAccessError extends Error {
  readonly code: RouteAccessErrorCode;
  readonly detail?: string;

  constructor(code: RouteAccessErrorCode, detail?: string) {
    super(code);
    this.name = 'RouteAccessError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Policy table, keyed `<route template>|<method>`. `[id]` and other bracketed
 * segments match exactly one path segment.
 *
 * Generated from the route tree and reviewed by hand; regenerate deliberately, not
 * automatically, because a permission key is a policy decision.
 */
export const ROUTE_PERMISSION_REQUIREMENTS: Readonly<Record<string, RouteAccess>> = {
  '/api/v1/acceptance-criteria/[id]/confirm|POST': { access: 'permission', permissionKey: 'acceptance-criteria:confirm' },
  '/api/v1/acceptance-criteria|POST': { access: 'permission', permissionKey: 'acceptance-criteria:create' },
  '/api/v1/acceptance-decisions|POST': { access: 'permission', permissionKey: 'acceptance-decisions:create' },
  '/api/v1/agreement-contracts|POST': { access: 'permission', permissionKey: 'agreement-contracts:create' },
  '/api/v1/agreement-intelligence/[id]/publish|POST': { access: 'permission', permissionKey: 'agreement-intelligence:publish' },
  '/api/v1/agreement-intelligence|POST': { access: 'permission', permissionKey: 'agreement-intelligence:create' },
  '/api/v1/approval-requests/[id]/decisions|POST': { access: 'permission', permissionKey: 'approval-requests:decide' },
  '/api/v1/approval-requests|POST': { access: 'permission', permissionKey: 'approval-requests:create' },
  '/api/v1/approval-thresholds|POST': { access: 'permission', permissionKey: 'approval-thresholds:create' },
  '/api/v1/auth/login|POST': { access: 'public' },
  '/api/v1/auth/logout|POST': { access: 'identity' },
  '/api/v1/auth/register|POST': { access: 'public' },
  '/api/v1/auth/session|GET': { access: 'identity' },
  '/api/v1/authorization-decisions/[id]/approve|POST': { access: 'permission', permissionKey: 'authorization-decisions:approve', segregatedFrom: ['payment-instructions:submit'] },
  '/api/v1/authorization-decisions/[id]/reject|POST': { access: 'permission', permissionKey: 'authorization-decisions:reject' },
  '/api/v1/authorization-decisions|POST': { access: 'permission', permissionKey: 'authorization-decisions:create' },
  '/api/v1/blueprint-milestones/critical-path|POST': { access: 'permission', permissionKey: 'blueprint-milestones:compute-critical-path' },
  '/api/v1/blueprint-milestones/dependencies|POST': { access: 'permission', permissionKey: 'blueprint-milestones:declare-dependencies' },
  '/api/v1/blueprint-milestones|POST': { access: 'permission', permissionKey: 'blueprint-milestones:create' },
  '/api/v1/certification-requests/[id]/decisions|POST': { access: 'permission', permissionKey: 'certification-requests:decide', segregatedFrom: ['certification-requests:create'] },
  '/api/v1/certification-requests/[id]/issue|POST': { access: 'permission', permissionKey: 'certification-requests:issue' },
  '/api/v1/certification-requests|POST': { access: 'permission', permissionKey: 'certification-requests:create' },
  '/api/v1/change-requests/[id]/decide|POST': { access: 'permission', permissionKey: 'change-requests:decide' },
  '/api/v1/change-requests/[id]/implement|POST': { access: 'permission', permissionKey: 'change-requests:implement' },
  '/api/v1/change-requests/[id]/submit|POST': { access: 'permission', permissionKey: 'change-requests:submit' },
  '/api/v1/change-requests|POST': { access: 'permission', permissionKey: 'change-requests:create' },
  '/api/v1/clauses|POST': { access: 'permission', permissionKey: 'clauses:create' },
  '/api/v1/completion-certificates/[id]/revoke|POST': { access: 'permission', permissionKey: 'completion-certificates:revoke' },
  '/api/v1/completion-certificates/[id]/verification|POST': { access: 'permission', permissionKey: 'completion-certificates:verify' },
  '/api/v1/completion-certificates/[id]/verify|GET': { access: 'permission', permissionKey: 'completion-certificates:verify' },
  '/api/v1/completion-certificates|POST': { access: 'permission', permissionKey: 'completion-certificates:create' },
  '/api/v1/contract-analysis|POST': { access: 'permission', permissionKey: 'contract-analysis:create' },
  '/api/v1/contract-drafts/[id]/submit|POST': { access: 'permission', permissionKey: 'contract-drafts:submit' },
  '/api/v1/contract-repository/search|POST': { access: 'permission', permissionKey: 'contract-repository:search' },
  '/api/v1/contract-risks|POST': { access: 'permission', permissionKey: 'contract-risks:create' },
  '/api/v1/contract-templates/versions|POST': { access: 'permission', permissionKey: 'contract-templates:create-version' },
  '/api/v1/contract-versions|POST': { access: 'permission', permissionKey: 'contract-versions:create' },
  '/api/v1/contracts/[id]/approve|POST': { access: 'permission', permissionKey: 'contracts:approve' },
  '/api/v1/contracts|GET': { access: 'permission', permissionKey: 'contracts:read' },
  '/api/v1/contracts|POST': { access: 'permission', permissionKey: 'contracts:create' },
  '/api/v1/corrective-action-plans/[id]/complete|POST': { access: 'permission', permissionKey: 'corrective-action-plans:complete' },
  '/api/v1/corrective-action-plans/[id]/verify|POST': { access: 'permission', permissionKey: 'corrective-action-plans:verify' },
  '/api/v1/corrective-action-plans|POST': { access: 'permission', permissionKey: 'corrective-action-plans:create' },
  '/api/v1/dashboard-snapshots|POST': { access: 'permission', permissionKey: 'dashboard-snapshots:create' },
  '/api/v1/defects/[id]/close|POST': { access: 'permission', permissionKey: 'defects:close' },
  '/api/v1/defects/[id]/resolve|POST': { access: 'permission', permissionKey: 'defects:resolve' },
  '/api/v1/defects/[id]/root-cause|POST': { access: 'permission', permissionKey: 'defects:record-root-cause' },
  '/api/v1/defects|POST': { access: 'permission', permissionKey: 'defects:create' },
  '/api/v1/definition-of-done-packages/[id]/publish|POST': { access: 'permission', permissionKey: 'definition-of-done-packages:publish' },
  '/api/v1/definition-of-done-packages|POST': { access: 'permission', permissionKey: 'definition-of-done-packages:create' },
  '/api/v1/definitions-of-done/[id]/evaluate|POST': { access: 'permission', permissionKey: 'definitions-of-done:evaluate' },
  '/api/v1/definitions-of-done/[id]/publish|POST': { access: 'permission', permissionKey: 'definitions-of-done:publish' },
  '/api/v1/definitions-of-done|POST': { access: 'permission', permissionKey: 'definitions-of-done:create' },
  '/api/v1/deliverables/[id]/confirm|POST': { access: 'permission', permissionKey: 'deliverables:confirm' },
  '/api/v1/deliverables|POST': { access: 'permission', permissionKey: 'deliverables:create' },
  '/api/v1/dependencies/[id]/resolve|POST': { access: 'permission', permissionKey: 'dependencies:resolve' },
  '/api/v1/dependencies|POST': { access: 'permission', permissionKey: 'dependencies:create' },
  '/api/v1/disputes/[id]/appeal|POST': { access: 'permission', permissionKey: 'disputes:appeal' },
  '/api/v1/disputes/[id]/close|POST': { access: 'permission', permissionKey: 'disputes:close' },
  '/api/v1/disputes/[id]/decide|POST': { access: 'permission', permissionKey: 'disputes:decide' },
  '/api/v1/disputes/[id]/evidence|POST': { access: 'permission', permissionKey: 'disputes:add-evidence' },
  '/api/v1/disputes/[id]/positions|POST': { access: 'permission', permissionKey: 'disputes:add-position' },
  '/api/v1/disputes|POST': { access: 'permission', permissionKey: 'disputes:create' },
  '/api/v1/drift-alerts/[id]/acknowledge|POST': { access: 'permission', permissionKey: 'drift-alerts:acknowledge' },
  '/api/v1/drift-alerts/[id]/resolve|POST': { access: 'permission', permissionKey: 'drift-alerts:resolve' },
  '/api/v1/drift-alerts|POST': { access: 'permission', permissionKey: 'drift-alerts:create' },
  '/api/v1/evaluation-records|POST': { access: 'permission', permissionKey: 'evaluation-records:create' },
  '/api/v1/evidence-packages/[id]/verify|POST': { access: 'permission', permissionKey: 'evidence-packages:verify' },
  '/api/v1/evidence-packages|POST': { access: 'permission', permissionKey: 'evidence-packages:create' },
  '/api/v1/evidence-requirements|POST': { access: 'permission', permissionKey: 'evidence-requirements:create' },
  '/api/v1/execution-assurance-indices|POST': { access: 'permission', permissionKey: 'execution-assurance-indices:create' },
  '/api/v1/execution-forecasts/[id]/review|POST': { access: 'permission', permissionKey: 'execution-forecasts:review' },
  '/api/v1/execution-forecasts|POST': { access: 'permission', permissionKey: 'execution-forecasts:create' },
  '/api/v1/execution-workspaces/[id]/activate|POST': { access: 'permission', permissionKey: 'execution-workspaces:activate' },
  '/api/v1/execution-workspaces/[id]/resume|POST': { access: 'permission', permissionKey: 'execution-workspaces:resume' },
  '/api/v1/execution-workspaces/[id]/submit|POST': { access: 'permission', permissionKey: 'execution-workspaces:submit' },
  '/api/v1/execution-workspaces/[id]/suspend|POST': { access: 'permission', permissionKey: 'execution-workspaces:suspend' },
  '/api/v1/execution-workspaces|POST': { access: 'permission', permissionKey: 'execution-workspaces:create' },
  '/api/v1/executions/[id]/transition|POST': { access: 'permission', permissionKey: 'executions:transition' },
  '/api/v1/executions|POST': { access: 'permission', permissionKey: 'executions:create' },
  '/api/v1/final-settlement-accounts/[id]/close|POST': { access: 'permission', permissionKey: 'final-settlement-accounts:close' },
  '/api/v1/final-settlement-accounts|POST': { access: 'permission', permissionKey: 'final-settlement-accounts:create' },
  '/api/v1/financial-closure-certificates|POST': { access: 'permission', permissionKey: 'financial-closure-certificates:create' },
  '/api/v1/financial-entitlements/[id]/confirm|POST': { access: 'permission', permissionKey: 'financial-entitlements:confirm' },
  '/api/v1/financial-entitlements|POST': { access: 'permission', permissionKey: 'financial-entitlements:create' },
  '/api/v1/financial-forecasts/[id]/review|POST': { access: 'permission', permissionKey: 'financial-forecasts:review' },
  '/api/v1/financial-forecasts|POST': { access: 'permission', permissionKey: 'financial-forecasts:create' },
  '/api/v1/fund-reservations/[id]/cancel|POST': { access: 'permission', permissionKey: 'fund-reservations:cancel' },
  '/api/v1/fund-reservations/[id]/release|POST': { access: 'permission', permissionKey: 'fund-reservations:release', segregatedFrom: ['release-requests:evaluate'] },
  '/api/v1/fund-reservations|POST': { access: 'permission', permissionKey: 'fund-reservations:create' },
  '/api/v1/funding-commitments/[id]/confirm|POST': { access: 'permission', permissionKey: 'funding-commitments:confirm' },
  '/api/v1/funding-commitments|POST': { access: 'permission', permissionKey: 'funding-commitments:create' },
  '/api/v1/inspections/[id]/complete|POST': { access: 'permission', permissionKey: 'inspections:complete' },
  '/api/v1/inspections|POST': { access: 'permission', permissionKey: 'inspections:create' },
  '/api/v1/invoices/[id]/approve|POST': { access: 'permission', permissionKey: 'invoices:approve', segregatedFrom: ['invoices:create'] },
  '/api/v1/invoices/[id]/reject|POST': { access: 'permission', permissionKey: 'invoices:reject' },
  '/api/v1/invoices|POST': { access: 'permission', permissionKey: 'invoices:create' },
  '/api/v1/issues/[id]/close|POST': { access: 'permission', permissionKey: 'issues:close' },
  '/api/v1/issues/[id]/escalate|POST': { access: 'permission', permissionKey: 'issues:escalate' },
  '/api/v1/issues|POST': { access: 'permission', permissionKey: 'issues:create' },
  '/api/v1/kpi-definitions/[id]/retire|POST': { access: 'permission', permissionKey: 'kpi-definitions:retire' },
  '/api/v1/kpi-definitions|POST': { access: 'permission', permissionKey: 'kpi-definitions:create' },
  '/api/v1/kpi-values|POST': { access: 'permission', permissionKey: 'kpi-values:create' },
  '/api/v1/ledger-entries|POST': { access: 'permission', permissionKey: 'ledger-entries:create' },
  '/api/v1/legal/holds|POST': { access: 'permission', permissionKey: 'legal:create' },
  '/api/v1/legal/policies|POST': { access: 'permission', permissionKey: 'legal:create' },
  '/api/v1/legal/policy-versions/[id]/accept|POST': { access: 'permission', permissionKey: 'legal:accept' },
  '/api/v1/me/workspaces|GET': { access: 'identity' },
  '/api/v1/milestones/[id]/assurance|GET': { access: 'permission', permissionKey: 'milestones:assurance' },
  '/api/v1/milestones|POST': { access: 'permission', permissionKey: 'milestones:create' },
  '/api/v1/model-feedback|POST': { access: 'permission', permissionKey: 'model-feedback:create' },
  '/api/v1/model-registrations/[id]/deprecate|POST': { access: 'permission', permissionKey: 'model-registrations:deprecate' },
  '/api/v1/model-registrations|POST': { access: 'permission', permissionKey: 'model-registrations:create' },
  '/api/v1/negotiation-rounds|POST': { access: 'permission', permissionKey: 'negotiation-rounds:create' },
  '/api/v1/organizations|POST': { access: 'permission', permissionKey: 'organizations:create' },
  '/api/v1/parties/[id]/verification-requests|POST': { access: 'permission', permissionKey: 'parties:request-verification' },
  '/api/v1/parties|POST': { access: 'permission', permissionKey: 'parties:create' },
  '/api/v1/payment-eligibilities|POST': { access: 'permission', permissionKey: 'payment-eligibilities:create' },
  '/api/v1/payment-eligibility/[id]/blockers|GET': { access: 'permission', permissionKey: 'payment-eligibility:blockers' },
  '/api/v1/payment-instructions/[id]/refresh-status|POST': { access: 'permission', permissionKey: 'payment-instructions:refresh-status' },
  '/api/v1/payment-instructions/[id]/reverse|POST': { access: 'permission', permissionKey: 'payment-instructions:reverse' },
  '/api/v1/payment-instructions/[id]/submit|POST': { access: 'permission', permissionKey: 'payment-instructions:submit', segregatedFrom: ['release-requests:evaluate'] },
  '/api/v1/payment-instructions|POST': { access: 'permission', permissionKey: 'payment-instructions:create' },
  '/api/v1/payment-trigger-rules/[id]/activate|POST': { access: 'permission', permissionKey: 'payment-trigger-rules:activate' },
  '/api/v1/payment-trigger-rules/[id]/evaluate|POST': { access: 'permission', permissionKey: 'payment-trigger-rules:evaluate' },
  '/api/v1/payment-trigger-rules|POST': { access: 'permission', permissionKey: 'payment-trigger-rules:create' },
  '/api/v1/payment-triggers/[id]/evaluate|POST': { access: 'permission', permissionKey: 'payment-triggers:evaluate' },
  '/api/v1/payment-triggers/[id]/proposals|POST': { access: 'permission', permissionKey: 'payment-triggers:propose' },
  '/api/v1/payment-triggers|POST': { access: 'permission', permissionKey: 'payment-triggers:create' },
  '/api/v1/performance-baselines|POST': { access: 'permission', permissionKey: 'performance-baselines:create' },
  '/api/v1/performance-baselines/variances|POST': { access: 'permission', permissionKey: 'performance-baselines:record-variance' },
  '/api/v1/performance-blueprints/[id]/activate|POST': { access: 'permission', permissionKey: 'performance-blueprints:activate' },
  '/api/v1/performance-blueprints|POST': { access: 'permission', permissionKey: 'performance-blueprints:create' },
  '/api/v1/performance-scorecards|POST': { access: 'permission', permissionKey: 'performance-scorecards:create' },
  '/api/v1/permissions/evaluate|POST': { access: 'permission', permissionKey: 'permissions:evaluate' },
  '/api/v1/portfolio-snapshots|POST': { access: 'permission', permissionKey: 'portfolio-snapshots:create' },
  '/api/v1/progress-records|POST': { access: 'permission', permissionKey: 'progress-records:create' },
  '/api/v1/quality-gate-evaluations|POST': { access: 'permission', permissionKey: 'quality-gate-evaluations:create' },
  '/api/v1/quality-plans|POST': { access: 'permission', permissionKey: 'quality-plans:create' },
  '/api/v1/recommendations/[id]/decide|POST': { access: 'permission', permissionKey: 'recommendations:decide' },
  '/api/v1/recommendations|POST': { access: 'permission', permissionKey: 'recommendations:create' },
  '/api/v1/reconciliation-records|POST': { access: 'permission', permissionKey: 'reconciliation-records:create' },
  '/api/v1/release-requests/[id]/cancel|POST': { access: 'permission', permissionKey: 'release-requests:cancel' },
  '/api/v1/release-requests/[id]/evaluate|POST': { access: 'permission', permissionKey: 'release-requests:evaluate', segregatedFrom: ['payment-instructions:submit'] },
  '/api/v1/release-requests|POST': { access: 'permission', permissionKey: 'release-requests:create' },
  '/api/v1/renewal-assessments|POST': { access: 'permission', permissionKey: 'renewal-assessments:create' },
  '/api/v1/scope-items/[id]/confirm|POST': { access: 'permission', permissionKey: 'scope-items:confirm' },
  '/api/v1/scope-items|POST': { access: 'permission', permissionKey: 'scope-items:create' },
  '/api/v1/settlement-assurance-indices|POST': { access: 'permission', permissionKey: 'settlement-assurance-indices:create' },
  '/api/v1/signature-packages|POST': { access: 'permission', permissionKey: 'signature-packages:create' },
  '/api/v1/success-metrics/[id]/confirm|POST': { access: 'permission', permissionKey: 'success-metrics:confirm' },
  '/api/v1/success-metrics|POST': { access: 'permission', permissionKey: 'success-metrics:create' },
  '/api/v1/validation-tests|POST': { access: 'permission', permissionKey: 'validation-tests:create' },
  '/api/v1/work-items/[id]/transition|POST': { access: 'permission', permissionKey: 'work-items:transition' },
  '/api/v1/work-items|POST': { access: 'permission', permissionKey: 'work-items:create' },
  '/api/v1/workflow-intelligence|POST': { access: 'permission', permissionKey: 'workflow-intelligence:create' },
  '/api/v1/workspaces/[id]/activate-context|POST': { access: 'permission', permissionKey: 'workspaces:activate-context' },
  '/api/v1/workspaces|POST': { access: 'permission', permissionKey: 'workspaces:create' },
};

/** Templates split once, so resolution is a comparison rather than a re-parse. */
const TEMPLATES = Object.keys(ROUTE_PERMISSION_REQUIREMENTS).map((key) => {
  const [template, method] = key.split('|');
  return { key, method, segments: template.split('/').filter(Boolean) };
});

function segmentsOf(pathname: string): string[] {
  return pathname.split('?')[0].split('/').filter(Boolean);
}

/**
 * Resolves the policy for a request, or throws.
 *
 * Matching is exact on segment count and on every literal segment; a bracketed
 * template segment matches one non-empty segment. A known path with an unmapped
 * method is reported distinctly from an entirely unknown path, because the two
 * mean different things to whoever has to fix it.
 */
export function requirementForRoute(pathname: string, method: string): RouteAccess {
  const segments = segmentsOf(pathname);
  const verb = method.toUpperCase();
  let pathMatched = false;

  for (const template of TEMPLATES) {
    if (template.segments.length !== segments.length) continue;

    const matches = template.segments.every(
      (segment, index) =>
        (segment.startsWith('[') && segment.endsWith(']') && segments[index].length > 0) ||
        segment === segments[index],
    );
    if (!matches) continue;

    pathMatched = true;
    if (template.method === verb) {
      return ROUTE_PERMISSION_REQUIREMENTS[template.key];
    }
  }

  throw new RouteAccessError(
    pathMatched ? 'ROUTE_METHOD_NOT_MAPPED' : 'ROUTE_NOT_MAPPED',
    `${verb} ${pathname}`,
  );
}

/** Every distinct permission key the HTTP surface requires. */
export function routePermissionKeys(): string[] {
  return [
    ...new Set(
      Object.values(ROUTE_PERMISSION_REQUIREMENTS)
        .filter((entry): entry is { access: 'permission' } & PermissionRequirement =>
          entry.access === 'permission',
        )
        .map((entry) => entry.permissionKey),
    ),
  ].sort();
}

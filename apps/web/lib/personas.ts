import { ROUTE_PERMISSION_REQUIREMENTS, routePermissionKeys } from './route-permissions';

/**
 * The persona catalogue — named grant compositions over the permission keys that already exist.
 *
 * ## Why this module has to exist, and why it is not a role model
 *
 * RC1 asks for ten personas to be certified, and instructs that the canonical authorization catalog be inspected
 * rather than a new one invented. Inspected: **AssuraPay has no named roles.** `packages/permissions` expresses
 * authority as grants — `{ permissionKey, effect, scopeType, scopeId, sourceType, sourceId }` — where
 * `sourceType: 'ROLE'` carries a free-form `sourceId`. A role is a label on a grant, not an object the platform
 * defines, so "Finance" and "Auditor" have no canonical existence to look up.
 *
 * That leaves two honest options and one dishonest one. Adding a role enum to `packages/permissions` would put a
 * new authority concept inside Engines 01–05, which CLAUDE.md's trust-foundation boundary forbids. Certifying
 * nothing would abandon a requirement. So personas are declared **here**, in the web application's own policy
 * layer beside the route table they are defined against, as compositions of keys the route table already
 * requires — which is exactly what a role is in this model, made explicit and checkable.
 *
 * The dishonest option is inventing permission keys to make a persona look complete.
 * `personas.test.ts` forecloses it: every key named below must appear in `ROUTE_PERMISSION_REQUIREMENTS`, so a
 * typo or an aspiration fails the build rather than certifying a persona against a permission nothing enforces.
 *
 * ## What a persona is for
 *
 * Two questions, both answerable from this table alone: which routes can this persona reach, and — the half that
 * matters more — which routes must refuse it. A persona whose denials are not enumerated is a persona whose
 * boundary was never tested, and §8 of the brief is explicit that the successful case alone is not certification.
 *
 * ## Scope
 *
 * These are workspace-scoped compositions. Tenancy is not a persona property: every grant is evaluated inside a
 * workspace, and cross-tenant isolation is enforced by forced row-level security rather than by any list here.
 * No persona can be given cross-tenant reach by editing this file, which is the point.
 */

export type PersonaId =
  | 'organization-administrator'
  | 'workspace-administrator'
  | 'agreement-owner'
  | 'execution-lead'
  | 'reviewer'
  | 'approver'
  | 'finance'
  | 'supplier'
  | 'customer'
  | 'auditor';

export type Persona = {
  readonly id: PersonaId;
  /** How the persona is described to a human, in the product's own language. */
  readonly title: string;
  /** Why this persona exists as a distinct authority rather than a variation of another. */
  readonly rationale: string;
  /** Permission keys granted. Every one must exist in the route policy table. */
  readonly grants: readonly string[];
  /**
   * Keys this persona must **not** hold, asserted rather than merely omitted.
   *
   * Omission and prohibition are different claims. A key absent from `grants` may be absent because nobody
   * thought about it; a key listed here is a statement that granting it would breach a separation this platform
   * depends on — so the matrix fails if a later edit adds it.
   */
  readonly mustNotHold: readonly string[];
};

/**
 * Money movement carries the separations CLAUDE.md's second hard constraint implies.
 *
 * `certification-requests:issue` attests that work is done; `authorization-decisions:approve` authorises money to
 * move against that attestation; `payment-instructions:submit` moves it. One principal holding all three is one
 * principal who can manufacture certified work and pay themselves for it, so the personas below hold at most one
 * of the three and each names the other two in `mustNotHold`.
 */
const CERTIFY = 'certification-requests:issue';
// `authorization-decisions:approve`, not a `release-requests:*` key. The route table has
// `release-requests:create`, `:cancel` and `:evaluate` but no approval: the authority that lets money move is
// the payment authorization decision, which is the aggregate Batch H found one UPDATE away from authorising a
// release for uncertified work. Naming the wrong key here would have certified a separation against a
// permission no route enforces, and `personas.test.ts` is what caught it.
const APPROVE_RELEASE = 'authorization-decisions:approve';
const SUBMIT_PAYMENT = 'payment-instructions:submit';

/**
 * The three authorities that must never meet in one persona.
 *
 * Exported rather than re-declared by the suite that checks them. The first version of `personas.test.ts` kept
 * its own copies, so correcting `APPROVE_RELEASE` here left the test asserting against a key that no longer
 * existed — it failed, correctly, but for the wrong reason. One definition, imported.
 */
export const MONEY_AUTHORITIES = Object.freeze({
  certify: CERTIFY,
  approveRelease: APPROVE_RELEASE,
  submitPayment: SUBMIT_PAYMENT,
});

export const PERSONAS: readonly Persona[] = Object.freeze([
  {
    id: 'organization-administrator',
    title: 'Organization Administrator',
    rationale:
      'Administers the tenant and its workspaces. Holds no execution, certification or money authority: ' +
      'the principal who can create a workspace and grant access must not also be able to pay out of it.',
    grants: ['workspaces:create', 'roles:assign', 'roles:read'],
    mustNotHold: [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'workspace-administrator',
    title: 'Workspace Administrator',
    rationale:
      'Administers one workspace’s membership and configuration. Distinct from the organization administrator ' +
      'because its reach stops at the workspace boundary.',
    grants: ['roles:read', 'permissions:evaluate', 'approval-thresholds:create'],
    mustNotHold: [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'agreement-owner',
    title: 'Agreement Owner',
    rationale:
      'Owns the commercial agreement: drafting, parties, versions and submission for approval. Cannot approve ' +
      'its own agreement — the drafter and the decider are separate principals.',
    grants: ['agreement-contracts:create', 'contract-drafts:submit', 'approval-requests:create'],
    mustNotHold: ['approval-requests:decide', CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'execution-lead',
    title: 'Execution Lead',
    rationale:
      'Plans and runs delivery: blueprint, milestones, dependencies and assignment. Holds no acceptance ' +
      'authority, so the principal who runs the work does not also accept it.',
    grants: [
      'blueprint-milestones:create',
      'blueprint-milestones:declare-dependencies',
      'blueprint-milestones:compute-critical-path',
      'acceptance-criteria:create',
    ],
    mustNotHold: ['acceptance-decisions:create', CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'reviewer',
    title: 'Reviewer',
    rationale:
      'Decides whether submitted evidence satisfies the definition of done. Reviews rather than certifies: the ' +
      'evidence decision and the completion attestation are separate acts.',
    grants: ['acceptance-decisions:create', 'acceptance-criteria:confirm'],
    mustNotHold: [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'approver',
    title: 'Approver',
    rationale:
      'Human authority over agreements and change. Decides what others requested, and never requests what it ' +
      'decides.',
    grants: ['approval-requests:decide', 'change-requests:decide', APPROVE_RELEASE],
    mustNotHold: ['approval-requests:create', 'change-requests:create', CERTIFY, SUBMIT_PAYMENT],
  },
  {
    id: 'finance',
    title: 'Finance',
    rationale:
      'Executes settlement against certified work: instructions, status and reconciliation. Holds the payment ' +
      'authority and therefore neither the certification that justifies it nor the release approval that ' +
      'authorises it.',
    grants: [SUBMIT_PAYMENT, 'payment-instructions:create', 'payment-instructions:refresh-status'],
    mustNotHold: [CERTIFY, APPROVE_RELEASE],
  },
  {
    id: 'supplier',
    title: 'Supplier',
    rationale:
      'The delivering counterparty. Submits evidence of its own work and can neither accept it nor be paid ' +
      'without a decision by someone else.',
    grants: ['evidence-requirements:create'],
    mustNotHold: ['acceptance-decisions:create', CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'customer',
    title: 'Customer',
    rationale:
      'The receiving counterparty. Sees delivery progress and confirms receipt where the model provides for it; ' +
      'holds no execution or payment authority.',
    grants: ['deliverables:confirm'],
    mustNotHold: [CERTIFY, APPROVE_RELEASE, SUBMIT_PAYMENT],
  },
  {
    id: 'auditor',
    title: 'Auditor',
    rationale:
      'Reads the record and changes nothing. The only persona defined by what it cannot do: every write in the ' +
      'platform is outside its reach, which is what makes its reading of the history trustworthy.',
    grants: ['contracts:read', 'completion-certificates:verify', 'evidence-packages:verify'],
    mustNotHold: [
      CERTIFY,
      APPROVE_RELEASE,
      SUBMIT_PAYMENT,
      'approval-requests:decide',
      'acceptance-decisions:create',
      'agreement-contracts:create',
      'payment-instructions:create',
    ],
  },
]);

export function persona(id: PersonaId): Persona {
  const found = PERSONAS.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown persona: ${id}`);
  return found;
}

/** Every permission key any persona claims. */
export function personaGrantKeys(): string[] {
  return [...new Set(PERSONAS.flatMap((entry) => [...entry.grants, ...entry.mustNotHold]))].sort();
}

/**
 * The routes a persona can reach, derived from the route policy table rather than listed.
 *
 * Derived on purpose: a hand-maintained list of reachable routes would drift from the table that actually
 * decides, and the drift would show up as a persona certified against a route it can no longer reach.
 */
export function routesReachableBy(entry: Persona): string[] {
  const held = new Set(entry.grants);
  return Object.entries(ROUTE_PERMISSION_REQUIREMENTS)
    .filter(([, requirement]) => requirement.access === 'permission' && held.has(requirement.permissionKey))
    .map(([route]) => route)
    .sort();
}

/** The permission-gated routes a persona cannot reach. The half of the matrix that has to be tested. */
export function routesDeniedTo(entry: Persona): string[] {
  const held = new Set(entry.grants);
  return Object.entries(ROUTE_PERMISSION_REQUIREMENTS)
    .filter(([, requirement]) => requirement.access === 'permission' && !held.has(requirement.permissionKey))
    .map(([route]) => route)
    .sort();
}

/** Keys named by a persona that no route requires — always empty, and the test that keeps it so. */
export function inventedPermissionKeys(): string[] {
  const real = new Set(routePermissionKeys());
  return personaGrantKeys().filter((key) => !real.has(key));
}

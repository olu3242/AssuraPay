import { PERSONAS, persona, type Persona, type PersonaId } from './personas';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';

/**
 * Persona workspaces — presentation over the authorization model that already exists.
 *
 * ## What this is not
 *
 * It is not a second persona framework. `personas.ts` already defines ten personas as compositions of
 * permission keys the route table enforces, with `mustNotHold` separations and a guard that fails the build if a
 * persona names a key no route requires. PR #46 builds on that same table unchanged and binds agent capability
 * policy to it. Introducing `PersonaDefinition` and `PersonaAssignment` tables beside that would be a parallel
 * authority model competing with the grant model — the thing the brief's own rules forbid.
 *
 * So the two concepts are kept apart, because they answer different questions:
 *
 * - a **persona** is what a principal may do. It is grants, it is enforced server-side, and it is the only thing
 *   that decides anything.
 * - a **workspace** is how the product presents itself to someone doing that job: a name, an accent, a
 *   navigation set, a dashboard.
 *
 * The brief says the same thing in its own words — "UI visibility is not authorization", and buyer and seller
 * are "contextual commercial roles" whose available actions must come from "the agreement relationship and
 * authorization policy, not simply the selected workspace color". A workspace here therefore *names* the
 * personas it presents and derives everything else from their grants. Switching workspace changes what is shown.
 * It cannot change what is permitted, because nothing in this file is consulted when a request is authorized.
 *
 * ## Navigation is derived, not declared
 *
 * Every module below names the route it opens and, where that route is permission-gated, the key that gates it.
 * `unreachableModules` asserts the workspace's personas actually hold that key, so a workspace cannot advertise
 * a destination the server would refuse. A hand-written navigation list would drift from the route table the
 * moment a key changed, and the drift would surface to a user as a menu item that 403s.
 */

export type WorkspaceId =
  | 'buyer'
  | 'seller'
  | 'enterprise'
  | 'finance'
  | 'verifier'
  | 'disputes'
  | 'compliance'
  | 'admin';

export type WorkspaceModule = {
  readonly label: string;
  /** An existing application route. The suite follows every one of these rather than trusting it. */
  readonly href: string;
  /**
   * The permission key gating this module's route, when it has one.
   *
   * Present means "this workspace's personas must hold this key". Absent means the route is identity-class or
   * public — reachable by any signed-in caller — which is true of the account and onboarding screens.
   */
  readonly requires?: string;
};

export type Workspace = {
  readonly id: WorkspaceId;
  readonly title: string;
  /** What the person in this workspace is trying to achieve, in their language rather than the platform's. */
  readonly purpose: string;
  /**
   * The accent that distinguishes this workspace's chrome.
   *
   * Every one of these clears WCAG AA for normal text both as a foreground on the canvas and inverted behind
   * white text — measured, not assumed; the lowest is the verifier's amber at 4.80:1 on `--ap-canvas`. Status
   * colours are deliberately not here: red, amber and green mean the same thing in every workspace, and
   * recolouring them per persona would make a failed payment look different depending on who was looking at it.
   */
  readonly accent: string;
  /**
   * The personas this workspace presents. Authority comes from these and from nowhere else in this file.
   *
   * Several workspaces name more than one, because the brief's eight cut the existing ten differently rather
   * than matching them: "Enterprise" is the commercial owner and the delivery lead seen together, and
   * "Administrator" spans the organization and workspace administrators.
   */
  readonly personas: readonly PersonaId[];
  readonly modules: readonly WorkspaceModule[];
};

/** Modules every workspace carries, because every signed-in person needs them. */
const ACCOUNT: readonly WorkspaceModule[] = Object.freeze([
  { label: 'Account & workspace', href: '/start' },
  { label: 'Settings', href: '/settings' },
]);

export const WORKSPACES: readonly Workspace[] = Object.freeze([
  {
    id: 'buyer',
    title: 'Buyer',
    purpose: 'Protect funds and confirm that what was agreed was delivered.',
    accent: '#1D4ED8',
    personas: ['customer'],
    modules: [
      { label: 'Agreements', href: '/contracts' },
      { label: 'Delivery', href: '/execution' },
      { label: 'Payments', href: '/settlements' },
      ...ACCOUNT,
    ],
  },
  {
    id: 'seller',
    title: 'Seller',
    purpose: 'Deliver the work, evidence it, and get paid for it.',
    accent: '#047857',
    personas: ['supplier'],
    modules: [
      { label: 'Agreements', href: '/contracts' },
      { label: 'Delivery & evidence', href: '/execution' },
      { label: 'Payments', href: '/settlements' },
      ...ACCOUNT,
    ],
  },
  {
    id: 'enterprise',
    title: 'Enterprise',
    purpose: 'Own the commercial relationship and run delivery across it.',
    accent: '#4338CA',
    personas: ['agreement-owner', 'execution-lead'],
    modules: [
      { label: 'Agreements', href: '/contracts', requires: 'agreement-contracts:create' },
      { label: 'Delivery plan', href: '/performance-blueprint', requires: 'blueprint-milestones:create' },
      { label: 'Execution', href: '/execution' },
      { label: 'Portfolio', href: '/enterprise-analytics' },
      ...ACCOUNT,
    ],
  },
  {
    id: 'finance',
    title: 'Financial operations',
    purpose: 'Fund, release and reconcile against work that was certified.',
    accent: '#0E7490',
    personas: ['finance'],
    modules: [
      { label: 'Payments', href: '/settlements', requires: 'payment-instructions:create' },
      { label: 'Settlement', href: '/settlement-execution', requires: 'payment-instructions:submit' },
      { label: 'Agreements', href: '/contracts' },
      ...ACCOUNT,
    ],
  },
  {
    id: 'verifier',
    title: 'Independent verifier',
    purpose: 'Judge whether submitted evidence meets the definition of done.',
    accent: '#B45309',
    personas: ['reviewer'],
    modules: [
      { label: 'Acceptance', href: '/completion-assurance', requires: 'acceptance-decisions:create' },
      { label: 'Delivery', href: '/execution' },
      { label: 'Agreements', href: '/contracts' },
      ...ACCOUNT,
    ],
  },
  {
    id: 'disputes',
    title: 'Dispute resolution',
    purpose: 'Handle contested execution without deciding who benefits from it.',
    accent: '#7E22CE',
    // No persona holds a `disputes:*` key, so this workspace presents none and its dispute module is
    // deliberately absent rather than linked to a screen the server would refuse. See DISPUTE_PERSONA_GAP.
    personas: [],
    modules: [...ACCOUNT],
  },
  {
    id: 'compliance',
    title: 'Compliance & risk',
    purpose: 'Read the record and change nothing, which is what makes the reading trustworthy.',
    accent: '#475569',
    personas: ['auditor'],
    modules: [
      { label: 'Agreements', href: '/contracts', requires: 'contracts:read' },
      { label: 'Trust & verification', href: '/parties' },
      { label: 'Legal', href: '/legal' },
      ...ACCOUNT,
    ],
  },
  {
    id: 'admin',
    title: 'Platform administration',
    purpose: 'Administer the organization, its workspaces and who may act in them.',
    accent: '#172554',
    personas: ['organization-administrator', 'workspace-administrator'],
    modules: [
      { label: 'Organization', href: '/organization', requires: 'roles:read' },
      { label: 'Parties', href: '/parties' },
      { label: 'Legal', href: '/legal' },
      ...ACCOUNT,
    ],
  },
]);

/**
 * The two places the brief's eight workspaces and the platform's ten personas do not meet.
 *
 * Recorded as data so the mismatch is visible and tested rather than described once and forgotten. Both are
 * findings about the proposal, not defects in it:
 *
 * - `approver` holds `authorization-decisions:approve` — the authority that lets money move — and the brief
 *   proposes no workspace for it, while `/approvals` is a built, working screen. Until that is settled the
 *   release approver has no workspace, which is why no workspace below claims the key.
 * - `disputes` is proposed as a workspace but no persona holds any `disputes:*` key, though the route table
 *   gates six dispute routes on them. The workspace exists here with no dispute module rather than with a module
 *   that 403s.
 */
export const WORKSPACE_PERSONA_GAPS = Object.freeze({
  personaWithoutWorkspace: 'approver' as PersonaId,
  workspaceWithoutPersona: 'disputes' as WorkspaceId,
  unclaimedDisputeKeys: Object.freeze(
    Object.values(ROUTE_PERMISSION_REQUIREMENTS)
      .flatMap((requirement) =>
        requirement.access === 'permission' && requirement.permissionKey.startsWith('disputes:')
          ? [requirement.permissionKey]
          : [],
      )
      .filter((key, index, all) => all.indexOf(key) === index)
      .sort(),
  ),
});

export function workspace(id: WorkspaceId): Workspace {
  const found = WORKSPACES.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown workspace: ${id}`);
  return found;
}

/** Every permission key this workspace's personas hold, which is the whole of its authority. */
export function workspaceGrants(entry: Workspace): string[] {
  const personas: Persona[] = entry.personas.map((id) => persona(id));
  return [...new Set(personas.flatMap((held) => held.grants))].sort();
}

/**
 * Modules naming a key the workspace's personas do not hold.
 *
 * Always empty, and the test that keeps it so is what makes "UI visibility is not authorization" checkable
 * rather than merely stated: navigation is derived from grants, so it cannot advertise a destination the
 * gateway would refuse.
 */
export function unreachableModules(entry: Workspace): WorkspaceModule[] {
  const held = new Set(workspaceGrants(entry));
  return entry.modules.filter((navItem) => navItem.requires !== undefined && !held.has(navItem.requires));
}

/** Personas presented by no workspace. A persona nobody can see is a persona nobody can use. */
export function personasWithoutWorkspace(): PersonaId[] {
  const presented = new Set(WORKSPACES.flatMap((entry) => entry.personas));
  return PERSONAS.map((entry) => entry.id).filter((id) => !presented.has(id));
}

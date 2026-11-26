/**
 * Which catalogue roles a persona test workspace is given.
 *
 * ## There is no superuser, and this is not one
 *
 * `packages/permissions/src/catalogue.ts` says it plainly: *"Roles are deliberately not hierarchical
 * and there is no superuser. A role that held every key would make every segregation rule vacuous, so
 * the founding administrator administers — it onboards parties, assigns roles and publishes policy —
 * and holds no certification, release or payment key at all."*
 *
 * So an account that holds every persona's authority **in one workspace** is not something this
 * repository declined to build. It is something the running platform refuses: `grantRole` rejects an
 * assignment whose resulting permission set breaches `SEGREGATION_CATALOGUE`, with
 * `CATALOGUE_SEGREGATION_CONFLICT`. Asking for it would produce a principal who can certify work and
 * pay themselves for it, which is CLAUDE.md's second hard constraint.
 *
 * What a tester actually needs is to *act as* each persona, one at a time. Grants are workspace-scoped,
 * so that is one workspace per persona, with the same identity a member of all of them — and the
 * workspace switcher already in the application header is how you change which one you are acting in.
 * Separation of duties survives, because no single workspace below holds two conflicting keys.
 *
 * ## This table is checked, not asserted
 *
 * `apps/web/lib/persona-provisioning.test.ts` imports this file alongside the real `PERSONA_WORKSPACES`,
 * `PERSONAS`, `PERMISSION_CATALOGUE` and `SEGREGATION_CATALOGUE` and proves three things: every
 * workspace id exists, every role exists, and no bundle below breaches a segregation rule. A table that
 * named a role the catalogue does not define, or that quietly reunited two conflicting duties, fails the
 * build rather than failing at provisioning time against the user's database.
 */

/**
 * The founding role. Granted automatically by `POST /v1/workspaces/{id}/found`, which is why it is not
 * listed per workspace below — every workspace the provisioner creates has it, because whoever founds a
 * workspace administers it. It holds no certification, release or payment key.
 */
export const FOUNDING_ROLE = 'WORKSPACE_ADMINISTRATOR';

/**
 * One entry per workspace the provisioner creates.
 *
 * `workspace` is a `PERSONA_WORKSPACES` id wherever one exists, so `/workspace/<id>` renders the matching
 * persona view. `approver` is the exception and is explained on its own entry.
 */
export const PERSONA_TEST_WORKSPACES = Object.freeze([
  {
    workspace: 'buyer',
    label: 'Buyer',
    personas: ['customer'],
    roles: ['ASSURANCE_ANALYST'],
    why:
      'The receiving counterparty watches delivery and confirms receipt. ASSURANCE_ANALYST carries the ' +
      'read surface a buyer needs across agreements, milestones and settlement without any authority ' +
      'to move, certify or approve any of it.',
  },
  {
    workspace: 'seller',
    label: 'Seller',
    personas: ['supplier'],
    roles: ['EXECUTION_MANAGER'],
    why:
      'The delivering counterparty runs the work and submits evidence of it. EXECUTION_MANAGER holds ' +
      '`certification-requests:create` — requesting certification, never deciding it, which is the ' +
      'maker-checker split against the verifier workspace below.',
  },
  {
    workspace: 'enterprise',
    label: 'Enterprise',
    personas: ['agreement-owner', 'execution-lead'],
    roles: ['CONTRACT_AUTHOR', 'PERFORMANCE_PLANNER'],
    why:
      'The commercial owner and the delivery lead seen together: drafting and submitting agreements, ' +
      'then planning the blueprint, milestones and definitions of done. Deliberately not ' +
      'CONTRACT_APPROVER — the drafter and the decider are separate principals.',
  },
  {
    workspace: 'approver',
    label: 'Approver',
    personas: ['approver'],
    roles: ['CONTRACT_APPROVER', 'SETTLEMENT_APPROVER'],
    why:
      'The only entry whose id is not a `PERSONA_WORKSPACES` view — the eight workspace views cover ten ' +
      'of the eleven personas and omit this one, so `/workspace/approver` will 404 while `/approvals` ' +
      'works. Included anyway, because without it the approval half of the release path cannot be ' +
      'exercised at all. Holds the two approval authorities and neither payment execution nor ' +
      'certification.',
  },
  {
    workspace: 'finance',
    label: 'Finance',
    personas: ['finance'],
    roles: ['PAYMENT_OPERATOR'],
    why:
      'Executes settlement against certified work. Holds `payment-instructions:submit`, and therefore ' +
      'neither `release-requests:evaluate` nor `authorization-decisions:approve` — two of the three ' +
      'CRITICAL segregation rules are exactly this pair.',
  },
  {
    workspace: 'verifier',
    label: 'Verifier',
    personas: ['reviewer'],
    roles: ['CERTIFIER'],
    why:
      'Decides certification requests and issues completion certificates. Holds ' +
      '`certification-requests:decide` and not `:create`, which is the HIGH rule against the seller ' +
      'workspace.',
  },
  {
    workspace: 'disputes',
    label: 'Disputes',
    personas: ['dispute-manager'],
    roles: ['DISPUTE_MANAGER'],
    why:
      'Handles contested execution end to end. Reads the releases and instructions under dispute and ' +
      'can move neither, so a dispute outcome is never decided by whoever benefits from releasing.',
  },
  {
    workspace: 'compliance',
    label: 'Compliance',
    personas: ['auditor'],
    roles: ['ASSURANCE_ANALYST'],
    why:
      'Reads across the whole chain, including the audit records, and writes only derived reporting. ' +
      'Shares ASSURANCE_ANALYST with the buyer workspace because the read surface is the same; the ' +
      'difference is which workspace the reader is in, which is what scopes the rows.',
  },
  {
    workspace: 'admin',
    label: 'Administrator',
    personas: ['organization-administrator', 'workspace-administrator'],
    roles: [],
    why:
      'The closest thing this platform has to a super administrator, and it is the founding role on its ' +
      'own — onboarding, role assignment and legal policy. No extra roles, because adding any would be ' +
      'the hierarchy the catalogue refuses to have.',
  },
]);

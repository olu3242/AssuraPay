import type { RequestContext } from '@assurapay/shared';
import { trustStore, workspaceScoped } from './trust-app';

/**
 * The record read surface — one aggregate, by id, with what it is attached to.
 *
 * ## Why this exists
 *
 * The collection read surface (`financial-reads.ts`) made lists possible. It did not make a *record*
 * possible: of the 47 `[id]` route directories under `api/v1`, 45 held only action sub-routes —
 * `/[id]/approve`, `/[id]/confirm`, `/[id]/verify` — and no handler at the `[id]` level at all. Every
 * aggregate in the canonical chain could be created, approved, certified and paid, and then never read
 * back by id over HTTP. A record page had nothing to render, which is why 22 of 24 screens were static.
 *
 * The acceptance test this surface is built against is the platform's own: *demonstrate where every
 * committed naira went, what contractual obligation justified it, what evidence supported it, who
 * validated it and what outcome was achieved.* Answering that means standing on one record and walking
 * the chain in both directions, so this module reads a record **and** the records it is attached to.
 *
 * ## A missing record and a forbidden one are answered differently, and neither leaks
 *
 * `readRecord` applies the workspace filter before the id lookup, so a row belonging to another
 * workspace is reported exactly as a row that does not exist. That is deliberate: answering 403 for a
 * record in a workspace the caller cannot see would confirm the record exists, and an id is often
 * guessable or quoted in a document. Permission to read the *type* is decided by the route table
 * before this module is reached, so the two questions stay separate — may you read invoices at all,
 * and does this invoice exist here.
 *
 * ## The relationship graph is declared once and derived in both directions
 *
 * Each type declares only its **parents** — the fields it carries that point upward. Children are
 * derived by inverting that declaration, so a link cannot exist in one direction and not the other,
 * and adding a type cannot half-wire it.
 *
 * It is still a declaration, and a declaration about the database's shape is exactly the kind of thing
 * that drifts into fiction. `record-reads.postgres.test.ts` is what stops it: it reads `pg_constraint`
 * and fails if any link declared below is not a real foreign key. Nothing here is believed on its own
 * authority.
 *
 * ## Related records the caller may not read are named, never counted
 *
 * A caller who may read an invoice is not thereby entitled to its payment instructions. Those are
 * withheld — and withheld *without a count*, unlike the workspace navigation, which counts the modules
 * it hides. The difference matters: "3 payment instructions, withheld" discloses how much money moved
 * against this invoice to someone with no key to read it. The type is named so the reader knows the
 * record is not an orphan; the volume is not.
 */

export type RecordTypeId =
  | 'contracts'
  | 'performance-blueprints'
  | 'milestones'
  | 'definition-of-done-packages'
  | 'execution-workspaces'
  | 'completion-certificates'
  | 'payment-eligibility'
  | 'financial-entitlements'
  | 'invoices'
  | 'funding-commitments'
  | 'fund-reservations'
  | 'release-requests'
  | 'payment-instructions'
  | 'reconciliation-records'
  | 'ledger-entries'
  | 'final-settlement-accounts'
  | 'disputes';

/** A field this record carries that points at one record of another type. */
export type RecordLink = {
  readonly field: string;
  readonly type: RecordTypeId;
};

export type RecordTypeDefinition = {
  readonly id: RecordTypeId;
  /** The store collection. Not derivable from `id`: `milestones` lives in `blueprintMilestones`. */
  readonly collection: string;
  /**
   * The `aggregateType` the engines actually write to the audit ledger.
   *
   * Taken from the `emit(...)` call sites rather than guessed from the type name — `milestones` is
   * audited as `BlueprintMilestone` and `definition-of-done-packages` as `DodPackage`. A wrong value
   * here would not error; it would render an empty audit trail on a record that has a full one, which
   * is the most misleading possible outcome for an audit tab.
   */
  readonly aggregateType: string;
  /** What the record is called in the product's own language. */
  readonly title: string;
  /** The read key the route table gates this type's record route on. */
  readonly permissionKey: string;
  readonly parents: readonly RecordLink[];
};

/**
 * The canonical chain, as link declarations.
 *
 * The order follows `CLAUDE.md`'s chain — Contract → PerformanceBlueprint → Milestone →
 * DefinitionOfDonePackage → ExecutionWorkspace → CompletionCertificate → PaymentEligibility →
 * FinancialEntitlement → ReleaseRequest → PaymentInstruction → ReconciliationRecord — with the
 * funding and invoicing records in the positions their foreign keys actually put them.
 */
export const RECORD_TYPES: readonly RecordTypeDefinition[] = Object.freeze([
  {
    id: 'contracts',
    collection: 'agreements',
    aggregateType: 'Agreement',
    title: 'Contract',
    permissionKey: 'contracts:read',
    // The chain's first link, and so the only type with no parent. Everything below reaches it.
    parents: [],
  },
  {
    id: 'performance-blueprints',
    collection: 'performanceBlueprints',
    aggregateType: 'PerformanceBlueprint',
    title: 'Performance blueprint',
    permissionKey: 'performance-blueprints:read',
    parents: [{ field: 'contractId', type: 'contracts' }],
  },
  {
    id: 'milestones',
    collection: 'blueprintMilestones',
    aggregateType: 'BlueprintMilestone',
    title: 'Milestone',
    permissionKey: 'milestones:read',
    parents: [{ field: 'blueprintId', type: 'performance-blueprints' }],
  },
  {
    id: 'definition-of-done-packages',
    collection: 'dodPackages',
    aggregateType: 'DodPackage',
    title: 'Definition of done',
    permissionKey: 'definition-of-done-packages:read',
    parents: [{ field: 'milestoneId', type: 'milestones' }],
  },
  {
    id: 'execution-workspaces',
    collection: 'executionWorkspaces',
    aggregateType: 'ExecutionWorkspace',
    title: 'Execution workspace',
    permissionKey: 'execution-workspaces:read',
    parents: [
      { field: 'blueprintId', type: 'performance-blueprints' },
      { field: 'milestoneId', type: 'milestones' },
    ],
  },
  {
    id: 'completion-certificates',
    collection: 'completionCertificates',
    aggregateType: 'CompletionCertificate',
    title: 'Completion certificate',
    permissionKey: 'completion-certificates:read',
    parents: [{ field: 'milestoneId', type: 'milestones' }],
  },
  {
    id: 'payment-eligibility',
    collection: 'paymentEligibilities',
    aggregateType: 'PaymentEligibility',
    title: 'Payment eligibility',
    permissionKey: 'payment-eligibility:read',
    parents: [
      { field: 'milestoneId', type: 'milestones' },
      { field: 'completionCertificateId', type: 'completion-certificates' },
    ],
  },
  {
    id: 'financial-entitlements',
    collection: 'financialEntitlements',
    aggregateType: 'FinancialEntitlement',
    title: 'Financial entitlement',
    permissionKey: 'financial-entitlements:read',
    parents: [
      { field: 'milestoneId', type: 'milestones' },
      { field: 'paymentEligibilityId', type: 'payment-eligibility' },
    ],
  },
  {
    id: 'funding-commitments',
    collection: 'fundingCommitments',
    aggregateType: 'FundingCommitment',
    title: 'Funding commitment',
    permissionKey: 'funding-commitments:read',
    parents: [{ field: 'milestoneId', type: 'milestones' }],
  },
  {
    id: 'invoices',
    collection: 'invoices',
    aggregateType: 'Invoice',
    title: 'Invoice',
    permissionKey: 'invoices:read',
    parents: [
      { field: 'milestoneId', type: 'milestones' },
      { field: 'financialEntitlementId', type: 'financial-entitlements' },
    ],
  },
  {
    id: 'fund-reservations',
    collection: 'fundReservations',
    aggregateType: 'FundReservation',
    title: 'Fund reservation',
    permissionKey: 'fund-reservations:read',
    parents: [
      { field: 'fundingCommitmentId', type: 'funding-commitments' },
      { field: 'invoiceId', type: 'invoices' },
    ],
  },
  {
    id: 'release-requests',
    collection: 'releaseRequests',
    aggregateType: 'ReleaseRequest',
    title: 'Release request',
    permissionKey: 'release-requests:read',
    // Four upward links, and migration `202608110025` is why they all have to be here: a release that
    // named one invoice's entitlement and another's reservation satisfied every constraint the schema
    // had. The composite foreign keys now bind them together, and this is the view of that binding.
    parents: [
      { field: 'milestoneId', type: 'milestones' },
      { field: 'financialEntitlementId', type: 'financial-entitlements' },
      { field: 'invoiceId', type: 'invoices' },
      { field: 'fundReservationId', type: 'fund-reservations' },
    ],
  },
  {
    id: 'payment-instructions',
    collection: 'paymentInstructions',
    aggregateType: 'PaymentInstruction',
    title: 'Payment instruction',
    permissionKey: 'payment-instructions:read',
    parents: [{ field: 'releaseRequestId', type: 'release-requests' }],
  },
  {
    id: 'reconciliation-records',
    collection: 'reconciliationRecords',
    aggregateType: 'ReconciliationRecord',
    title: 'Reconciliation record',
    permissionKey: 'reconciliation-records:read',
    parents: [{ field: 'paymentInstructionId', type: 'payment-instructions' }],
  },
  {
    id: 'ledger-entries',
    collection: 'ledgerEntries',
    aggregateType: 'LedgerEntry',
    title: 'Ledger entry',
    permissionKey: 'ledger-entries:read',
    parents: [{ field: 'paymentInstructionId', type: 'payment-instructions' }],
  },
  {
    id: 'final-settlement-accounts',
    collection: 'finalSettlementAccounts',
    aggregateType: 'FinalSettlementAccount',
    title: 'Final settlement account',
    permissionKey: 'final-settlement-accounts:read',
    // Per milestone, not per contract. Written from the schema after the foreign-key guard rejected a
    // `contractId` link: `final_settlement_accounts` has no contract column, and a settlement account
    // closes out one milestone's entitlement against what was actually settled.
    parents: [{ field: 'milestoneId', type: 'milestones' }],
  },
  {
    id: 'disputes',
    collection: 'disputes',
    aggregateType: 'Dispute',
    title: 'Dispute',
    permissionKey: 'disputes:read',
    // A dispute attaches to the release it contests, not to the milestone. Also written from the
    // schema rather than from the shape of the chain: `disputes.release_request_id` is the column, and
    // the foreign key enforcing it already existed. It is the link that lets a release record show it
    // is under dispute, which is the one thing a release approver most needs to see.
    parents: [{ field: 'releaseRequestId', type: 'release-requests' }],
  },
]);

export function recordType(id: string): RecordTypeDefinition | undefined {
  return RECORD_TYPES.find((definition) => definition.id === id);
}

/**
 * The downward links, inverted from the upward ones.
 *
 * Derived rather than declared so the graph cannot disagree with itself. A child list maintained by
 * hand beside the parent list is two statements about one foreign key, and the second one rots.
 */
export function childLinksOf(id: RecordTypeId): readonly { type: RecordTypeId; field: string }[] {
  return RECORD_TYPES.flatMap((definition) =>
    definition.parents
      .filter((link) => link.type === id)
      .map((link) => ({ type: definition.id, field: link.field })),
  );
}

/** Every permission key the record surface gates on. */
export function recordPermissionKeys(): string[] {
  return [...new Set(RECORD_TYPES.map((definition) => definition.permissionKey))].sort();
}

type StoredRecord = { id: string; workspaceId?: string } & Record<string, unknown>;

/**
 * How a collection's rows are fetched.
 *
 * Injectable so the rules below — workspace-before-id, withholding without counts, dangling parents —
 * can be *tested* rather than only described. `financial-reads.ts` has no such seam and so its
 * `readCollection` is covered only by integration tests; the scoping decision here is a security
 * property and deserves a unit test that fails if it is reordered.
 */
export type CollectionReader = <T>(collection: string) => Promise<T[]>;

const storeReader: CollectionReader = (collection) => trustStore.list(collection);

/**
 * One record of one type, in the caller's active workspace, or `undefined`.
 *
 * The workspace filter is applied before the id lookup rather than after, so this cannot be made to
 * answer "that id exists but not here" by any argument the caller controls.
 */
export async function readRecord(
  context: RequestContext,
  definition: RecordTypeDefinition,
  id: string,
  read: CollectionReader = storeReader,
): Promise<StoredRecord | undefined> {
  const scoped = workspaceScoped(context);
  const rows = await read<StoredRecord>(definition.collection);
  return rows.find((row) => row.workspaceId === scoped.activeWorkspaceId && row.id === id);
}

/**
 * Fields a record might carry that a person would recognise it by, in order of preference.
 *
 * Falling back to the id is the point of the ordering: a label is a convenience, and inventing one
 * from the type name plus a counter would put a number on screen that matches nothing in the
 * database. If a record has no human-readable field, the reader gets its id, which is at least true.
 */
const LABEL_FIELDS = [
  'contractNumber',
  'invoiceNumber',
  'reference',
  'title',
  'name',
  'milestoneCode',
  'description',
] as const;

export function labelOf(row: StoredRecord): string {
  for (const field of LABEL_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return row.id;
}

export type RelatedRecord = {
  type: RecordTypeId;
  title: string;
  id: string;
  label: string;
  /** The field on the subject that points here, for a parent; on the child, for a child. */
  via: string;
};

export type RelatedRecords = {
  /** Records this one is attached to, upward along the chain. */
  parents: RelatedRecord[];
  /** Records attached to this one, downward along the chain. */
  children: RelatedRecord[];
  /**
   * Types withheld because the caller holds no read key for them, by title and without counts.
   * See the module note: a count would disclose volume to someone with no key to read the rows.
   */
  withheld: string[];
  /**
   * Parent ids this record names that are not present in the workspace.
   *
   * Reported rather than dropped. A dangling reference in a chain that authorises money is a finding,
   * and silently omitting it would make the record look complete.
   */
  danglingParents: { type: RecordTypeId; field: string; id: string }[];
};

/** How many children of one type are listed before the list is truncated. */
const CHILD_LIMIT = 25;

/**
 * What this record is attached to, in both directions, filtered to what the caller may read.
 *
 * `heldKeys` is the caller's effective permission set — passed in rather than recomputed here, so the
 * answer is the same set `PermissionService` would enforce, not a second opinion about it.
 */
export async function relatedTo(
  context: RequestContext,
  definition: RecordTypeDefinition,
  row: StoredRecord,
  heldKeys: ReadonlySet<string>,
  read: CollectionReader = storeReader,
): Promise<RelatedRecords> {
  const scoped = workspaceScoped(context);
  const related: RelatedRecords = { parents: [], children: [], withheld: [], danglingParents: [] };
  const withheld = new Set<string>();

  for (const link of definition.parents) {
    const target = recordType(link.type);
    if (!target) continue;
    const referenced = row[link.field];
    if (typeof referenced !== 'string' || referenced.length === 0) continue;
    if (!heldKeys.has(target.permissionKey)) {
      withheld.add(target.title);
      continue;
    }
    const parent = await readRecord(context, target, referenced, read);
    if (parent) {
      related.parents.push({
        type: target.id,
        title: target.title,
        id: parent.id,
        label: labelOf(parent),
        via: link.field,
      });
    } else {
      related.danglingParents.push({ type: target.id, field: link.field, id: referenced });
    }
  }

  for (const link of childLinksOf(definition.id)) {
    const target = recordType(link.type);
    if (!target) continue;
    if (!heldKeys.has(target.permissionKey)) {
      withheld.add(target.title);
      continue;
    }
    const rows = await read<StoredRecord>(target.collection);
    const matches = rows.filter(
      (candidate) =>
        candidate.workspaceId === scoped.activeWorkspaceId && candidate[link.field] === row.id,
    );
    for (const match of matches.slice(0, CHILD_LIMIT)) {
      related.children.push({
        type: target.id,
        title: target.title,
        id: match.id,
        label: labelOf(match),
        via: link.field,
      });
    }
  }

  related.withheld = [...withheld].sort();
  return related;
}

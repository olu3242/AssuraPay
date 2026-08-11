import { z } from 'zod';
import {
  calendarDate,
  currencyCode,
  identifier,
  instant,
  positiveMinorUnits,
  requiredText,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch E — the six performance-blueprint aggregates of
 * canonical Engines 16-20.
 *
 * The first batch of the sixty-seven `docs/persistence/DURABILITY_GAP_ANALYSIS.md` registers, and it
 * is first because three of these six are **canonical chain links**: `performanceBlueprints`,
 * `blueprintMilestones` and `dodPackages`. Six aggregates of work repair three of the four broken
 * links at the front of `Contract → PerformanceBlueprint → Milestone → DefinitionOfDonePackage →
 * ExecutionWorkspace → …`, which is the best ratio of central-claim repair to effort in the register.
 *
 * Two things about this batch differ from Batches A-D, and both are recorded rather than smoothed
 * over:
 *
 *   - **`version` here is a domain field, not a row counter.** A blueprint or a definition-of-done
 *     package carries the revision it *is* — `draft` computes it by counting existing rows for the
 *     contract — and a new revision is a new row while the old one becomes SUPERSEDED. So the
 *     persistence layer's optimistic-concurrency column is `row_version`, and the domain `version`
 *     appears in these schemas as what it is: a positive revision number that never changes.
 *   - **Money appears outside the settlement batches for the first time.**
 *     `BlueprintMilestone.budgetAmountMinor` is an amount in minor units with a currency, so
 *     `docs/finance/MONETARY_INVARIANTS.md` governs it — the representation rules apply wherever an
 *     amount exists, not only where it moves.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagreed the engine won
 * and the disagreement is recorded: `BlueprintMilestone.status` declares a `CANCELLED` value that
 * nothing in the repository ever writes, so the aggregate is append-only in both the store and the
 * database — a table is append-only because of what the engines do, not because of what its type
 * allows.
 */

// Engine 16 — Performance Blueprint

export const performanceBlueprintSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    contractVersionId: identifier,
    agreementIntelligenceVersionId: identifier,
    // The revision this blueprint *is*, counted from the contract's existing blueprints. Positive
    // because there is no revision zero, and immutable because revision 3 does not become revision 4
    // — a new revision is a new row.
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    status: z.enum(['DRAFT', 'ACTIVE', 'SUPERSEDED']),
    createdBy: identifier,
    createdAt: instant,
    // What makes the blueprint citable as evidence: a digest of the inputs it was derived from. Blank
    // would make the citation unverifiable.
    contentHash: requiredText,
  })
  .strict();

// Engine 17 — Scope Definition

export const scopeItemSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    // Exclusions are as load-bearing as inclusions: a dispute over whether work was in scope is
    // decided against this field.
    kind: z.enum(['INCLUDED', 'EXCLUDED']),
    description: requiredText,
    assumptions: z.array(requiredText),
    constraints: z.array(requiredText),
    ownerId: identifier,
    status: z.enum(['DRAFT', 'CONFIRMED']),
    createdAt: instant,
  })
  .strict();

// Engine 18 — Deliverables

export const deliverableSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    scopeItemId: identifier,
    title: requiredText,
    // A quantity, not an amount: fractional is legitimate — 2.5 tonnes, 1.5 days — so this is not
    // minor units. Strictly positive, because a deliverable of nothing is not a deliverable.
    quantity: z.number().positive().finite(),
    unit: requiredText,
    qualityStandard: requiredText,
    ownerId: identifier,
    dueDate: calendarDate,
    // Non-empty in the database since `202608030004`, and non-empty here for the same reason: a
    // deliverable nobody can accept or evidence cannot be completed.
    acceptanceCriteria: z.array(requiredText).min(1),
    evidenceRequirements: z.array(requiredText).min(1),
    status: z.enum(['DRAFT', 'CONFIRMED']),
    createdAt: instant,
  })
  .strict();

// Engine 19 — Milestone Planning

export const blueprintMilestoneSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    title: requiredText,
    deliverableIds: z.array(identifier).min(1),
    startDate: calendarDate,
    dueDate: calendarDate,
    // Money, in a planning aggregate. MONETARY_INVARIANTS governs representation wherever an amount
    // exists: integer minor units, strictly positive, and a currency from the governed set travelling
    // with it.
    budgetAmountMinor: positiveMinorUnits,
    currency: currencyCode,
    // Strictly above zero, matching the constraint `202608030004` already carries. A milestone
    // allocated no value is a milestone no release can be earned against.
    valueAllocationPercent: z.number().gt(0).max(100),
    status: z.enum(['SCHEDULED', 'CANCELLED']),
    createdAt: instant,
  })
  .strict()
  // A milestone due before it starts cannot be scheduled, and every downstream date calculation would
  // inherit the inversion. Expressible in one record, so it belongs here as well as in the column.
  .refine((value) => value.dueDate >= value.startDate, {
    message: 'a milestone cannot be due before it starts',
    path: ['dueDate'],
  });

export const milestoneSequenceEdgeSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    predecessorId: identifier,
    successorId: identifier,
    createdAt: instant,
  })
  .strict()
  // A self-edge is a one-node cycle, and a schedule containing one cannot be ordered. Longer cycles
  // are a property of the whole graph and are not expressible here — see the activation document.
  .refine((value) => value.predecessorId !== value.successorId, {
    message: 'a milestone cannot precede itself',
    path: ['successorId'],
  });

// Engine 20 — Definition of Done

export const dodGateCriterionSchema = z
  .object({
    key: identifier,
    description: requiredText,
    mandatory: z.boolean(),
    evaluationType: z.enum(['AUTOMATED', 'MANUAL']),
  })
  .strict();

export const dodPackageSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    // The same domain revision as a blueprint's, for the same reason.
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    deliverableGateIds: z.array(identifier).min(1),
    // The gate criteria a completion certificate is judged against. Non-empty, because a definition
    // of done that defines nothing would let any evidence satisfy it.
    criteria: z.array(dodGateCriterionSchema).min(1),
    evidenceRequirements: z.array(requiredText).min(1),
    qualityGate: z.boolean(),
    complianceGate: z.boolean(),
    riskGate: z.boolean(),
    paymentGate: z.boolean(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'SUPERSEDED']),
    createdBy: identifier,
    createdAt: instant,
    contentHash: requiredText,
  })
  .strict();

/**
 * The schema version stored beside every Batch E row.
 *
 * Distinct from each aggregate's domain `version`, which is a revision number. This one says which
 * *shape* the row is in, and a row declaring a version this build cannot parse is refused rather than
 * read optimistically.
 */
export const BATCH_E_SCHEMA_VERSION = 1;

export type BatchEAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly schemaVersion: number;
};

/**
 * The registry, in dependency order.
 *
 * Load-bearing, because the tenant-composite foreign keys make it so: everything references the
 * blueprint, a deliverable references a scope item, a sequence edge references two milestones, and a
 * definition-of-done package references a milestone.
 */
export const BATCH_E_AGGREGATES: readonly BatchEAggregateContract[] = Object.freeze([
  { collection: 'performanceBlueprints', table: 'performance_blueprints', engine: '16', schema: performanceBlueprintSchema, schemaVersion: BATCH_E_SCHEMA_VERSION },
  { collection: 'scopeItems', table: 'scope_items', engine: '17', schema: scopeItemSchema, schemaVersion: BATCH_E_SCHEMA_VERSION },
  { collection: 'deliverables', table: 'deliverables', engine: '18', schema: deliverableSchema, schemaVersion: BATCH_E_SCHEMA_VERSION },
  { collection: 'blueprintMilestones', table: 'blueprint_milestones', engine: '19', schema: blueprintMilestoneSchema, schemaVersion: BATCH_E_SCHEMA_VERSION },
  { collection: 'milestoneSequenceEdges', table: 'milestone_sequence_edges', engine: '19', schema: milestoneSequenceEdgeSchema, schemaVersion: BATCH_E_SCHEMA_VERSION },
  { collection: 'dodPackages', table: 'dod_packages', engine: '20', schema: dodPackageSchema, schemaVersion: BATCH_E_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_E_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_E_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_E_TABLES: readonly string[] = Object.freeze(
  BATCH_E_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Checked against the engines rather than inferred from the types. `BlueprintMilestone.status`
 * declares `CANCELLED` and nothing in the repository writes it; a sequence edge has no status at all.
 */
export const BATCH_E_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'blueprintMilestones',
  'milestoneSequenceEdges',
]);

/**
 * The canonical chain links this batch makes durable.
 *
 * Named so the claim is checkable rather than asserted in prose: a test can compare it against the
 * store's routing table and the chain census in `durability-coverage.test.ts`.
 */
export const BATCH_E_CANONICAL_CHAIN_LINKS: readonly string[] = Object.freeze([
  'performanceBlueprints',
  'blueprintMilestones',
  'dodPackages',
]);

/** The contract for a collection, or `undefined` when Batch E does not own it. */
export function batchEContract(collection: string): BatchEAggregateContract | undefined {
  return BATCH_E_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}

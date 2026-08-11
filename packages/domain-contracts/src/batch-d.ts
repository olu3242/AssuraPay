import { z } from 'zod';
import { identifier, instant, requiredText } from './primitives';

/**
 * The canonical persisted-state schemas for Batch D — the five dispute-and-remediation aggregates of
 * canonical Engine 49.
 *
 * The last batch, and the one that closes CLAUDE.md's second hard constraint. "Release requires …
 * **no active hold**" was, until `202608110002`, enforced nowhere:
 * `DisputeResolutionEngine.isHeld` computes the right answer and no code path calls it, and
 * `FinalSettlementEngine.close` takes `noOpenDisputes` as a boolean the caller supplies.
 *
 * None of that is fixable here, and the division is the point. A hold is a **cross-row** property —
 * it lives in a different table than the thing it blocks — so no single-record schema can express
 * it. These schemas carry what a hold *is*; the triggers carry what a hold *does*. A schema that
 * claimed to enforce hold semantics would be claiming it in the one place the claim cannot hold, the
 * same reason journal balance is absent from Batch C's schemas and segregation of duties from Batch
 * B's.
 *
 * What the schemas do carry is the internal consistency of a hold record, which *is* single-row: a
 * released hold records when it was released, and an active one does not. Without that a hold could
 * be deactivated with no time it was lifted, and the audit chain could not say how long money was
 * blocked.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagreed the engine
 * won and the disagreement is recorded — `dispute_holds` carried a blanket append-only trigger while
 * `close` releases holds, which would have made every hold permanent.
 */

// Engine 49 — Dispute, Claim & Appeal Resolution

export const disputeSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    releaseRequestId: identifier,
    kind: z.enum(['PAYMENT_DISPUTE', 'CLAIM', 'APPEAL']),
    description: requiredText,
    status: z.enum(['OPEN', 'MEDIATION', 'DECIDED', 'APPEALED', 'CLOSED']),
    raisedBy: identifier,
    createdAt: instant,
  })
  .strict();

export const disputeEvidenceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    disputeId: identifier,
    // A reference to the artefact, not the artefact. Evidence files live where the evidence-package
    // aggregate puts them; this names one so an appeal can be re-decided from the same material.
    reference: requiredText,
    description: requiredText,
    submittedBy: identifier,
    submittedAt: instant,
  })
  .strict();

export const disputePositionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    disputeId: identifier,
    partyId: identifier,
    position: requiredText,
    submittedAt: instant,
  })
  .strict();

export const disputeDecisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    disputeId: identifier,
    decision: z.enum(['UPHELD', 'REJECTED', 'PARTIAL']),
    // A decision resolving a dispute over money with no stated reasoning is an unexplained
    // resolution, and an appeal is decided against the reasoning rather than the outcome.
    rationale: requiredText,
    decidedBy: identifier,
    decidedAt: instant,
  })
  .strict();

export const disputeHoldSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    disputeId: identifier,
    releaseRequestId: identifier,
    active: z.boolean(),
    placedAt: instant,
    releasedAt: instant.optional(),
  })
  .strict()
  // Single-row consistency, which is all a schema can say about a hold. Whether the hold *blocks*
  // anything is a cross-row property, enforced by the triggers `202608110002` adds.
  .refine((value) => value.active === (value.releasedAt === undefined), {
    message: 'a released hold records when it was released, and an active one does not',
    path: ['releasedAt'],
  });

/**
 * The schema version stored beside every Batch D row.
 *
 * One for every aggregate in the batch, because they were introduced together.
 */
export const BATCH_D_SCHEMA_VERSION = 1;

export type BatchDAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly schemaVersion: number;
};

/**
 * The registry, in dependency order.
 *
 * `disputes` first: the other four all reference it, and a dispute references the release request it
 * disputes — which is why Batch D is last. It depends on Batch B for `release_requests` and, through
 * the hold triggers, guards Batch C's payment instructions and settlement accounts. Nothing depends
 * on Batch D.
 */
export const BATCH_D_AGGREGATES: readonly BatchDAggregateContract[] = Object.freeze([
  { collection: 'disputes', table: 'disputes', engine: '49', schema: disputeSchema, schemaVersion: BATCH_D_SCHEMA_VERSION },
  { collection: 'disputeEvidence', table: 'dispute_evidence', engine: '49', schema: disputeEvidenceSchema, schemaVersion: BATCH_D_SCHEMA_VERSION },
  { collection: 'disputePositions', table: 'dispute_positions', engine: '49', schema: disputePositionSchema, schemaVersion: BATCH_D_SCHEMA_VERSION },
  { collection: 'disputeDecisions', table: 'dispute_decisions', engine: '49', schema: disputeDecisionSchema, schemaVersion: BATCH_D_SCHEMA_VERSION },
  { collection: 'disputeHolds', table: 'dispute_holds', engine: '49', schema: disputeHoldSchema, schemaVersion: BATCH_D_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_D_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_D_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_D_TABLES: readonly string[] = Object.freeze(
  BATCH_D_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Evidence, positions and decisions are submissions: a retraction is a new record, never an edit,
 * because a dispute's record of who said what is the material an appeal is decided on.
 *
 * `disputes` and `disputeHolds` are absent deliberately — both are transitioned, and `dispute_holds`
 * carried a blanket append-only trigger that would have made every hold permanent.
 */
export const BATCH_D_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'disputeDecisions',
  'disputeEvidence',
  'disputePositions',
]);

/** The contract for a collection, or `undefined` when Batch D does not own it. */
export function batchDContract(collection: string): BatchDAggregateContract | undefined {
  return BATCH_D_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}

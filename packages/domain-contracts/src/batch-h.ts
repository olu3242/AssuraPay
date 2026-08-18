import { z } from 'zod';
import {
  currencyCode,
  identifier,
  instant,
  positiveMinorUnits,
  requiredText,
  revisionNumber,
  sha256Hex,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch H — the eleven governance-core aggregates of canonical
 * Engines 06-10.
 *
 * The largest closure in the register after Batch F, and the tightest: all thirty-two of its foreign keys
 * point inside the eleven or at the deprecated `workspaces` table, and nothing outside references any of
 * them. So the batch converges a self-contained graph, which is why identity can be converted at all.
 *
 * ## The defect this batch found, and it is the inverse of Batch G's
 *
 * Batch G found triggers that refused what its engines did. Batch H found the opposite: **eight of eleven
 * tables have no mutation boundary whatsoever.** Only `certification_decisions`,
 * `digital_certification_records` and `execution_history` carry an append-only trigger, and those three
 * are correct — the first time a batch's historical boundary agreed with its engines.
 *
 * What is unprotected is the part that matters. `createEscrowReleaseIntent` reads a proposal, requires
 * `status === 'PROPOSED'`, and then calls the provider adapter to create a real release intent. No engine
 * ever updates a proposal — `propose()` appends one and that is the whole lifecycle — yet nothing in the
 * database stops a direct writer taking a BLOCKED proposal carrying
 * `['DOD_NOT_SATISFIED', 'CERTIFICATION_REQUIRED']` and issuing
 *
 *   UPDATE payment_authorization_proposals SET status = 'PROPOSED', blockers = '[]' WHERE ...
 *
 * after which the release instruction goes to the provider for work that was never certified.
 * `dod_evaluations.mandatory_passed` is exposed the same way and is precisely what produces
 * `DOD_NOT_SATISFIED`, and `payment_trigger_definitions.amount_minor` is the sum a proposal inherits.
 *
 * CLAUDE.md's second hard constraint says no unconditional release path exists. On the durable store one
 * did: a single UPDATE away, on the four aggregates that gate a release, three of which had nothing
 * guarding them. `202608110011` makes all four append-only in the database and gives the four aggregates
 * their engines *do* transition governed-transition triggers instead.
 *
 * ## `version` means two different things here
 *
 * Unusually, and the schemas record which is which rather than smoothing it over:
 *
 *   - For `governedExecutions`, `governedMilestones` and `certificationRequests` the engine writes
 *     `version: previous.version + 1` on every transition, so `version` *is* the optimistic-concurrency
 *     counter. These use the governed trigger's default concurrency column and need no `row_version`.
 *   - For `dodVersions` it is a domain revision — `prior.length + 1`, the revision the definition *is* —
 *     so it is immutable and `row_version` carries concurrency instead, exactly as Batch E's blueprint
 *     does.
 *   - For `paymentTriggerDefinitions` it is written once as 1 and never changed, which makes it a
 *     revision of one.
 *
 * Derived from engine semantics, not from table introspection.
 */

/** A rule a criterion is evaluated by, when the evaluation is automated. */
export const dodCriterionRuleSchema = z
  .object({
    field: requiredText,
    operator: z.enum(['EQ', 'GTE', 'LTE']),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

export const dodCriterionSchema = z
  .object({
    key: requiredText,
    description: requiredText,
    mandatory: z.boolean(),
    evidenceRequirementKeys: z.array(requiredText),
    evaluationType: z.enum(['AUTOMATED', 'MANUAL']),
    rule: dodCriterionRuleSchema.optional(),
  })
  .strict();

// Engine 06 — Governed Execution

export const executionStateSchema = z.enum([
  'DRAFT',
  'PLANNED',
  'ACTIVE',
  'SUSPENDED',
  'COMPLETED',
  'CANCELLED',
]);

export const governedExecutionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    title: requiredText,
    ownerUserId: identifier,
    state: executionStateSchema,
    startedAt: instant.optional(),
    completedAt: instant.optional(),
    createdAt: instant,
    updatedAt: instant,
    // The row counter, not a revision. `transition()` writes `execution.version + 1`, so this is what the
    // governed trigger checks advances.
    version: revisionNumber,
  })
  .strict()
  // `transition()` stamps `startedAt` on the way into ACTIVE and never clears it, so a COMPLETED execution
  // that never started is a record of work that finished without beginning — and `project()` reads these
  // dates as the execution's actual span.
  .refine((value) => value.completedAt === undefined || value.startedAt !== undefined, {
    message: 'an execution cannot complete without having started',
    path: ['startedAt'],
  })
  .refine((value) => (value.state === 'COMPLETED') === (value.completedAt !== undefined), {
    message: 'a completed execution records when it completed, and no other state does',
    path: ['completedAt'],
  });

export const executionHistorySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    fromState: executionStateSchema.optional(),
    toState: executionStateSchema,
    actorId: identifier,
    reason: requiredText,
    // `history()` sorts by this, and the audit trail is only readable if the order is total. Starts at 1;
    // the creation record has no `fromState`, which is how a reader tells the first entry from the rest.
    sequence: revisionNumber,
    occurredAt: instant,
  })
  .strict()
  .refine((value) => value.fromState !== value.toState, {
    message: 'a transition changes the state',
    path: ['toState'],
  });

// Engine 07 — Milestone

export const governedMilestoneSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    parentMilestoneId: identifier.optional(),
    title: requiredText,
    ownerUserId: identifier,
    state: z.enum(['PLANNED', 'READY', 'ACTIVE', 'BLOCKED', 'COMPLETED', 'CANCELLED']),
    // Zero-day work is not a milestone, and `INVALID_DURATION` is what the engine says about it.
    durationDays: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: instant,
    updatedAt: instant,
    version: revisionNumber,
  })
  .strict()
  // A milestone cannot be its own parent. The engine's `MILESTONE_CYCLE` check covers longer cycles too,
  // which a single-record schema cannot see — that part stays where it can be evaluated.
  .refine((value) => value.parentMilestoneId !== value.id, {
    message: 'a milestone cannot be its own parent',
    path: ['parentMilestoneId'],
  });

export const milestoneDependencySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    predecessorId: identifier,
    successorId: identifier,
    dependencyType: z.literal('FINISH_TO_START'),
    createdAt: instant,
  })
  .strict()
  // A self-edge is a milestone that cannot start until it finishes. `complete()` refuses a milestone whose
  // dependencies are incomplete, so a self-edge is a permanent block that reads as an ordinary one.
  .refine((value) => value.predecessorId !== value.successorId, {
    message: 'a dependency needs two different milestones',
    path: ['successorId'],
  });

// Engine 08 — Definition of Done

export const dodVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    // A domain revision, counted from the milestone's existing definitions. Immutable: revision 3 does not
    // become revision 4, a new revision is a new row.
    version: revisionNumber,
    status: z.enum(['DRAFT', 'PUBLISHED', 'SUPERSEDED']),
    // `createVersion()` refuses an empty set and refuses duplicate keys, because a criterion key is how an
    // evaluation result names what it evaluated — two criteria sharing a key make a result ambiguous.
    // `readonly`, matching the domain type. `createVersion()` freezes the array it stores, because a
    // published definition is the standard a release turns on and a caller holding a mutable reference to
    // it could change the standard after the fact.
    criteria: z
      .array(dodCriterionSchema)
      .min(1)
      .refine((value) => new Set(value.map((entry) => entry.key)).size === value.length, {
        message: 'criterion keys are unique within a definition',
      })
      .readonly(),
    createdBy: identifier,
    createdAt: instant,
    publishedAt: instant.optional(),
    // What makes the definition citable as evidence: a digest of the criteria it was derived from.
    contentHash: sha256Hex,
  })
  .strict()
  // Published means published at a time. A payment trigger names a definition as the standard a release
  // turns on, so a publication with no moment cannot be placed in the audit chain. SUPERSEDED carries one
  // too, because a definition is only superseded after having been published.
  .refine(
    (value) => (value.status === 'DRAFT') === (value.publishedAt === undefined),
    {
      message: 'a published or superseded definition records when it was published',
      path: ['publishedAt'],
    },
  );

export const dodEvaluationSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    definitionId: identifier,
    results: z
      .array(
        z
          .object({
            criterionKey: requiredText,
            passed: z.boolean(),
            reason: requiredText,
          })
          .strict(),
      )
      .min(1),
    // What `PaymentTriggerEngine.evaluate` reads to decide whether DOD_NOT_SATISFIED blocks a release. The
    // most load-bearing boolean in this batch, which is why `202608110011` makes the row append-only.
    mandatoryPassed: z.boolean(),
    manualReviewRequired: z.boolean(),
    evidenceReferences: z.array(requiredText),
    evaluatedBy: identifier,
    evaluatedAt: instant,
  })
  .strict()
  // The derived claim must follow from the results it was derived from: if any result failed, the
  // mandatory set cannot have passed. Not the whole rule — only the definition knows which criteria were
  // mandatory — but the half that is checkable from one row, and the half that catches a flipped boolean.
  .refine(
    (value) => !value.mandatoryPassed || value.results.every((result) => result.passed),
    {
      message: 'a passing evaluation cannot contain a failed result',
      path: ['mandatoryPassed'],
    },
  );

// Engine 09 — Certification

export const certificationRequestSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    milestoneId: identifier,
    dodEvaluationId: identifier,
    requestedBy: identifier,
    status: z.enum(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED']),
    // `open()` refuses `INDEPENDENT_REVIEWER_REQUIRED` when the requester is the only reviewer, so a
    // request always names at least one. The independence rule itself compares two fields and is stated
    // below.
    reviewerIds: z.array(identifier).min(1),
    createdAt: instant,
    updatedAt: instant,
    version: revisionNumber,
  })
  .strict()
  // Certification is the point at which work becomes payable, so the reviewer cannot be the person who
  // asked for it. Checkable from one row, therefore a constraint rather than only an engine guard.
  .refine((value) => !value.reviewerIds.includes(value.requestedBy), {
    message: 'the requester cannot review their own certification',
    path: ['reviewerIds'],
  });

export const certificationDecisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    certificationRequestId: identifier,
    reviewerId: identifier,
    decision: z.enum(['APPROVE', 'REJECT']),
    // A decision without a reason is not reviewable, and this record is the evidence a certification was
    // considered rather than waved through.
    rationale: requiredText,
    evidenceReferences: z.array(requiredText),
    decidedAt: instant,
  })
  .strict();

export const digitalCertificationRecordSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    certificationRequestId: identifier,
    milestoneId: identifier,
    certificateNumber: requiredText,
    canonicalHash: sha256Hex,
    status: z.enum(['CERTIFIED', 'REVOKED']),
    issuedBy: identifier,
    issuedAt: instant,
  })
  .strict();

// Engine 10 — Payment Trigger

export const paymentTriggerDefinitionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    milestoneId: identifier,
    name: requiredText,
    // The definition of done a release turns on. Not optional: a trigger with no standard to check is a
    // release with no condition.
    requiredDodDefinitionId: identifier,
    certificationRequired: z.boolean(),
    // Money outside the settlement batches, so `docs/finance/MONETARY_INVARIANTS.md` governs it. Positive
    // because a trigger releasing nothing is not a trigger, and the engine says `INVALID_PAYMENT_AMOUNT`.
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    // Which certified Financial Provider is instructed. Absent means no orchestrator is configured, and
    // `createEscrowReleaseIntent` refuses rather than guessing — the non-custody constraint means
    // AssuraPay has no fallback path of its own to fall back to.
    escrowProviderKey: identifier.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    createdAt: instant,
    version: revisionNumber,
  })
  .strict();

export const paymentAuthorizationProposalSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    triggerId: identifier,
    milestoneId: identifier,
    certificationId: identifier.optional(),
    amountMinor: positiveMinorUnits,
    currency: currencyCode,
    status: z.enum([
      'PROPOSED',
      'BLOCKED',
      'AUTHORIZED_FOR_PROVIDER_SUBMISSION',
      'REVOKED',
    ]),
    blockers: z.array(requiredText),
    proposedBy: identifier,
    proposedAt: instant,
    // What makes `propose()` idempotent: it returns the existing proposal for a repeated key rather than
    // authorising a second release for the same work.
    idempotencyKey: requiredText,
  })
  .strict()
  // The status and the blockers are one statement, and they have to agree. `propose()` sets BLOCKED exactly
  // when it found blockers, and `createEscrowReleaseIntent` reads nothing but the status before
  // instructing the provider — so a PROPOSED row carrying blockers is an authorised release whose own
  // record says it should not have been, and a BLOCKED row carrying none is unreadable.
  .refine((value) => (value.status === 'BLOCKED') === (value.blockers.length > 0), {
    message: 'a blocked proposal names its blockers, and an unblocked one has none',
    path: ['blockers'],
  });

/**
 * The schema version stored beside every Batch H row.
 *
 * One for all eleven, because they are activated together. A row declaring a version this build cannot
 * parse is refused rather than read optimistically.
 */
export const BATCH_H_SCHEMA_VERSION = 1;

export type BatchHAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodTypeAny;
  readonly schemaVersion: number;
};

export const BATCH_H_AGGREGATES: readonly BatchHAggregateContract[] = Object.freeze([
  { collection: 'governedExecutions', table: 'governed_executions', engine: '06', schema: governedExecutionSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'executionHistory', table: 'execution_history', engine: '06', schema: executionHistorySchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'governedMilestones', table: 'governed_milestones', engine: '07', schema: governedMilestoneSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'milestoneDependencies', table: 'milestone_dependencies', engine: '07', schema: milestoneDependencySchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'dodVersions', table: 'dod_versions', engine: '08', schema: dodVersionSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'dodEvaluations', table: 'dod_evaluations', engine: '08', schema: dodEvaluationSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'certificationRequests', table: 'certification_requests', engine: '09', schema: certificationRequestSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'certificationDecisions', table: 'certification_decisions', engine: '09', schema: certificationDecisionSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'digitalCertifications', table: 'digital_certification_records', engine: '09', schema: digitalCertificationRecordSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'paymentTriggerDefinitions', table: 'payment_trigger_definitions', engine: '10', schema: paymentTriggerDefinitionSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
  { collection: 'paymentAuthorizationProposals', table: 'payment_authorization_proposals', engine: '10', schema: paymentAuthorizationProposalSchema, schemaVersion: BATCH_H_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_H_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_H_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_H_TABLES: readonly string[] = Object.freeze(
  BATCH_H_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Seven of eleven, and four of those seven had nothing enforcing it before `202608110011` — including the
 * payment authorization proposal, which `createEscrowReleaseIntent` reads to decide whether to instruct a
 * provider. Checked against the engines: none of these seven is ever passed to `replace`.
 */
export const BATCH_H_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'certificationDecisions',
  'digitalCertifications',
  'dodEvaluations',
  'executionHistory',
  'milestoneDependencies',
  'paymentAuthorizationProposals',
  'paymentTriggerDefinitions',
]);

/**
 * The collections whose domain `version` field *is* the optimistic-concurrency counter.
 *
 * Named rather than inferred, because the distinction decides which column the governed-transition trigger
 * watches. For these three the engine writes `previous.version + 1` on every transition. `dodVersions`
 * carries a domain revision instead and is deliberately absent.
 */
export const BATCH_H_DOMAIN_VERSION_IS_CONCURRENCY: readonly string[] = Object.freeze([
  'certificationRequests',
  'governedExecutions',
  'governedMilestones',
]);

/** The contract for a collection, or `undefined` when Batch H does not own it. */
export function batchHContract(collection: string): BatchHAggregateContract | undefined {
  return BATCH_H_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}

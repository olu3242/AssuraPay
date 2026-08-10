import { z } from 'zod';
import {
  calendarDate,
  count,
  identifier,
  instant,
  minorUnits,
  optionalText,
  percentage,
  requiredText,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch A — the sixteen execution-and-evidence
 * aggregates of canonical Engines 31–40.
 *
 * Derived from engine semantics, not from table introspection. `docs/persistence/
 * WAVE_4_SCHEMA_AUTHORITY.md` ranks the existing relational tables ninth and explicitly
 * forbids generating domain types from their shape: those tables were written before the
 * engines settled and nothing has ever read them, so a column in one of them is a proposal
 * about the domain rather than a fact about it. Where a column and the engine disagree the
 * engine wins, and the disagreement is recorded rather than resolved silently — see
 * `calendarDate` in `./primitives` for the one instance in this batch.
 *
 * Every schema is `.strict()`. An unknown key is a refusal, not a passthrough, because the
 * relational writer has a column per field and would drop anything it did not recognise:
 * a permissive schema would turn an added field into silent data loss discoverable only by
 * its absence.
 *
 * These are *persisted-state* schemas. Command inputs are the engines' own parameter types
 * and are validated by the engines' preconditions; nothing here is a substitute for those,
 * and nothing here is a substitute for a database constraint — a schema that runs in one
 * process cannot constrain a console session.
 */

// Engine 31 — Execution Orchestration

export const executionWorkspaceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    milestoneId: identifier,
    status: z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED', 'SUBMITTED']),
    createdAt: instant,
  })
  .strict();

export const workItemSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionWorkspaceId: identifier,
    deliverableId: identifier,
    title: requiredText,
    assigneeId: identifier,
    status: z.enum(['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'CANCELLED']),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

// Engine 32 — Progress Measurement

export const progressRecordSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    stage: z.enum([
      'DECLARED',
      'EVIDENCED',
      'VALIDATED',
      'ACCEPTED',
      'FINANCIALLY_EARNED',
    ]),
    percentComplete: percentage,
    // Optional because only a financially-earned record carries one. The engine already
    // requires it to be a positive integer at that stage; `minorUnits` states the
    // representation, which nothing enforced before.
    earnedValueAmountMinor: minorUnits.optional(),
    reportedBy: identifier,
    createdAt: instant,
  })
  .strict();

// Engine 33 — Evidence Management

export const evidenceRequirementSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    deliverableId: identifier,
    kind: requiredText,
    description: requiredText,
    mandatory: z.boolean(),
    createdAt: instant,
  })
  .strict();

export const evidenceFileSchema = z
  .object({
    requirementId: identifier,
    reference: requiredText,
    hash: requiredText,
    mimeType: requiredText,
  })
  .strict();

export const evidenceCustodyEntrySchema = z
  .object({ actorId: identifier, action: requiredText, at: instant })
  .strict();

export const evidencePackageSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    deliverableId: identifier,
    // Non-empty, matching `CHECK (jsonb_array_length(files) > 0)` and the engine's
    // EVIDENCE_FILE_REQUIRED precondition. Both, deliberately: the column stops a write the
    // application never made, the schema stops one it did.
    files: z.array(evidenceFileSchema).min(1),
    chainOfCustody: z.array(evidenceCustodyEntrySchema),
    status: z.enum(['SUBMITTED', 'VERIFIED', 'REJECTED']),
    createdAt: instant,
  })
  .strict();

// Engine 34 — Validation & Acceptance Testing

export const validationTestSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    acceptanceCriterionId: identifier,
    method: z.enum(['MANUAL', 'AUTOMATED']),
    result: z.enum(['PASS', 'FAIL', 'CONDITIONAL_PASS', 'WAIVED']),
    notes: optionalText,
    evidencePackageId: identifier.optional(),
    retestOf: identifier.optional(),
    testedBy: identifier,
    testedAt: instant,
  })
  .strict();

// Engine 35 — Quality Assurance

export const qualityPlanSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionWorkspaceId: identifier,
    standards: z.array(requiredText).min(1),
    inspectionFrequency: requiredText,
    status: z.literal('ACTIVE'),
    createdAt: instant,
  })
  .strict();

export const defectSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
    description: requiredText,
    rootCause: requiredText.optional(),
    status: z.enum(['OPEN', 'IN_REWORK', 'RESOLVED', 'CLOSED']),
    raisedBy: identifier,
    createdAt: instant,
    resolvedAt: instant.optional(),
  })
  .strict();

export const qualityGateResultSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    passed: z.boolean(),
    openDefectCount: count,
    criticalDefectCount: count,
    evaluatedAt: instant,
  })
  .strict();

// Engine 36 — Inspection & Field Verification

export const checklistItemSchema = z
  .object({ item: requiredText, required: z.boolean() })
  .strict();

export const inspectionFindingSchema = z
  .object({
    checklistItem: requiredText,
    result: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']),
    evidenceReference: requiredText.optional(),
    notes: optionalText,
  })
  .strict();

export const inspectionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    // A `DATE` column and a plain calendar date. See `calendarDate`.
    scheduledFor: calendarDate,
    checklist: z.array(checklistItemSchema).min(1),
    findings: z.array(inspectionFindingSchema),
    status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED']),
    passed: z.boolean(),
    reinspectionOfId: identifier.optional(),
    createdAt: instant,
  })
  .strict();

// Engine 37 — Issue, Risk & Corrective Action

export const issueRecordSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    kind: z.enum(['ISSUE', 'RISK']),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    description: requiredText,
    status: z.enum([
      'OPEN',
      'ESCALATED',
      'CAPA_IN_PROGRESS',
      'RESOLVED',
      'CLOSED',
    ]),
    raisedBy: identifier,
    createdAt: instant,
    escalatedAt: instant.optional(),
    resolvedAt: instant.optional(),
  })
  .strict();

export const correctiveActionPlanSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    issueId: identifier,
    actionPlan: requiredText,
    ownerId: identifier,
    dueDate: calendarDate,
    status: z.enum(['OPEN', 'COMPLETED', 'VERIFIED']),
    createdAt: instant,
    completedAt: instant.optional(),
    verifiedAt: instant.optional(),
  })
  .strict();

// Engine 38 — Change Control

export const changeImpactSchema = z
  .object({
    scheduleDays: z.number().int().optional(),
    // Signed, unlike every base amount: a change request may legitimately reduce cost, and
    // this is an *impact* rather than a posted monetary fact. `docs/finance/
    // MONETARY_INVARIANTS.md` constrains base contractual, claim, invoice, entitlement,
    // funding, release and payment amounts — a projected delta is none of those, and the
    // engine already refuses a non-integer.
    costAmountMinor: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

export const changeRequestSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    blueprintId: identifier,
    milestoneId: identifier,
    changeType: z.enum([
      'SCOPE',
      'SCHEDULE',
      'COST',
      'ACCEPTANCE_CRITERIA',
      'EVIDENCE_REQUIREMENT',
      'PAYMENT_TRIGGER',
    ]),
    description: requiredText,
    impact: changeImpactSchema,
    requestedBy: identifier,
    status: z.enum([
      'DRAFT',
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
      'IMPLEMENTED',
    ]),
    createdAt: instant,
  })
  .strict();

export const changeApprovalSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    changeRequestId: identifier,
    approverId: identifier,
    decision: z.enum(['APPROVE', 'REJECT']),
    rationale: requiredText,
    decidedAt: instant,
  })
  .strict();

// Engine 39 — Acceptance & Decision

export const acceptanceDecisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    decision: z.enum([
      'FULL',
      'PARTIAL',
      'CONDITIONAL',
      'PROVISIONAL',
      'REJECTED',
      'DEFERRED',
    ]),
    rationale: requiredText,
    conditions: z.array(requiredText),
    status: z.enum(['ACTIVE', 'SUPERSEDED']),
    decidedBy: identifier,
    decidedAt: instant,
    supersedesId: identifier.optional(),
  })
  .strict();

// Engine 40 — Completion Certification

export const completionCertificateSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    workItemId: identifier,
    milestoneId: identifier,
    certificateNumber: requiredText,
    acceptanceDecisionId: identifier,
    // A SHA-256 hex digest. Pinned to its shape because the certificate's whole evidentiary
    // value is that this field is reproducible from the facts it commits to, and a
    // truncated or re-encoded digest verifies against nothing.
    canonicalHash: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(['CERTIFIED', 'REVOKED']),
    issuedBy: identifier,
    issuedAt: instant,
    revokedAt: instant.optional(),
  })
  .strict();

/**
 * One aggregate's persistence contract: the collection engines name it by, the table that
 * owns it, and the schema its persisted state must satisfy.
 *
 * `schemaVersion` is the value written to the table's `schema_version` column. Legacy
 * readers parse *by* it, and an unrecognised version must fail into an explicit unsupported
 * result rather than a best-effort parse — a silently mis-parsed aggregate is worse than a
 * refused one.
 */
export type BatchAAggregateContract = {
  readonly collection: string;
  readonly table: string;
  /** Canonical engine id from `docs/ENGINE_CATALOG.md`. */
  readonly engine: string;
  readonly schema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly schemaVersion: number;
};

/** The schema version every Batch A table is written at by this capability. */
export const BATCH_A_SCHEMA_VERSION = 1;

/**
 * The registry, in dependency order.
 *
 * Ordered so that a caller replaying it — a backfill, a fixture, a reconciliation report —
 * inserts parents before children. Foreign keys make the order load-bearing rather than
 * cosmetic: `work_items` references `execution_workspaces`, `progress_records` references
 * `work_items`, `corrective_action_plans` references `issue_records`, and
 * `completion_certificates` references `acceptance_decisions`.
 */
export const BATCH_A_AGGREGATES: readonly BatchAAggregateContract[] =
  Object.freeze([
    {
      collection: 'executionWorkspaces',
      table: 'execution_workspaces',
      engine: '31',
      schema: executionWorkspaceSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'workItems',
      table: 'work_items',
      engine: '31',
      schema: workItemSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'progressRecords',
      table: 'progress_records',
      engine: '32',
      schema: progressRecordSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'evidenceRequirements',
      table: 'evidence_requirements',
      engine: '33',
      schema: evidenceRequirementSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'evidencePackages',
      table: 'evidence_packages',
      engine: '33',
      schema: evidencePackageSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'validationTests',
      table: 'validation_tests',
      engine: '34',
      schema: validationTestSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'qualityPlans',
      table: 'quality_plans',
      engine: '35',
      schema: qualityPlanSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'defects',
      table: 'defects',
      engine: '35',
      schema: defectSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'qualityGateResults',
      table: 'quality_gate_results',
      engine: '35',
      schema: qualityGateResultSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'inspections',
      table: 'inspections',
      engine: '36',
      schema: inspectionSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'issueRecords',
      table: 'issue_records',
      engine: '37',
      schema: issueRecordSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'correctiveActionPlans',
      table: 'corrective_action_plans',
      engine: '37',
      schema: correctiveActionPlanSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'changeRequests',
      table: 'change_requests',
      engine: '38',
      schema: changeRequestSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'changeApprovals',
      table: 'change_approvals',
      engine: '38',
      schema: changeApprovalSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'acceptanceDecisions',
      table: 'acceptance_decisions',
      engine: '39',
      schema: acceptanceDecisionSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
    {
      collection: 'completionCertificates',
      table: 'completion_certificates',
      engine: '40',
      schema: completionCertificateSchema,
      schemaVersion: BATCH_A_SCHEMA_VERSION,
    },
  ]);

/** Collection names, for a store that must decide whether it owns a collection. */
export const BATCH_A_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_A_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_A_TABLES: readonly string[] = Object.freeze(
  BATCH_A_AGGREGATES.map((aggregate) => aggregate.table),
);

/** The contract for a collection, or `undefined` when Batch A does not own it. */
export function batchAContract(
  collection: string,
): BatchAAggregateContract | undefined {
  return BATCH_A_AGGREGATES.find(
    (aggregate) => aggregate.collection === collection,
  );
}

/**
 * A schema failure described without any of the value that failed.
 *
 * Path and issue code only. A Zod message quotes the offending value — `Invalid enum value.
 * Expected 'PASS' | 'FAIL', received '…'` — and these records carry evidence references,
 * actor identifiers and narrative text. The standing constraint is that raw payloads never
 * reach a log or an error, and an error message is the easiest place to lose that.
 */
export function describeSchemaFailure(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
}

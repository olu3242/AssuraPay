import { z } from 'zod';
import { identifier, instant, percentage, requiredText, revisionNumber, sha256Hex } from './primitives';

/**
 * The canonical persisted-state schemas for Batch I — the six agreement-intelligence aggregates of
 * canonical Engines 16-20.
 *
 * **Six, not the five the register recorded.** `contractVersionsV2` is written by
 * `ContractVersionEngine` and was absent from the register and the coverage baseline alike, because that
 * gate's collection-name pattern was `[a-zA-Z]+` and silently dropped every name containing a digit. The
 * correction landed before this batch, and it changes the shape of the work: `contract_versions_v2` looked
 * like a foreign parent with no `tenant_id`, which would have forced either an unbounded conversion or a
 * bare identifier, and is in fact one of this batch's own aggregates.
 *
 * ## The closure is larger than the aggregate set, for the first time
 *
 * Two tables reference the closure and no engine writes either: `agreement_intelligence_items` and
 * `contract_analysis_findings`. They are leaves — nothing references them — but their `*_id` columns point
 * at aggregates whose identity this batch converts from UUID to TEXT, so leaving them alone would either
 * break their foreign keys or reinstate the identity split the platform is eliminating. They are therefore
 * converged and governed without being routed, the arrangement Batch B named: activated aggregates, and a
 * closure converged around them.
 *
 * ## What this batch enforces that nothing did
 *
 * Three single-record invariants here are unusually strong, because these aggregates carry their child
 * collections inline as `jsonb` rather than as rows:
 *
 *   - a **published** intelligence version may contain no item still `PENDING` and must contain at least
 *     one `ACCEPTED`. `publish()` refuses both, and because the items live in the row it is checkable from
 *     the row;
 *   - a risk assessment's **level must follow from its score** on the engine's own thresholds, so a
 *     CRITICAL banner cannot sit above a score of four;
 *   - every finding above `INFO`, every explanation and every intelligence item must **cite a source**.
 *     `SOURCE_REFERENCE_REQUIRED` is the engine's rule, and an uncited finding is an assertion about a
 *     contract with nothing behind it.
 *
 * ## One thing deliberately left unbounded, and recorded rather than invented
 *
 * `confidence` has no bound in any engine, and the only bound in the schema is on the two leaf tables no
 * engine writes — so it constrains nothing that is actually stored. On the six routed aggregates a
 * confidence lives inside a `jsonb` item or finding, and a confidence of 5000 is storable today. The scale
 * is not stated anywhere in the repository, so this batch does not invent one: guessing 0-1 would reject a
 * gateway that reports percentages, and guessing 0-100 would accept a probability of 100 as certainty. It is
 * a gap in the model rather than in the plumbing, and it belongs to whoever specifies the gateway contract.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagreed the engine won:
 * `contract_versions_v2` stores `version_number` and `version_kind` for the domain's `number` and `kind`.
 */

/** Where an assertion about a contract points. */
export const sourceReferenceSchema = z
  .object({
    documentVersionId: identifier,
    section: requiredText,
    page: z.number().int().min(1).optional(),
    startOffset: z.number().int().min(0).optional(),
    endOffset: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.startOffset === undefined ||
      value.endOffset === undefined ||
      value.endOffset >= value.startOffset,
    { message: 'a citation cannot end before it starts', path: ['endOffset'] },
  );

/**
 * A confidence, unbounded.
 *
 * See this file's header: no engine and no column bounds it, and the scale is unstated, so no bound is
 * invented here.
 */
const confidence = z.number();

// Engine 16 — Contract Version

export const contractVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    // Stored as `version_number`. A revision, counted from the contract's existing versions.
    number: revisionNumber,
    kind: z.enum(['EXECUTED', 'AMENDMENT', 'RESTATEMENT', 'RENEWAL', 'CORRECTION']),
    documentReference: requiredText,
    // What `verify()` compares a document against, so a blank one makes verification vacuous.
    documentHash: sha256Hex,
    executionCertificateId: identifier,
    status: z.enum(['ACTIVE', 'SUPERSEDED']),
    supersedesId: identifier.optional(),
    createdAt: instant,
  })
  .strict()
  // A version cannot supersede itself. `registerExecuted` marks the superseded version SUPERSEDED, so a
  // self-reference would set the new version's own status and leave the chain pointing at nothing.
  .refine((value) => value.supersedesId !== value.id, {
    message: 'a version cannot supersede itself',
    path: ['supersedesId'],
  });

// Engine 17 — Contract Analysis

export const analysisFindingSchema = z
  .object({
    id: identifier,
    type: requiredText,
    severity: z.enum(['INFO', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL']),
    title: requiredText,
    sourceReferences: z.array(sourceReferenceSchema),
    confidence,
    reviewStatus: z.enum(['NOT_REVIEWED', 'ACCEPTED', 'REJECTED']),
  })
  .strict()
  // The engine's `SOURCE_REFERENCE_REQUIRED`, and the reason it exempts INFO: an informational note is an
  // observation, while anything above it is a claim about the contract that a reviewer has to be able to
  // check. An uncited HIGH finding is an assertion with nothing behind it.
  .refine((value) => value.severity === 'INFO' || value.sourceReferences.length > 0, {
    message: 'a finding above INFO must cite a source',
    path: ['sourceReferences'],
  });

export const analysisRunSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    contractVersionId: identifier,
    method: z.enum(['DETERMINISTIC', 'AI_ASSISTED', 'HYBRID', 'MANUAL']),
    modelId: identifier.optional(),
    modelVersion: identifier.optional(),
    promptVersion: identifier.optional(),
    // The two hashes are what make a run reproducible: the same input under the same profile should
    // produce the same output, and these are how anyone checks.
    inputHash: sha256Hex,
    outputHash: sha256Hex,
    findings: z.array(analysisFindingSchema),
    status: z.enum(['COMPLETED', 'SUPERSEDED']),
    requestedBy: identifier,
    createdAt: instant,
  })
  .strict()
  // A model-assisted run has to say which model produced it. `analyze()` fills all three from the gateway
  // for AI_ASSISTED and HYBRID, and a run that cannot name its model is a finding no one can reproduce or
  // attribute — which for an AI-derived claim about a contract is the whole of its evidential value.
  .refine(
    (value) =>
      !['AI_ASSISTED', 'HYBRID'].includes(value.method) ||
      (value.modelId !== undefined &&
        value.modelVersion !== undefined &&
        value.promptVersion !== undefined),
    {
      message: 'a model-assisted run records the model, its version and the prompt version',
      path: ['modelId'],
    },
  );

/**
 * A reviewer's decision on one finding.
 *
 * The only aggregate in this batch with no table and no exported domain type — `review()` builds the
 * record inline. The shape is taken from that call, and `202608110012` creates the table.
 */
export const analysisReviewSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    runId: identifier,
    findingId: identifier,
    decision: z.enum(['ACCEPTED', 'REJECTED']),
    // A decision with no note is not reviewable. This record is the evidence a finding was considered
    // rather than clicked through.
    notes: requiredText,
    reviewerId: identifier,
    createdAt: instant,
  })
  .strict();

export type AnalysisReviewRecord = z.infer<typeof analysisReviewSchema>;

// Engine 18 — Contract Risk

export const riskExplanationSchema = z
  .object({
    dimension: requiredText,
    sourceReferences: z.array(sourceReferenceSchema).min(1),
  })
  .strict();

/**
 * The engine's own thresholds, in one place.
 *
 * `assess()` computes the level from the score with exactly these bounds. Repeating them here rather than
 * describing them keeps the schema and the engine from drifting apart silently.
 */
export function riskLevelForScore(score: number): 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MODERATE';
  return 'LOW';
}

export const riskAssessmentSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    contractVersionId: identifier,
    analysisRunId: identifier,
    version: revisionNumber,
    // Each dimension is a score out of a hundred; `assess()` refuses `INVALID_RISK_SCORE` otherwise.
    dimensions: z.record(percentage),
    score: percentage,
    level: z.enum(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']),
    explanations: z.array(riskExplanationSchema),
    status: z.enum(['DRAFT', 'VALIDATED', 'SUPERSEDED']),
    createdAt: instant,
  })
  .strict()
  // The level has to follow from the score. It is derived, not chosen, so a row where the two disagree is
  // a risk banner that does not describe its own number — and the banner is what a reader acts on.
  .refine((value) => value.level === riskLevelForScore(value.score), {
    message: 'the level is derived from the score, on the engine’s thresholds',
    path: ['level'],
  })
  // An assessment with no dimensions has measured nothing, and `assess()` divides by
  // `Math.max(1, count)` — so an empty set yields a score of zero and a LOW banner that looks like a
  // finding rather than an absence of one.
  .refine((value) => Object.keys(value.dimensions).length > 0, {
    message: 'an assessment scores at least one dimension',
    path: ['dimensions'],
  });

// Engine 19 — Contract Repository

/**
 * The document types the repository accepts.
 *
 * `store()` refuses `MIME_NOT_ALLOWED` for anything else. Stated as an enum rather than free text because
 * the allow-list is the rule: a repository that will store any bytes under any type is not a controlled
 * one, and the classification below is what governs who may read them.
 */
export const REPOSITORY_MIME_TYPES: readonly string[] = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/**
 * The allow-list as a refinement rather than an enum, so the inferred type stays `string`.
 *
 * `RepositoryDocument.mimeType` is declared `string` in the domain, and the conformance assertion requires
 * the schema to infer exactly that — an enum would infer a union of two literals and be a different type.
 * The values are still closed: this refuses anything off the list, which is what `MIME_NOT_ALLOWED` means.
 * The rule and the type are separate concerns, and only one of them is the published contract.
 */
export const repositoryMimeTypeSchema = requiredText.refine(
  (value) => REPOSITORY_MIME_TYPES.includes(value),
  { message: 'the repository stores PDF and Word documents only' },
);

export const repositoryDocumentSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractVersionId: identifier,
    // `search()` strips this from every result, because a storage reference is a capability rather than a
    // description: holding it is how a document is fetched.
    storageReference: requiredText,
    contentHash: sha256Hex,
    mimeType: repositoryMimeTypeSchema,
    classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PRIVILEGED']),
    tags: z.array(requiredText),
    ocrTextReference: requiredText.optional(),
    legalHold: z.boolean(),
    createdAt: instant,
  })
  .strict();

// Engine 20 — Agreement Intelligence

export const intelligenceItemSchema = z
  .object({
    id: identifier,
    type: z.enum(['PARTY', 'OBLIGATION', 'MILESTONE', 'KPI', 'PAYMENT_TRIGGER']),
    value: z.record(z.unknown()),
    // Every item, without exemption: `propose()` refuses the whole version if any item cites nothing.
    // An extracted obligation with no source is a claim about the agreement that cannot be checked
    // against it, and these items become parties, milestones and payment triggers downstream.
    sourceReferences: z.array(sourceReferenceSchema).min(1),
    confidence,
    reviewStatus: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']),
  })
  .strict();

export const agreementIntelligenceVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    contractVersionId: identifier,
    version: revisionNumber,
    items: z.array(intelligenceItemSchema).min(1),
    status: z.enum(['DRAFT', 'PUBLISHED', 'SUPERSEDED']),
    createdBy: identifier,
    createdAt: instant,
    contentHash: sha256Hex,
  })
  .strict()
  // `publish()` refuses `HUMAN_REVIEW_REQUIRED` while any item is still PENDING, and
  // `ACCEPTED_INTELLIGENCE_REQUIRED` if none was accepted. Both are checkable from the row, because the
  // items live in it — so a published version that slipped past the engine is still refused here. This is
  // the human-in-the-loop rule for machine-extracted terms, and it is the one that keeps an AI reading of
  // a contract from becoming the contract's terms unreviewed.
  .refine(
    (value) =>
      value.status === 'DRAFT' || value.items.every((item) => item.reviewStatus !== 'PENDING'),
    {
      message: 'a published version has no item awaiting review',
      path: ['items'],
    },
  )
  .refine(
    (value) =>
      value.status === 'DRAFT' ||
      value.items.some((item) => item.reviewStatus === 'ACCEPTED'),
    {
      message: 'a published version has at least one accepted item',
      path: ['items'],
    },
  );

/**
 * The schema version stored beside every Batch I row.
 *
 * One for all six, because they are activated together. A row declaring a version this build cannot parse
 * is refused rather than read optimistically.
 */
export const BATCH_I_SCHEMA_VERSION = 1;

export type BatchIAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodTypeAny;
  readonly schemaVersion: number;
};

export const BATCH_I_AGGREGATES: readonly BatchIAggregateContract[] = Object.freeze([
  { collection: 'contractVersionsV2', table: 'contract_versions_v2', engine: '16', schema: contractVersionSchema, schemaVersion: BATCH_I_SCHEMA_VERSION },
  { collection: 'contractAnalysisRuns', table: 'contract_analysis_runs', engine: '17', schema: analysisRunSchema, schemaVersion: BATCH_I_SCHEMA_VERSION },
  { collection: 'analysisReviews', table: 'analysis_reviews', engine: '17', schema: analysisReviewSchema, schemaVersion: BATCH_I_SCHEMA_VERSION },
  { collection: 'contractRiskAssessments', table: 'contract_risk_assessments', engine: '18', schema: riskAssessmentSchema, schemaVersion: BATCH_I_SCHEMA_VERSION },
  { collection: 'repositoryDocuments', table: 'contract_repository_documents', engine: '19', schema: repositoryDocumentSchema, schemaVersion: BATCH_I_SCHEMA_VERSION },
  { collection: 'agreementIntelligenceVersions', table: 'agreement_intelligence_versions', engine: '20', schema: agreementIntelligenceVersionSchema, schemaVersion: BATCH_I_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_I_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_I_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_I_TABLES: readonly string[] = Object.freeze(
  BATCH_I_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Two of six. A run is a measurement taken at a moment — `analyze()` appends and `review()` records a
 * decision beside it rather than editing it — and a review is one reviewer's position. The other four are
 * transitioned: a contract version is superseded, an assessment validated, a document placed under legal
 * hold, an intelligence version reviewed and published.
 */
export const BATCH_I_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'analysisReviews',
  'contractAnalysisRuns',
]);

/**
 * The tables this batch converges without routing.
 *
 * Neither is written by any engine, and both are leaves. They are in the closure because their `*_id`
 * columns reference aggregates whose identity this batch converts, so leaving them alone would break their
 * keys or keep a UUID column pointing at a TEXT one. Named here so the batch's own suite can assert they
 * were converged rather than forgotten.
 */
export const BATCH_I_CONVERGED_NOT_ROUTED_TABLES: readonly string[] = Object.freeze([
  'agreement_intelligence_items',
  'contract_analysis_findings',
]);

/** The contract for a collection, or `undefined` when Batch I does not own it. */
export function batchIContract(collection: string): BatchIAggregateContract | undefined {
  return BATCH_I_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}

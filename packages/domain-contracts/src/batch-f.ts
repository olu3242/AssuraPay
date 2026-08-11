import { z } from 'zod';
import {
  count,
  identifier,
  instant,
  optionalText,
  requiredText,
  revisionNumber,
  sha256Hex,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch F — the fifteen agreement-creation aggregates of
 * canonical Engines 11-15.
 *
 * The largest batch in `docs/persistence/DURABILITY_GAP_ANALYSIS.md`, and the one that closes the
 * canonical chain's front: `agreements` is the eleventh and last link of
 * `Contract → PerformanceBlueprint → Milestone → DefinitionOfDonePackage → ExecutionWorkspace →
 * CompletionCertificate → PaymentEligibility → FinancialEntitlement → ReleaseRequest →
 * PaymentInstruction → ReconciliationRecord` to become durable. Batch E made three of the four missing
 * links durable; this one makes the fourth.
 *
 * ## Four column names diverge from their fields, and the divergence is real
 *
 * Batches A-E could take snake_case of the field name as the column name. Here they disagree, in the
 * schema that has existed since `202608030002`:
 *
 * | aggregate | field | column |
 * |---|---|---|
 * | `documentVersions` | `number` | `version` |
 * | `contractDrafts` | `documentVersionId` | `current_document_version_id` |
 * | `clauseVersions` | `guidance` | `guidance_reference` |
 * | `negotiationRounds` | `number` | `round_number` |
 *
 * The schemas describe the *domain* shape, because that is what the engines pass to `append` and read
 * back from `list`. `batch-f-repository.ts` is where the two vocabularies meet, and it is the only
 * place they may.
 *
 * ## Two aggregates have no table at all
 *
 * `contractComments` and `signatureCallbacks` are written by `ContractAuthoringEngine.comment` and
 * `DigitalExecutionEngine.callback`, and neither has ever had a relation anywhere in the ninety-eight
 * tables the migrations declare. Every batch so far converged tables that already existed;
 * `202608110005` creates these two, which is why they are the only Batch F aggregates whose schema had
 * no prior column to disagree with.
 *
 * ## `version` is a domain field again, and here it is both
 *
 * As in Batch E, several of these aggregates carry a `version` that is a revision number rather than a
 * row counter — a template version, a clause version, a policy version — so the persistence layer's
 * optimistic-concurrency column is `row_version` across the whole batch.
 *
 * `contractDrafts.version` is the exception that proves the rule worth keeping. It genuinely advances
 * on every edit: `setVariables`, `lock`, `submit` and `revise` each write `version: d.version + 1`. It
 * could therefore have served as the concurrency column for that one table. It does not, for two
 * reasons — a per-table exception is a rule a reader has to remember, and the value arrives from the
 * caller, so a caller that forgot to advance it would turn a stale-write refusal into a silent
 * overwrite. The store owns its own counter.
 *
 * ## Every hash is a digest, and that is checkable
 *
 * Seven fields across five aggregates are SHA-256 digests, and `sha256Hex` says so rather than
 * accepting any text. That is not a guess about intent: every one is assigned from the single
 * `createHash('sha256')...digest('hex')` helper in `packages/agreement-creation/src/index.ts`, or
 * copied from a field that was — `ApprovalRequest.documentHash` from the document version's
 * `contentHash`, `SignaturePackage.documentHash` from the same, `ExecutionCertificate.documentHash`
 * from the package's. The migration turns the same rule into a column constraint, and the composite
 * foreign keys make the *copying* structural rather than conventional.
 *
 * Derived from engine semantics, not from table introspection. Where the two disagree the engine wins
 * and the disagreement is recorded — see `BATCH_F_UNREACHED_STATES`.
 */

// ---------------------------------------------------------------------------------------
// Engine 11 — Contract Authoring
// ---------------------------------------------------------------------------------------

export const agreementSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    // Unique per workspace since `202608030002`, and the engine checks the same pair before writing.
    contractNumber: requiredText,
    title: requiredText,
    contractType: requiredText,
    ownerUserId: identifier,
    // The full declared lifecycle, of which `ContractAuthoringEngine.create` writes only `DRAFT` and
    // no engine writes any other. Kept complete rather than narrowed to what is reached: the states
    // are the contract's own vocabulary, the transitions are Batch F's recorded gap, and a schema that
    // admitted only `DRAFT` would have to be widened by whoever implements them.
    status: z.enum([
      'DRAFT',
      'NEGOTIATION',
      'AWAITING_APPROVAL',
      'APPROVED',
      'AWAITING_SIGNATURE',
      'PARTIALLY_SIGNED',
      'EXECUTED',
    ]),
    createdAt: instant,
    version: revisionNumber,
  })
  .strict();

export const templateVariableSchema = z
  .object({
    key: identifier,
    required: z.boolean(),
  })
  .strict();

export const templateVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    templateKey: identifier,
    // Counted from the workspace's existing versions of this key, and unique on
    // `(workspace_id, template_key, version)` since `202608030002`.
    version: revisionNumber,
    // May legitimately be empty: a template with no variables is a fixed-text template, and
    // `submit` checking required variables over an empty list is a check that passes.
    variableSchema: z.array(templateVariableSchema),
    contentHash: sha256Hex,
    status: z.enum(['DRAFT', 'PUBLISHED', 'SUPERSEDED']),
    createdBy: identifier,
    createdAt: instant,
  })
  .strict();

export const documentVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    draftId: identifier,
    // The field is `number`; the column is `version`. `revise` writes `old.number + 1`.
    number: revisionNumber,
    contentReference: requiredText,
    contentHash: sha256Hex,
    status: z.enum(['DRAFT', 'NEGOTIATED', 'APPROVED', 'EXECUTED']),
    createdBy: identifier,
    createdAt: instant,
    // Present on every version but the first. `revise` sets it to the version being replaced, which
    // is what makes the document lineage reconstructible.
    supersedesId: identifier.optional(),
    aiProposed: z.boolean(),
  })
  .strict();

export const contractDraftSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    templateVersionId: identifier,
    // The field is `documentVersionId`; the column is `current_document_version_id`. It moves: `revise`
    // points the draft at the new version it just appended.
    documentVersionId: identifier,
    status: z.enum(['WORKING', 'LOCKED', 'SUBMITTED', 'RETURNED', 'SUPERSEDED']),
    // Filled in against the template's declared variables. Unconstrained values, because a template
    // variable is whatever the template says it is.
    variables: z.record(z.unknown()),
    // Set by `lock` and never cleared, so a submitted draft still records who locked it. The migration
    // makes the implication one way only — LOCKED requires a locker, a locker does not require LOCKED.
    lockedBy: identifier.optional(),
    createdBy: identifier,
    createdAt: instant,
    // The one domain `version` in this batch that genuinely advances on every edit. See this file's
    // header for why it is still not the concurrency column.
    version: revisionNumber,
  })
  .strict();

export const contractCommentSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    body: requiredText,
    // The whole point of the aggregate. `comments(..., external = true)` returns only `SHARED`, so this
    // field is the boundary between privileged internal discussion and what a counterparty may read —
    // which makes it a governed value set rather than a label.
    visibility: z.enum(['INTERNAL', 'SHARED']),
    authorId: identifier,
    createdAt: instant,
  })
  .strict();

// ---------------------------------------------------------------------------------------
// Engine 12 — Clause Intelligence
// ---------------------------------------------------------------------------------------

export const clauseRiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const clauseVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    clauseKey: identifier,
    version: revisionNumber,
    bodyHash: sha256Hex,
    risk: clauseRiskSchema,
    // The field is `guidance`; the column is `guidance_reference`. `guidance()` refuses to return it to
    // an external caller, so it is internal legal reasoning rather than clause text.
    guidance: requiredText,
    status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED', 'SUPERSEDED']),
    createdAt: instant,
  })
  .strict();

export const clauseInstanceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    draftId: identifier,
    // Absent exactly when the clause is custom. `insert` sets `source: 'LIBRARY'` with a published
    // clause version and `source: 'CUSTOM'` with a body and no version, never any other pairing —
    // enforced below, and as a column constraint in `202608110005`.
    clauseVersionId: identifier.optional(),
    bodyHash: sha256Hex,
    source: z.enum(['LIBRARY', 'CUSTOM']),
    createdAt: instant,
  })
  .strict()
  .refine((value) => (value.source === 'LIBRARY') === (value.clauseVersionId !== undefined), {
    message: 'a LIBRARY clause cites a clause version and a CUSTOM clause does not',
    path: ['clauseVersionId'],
  });

export const clauseDeviationSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    instanceId: identifier,
    baselineVersionId: identifier,
    // Copied from the baseline clause version rather than supplied: `deviate` reads `b.risk`. A
    // deviation cannot understate the risk of the clause it departs from.
    risk: clauseRiskSchema,
    summary: requiredText,
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    createdAt: instant,
  })
  .strict();

// ---------------------------------------------------------------------------------------
// Engine 13 — Negotiation
// ---------------------------------------------------------------------------------------

export const negotiationRoundSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    // The field is `number`; the column is `round_number`. Unique per contract since `202608030002`.
    number: revisionNumber,
    submittedBy: identifier,
    documentVersionId: identifier,
    status: z.enum(['SUBMITTED', 'WITHDRAWN', 'ACCEPTED']),
    // `accept` refuses a round with any item outstanding, so an empty array is the normal end state
    // rather than a missing value.
    mandatoryOpenItems: z.array(requiredText),
    createdAt: instant,
  })
  .strict();

// ---------------------------------------------------------------------------------------
// Engine 14 — Approval Workflow
// ---------------------------------------------------------------------------------------

export const approvalStepSchema = z
  .object({
    role: identifier,
    // The identity assurance a decision at this step demands. `decide` compares the actor's level
    // against it and raises STEP_UP_REQUIRED, so this is an authorization input and not a hint.
    minimumAssurance: z.enum(['IAL1_BASIC', 'IAL2_VERIFIED', 'IAL3_HIGH_ASSURANCE']),
  })
  .strict();

export const approvalPolicySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    version: revisionNumber,
    // Non-empty, matching `policy`'s own APPROVAL_STEPS_REQUIRED refusal: a policy with no steps would
    // route a request that is approved the moment it is created.
    steps: z.array(approvalStepSchema).min(1),
    status: z.enum(['DRAFT', 'PUBLISHED']),
    createdAt: instant,
  })
  .strict();

export const approvalRequestSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    documentVersionId: identifier,
    // Copied from the cited document version's `contentHash`. The migration makes that copy a composite
    // foreign key, so a request cannot name one document and carry another's digest.
    documentHash: sha256Hex,
    policyId: identifier,
    requesterId: identifier,
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED']),
    // How far through the policy's steps this request has travelled. Zero at creation, so a count and
    // not a revision.
    completedSteps: count,
    createdAt: instant,
  })
  .strict();

export const approvalDecisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    requestId: identifier,
    // The index into the policy's steps, taken from the request's `completedSteps`, so zero-based.
    // Unique on `(request_id, step)` since `202608030002`, which is what stops one step being decided
    // twice.
    step: count,
    approverId: identifier,
    decision: z.enum(['APPROVE', 'REJECT']),
    // May legitimately be empty: `decide` defaults it, and an unconditional approval carries no
    // conditions.
    conditions: z.array(requiredText),
    createdAt: instant,
  })
  .strict();

// ---------------------------------------------------------------------------------------
// Engine 15 — Digital Execution
// ---------------------------------------------------------------------------------------

export const signerSchema = z
  .object({
    userId: identifier,
    // Refused when blank by `create`'s SIGNATORY_AUTHORITY_REQUIRED: a signature with no cited
    // authority to sign is not evidence that the party is bound.
    authorityReference: requiredText,
    witnessRequired: z.boolean(),
    signedAt: instant.optional(),
    witnessedAt: instant.optional(),
  })
  .strict()
  // `callback` writes `witnessedAt` only for a WITNESSED action on a signer, and completion requires
  // `signedAt` for every signer plus `witnessedAt` for those who need one. A witnessed-but-unsigned
  // signer is therefore a state no engine produces, and one that would make the completion test read
  // as satisfied for the wrong reason.
  .refine((value) => value.witnessedAt === undefined || value.signedAt !== undefined, {
    message: 'a signature cannot be witnessed before it is made',
    path: ['witnessedAt'],
  });

export const signaturePackageSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    contractId: identifier,
    approvalRequestId: identifier,
    documentVersionId: identifier,
    documentHash: sha256Hex,
    // Non-empty, matching `create`'s own refusal. A package with no signers completes immediately,
    // because `every` over an empty list is true — which would issue an execution certificate for a
    // document nobody signed.
    signers: z.array(signerSchema).min(1),
    status: z.enum(['DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'VOID']),
    // Which provider adapter sent it. Recorded because a signature is only as good as the provider
    // that witnessed it, and the certificate's canonical hash does not include it.
    providerKey: identifier,
    createdAt: instant,
  })
  .strict();

export const signatureCallbackSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    // The provider's own event identifier, and the whole reason the aggregate exists: `callback` treats
    // an event it has already seen as a replay and returns the package unchanged. Unique per workspace
    // in `202608110005` — per workspace and not globally, because a provider event identifier is only
    // unique within the account it was issued for.
    eventId: requiredText,
    createdAt: instant,
  })
  .strict();

export const executionCertificateSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    // One certificate per package, enforced by a UNIQUE column since `202608030002` and by `issue`
    // returning the existing certificate rather than minting a second.
    packageId: identifier,
    contractId: identifier,
    documentHash: sha256Hex,
    // The digest of the package, the document and every signer's authority and timestamps — the
    // artefact that makes the execution independently recomputable.
    canonicalHash: sha256Hex,
    status: z.enum(['VALID', 'REVOKED']),
    issuedAt: instant,
  })
  .strict();

/**
 * The schema version stored beside every Batch F row.
 *
 * Distinct from each aggregate's domain `version`, which is a revision number, and from `row_version`,
 * which counts writes. This one says which *shape* the row is in, and a row declaring a version this
 * build cannot parse is refused rather than read optimistically.
 */
export const BATCH_F_SCHEMA_VERSION = 1;

export type BatchFAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  readonly schemaVersion: number;
};

/**
 * The registry, in dependency order.
 *
 * Load-bearing, because the tenant-composite foreign keys make it so. The order is not simply
 * "parents first": `agreement_document_versions.draft_id` and
 * `agreement_drafts.current_document_version_id` point at each other, and `createDraft` appends the
 * document version first, so the document version precedes the draft here and the draft's side is the
 * only one of the pair that is a foreign key. See `BATCH_F_UNENFORCED_INVARIANTS`.
 */
export const BATCH_F_AGGREGATES: readonly BatchFAggregateContract[] = Object.freeze([
  { collection: 'agreements', table: 'agreements_v2', engine: '11', schema: agreementSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'templateVersions', table: 'contract_template_versions', engine: '11', schema: templateVersionSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'documentVersions', table: 'agreement_document_versions', engine: '11', schema: documentVersionSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'contractDrafts', table: 'agreement_drafts', engine: '11', schema: contractDraftSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'contractComments', table: 'contract_comments', engine: '11', schema: contractCommentSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'clauseVersions', table: 'clause_versions_v2', engine: '12', schema: clauseVersionSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'clauseInstances', table: 'clause_instances_v2', engine: '12', schema: clauseInstanceSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'clauseDeviations', table: 'clause_deviations_v2', engine: '12', schema: clauseDeviationSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'negotiationRounds', table: 'negotiation_rounds', engine: '13', schema: negotiationRoundSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'approvalPolicies', table: 'approval_policies_v2', engine: '14', schema: approvalPolicySchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'approvalRequests', table: 'agreement_approval_requests', engine: '14', schema: approvalRequestSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'approvalDecisions', table: 'agreement_approval_decisions', engine: '14', schema: approvalDecisionSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'signaturePackages', table: 'signature_packages_v2', engine: '15', schema: signaturePackageSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'signatureCallbacks', table: 'signature_callbacks', engine: '15', schema: signatureCallbackSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
  { collection: 'agreementExecutionCertificates', table: 'agreement_execution_certificates', engine: '15', schema: executionCertificateSchema, schemaVersion: BATCH_F_SCHEMA_VERSION },
]);

/** Collection names, for a store deciding whether it owns a collection. */
export const BATCH_F_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_F_AGGREGATES.map((aggregate) => aggregate.collection),
);

/** Table names, for readiness checks and certification. */
export const BATCH_F_TABLES: readonly string[] = Object.freeze(
  BATCH_F_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The tables this batch creates rather than converges.
 *
 * Named because it is the first time in the programme that a batch adds a relation. `contractComments`
 * and `signatureCallbacks` are written by canonical engines and had no table among the ninety-eight the
 * migrations declared, so every comment and every provider callback was unstorable — not merely
 * unrouted, which is what the other sixty-five registered collections are.
 */
export const BATCH_F_CREATED_TABLES: readonly string[] = Object.freeze([
  'contract_comments',
  'signature_callbacks',
]);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Two different reasons, both stated, because "no engine updates it today" is not one of them. That is
 * a fact about the current implementation, and encoding it as a permanent database rule is exactly the
 * defect this programme has now found seven times.
 *
 * **Nothing to transition.** `contractComments`, `clauseInstances` and `signatureCallbacks` have no
 * status column at all. A row with no lifecycle cannot have one refused.
 *
 * **A boundary that already holds.** `documentVersions` and `approvalDecisions` have carried a blanket
 * `<table>_append_only` trigger since `202608030002`, and no engine transitions either. `documentVersions`
 * does declare a four-state lifecycle, so the case is not "it has no states" — it is that removing a
 * constraint which currently holds, to accommodate a lifecycle nobody has implemented, is the same
 * speculation as adding one, pointed the other way.
 *
 * The reverse case is `agreements` and `approvalPolicies`. Neither is transitioned by any engine either,
 * and neither has a mutation trigger today — so making them append-only would be inventing a refusal
 * their own declared states contradict. They are governed instead: identity immutable, no DELETE,
 * concurrency enforced, and the transitions permitted if and when someone writes them.
 */
export const BATCH_F_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'documentVersions',
  'contractComments',
  'clauseInstances',
  'approvalDecisions',
  'signatureCallbacks',
]);

/**
 * The canonical chain link this batch makes durable.
 *
 * One entry, and the last one. With `agreements` routed, all eleven links of the canonical chain have a
 * relational home — the claim `docs/persistence/DURABILITY_GAP_ANALYSIS.md` opened by measuring at
 * seven of eleven.
 */
export const BATCH_F_CANONICAL_CHAIN_LINKS: readonly string[] = Object.freeze(['agreements']);

/**
 * Lifecycle states these aggregates declare that no canonical engine writes.
 *
 * Recorded rather than removed, and recorded rather than left implicit, because the two mistakes
 * available here are opposite and both damaging. Narrowing a schema to the states currently reached
 * would make it wrong the moment the transitions are implemented; treating an unreached state as
 * reachable-and-therefore-terminal would refuse writes that are legitimate.
 *
 * `202608110005` uses this list directly: an unreached state is never made terminal, because a terminal
 * state is a claim that no transition leaves it, and there is no evidence either way for a state
 * nothing enters.
 */
export const BATCH_F_UNREACHED_STATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // `create` writes DRAFT; nothing transitions an agreement. The six remaining states are the
  // contract lifecycle the platform's own chain describes and Engines 11-15 do not yet drive.
  agreements: Object.freeze([
    'NEGOTIATION',
    'AWAITING_APPROVAL',
    'APPROVED',
    'AWAITING_SIGNATURE',
    'PARTIALLY_SIGNED',
    'EXECUTED',
  ]),
  // `createDraft` and `revise` write DRAFT; the document's own progression through the approval and
  // signature stages is never recorded on the version.
  documentVersions: Object.freeze(['NEGOTIATED', 'APPROVED', 'EXECUTED']),
  // `setVariables`, `lock`, `submit` and `revise` reach WORKING, LOCKED and SUBMITTED. Nothing returns
  // a draft or supersedes one.
  contractDrafts: Object.freeze(['RETURNED', 'SUPERSEDED']),
  // `publish` and `retire` reach PUBLISHED and RETIRED. Unlike a template version, a clause version is
  // never superseded — `publish` does not demote the previous one.
  clauseVersions: Object.freeze(['SUPERSEDED']),
  // `approve` reaches APPROVED. Nothing rejects a deviation, which is why REJECTED is not terminal.
  clauseDeviations: Object.freeze(['REJECTED']),
  // `policy` writes PUBLISHED directly; there is no draft-then-publish path for an approval policy.
  approvalPolicies: Object.freeze(['DRAFT']),
  // `callback` reaches SENT, PARTIALLY_SIGNED, COMPLETED and DECLINED. Nothing voids a package.
  signaturePackages: Object.freeze(['VOID']),
});

/**
 * Cross-row rules the engines enforce that the schema and the columns cannot.
 *
 * Stated so that "certified" never reads as "everything is enforced". Each entry names the rule and why
 * it resists the mechanisms available, and none is approximated.
 */
export const BATCH_F_UNENFORCED_INVARIANTS: readonly string[] = Object.freeze([
  // `create` refuses unless `a.status === 'APPROVED'`. A foreign key can carry a value across tables,
  // which is how the document-hash chain works, but it cannot require a *current* status: the parent's
  // status changes after the child is written, and `invalidateOnChange` is specifically meant to change
  // it. Enforcing it structurally would need the approval's status in the package's key, which would
  // then have to be updated in lockstep — a worse rule than the engine's.
  'signaturePackages.approvalRequestId must cite an APPROVED request',
  // `insert` refuses unless the cited clause version is PUBLISHED. Same shape, same reason, plus
  // `retire` deliberately moves a published clause out of that state afterwards.
  'clauseInstances.clauseVersionId must cite a PUBLISHED clause version',
  // `createDraft` refuses unless the template is PUBLISHED, and `publishTemplate` supersedes it later.
  'contractDrafts.templateVersionId must cite a PUBLISHED template version',
  // The mutual reference. `agreement_document_versions.draft_id` and
  // `agreement_drafts.current_document_version_id` name each other, and `createDraft` appends the
  // document version before the draft exists — two `append` calls, not one statement — so the
  // document-version side cannot be a foreign key without being deferrable, and a deferred constraint
  // only helps inside a transaction the store is never told about.
  'documentVersions.draftId has no foreign key to the draft it belongs to',
  // `decide` reads `p.steps[r.completedSteps]` and refuses when the step does not exist, so a request
  // cannot advance past its policy's step count. The bound lives in another table's JSONB array length,
  // which no column constraint can reach.
  'approvalRequests.completedSteps must not exceed the policy step count',
]);

/** The contract for a collection, or `undefined` when Batch F does not own it. */
export function batchFContract(collection: string): BatchFAggregateContract | undefined {
  return BATCH_F_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}

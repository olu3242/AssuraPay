import { z } from 'zod';
import {
  count,
  identifier,
  instant,
  minorUnits,
  percentage,
  requiredText,
  revisionNumber,
  sha256Hex,
} from './primitives';

/**
 * The canonical persisted-state schemas for Batch M — the nine agent-runtime aggregates of canonical
 * Engines 61-70, the governed agent surface.
 *
 * The last batch in the register, and the only one since Batch A that **creates rather than converges**. None
 * of these nine tables exists, but something else does, and the first scan for this batch missed it: an
 * earlier by-name search of `current_schema()` found nothing and concluded there was no prior art.
 * `202608030012_agent_runtime.sql` creates `agent_runtime.records` — one generic envelope for all nine
 * aggregates, discriminated by a `record_type` column, in a **schema of its own**. That is why the scan missed
 * it, and it is also why every gate in the repository missed it: `certifySchemaOwnership` and the RLS
 * certification both inspect `current_schema()`, so a table outside it is not governed by anything. It has no
 * reader and no writer in any TypeScript file, and `202608110017` retires it.
 *
 * Three of its properties were proved against a live migrated instance, and they invert the batch's premise —
 * there *was* a mutation boundary contradicting its engines, and it was wrong in both directions at once:
 *
 *   * a `capability` record can be edited into `EXECUTE_DETERMINISTIC` with `protectedState: true` — the exact
 *     shape `CapabilityRegistryEngine.register` refuses, and the row that is the only thing standing between
 *     an agent and a direct protected-state change. `UPDATE 1`, no refusal;
 *   * an `execution` record cannot transition at all. `QUEUED → RUNNING` raises `agent runtime history is
 *     append-only`, so Engine 61's entire lifecycle is unperformable — the same defect Batches K and L found,
 *     for the third time;
 *   * a `DELETE` reports `DELETE 0` and leaves the row in place. The trigger is `BEFORE DELETE` and returns
 *     `NEW`, which is NULL in a delete context, so PL/pgSQL skips the row operation. The delete is neither
 *     performed nor refused: the caller is told nothing matched.
 *
 * A fourth is structural. Its policy predicate is `current_setting('app.tenant_id', true)::uuid`, the
 * pre-trust convention, while `trust_current_tenant()` returns TEXT — so under the runtime's actual identity
 * every statement against the table raises `invalid input syntax for type uuid`, an error naming a type rather
 * than a permission. And being one envelope, it can express no invariant of any of the nine: its only
 * constraints are a primary key and the `record_type` CHECK.
 *
 * So the batch is still a create, and the reason to state the discovery rather than quietly build over it is
 * that it is the same lesson twice: an aggregate stored as an untyped payload cannot carry its own rules, and
 * an object outside `current_schema()` is outside the reach of every gate meant to catch that.
 *
 * ## The invariant this batch exists to hold
 *
 * `CapabilityRegistryEngine.register` refuses `AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES` when a
 * capability touches protected state in any mode but `PROPOSE`. That is the agent surface's version of
 * CLAUDE.md's non-custody constraint: an agent may propose a change to protected state and never execute one.
 *
 * The whole guard rests on one row. `AgentRuntimeEngine.execute` reads the capability and invokes the
 * deterministic gateway when `mode === 'EXECUTE_DETERMINISTIC' && !approvalRequired` — so a capability row
 * saying `EXECUTE_DETERMINISTIC` with `protectedState: true` is an agent executing a protected-state change
 * directly. The engine refuses to *create* one, but `deactivate()` is a `replace`, so without an immutable
 * `mode` and `protected_state` the row could be edited into that shape afterwards. `202608110017` makes it a
 * CHECK and holds both columns immutable.
 *
 * ## An agent cannot approve its own proposal
 *
 * `HumanApprovalEngine` guards this twice — `AGENT_ID_CANNOT_BE_HUMAN_ACTOR` at request time and
 * `AGENT_CANNOT_SELF_APPROVE` at decision time — and it matters more than it first appears, because
 * `ProtectedAction` includes `'CERTIFICATION'`. An agent that approved its own request could manufacture a
 * completion certificate, and CLAUDE.md's second hard constraint is that every release is
 * certified-work-backed. So `decided_by <> requested_by_agent_id` is a database constraint here, not only an
 * engine check.
 *
 * Consumption is single-use and hash-matched: `consume()` refuses an already-consumed approval and one whose
 * `proposalHash` does not match what is being executed, so an approval for one proposal cannot authorise a
 * different one.
 *
 * ## Six transition, three are append-only
 *
 * A capability is deactivated, an agent and a governance policy are superseded by a new version, a prompt
 * version moves DRAFT → PUBLISHED → RETIRED, an approval is decided and then consumed, and an execution moves
 * through QUEUED → RUNNING → SUCCEEDED/FAILED/CANCELLED. The three that do not transition are the ones the
 * engines describe as records of what happened: a context snapshot, a memory entry — Engine 67 is
 * "append-only, explicit, inspectable memory" — and a telemetry record.
 *
 * ## Sequence numbers computed by counting
 *
 * `ExecutionMemoryEngine.append` derives `sequence` from the count of prior entries, and
 * `AgentRegistryEngine` / `AgentGovernanceEngine` derive `version` the same way. Every one of those is a
 * read-then-write that two concurrent callers both satisfy, so each needs a real unique key —
 * `(tenant, workspace, execution, sequence)` for memory, and single-active partial indexes for the rest.
 * Without them a conversation's memory has two entries claiming the same position and nothing to say which
 * came first, which for an inspectable audit of an agent's reasoning is the whole point lost.
 *
 * Derived from engine semantics. The one table that exists is an untyped envelope, so there is no column shape
 * to introspect — only a boundary to retire.
 */

// Engine 62 — Capability registry

export const capabilityModeSchema = z.enum(['READ', 'PROPOSE', 'EXECUTE_DETERMINISTIC']);

export const protectedActionSchema = z.enum(['APPROVAL', 'WAIVER', 'OVERRIDE', 'CERTIFICATION']);

export const capabilitySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    name: requiredText,
    owner: requiredText,
    // The permission Engine 03 evaluates before the capability runs. A capability with no permission is one
    // nothing authorises.
    permission: requiredText,
    mode: capabilityModeSchema,
    // The named contract the deterministic gateway dispatches on — never a function or a state handle, which
    // is what keeps a capability a contract rather than arbitrary code.
    deterministicContract: requiredText,
    aiAllowed: z.boolean(),
    humanApprovalRequired: z.boolean(),
    protectedState: z.boolean(),
    active: z.boolean(),
    createdAt: instant,
  })
  .strict()
  // `AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES`. The agent surface's non-custody rule: an agent may
  // propose a change to protected state and never execute one. `execute()` invokes the deterministic gateway
  // on `EXECUTE_DETERMINISTIC`, so this row is the only thing standing between an agent and a direct
  // protected-state change.
  .refine((value) => !value.protectedState || value.mode === 'PROPOSE', {
    message: 'a capability touching protected state may only propose',
    path: ['mode'],
  });

// Engine 63 — Agent registry

export const registeredAgentSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    name: requiredText,
    version: revisionNumber,
    owner: requiredText,
    promptIds: z.array(identifier),
    allowedCapabilityIds: z.array(identifier),
    active: z.boolean(),
    createdAt: instant,
  })
  .strict();

// Engine 64 — Prompt registry

export const promptVersionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    promptId: identifier,
    version: revisionNumber,
    template: requiredText,
    requiredVariables: z.array(requiredText),
    // What the gateway validates the model's output against. A version with no output contract accepts
    // anything a model returns.
    outputContract: requiredText,
    status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']),
    // A digest of the template, so what was published can be shown to be what ran.
    checksum: sha256Hex,
    createdAt: instant,
  })
  .strict();

// Engine 66 — Execution context

/**
 * The governed references an execution was given.
 *
 * The only aggregate in the batch whose domain type carries `tenantId` as a field of its own. Engine 66's
 * comment explains why the shape is references rather than data: "caller supplies governed
 * references/snapshots; this package never reads domain stores" — so the snapshot is what the agent was
 * allowed to see, not a copy of it.
 */
export const executionContextSnapshotSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    agreementId: identifier.optional(),
    blueprintId: identifier.optional(),
    milestoneIds: z.array(identifier),
    definitionOfDoneIds: z.array(identifier),
    historyRefs: z.array(requiredText),
    tenantId: identifier,
    userId: identifier,
    // The permissions in force when the snapshot was taken. An agent's reach is bounded by this list, so a
    // snapshot is also the record of what it was entitled to.
    permissions: z.array(requiredText),
    checksum: sha256Hex,
    createdAt: instant,
  })
  .strict();

// Engine 67 — Execution memory

export const memoryEntrySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    agentId: identifier,
    // Derived by counting prior entries (`prior.length + 1`), so two concurrent appends both compute the same
    // number. The unique key in `202608110017` is what actually orders them.
    //
    // `revisionNumber` rather than `count`: a sequence number is a position, and the engine's first entry is
    // 1. `count` would admit a zero the column refuses, which is a schema looser than its own table.
    sequence: revisionNumber,
    kind: z.enum(['USER', 'AGENT', 'REASONING_METADATA', 'TOOL', 'RESULT']),
    content: z.unknown(),
    contentHash: sha256Hex,
    createdAt: instant,
  })
  .strict();

// Engine 68 — Human approval

/**
 * Named `agentApprovalRequestSchema`, not `approvalRequestSchema`.
 *
 * Batch F already exports the latter for Engine 15's contract-approval aggregate, and the two are different
 * things: that one routes a document version to named approvers under a policy, this one gates an agent's
 * proposal on a human. The barrel re-exports every batch flat, so a shared name is a compile error rather
 * than a silent shadow — which is the right outcome, and the reason for the prefix.
 */
export const agentApprovalRequestSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    requestedByAgentId: identifier,
    action: protectedActionSchema,
    // What the approval is *for*. `consume()` refuses when this does not match the proposal being executed, so
    // an approval for one proposal cannot authorise a different one.
    //
    // A digest, not merely text. Engine 68 accepted any string until this batch — its own suite passed
    // `'abc'` — while every sibling hash in the package (`checksum`, `contentHash`) comes from the one
    // `createHash('sha256')` helper. An approval whose subject cannot be recomputed cannot be shown to be the
    // proposal that was approved, and `action` may be `CERTIFICATION`. The engine now asserts the same shape,
    // so the store and the engine agree rather than the store refusing what the engine accepts.
    proposalHash: sha256Hex,
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    decidedBy: identifier.optional(),
    decidedAt: instant.optional(),
    consumedAt: instant.optional(),
    createdAt: instant,
  })
  .strict()
  // A decision records who and when, and a pending request records neither.
  .refine((value) => (value.status !== 'PENDING') === (value.decidedBy !== undefined), {
    message: 'a decided request names its decider, and a pending one names none',
    path: ['decidedBy'],
  })
  .refine((value) => (value.decidedBy !== undefined) === (value.decidedAt !== undefined), {
    message: 'a decider and a decision time are recorded together',
    path: ['decidedAt'],
  })
  // `AGENT_CANNOT_SELF_APPROVE`, and the reason it is here rather than only in the engine: `action` may be
  // `CERTIFICATION`, so an agent approving its own request could manufacture certified work — and CLAUDE.md's
  // second hard constraint is that every release is certified-work-backed.
  .refine((value) => value.decidedBy === undefined || value.decidedBy !== value.requestedByAgentId, {
    message: 'an agent cannot approve its own request',
    path: ['decidedBy'],
  })
  // Only an approved request is consumable, and only once. `consume()` refuses otherwise.
  .refine((value) => value.consumedAt === undefined || value.status === 'APPROVED', {
    message: 'only an approved request can be consumed',
    path: ['consumedAt'],
  })
  .refine(
    (value) =>
      value.decidedAt === undefined || Date.parse(value.decidedAt) >= Date.parse(value.createdAt),
    { message: 'a request cannot be decided before it was made', path: ['decidedAt'] },
  )
  .refine(
    (value) =>
      value.consumedAt === undefined ||
      value.decidedAt === undefined ||
      Date.parse(value.consumedAt) >= Date.parse(value.decidedAt),
    { message: 'a request cannot be consumed before it was decided', path: ['consumedAt'] },
  );

// Engine 69 — Telemetry

export const telemetryRecordSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    executionId: identifier,
    agentId: identifier,
    provider: identifier.optional(),
    latencyMs: count,
    // Integer minor units, per CLAUDE.md's fourth constraint — model spend is money like any other.
    costMinor: minorUnits,
    inputTokens: count,
    outputTokens: count,
    errors: count,
    qualityScore: percentage.optional(),
    // The two flags an operator filters on when auditing what a model did.
    hallucinationFlag: z.boolean(),
    approvalRequested: z.boolean(),
    createdAt: instant,
  })
  .strict();

// Engine 70 — Governance policy

export const governancePolicySchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    version: revisionNumber,
    allowedRoles: z.array(requiredText),
    allowedPromptIds: z.array(identifier),
    allowedCapabilityIds: z.array(identifier),
    allowedModels: z.array(requiredText),
    requireApprovalFor: z.array(protectedActionSchema),
    active: z.boolean(),
    createdAt: instant,
  })
  .strict();

// Engine 61 — Agent runtime

export const agentExecutionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    agentId: identifier,
    capabilityId: identifier,
    promptVersionId: identifier,
    contextSnapshotId: identifier,
    status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
    attempts: count,
    // The output, which Engine 61's comment insists is "a proposal/result artifact, never protected state".
    proposal: z.unknown().optional(),
    error: requiredText.optional(),
    startedAt: instant.optional(),
    completedAt: instant.optional(),
    createdAt: instant,
  })
  .strict()
  // A run that has started records when, and a queued one has not started.
  .refine((value) => (value.status !== 'QUEUED') === (value.startedAt !== undefined), {
    message: 'a run that left the queue records when it started',
    path: ['startedAt'],
  })
  // A finished run records when it finished; a live one does not.
  .refine(
    (value) =>
      ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(value.status) === (value.completedAt !== undefined),
    { message: 'a finished run records when it finished', path: ['completedAt'] },
  )
  // A failure says why. An execution that failed with no error is one nobody can diagnose, and `execute()`
  // always records `lastError`.
  .refine((value) => value.status !== 'FAILED' || value.error !== undefined, {
    message: 'a failed run records its error',
    path: ['error'],
  })
  .refine(
    (value) =>
      value.completedAt === undefined ||
      value.startedAt === undefined ||
      Date.parse(value.completedAt) >= Date.parse(value.startedAt),
    { message: 'a run cannot finish before it started', path: ['completedAt'] },
  );

/**
 * The schema version stored beside every Batch M row.
 *
 * One for all nine, because they are created together — the only batch where "created" is literal.
 */
export const BATCH_M_SCHEMA_VERSION = 1;

export type BatchMAggregateContract = {
  readonly collection: string;
  readonly table: string;
  readonly engine: string;
  readonly schema: z.ZodTypeAny;
  readonly schemaVersion: number;
};

export const BATCH_M_AGGREGATES: readonly BatchMAggregateContract[] = Object.freeze([
  { collection: 'agentCapabilities', table: 'agent_capabilities', engine: '62', schema: capabilitySchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'registeredAgents', table: 'registered_agents', engine: '63', schema: registeredAgentSchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'promptVersions', table: 'prompt_versions', engine: '64', schema: promptVersionSchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'agentContextSnapshots', table: 'agent_context_snapshots', engine: '66', schema: executionContextSnapshotSchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'agentMemory', table: 'agent_memory', engine: '67', schema: memoryEntrySchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'agentApprovalRequests', table: 'agent_approval_requests', engine: '68', schema: agentApprovalRequestSchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'agentTelemetry', table: 'agent_telemetry', engine: '69', schema: telemetryRecordSchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'agentGovernancePolicies', table: 'agent_governance_policies', engine: '70', schema: governancePolicySchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
  { collection: 'agentExecutions', table: 'agent_executions', engine: '61', schema: agentExecutionSchema, schemaVersion: BATCH_M_SCHEMA_VERSION },
]);

export const BATCH_M_COLLECTIONS: readonly string[] = Object.freeze(
  BATCH_M_AGGREGATES.map((aggregate) => aggregate.collection),
);

export const BATCH_M_TABLES: readonly string[] = Object.freeze(
  BATCH_M_AGGREGATES.map((aggregate) => aggregate.table),
);

/**
 * The collections whose rows may never be updated, in the store as well as the database.
 *
 * Three of nine, and each is a record of what happened rather than a thing with a lifecycle: the governed
 * references an execution was given, a memory entry — Engine 67 is "append-only, explicit, inspectable
 * memory" — and a telemetry measurement.
 */
export const BATCH_M_APPEND_ONLY_COLLECTIONS: readonly string[] = Object.freeze([
  'agentContextSnapshots',
  'agentMemory',
  'agentTelemetry',
]);

/** The contract for a collection, or `undefined` when Batch M does not own it. */
export function batchMContract(collection: string): BatchMAggregateContract | undefined {
  return BATCH_M_AGGREGATES.find((aggregate) => aggregate.collection === collection);
}

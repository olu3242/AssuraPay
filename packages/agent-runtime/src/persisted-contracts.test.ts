import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  agentApprovalRequestSchema,
  agentExecutionSchema,
  capabilitySchema,
  executionContextSnapshotSchema,
  governancePolicySchema,
  memoryEntrySchema,
  promptVersionSchema,
  registeredAgentSchema,
  telemetryRecordSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  AgentExecution,
  ApprovalRequest,
  Capability,
  ExecutionContextSnapshot,
  GovernancePolicy,
  MemoryEntry,
  PromptVersion,
  RegisteredAgent,
  TelemetryRecord,
} from './index';

/**
 * Compile-time proof that this package's Batch M domain types and their canonical Zod schemas describe the
 * same shape, plus the rules those schemas enforce.
 *
 * Two rules are deliberately not here, for the same reason in both cases: they are properties of a *set*, not
 * of a row, so they are partial unique indexes in `202608110017` rather than schema refinements. At most one
 * ACTIVE agent per name, one PUBLISHED version per prompt, one active governance policy — and one memory entry
 * per sequence within an execution. Every one of those is derived by counting or filtering prior rows, which
 * is a read-then-write two concurrent callers both satisfy, and no per-row check can see the other
 * transaction.
 */

export const capabilityConforms: SchemaMatchesType<z.infer<typeof capabilitySchema>, Capability> = true;

export const registeredAgentConforms: SchemaMatchesType<
  z.infer<typeof registeredAgentSchema>,
  RegisteredAgent
> = true;

export const promptVersionConforms: SchemaMatchesType<
  z.infer<typeof promptVersionSchema>,
  PromptVersion
> = true;

export const executionContextSnapshotConforms: SchemaMatchesType<
  z.infer<typeof executionContextSnapshotSchema>,
  ExecutionContextSnapshot
> = true;

/**
 * The one aggregate whose proof needs a note, and the note is about `content`.
 *
 * `z.unknown()` infers an **optional** key: Zod derives key optionality from whether the output type admits
 * `undefined`, and `unknown` does. `MemoryEntry.content` is a required key of type `unknown`. `Identical`
 * distinguishes the two, and for an ordinary field that distinction is exactly the one it exists to catch —
 * `{ a?: string }` omits a column where `{ a: string | undefined }` writes a null.
 *
 * Here it is not a real difference: `unknown` admits `undefined` on both sides, so the two describe the same
 * set of values. Rather than loosen `MemoryEntry` — a published type other packages import, which
 * `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` makes canonical — or widen the schema, the exception is
 * localised to the single field, so every other field of the aggregate is still proved exactly. The column is
 * `jsonb NOT NULL` and the repository writes JSON `null` for an absent content, which is the durable form of
 * "the same set of values".
 */
type WithRequiredContent<T> = Omit<T, 'content'> & { content: unknown };

export const memoryEntryConforms: SchemaMatchesType<
  WithRequiredContent<z.infer<typeof memoryEntrySchema>>,
  WithRequiredContent<MemoryEntry>
> = true;

export const approvalRequestConforms: SchemaMatchesType<
  z.infer<typeof agentApprovalRequestSchema>,
  ApprovalRequest
> = true;

export const telemetryRecordConforms: SchemaMatchesType<
  z.infer<typeof telemetryRecordSchema>,
  TelemetryRecord
> = true;

export const governancePolicyConforms: SchemaMatchesType<
  z.infer<typeof governancePolicySchema>,
  GovernancePolicy
> = true;

export const agentExecutionConforms: SchemaMatchesType<
  z.infer<typeof agentExecutionSchema>,
  AgentExecution
> = true;

const stamp = '2026-08-18T09:00:00.000Z';
const later = '2026-08-18T11:00:00.000Z';
const digest = 'a'.repeat(64);

const capability = (o: Record<string, unknown> = {}) => ({
  id: 'cap-1',
  workspaceId: 'ws-1',
  name: 'Propose a milestone certification',
  owner: 'team-assurance',
  permission: 'completion-certificates:create',
  mode: 'PROPOSE' as const,
  deterministicContract: 'certification.propose.v1',
  aiAllowed: true,
  humanApprovalRequired: true,
  protectedState: true,
  active: true,
  createdAt: stamp,
  ...o,
});

const approval = (o: Record<string, unknown> = {}) => ({
  id: 'ar-1',
  workspaceId: 'ws-1',
  executionId: 'ex-1',
  requestedByAgentId: 'agent-atlas',
  action: 'CERTIFICATION' as const,
  proposalHash: digest,
  status: 'PENDING' as const,
  createdAt: stamp,
  ...o,
});

const execution = (o: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  workspaceId: 'ws-1',
  agentId: 'agent-atlas',
  capabilityId: 'cap-1',
  promptVersionId: 'pv-1',
  contextSnapshotId: 'cs-1',
  status: 'QUEUED' as const,
  attempts: 0,
  createdAt: stamp,
  ...o,
});

describe('Batch M persisted contracts', () => {
  it('accepts what the engines write', () => {
    expect(capabilitySchema.safeParse(capability()).success).toBe(true);
    expect(agentApprovalRequestSchema.safeParse(approval()).success).toBe(true);
    expect(agentExecutionSchema.safeParse(execution()).success).toBe(true);
    expect(
      registeredAgentSchema.safeParse({
        id: 'ag-1',
        workspaceId: 'ws-1',
        name: 'Atlas',
        version: 1,
        owner: 'team-assurance',
        promptIds: ['p-1'],
        allowedCapabilityIds: ['cap-1'],
        active: true,
        createdAt: stamp,
      }).success,
    ).toBe(true);
    expect(
      promptVersionSchema.safeParse({
        id: 'pv-1',
        workspaceId: 'ws-1',
        promptId: 'p-1',
        version: 1,
        template: 'Assess {{milestoneId}} against its definition of done.',
        requiredVariables: ['milestoneId'],
        outputContract: 'certification.assessment.v1',
        status: 'PUBLISHED',
        checksum: digest,
        createdAt: stamp,
      }).success,
    ).toBe(true);
    expect(
      executionContextSnapshotSchema.safeParse({
        id: 'cs-1',
        workspaceId: 'ws-1',
        milestoneIds: ['gm-1'],
        definitionOfDoneIds: ['dv-1'],
        historyRefs: [],
        tenantId: 'tenant-1',
        userId: 'user-1',
        permissions: ['completion-certificates:create'],
        checksum: digest,
        createdAt: stamp,
      }).success,
    ).toBe(true);
    expect(
      memoryEntrySchema.safeParse({
        id: 'mem-1',
        workspaceId: 'ws-1',
        executionId: 'ex-1',
        agentId: 'agent-atlas',
        sequence: 1,
        kind: 'USER',
        content: { milestoneId: 'gm-1' },
        contentHash: digest,
        createdAt: stamp,
      }).success,
    ).toBe(true);
    expect(
      telemetryRecordSchema.safeParse({
        id: 'tel-1',
        workspaceId: 'ws-1',
        executionId: 'ex-1',
        agentId: 'agent-atlas',
        latencyMs: 820,
        costMinor: 1_400,
        inputTokens: 900,
        outputTokens: 240,
        errors: 0,
        hallucinationFlag: false,
        approvalRequested: true,
        createdAt: stamp,
      }).success,
    ).toBe(true);
    expect(
      governancePolicySchema.safeParse({
        id: 'gp-1',
        workspaceId: 'ws-1',
        version: 1,
        allowedRoles: ['ASSURANCE_LEAD'],
        allowedPromptIds: ['p-1'],
        allowedCapabilityIds: ['cap-1'],
        allowedModels: ['deterministic-1'],
        requireApprovalFor: ['CERTIFICATION'],
        active: true,
        createdAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('refuses a capability that would let an agent execute a protected-state change', () => {
    // `AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES`, and the single most important rule in the batch.
    // `execute()` invokes the deterministic gateway when the mode is EXECUTE_DETERMINISTIC, so this row is
    // the only thing between an agent and a direct change to protected state.
    expect(
      capabilitySchema.safeParse(capability({ mode: 'EXECUTE_DETERMINISTIC' })).success,
    ).toBe(false);
    expect(capabilitySchema.safeParse(capability({ mode: 'READ' })).success).toBe(false);
    // Unprotected state may execute deterministically — the rule is about what it touches, not the mode.
    expect(
      capabilitySchema.safeParse(
        capability({ protectedState: false, mode: 'EXECUTE_DETERMINISTIC' }),
      ).success,
    ).toBe(true);
  });

  it('refuses an agent approving its own request', () => {
    // `AGENT_CANNOT_SELF_APPROVE`. The fixture's action is CERTIFICATION on purpose: an agent that approved
    // its own request could manufacture certified work, and CLAUDE.md's second hard constraint is that every
    // release is certified-work-backed.
    expect(
      agentApprovalRequestSchema.safeParse(
        approval({ status: 'APPROVED', decidedBy: 'agent-atlas', decidedAt: later }),
      ).success,
    ).toBe(false);
    // A different principal deciding is exactly what the aggregate is for.
    expect(
      agentApprovalRequestSchema.safeParse(
        approval({ status: 'APPROVED', decidedBy: 'user-reviewer', decidedAt: later }),
      ).success,
    ).toBe(true);
  });

  it('keeps an approval’s decision and consumption coherent', () => {
    expect(agentApprovalRequestSchema.safeParse(approval({ status: 'APPROVED' })).success).toBe(false);
    expect(
      agentApprovalRequestSchema.safeParse(approval({ decidedBy: 'user-reviewer' })).success,
    ).toBe(false);
    // Only an approved request is consumable — a rejected one carrying a consumption time would read as
    // having authorised something.
    expect(
      agentApprovalRequestSchema.safeParse(
        approval({ status: 'REJECTED', decidedBy: 'user-reviewer', decidedAt: later, consumedAt: later }),
      ).success,
    ).toBe(false);
    expect(
      agentApprovalRequestSchema.safeParse(
        approval({ status: 'APPROVED', decidedBy: 'user-reviewer', decidedAt: later, consumedAt: later }),
      ).success,
    ).toBe(true);
    // And time runs forwards.
    expect(
      agentApprovalRequestSchema.safeParse(
        approval({ status: 'APPROVED', decidedBy: 'user-reviewer', createdAt: later, decidedAt: stamp }),
      ).success,
    ).toBe(false);
  });

  it('keeps an execution’s status and timestamps coherent', () => {
    expect(agentExecutionSchema.safeParse(execution({ startedAt: stamp })).success).toBe(false);
    expect(agentExecutionSchema.safeParse(execution({ status: 'RUNNING' })).success).toBe(false);
    expect(
      agentExecutionSchema.safeParse(execution({ status: 'RUNNING', startedAt: stamp })).success,
    ).toBe(true);
    // A failure says why. An execution that failed with no error is one nobody can diagnose.
    expect(
      agentExecutionSchema.safeParse(
        execution({ status: 'FAILED', startedAt: stamp, completedAt: later }),
      ).success,
    ).toBe(false);
    expect(
      agentExecutionSchema.safeParse(
        execution({ status: 'FAILED', startedAt: stamp, completedAt: later, error: 'provider timeout' }),
      ).success,
    ).toBe(true);
    // A finished run records when, and a live one does not.
    expect(
      agentExecutionSchema.safeParse(
        execution({ status: 'SUCCEEDED', startedAt: stamp, proposal: { ok: true } }),
      ).success,
    ).toBe(false);
    expect(
      agentExecutionSchema.safeParse(
        execution({ status: 'RUNNING', startedAt: stamp, completedAt: later }),
      ).success,
    ).toBe(false);
    expect(
      agentExecutionSchema.safeParse(
        execution({ status: 'SUCCEEDED', startedAt: later, completedAt: stamp, proposal: {} }),
      ).success,
    ).toBe(false);
  });

  it('holds model spend to integer minor units', () => {
    // Model spend is money, so CLAUDE.md's fourth constraint applies to it like any other amount.
    const telemetry = {
      id: 'tel-1',
      workspaceId: 'ws-1',
      executionId: 'ex-1',
      agentId: 'agent-atlas',
      latencyMs: 820,
      costMinor: 1_400,
      inputTokens: 900,
      outputTokens: 240,
      errors: 0,
      hallucinationFlag: false,
      approvalRequested: true,
      createdAt: stamp,
    };
    expect(telemetryRecordSchema.safeParse({ ...telemetry, costMinor: 1_400.5 }).success).toBe(false);
    expect(telemetryRecordSchema.safeParse({ ...telemetry, costMinor: -1 }).success).toBe(false);
    expect(telemetryRecordSchema.safeParse({ ...telemetry, latencyMs: -1 }).success).toBe(false);
    expect(telemetryRecordSchema.safeParse({ ...telemetry, qualityScore: 101 }).success).toBe(false);
  });

  it('numbers a memory entry from one, as the engine does', () => {
    // `append` computes `prior.length + 1`, so there is no entry zero. A schema admitting one would be looser
    // than the `agent_memory_sequence_ck` column it describes, and the unique key on
    // `(tenant, workspace, execution, sequence)` is what actually orders an agent's reasoning.
    const entry = {
      id: 'mem-1',
      workspaceId: 'ws-1',
      executionId: 'ex-1',
      agentId: 'agent-atlas',
      sequence: 1,
      kind: 'USER' as const,
      content: {},
      contentHash: digest,
      createdAt: stamp,
    };
    expect(memoryEntrySchema.safeParse(entry).success).toBe(true);
    expect(memoryEntrySchema.safeParse({ ...entry, sequence: 0 }).success).toBe(false);
    expect(memoryEntrySchema.safeParse({ ...entry, sequence: 1.5 }).success).toBe(false);
  });

  it('requires an approval’s proposal hash to be a recomputable digest', () => {
    // The engine accepted any string until this batch. `consume()` authorises a protected action — possibly a
    // `CERTIFICATION` — only when this value matches the proposal being executed, and a value nobody can
    // recompute from the proposal makes that match an agreement between two opaque strings.
    expect(agentApprovalRequestSchema.safeParse(approval({ proposalHash: 'abc' })).success).toBe(false);
    expect(
      agentApprovalRequestSchema.safeParse(approval({ proposalHash: digest.toUpperCase() })).success,
    ).toBe(false);
    expect(agentApprovalRequestSchema.safeParse(approval({ proposalHash: digest })).success).toBe(true);
  });

  it('refuses a capability or prompt with nothing behind it', () => {
    expect(capabilitySchema.safeParse(capability({ permission: '  ' })).success).toBe(false);
    expect(capabilitySchema.safeParse(capability({ deterministicContract: '' })).success).toBe(false);
    expect(capabilitySchema.safeParse(capability({ owner: '' })).success).toBe(false);
  });

  it('refuses an unknown field on every aggregate', () => {
    for (const [schema, value] of [
      [capabilitySchema, capability()],
      [agentApprovalRequestSchema, approval()],
      [agentExecutionSchema, execution()],
    ] as const) {
      expect(schema.safeParse({ ...value, surprise: true }).success).toBe(false);
    }
  });
});

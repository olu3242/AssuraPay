import {
  BATCH_M_AGGREGATES,
  BATCH_M_SCHEMA_VERSION,
  batchMContract,
  describeSchemaFailure,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

/**
 * Relational repositories for Batch M — the nine agent-runtime aggregates of canonical Engines 61-70, and the
 * last batch in the durability register.
 *
 * ## What this replaces
 *
 * An untyped envelope, and this is the one batch where the answer is not "nothing". These collections were
 * absent from the store's routing table, so `PostgresTrustStore` refused every one of them — but
 * `202608030012` had created `agent_runtime.records`, a single table in a schema of its own holding all nine
 * aggregates behind a `record_type` discriminator and a `payload` column. Nothing read it and nothing wrote
 * it; being outside `current_schema()`, no gate in the repository could see it either. `202608110017` creates
 * the nine typed tables and retires it.
 *
 * The envelope is worth one more sentence here, because it explains what these repositories are for. It could
 * hold no invariant of any of the nine — a `payload` column has no `mode`, no `protected_state`, no
 * `decided_by` — so a capability record could be edited into `EXECUTE_DETERMINISTIC` with `protectedState`
 * true, which is the shape `CapabilityRegistryEngine.register` exists to refuse and the only thing standing
 * between an agent proposing a protected-state change and performing one. Typed columns are what make that
 * refusable.
 *
 * ## Six governed, three append-only
 *
 * Each `update` writes only what its engine moves, and for four of the six that is a single column:
 *
 *   * a capability's `active` — the whole of `deactivate()`, and the only thing about a capability that may
 *     ever change;
 *   * a registered agent's `active` and a governance policy's `active` — activation and supersession;
 *   * a prompt version's `status` — DRAFT to PUBLISHED, PUBLISHED to RETIRED, and RETIRED back to PUBLISHED,
 *     which is `rollback`;
 *   * an approval's decision and consumption — four columns, written once each;
 *   * an execution's status, attempt count, proposal, error and two timestamps, which is Engine 61's whole
 *     lifecycle and the transition the retired envelope refused outright.
 *
 * The three that do not transition are records of what happened: the governed references an execution was
 * given, a memory entry, a telemetry measurement.
 *
 * ## Reading these rows
 *
 * Three column families need care.
 *
 * `BIGINT` and `NUMERIC` arrive from the driver as **strings**, deliberately on its part — converting either
 * to a float would lose precision silently. `cost_minor` is integer minor units per CLAUDE.md's fourth
 * constraint and `quality_score` is a percentage, so both are parsed here.
 *
 * `jsonb` array columns arrive already parsed, and are read back as arrays rather than passed through: the
 * schema is what decides whether the contents are what they claim to be.
 *
 * And `agent_memory.content` is `jsonb NOT NULL`, which stores the JSON value `null` for an entry whose
 * content was absent. The engine's `content` is `unknown`, so `undefined` is representable in TypeScript and
 * not in a NOT NULL column; the insert maps it to JSON `null` and says so, because a nullable column could not
 * distinguish the two either and silently choosing per row would be worse than choosing once.
 *
 * One statement per table, written out rather than generated: `persistence/unsafe-sql` confines the driver's
 * escape hatch to DDL.
 */

type Row = Record<string, unknown>;

export type BatchMRelation = {
  readonly collection: string;
  readonly table: string;
  /**
   * True when no canonical engine transitions this aggregate. The `<table>_append_only` trigger and the
   * withheld UPDATE privilege are the authority; this flag only makes the refusal legible.
   */
  readonly appendOnly: boolean;
  list(sql: SqlClient): Promise<Row[]>;
  insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
  /** Rows affected. Zero means the record does not exist, or lies outside the caller's scope. */
  update(sql: SqlClient, record: Row): Promise<number>;
};

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

function contractFor(collection: string) {
  const contract = batchMContract(collection);
  if (!contract)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch M aggregate`,
    );
  return contract;
}

/**
 * The aggregate's canonical schema, applied before the statement rather than after it.
 *
 * For this batch it is also what refuses a fractional `costMinor`. `cost_minor` is `BIGINT`, and an integer
 * column *rounds* a fractional value rather than refusing it — the cast happens before any CHECK can see it —
 * so `minorUnits` here is the only thing between a caller and 100.5 kobo silently becoming 101.
 */
function validateForWrite(collection: string, value: unknown): Row {
  const result = contractFor(collection).schema.safeParse(value);
  if (!result.success)
    throw new PostgresStoreError(
      'PERSISTENCE_SCHEMA_VIOLATION',
      `${collection}: ${describeSchemaFailure(result.error)}`,
    );
  return result.data as Row;
}

/**
 * The same schema, applied on the way out.
 *
 * A failure here is a data-integrity incident rather than a caller error. For this batch the sharpest case is
 * a capability row claiming `EXECUTE_DETERMINISTIC` with `protectedState` true: `execute()` invokes the
 * deterministic gateway on that mode, so such a row is an agent performing a protected-state change rather
 * than proposing one. The database refuses to hold it, and this refuses to hand it to an engine.
 */
function validateFromRow(collection: string, value: unknown): Row {
  const result = contractFor(collection).schema.safeParse(value);
  if (!result.success)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: ${describeSchemaFailure(result.error)}`,
    );
  return result.data as Row;
}

function requireSupportedSchemaVersion(collection: string, row: Row): void {
  const declared = row.schema_version;
  const version = typeof declared === 'number' ? declared : Number(declared);
  if (!Number.isInteger(version) || version < 1)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      `${collection}: schema_version is not a positive integer`,
    );
  if (version > BATCH_M_SCHEMA_VERSION)
    throw new PostgresStoreError(
      'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION',
      `${collection}: row declares schema version ${version}; this build understands up to ${BATCH_M_SCHEMA_VERSION}`,
    );
}

// ---------------------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------------------

function corrupt(collection: string, column: string, why: string): never {
  // Column and reason only, never the value: these rows carry prompt templates, an agent's reasoning steps,
  // model spend and the proposals a human approved.
  throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', `${collection}.${column} ${why}`);
}

function text(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') corrupt(collection, column, 'is not a string');
  return value as string;
}

function optionalText(collection: string, row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return text(collection, row, column);
}

function instant(collection: string, row: Row, column: string): string {
  const value = row[column];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return corrupt(collection, column, 'is not a timestamp');
}

function optionalInstant(collection: string, row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return instant(collection, row, column);
}

/**
 * A `NUMERIC` or `BIGINT` column.
 *
 * Both arrive as strings from the driver, which is deliberate on its part: converting either to a float in the
 * driver would lose precision silently.
 */
function numeric(collection: string, row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' && typeof value !== 'string')
    corrupt(collection, column, 'is not numeric');
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) corrupt(collection, column, 'is not a finite number');
  return parsed;
}

/** An integer column — a count, a revision, or an amount in minor units. */
function integer(collection: string, row: Row, column: string): number {
  const parsed = numeric(collection, row, column);
  if (!Number.isInteger(parsed)) corrupt(collection, column, 'is not an integer');
  return parsed;
}

function optionalNumeric(collection: string, row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return numeric(collection, row, column);
}

function boolean(collection: string, row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') corrupt(collection, column, 'is not a boolean');
  return value as boolean;
}

/**
 * A `jsonb` array column, as a string array.
 *
 * Read rather than passed through, because these lists are what bound an agent: a registered agent's
 * `allowedCapabilityIds`, a policy's `allowedModels`, a snapshot's `permissions`. A non-array here would reach
 * `.includes(...)` in an engine and answer `false` to every question rather than failing.
 */
function textArray(collection: string, row: Row, column: string): string[] {
  const value = row[column];
  if (!Array.isArray(value)) corrupt(collection, column, 'is not an array');
  for (const entry of value as unknown[])
    if (typeof entry !== 'string') corrupt(collection, column, 'holds a non-string element');
  return value as string[];
}

/** A `jsonb` column of arbitrary shape, already parsed by the driver. Its shape is the schema's business. */
function json(row: Row, column: string): unknown {
  return row[column];
}

function compact(record: Row): Row {
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
}

function requireId(collection: string, record: Row): string {
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0)
    throw new PostgresStoreError('PERSISTENCE_RECORD_ID_REQUIRED', `${collection} record has no id`);
  return id;
}

function relation(
  collection: string,
  table: string,
  operations: {
    list(sql: SqlClient): Promise<Row[]>;
    insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
    update?(sql: SqlClient, record: Row): Promise<number>;
  },
): BatchMRelation {
  return {
    collection,
    table,
    appendOnly: operations.update === undefined,
    list: operations.list,
    insert: operations.insert,
    update:
      operations.update ??
      (async () => {
        throw new PostgresStoreError(
          'PERSISTENCE_HISTORY_IMMUTABLE',
          `${collection} is append-only; no canonical engine transitions it and the ${table}_append_only trigger refuses the statement`,
        );
      }),
  };
}

// ---------------------------------------------------------------------------------------
// Engine 62 — Capability registry
// ---------------------------------------------------------------------------------------

const agentCapabilities = relation('agentCapabilities', 'agent_capabilities', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, name, owner, permission, mode, deterministic_contract, ai_allowed,
             human_approval_required, protected_state, active, created_at, schema_version
      FROM agent_capabilities ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentCapabilities', row);
      return validateFromRow('agentCapabilities', {
        id: text('agentCapabilities', row, 'id'),
        workspaceId: text('agentCapabilities', row, 'workspace_id'),
        name: text('agentCapabilities', row, 'name'),
        owner: text('agentCapabilities', row, 'owner'),
        permission: text('agentCapabilities', row, 'permission'),
        mode: text('agentCapabilities', row, 'mode'),
        deterministicContract: text('agentCapabilities', row, 'deterministic_contract'),
        aiAllowed: boolean('agentCapabilities', row, 'ai_allowed'),
        humanApprovalRequired: boolean('agentCapabilities', row, 'human_approval_required'),
        protectedState: boolean('agentCapabilities', row, 'protected_state'),
        active: boolean('agentCapabilities', row, 'active'),
        createdAt: instant('agentCapabilities', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentCapabilities', value);
    await sql`
      INSERT INTO agent_capabilities
        (id, tenant_id, workspace_id, name, owner, permission, mode, deterministic_contract, ai_allowed,
         human_approval_required, protected_state, active, created_at, row_version, schema_version,
         updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.name as string}, ${record.owner as string}, ${record.permission as string},
        ${record.mode as string}, ${record.deterministicContract as string},
        ${record.aiAllowed as boolean}, ${record.humanApprovalRequired as boolean},
        ${record.protectedState as boolean}, ${record.active as boolean},
        ${record.createdAt as string}, 1, ${BATCH_M_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `active`, and nothing else — the whole of `deactivate()`.
  //
  // The narrowest update in the programme, and deliberately so. `mode` and `protected_state` are what stop an
  // agent executing a protected-state change, `deactivate` is a `replace`, and the retired envelope let
  // exactly this statement rewrite them. Writing only `active` means the repository cannot carry such an edit
  // even if a caller handed it one; `agent_capabilities_governed_transition` refuses it besides.
  async update(sql, value) {
    const record = validateForWrite('agentCapabilities', value);
    const rows = await sql<Row[]>`
      UPDATE agent_capabilities
      SET active = ${record.active as boolean},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('agentCapabilities', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 63 — Agent registry
// ---------------------------------------------------------------------------------------

const registeredAgents = relation('registeredAgents', 'registered_agents', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, name, version, owner, prompt_ids, allowed_capability_ids, active,
             created_at, schema_version
      FROM registered_agents ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('registeredAgents', row);
      return validateFromRow('registeredAgents', {
        id: text('registeredAgents', row, 'id'),
        workspaceId: text('registeredAgents', row, 'workspace_id'),
        name: text('registeredAgents', row, 'name'),
        version: integer('registeredAgents', row, 'version'),
        owner: text('registeredAgents', row, 'owner'),
        promptIds: textArray('registeredAgents', row, 'prompt_ids'),
        allowedCapabilityIds: textArray('registeredAgents', row, 'allowed_capability_ids'),
        active: boolean('registeredAgents', row, 'active'),
        createdAt: instant('registeredAgents', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('registeredAgents', value);
    await sql`
      INSERT INTO registered_agents
        (id, tenant_id, workspace_id, name, version, owner, prompt_ids, allowed_capability_ids, active,
         created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.name as string}, ${record.version as number}, ${record.owner as string},
        ${sql.json(record.promptIds as never)}, ${sql.json(record.allowedCapabilityIds as never)},
        ${record.active as boolean}, ${record.createdAt as string}, 1, ${BATCH_M_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  // `active`, and nothing else. `activate` names a version, so the incumbent is deactivated and the named
  // version activated — two statements, each writing this one column. The allow-lists never move: `execute()`
  // checks `allowedCapabilityIds` on every run, so a mutable one would silently widen what an
  // already-approved agent may do.
  async update(sql, value) {
    const record = validateForWrite('registeredAgents', value);
    const rows = await sql<Row[]>`
      UPDATE registered_agents
      SET active = ${record.active as boolean},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('registeredAgents', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 64 — Prompt registry
// ---------------------------------------------------------------------------------------

const promptVersions = relation('promptVersions', 'prompt_versions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, prompt_id, version, template, required_variables, output_contract, status,
             checksum, created_at, schema_version
      FROM prompt_versions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('promptVersions', row);
      return validateFromRow('promptVersions', {
        id: text('promptVersions', row, 'id'),
        workspaceId: text('promptVersions', row, 'workspace_id'),
        promptId: text('promptVersions', row, 'prompt_id'),
        version: integer('promptVersions', row, 'version'),
        template: text('promptVersions', row, 'template'),
        requiredVariables: textArray('promptVersions', row, 'required_variables'),
        outputContract: text('promptVersions', row, 'output_contract'),
        status: text('promptVersions', row, 'status'),
        checksum: text('promptVersions', row, 'checksum'),
        createdAt: instant('promptVersions', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('promptVersions', value);
    await sql`
      INSERT INTO prompt_versions
        (id, tenant_id, workspace_id, prompt_id, version, template, required_variables, output_contract,
         status, checksum, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.promptId as string}, ${record.version as number}, ${record.template as string},
        ${sql.json(record.requiredVariables as never)}, ${record.outputContract as string},
        ${record.status as string}, ${record.checksum as string}, ${record.createdAt as string}, 1,
        ${BATCH_M_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // `status`, and nothing else. `publish` retires the incumbent and publishes the target; `rollback` publishes
  // a retired version again, which is why the status is not treated as terminal. The template and its checksum
  // are immutable, so what ran can always be recomputed from what was published.
  async update(sql, value) {
    const record = validateForWrite('promptVersions', value);
    const rows = await sql<Row[]>`
      UPDATE prompt_versions
      SET status = ${record.status as string},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('promptVersions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 66 — Execution context
// ---------------------------------------------------------------------------------------

/**
 * No `update`. A snapshot is the governed references an agent was given at a moment, and Engine 66 has no
 * method that changes one.
 *
 * `tenantId` is read from the routing column rather than a second column of its own. The domain type carries a
 * tenant — the only aggregate in the batch that does — and two columns could disagree, which would mean a
 * snapshot claiming it was taken for a tenant other than the one it is stored under. The insert refuses a
 * record whose `tenantId` is not the caller's scope, which is the only way the two can now differ.
 */
const agentContextSnapshots = relation('agentContextSnapshots', 'agent_context_snapshots', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, tenant_id, workspace_id, agreement_id, blueprint_id, milestone_ids,
             definition_of_done_ids, history_refs, user_id, permissions, checksum, created_at,
             schema_version
      FROM agent_context_snapshots ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentContextSnapshots', row);
      return validateFromRow(
        'agentContextSnapshots',
        compact({
          id: text('agentContextSnapshots', row, 'id'),
          workspaceId: text('agentContextSnapshots', row, 'workspace_id'),
          agreementId: optionalText('agentContextSnapshots', row, 'agreement_id'),
          blueprintId: optionalText('agentContextSnapshots', row, 'blueprint_id'),
          milestoneIds: textArray('agentContextSnapshots', row, 'milestone_ids'),
          definitionOfDoneIds: textArray('agentContextSnapshots', row, 'definition_of_done_ids'),
          historyRefs: textArray('agentContextSnapshots', row, 'history_refs'),
          tenantId: text('agentContextSnapshots', row, 'tenant_id'),
          userId: text('agentContextSnapshots', row, 'user_id'),
          permissions: textArray('agentContextSnapshots', row, 'permissions'),
          checksum: text('agentContextSnapshots', row, 'checksum'),
          createdAt: instant('agentContextSnapshots', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentContextSnapshots', value);
    // The one place the two meanings of `tenant_id` could part company. A snapshot is the record of what an
    // agent was entitled to see, so one claiming a different tenant than the scope it is written under is a
    // scope error rather than a schema one.
    if (record.tenantId !== tenantId)
      throw new PostgresStoreError(
        'PERSISTENCE_SCOPE_INVALID',
        'agentContextSnapshots: the snapshot names a different tenant than the active scope',
      );
    await sql`
      INSERT INTO agent_context_snapshots
        (id, tenant_id, workspace_id, agreement_id, blueprint_id, milestone_ids, definition_of_done_ids,
         history_refs, user_id, permissions, checksum, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${(record.agreementId as string | undefined) ?? null},
        ${(record.blueprintId as string | undefined) ?? null},
        ${sql.json(record.milestoneIds as never)}, ${sql.json(record.definitionOfDoneIds as never)},
        ${sql.json(record.historyRefs as never)}, ${record.userId as string},
        ${sql.json(record.permissions as never)}, ${record.checksum as string},
        ${record.createdAt as string}, 1, ${BATCH_M_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 67 — Execution memory
// ---------------------------------------------------------------------------------------

// No `update`. Engine 67 is "append-only, explicit, inspectable memory": editing an entry would rewrite an
// agent's reasoning after the fact, which is the one thing an inspectable record cannot allow.
const agentMemory = relation('agentMemory', 'agent_memory', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, agent_id, sequence, kind, content, content_hash, created_at,
             schema_version
      FROM agent_memory ORDER BY execution_id ASC, sequence ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentMemory', row);
      return validateFromRow('agentMemory', {
        id: text('agentMemory', row, 'id'),
        workspaceId: text('agentMemory', row, 'workspace_id'),
        executionId: text('agentMemory', row, 'execution_id'),
        agentId: text('agentMemory', row, 'agent_id'),
        sequence: integer('agentMemory', row, 'sequence'),
        kind: text('agentMemory', row, 'kind'),
        content: json(row, 'content'),
        contentHash: text('agentMemory', row, 'content_hash'),
        createdAt: instant('agentMemory', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentMemory', value);
    // `content ?? null` rather than passing the value through: the column is NOT NULL, and an entry whose
    // content was absent is stored as the JSON value `null`. `sql.json(undefined)` binds SQL NULL, which the
    // column refuses — turning a legal entry into a failed write.
    await sql`
      INSERT INTO agent_memory
        (id, tenant_id, workspace_id, execution_id, agent_id, sequence, kind, content, content_hash,
         created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${record.agentId as string}, ${record.sequence as number},
        ${record.kind as string},
        ${sql.json((record.content ?? null) as never)},
        ${record.contentHash as string}, ${record.createdAt as string}, 1, ${BATCH_M_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 68 — Human approval
// ---------------------------------------------------------------------------------------

const agentApprovalRequests = relation('agentApprovalRequests', 'agent_approval_requests', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, requested_by_agent_id, action, proposal_hash, status,
             decided_by, decided_at, consumed_at, created_at, schema_version
      FROM agent_approval_requests ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentApprovalRequests', row);
      return validateFromRow(
        'agentApprovalRequests',
        compact({
          id: text('agentApprovalRequests', row, 'id'),
          workspaceId: text('agentApprovalRequests', row, 'workspace_id'),
          executionId: text('agentApprovalRequests', row, 'execution_id'),
          requestedByAgentId: text('agentApprovalRequests', row, 'requested_by_agent_id'),
          action: text('agentApprovalRequests', row, 'action'),
          proposalHash: text('agentApprovalRequests', row, 'proposal_hash'),
          status: text('agentApprovalRequests', row, 'status'),
          decidedBy: optionalText('agentApprovalRequests', row, 'decided_by'),
          decidedAt: optionalInstant('agentApprovalRequests', row, 'decided_at'),
          consumedAt: optionalInstant('agentApprovalRequests', row, 'consumed_at'),
          createdAt: instant('agentApprovalRequests', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentApprovalRequests', value);
    await sql`
      INSERT INTO agent_approval_requests
        (id, tenant_id, workspace_id, execution_id, requested_by_agent_id, action, proposal_hash, status,
         decided_by, decided_at, consumed_at, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${record.requestedByAgentId as string},
        ${record.action as string}, ${record.proposalHash as string}, ${record.status as string},
        ${(record.decidedBy as string | undefined) ?? null},
        ${(record.decidedAt as string | undefined) ?? null},
        ${(record.consumedAt as string | undefined) ?? null}, ${record.createdAt as string}, 1,
        ${BATCH_M_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // The decision and the consumption, which are the whole of `decide()` and `consume()`. What the approval is
  // *for* — the execution, the requesting agent, the action and the proposal digest — is immutable, and that
  // is what makes a consumed approval evidence that this proposal was authorised rather than another one.
  //
  // `agent_approval_requests_finality` refuses a second decision and a second consumption, so this statement
  // cannot revise either even though it names all four columns.
  async update(sql, value) {
    const record = validateForWrite('agentApprovalRequests', value);
    const rows = await sql<Row[]>`
      UPDATE agent_approval_requests
      SET status = ${record.status as string},
          decided_by = ${(record.decidedBy as string | undefined) ?? null},
          decided_at = ${(record.decidedAt as string | undefined) ?? null},
          consumed_at = ${(record.consumedAt as string | undefined) ?? null},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('agentApprovalRequests', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 69 — Telemetry
// ---------------------------------------------------------------------------------------

// No `update`. A measurement of what a model did, at a moment; `summarize` reads the series.
const agentTelemetry = relation('agentTelemetry', 'agent_telemetry', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, execution_id, agent_id, provider, latency_ms, cost_minor, input_tokens,
             output_tokens, errors, quality_score, hallucination_flag, approval_requested, created_at,
             schema_version
      FROM agent_telemetry ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentTelemetry', row);
      return validateFromRow(
        'agentTelemetry',
        compact({
          id: text('agentTelemetry', row, 'id'),
          workspaceId: text('agentTelemetry', row, 'workspace_id'),
          executionId: text('agentTelemetry', row, 'execution_id'),
          agentId: text('agentTelemetry', row, 'agent_id'),
          provider: optionalText('agentTelemetry', row, 'provider'),
          latencyMs: integer('agentTelemetry', row, 'latency_ms'),
          // BIGINT, arriving as a string. Integer minor units per CLAUDE.md's fourth constraint.
          costMinor: integer('agentTelemetry', row, 'cost_minor'),
          inputTokens: integer('agentTelemetry', row, 'input_tokens'),
          outputTokens: integer('agentTelemetry', row, 'output_tokens'),
          errors: integer('agentTelemetry', row, 'errors'),
          // NUMERIC, also a string, and a percentage rather than an integer.
          qualityScore: optionalNumeric('agentTelemetry', row, 'quality_score'),
          hallucinationFlag: boolean('agentTelemetry', row, 'hallucination_flag'),
          approvalRequested: boolean('agentTelemetry', row, 'approval_requested'),
          createdAt: instant('agentTelemetry', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentTelemetry', value);
    await sql`
      INSERT INTO agent_telemetry
        (id, tenant_id, workspace_id, execution_id, agent_id, provider, latency_ms, cost_minor,
         input_tokens, output_tokens, errors, quality_score, hallucination_flag, approval_requested,
         created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.executionId as string}, ${record.agentId as string},
        ${(record.provider as string | undefined) ?? null}, ${record.latencyMs as number},
        ${record.costMinor as number}, ${record.inputTokens as number},
        ${record.outputTokens as number}, ${record.errors as number},
        ${(record.qualityScore as number | undefined) ?? null},
        ${record.hallucinationFlag as boolean}, ${record.approvalRequested as boolean},
        ${record.createdAt as string}, 1, ${BATCH_M_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 70 — Governance policy
// ---------------------------------------------------------------------------------------

const agentGovernancePolicies = relation('agentGovernancePolicies', 'agent_governance_policies', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, version, allowed_roles, allowed_prompt_ids, allowed_capability_ids,
             allowed_models, require_approval_for, active, created_at, schema_version
      FROM agent_governance_policies ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentGovernancePolicies', row);
      return validateFromRow('agentGovernancePolicies', {
        id: text('agentGovernancePolicies', row, 'id'),
        workspaceId: text('agentGovernancePolicies', row, 'workspace_id'),
        version: integer('agentGovernancePolicies', row, 'version'),
        allowedRoles: textArray('agentGovernancePolicies', row, 'allowed_roles'),
        allowedPromptIds: textArray('agentGovernancePolicies', row, 'allowed_prompt_ids'),
        allowedCapabilityIds: textArray('agentGovernancePolicies', row, 'allowed_capability_ids'),
        allowedModels: textArray('agentGovernancePolicies', row, 'allowed_models'),
        requireApprovalFor: textArray('agentGovernancePolicies', row, 'require_approval_for'),
        active: boolean('agentGovernancePolicies', row, 'active'),
        createdAt: instant('agentGovernancePolicies', row, 'created_at'),
      });
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentGovernancePolicies', value);
    await sql`
      INSERT INTO agent_governance_policies
        (id, tenant_id, workspace_id, version, allowed_roles, allowed_prompt_ids, allowed_capability_ids,
         allowed_models, require_approval_for, active, created_at, row_version, schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.version as number}, ${sql.json(record.allowedRoles as never)},
        ${sql.json(record.allowedPromptIds as never)},
        ${sql.json(record.allowedCapabilityIds as never)},
        ${sql.json(record.allowedModels as never)}, ${sql.json(record.requireApprovalFor as never)},
        ${record.active as boolean}, ${record.createdAt as string}, 1, ${BATCH_M_SCHEMA_VERSION},
        ${record.createdAt as string}
      )
    `;
  },
  // `active`, and nothing else — `publish` supersedes the incumbent before creating the next version. The four
  // allow-lists are what the policy *was*: `authorize()` reads every one of them on every execution, so an
  // editable `allowed_models` would change what an agent may use without any record that the policy changed.
  async update(sql, value) {
    const record = validateForWrite('agentGovernancePolicies', value);
    const rows = await sql<Row[]>`
      UPDATE agent_governance_policies
      SET active = ${record.active as boolean},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('agentGovernancePolicies', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

// ---------------------------------------------------------------------------------------
// Engine 61 — Agent runtime
// ---------------------------------------------------------------------------------------

const agentExecutions = relation('agentExecutions', 'agent_executions', {
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, agent_id, capability_id, prompt_version_id, context_snapshot_id, status,
             attempts, proposal, error, started_at, completed_at, created_at, schema_version
      FROM agent_executions ORDER BY created_at ASC, id ASC
    `;
    return rows.map((row) => {
      requireSupportedSchemaVersion('agentExecutions', row);
      return validateFromRow(
        'agentExecutions',
        compact({
          id: text('agentExecutions', row, 'id'),
          workspaceId: text('agentExecutions', row, 'workspace_id'),
          agentId: text('agentExecutions', row, 'agent_id'),
          capabilityId: text('agentExecutions', row, 'capability_id'),
          promptVersionId: text('agentExecutions', row, 'prompt_version_id'),
          contextSnapshotId: text('agentExecutions', row, 'context_snapshot_id'),
          status: text('agentExecutions', row, 'status'),
          attempts: integer('agentExecutions', row, 'attempts'),
          // SQL NULL means the run produced no proposal; the JSON value `null` means it produced one that is
          // null. `compact` drops the former, so the schema sees an absent field rather than an explicit null.
          proposal: row.proposal === null ? undefined : json(row, 'proposal'),
          error: optionalText('agentExecutions', row, 'error'),
          startedAt: optionalInstant('agentExecutions', row, 'started_at'),
          completedAt: optionalInstant('agentExecutions', row, 'completed_at'),
          createdAt: instant('agentExecutions', row, 'created_at'),
        }),
      );
    });
  },
  async insert(sql, value, tenantId) {
    const record = validateForWrite('agentExecutions', value);
    await sql`
      INSERT INTO agent_executions
        (id, tenant_id, workspace_id, agent_id, capability_id, prompt_version_id, context_snapshot_id,
         status, attempts, proposal, error, started_at, completed_at, created_at, row_version,
         schema_version, updated_at)
      VALUES (
        ${record.id as string}, ${tenantId}, ${record.workspaceId as string},
        ${record.agentId as string}, ${record.capabilityId as string},
        ${record.promptVersionId as string}, ${record.contextSnapshotId as string},
        ${record.status as string}, ${record.attempts as number},
        ${record.proposal === undefined ? null : sql.json(record.proposal as never)},
        ${(record.error as string | undefined) ?? null},
        ${(record.startedAt as string | undefined) ?? null},
        ${(record.completedAt as string | undefined) ?? null}, ${record.createdAt as string}, 1,
        ${BATCH_M_SCHEMA_VERSION}, ${record.createdAt as string}
      )
    `;
  },
  // Engine 61's whole lifecycle: QUEUED to RUNNING, then to SUCCEEDED, FAILED or CANCELLED, with the attempt
  // count, the proposal and the error the run produced.
  //
  // Every one of these statements was refused before `202608110017`. The retired envelope treated an execution
  // record as history, so `QUEUED → RUNNING` raised "agent runtime history is append-only" and no run could
  // ever be recorded as started, finished or cancelled on the durable store.
  //
  // What the run *was* — the agent, the capability, the prompt version and the context snapshot — is immutable,
  // so a completed run cannot be re-attributed to a different capability after the fact.
  async update(sql, value) {
    const record = validateForWrite('agentExecutions', value);
    const rows = await sql<Row[]>`
      UPDATE agent_executions
      SET status = ${record.status as string},
          attempts = ${record.attempts as number},
          proposal = ${record.proposal === undefined ? null : sql.json(record.proposal as never)},
          error = ${(record.error as string | undefined) ?? null},
          started_at = ${(record.startedAt as string | undefined) ?? null},
          completed_at = ${(record.completedAt as string | undefined) ?? null},
          row_version = row_version + 1,
          updated_at = now()
      WHERE id = ${requireId('agentExecutions', record)}
      RETURNING id
    `;
    return rows.length;
  },
});

export const BATCH_M_RELATIONS: Readonly<Record<string, BatchMRelation>> = Object.freeze(
  Object.fromEntries(
    [
      agentCapabilities,
      registeredAgents,
      promptVersions,
      agentContextSnapshots,
      agentMemory,
      agentApprovalRequests,
      agentTelemetry,
      agentGovernancePolicies,
      agentExecutions,
    ].map((entry) => [entry.collection, entry]),
  ),
);

export function isBatchMCollection(collection: string): boolean {
  return Object.hasOwn(BATCH_M_RELATIONS, collection);
}

/**
 * The relation for a collection.
 *
 * Refuses rather than returning undefined: a caller that reached here has already decided the collection is
 * Batch M's, and a silent undefined would become a lost write.
 */
export function batchMRelation(collection: string): BatchMRelation {
  const found = BATCH_M_RELATIONS[collection];
  if (!found)
    throw new PostgresStoreError(
      'PERSISTENCE_COLLECTION_NOT_MAPPED',
      `${collection} is not a Batch M aggregate`,
    );
  return found;
}

export const BATCH_M_RELATION_COUNT = Object.keys(BATCH_M_RELATIONS).length;

if (BATCH_M_RELATION_COUNT !== BATCH_M_AGGREGATES.length)
  throw new Error(
    `${BATCH_M_RELATION_COUNT} relational repositories for ${BATCH_M_AGGREGATES.length} ` +
      'Batch M aggregates; an aggregate with a schema and no repository cannot be stored.',
  );

import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';
import {
  auditIntegrityHash as sharedAuditIntegrityHash,
  canonicalJson,
  redactAuditMetadata,
} from '@assurapay/shared';
import type { SqlClient } from './postgres-client';
import { sanitizeDatabaseFailure } from './postgres-client';
import { currentTrustScope, isTenantScoped } from './trust-scope';
import type { TrustScope } from './trust-scope';

/**
 * The durable `TrustPersistence` implementation.
 *
 * Every method executes parameterized SQL against a real PostgreSQL connection.
 * There is no in-memory path, no file path, and no method that reports success
 * without a row having been written — a store that falls back to memory when the
 * database is unreachable is worse than one that fails, because the caller is told
 * its write survived.
 *
 * Collections are routed explicitly. Entities whose invariants CLAUDE.md depends on
 * have their own tables with real foreign keys and real uniqueness; the remaining
 * trust collections share `trust_records`, which still carries every dimension the
 * platform filters or scopes on as a column. A collection this store does not know
 * is refused: silently accepting it would persist authorization-relevant state
 * somewhere nothing reads, which is indistinguishable from losing it.
 */

export type PostgresStoreErrorCode =
  | 'PERSISTENCE_COLLECTION_NOT_MAPPED'
  | 'PERSISTENCE_RECORD_ID_REQUIRED'
  | 'PERSISTENCE_RECORD_NOT_FOUND'
  | 'PERSISTENCE_DUPLICATE_RECORD'
  | 'PERSISTENCE_SCOPE_INVALID'
  | 'PERSISTENCE_CONFLICT'
  | 'PERSISTENCE_CORRUPT_RECORD'
  | 'PERSISTENCE_HISTORY_IMMUTABLE'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'PERSISTENCE_TIMEOUT'
  | 'PERSISTENCE_TRANSACTION_FAILED'
  | 'PERSISTENCE_REVOKED_SCOPE';

/** Stable codes so a caller branches on the reason, never on driver text. */
export class PostgresStoreError extends Error {
  readonly code: PostgresStoreErrorCode;
  readonly detail?: string;

  constructor(code: PostgresStoreErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PostgresStoreError';
    this.code = code;
    this.detail = detail;
  }
}

/** PostgreSQL SQLSTATE classes the store translates into its own vocabulary. */
const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  queryCanceled: '57014',
  adminShutdown: '57P01',
  cannotConnectNow: '57P03',
  connectionFailure: '08006',
  connectionDoesNotExist: '08003',
  invalidPassword: '28P01',
  insufficientPrivilege: '42501',
  undefinedTable: '42P01',
} as const;

/**
 * Translates a driver failure into a stable store code.
 *
 * The raw error never escapes: it carries the failing statement's parameter values,
 * which for this store include tenant ids, principal ids and permission keys.
 */
function translate(error: unknown): PostgresStoreError {
  const code = (error as { code?: string } | null)?.code;
  const detail = sanitizeDatabaseFailure(error);

  // The append-only trigger raises a bare exception with a recognizable prefix.
  if (detail.includes('TRUST_HISTORY_IS_APPEND_ONLY'))
    return new PostgresStoreError('PERSISTENCE_HISTORY_IMMUTABLE', detail);

  switch (code) {
    case SQLSTATE.uniqueViolation:
      return new PostgresStoreError('PERSISTENCE_DUPLICATE_RECORD', detail);
    case SQLSTATE.foreignKeyViolation:
      return new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', detail);
    case SQLSTATE.checkViolation:
    case SQLSTATE.notNullViolation:
      return new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', detail);
    case SQLSTATE.serializationFailure:
    case SQLSTATE.deadlockDetected:
      return new PostgresStoreError('PERSISTENCE_CONFLICT', detail);
    case SQLSTATE.queryCanceled:
      return new PostgresStoreError('PERSISTENCE_TIMEOUT', detail);
    case SQLSTATE.adminShutdown:
    case SQLSTATE.cannotConnectNow:
    case SQLSTATE.connectionFailure:
    case SQLSTATE.connectionDoesNotExist:
    case SQLSTATE.invalidPassword:
    case SQLSTATE.insufficientPrivilege:
    case SQLSTATE.undefinedTable:
      return new PostgresStoreError('PERSISTENCE_UNAVAILABLE', detail);
    default:
      return error instanceof PostgresStoreError
        ? error
        : new PostgresStoreError('PERSISTENCE_UNAVAILABLE', detail);
  }
}

/** Rethrows as a store error, preserving one that is already translated. */
function fail(error: unknown): never {
  throw error instanceof PostgresStoreError ? error : translate(error);
}

/**
 * Collections with a dedicated table.
 *
 * Each entry names the table and the columns lifted out of the record, so the
 * invariants in the schema — foreign keys, partial unique indexes, lifecycle checks —
 * apply to real columns rather than to JSON.
 */
type DedicatedMapping = {
  table: string;
  idColumn: string;
  /** Record field → column, for fields promoted out of the payload. */
  columns: Record<string, string>;
};

const DEDICATED: Record<string, DedicatedMapping> = {
  trustWorkspaces: {
    table: 'trust_workspaces',
    idColumn: 'workspace_id',
    columns: { tenantId: 'tenant_id', status: 'status', version: 'version' },
  },
  memberships: {
    table: 'trust_memberships',
    idColumn: 'membership_id',
    columns: {
      workspaceId: 'workspace_id',
      userId: 'user_id',
      status: 'status',
      role: 'role',
      effectiveFrom: 'effective_from',
      effectiveTo: 'effective_to',
      revokedAt: 'revoked_at',
      version: 'version',
    },
  },
  permissionGrants: {
    table: 'trust_permission_grants',
    idColumn: 'grant_id',
    columns: {
      workspaceId: 'workspace_id',
      userId: 'user_id',
      permissionKey: 'permission_key',
      effect: 'effect',
      scopeType: 'scope_type',
      scopeId: 'scope_id',
      sourceType: 'source_type',
      sourceId: 'source_id',
      effectiveFrom: 'effective_from',
      effectiveTo: 'effective_to',
      revokedAt: 'revoked_at',
    },
  },
};

/**
 * Collections stored in the governed document table.
 *
 * Listed explicitly rather than accepted by default. An unlisted collection is a
 * caller persisting something this store was not built to hold, and the honest answer
 * is a refusal — not a row nothing will ever read.
 */
const GOVERNED_DOCUMENTS = Object.freeze([
  'authenticationMethods',
  'beneficiaryAccounts',
  'consents',
  'delegations',
  'devices',
  'evidenceLedgerEntries',
  'fieldPermissions',
  'authorityRules',
  'invitations',
  'identities',
  'legalHolds',
  'legalPolicies',
  'legalPolicyVersions',
  'organizationUnits',
  'parties',
  'policyAcceptances',
  'policyAssignments',
  'segregationRules',
  'sessions',
  'signaturePolicies',
  'stepUpChallenges',
  'trustOrganizations',
  'verificationRequests',
  'verificationResults',
]);

/** Collections with bespoke handling, reached through `audit` and `emit` only. */
const HISTORY_COLLECTIONS = Object.freeze(['auditRecords', 'outboxEvents']);

/** Every collection this store can serve. */
export const POSTGRES_TRUST_COLLECTIONS: readonly string[] = Object.freeze(
  [...Object.keys(DEDICATED), ...GOVERNED_DOCUMENTS, ...HISTORY_COLLECTIONS].sort(),
);

/** Scope fields promoted to columns in `trust_records`, in priority order. */
const SCOPE_FIELDS = {
  tenantId: ['tenantId'],
  workspaceId: ['workspaceId'],
  principalId: ['userId', 'principalId', 'partyId', 'actorId'],
  status: ['status'],
  effectiveFrom: ['effectiveFrom', 'issuedAt', 'createdAt'],
  effectiveTo: ['effectiveTo', 'expiresAt'],
  revokedAt: ['revokedAt'],
} as const;

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstTimestamp(record: Record<string, unknown>, keys: readonly string[]): Date | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return null;
}

/**
 * A digest over the record as stored.
 *
 * Keys are sorted so the digest depends on content rather than on property order,
 * which JSON round-trips do not preserve.
 */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requireRecordId(value: unknown): string {
  const id = (value as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.length === 0)
    throw new PostgresStoreError(
      'PERSISTENCE_RECORD_ID_REQUIRED',
      'every persisted record needs a string id',
    );
  return id;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', 'expected an object record');
  return value as Record<string, unknown>;
}

/**
 * Reconstructs the domain record from a stored row.
 *
 * The payload holds the record verbatim, so the promoted columns are not merged back
 * in — doing so would let a column edited out of band silently replace the value the
 * digest was computed over, and the tamper check would still pass.
 */
function rowToRecord<T>(row: { payload: unknown; payload_digest: string }): T {
  const payload = row.payload;
  if (payload === null || typeof payload !== 'object')
    throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', 'stored payload is not an object');
  if (payloadDigest(payload) !== row.payload_digest)
    throw new PostgresStoreError(
      'PERSISTENCE_CORRUPT_RECORD',
      'stored payload does not match its digest',
    );
  return payload as T;
}

export type PostgresTrustStoreOptions = {
  /**
   * Clock, injected so a test can assert timestamps without sleeping. Production
   * leaves it unset and gets the real one.
   */
  now?: () => Date;
  /**
   * Set when this store is bound to an open transaction.
   *
   * Read by `transaction` so a nested call joins the outer one instead of opening a
   * savepoint. Not a public knob: the only caller that sets it is `transaction`
   * itself, constructing the store it hands to the callback.
   */
  withinTransaction?: boolean;
};

export class PostgresTrustStore implements TrustPersistence {
  private readonly now: () => Date;
  private readonly withinTransaction: boolean;

  constructor(
    private readonly sql: SqlClient,
    options: PostgresTrustStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.withinTransaction = options.withinTransaction ?? false;
  }

  /**
   * Runs an operation with the ambient tenancy scope applied to its connection.
   *
   * Row Level Security reads `app.tenant_id` and `app.workspace_id`, and those are session
   * variables — so they must be set on the same connection that runs the statement, and
   * only for its duration. `set_config(..., true)` is transaction-local, which is why every
   * scoped operation opens a transaction: a value set without one would persist on the
   * pooled connection and become the next request's scope, which is a cross-tenant read
   * with no bug in any policy.
   *
   * Three cases, and the third is the one that matters:
   *
   *   Already inside a transaction — the scope was applied when it opened.
   *   An ambient scope exists — open a transaction, set it, run.
   *   No ambient scope — run unscoped. Under forced RLS that reads nothing and writes
   *     nothing, which is the correct outcome: an unscoped governed operation must not
   *     quietly see every tenant. It fails at the database rather than at the type level,
   *     which is the cost of carrying scope ambiently and is why scope is established at
   *     the funnel every protected route passes through.
   */
  private async inScope<T>(run: (store: PostgresTrustStore) => Promise<T>): Promise<T> {
    if (this.withinTransaction) return await run(this);

    const scope = currentTrustScope();
    if (!isTenantScoped(scope)) return await run(this);

    try {
      return await this.sql.begin(async (tx) => {
        await applyTrustScope(tx, scope);
        return await run(new PostgresTrustStore(tx, { now: this.now, withinTransaction: true }));
      });
    } catch (error) {
      fail(error);
    }
  }

  async list<T>(collection: string): Promise<T[]> {
    return await this.inScope((store) => store.listScoped<T>(collection));
  }

  async append<T>(collection: string, value: T): Promise<void> {
    await this.inScope((store) => store.appendScoped(collection, value));
  }

  async replace<T extends { id: string }>(collection: string, value: T): Promise<void> {
    await this.inScope((store) => store.replaceScoped(collection, value));
  }

  async audit(
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    return await this.inScope((store) => store.auditScoped(input));
  }

  async emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent> {
    return await this.inScope((store) => store.emitScoped(input));
  }

  /**
   * Reads a collection.
   *
   * Returns rows in insertion order, which the audit chain depends on and which every
   * engine that takes `records[records.length - 1]` as "the latest" assumes. An
   * unordered read would make those engines non-deterministic under any plan change.
   */
  private async listScoped<T>(collection: string): Promise<T[]> {
    const dedicated = DEDICATED[collection];
    try {
      if (collection === 'auditRecords') {
        // Ordered by position within the tenant. Under RLS a caller sees only its own
        // records, and those form a complete chain from position 1 — which is exactly what
        // `verifyAuditChain` needs and what a global chain could not provide.
        const rows = await this.sql<AuditRow[]>`
          SELECT * FROM trust_audit_records
          ORDER BY coalesce(tenant_id, '') ASC, chain_position ASC
        `;
        return rows.map(auditRowToRecord) as unknown as T[];
      }
      if (collection === 'outboxEvents') {
        const rows = await this.sql<OutboxRow[]>`
          SELECT * FROM trust_outbox_events ORDER BY occurred_at ASC, event_id ASC
        `;
        return rows.map(outboxRowToRecord) as unknown as T[];
      }
      // Table identifiers cannot be bound, so each dedicated table is read through
      // its own statement rather than through an interpolated name.
      if (dedicated) return await this.listDedicated<T>(collection);
      this.requireGoverned(collection);
      const rows = await this.sql<StoredRow[]>`
        SELECT payload, payload_digest FROM trust_records
        WHERE collection = ${collection}
        ORDER BY created_at ASC, record_id ASC
      `;
      return rows.map((row) => rowToRecord<T>(row));
    } catch (error) {
      fail(error);
    }
  }

  /** Dedicated tables, each with its own statement so no identifier is interpolated. */
  private async listDedicated<T>(collection: string): Promise<T[]> {
    if (collection === 'trustWorkspaces') {
      const rows = await this.sql<StoredRow[]>`
        SELECT payload, payload_digest FROM trust_workspaces
        ORDER BY created_at ASC, workspace_id ASC
      `;
      return rows.map((row) => rowToRecord<T>(row));
    }
    if (collection === 'memberships') {
      const rows = await this.sql<StoredRow[]>`
        SELECT payload, payload_digest FROM trust_memberships
        ORDER BY created_at ASC, membership_id ASC
      `;
      return rows.map((row) => rowToRecord<T>(row));
    }
    const rows = await this.sql<StoredRow[]>`
      SELECT payload, payload_digest FROM trust_permission_grants
      ORDER BY created_at ASC, grant_id ASC
    `;
    return rows.map((row) => rowToRecord<T>(row));
  }

  private async appendScoped<T>(collection: string, value: T): Promise<void> {
    const record = asRecord(value);
    const id = requireRecordId(value);
    const digest = payloadDigest(record);

    try {
      if (collection === 'trustWorkspaces') {
        const tenantId = firstString(record, ['tenantId']);
        if (!tenantId)
          throw new PostgresStoreError(
            'PERSISTENCE_SCOPE_INVALID',
            'a workspace must name its tenant',
          );
        // The tenant row is created on demand: tenancy has no engine that owns a
        // tenant lifecycle yet, and a foreign key with nothing to point at would make
        // every workspace write fail.
        await this.sql`
          INSERT INTO trust_tenants (tenant_id) VALUES (${tenantId})
          ON CONFLICT (tenant_id) DO NOTHING
        `;
        await this.sql`
          INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest, version)
          VALUES (
            ${id}, ${tenantId}, ${firstString(record, ['status']) ?? 'ACTIVE'},
            ${this.sql.json(record)}, ${digest}, ${asVersion(record)}
          )
        `;
        return;
      }

      if (collection === 'memberships') {
        await this.sql`
          INSERT INTO trust_memberships (
            membership_id, workspace_id, user_id, status, role,
            effective_from, effective_to, revoked_at, payload, payload_digest, version
          ) VALUES (
            ${id},
            ${requireScope(record, 'workspaceId')},
            ${requireScope(record, 'userId')},
            ${firstString(record, ['status']) ?? 'ACTIVE'},
            ${firstString(record, ['role'])},
            ${firstTimestamp(record, ['effectiveFrom', 'createdAt'])},
            ${firstTimestamp(record, ['effectiveTo'])},
            ${firstTimestamp(record, ['revokedAt'])},
            ${this.sql.json(record)}, ${digest}, ${asVersion(record)}
          )
        `;
        return;
      }

      if (collection === 'permissionGrants') {
        await this.sql`
          INSERT INTO trust_permission_grants (
            grant_id, workspace_id, user_id, permission_key, effect, scope_type, scope_id,
            source_type, source_id, effective_from, effective_to, revoked_at, payload, payload_digest
          ) VALUES (
            ${id},
            ${requireScope(record, 'workspaceId')},
            ${requireScope(record, 'userId')},
            ${requireScope(record, 'permissionKey')},
            ${firstString(record, ['effect']) ?? 'ALLOW'},
            ${firstString(record, ['scopeType']) ?? 'WORKSPACE'},
            ${firstString(record, ['scopeId'])},
            ${firstString(record, ['sourceType']) ?? 'ROLE'},
            ${firstString(record, ['sourceId']) ?? 'unspecified'},
            ${firstTimestamp(record, ['effectiveFrom', 'createdAt']) ?? this.now()},
            ${firstTimestamp(record, ['effectiveTo'])},
            ${firstTimestamp(record, ['revokedAt'])},
            ${this.sql.json(record)}, ${digest}
          )
        `;
        return;
      }

      this.requireGoverned(collection);
      await this.sql`
        INSERT INTO trust_records (
          collection, record_id, tenant_id, workspace_id, principal_id, status,
          effective_from, effective_to, revoked_at, version, payload, payload_digest
        ) VALUES (
          ${collection}, ${id},
          ${firstString(record, SCOPE_FIELDS.tenantId)},
          ${firstString(record, SCOPE_FIELDS.workspaceId)},
          ${firstString(record, SCOPE_FIELDS.principalId)},
          ${firstString(record, SCOPE_FIELDS.status)},
          ${firstTimestamp(record, SCOPE_FIELDS.effectiveFrom)},
          ${firstTimestamp(record, SCOPE_FIELDS.effectiveTo)},
          ${firstTimestamp(record, SCOPE_FIELDS.revokedAt)},
          ${asVersion(record)}, ${this.sql.json(record)}, ${digest}
        )
      `;
    } catch (error) {
      fail(error);
    }
  }

  /**
   * Replaces a record in place, by id.
   *
   * A missing row is an error rather than an insert. `replace` is how an engine
   * commits a state transition it has already validated against the record it read;
   * turning that into a create would resurrect a deleted aggregate and skip every
   * precondition the engine checked.
   */
  private async replaceScoped<T extends { id: string }>(collection: string, value: T): Promise<void> {
    const record = asRecord(value);
    const id = requireRecordId(value);
    const digest = payloadDigest(record);
    const updatedAt = this.now();

    try {
      if (collection === 'trustWorkspaces') {
        const rows = await this.sql<{ workspace_id: string }[]>`
          UPDATE trust_workspaces SET
            status = ${firstString(record, ['status']) ?? 'ACTIVE'},
            payload = ${this.sql.json(record)},
            payload_digest = ${digest},
            version = ${asVersion(record)},
            updated_at = ${updatedAt}
          WHERE workspace_id = ${id}
          RETURNING workspace_id
        `;
        this.requireAffected(rows.length, collection, id);
        return;
      }

      if (collection === 'memberships') {
        const rows = await this.sql<{ membership_id: string }[]>`
          UPDATE trust_memberships SET
            status = ${firstString(record, ['status']) ?? 'ACTIVE'},
            role = ${firstString(record, ['role'])},
            effective_from = ${firstTimestamp(record, ['effectiveFrom', 'createdAt'])},
            effective_to = ${firstTimestamp(record, ['effectiveTo'])},
            revoked_at = ${firstTimestamp(record, ['revokedAt'])},
            payload = ${this.sql.json(record)},
            payload_digest = ${digest},
            version = ${asVersion(record)},
            updated_at = ${updatedAt}
          WHERE membership_id = ${id}
          RETURNING membership_id
        `;
        this.requireAffected(rows.length, collection, id);
        return;
      }

      if (collection === 'permissionGrants') {
        const rows = await this.sql<{ grant_id: string }[]>`
          UPDATE trust_permission_grants SET
            effect = ${firstString(record, ['effect']) ?? 'ALLOW'},
            scope_id = ${firstString(record, ['scopeId'])},
            effective_to = ${firstTimestamp(record, ['effectiveTo'])},
            revoked_at = ${firstTimestamp(record, ['revokedAt'])},
            payload = ${this.sql.json(record)},
            payload_digest = ${digest}
          WHERE grant_id = ${id}
          RETURNING grant_id
        `;
        this.requireAffected(rows.length, collection, id);
        return;
      }

      this.requireGoverned(collection);
      const rows = await this.sql<{ record_id: string }[]>`
        UPDATE trust_records SET
          tenant_id = ${firstString(record, SCOPE_FIELDS.tenantId)},
          workspace_id = ${firstString(record, SCOPE_FIELDS.workspaceId)},
          principal_id = ${firstString(record, SCOPE_FIELDS.principalId)},
          status = ${firstString(record, SCOPE_FIELDS.status)},
          effective_from = ${firstTimestamp(record, SCOPE_FIELDS.effectiveFrom)},
          effective_to = ${firstTimestamp(record, SCOPE_FIELDS.effectiveTo)},
          revoked_at = ${firstTimestamp(record, SCOPE_FIELDS.revokedAt)},
          version = ${asVersion(record)},
          payload = ${this.sql.json(record)},
          payload_digest = ${digest},
          updated_at = ${updatedAt}
        WHERE collection = ${collection} AND record_id = ${id}
        RETURNING record_id
      `;
      this.requireAffected(rows.length, collection, id);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * Appends an audit record, linked to its predecessor.
   *
   * The chain position and predecessor are read and written in one transaction with
   * `FOR UPDATE` on the tail. Two concurrent appends would otherwise both read the
   * same predecessor and both claim it, forking the chain — the exact defect the
   * in-memory store's sequential grant issuance was changed to avoid, except that a
   * database has genuinely concurrent writers and cannot be fixed by ordering calls.
   */
  private async auditScoped(
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    try {
      // Inside an open transaction the append joins it, so the caller's mutation and
      // its audit record commit or roll back together. Opening a second transaction
      // here would let the audit survive a rolled-back mutation.
      if (this.withinTransaction) return await this.appendAudit(this.sql, input);
      return await this.sql.begin(async (tx) => this.appendAudit(tx, input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * Appends one link to the chain, on the given connection.
   *
   * The table lock is what makes the read-then-write atomic. A row lock on the tail
   * cannot serialize it: the second writer must be blocked *before* it reads, and at
   * position 1 there is no row for it to wait on. The lock is held only for the
   * duration of the enclosing statement pair, and the chain is the one structure in
   * the system that is inherently sequential — its whole purpose is that link N+1
   * commits to exactly what link N said.
   */
  private async appendAudit(
    sql: SqlClient,
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    await sql`LOCK TABLE trust_audit_records IN EXCLUSIVE MODE`;
    // The tail of *this tenant's* chain. Read globally, this returns whatever row happened to
    // be last across all tenants — and under Row Level Security it returns nothing at all for
    // the second tenant, because the policy hides the first tenant's rows. The caller then
    // computes position 1 and collides. One chain per tenant is what makes the position
    // allocatable and the chain verifiable from inside a tenant scope.
    const tenantId = input.tenantId ?? '';
    const [tail] = await sql<{ chain_position: string; integrity_hash: string }[]>`
      SELECT chain_position, integrity_hash FROM trust_audit_records
      WHERE coalesce(tenant_id, '') = ${tenantId}
      ORDER BY chain_position DESC LIMIT 1
    `;

    const chainPosition = tail ? Number(tail.chain_position) + 1 : 1;
    const previousHash = tail?.integrity_hash;
    const createdAt = this.now().toISOString();
    // Redacted before hashing, never after: history is append-only, so a secret
    // written into it is permanent.
    const metadata = redactAuditMetadata(input.metadata);
    const integrityHash = sharedAuditIntegrityHash(
      { ...input, metadata, createdAt, previousHash },
      (value) => createHash('sha256').update(value).digest('hex'),
    );

    const record: AuditRecord = {
      id: randomUUID(),
      ...input,
      metadata,
      createdAt,
      integrityHash,
      previousHash,
    };

    await sql`
      INSERT INTO trust_audit_records (
        audit_id, chain_position, tenant_id, workspace_id, actor_id, event_type,
        aggregate_type, aggregate_id, correlation_id, metadata, previous_hash,
        integrity_hash, created_at
      ) VALUES (
        ${record.id}, ${chainPosition}, ${record.tenantId ?? null}, ${record.workspaceId ?? null},
        ${record.actorId}, ${record.eventType}, ${record.aggregateType}, ${record.aggregateId},
        ${record.correlationId}, ${sql.json(metadata)}, ${previousHash ?? null},
        ${integrityHash}, ${createdAt}
      )
    `;
    return record;
  }

  private async emitScoped(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent> {
    const event: OutboxEvent = {
      ...input,
      id: randomUUID(),
      occurredAt: this.now().toISOString(),
    };
    try {
      await this.sql`
        INSERT INTO trust_outbox_events (
          event_id, tenant_id, workspace_id, aggregate_type, aggregate_id, event_type,
          event_version, payload, correlation_id, occurred_at, published_at
        ) VALUES (
          ${event.id}, ${event.tenantId ?? null}, ${event.workspaceId ?? null},
          ${event.aggregateType}, ${event.aggregateId}, ${event.eventType},
          ${event.eventVersion}, ${this.sql.json(event.payload)}, ${event.correlationId},
          ${event.occurredAt}, ${event.publishedAt ?? null}
        )
      `;
      return event;
    } catch (error) {
      fail(error);
    }
  }

  /**
   * Runs `operation` inside a real database transaction.
   *
   * BEGIN before, COMMIT after resolution, ROLLBACK on rejection — the driver's own,
   * not a snapshot-and-restore simulation. The callback receives a store bound to the
   * transaction's connection; writes through the outer store are not part of it,
   * which is why it is passed rather than assumed.
   *
   * Nested calls join the outer transaction rather than opening a savepoint. A nested
   * rollback that undid only inner writes would leave the outer transaction partially
   * applied while reporting that it had been undone.
   */
  async transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T> {
    // Already inside one: join it. Opening a savepoint here would let an inner
    // rollback report that its writes were undone while the outer transaction went
    // on to commit the rest, which is a partially applied transaction reported as a
    // clean one.
    if (this.withinTransaction) return await operation(this);

    try {
      return await this.sql.begin(async (tx) => {
        // Once, for the whole transaction. Every operation inside it then runs on this
        // connection with this scope, and `inScope` sees `withinTransaction` and does not
        // reapply it.
        const scope = currentTrustScope();
        if (isTenantScoped(scope)) await applyTrustScope(tx, scope);
        return await operation(
          new PostgresTrustStore(tx, { now: this.now, withinTransaction: true }),
        );
      });
    } catch (error) {
      if (error instanceof PostgresStoreError) throw error;
      throw new PostgresStoreError('PERSISTENCE_TRANSACTION_FAILED', sanitizeDatabaseFailure(error));
    }
  }

  private requireGoverned(collection: string): void {
    if (!GOVERNED_DOCUMENTS.includes(collection))
      throw new PostgresStoreError(
        'PERSISTENCE_COLLECTION_NOT_MAPPED',
        `${collection} has no mapping in the durable trust store`,
      );
  }

  private requireAffected(affected: number, collection: string, id: string): void {
    if (affected === 0)
      throw new PostgresStoreError(
        'PERSISTENCE_RECORD_NOT_FOUND',
        `${collection}/${id} does not exist; replace does not create`,
      );
  }
}

type StoredRow = { payload: unknown; payload_digest: string };

type AuditRow = {
  audit_id: string;
  chain_position: string;
  tenant_id: string | null;
  workspace_id: string | null;
  actor_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string;
  metadata: Record<string, unknown>;
  previous_hash: string | null;
  integrity_hash: string;
  created_at: Date;
};

type OutboxRow = {
  event_id: string;
  tenant_id: string | null;
  workspace_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  correlation_id: string;
  occurred_at: Date;
  published_at: Date | null;
};

/**
 * Rebuilds the audit record from its row.
 *
 * Optional fields are omitted rather than set to null, because the integrity hash is
 * computed over the record's own keys and a present-but-null key changes it.
 */
function auditRowToRecord(row: AuditRow): AuditRecord {
  const record: AuditRecord = {
    id: row.audit_id,
    actorId: row.actor_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    correlationId: row.correlation_id,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    integrityHash: row.integrity_hash,
  };
  if (row.tenant_id !== null) record.tenantId = row.tenant_id;
  if (row.workspace_id !== null) record.workspaceId = row.workspace_id;
  if (row.previous_hash !== null) record.previousHash = row.previous_hash;
  return record;
}

function outboxRowToRecord(row: OutboxRow): OutboxEvent {
  const event: OutboxEvent = {
    id: row.event_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at.toISOString(),
  };
  if (row.tenant_id !== null) event.tenantId = row.tenant_id;
  if (row.workspace_id !== null) event.workspaceId = row.workspace_id;
  if (row.published_at !== null) event.publishedAt = row.published_at.toISOString();
  return event;
}

function requireScope(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', `${field} is required`);
  return value;
}

/**
 * Sets the session variables the policies read, transaction-locally.
 *
 * `true` is the `is_local` argument: the value reverts when the transaction ends. A global
 * `set_config` would leave the scope on the pooled connection for whatever request it serves
 * next — the failure mode being guarded against here is not a policy bug but a scope that
 * outlives its request.
 *
 * Absent parts are set to the empty string rather than left alone, so a connection cannot
 * inherit a previous transaction's value through a variable this one did not mention.
 */
export async function applyTrustScope(sql: SqlClient, scope: TrustScope): Promise<void> {
  await sql`SELECT
    set_config('app.tenant_id', ${scope.tenantId ?? ''}, true),
    set_config('app.workspace_id', ${scope.workspaceId ?? ''}, true),
    set_config('app.actor_id', ${scope.actorId ?? ''}, true)
  `;
}

function asVersion(record: Record<string, unknown>): number {
  const value = record.version;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

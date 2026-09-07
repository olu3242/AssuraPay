import { createHash } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';
import { canonicalJson } from '@assurapay/shared';
import type { SqlClient } from './postgres-client';
import {
  PostgresTrustStore as BasePostgresTrustStore,
  PostgresStoreError,
  POSTGRES_IDENTITY_PLANE_COLLECTIONS,
  POSTGRES_ROUTED_TABLES,
  POSTGRES_TRUST_COLLECTIONS as BASE_POSTGRES_TRUST_COLLECTIONS,
  applyTrustScope,
  payloadDigest,
  type PostgresTrustStoreOptions,
} from './postgres-store';
import { currentTrustScope, isScopeBearing } from './trust-scope';

export {
  PostgresStoreError,
  POSTGRES_IDENTITY_PLANE_COLLECTIONS,
  POSTGRES_ROUTED_TABLES,
  applyTrustScope,
  payloadDigest,
};
export type { PostgresStoreErrorCode } from './store-error';
export type { PostgresTrustStoreOptions } from './postgres-store';

/**
 * Flow OS records are orchestration state, not new financial/domain aggregates. They therefore use the
 * existing governed `trust_records` document table rather than inventing four one-off tables. The names
 * remain explicit so an accidental new orchestration collection still fails closed.
 */
export const FLOW_POSTGRES_TRUST_COLLECTIONS = Object.freeze([
  'flowInstances',
  'flowStepInstances',
  'flowSignals',
  'humanTasks',
] as const);

const FLOW_COLLECTION_SET = new Set<string>(FLOW_POSTGRES_TRUST_COLLECTIONS);

/** Every collection the public PostgreSQL adapter can serve. */
export const POSTGRES_TRUST_COLLECTIONS: readonly string[] = Object.freeze(
  [...BASE_POSTGRES_TRUST_COLLECTIONS, ...FLOW_POSTGRES_TRUST_COLLECTIONS].sort(),
);

type StoredRow = { payload: unknown; payload_digest: string };
type FlowRecord = Record<string, unknown> & { id: string; workspaceId: string };

function isFlowCollection(collection: string): boolean {
  return FLOW_COLLECTION_SET.has(collection);
}

function asFlowRecord(value: unknown): FlowRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', 'flow record must be an object');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0)
    throw new PostgresStoreError('PERSISTENCE_RECORD_ID_REQUIRED', 'flow record id is required');
  if (typeof record.workspaceId !== 'string' || record.workspaceId.length === 0)
    throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', 'flow record workspaceId is required');
  return record as FlowRecord;
}

function readFlowRecord<T>(row: StoredRow): T {
  if (row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload))
    throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', 'stored flow payload is not an object');
  const digest = createHash('sha256').update(canonicalJson(row.payload)).digest('hex');
  if (digest !== row.payload_digest)
    throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', 'stored flow payload does not match its digest');
  return row.payload as T;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function timestampField(record: Record<string, unknown>, ...keys: string[]): Date | null {
  const value = stringField(record, ...keys);
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function versionOf(record: Record<string, unknown>): number {
  const value = record.version;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * Canonical durable store exported by `@assurapay/database`.
 *
 * Existing collections are delegated unchanged to the mature store. Only the four Flow OS collections are
 * handled here, on the same SQL connection and transaction, so flow mutation + audit + outbox can commit as
 * one database transaction. This closes the production-only `PERSISTENCE_COLLECTION_NOT_MAPPED` failure
 * without weakening the base store's explicit allowlist.
 */
export class PostgresTrustStore implements TrustPersistence {
  private readonly base: BasePostgresTrustStore;
  private readonly withinTransaction: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly sql: SqlClient,
    options: PostgresTrustStoreOptions = {},
  ) {
    this.withinTransaction = options.withinTransaction ?? false;
    this.now = options.now ?? (() => new Date());
    this.base = new BasePostgresTrustStore(sql, options);
  }

  async list<T>(collection: string): Promise<T[]> {
    if (!isFlowCollection(collection)) return await this.base.list<T>(collection);
    return await this.inScope((store) => store.listFlowScoped<T>(collection));
  }

  async append<T>(collection: string, value: T): Promise<void> {
    if (!isFlowCollection(collection)) return await this.base.append(collection, value);
    await this.inScope((store) => store.appendFlowScoped(collection, value));
  }

  async replace<T extends { id: string }>(collection: string, value: T): Promise<void> {
    if (!isFlowCollection(collection)) return await this.base.replace(collection, value);
    await this.inScope((store) => store.replaceFlowScoped(collection, value));
  }

  async audit(
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    return await this.base.audit(input);
  }

  async emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent> {
    return await this.base.emit(input);
  }

  async transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T> {
    if (this.withinTransaction) return await operation(this);
    try {
      return await this.sql.begin(async (tx) => {
        const scope = currentTrustScope();
        if (isScopeBearing(scope)) await applyTrustScope(tx, scope);
        return await operation(new PostgresTrustStore(tx, { now: this.now, withinTransaction: true }));
      });
    } catch (error) {
      if (error instanceof PostgresStoreError) throw error;
      throw new PostgresStoreError(
        'PERSISTENCE_TRANSACTION_FAILED',
        error instanceof Error ? error.message : 'flow transaction failed',
      );
    }
  }

  private async inScope<T>(operation: (store: PostgresTrustStore) => Promise<T>): Promise<T> {
    if (this.withinTransaction) return await operation(this);
    const scope = currentTrustScope();
    if (!isScopeBearing(scope)) return await operation(this);
    try {
      return await this.sql.begin(async (tx) => {
        await applyTrustScope(tx, scope);
        return await operation(new PostgresTrustStore(tx, { now: this.now, withinTransaction: true }));
      });
    } catch (error) {
      if (error instanceof PostgresStoreError) throw error;
      throw new PostgresStoreError(
        'PERSISTENCE_UNAVAILABLE',
        error instanceof Error ? error.message : 'flow persistence failed',
      );
    }
  }

  private assertScope(record: FlowRecord): { tenantId: string | null; workspaceId: string } {
    const scope = currentTrustScope();
    if (scope?.workspaceId && scope.workspaceId !== record.workspaceId)
      throw new PostgresStoreError(
        'PERSISTENCE_SCOPE_INVALID',
        'flow record belongs to a workspace other than the caller scope',
      );
    return { tenantId: scope?.tenantId ?? null, workspaceId: record.workspaceId };
  }

  private async listFlowScoped<T>(collection: string): Promise<T[]> {
    const rows = await this.sql<StoredRow[]>`
      SELECT payload, payload_digest FROM trust_records
      WHERE collection = ${collection}
      ORDER BY created_at ASC, record_id ASC
    `;
    return rows.map((row) => readFlowRecord<T>(row));
  }

  private async appendFlowScoped<T>(collection: string, value: T): Promise<void> {
    const record = asFlowRecord(value);
    const { tenantId, workspaceId } = this.assertScope(record);
    const digest = payloadDigest(record);
    try {
      await this.sql`
        INSERT INTO trust_records (
          collection, record_id, tenant_id, workspace_id, status,
          effective_from, version, payload, payload_digest
        ) VALUES (
          ${collection}, ${record.id}, ${tenantId}, ${workspaceId},
          ${stringField(record, 'state', 'status')},
          ${timestampField(record, 'createdAt')},
          ${versionOf(record)}, ${this.sql.json(record)}, ${digest}
        )
      `;
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async replaceFlowScoped<T extends { id: string }>(collection: string, value: T): Promise<void> {
    const record = asFlowRecord(value);
    const { tenantId, workspaceId } = this.assertScope(record);
    const digest = payloadDigest(record);
    try {
      const rows = await this.sql<{ record_id: string }[]>`
        UPDATE trust_records SET
          tenant_id = ${tenantId},
          workspace_id = ${workspaceId},
          status = ${stringField(record, 'state', 'status')},
          effective_from = ${timestampField(record, 'createdAt')},
          version = ${versionOf(record)},
          payload = ${this.sql.json(record)},
          payload_digest = ${digest},
          updated_at = ${this.now()}
        WHERE collection = ${collection} AND record_id = ${record.id}
        RETURNING record_id
      `;
      if (rows.length === 0)
        throw new PostgresStoreError(
          'PERSISTENCE_RECORD_NOT_FOUND',
          `${collection}/${record.id} does not exist; replace does not create`,
        );
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof PostgresStoreError) throw error;
    const code = (error as { code?: string } | null)?.code;
    if (code === '23505')
      throw new PostgresStoreError('PERSISTENCE_DUPLICATE_RECORD', 'duplicate flow persistence record');
    if (code === '42501')
      throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', 'flow persistence scope was refused');
    if (code === '23502' || code === '23514')
      throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', 'flow persistence record violated a constraint');
    throw new PostgresStoreError(
      'PERSISTENCE_UNAVAILABLE',
      error instanceof Error ? error.message : 'flow persistence unavailable',
    );
  }
}

import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

export type P1Relation = {
  readonly collection: string;
  readonly table: string;
  readonly appendOnly: boolean;
};

/**
 * The remaining P1 durability closure selected by REOS. Table names are evidence and
 * documentation only: runtime SQL receives the collection as a value and the database
 * resolves it through an immutable CASE expression. No caller-controlled identifier is
 * ever interpolated into SQL.
 */
export const P1_RELATIONS = Object.freeze({
  acceptanceCriteria: { table: 'acceptance_criteria', appendOnly: false },
  successMetrics: { table: 'success_metrics', appendOnly: false },
  dependencies: { table: 'dependencies', appendOnly: false },
  paymentTriggerRules: { table: 'payment_trigger_rules', appendOnly: false },
  paymentTriggerEvaluations: { table: 'payment_trigger_evaluations', appendOnly: true },
  performanceBaselines: { table: 'performance_baselines', appendOnly: true },
  baselineVariances: { table: 'baseline_variances', appendOnly: true },
} as const satisfies Record<string, Omit<P1Relation, 'collection'>>);

export type P1Collection = keyof typeof P1_RELATIONS;

export const P1_TABLES: readonly string[] = Object.freeze(
  [...new Set(Object.values(P1_RELATIONS).map((relation) => relation.table))].sort(),
);

export function isP1Collection(collection: string): collection is P1Collection {
  return Object.prototype.hasOwnProperty.call(P1_RELATIONS, collection);
}

function requireRecord(collection: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${collection}: record must be an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0)
    throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${collection}: id must be a non-empty string`);
  if (typeof record.workspaceId !== 'string' || record.workspaceId.length === 0)
    throw new PostgresStoreError(
      'PERSISTENCE_SCOPE_INVALID',
      `${collection}: workspaceId must be a non-empty string`,
    );
  return record;
}

const SPECIAL_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});

function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/** Converts only relation columns. Nested JSON is domain data and retains its canonical keys. */
function toColumns(collection: P1Collection, record: Record<string, unknown>): Record<string, unknown> {
  const special = SPECIAL_COLUMNS[collection] ?? {};
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [special[key] ?? snakeCase(key), value]),
  );
}

function fromColumns(collection: P1Collection, record: unknown): Record<string, unknown> {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', `${collection}: row is not an object`);
  const reverse = Object.fromEntries(
    Object.entries(SPECIAL_COLUMNS[collection] ?? {}).map(([field, column]) => [column, field]),
  );
  return Object.fromEntries(
    Object.entries(record as Record<string, unknown>).map(([key, value]) => [reverse[key] ?? camelCase(key), value]),
  );
}

export function p1Relation(collection: P1Collection): P1Relation {
  return { collection, ...P1_RELATIONS[collection] };
}

export async function listP1(sql: SqlClient, collection: P1Collection): Promise<Record<string, unknown>[]> {
  const rows = await sql<{ record: unknown }[]>`
    SELECT record FROM assurapay_p1_list(${collection}) AS records(record)
  `;
  return rows.map((row) => requireRecord(collection, fromColumns(collection, row.record)));
}

export async function insertP1(
  sql: SqlClient,
  collection: P1Collection,
  value: unknown,
  tenantId: string,
): Promise<void> {
  const record = requireRecord(collection, value);
  await sql`SELECT assurapay_p1_append(
    ${collection}, ${tenantId}, ${record.workspaceId as string}, ${sql.json(toColumns(collection, record))}
  )`;
}

export async function updateP1(
  sql: SqlClient,
  collection: P1Collection,
  value: unknown,
  tenantId: string,
): Promise<number> {
  if (P1_RELATIONS[collection].appendOnly)
    throw new PostgresStoreError(
      'PERSISTENCE_HISTORY_IMMUTABLE',
      `${collection} is append-only; replace is not permitted`,
    );
  const record = requireRecord(collection, value);
  const expectedVersion = record.rowVersion;
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
    throw new PostgresStoreError(
      'PERSISTENCE_CONFLICT',
      `${collection}: replace requires the rowVersion returned by list`,
    );
  const [result] = await sql<{ affected: number }[]>`
    SELECT assurapay_p1_replace(
      ${collection}, ${tenantId}, ${record.workspaceId as string}, ${record.id as string},
      ${expectedVersion as number}, ${sql.json(toColumns(collection, record))}
    ) AS affected
  `;
  const affected = result?.affected ?? 0;
  if (affected < 0)
    throw new PostgresStoreError(
      'PERSISTENCE_CONFLICT',
      `${collection}/${record.id as string} was changed after it was read`,
    );
  return affected;
}

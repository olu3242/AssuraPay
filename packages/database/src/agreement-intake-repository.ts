import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

type Row = Record<string, unknown>;

export type AgreementIntakeRelation = {
  readonly collection: 'agreementIntakes';
  readonly table: 'agreement_intakes';
  readonly appendOnly: false;
  list(sql: SqlClient): Promise<Row[]>;
  insert(sql: SqlClient, record: Row, tenantId: string): Promise<void>;
  update(sql: SqlClient, record: Row): Promise<number>;
};

function required(record: Row, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `agreementIntakes.${key} is required`);
  return value;
}

function number(record: Row, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `agreementIntakes.${key} must be numeric`);
  return value;
}

function rowToRecord(row: Row): Row {
  return {
    id: required(row, 'id'),
    workspaceId: required(row, 'workspace_id'),
    sourceType: required(row, 'source_type'),
    sourceArtifactIds: row.source_artifact_ids ?? [],
    sourceHash: required(row, 'source_hash'),
    proposedTerms: row.proposed_terms ?? [],
    clarifications: row.clarifications ?? [],
    clarityScore: Number(row.clarity_score),
    status: required(row, 'status'),
    createdBy: required(row, 'created_by'),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : required(row, 'created_at'),
    ...(row.reviewed_by ? { reviewedBy: String(row.reviewed_by) } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : String(row.reviewed_at) } : {}),
    ...(row.converted_agreement_id ? { convertedAgreementId: String(row.converted_agreement_id) } : {}),
  };
}

export const AGREEMENT_INTAKE_RELATION: AgreementIntakeRelation = Object.freeze({
  collection: 'agreementIntakes',
  table: 'agreement_intakes',
  appendOnly: false,
  async list(sql) {
    const rows = await sql<Row[]>`
      SELECT id, workspace_id, source_type, source_artifact_ids, source_hash, proposed_terms,
             clarifications, clarity_score, status, created_by, created_at, reviewed_by, reviewed_at,
             converted_agreement_id
      FROM agreement_intakes
      ORDER BY created_at ASC, id ASC
    `;
    return rows.map(rowToRecord);
  },
  async insert(sql, record, tenantId) {
    await sql`
      INSERT INTO agreement_intakes
        (id, tenant_id, workspace_id, source_type, source_artifact_ids, source_hash, proposed_terms,
         clarifications, clarity_score, status, created_by, created_at, reviewed_by, reviewed_at,
         converted_agreement_id)
      VALUES (
        ${required(record, 'id')}, ${tenantId}, ${required(record, 'workspaceId')},
        ${required(record, 'sourceType')}, ${sql.json((record.sourceArtifactIds ?? []) as never)},
        ${required(record, 'sourceHash')}, ${sql.json((record.proposedTerms ?? []) as never)},
        ${sql.json((record.clarifications ?? []) as never)}, ${number(record, 'clarityScore')},
        ${required(record, 'status')}, ${required(record, 'createdBy')}, ${required(record, 'createdAt')},
        ${(record.reviewedBy as string | undefined) ?? null}, ${(record.reviewedAt as string | undefined) ?? null},
        ${(record.convertedAgreementId as string | undefined) ?? null}
      )
    `;
  },
  async update(sql, record) {
    const rows = await sql<Row[]>`
      UPDATE agreement_intakes
      SET proposed_terms = ${sql.json((record.proposedTerms ?? []) as never)},
          clarifications = ${sql.json((record.clarifications ?? []) as never)},
          clarity_score = ${number(record, 'clarityScore')},
          status = ${required(record, 'status')},
          reviewed_by = ${(record.reviewedBy as string | undefined) ?? null},
          reviewed_at = ${(record.reviewedAt as string | undefined) ?? null},
          converted_agreement_id = ${(record.convertedAgreementId as string | undefined) ?? null}
      WHERE id = ${required(record, 'id')}
      RETURNING id
    `;
    return rows.length;
  },
});

export function isAgreementIntakeCollection(collection: string): collection is 'agreementIntakes' {
  return collection === 'agreementIntakes';
}

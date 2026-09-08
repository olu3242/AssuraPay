import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  BATCH_A_TABLES,
  BATCH_B_TABLES,
  BATCH_C_TABLES,
  BATCH_D_TABLES,
  BATCH_E_TABLES,
  BATCH_F_TABLES,
  BATCH_G_TABLES,
  BATCH_H_TABLES,
  BATCH_I_TABLES,
  BATCH_K_TABLES,
  BATCH_L_TABLES,
  BATCH_M_TABLES,
} from '@assurapay/domain-contracts';
import type { SqlClient } from './postgres-client';

const MIGRATION_LOCK_KEY = 0x41535355;

export type MigrationFile = {
  id: string;
  ordinal: number;
  path: string;
  sql: string;
  checksum: string;
};

export type MigrationOutcome = {
  id: string;
  applied: boolean;
  skippedReason?: 'ALREADY_APPLIED';
  executionMs: number;
};

export type MigrationErrorCode =
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_LEDGER_UNAVAILABLE'
  | 'MIGRATION_LOCK_UNAVAILABLE'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_DIRECTORY_EMPTY'
  | 'MIGRATION_ORDER_AMBIGUOUS';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly migrationId?: string;

  constructor(code: MigrationErrorCode, detail: string, migrationId?: string) {
    super(`${code}: ${detail}`);
    this.name = 'MigrationError';
    this.code = code;
    this.migrationId = migrationId;
  }
}

export function readMigrations(directory: string): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (names.length === 0) throw new MigrationError('MIGRATION_DIRECTORY_EMPTY', directory);

  const prefixes = new Set<string>();
  return names.map((name, index) => {
    const prefix = name.split('_')[0];
    if (prefixes.has(prefix))
      throw new MigrationError(
        'MIGRATION_ORDER_AMBIGUOUS',
        `two migrations share the prefix ${prefix}`,
        name,
      );
    prefixes.add(prefix);
    const absolute = path.join(directory, name);
    const sql = readFileSync(absolute, 'utf8');
    return {
      id: name.replace(/\.sql$/, ''),
      ordinal: index + 1,
      path: absolute,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

async function ensureLedger(sql: SqlClient): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS trust_migration_ledger (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL,
      execution_ms INTEGER NOT NULL,
      ordinal INTEGER NOT NULL
    )
  `;
}

const SUPERSEDED_CHECKSUMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    '202608110003_wave5_close_batch_c_gaps',
    new Set(['559945007a0218166da75d1e5dcca9b75f4f55a44188591055d37f37bbd1430e']),
  ],
]);

type LedgerRow = { migration_id: string; checksum: string };

async function readLedger(sql: SqlClient): Promise<Map<string, string>> {
  const rows = await sql<LedgerRow[]>`SELECT migration_id, checksum FROM trust_migration_ledger`;
  return new Map(rows.map((row) => [row.migration_id, row.checksum]));
}

export async function applyMigrations(
  sql: SqlClient,
  directory: string,
  options: { appliedBy?: string } = {},
): Promise<MigrationOutcome[]> {
  const migrations = readMigrations(directory);
  const appliedBy = options.appliedBy ?? 'assurapay-migration-runner';

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      await ensureLedger(tx);
      const ledger = await readLedger(tx);
      const outcomes: MigrationOutcome[] = [];

      for (const migration of migrations) {
        const recorded = ledger.get(migration.id);
        if (recorded !== undefined) {
          if (recorded !== migration.checksum) {
            if (!SUPERSEDED_CHECKSUMS.get(migration.id)?.has(recorded))
              throw new MigrationError(
                'MIGRATION_CHECKSUM_MISMATCH',
                `${migration.id} was applied with a different checksum; add a forward corrective migration instead of editing it`,
                migration.id,
              );
            await tx`
              UPDATE trust_migration_ledger SET checksum = ${migration.checksum}
              WHERE migration_id = ${migration.id}
            `;
          }
          outcomes.push({
            id: migration.id,
            applied: false,
            skippedReason: 'ALREADY_APPLIED',
            executionMs: 0,
          });
          continue;
        }

        const started = Date.now();
        try {
          await tx.unsafe(migration.sql);
          await tx`
            INSERT INTO trust_migration_ledger (migration_id, checksum, applied_by, execution_ms, ordinal)
            VALUES (${migration.id}, ${migration.checksum}, ${appliedBy}, ${Date.now() - started}, ${migration.ordinal})
          `;
        } catch (error) {
          if (error instanceof MigrationError) throw error;
          throw new MigrationError(
            'MIGRATION_FAILED',
            `${migration.id}: ${error instanceof Error ? error.message : String(error)}`,
            migration.id,
          );
        }
        outcomes.push({ id: migration.id, applied: true, executionMs: Date.now() - started });
      }
      return outcomes;
    });
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('MIGRATION_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export const REQUIRED_TRUST_MIGRATIONS: readonly string[] = Object.freeze([
  '202608060001_trust_repository_store',
  '202608070001_trust_row_level_security',
  '202608070002_trust_audit_chain_per_tenant',
  '202608080001_trust_schema_ownership_reconciliation',
  '202608030006_execution_orchestration',
  '202608030007_completion_assurance',
  '202608090001_wave4_trust_authority',
  '202608100001_wave4_batch_a_governed_transitions',
  '202608030008_settlement_assurance',
  '202608030009_settlement_execution',
  '202608100002_wave5_batch_b_settlement_authority',
  '202608110001_wave5_batch_c_settlement_ledger',
  '202608110002_wave5_batch_d_dispute_linkage',
  '202608110003_wave5_close_batch_c_gaps',
  '202608110004_wave6_batch_e_performance_blueprint',
  '202608110005_wave6_batch_f_agreement_creation',
  '202608110006_close_batch_b_invoice_number_gap',
  '202608110007_close_settlement_closure_gaps',
  '202608110008_workspace_scoped_references',
  '202608110009_wave6_batch_g_performance_readiness',
  '202608110010_tenant_scoped_unique_keys',
  '202608110011_wave6_batch_h_governance_core',
  '202608110012_wave6_batch_i_agreement_intelligence',
  '202608110013_workspace_slug_is_tenant_scoped',
  '202608110014_wave6_batch_k_enterprise_intelligence',
  '202608110015_wave6_batch_l_enterprise_analytics',
  '202608110016_retire_trust_compatibility_tables',
  '202608110017_wave6_batch_m_agent_runtime',
  '202608110018_money_columns_refuse_fractional_amounts',
  '202608110019_retire_dead_legacy_tables',
  '202608110020_identity_plane_is_reachable_without_a_tenant',
  '202608110021_trust_memberships_carry_their_tenant',
  '202608110022_membership_discovery_precedes_tenant_scope',
  '202609070001_agentic_persona_profiles_relational',
  '202609070002_agentic_persona_profiles_direct',
]);

export type SchemaCompatibility = {
  compatible: boolean;
  pending: string[];
  pendingRequired: string[];
  divergent: string[];
  missingTables: string[];
};

export const REQUIRED_TRUST_TABLES = Object.freeze([
  'persona_agent_profiles',
  'trust_audit_records',
  'trust_bootstrap_state',
  'trust_idempotency_keys',
  'trust_memberships',
  'trust_migration_ledger',
  'trust_outbox_events',
  'trust_permission_grants',
  'trust_records',
  'trust_tenants',
  'trust_workspaces',
]);

export const REQUIRED_DOMAIN_AGGREGATE_TABLES = Object.freeze(
  [
    ...BATCH_A_TABLES,
    ...BATCH_B_TABLES,
    ...BATCH_C_TABLES,
    ...BATCH_D_TABLES,
    ...BATCH_E_TABLES,
    ...BATCH_F_TABLES,
    ...BATCH_G_TABLES,
    ...BATCH_H_TABLES,
    ...BATCH_I_TABLES,
    ...BATCH_K_TABLES,
    ...BATCH_L_TABLES,
    ...BATCH_M_TABLES,
  ].sort(),
);

export const REQUIRED_STORE_TABLES = Object.freeze(
  [...REQUIRED_TRUST_TABLES, ...REQUIRED_DOMAIN_AGGREGATE_TABLES].sort(),
);

export async function verifySchemaCompatibility(
  sql: SqlClient,
  directory: string,
): Promise<SchemaCompatibility> {
  const migrations = readMigrations(directory);
  let ledger: Map<string, string>;
  try {
    ledger = await readLedger(sql);
  } catch {
    return {
      compatible: false,
      pending: migrations.map((migration) => migration.id),
      pendingRequired: [...REQUIRED_TRUST_MIGRATIONS],
      divergent: [],
      missingTables: [...REQUIRED_STORE_TABLES],
    };
  }

  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const pending = migrations.filter((migration) => !ledger.has(migration.id)).map((migration) => migration.id);
  const divergent: string[] = [];
  for (const [id, checksum] of ledger) {
    const migration = byId.get(id);
    if (!migration || migration.checksum !== checksum) divergent.push(id);
  }

  const present = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
  `;
  const names = new Set(present.map((row) => row.table_name));
  const missingTables = REQUIRED_STORE_TABLES.filter((table) => !names.has(table));
  const pendingRequired = REQUIRED_TRUST_MIGRATIONS.filter((id) => !ledger.has(id));

  return {
    compatible: pendingRequired.length === 0 && divergent.length === 0 && missingTables.length === 0,
    pending,
    pendingRequired,
    divergent: divergent.sort(),
    missingTables,
  };
}

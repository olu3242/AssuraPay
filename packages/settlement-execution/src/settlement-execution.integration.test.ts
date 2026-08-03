import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 10 settlement execution migration', () => {
  it('defines all engine tables, RLS, immutable records and non-custody idempotency constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030009_settlement_execution.sql'), 'utf8');
    for (const table of [
      'approval_thresholds',
      'authorization_decisions',
      'financial_approval_decisions',
      'payment_instructions',
      'ledger_entries',
      'reconciliation_records',
      'disputes',
      'dispute_holds',
      'final_settlement_accounts',
      'financial_closure_certificates',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('idempotency_key');
    expect(sql).toContain('canonical_hash');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

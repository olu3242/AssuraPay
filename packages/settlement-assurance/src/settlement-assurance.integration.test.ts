import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 9 settlement assurance migration', () => {
  it('defines all engine tables, RLS, immutable records and non-custody reference constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030008_settlement_assurance.sql'), 'utf8');
    for (const table of [
      'payment_eligibilities',
      'financial_entitlements',
      'invoices',
      'funding_commitments',
      'fund_reservations',
      'release_requests',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('external_custody_reference');
    expect(sql).toContain('net_payable_amount_minor');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

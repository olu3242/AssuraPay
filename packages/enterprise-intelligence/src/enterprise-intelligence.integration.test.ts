import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 11 enterprise intelligence migration', () => {
  it('defines all engine tables, RLS, immutable records and governed-forecast constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030010_enterprise_intelligence.sql'), 'utf8');
    for (const table of [
      'execution_assurance_indices',
      'settlement_assurance_indices',
      'kpi_definitions',
      'kpi_values',
      'dashboard_snapshots',
      'execution_forecasts',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('confidence');
    expect(sql).toContain('mandatory_gates');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 6 performance readiness migration', () => {
  it('defines all engine tables, RLS, immutable records and allocation/gate constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030005_performance_readiness.sql'), 'utf8');
    for (const table of [
      'acceptance_criteria',
      'success_metrics',
      'dependencies',
      'payment_trigger_rules',
      'performance_baselines',
      'baseline_variances',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('weight_percent');
    expect(sql).toContain('required_acceptance_criterion_ids');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

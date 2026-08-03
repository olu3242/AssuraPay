import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 12 enterprise analytics migration', () => {
  it('defines all engine tables, RLS, immutable records and governance constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030011_enterprise_analytics.sql'), 'utf8');
    for (const table of [
      'financial_forecasts',
      'performance_scorecards',
      'portfolio_snapshots',
      'renewal_assessments',
      'model_registrations',
      'evaluation_records',
      'drift_alerts',
      'model_feedback',
      'recommendations',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('confidence');
    expect(sql).toContain('concentration_top_party_percent');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 7 execution orchestration migration', () => {
  it('defines all engine tables, RLS, immutable records and gate/mandatory constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030006_execution_orchestration.sql'), 'utf8');
    for (const table of [
      'execution_workspaces',
      'work_items',
      'progress_records',
      'evidence_requirements',
      'evidence_packages',
      'validation_tests',
      'quality_plans',
      'defects',
      'quality_gate_results',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('chain_of_custody');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

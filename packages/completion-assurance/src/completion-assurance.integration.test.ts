import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 8 completion assurance migration', () => {
  it('defines all engine tables, RLS, immutable records and gate constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030007_completion_assurance.sql'), 'utf8');
    for (const table of [
      'inspections',
      'issue_records',
      'corrective_action_plans',
      'change_requests',
      'change_approvals',
      'acceptance_decisions',
      'completion_certificates',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('canonical_hash');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

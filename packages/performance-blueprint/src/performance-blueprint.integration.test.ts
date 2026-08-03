import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integration Batch 5 performance blueprint migration', () => {
  it('defines all engine tables, RLS, immutable records and gate integrity constraints', () => {
    const sql = readFileSync(resolve('supabase/migrations/202608030004_performance_blueprint.sql'), 'utf8');
    for (const table of [
      'performance_blueprints',
      'scope_items',
      'deliverables',
      'blueprint_milestones',
      'milestone_sequence_edges',
      'dod_packages',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('value_allocation_percent');
    expect(sql).toContain('deliverable_gate_ids');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

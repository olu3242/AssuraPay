import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
describe('integration Batch 5 performance blueprint migration', () => {
  it('defines five workspace-isolated immutable planning boundaries', () => {
    const sql = readFileSync(
      resolve('supabase/migrations/202608030004_performance_blueprint.sql'),
      'utf8',
    );
    for (const t of [
      'performance_blueprints',
      'scope_definitions',
      'blueprint_deliverables',
      'planned_milestones',
      'blueprint_definitions_of_done',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${t}`);
    expect(sql).toContain('agreement_intelligence_versions');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
  });
});

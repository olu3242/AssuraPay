import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
describe('integration Batch 3 migration contract', () => {
  it('defines tenant RLS, immutable agreement history and all five persistence boundaries', () => {
    const sql = readFileSync(
      resolve('supabase/migrations/202608030002_agreement_creation.sql'),
      'utf8',
    );
    for (const table of [
      'agreements_v2',
      'contract_template_versions',
      'agreement_document_versions',
      'clause_versions_v2',
      'negotiation_rounds',
      'approval_policies_v2',
      'agreement_approval_requests',
      'agreement_approval_decisions',
      'signature_packages_v2',
      'agreement_execution_certificates',
    ])
      expect(sql).toContain(`TABLE IF NOT EXISTS ${table}`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('prevent_append_only_mutation');
    expect(sql).toContain('current_workspace_id()');
  });
});

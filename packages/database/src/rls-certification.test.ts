import { describe, expect, it } from 'vitest';
import {
  AGENTIC_RLS_GOVERNED_TABLES,
  RLS_GOVERNED_TABLES,
  quoteIdentifier,
} from './rls-certification';

describe('quoteIdentifier is what the unsafe-SQL allowlist rests on', () => {
  it('quotes a bare identifier', () => {
    expect(quoteIdentifier('assurapay_app')).toBe('"assurapay_app"');
    expect(quoteIdentifier('trust_audit_records')).toBe('"trust_audit_records"');
  });

  it('refuses anything that could terminate the identifier or add a statement', () => {
    for (const attempt of [
      'app"; DROP TABLE trust_audit_records; --',
      'app role',
      'app-role',
      'app;',
      "app'",
      '"app"',
      '1app',
      '',
      'app.role',
    ])
      expect(() => quoteIdentifier(attempt), attempt).toThrow('RLS_IDENTIFIER_INVALID');
  });

  it('reports the rejected value so a misconfiguration is diagnosable', () => {
    expect(() => quoteIdentifier('bad name')).toThrow('"bad name"');
  });
});

describe('the governed table registries', () => {
  it('names every trust-core table that carries tenant/workspace scope', () => {
    for (const table of [
      'trust_tenants',
      'trust_workspaces',
      'trust_memberships',
      'trust_permission_grants',
      'trust_bootstrap_state',
      'trust_audit_records',
      'trust_outbox_events',
      'trust_idempotency_keys',
      'trust_records',
    ])
      expect(RLS_GOVERNED_TABLES, table).toContain(table);
  });

  it('registers persona-agent governance in the same deployment certification capability', () => {
    expect(AGENTIC_RLS_GOVERNED_TABLES).toContain('persona_agent_profiles');
  });

  it('excludes the migration ledger, which has no tenant', () => {
    expect(RLS_GOVERNED_TABLES).not.toContain('trust_migration_ledger');
    expect(AGENTIC_RLS_GOVERNED_TABLES).not.toContain('trust_migration_ledger');
  });

  it('lists each table once across the two registries', () => {
    const all = [...RLS_GOVERNED_TABLES, ...AGENTIC_RLS_GOVERNED_TABLES];
    expect(all.sort()).toEqual([...new Set(all)].sort());
  });
});

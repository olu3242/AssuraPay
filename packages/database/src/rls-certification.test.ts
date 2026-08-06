import { describe, expect, it } from 'vitest';
import { RLS_GOVERNED_TABLES, quoteIdentifier } from './rls-certification';

/**
 * The parts of RLS certification that need no database.
 *
 * `quoteIdentifier` is what makes this module's `sql.unsafe` calls safe. PostgreSQL cannot
 * bind an identifier — `SET LOCAL ROLE $1` is not valid SQL — so a role or table name has to
 * be interpolated, and the architecture rule that forbids unparameterized SQL allowlists this
 * module on the strength of that guard. An allowlist justified by a function nothing tests is
 * an allowlist justified by nothing.
 */

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
    // A role name is configuration, not a secret — unlike a connection string, quoting it
    // back tells an operator which value to fix.
    expect(() => quoteIdentifier('bad name')).toThrow('"bad name"');
  });
});

describe('the governed table list', () => {
  it('names every trust table that carries tenant or workspace scope', () => {
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

  it('excludes the migration ledger, which has no tenant', () => {
    // Forcing a policy onto it would either deny the runner its own ledger or need a policy
    // that permits everything — which teaches a reader that these policies are decorative.
    expect(RLS_GOVERNED_TABLES).not.toContain('trust_migration_ledger');
  });

  it('lists each table once', () => {
    expect([...RLS_GOVERNED_TABLES].sort()).toEqual([...new Set(RLS_GOVERNED_TABLES)].sort());
  });
});

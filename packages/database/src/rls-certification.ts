import type { SqlClient } from './postgres-client';

export type RlsFindingCode =
  | 'RLS_DISABLED'
  | 'RLS_NOT_FORCED'
  | 'RLS_NO_POLICY'
  | 'RLS_OWNER_BYPASS'
  | 'RLS_CROSS_TENANT_READ'
  | 'RLS_CROSS_WORKSPACE_READ'
  | 'RLS_UNSCOPED_READ'
  | 'RLS_CROSS_TENANT_WRITE'
  | 'RLS_ROLE_BYPASSES'
  | 'RLS_PROBE_ROLE_UNAVAILABLE';

export type RlsFinding = { code: RlsFindingCode; table?: string; detail: string };
export type RlsCertification = { certified: boolean; checkedTables: string[]; findings: RlsFinding[] };

export const RLS_GOVERNED_TABLES: readonly string[] = Object.freeze([
  'persona_agent_profiles',
  'trust_audit_records',
  'trust_tenants',
  'trust_bootstrap_state',
  'trust_idempotency_keys',
  'trust_memberships',
  'trust_outbox_events',
  'trust_permission_grants',
  'trust_records',
  'trust_workspaces',
]);

type RlsFlagRow = { relname: string; enabled: boolean; forced: boolean };
type PolicyRow = { tablename: string; policyname: string };

export async function readRlsState(sql: SqlClient, schema: string) {
  const flagRows = await sql<RlsFlagRow[]>`
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind = 'r'
  `;
  const policyRows = await sql<PolicyRow[]>`
    SELECT tablename, policyname FROM pg_policies WHERE schemaname = ${schema}
  `;
  const flags = new Map(flagRows.map((row) => [row.relname, { enabled: row.enabled, forced: row.forced }]));
  const policies = new Map<string, string[]>();
  for (const row of policyRows) policies.set(row.tablename, [...(policies.get(row.tablename) ?? []), row.policyname]);
  return { flags, policies };
}

export type RlsProbeContext = { role: string; tenantId: string; workspaceId: string; actorId: string };

export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error(`RLS_IDENTIFIER_INVALID: "${value}"`);
  return `"${value}"`;
}

async function applyProbeRole(sql: SqlClient, context: RlsProbeContext): Promise<void> {
  await sql.unsafe(`SET LOCAL ROLE ${quoteIdentifier(context.role)}`);
  await sql`SELECT set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.workspace_id', ${context.workspaceId}, true), set_config('app.actor_id', ${context.actorId}, true)`;
}

export async function assertRoleCannotBypass(sql: SqlClient, role: string): Promise<RlsFinding[]> {
  const [row] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${role}`;
  if (!row) return [{ code: 'RLS_PROBE_ROLE_UNAVAILABLE', detail: `probe role ${role} does not exist` }];
  if (row.rolsuper || row.rolbypassrls) return [{ code: 'RLS_ROLE_BYPASSES', detail: `probe role ${role} bypasses row-level security` }];
  return [];
}

export async function assertConnectedRoleCannotBypass(sql: SqlClient): Promise<RlsFinding[]> {
  const [row] = await sql<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (row?.rolsuper || row?.rolbypassrls)
    return [{ code: 'RLS_OWNER_BYPASS', detail: `connected role ${row.current_user} bypasses row-level security` }];
  return [];
}

export async function assertCrossTenantDenied(
  sql: SqlClient,
  context: RlsProbeContext,
  foreign: { tenantId: string; workspaceId: string },
): Promise<RlsFinding[]> {
  const findings: RlsFinding[] = [];
  await sql.begin(async (tx) => {
    await applyProbeRole(tx, context);
    const [own] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_workspaces WHERE workspace_id = ${context.workspaceId}`;
    if (own.n === '0') findings.push({ code: 'RLS_CROSS_TENANT_READ', table: 'trust_workspaces', detail: 'the policy hides the caller’s own workspace' });
    const [crossed] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_workspaces WHERE workspace_id = ${foreign.workspaceId}`;
    if (crossed.n !== '0') findings.push({ code: 'RLS_CROSS_TENANT_READ', table: 'trust_workspaces', detail: 'a caller read another tenant workspace' });
    const [grants] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_permission_grants WHERE workspace_id = ${foreign.workspaceId}`;
    if (grants.n !== '0') findings.push({ code: 'RLS_CROSS_TENANT_READ', table: 'trust_permission_grants', detail: 'a caller read another tenant permission grants' });
    const [audits] = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_audit_records WHERE workspace_id = ${foreign.workspaceId}`;
    if (audits.n !== '0') findings.push({ code: 'RLS_CROSS_TENANT_READ', table: 'trust_audit_records', detail: 'a caller read another tenant audit history' });
    const [personaProfiles] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM persona_agent_profiles WHERE workspace_id = ${foreign.workspaceId}
    `;
    if (personaProfiles.n !== '0')
      findings.push({
        code: 'RLS_CROSS_TENANT_READ',
        table: 'persona_agent_profiles',
        detail: 'a caller read another tenant persona-agent governance configuration',
      });
  });
  return findings;
}

export async function assertCrossTenantWriteDenied(
  sql: SqlClient,
  context: RlsProbeContext,
  foreign: { tenantId: string; workspaceId: string },
): Promise<RlsFinding[]> {
  const refused = await sql.begin(async (tx) => {
    await applyProbeRole(tx, context);
    await tx`INSERT INTO trust_records (collection, record_id, tenant_id, workspace_id, payload, payload_digest)
             VALUES ('parties', 'planted-by-another-tenant', ${foreign.tenantId}, ${foreign.workspaceId}, '{}', 'digest')`;
    return false;
  }).catch(() => true);
  return refused ? [] : [{ code: 'RLS_CROSS_TENANT_WRITE', table: 'trust_records', detail: 'a caller inserted a row attributed to another tenant' }];
}

export async function assertUnscopedReadDenied(sql: SqlClient, role: string): Promise<RlsFinding[]> {
  const findings: RlsFinding[] = [];
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
    await tx`SELECT set_config('app.tenant_id', '', true), set_config('app.workspace_id', '', true), set_config('app.actor_id', '', true)`;
    const queries: Record<string, string> = {
      persona_agent_profiles: 'SELECT count(*)::text AS n FROM persona_agent_profiles',
      trust_workspaces: 'SELECT count(*)::text AS n FROM trust_workspaces',
      trust_permission_grants: 'SELECT count(*)::text AS n FROM trust_permission_grants',
      trust_audit_records: 'SELECT count(*)::text AS n FROM trust_audit_records WHERE tenant_id IS NOT NULL',
    };
    for (const [table, query] of Object.entries(queries)) {
      const rows = await tx.unsafe<Array<{ n: string }>>(query);
      if (rows[0]?.n !== '0') findings.push({ code: 'RLS_UNSCOPED_READ', table, detail: 'an unscoped application caller read governed rows' });
    }
  });
  return findings;
}

export async function certifyRowLevelSecurity(
  sql: SqlClient,
  options: {
    schema: string;
    probe?: { context: RlsProbeContext; foreign: { tenantId: string; workspaceId: string } };
    tables?: readonly string[];
  },
): Promise<RlsCertification> {
  const tables = [...(options.tables ?? RLS_GOVERNED_TABLES)];
  const findings: RlsFinding[] = [];
  const state = await readRlsState(sql, options.schema);
  for (const table of tables) {
    const flags = state.flags.get(table);
    if (!flags) continue;
    if (!flags.enabled) findings.push({ code: 'RLS_DISABLED', table, detail: `${table} does not have row-level security enabled` });
    else if (!flags.forced) findings.push({ code: 'RLS_NOT_FORCED', table, detail: `${table} does not force row-level security` });
    if ((state.policies.get(table) ?? []).length === 0) findings.push({ code: 'RLS_NO_POLICY', table, detail: `${table} has no row-level security policy` });
  }
  if (options.probe) {
    findings.push(...(await assertRoleCannotBypass(sql, options.probe.context.role)));
    findings.push(...(await assertConnectedRoleCannotBypass(sql));
    findings.push(...(await assertUnscopedReadDenied(sql, options.probe.context.role)));
    findings.push(...(await assertCrossTenantDenied(sql, options.probe.context, options.probe.foreign)));
    findings.push(...(await assertCrossTenantWriteDenied(sql, options.probe.context, options.probe.foreign)));
  }
  return { certified: findings.length === 0, checkedTables: tables.filter((table) => state.flags.has(table)), findings };
}

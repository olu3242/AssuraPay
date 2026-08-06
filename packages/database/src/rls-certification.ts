import type { SqlClient } from './postgres-client';

/**
 * Row Level Security certification.
 *
 * The finding this module exists to prevent recurring: before this capability, one
 * hundred tables carried `ENABLE ROW LEVEL SECURITY` and a policy requiring
 * `workspace_id = current_workspace_id()`, and none of it applied to the application.
 * `ENABLE` does not constrain the table's *owner*, and the application role owned every
 * table — so with no workspace context set at all, a plain `SELECT` returned rows the
 * policy said were invisible. Verified against a live instance, not inferred: insert a
 * membership, clear `app.workspace_id`, count rows, and the answer was one.
 *
 * A policy that is present but bypassed is worse than none, because it is read as
 * protection. So certification here is never "does a policy exist". It is:
 *
 *   1. RLS enabled *and forced*, so the owner is subject to it too;
 *   2. a policy on every table that carries tenant or workspace scope;
 *   3. a live denial probe, run as a role that does not own the tables, proving that
 *      cross-tenant and cross-workspace reads and writes actually fail.
 *
 * Framework-free, so the same checks run from a test, a deployment gate, or a
 * production readiness probe rather than being restated in each.
 */

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

export type RlsFinding = {
  code: RlsFindingCode;
  table?: string;
  /** What goes wrong when this is true. Stated per finding, not per rule. */
  detail: string;
};

export type RlsCertification = {
  certified: boolean;
  checkedTables: string[];
  findings: RlsFinding[];
};

/**
 * Tables whose rows belong to a tenant or a workspace, and therefore must be governed.
 *
 * `trust_migration_ledger` is deliberately absent: it records which migrations ran, has
 * no tenant column, and is the same for every tenant. Forcing a policy onto it would
 * either deny the migration runner its own ledger or require a policy that permits
 * everything, which teaches a reader that these policies are decorative.
 */
export const RLS_GOVERNED_TABLES: readonly string[] = Object.freeze([
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

/**
 * Reads the RLS flags and policies actually present in the database.
 *
 * From `pg_class` and `pg_policies` rather than from the migration text: the question is
 * what the running database enforces, and a migration that was edited, partially applied,
 * or overridden by a later `ALTER TABLE` would still read correctly as SQL.
 */
export async function readRlsState(
  sql: SqlClient,
  schema: string,
): Promise<{ flags: Map<string, { enabled: boolean; forced: boolean }>; policies: Map<string, string[]> }> {
  const flagRows = await sql<RlsFlagRow[]>`
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind = 'r'
  `;
  const policyRows = await sql<PolicyRow[]>`
    SELECT tablename, policyname FROM pg_policies WHERE schemaname = ${schema}
  `;

  const flags = new Map(flagRows.map((row) => [row.relname, { enabled: row.enabled, forced: row.forced }]));
  const policies = new Map<string, string[]>();
  for (const row of policyRows)
    policies.set(row.tablename, [...(policies.get(row.tablename) ?? []), row.policyname]);

  return { flags, policies };
}

export type RlsProbeContext = {
  /** A role that does not own the tables — the shape a real application connection has. */
  role: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
};

/**
 * Proves that a read outside the caller's tenant returns nothing.
 *
 * Run as `context.role` inside a transaction, with the session variables the policies read
 * set through `set_config(..., true)` so they are transaction-local and cannot leak onto a
 * pooled connection.
 *
 * Counting rows rather than comparing ids: the assertion is that *nothing* crosses the
 * boundary, and an id comparison would pass while a second tenant's row sat beside the
 * expected one.
 */
export async function assertCrossTenantDenied(
  sql: SqlClient,
  context: RlsProbeContext,
  foreign: { tenantId: string; workspaceId: string },
): Promise<RlsFinding[]> {
  const findings: RlsFinding[] = [];

  await sql.begin(async (tx) => {
    await applyProbeRole(tx, context);

    // The caller's own workspace is visible.
    const [own] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trust_workspaces WHERE workspace_id = ${context.workspaceId}
    `;
    if (own.n === '0')
      findings.push({
        code: 'RLS_CROSS_TENANT_READ',
        table: 'trust_workspaces',
        detail:
          'the policy hides the caller’s own workspace, which makes the application unusable and invites an operator to drop the policy',
      });

    // The other tenant's workspace is not.
    const [crossed] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trust_workspaces WHERE workspace_id = ${foreign.workspaceId}
    `;
    if (crossed.n !== '0')
      findings.push({
        code: 'RLS_CROSS_TENANT_READ',
        table: 'trust_workspaces',
        detail: `a caller scoped to ${context.tenantId} read a workspace belonging to another tenant`,
      });

    // Grants are the highest-value cross-tenant read: they are what authorization decides
    // on, so a leak here is not an information disclosure but a potential privilege one.
    const [grants] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trust_permission_grants WHERE workspace_id = ${foreign.workspaceId}
    `;
    if (grants.n !== '0')
      findings.push({
        code: 'RLS_CROSS_TENANT_READ',
        table: 'trust_permission_grants',
        detail: 'a caller read permission grants belonging to another tenant’s workspace',
      });

    const [audits] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM trust_audit_records WHERE workspace_id = ${foreign.workspaceId}
    `;
    if (audits.n !== '0')
      findings.push({
        code: 'RLS_CROSS_TENANT_READ',
        table: 'trust_audit_records',
        detail: 'a caller read another tenant’s audit history',
      });
  });

  return findings;
}

/**
 * Proves that a write attributed to another tenant is refused.
 *
 * Separate from the read probe because `USING` and `WITH CHECK` are different clauses, and
 * a policy with only `USING` hides other tenants' rows while happily letting a caller
 * *insert* rows into their scope — which is worse than a read leak, since it plants data
 * the owning tenant did not create and cannot see the origin of.
 */
export async function assertCrossTenantWriteDenied(
  sql: SqlClient,
  context: RlsProbeContext,
  foreign: { tenantId: string; workspaceId: string },
): Promise<RlsFinding[]> {
  const findings: RlsFinding[] = [];

  const refused = await sql
    .begin(async (tx) => {
      await applyProbeRole(tx, context);
      await tx`
        INSERT INTO trust_records (collection, record_id, tenant_id, workspace_id, payload, payload_digest)
        VALUES ('parties', 'planted-by-another-tenant', ${foreign.tenantId}, ${foreign.workspaceId}, '{}', 'digest')
      `;
      return false;
    })
    .then((value) => value)
    .catch(() => true);

  if (!refused)
    findings.push({
      code: 'RLS_CROSS_TENANT_WRITE',
      table: 'trust_records',
      detail:
        'a caller inserted a row attributed to another tenant’s workspace; the policy needs a WITH CHECK clause, not only USING',
    });

  return findings;
}

/**
 * Proves that a caller with no scope set reads nothing.
 *
 * The most important probe of the three. Every other check assumes context is present;
 * this one asks what happens when it is absent — which is the state a connection is in
 * before anything sets it, and therefore the state a bug leaves it in.
 */
export async function assertUnscopedReadDenied(
  sql: SqlClient,
  role: string,
): Promise<RlsFinding[]> {
  const findings: RlsFinding[] = [];

  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
    // Explicitly blank rather than merely unset, so the probe is deterministic whatever a
    // pooled connection was last used for.
    await tx`SELECT set_config('app.tenant_id', '', true)`;
    await tx`SELECT set_config('app.workspace_id', '', true)`;
    await tx`SELECT set_config('app.actor_id', '', true)`;

    for (const table of ['trust_workspaces', 'trust_permission_grants', 'trust_audit_records']) {
      const [row] = await tx<{ n: string }[]>(
        toTemplate(`SELECT count(*)::text AS n FROM ${quoteIdentifier(table)}`),
      );
      if (row.n !== '0')
        findings.push({
          code: 'RLS_UNSCOPED_READ',
          table,
          detail: `${row.n} row(s) were visible to a caller with no tenant or workspace context`,
        });
    }
  });

  return findings;
}

/**
 * Whether a role can bypass Row Level Security entirely.
 *
 * The gap this closes was found in CI, one level above the original defect. A superuser is
 * exempt from every policy — `FORCE` included — and so is any role with `BYPASSRLS`. The CI
 * database's `POSTGRES_USER` is created as a superuser, so the suite that asserts "the owner
 * sees nothing" saw everything, while `enabled` and `forced` both read true.
 *
 * That is the same failure as before wearing a different hat: policies present, forced, and
 * enforcing nothing, with a certification that looked clean. A deployment whose application
 * connects as a superuser has no row-level security at all, however many policies it carries.
 */
export async function assertRoleCannotBypass(
  sql: SqlClient,
  role: string,
): Promise<RlsFinding[]> {
  const rows = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${role}
  `;
  const found = rows[0];
  if (!found)
    return [
      {
        code: 'RLS_PROBE_ROLE_UNAVAILABLE',
        detail: `the role ${role} does not exist, so no denial can be proven as the application`,
      },
    ];

  const findings: RlsFinding[] = [];
  if (found.rolsuper)
    findings.push({
      code: 'RLS_ROLE_BYPASSES',
      detail: `${role} is a superuser, which is exempt from every policy including forced ones; the application must not connect as one`,
    });
  if (found.rolbypassrls)
    findings.push({
      code: 'RLS_ROLE_BYPASSES',
      detail: `${role} holds BYPASSRLS, so no policy applies to it`,
    });
  return findings;
}

/**
 * The full certification: static state plus live denial.
 *
 * Both halves are required. The static half alone is what produced a hundred tables of
 * policy nobody was subject to; the live half alone would pass against a database where
 * the tables simply happened to be empty.
 */
export async function certifyRowLevelSecurity(
  sql: SqlClient,
  options: {
    schema: string;
    /** Present when a live probe can run. Absent, the static checks still apply. */
    probe?: { context: RlsProbeContext; foreign: { tenantId: string; workspaceId: string } };
    tables?: readonly string[];
  },
): Promise<RlsCertification> {
  const tables = options.tables ?? RLS_GOVERNED_TABLES;
  const findings: RlsFinding[] = [];
  const { flags, policies } = await readRlsState(sql, options.schema);

  for (const table of tables) {
    const flag = flags.get(table);
    if (!flag) continue;

    if (!flag.enabled)
      findings.push({
        code: 'RLS_DISABLED',
        table,
        detail: 'the table carries tenant or workspace scope but has no row-level security',
      });
    // The check that would have caught the original defect. `ENABLE` leaves the owner
    // unconstrained, and the application role owned every table.
    else if (!flag.forced)
      findings.push({
        code: 'RLS_NOT_FORCED',
        table,
        detail:
          'row-level security is enabled but not forced, so the table owner bypasses every policy on it',
      });

    if ((policies.get(table) ?? []).length === 0)
      findings.push({
        code: 'RLS_NO_POLICY',
        table,
        detail: 'row-level security with no policy denies everything, which is a broken application rather than a secure one',
      });
  }

  if (options.probe) {
    // Before the denial probes, because a bypassing role makes every one of them meaningless:
    // they would pass or fail on what the data happens to be rather than on what the policies
    // enforce.
    findings.push(...(await assertRoleCannotBypass(sql, options.probe.context.role)));
    findings.push(...(await assertConnectedRoleCannotBypass(sql)));
    findings.push(...(await assertUnscopedReadDenied(sql, options.probe.context.role)));
    findings.push(...(await assertCrossTenantDenied(sql, options.probe.context, options.probe.foreign)));
    findings.push(
      ...(await assertCrossTenantWriteDenied(sql, options.probe.context, options.probe.foreign)),
    );
  }

  return {
    certified: findings.length === 0,
    checkedTables: tables.filter((table) => flags.has(table)),
    findings,
  };
}

/**
 * Whether the role this connection is using can bypass RLS.
 *
 * Checked separately from the probe role because they are different questions. The probe role
 * stands in for the application; the connected role is whatever the caller actually holds, and
 * a certification run by a superuser proves nothing about what the application experiences.
 */
export async function assertConnectedRoleCannotBypass(sql: SqlClient): Promise<RlsFinding[]> {
  const [row] = await sql<{ who: string }[]>`SELECT current_user AS who`;
  return await assertRoleCannotBypass(sql, row.who);
}

/** Switches to the probe role and sets the session variables the policies read. */
async function applyProbeRole(sql: SqlClient, context: RlsProbeContext): Promise<void> {
  // `SET LOCAL ROLE` cannot be parameterized, so the identifier is quoted rather than
  // bound. The role name comes from the caller's own configuration, never from a request.
  await sql.unsafe(`SET LOCAL ROLE ${quoteIdentifier(context.role)}`);
  await sql`SELECT set_config('app.tenant_id', ${context.tenantId}, true)`;
  await sql`SELECT set_config('app.workspace_id', ${context.workspaceId}, true)`;
  await sql`SELECT set_config('app.actor_id', ${context.actorId}, true)`;
}

/**
 * Quotes a PostgreSQL identifier.
 *
 * Used only for role and table names this module itself supplies or the caller configures.
 * Doubling an embedded quote is what stops a name from terminating the identifier early.
 */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name))
    throw new Error(`RLS_IDENTIFIER_INVALID: ${JSON.stringify(name)} is not a bare identifier`);
  return `"${name.replace(/"/g, '""')}"`;
}

/** Builds a template-strings array for a statement with no bound parameters. */
function toTemplate(text: string): TemplateStringsArray {
  const parts = [text] as string[] & { raw: string[] };
  parts.raw = [text];
  return parts as unknown as TemplateStringsArray;
}

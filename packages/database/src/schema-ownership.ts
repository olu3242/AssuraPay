import type { SqlClient } from './postgres-client';

/**
 * The canonical schema ownership registry, and the certification that it is true.
 *
 * The repository carried two relational models for the trust domain. The certified
 * `PostgresTrustStore` owns ten `trust_*` tables; an earlier model described the same
 * aggregates across thirty-one tables that no code has ever read or written. Both were
 * created by every migration run, so every database carried both.
 *
 * Two facts, established against a live instance rather than by reading SQL, decide what
 * this capability can honestly do.
 *
 * **There were never any dual writes.** The only production module issuing SQL against
 * data is `postgres-store.ts`, and it names seven `trust_*` tables. `FileAssuraStore`
 * contains no SQL at all — it is JSON files. Every appearance of a historical table name
 * outside `supabase/migrations` is in a test. So the historical model held no rows on any
 * database, and there is no data to migrate, no divergence to reconcile, and no dual write
 * to eliminate. Reporting migrated-row counts here would be fabrication.
 *
 * **The historical model was not uniformly removable, and now it is gone.** Three of its tables were
 * load-bearing for the then-out-of-scope Engine 06–60 relational model, and `202608080001` had to retain
 * them, each naming `persistence.domain-store-durability` as the condition that would free it:
 *
 *   - `workspaces` was recorded as the foreign-key parent of ninety-three of those tables;
 *   - `workspace_memberships` was read by `has_active_workspace_membership()`, which the RLS
 *     policies on those tables called;
 *   - `user_identities` was the foreign-key parent of `workspace_memberships`.
 *
 * PostgreSQL itself was the oracle for that closure, then and at every step since. The ninety-three was
 * never re-measured until Batch J, and it was wrong by a wide margin — Batches A–I had converged
 * seventy-seven of those tables onto `trust_workspaces` as they activated them:
 *
 *     recorded    93   (`202608080001`, never re-measured)
 *     Batch J     16   measured — 15 deferred-batch tables plus workspace_memberships
 *     Batch K     10   enterprise-intelligence converged its six
 *     Batch L      1   enterprise-analytics converged its nine
 *
 * That last one was `workspace_memberships`, which by then had no children of its own. The three
 * referenced only each other, so `202608110016` dropped all three together, along with
 * `has_active_workspace_membership()` and the superseded `current_workspace_id()`.
 *
 * Two lessons worth keeping, because both cost real work to learn. A dependant count written once and never
 * re-measured understated how close the retirement was by a factor of six, and each batch that could have
 * checked it did not. And the retirement condition as `202608080001` stated it was not sufficient: Batch J
 * retired `FileAssuraStore` — the code half of the named capability — and that freed none of these tables.
 * What freed them was activating the batches that owned the dependants. See
 * `docs/persistence/DOMAIN_STORE_RETIREMENT.md`.
 *
 * So the real risk the duplicate model posed was never corruption. It was that one hundred
 * and two of its tables carried `ENABLE ROW LEVEL SECURITY` with no `FORCE` — the exact defect
 * `persistence.rls-certification` corrected for the trust tables — so anything that *started*
 * using them would inherit a boundary that reads as protection and enforces nothing. Measured after
 * Batch L, no table in the schema carries ENABLE without FORCE.
 *
 * What this module therefore is: the single place that says which relational object owns each
 * trust aggregate, executable rather than a document, consumed by architecture validation,
 * runtime readiness and migration certification. A documentation-only ownership map would
 * drift from the database the first time either changed.
 */

/** How a relational object relates to the canonical model. */
export type ObjectDisposition =
  /** The canonical owner of an aggregate. Written by `PostgresTrustStore`. */
  | 'CANONICAL'
  /** Migration bookkeeping. Owns no domain aggregate and carries no tenant. */
  | 'INFRASTRUCTURE'
  /**
   * A trust-domain duplicate with no readers, no writers and no rows, retired by forward
   * migration. Absent after reconciliation; its presence is a finding.
   */
  | 'RETIRED'
  /**
   * A trust-domain duplicate that cannot be retired yet because the out-of-scope model
   * depends on it. Not canonical, never written by the runtime, and carrying a named
   * retirement condition rather than an indefinite reprieve.
   *
   * No object holds this disposition today: `202608110016` retired the last three. The disposition stays for
   * the next duplicate, because the discipline it encodes — a stated reason and a named capability that
   * removes it, both checked against the live database — is what eventually got these three dropped.
   */
  | 'COMPATIBILITY'
  /**
   * Engine 06–60 domain state that no relational object owned when this registry was written.
   *
   * It named `FileAssuraStore` as the owner, which Batch J removed — and Batches E through L gave every one
   * of those aggregates a canonical relational owner, so the disposition now describes only the two dead
   * legacy tables (`contracts`, `milestones`) that no engine reads or writes and no batch activated.
   */
  | 'OUT_OF_SCOPE_DOMAIN';

export type AggregateOwnership = {
  /** The domain aggregate, named as the domain names it. */
  aggregate: string;
  /** The relational object that owns it. Exactly one, always. */
  canonicalTable: string;
  /** The repository type that reads and writes it. */
  repositoryOwner: string;
  /** Whether the canonical table must carry forced Row Level Security. */
  requiresForcedRls: boolean;
  /** Objects that described the same aggregate and no longer own it. */
  supersededTables: readonly string[];
};

/**
 * One canonical owner per trust aggregate.
 *
 * `trust_records` owns several aggregates rather than one. That is not ambiguity: it is a
 * single generic record table keyed by collection, which is how `TrustPersistence` stores
 * identities, sessions, verification results and legal policy. The aggregates listed against
 * it are the collections it holds, and each still has exactly one owning table.
 */
export const TRUST_AGGREGATE_OWNERSHIP: readonly AggregateOwnership[] = Object.freeze([
  {
    aggregate: 'tenant',
    canonicalTable: 'trust_tenants',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([]),
  },
  {
    aggregate: 'workspace',
    canonicalTable: 'trust_workspaces',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    // All four retired. `workspaces` was the last to go — `202608110016`, once Batch L removed its final
    // dependant — and `organizations`, `organization_units` and `legal_entities` described the same tenancy
    // shape and went with `202608080001`.
    supersededTables: Object.freeze(['workspaces', 'organizations', 'organization_units', 'legal_entities']),
  },
  {
    aggregate: 'membership',
    canonicalTable: 'trust_memberships',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze(['workspace_memberships', 'workspace_invitations']),
  },
  {
    aggregate: 'permission-grant',
    canonicalTable: 'trust_permission_grants',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([
      'permission_grants',
      'permission_definitions',
      'role_definitions',
      'field_permissions',
      'delegations',
      'authority_rules',
      'segregation_rules',
    ]),
  },
  {
    aggregate: 'bootstrap-state',
    canonicalTable: 'trust_bootstrap_state',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([]),
  },
  {
    aggregate: 'identity-and-session',
    canonicalTable: 'trust_records',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([
      'user_identities',
      'authentication_methods',
      'user_sessions',
      'trusted_devices',
      'step_up_challenges',
    ]),
  },
  {
    aggregate: 'party-verification',
    canonicalTable: 'trust_records',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([
      'parties',
      'verification_requests',
      'verification_results',
      'beneficiary_account_references',
    ]),
  },
  {
    aggregate: 'legal-governance',
    canonicalTable: 'trust_records',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([
      'legal_policies',
      'legal_policy_versions',
      'policy_assignments',
      'policy_acceptances',
      'consent_records',
      'legal_holds',
      'signature_policies',
    ]),
  },
  {
    aggregate: 'replay-protection',
    canonicalTable: 'trust_idempotency_keys',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze([]),
  },
  {
    aggregate: 'audit-evidence',
    canonicalTable: 'trust_audit_records',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze(['audit_records']),
  },
  {
    aggregate: 'outbox',
    canonicalTable: 'trust_outbox_events',
    repositoryOwner: 'PostgresTrustStore',
    requiresForcedRls: true,
    supersededTables: Object.freeze(['event_outbox']),
  },
  {
    aggregate: 'migration-state',
    canonicalTable: 'trust_migration_ledger',
    repositoryOwner: 'applyMigrations',
    // Deliberately not forced. It carries no tenant, is identical for everyone, and a policy
    // on it would either deny the runner its own ledger or permit everything — which teaches
    // a reader that these policies are decorative.
    requiresForcedRls: false,
    supersededTables: Object.freeze([]),
  },
]);

/**
 * Trust-domain duplicates retired by forward migration.
 *
 * All twenty-eight were empty on every database, had no production reader or writer, and no
 * out-of-scope object depended on them — each verified against a live instance rather than
 * assumed. The migration re-checks emptiness at apply time and refuses rather than
 * discarding anything, so this list being wrong is a failed migration, not lost data.
 */
export const RETIRED_TRUST_HISTORICAL_TABLES: readonly string[] = Object.freeze([
  'audit_records',
  'authentication_methods',
  'authority_rules',
  'beneficiary_account_references',
  'consent_records',
  'delegations',
  'event_outbox',
  'field_permissions',
  'legal_entities',
  'legal_holds',
  'legal_policies',
  'legal_policy_versions',
  'organization_units',
  'organizations',
  'parties',
  'permission_definitions',
  'permission_grants',
  'policy_acceptances',
  'policy_assignments',
  'role_definitions',
  'segregation_rules',
  'signature_policies',
  'step_up_challenges',
  'trusted_devices',
  'user_sessions',
  'verification_requests',
  'verification_results',
  'workspace_invitations',
  // Retired by `202608110016`, twelve batches after `202608080001` had to retain them. They were the last
  // three trust-domain duplicates, and the retirement condition it named was
  // `persistence.domain-store-durability`. Batch L removed the last tables referencing them: `workspaces`
  // went from 93 recorded dependants to 16 measured (Batch J), to 10 (Batch K), to 1 (Batch L) — and that one
  // was `workspace_memberships`, which by then had no children of its own. The three referenced only each
  // other, so they dropped together.
  'user_identities',
  'workspace_memberships',
  'workspaces',
]);

export type CompatibilityObject = {
  table: string;
  /** Why it cannot be retired yet, in terms of what actually depends on it. */
  reason: string;
  /** The capability whose completion removes the dependency. Never "eventually". */
  retirementCondition: string;
};

/**
 * Trust-domain duplicates that must survive, and exactly why.
 *
 * Each is read-only as far as the trust runtime is concerned: the runtime role holds no
 * privilege on any of them, which `certifySchemaOwnership` verifies rather than trusting.
 * None is a second persistence API — no repository method targets them.
 */
export const COMPATIBILITY_OBJECTS: readonly CompatibilityObject[] = Object.freeze([
  // Empty, and deliberately kept rather than deleted along with its last entries.
  //
  // It held `workspaces`, `workspace_memberships` and `user_identities` — the three trust-domain duplicates
  // `202608080001` could not drop, each naming `persistence.domain-store-durability` as the condition that
  // would free it. `202608110016` retired all three, so they move to `RETIRED_TRUST_HISTORICAL_TABLES` above
  // and this list is empty for the first time.
  //
  // The type and the list stay because the next duplicate will need the same discipline: a table retained for
  // a stated reason, with a named capability that removes the reason, checked by `certifySchemaOwnership`
  // against what the database actually holds. That check is what caught the registry going stale the moment
  // the tables were dropped — it reported `OWNERSHIP_COMPATIBILITY_TABLE_MISSING` rather than passing, which
  // is why this list is now correct instead of merely unread.
]);

/** Canonical tables, derived rather than restated so the two cannot disagree. */
export function canonicalTables(): readonly string[] {
  return Object.freeze([...new Set(TRUST_AGGREGATE_OWNERSHIP.map((entry) => entry.canonicalTable))].sort());
}

/** Canonical tables that must carry forced Row Level Security. */
export function forcedRlsCanonicalTables(): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        TRUST_AGGREGATE_OWNERSHIP.filter((entry) => entry.requiresForcedRls).map(
          (entry) => entry.canonicalTable,
        ),
      ),
    ].sort(),
  );
}

export type OwnershipFindingCode =
  /** A canonical table the registry names is not in the database. */
  | 'OWNERSHIP_CANONICAL_TABLE_MISSING'
  /** A retired table is still present, so reconciliation has not been applied. */
  | 'OWNERSHIP_RETIRED_TABLE_PRESENT'
  /** A compatibility table the registry expects is gone, so the registry is stale. */
  | 'OWNERSHIP_COMPATIBILITY_TABLE_MISSING'
  /** The runtime role can write an object it does not own. */
  | 'OWNERSHIP_DEPRECATED_TABLE_WRITABLE'
  /** A canonical table that must be forced is not. */
  | 'OWNERSHIP_CANONICAL_RLS_NOT_FORCED'
  /** The registry names an aggregate twice with different owners. */
  | 'OWNERSHIP_AMBIGUOUS'
  /** A table the registry never classifies. Ownership must be total, not partial. */
  | 'OWNERSHIP_UNCLASSIFIED_TRUST_TABLE';

/**
 * Whether a finding may let a host serve traffic.
 *
 * `error` means two models exist for one aggregate, or the runtime can write something it does
 * not own — states this capability exists to refuse, so readiness must be false.
 *
 * `warning` is reserved for the registry being *stale* rather than the database being unsafe.
 * A retained compatibility object that has since been dropped is the case: it means the
 * dependency keeping it alive is gone, which is further along than this capability got, not a
 * regression. Blocking startup on it would mean a database that had finished the follow-on
 * work could not boot.
 */
export type OwnershipSeverity = 'error' | 'warning';

export type OwnershipFinding = {
  code: OwnershipFindingCode;
  severity: OwnershipSeverity;
  detail: string;
  table?: string;
};

export type OwnershipCertification = {
  /** No findings of any severity. What a deployment gate and the architecture check require. */
  certified: boolean;
  /**
   * No `error` findings. What readiness requires — see `OwnershipSeverity` for why the two are
   * not the same question.
   */
  safeToServe: boolean;
  findings: OwnershipFinding[];
  /** Counts, so a report states measured numbers rather than restating the registry. */
  observed: {
    canonicalPresent: number;
    retiredPresent: number;
    compatibilityPresent: number;
  };
};

/**
 * The registry's internal consistency, checked without a database.
 *
 * Separate from the live certification because a registry that contradicts itself should fail
 * a unit test rather than wait for a PostgreSQL service. An aggregate claimed by two
 * different canonical tables is the defect this capability exists to prevent, and it would be
 * absurd to let the registry itself carry one.
 */
export function auditOwnershipRegistry(): OwnershipFinding[] {
  const findings: OwnershipFinding[] = [];

  const ownerByAggregate = new Map<string, string>();
  for (const entry of TRUST_AGGREGATE_OWNERSHIP) {
    const existing = ownerByAggregate.get(entry.aggregate);
    if (existing && existing !== entry.canonicalTable)
      findings.push({
        code: 'OWNERSHIP_AMBIGUOUS',
        severity: 'error',
        detail: `aggregate ${entry.aggregate} is claimed by both ${existing} and ${entry.canonicalTable}`,
        table: entry.canonicalTable,
      });
    ownerByAggregate.set(entry.aggregate, entry.canonicalTable);
  }

  // A superseded table is either retired or retained, never both and never neither —
  // otherwise the registry records that something lost ownership without saying what
  // happened to it, which is exactly the indefinite limbo this capability forbids.
  const retired = new Set(RETIRED_TRUST_HISTORICAL_TABLES);
  const compatibility = new Set(COMPATIBILITY_OBJECTS.map((entry) => entry.table));
  for (const entry of TRUST_AGGREGATE_OWNERSHIP) {
    for (const table of entry.supersededTables) {
      const inRetired = retired.has(table);
      const inCompatibility = compatibility.has(table);
      if (inRetired && inCompatibility)
        findings.push({
          code: 'OWNERSHIP_AMBIGUOUS',
          severity: 'error',
          detail: `${table} is listed as both retired and retained`,
          table,
        });
      if (!inRetired && !inCompatibility)
        findings.push({
          code: 'OWNERSHIP_UNCLASSIFIED_TRUST_TABLE',
          severity: 'error',
          detail: `${table} lost ownership of ${entry.aggregate} but is neither retired nor given a retirement condition`,
          table,
        });
    }
  }

  // Every retained object must name a real follow-on capability. "Temporary" without a
  // condition is permanent.
  for (const entry of COMPATIBILITY_OBJECTS)
    if (!entry.retirementCondition.trim())
      findings.push({
        code: 'OWNERSHIP_AMBIGUOUS',
        severity: 'error',
        detail: `${entry.table} is retained with no retirement condition`,
        table: entry.table,
      });

  return findings;
}

/**
 * Whether a live database matches the registry.
 *
 * Reads `information_schema` and `pg_class` rather than trusting the migration ledger: a
 * ledger says which files ran, and this capability's claim is about what the database
 * actually contains. Those are different assertions, and only the second is evidence.
 */
export async function certifySchemaOwnership(
  sql: SqlClient,
  options: { schema?: string; runtimeRole?: string } = {},
): Promise<OwnershipCertification> {
  const findings: OwnershipFinding[] = [...auditOwnershipRegistry()];

  // Resolved from the connection when not given, rather than defaulted to `public`. A pooled
  // connection carries its schema in `search_path`, and a certification that assumed `public`
  // would read a different schema than the store writes — reporting the canonical tables
  // missing, or worse, reporting a clean result about a schema nobody uses.
  const schema =
    options.schema ??
    (await sql<{ schema: string }[]>`SELECT current_schema() AS schema`)[0]?.schema ??
    'public';

  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
  `;
  const present = new Set(rows.map((row) => row.table_name));

  const canonical = canonicalTables();
  for (const table of canonical)
    if (!present.has(table))
      findings.push({
        code: 'OWNERSHIP_CANONICAL_TABLE_MISSING',
        severity: 'error',
        detail: `${table} owns a trust aggregate but does not exist in ${schema}`,
        table,
      });

  for (const table of RETIRED_TRUST_HISTORICAL_TABLES)
    if (present.has(table))
      findings.push({
        code: 'OWNERSHIP_RETIRED_TABLE_PRESENT',
        severity: 'error',
        detail: `${table} was retired by forward migration but is still present, so this database has two models for one aggregate`,
        table,
      });

  for (const entry of COMPATIBILITY_OBJECTS)
    if (!present.has(entry.table))
      findings.push({
        code: 'OWNERSHIP_COMPATIBILITY_TABLE_MISSING',
        severity: 'warning',
        detail: `${entry.table} is retained in the registry (${entry.reason}) but absent from ${schema}; the registry is stale`,
        table: entry.table,
      });

  // Forced RLS on every canonical table that requires it. This duplicates part of
  // `certifyRowLevelSecurity` deliberately: readiness must be able to answer "is ownership
  // sound" without also running the live denial probes, which need a probe role.
  const flags = await sql<{ relname: string; forced: boolean }[]>`
    SELECT c.relname, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind = 'r'
  `;
  const forcedByTable = new Map(flags.map((row) => [row.relname, row.forced]));
  for (const table of forcedRlsCanonicalTables())
    if (present.has(table) && forcedByTable.get(table) !== true)
      findings.push({
        code: 'OWNERSHIP_CANONICAL_RLS_NOT_FORCED',
        severity: 'error',
        detail: `${table} is canonical and must carry FORCE ROW LEVEL SECURITY; without it the owning role bypasses its own policies`,
        table,
      });

  // The runtime must hold no write privilege on anything it does not own. A retained
  // compatibility object that the runtime can write is a dual-write path waiting to happen.
  const runtimeRole = options.runtimeRole ?? 'assurapay_app';
  const deprecated = [
    ...RETIRED_TRUST_HISTORICAL_TABLES,
    ...COMPATIBILITY_OBJECTS.map((entry) => entry.table),
  ];
  const grants = await sql<{ table_name: string; privilege_type: string }[]>`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = ${runtimeRole}
      AND table_schema = ${schema}
      AND table_name = ANY(${deprecated})
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  `;
  for (const grant of grants)
    findings.push({
      code: 'OWNERSHIP_DEPRECATED_TABLE_WRITABLE',
      severity: 'error',
      detail: `${runtimeRole} holds ${grant.privilege_type} on ${grant.table_name}, which it does not own`,
      table: grant.table_name,
    });

  return {
    certified: findings.length === 0,
    safeToServe: findings.every((finding) => finding.severity !== 'error'),
    findings,
    observed: {
      canonicalPresent: canonical.filter((table) => present.has(table)).length,
      retiredPresent: RETIRED_TRUST_HISTORICAL_TABLES.filter((table) => present.has(table)).length,
      compatibilityPresent: COMPATIBILITY_OBJECTS.filter((entry) => present.has(entry.table)).length,
    },
  };
}

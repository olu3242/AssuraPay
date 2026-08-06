-- Row Level Security for the trust store, made load-bearing.
--
-- The defect this corrects, verified against a live instance rather than inferred: one
-- hundred tables already carried ENABLE ROW LEVEL SECURITY and a policy requiring
-- workspace_id = current_workspace_id(), and none of it applied to the application. ENABLE
-- does not constrain a table's OWNER, and the application role owned every table. Insert a
-- membership, clear app.workspace_id, count rows — the answer was one, on a table whose
-- policy said it should have been zero.
--
-- A policy that is present but bypassed is worse than no policy, because it is read as
-- protection. Two changes make these real:
--
--   FORCE ROW LEVEL SECURITY, so the owner is subject to its own policies. Without it,
--   any connection as the owning role — a migration, a console, a job that happens to use
--   the admin credential — sees everything.
--
--   A separate application role that does not own the tables, holding DML only. Defence in
--   depth rather than redundancy: FORCE covers the owner, and a non-owning role means the
--   application is not the owner in the first place.
--
-- Scope comes from transaction-local session variables (app.tenant_id, app.workspace_id,
-- app.actor_id) set by the repository per operation. Transaction-local — set_config(..., true)
-- — because a value that outlived its transaction would leak onto the next request served
-- by the same pooled connection, which is a cross-tenant read with no bug in any policy.

-- ---------------------------------------------------------------- scope accessors

-- Null rather than an error when unset, so a policy comparing against it denies instead of
-- failing. A caller with no scope must read nothing, not receive a diagnostic they might
-- retry around.
CREATE OR REPLACE FUNCTION trust_current_tenant() RETURNS TEXT
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE OR REPLACE FUNCTION trust_current_workspace() RETURNS TEXT
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '') $$;

CREATE OR REPLACE FUNCTION trust_current_actor() RETURNS TEXT
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_id', true), '') $$;

COMMENT ON FUNCTION trust_current_workspace() IS
  'Transaction-local workspace scope, or NULL when unset so policies deny rather than error.';

-- ---------------------------------------------------------------- the application role

-- The migration does not create the role, and does not grant it to anybody.
--
-- It did both at first, and that was wrong twice over. Creating a role needs CREATEROLE, and
-- granting membership needs ADMIN OPTION on the role — privileges a migration credential may
-- not hold, and which it should not need, since a migration's job is the schema. Worse, the
-- grant is not idempotent across credentials: a role created by one operator cannot be granted
-- by another, so the migration succeeded on the machine that first ran it and failed with a
-- bare "permission denied" everywhere else.
--
-- Role provisioning is an operator action, for the same reason the password is: it belongs to
-- the deployment, not to a file in the repository. What the migration owns is the privileges
-- *on its own objects*, applied when the role is present and skipped with a notice when it is
-- not — so a database can carry the policies before the role exists, and gain the grants when
-- an operator creates it and re-runs the corrective migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    RAISE NOTICE 'assurapay_app does not exist; policies are applied but no privileges granted. Create the role and grant it the privileges listed in this migration before pointing an application at this database.';
    RETURN;
  END IF;

  -- The current schema, not a hard-coded `public`. Without USAGE on the schema the tables are
  -- not merely unreadable but invisible — a query reports that the relation does not exist,
  -- which reads as a missing migration rather than a missing grant.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO assurapay_app', current_schema());

  -- DML only. No DDL, no ownership, and deliberately no DELETE on history: the append-only
  -- constraint is enforced by a trigger, and a role that cannot issue DELETE at all cannot
  -- reach the trigger to be refused by it.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON
    trust_tenants, trust_workspaces, trust_memberships, trust_permission_grants,
    trust_bootstrap_state, trust_outbox_events, trust_idempotency_keys, trust_records
    TO assurapay_app';

  EXECUTE 'GRANT SELECT, INSERT ON trust_audit_records TO assurapay_app';

  -- The ledger is read to verify schema compatibility at startup and never written by the
  -- application; the migration runner writes it as the owner.
  EXECUTE 'GRANT SELECT ON trust_migration_ledger TO assurapay_app';
END $$;

-- ---------------------------------------------------------------- workspaces

ALTER TABLE trust_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_workspaces FORCE ROW LEVEL SECURITY;

-- Tenant-scoped rather than workspace-scoped: a caller resolving which workspaces they may
-- enter has a tenant but not yet a workspace, and a workspace-scoped policy here would make
-- that resolution impossible and force an operator to disable the policy to fix login.
CREATE POLICY trust_workspaces_tenant_scope ON trust_workspaces
  USING (tenant_id = trust_current_tenant())
  WITH CHECK (tenant_id = trust_current_tenant());

-- ---------------------------------------------------------------- tenants

ALTER TABLE trust_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY trust_tenants_self ON trust_tenants
  USING (tenant_id = trust_current_tenant())
  WITH CHECK (tenant_id = trust_current_tenant());

-- ---------------------------------------------------------------- memberships

ALTER TABLE trust_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_memberships FORCE ROW LEVEL SECURITY;

-- Readable when the row's workspace belongs to the caller's tenant, rather than requiring
-- the workspace to be the active one. Membership resolution answers "which workspaces am I
-- in", and a policy keyed on the active workspace would require knowing the answer first.
--
-- Note what this does not do: it does not filter to the caller's own membership. Reading
-- another member's row inside a workspace you belong to is a permission question, decided by
-- Engine 03 against a grant. RLS is the tenancy boundary, not the authorization model, and
-- conflating them would put permission logic in a place no test of authorization can see.
CREATE POLICY trust_memberships_tenant_scope ON trust_memberships
  USING (
    workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  )
  WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  );

-- ---------------------------------------------------------------- permission grants

ALTER TABLE trust_permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_permission_grants FORCE ROW LEVEL SECURITY;

-- The highest-value boundary in the schema. A cross-tenant leak here is not an information
-- disclosure but a potential privilege one: grants are what authorization decides on.
CREATE POLICY trust_permission_grants_tenant_scope ON trust_permission_grants
  USING (
    workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  )
  WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  );

-- ---------------------------------------------------------------- bootstrap

ALTER TABLE trust_bootstrap_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_bootstrap_state FORCE ROW LEVEL SECURITY;

CREATE POLICY trust_bootstrap_tenant_scope ON trust_bootstrap_state
  USING (
    workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  )
  WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  );

-- ---------------------------------------------------------------- audit history

ALTER TABLE trust_audit_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_audit_records FORCE ROW LEVEL SECURITY;

-- Keyed on the record's own tenant_id, not on a join to trust_workspaces. Audit history
-- outlives the aggregates it describes: a workspace may be closed and its row removed, and
-- history that became unreadable at that moment would defeat the point of keeping it.
--
-- A NULL tenant_id is a platform-level event rather than a tenant's: identity registration
-- and activation happen before the actor belongs to any tenant, and `IdentityService` audits
-- them with no tenant on the context. Refusing those writes would make registration impossible
-- under forced RLS, so they are permitted — and, being untenanted, they are readable by any
-- scoped caller.
--
-- That is the same exception `trust_records` makes for identities and sessions, and the same
-- named weak point: an untenanted record is guarded by the identity gateway and by permission
-- enforcement, not by tenancy. Narrowing it needs a tenant on identity events, which is a
-- domain change rather than a policy one. It is stated here rather than left for a reader to
-- infer from a policy that looks tighter than it is.
CREATE POLICY trust_audit_tenant_scope ON trust_audit_records
  USING (
    tenant_id = trust_current_tenant()
    OR (tenant_id IS NULL AND trust_current_tenant() IS NOT NULL)
  )
  WITH CHECK (
    tenant_id = trust_current_tenant()
    OR (tenant_id IS NULL AND trust_current_tenant() IS NOT NULL)
  );

-- ---------------------------------------------------------------- outbox

ALTER TABLE trust_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_outbox_events FORCE ROW LEVEL SECURITY;

-- Same exception as the audit trail, for the same reason: a session-created event emitted at
-- login has no tenant yet.
CREATE POLICY trust_outbox_tenant_scope ON trust_outbox_events
  USING (
    tenant_id = trust_current_tenant()
    OR (tenant_id IS NULL AND trust_current_tenant() IS NOT NULL)
  )
  WITH CHECK (
    tenant_id = trust_current_tenant()
    OR (tenant_id IS NULL AND trust_current_tenant() IS NOT NULL)
  );

-- ---------------------------------------------------------------- idempotency

ALTER TABLE trust_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_idempotency_keys FORCE ROW LEVEL SECURITY;

-- Scoped by workspace where present. A key with no workspace is global by construction —
-- it deduplicates something that happens once across the platform — and is readable within
-- any tenant, because hiding it would let two tenants each believe they were first.
CREATE POLICY trust_idempotency_scope ON trust_idempotency_keys
  USING (
    workspace_id IS NULL
    OR workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  )
  WITH CHECK (
    workspace_id IS NULL
    OR workspace_id IN (SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant())
  );

-- ---------------------------------------------------------------- governed documents

ALTER TABLE trust_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_records FORCE ROW LEVEL SECURITY;

-- The document table holds records at three different scopes, and the policy has to admit
-- all three or break the paths that legitimately precede having a workspace.
--
--   Tenant-scoped rows are visible within their tenant.
--   Workspace-scoped rows are visible when the workspace belongs to the caller's tenant.
--   Rows with neither — identities and sessions, which exist before any workspace does and
--   are how a caller establishes who they are — are visible to any scoped caller. They are
--   guarded by the identity gateway and by permission enforcement, not by tenancy, because
--   a policy that hid them would make sign-in impossible.
--
-- That last branch is the honest weak point of this model and is named as such: it is why
-- `identities` and `sessions` still depend on application-level scoping. Narrowing it needs
-- a tenant column on those records, which is a data-model change rather than a policy one.
CREATE POLICY trust_records_scope ON trust_records
  USING (
    (tenant_id IS NOT NULL AND tenant_id = trust_current_tenant())
    OR (workspace_id IS NOT NULL AND workspace_id IN (
      SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant()
    ))
    OR (tenant_id IS NULL AND workspace_id IS NULL AND trust_current_tenant() IS NOT NULL)
  )
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = trust_current_tenant())
    OR (workspace_id IS NOT NULL AND workspace_id IN (
      SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant()
    ))
    OR (tenant_id IS NULL AND workspace_id IS NULL AND trust_current_tenant() IS NOT NULL)
  );

-- Gives `trust_memberships` its own tenant, so its policy needs no join.
--
-- Split from `202608110022_membership_discovery_precedes_tenant_scope.sql`, which is the policy half,
-- because this half is *schema* and every schema the store writes to needs it. The store fills the
-- column on every membership insert, so a host carrying the policies but not the column — or the
-- column but not the policies — is broken in one direction or the other. Separating them lets the
-- store-only harnesses apply the column without the policies, and guarantees the column exists before
-- any policy referencing it is created.
--
-- ## Why the column exists at all
--
-- A membership's tenant is derivable from its workspace, so storing it is denormalisation. It is
-- stored anyway because the policy that has to read it runs *during scope discovery*: the previous
-- `trust_memberships_tenant_scope` resolved the tenant by joining `trust_workspaces`, and giving
-- `trust_workspaces` an actor-keyed branch in return made the two policies mutually recursive.
-- PostgreSQL refuses that rather than looping:
--
--   ERROR:  infinite recursion detected in policy for relation "trust_memberships"
--
-- measured, not predicted — the joined version was written and run first. With the tenant on the row,
-- the membership policy references no table and the cycle cannot form.
--
-- The value is never trusted from a caller. `PostgresTrustStore` derives it in the INSERT from the
-- membership's own workspace, and the policy in `202608110022` requires it to equal the caller's
-- scope — so a row's tenant can only ever be both its workspace's tenant and the tenant that wrote it.

-- ---------------------------------------------------------------- the membership's own tenant

ALTER TABLE trust_memberships ADD COLUMN IF NOT EXISTS tenant_id TEXT;

-- Backfilled from the workspace, which is where the value has always been derivable from.
UPDATE trust_memberships m
SET tenant_id = w.tenant_id
FROM trust_workspaces w
WHERE w.workspace_id = m.workspace_id AND m.tenant_id IS NULL;

-- A membership whose workspace no longer exists cannot be given a tenant, and must not be left
-- readable-by-nobody with a NULL that the policy treats as "no tenant". There should be none — the
-- foreign key to `trust_workspaces` makes it impossible — so this asserts rather than repairs.
DO $$
DECLARE orphaned BIGINT;
BEGIN
  SELECT count(*) INTO orphaned FROM trust_memberships WHERE tenant_id IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'MEMBERSHIP_TENANT_UNRESOLVED: % membership row(s) name no reachable workspace', orphaned;
  END IF;
END $$;

ALTER TABLE trust_memberships ALTER COLUMN tenant_id SET NOT NULL;

-- Not a foreign key to `trust_tenants`, and the reason is the policy above rather than laziness:
-- resolving an FK reads the referenced table, `trust_tenants` is itself policy-governed on
-- `tenant_id = trust_current_tenant()`, and an insert during founding would have to satisfy that
-- policy from a scope that is being established by the same statement. The value's integrity is
-- guaranteed the other way instead — by the `WITH CHECK` requiring it to equal the caller's scope,
-- and by the existing FK from `workspace_id`, which already pins the membership to a real workspace
-- whose own tenant is a real tenant.
CREATE INDEX IF NOT EXISTS trust_memberships_actor_idx ON trust_memberships (user_id, status);
CREATE INDEX IF NOT EXISTS trust_memberships_tenant_idx ON trust_memberships (tenant_id);

COMMENT ON COLUMN trust_memberships.tenant_id IS
  'The membership''s own tenant, denormalised from its workspace so the policy needs no join and can be evaluated before scope exists.';


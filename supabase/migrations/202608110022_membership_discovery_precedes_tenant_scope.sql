-- Lets a caller discover the memberships that tell it which tenant to scope to.
--
-- The last blocker in the bootstrap journey, and the same shape as the two before it: a step that
-- establishes scope was itself gated on already having scope. The browser found it after
-- `202608110020` repaired registration — founding an organization succeeded, the row was written
-- correctly, and the page then showed "No workspace memberships yet". The membership existed:
--
--   membership_id                        | workspace_id | user_id      | status
--   2e6ad436-46d7-42c0-9ca1-2ad1cd192028 | 7b92c7f7-... | 9c8c0fc5-... | ACTIVE
--
-- and an unscoped read of `trust_memberships` returned 0 rows.
--
-- ## Why the previous policies could not answer the question they were asked
--
-- `GET /v1/me/workspaces` answers "which workspaces may I enter". A caller who has just signed in
-- has no tenant on its session — the tenant comes *from* the workspace it eventually activates — so
-- that read runs with no tenant scope. Both policies it touches required one:
--
--   trust_memberships_tenant_scope: workspace_id IN (SELECT ... WHERE tenant_id = trust_current_tenant())
--   trust_workspaces_tenant_scope:  tenant_id = trust_current_tenant()
--
-- `202608070001`'s own comment on the membership policy shows the author reasoning about exactly
-- this trap one level down — "Membership resolution answers 'which workspaces am I in', and a policy
-- keyed on the active workspace would require knowing the answer first" — and then keying it on the
-- tenant, which has the identical problem one level up. You cannot know your tenant before you know
-- your memberships, because your memberships are what name it.
--
-- The consequence was not a corner case. It made every return visit unusable: the first sign-in of a
-- session could never reach a workspace list, so the only way into the product was to found a new
-- organization every time.
--
-- ## The recursion this has to avoid, and why the column is the way out
--
-- The obvious repair is an actor-keyed branch on each policy: a membership is readable by the
-- principal it names, and a workspace is readable by someone with an ACTIVE membership in it. Added
-- naively that is mutually recursive — the workspace policy queries `trust_memberships`, whose
-- policy queries `trust_workspaces` — and PostgreSQL says so rather than looping:
--
--   ERROR:  infinite recursion detected in policy for relation "trust_memberships"
--
-- That was measured, not predicted; the naive version was written and run first.
--
-- The cycle is broken by giving `trust_memberships` its own `tenant_id`, so its policy references no
-- table at all. The workspace policy may then query memberships freely, because nothing queries back.
-- The column is denormalised, which is worth naming: a membership's tenant is derivable from its
-- workspace, and it is stored anyway because a policy that has to join to find its own scope is a
-- policy that cannot be evaluated during scope discovery. The value is not trusted from a caller —
-- `PostgresTrustStore` writes it from the ambient scope, and the `WITH CHECK` below requires it to
-- equal `trust_current_tenant()`, so a row's tenant can only ever be the tenant that wrote it.
--
-- ## The actor branch is read-only, deliberately
--
-- `USING` gains the actor branch; `WITH CHECK` does not. This is the difference between reading your
-- own memberships and granting yourself one, and putting the branch on both would be a privilege
-- escalation with no authentication step: any caller could insert an ACTIVE membership naming itself
-- in any workspace of any tenant, and the row would satisfy its own policy. Writes therefore still
-- require a tenant scope. Founding is unaffected because `POST /v1/tenants` mints a tenant and enters
-- its scope before writing, which is what makes that route safe in the first place.
--
-- Nothing here widens what a *scoped* caller can see. The tenant branches are reproduced unchanged,
-- and the actor branch shows a caller only rows that name it — strictly less than the tenant branch
-- already grants, since a tenant-scoped caller sees every workspace in its tenant rather than only
-- the ones it belongs to.

-- ---------------------------------------------------------------- memberships

DROP POLICY IF EXISTS trust_memberships_tenant_scope ON trust_memberships;

CREATE POLICY trust_memberships_tenant_scope ON trust_memberships
  USING (
    tenant_id = trust_current_tenant()
    -- Read your own memberships with no tenant scope. This is the branch that makes sign-in able to
    -- reach a workspace list, and it references no other table, which is what keeps the workspace
    -- policy below from recursing.
    OR user_id = trust_current_actor()
  )
  -- Writes stay tenant-scoped. See the note above on why the actor branch must not appear here.
  WITH CHECK (tenant_id = trust_current_tenant());

-- ---------------------------------------------------------------- workspaces

DROP POLICY IF EXISTS trust_workspaces_tenant_scope ON trust_workspaces;

CREATE POLICY trust_workspaces_tenant_scope ON trust_workspaces
  USING (
    tenant_id = trust_current_tenant()
    -- A workspace you are an ACTIVE member of, readable before you have entered its tenant. ACTIVE
    -- rather than any status, matching `listAuthorizedWorkspaces`: a suspended membership must not
    -- reveal a workspace the caller would then be refused entry to.
    OR workspace_id IN (
      SELECT workspace_id FROM trust_memberships
      WHERE user_id = trust_current_actor() AND status = 'ACTIVE'
    )
  )
  WITH CHECK (tenant_id = trust_current_tenant());

-- ---------------------------------------------------------------- the repair, asserted

-- Proven here for the same reason `202608110020` proves its own: the DDL above is a claim about
-- behaviour, and the claim is worth checking before it is committed. Run as the owner under FORCE
-- ROW LEVEL SECURITY, so the policies apply.
DO $$
DECLARE
  probe_tenant CONSTANT TEXT := 'tenant-202608110021-probe';
  probe_workspace CONSTANT TEXT := 'ws-202608110021-probe';
  probe_actor CONSTANT TEXT := 'user-202608110021-probe';
  visible BIGINT;
  escalated BOOLEAN := TRUE;
BEGIN
  -- Seeded inside the tenant's own scope, which is how founding writes it.
  PERFORM set_config('app.tenant_id', probe_tenant, true);
  PERFORM set_config('app.workspace_id', '', true);
  PERFORM set_config('app.actor_id', probe_actor, true);

  INSERT INTO trust_tenants (tenant_id) VALUES (probe_tenant);
  INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
  VALUES (probe_workspace, probe_tenant, 'ACTIVE', '{"id":"probe"}'::jsonb, repeat('0', 64));
  INSERT INTO trust_memberships (membership_id, workspace_id, tenant_id, user_id, status, payload, payload_digest)
  VALUES ('m-probe', probe_workspace, probe_tenant, probe_actor, 'ACTIVE', '{"id":"probe"}'::jsonb, repeat('0', 64));

  -- Now the read that was returning nothing: the actor is known, the tenant is not.
  PERFORM set_config('app.tenant_id', '', true);

  SELECT count(*) INTO visible FROM trust_memberships WHERE membership_id = 'm-probe';
  IF visible <> 1 THEN
    RAISE EXCEPTION 'MEMBERSHIP_UNDISCOVERABLE: a caller still cannot read its own membership without a tenant';
  END IF;

  SELECT count(*) INTO visible FROM trust_workspaces WHERE workspace_id = probe_workspace;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'WORKSPACE_UNDISCOVERABLE: a member still cannot see the workspace it belongs to';
  END IF;

  -- And the escalation the read-only actor branch exists to refuse: granting yourself a membership
  -- in a tenant you are not scoped to. Its own block, so a refusal of the reads above cannot be
  -- mistaken for this one succeeding.
  BEGIN
    INSERT INTO trust_memberships (membership_id, workspace_id, tenant_id, user_id, status, payload, payload_digest)
    VALUES ('m-probe-escalation', probe_workspace, probe_tenant, probe_actor, 'ACTIVE', '{"id":"probe"}'::jsonb, repeat('0', 64));
  EXCEPTION
    WHEN insufficient_privilege THEN
      escalated := FALSE;
  END;

  IF escalated THEN
    RAISE EXCEPTION 'MEMBERSHIP_SELF_GRANT_PERMITTED: the actor branch reached WITH CHECK';
  END IF;

  -- Cleaned up in the tenant's scope, since that is the only scope permitted to delete these rows.
  PERFORM set_config('app.tenant_id', probe_tenant, true);
  DELETE FROM trust_memberships WHERE membership_id = 'm-probe';
  DELETE FROM trust_workspaces WHERE workspace_id = probe_workspace;
  DELETE FROM trust_tenants WHERE tenant_id = probe_tenant;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

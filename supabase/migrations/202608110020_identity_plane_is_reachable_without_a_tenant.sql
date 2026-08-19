-- Makes the identity plane reachable by a caller that has no tenant yet.
--
-- This repairs a defect that made the product impossible to bootstrap: under forced row-level
-- security, **registration could not write its own row**. The first browser journey ever run
-- against the durable runtime failed on its first click with
--
--   Registration refused: PERSISTENCE_SCOPE_INVALID: 42501:
--   new row violates row-level security policy for table "trust_records"
--
-- and every journey behind it failed the same way. `docs/product/RC1_GAP_MATRIX.md` records the
-- measurement.
--
-- ## The defect is a contradiction between three policies and their own comments
--
-- `202608070001` gave `trust_records`, `trust_audit_records` and `trust_outbox_events` an
-- untenanted branch, and said in prose exactly why:
--
--   "identity registration and activation happen before the actor belongs to any tenant, and
--    `IdentityService` audits them with no tenant on the context. Refusing those writes would
--    make registration impossible under forced RLS, so they are permitted"
--
-- The predicate does the opposite of what that sentence says. All three wrote the branch as
--
--   tenant_id IS NULL AND trust_current_tenant() IS NOT NULL
--
-- which admits an untenanted row only for a caller that *already has a tenant* — precisely the
-- caller which, by the comment's own reasoning, does not exist yet at registration. The branch
-- meant to permit the pre-tenant path is the one predicate that excludes it. `PostgresTrustStore`
-- then documents the consequence as intended behaviour ("No ambient scope — run unscoped. Under
-- forced RLS that reads nothing and writes nothing, which is the correct outcome"), so nothing in
-- the system disagreed with anything else and the product simply could not be entered.
--
-- Note that `trust_idempotency_keys` in the same migration got it right — `workspace_id IS NULL OR
-- workspace_id IN (...)`, with no ambient-scope requirement. That is the shape the other three
-- intended, and this migration gives it to them.
--
-- ## The second defect: a session became unreadable the moment it was activated
--
-- Fixing registration alone is not enough, and the reason is structural rather than incidental.
-- `UserSession` carries an optional `workspaceId`, so `activate-context` promotes a session row
-- from scope-less to workspace-scoped. Session resolution cannot be scoped — resolving the session
-- is *how* the scope is discovered — so after activation the unscoped resolver would look for a
-- workspace-scoped row and, correctly by the second branch, find nothing. A user could sign in,
-- activate a workspace, and be signed out by their own success.
--
-- That is why the branch added below is keyed on the **collection** and not on the scope columns.
-- A rule of the form "untenanted rows are admissible" cannot express it, because an activated
-- session is not untenanted.
--
-- ## What this changes, stated precisely
--
-- `trust_records` holds rows of two different kinds, and this migration is the first thing in the
-- schema to say so:
--
--   * Tenancy-scoped aggregates — parties, legal policies, organization units and the rest.
--     Guarded by tenancy. The three existing branches are reproduced below unchanged, character
--     for character, and nothing about these rows is altered.
--
--   * The identity plane — identities, authentication methods, sessions, devices and step-up
--     challenges. Guarded by the identity gateway and by permission enforcement, not by tenancy,
--     because the identity plane is what *establishes* scope and therefore cannot be guarded by
--     it. `UserIdentity` names this itself: its subject key is `tenantNeutralSubjectId`.
--
-- The change is additive. Every row admitted before is still admitted, so no scoped behaviour
-- moves; the addition is confined to the five collections named in
-- `trust_collection_is_identity_plane`, so an unscoped caller gains the identity plane and nothing
-- else. An unscoped transaction still reads zero agreements, zero milestones, zero entitlements
-- and zero parties — `identity-plane-rls.postgres.test.ts` asserts that boundary rather than
-- leaving it to be inferred from the predicate.
--
-- ## What it deliberately does not do
--
-- It does not narrow the untenanted branch to the identity plane, which would be the tighter
-- policy. `legalPolicyVersions` carries neither `tenantId` nor `workspaceId` — it is scoped
-- transitively through its parent policy — so it writes a scope-less row and depends on the
-- existing branch. Narrowing would refuse it. That residual is a data-model gap rather than a
-- policy one and is recorded as such in the gap matrix; it is named here so a reader does not
-- mistake this migration for having closed it.

-- ---------------------------------------------------------------- the identity plane

-- IMMUTABLE rather than STABLE: the set is a property of the schema, not of the database's
-- contents, which lets the planner fold it into the policy instead of re-evaluating per row.
--
-- The five are derived rather than chosen. `UserIdentity`, `AuthenticationMethod`, `TrustedDevice`
-- and `StepUpChallenge` are the only trust types carrying neither `tenantId` nor `workspaceId`,
-- and `UserSession`'s `workspaceId` is an activation result rather than an ownership scope.
-- `POSTGRES_IDENTITY_PLANE_COLLECTIONS` in `packages/database` holds the same list, and
-- `identity-plane-rls.postgres.test.ts` asserts the two agree — so adding a sixth collection on
-- one side without the other fails certification rather than drifting.
CREATE OR REPLACE FUNCTION trust_collection_is_identity_plane(collection TEXT)
  RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT collection IN (
      'identities',
      'authenticationMethods',
      'sessions',
      'devices',
      'stepUpChallenges'
    )
  $$;

COMMENT ON FUNCTION trust_collection_is_identity_plane(TEXT) IS
  'True for the collections that establish scope and therefore cannot be guarded by it.';

-- ---------------------------------------------------------------- governed documents

DROP POLICY IF EXISTS trust_records_scope ON trust_records;

CREATE POLICY trust_records_scope ON trust_records
  USING (
    (tenant_id IS NOT NULL AND tenant_id = trust_current_tenant())
    OR (workspace_id IS NOT NULL AND workspace_id IN (
      SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant()
    ))
    OR (tenant_id IS NULL AND workspace_id IS NULL AND trust_current_tenant() IS NOT NULL)
    -- The fourth branch, and the only addition. Keyed on the collection because an activated
    -- session is workspace-scoped and still has to be resolvable by the unscoped resolver.
    OR trust_collection_is_identity_plane(collection)
  )
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = trust_current_tenant())
    OR (workspace_id IS NOT NULL AND workspace_id IN (
      SELECT workspace_id FROM trust_workspaces WHERE tenant_id = trust_current_tenant()
    ))
    OR (tenant_id IS NULL AND workspace_id IS NULL AND trust_current_tenant() IS NOT NULL)
    OR trust_collection_is_identity_plane(collection)
  );

-- ---------------------------------------------------------------- audit history

-- No collection column to key on here, and none is wanted: an audit record is untenanted whenever
-- the context that produced it was, which is not a property of one aggregate type. The conjunct
-- that contradicted the comment is simply removed, leaving the rule the comment describes — an
-- untenanted audit record is a platform-level event, writable by the platform-level caller that
-- produces it and readable by any caller.
--
-- Tenanted records are untouched: they remain visible only within their own tenant, and
-- `identity-plane-rls.postgres.test.ts` proves tenant A still cannot read tenant B's history.
DROP POLICY IF EXISTS trust_audit_tenant_scope ON trust_audit_records;

CREATE POLICY trust_audit_tenant_scope ON trust_audit_records
  USING (tenant_id = trust_current_tenant() OR tenant_id IS NULL)
  WITH CHECK (tenant_id = trust_current_tenant() OR tenant_id IS NULL);

-- ---------------------------------------------------------------- outbox

-- Same repair for the same reason. The original comment already said it: "a session-created event
-- emitted at login has no tenant yet" — and login has no tenant either, which is what the removed
-- conjunct required it to have.
DROP POLICY IF EXISTS trust_outbox_tenant_scope ON trust_outbox_events;

CREATE POLICY trust_outbox_tenant_scope ON trust_outbox_events
  USING (tenant_id = trust_current_tenant() OR tenant_id IS NULL)
  WITH CHECK (tenant_id = trust_current_tenant() OR tenant_id IS NULL);

-- ---------------------------------------------------------------- the repair, asserted

-- The migration proves its own claim before it commits, in the same shape
-- `202608110018_money_columns_refuse_fractional_amounts` used: assert the behaviour rather than
-- trust that the DDL above expressed it.
--
-- Run as the table owner under FORCE ROW LEVEL SECURITY with no scope set — which is exactly the
-- registration path's conditions — so a policy that still refused the write would fail the
-- migration here rather than fail a user's first click.
-- Note the shape: the boundary probe gets its own inner block, and only that block has an
-- exception handler. An outer handler covering all three would swallow a *refusal* of the two
-- identity-plane inserts — the exact failure being tested for — and the migration would report
-- success on a schema where registration was still impossible. The handler must therefore be no
-- wider than the one statement whose refusal is the expected result.
DO $$
DECLARE
  probe_id CONSTANT TEXT := 'migration-202608110020-probe';
  boundary_breached BOOLEAN := TRUE;
BEGIN
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.workspace_id', '', true);

  -- Registration. Refused before this migration; if it is refused now, the exception is raised by
  -- the INSERT itself and reaches the runner uncaught, which is what should happen.
  INSERT INTO trust_records (collection, record_id, payload, payload_digest)
  VALUES ('identities', probe_id, '{"id":"probe"}'::jsonb, repeat('0', 64));

  IF NOT EXISTS (SELECT 1 FROM trust_records WHERE collection = 'identities' AND record_id = probe_id) THEN
    RAISE EXCEPTION 'IDENTITY_PLANE_UNREADABLE_WITHOUT_A_TENANT: registration would still be impossible';
  END IF;

  -- An activated session: workspace-scoped, and still resolvable unscoped. This is the second
  -- defect, and it is the one a reader is most likely to think the fix above did not cover.
  INSERT INTO trust_records (collection, record_id, workspace_id, payload, payload_digest)
  VALUES ('sessions', probe_id, 'ws-migration-probe', '{"id":"probe"}'::jsonb, repeat('0', 64));

  IF NOT EXISTS (SELECT 1 FROM trust_records WHERE collection = 'sessions' AND record_id = probe_id) THEN
    RAISE EXCEPTION 'ACTIVATED_SESSION_UNREADABLE_WITHOUT_A_TENANT: sign-in would end at activation';
  END IF;

  -- The boundary the addition must not have moved. A workspace-scoped row outside the identity
  -- plane stays invisible to an unscoped caller; if this insert succeeds, the fourth branch has
  -- been written too wide.
  BEGIN
    INSERT INTO trust_records (collection, record_id, workspace_id, payload, payload_digest)
    VALUES ('parties', probe_id, 'ws-migration-probe', '{"id":"probe"}'::jsonb, repeat('0', 64));
  EXCEPTION
    WHEN insufficient_privilege THEN
      boundary_breached := FALSE;
  END;

  IF boundary_breached THEN
    RAISE EXCEPTION 'TENANCY_BOUNDARY_BREACHED: an unscoped caller wrote a workspace-scoped party row';
  END IF;
END $$;

-- The audit and outbox repairs are deliberately not probed here. `trust_audit_records` is an
-- append-only hash chain — `chain_position` and `integrity_hash` are NOT NULL with no defaults, and
-- a probe row would either be refused by the append-only trigger or, worse, accepted and leave a
-- break in the chain that a later integrity check would report as tampering. Proving a policy is
-- not worth corrupting the ledger that policy protects.
--
-- They are proven twice elsewhere instead, and more honestly: `identity-plane-rls.postgres.test.ts`
-- writes a properly chained untenanted record with no scope set, and the browser journey in
-- `e2e/browser-auth-e2e.spec.ts` cannot register at all unless the audit write succeeds, because
-- `IdentityService.register` audits every registration before it returns.

-- The probes are rolled back with the transaction the migration runner opens, but say so rather
-- than rely on it: a runner that autocommitted would otherwise leave three rows behind.
DELETE FROM trust_records WHERE record_id = 'migration-202608110020-probe';

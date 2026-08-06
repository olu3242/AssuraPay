-- Every trust aggregate gets one relational owner.
--
-- The repository carried two relational models for the trust domain: the ten `trust_*` tables
-- the certified `PostgresTrustStore` writes, and an earlier thirty-one-table model describing
-- the same aggregates. Both were created by every migration run, so every database carried
-- both, and `audit_records.aggregate_id` was typed UUID while the live store audits
-- permission keys — a schema that could not hold what the application produces.
--
-- Two facts, established against a live instance, decide what this migration does.
--
-- There were never any dual writes. The only production module issuing SQL against data is
-- `postgres-store.ts`, and it names `trust_*` tables only; `FileAssuraStore` contains no SQL
-- at all. So the historical model held no rows, and this is a retirement rather than a data
-- migration. No row is moved, because there is no row to move.
--
-- The historical model is not uniformly removable. Three of its tables are load-bearing for
-- the out-of-scope Engine 06-60 model, and PostgreSQL was the oracle for that closure rather
-- than inference: dropping the full candidate set is refused naming
-- `governed_executions_workspace_id_fkey`, and the closure of what must survive is
-- `workspaces` (foreign-key parent of 93 tables), `workspace_memberships` (read by
-- `has_active_workspace_membership()`, which those tables' policies call) and
-- `user_identities` (parent of `workspace_memberships`).
--
-- Those three are therefore retained as compatibility objects with a named retirement
-- condition — `persistence.domain-store-durability` — not as an indefinite reprieve. The
-- other twenty-eight are dropped.
--
-- The emptiness check below is the whole safety argument. "These tables are empty" is a claim
-- about every database that will ever apply this migration, not just the ones it was written
-- against, and a migration that assumed it and was wrong would destroy data silently. So it
-- is verified at apply time and the migration refuses. A database with rows in these tables
-- is a database whose history contradicts this capability's evidence, and it must stop and be
-- looked at rather than be quietly reconciled.

-- Refuse rather than discard. Named columns are avoided so this works whatever the shape.
DO $reconcile$
DECLARE
  target   TEXT;
  occupied TEXT[] := '{}';
  rows     BIGINT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'audit_records', 'authentication_methods', 'authority_rules',
    'beneficiary_account_references', 'consent_records', 'delegations', 'event_outbox',
    'field_permissions', 'legal_entities', 'legal_holds', 'legal_policies',
    'legal_policy_versions', 'organization_units', 'organizations', 'parties',
    'permission_definitions', 'permission_grants', 'policy_acceptances', 'policy_assignments',
    'role_definitions', 'segregation_rules', 'signature_policies', 'step_up_challenges',
    'trusted_devices', 'user_sessions', 'verification_requests', 'verification_results',
    'workspace_invitations'
  ]
  LOOP
    -- Absent already is fine: this migration must be idempotent against a database that a
    -- previous partial run, or a future fresh install, left in either state.
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
      IF rows > 0 THEN
        occupied := occupied || format('%s=%s', target, rows);
      END IF;
    END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'TRUST_SCHEMA_RECONCILIATION_REFUSED: % historical trust table(s) contain rows: %. '
      'This capability retires them on the evidence that no code has ever written them, so '
      'rows here mean that evidence does not hold for this database. Nothing has been '
      'dropped. Migrate or export this data deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;
END
$reconcile$;

-- Retire the twenty-eight. One statement listing all of them, deliberately without CASCADE:
-- mutual foreign keys inside the set resolve because every member is named, while anything
-- *outside* the set that depends on them makes the migration fail loudly instead of being
-- silently dropped along with them.
DROP TABLE IF EXISTS
  audit_records,
  authentication_methods,
  authority_rules,
  beneficiary_account_references,
  consent_records,
  delegations,
  event_outbox,
  field_permissions,
  legal_entities,
  legal_holds,
  legal_policies,
  legal_policy_versions,
  organization_units,
  organizations,
  parties,
  permission_definitions,
  permission_grants,
  policy_acceptances,
  policy_assignments,
  role_definitions,
  segregation_rules,
  signature_policies,
  step_up_challenges,
  trusted_devices,
  user_sessions,
  verification_requests,
  verification_results,
  workspace_invitations;

-- The three that survive are marked, in the database, as not owning anything. A reader with a
-- psql prompt and no access to this repository is the audience: the comment has to say what
-- owns the aggregate now and what would let this table go.
--
-- Conditional on existence, for two reasons that are the same reason. A schema holding only
-- the trust tables — which is what the integration harness builds, and what a deployment that
-- never carried the historical model would have — has nothing to deprecate. And a database
-- that has already completed `persistence.domain-store-durability` will have dropped these
-- three, at which point this migration must still apply cleanly to a fresh install rather
-- than failing on tables whose whole point was to go away.
DO $deprecate$
DECLARE
  target  TEXT;
  note    TEXT;
  retained CONSTANT TEXT[][] := ARRAY[
    ARRAY['workspaces',
      'DEPRECATED. Not the canonical workspace aggregate - trust_workspaces is. Retained only because it is the foreign-key parent of 93 Engine 06-60 tables. Never written by the trust runtime. Retirement condition: persistence.domain-store-durability.'],
    ARRAY['workspace_memberships',
      'DEPRECATED. Not the canonical membership aggregate - trust_memberships is. Retained only because has_active_workspace_membership() reads it and the Engine 06-60 RLS policies call that function. Never written by the trust runtime. Retirement condition: persistence.domain-store-durability.'],
    ARRAY['user_identities',
      'DEPRECATED. Not the canonical identity aggregate - trust_records is. Retained only as the foreign-key parent of workspace_memberships, which is itself retained. Never written by the trust runtime. Retirement condition: persistence.domain-store-durability.']
  ];
  i INT;
BEGIN
  FOR i IN 1 .. array_length(retained, 1) LOOP
    target := retained[i][1];
    note   := retained[i][2];
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      EXECUTE format('COMMENT ON TABLE %I IS %L', target, note);

      -- Belt as well as braces on the privilege side. The RLS migration granted the runtime
      -- role nothing on these tables, so this revokes what was never granted — but a grant
      -- added later, by a console session or a well-meaning operator, is precisely how a
      -- deprecated object becomes a second writable model.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
        EXECUTE format(
          'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM assurapay_app', target);
      END IF;
    END IF;
  END LOOP;
END
$deprecate$;

-- On whichever schema this migration is applied to, not a hard-coded `public`: the integration
-- harness applies it to a throwaway schema, and commenting `public` from there would annotate
-- a schema this run never touched.
DO $annotate$
BEGIN
  EXECUTE format(
    'COMMENT ON SCHEMA %I IS %L',
    current_schema(),
    'Trust aggregates are owned by the trust_* tables and by no others. See '
    'packages/database/src/schema-ownership.ts for the executable registry. Engine 06-60 '
    'domain state is not owned by any relational object yet - see persistence.domain-store-durability.'
  );
END
$annotate$;

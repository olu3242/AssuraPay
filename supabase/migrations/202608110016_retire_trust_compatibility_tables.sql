-- Retires `workspaces`, `workspace_memberships` and `user_identities`.
--
-- These are the three trust-domain compatibility tables `202608080001` was forced to retain, and this is the
-- retirement condition it named: `persistence.domain-store-durability`. Twelve batches later, the condition is
-- met — and it took two corrections to the record to see that clearly.
--
-- ## What actually held them, measured rather than assumed
--
-- `schema-ownership.ts` recorded `workspaces` as the foreign-key parent of **93** Engine 06-60 tables.
-- Batch J re-measured it at **16**, because Batches A-I had converged the other 77 onto `trust_workspaces` as
-- they activated them. Batch K took it to **10**, and Batch L to **1**:
--
--     workspaces            -> workspace_memberships          (1 child)
--     workspace_memberships -> (nothing)                      (0 children)
--     user_identities       -> workspace_memberships          (1 child)
--
-- The three now reference only each other, and the single remaining policy calling
-- `has_active_workspace_membership()` is on `workspace_memberships` itself. Nothing outside the set touches
-- any of them, so all three drop together — which is why this is one migration rather than three.
--
-- Batch J's own note recorded that the code half of the capability did *not* free these tables, and that what
-- would free them was activating the two deferred batches. That turned out to be exactly right, and stating
-- it then rather than dropping the tables prematurely is why this migration can be a plain DROP instead of a
-- CASCADE that would have taken two unwritten batches' schemas with it.
--
-- ## Refusing rather than discarding
--
-- The trust runtime has never written these tables — `certifySchemaOwnership` verifies the runtime role holds
-- no privilege on any of them, rather than trusting it — so on any host that ran the trust migrations they are
-- empty. But an older deployment may hold rows from before `trust_workspaces` existed, and those rows are the
-- only copy of that history. So this refuses and names the counts rather than dropping data no one asked it to
-- drop. `202608080001` refuses the same way for the same reason.
--
-- ## The functions go too
--
-- `has_active_workspace_membership()` reads `workspace_memberships` and `current_workspace_id()` is the
-- superseded scope accessor that predated `trust_current_workspace()`. Both are dropped once nothing calls
-- them: a function that reads a table which no longer exists is a trap for whoever writes the next policy,
-- because it resolves and then fails at runtime instead of at creation.

DO $retire$
DECLARE
  retiring CONSTANT TEXT[] := ARRAY['workspace_memberships', 'workspaces', 'user_identities'];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  -- Nothing to do on a database that never had them.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ANY(retiring)
  ) THEN
    RETURN;
  END IF;

  FOREACH target IN ARRAY retiring LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
    IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'TRUST_COMPATIBILITY_RETIREMENT_REFUSED: % table(s) hold rows: %. These are the deprecated '
      'trust-domain tables superseded by trust_workspaces, trust_memberships and trust_identities. The '
      'trust runtime never writes them, so rows here predate that runtime and are the only copy of that '
      'history. Nothing has been dropped. Migrate the rows deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  -- The closure check, in the direction that matters: anything outside the set still referencing it. This is
  -- the guard that would have caught a premature retirement, and it is why the batches came first.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(retiring)
      AND NOT (c.conrelid::regclass::text = ANY(retiring))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'TRUST_COMPATIBILITY_RETIREMENT_REFUSED: foreign key(s) from outside the retiring set still '
      'reference it: %. Dropping these tables would require CASCADE, which would take those tables with '
      'them. Activate the batches that own them first. Nothing has been dropped.',
      array_to_string(intruder, ', ');
  END IF;

  -- And any policy still calling the function that reads `workspace_memberships`, other than on the
  -- retiring tables themselves. A policy left calling a function whose table is gone fails at query time
  -- rather than at creation, which is the worst place to find out.
  FOR rec IN
    SELECT tablename AS tbl FROM pg_policies
    WHERE schemaname = current_schema()
      AND qual LIKE '%has_active_workspace_membership%'
      AND NOT (tablename = ANY(retiring))
  LOOP
    intruder := intruder || format('policy on %s', rec.tbl);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'TRUST_COMPATIBILITY_RETIREMENT_REFUSED: policy/policies still call '
      'has_active_workspace_membership(), which reads workspace_memberships: %. Converge those tables onto '
      'the trust scope first. Nothing has been dropped.',
      array_to_string(intruder, ', ');
  END IF;

  -- One statement, so PostgreSQL resolves the order among the three itself. No CASCADE: by this point
  -- nothing outside the set depends on them, and CASCADE would hide it if something did.
  DROP TABLE IF EXISTS workspace_memberships, workspaces, user_identities;

  -- The functions, now that nothing reads the table behind them. `current_workspace_id()` is the superseded
  -- scope accessor `trust_current_workspace()` replaced.
  DROP FUNCTION IF EXISTS has_active_workspace_membership(UUID);
  DROP FUNCTION IF EXISTS has_active_workspace_membership(TEXT);
  DROP FUNCTION IF EXISTS current_workspace_id();
END
$retire$;

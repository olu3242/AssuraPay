-- Batch D answers to the trust runtime, and a hold answers to nobody.
--
-- Batch D is the dispute-and-remediation set of the accepted wave 4-5 plan: canonical Engine 49 —
-- dispute, dispute evidence, dispute position, dispute decision, dispute hold. It is the last batch,
-- and it closes the constraint the whole platform is named for.
--
-- THE CLOSURE IS THE FIVE, AND NOTHING REFERENCES THEM.
--
-- Computed against a live migrated instance, as for Batches B and C. Every outbound foreign key from
-- these five goes to `disputes` (inside the closure) or to `workspaces` (which convergence
-- replaces), and **no table outside the five references any of them**. It is the cleanest closure in
-- the programme, which is why Batch D is last and not first: it depends on B and C for its linkage
-- targets, and nothing depends on it.
--
-- All five hold zero rows, re-verified below at apply time rather than assumed.
--
-- TWO DEFECTS, AND THE SECOND ONE STOPS MONEY FOREVER
--
-- 1. `disputes` carries **no trigger at all**, while `DisputeResolutionEngine` transitions it
--    OPEN -> MEDIATION -> DECIDED -> APPEALED -> CLOSED. Arbitrary UPDATE and DELETE are permitted,
--    so a dispute could simply be deleted — and since a dispute is what places a hold, deleting one
--    is how a blocked release gets unblocked without anybody resolving anything.
--
-- 2. `dispute_holds` carries a **blanket append-only trigger**, while `DisputeResolutionEngine.close`
--    releases every active hold by writing `active = false, released_at = now()`. That UPDATE would
--    have been refused. **A hold could never be lifted.** A dispute could be raised and never
--    closed, and the release request it holds would be blocked permanently — funds committed at the
--    provider, work certified, and no path to release them.
--
--    This is the fourth instance of the blanket-append-only defect, after five tables in
--    `202608100001` and three in `202608100002`, and it is the worst of them. The others refused a
--    state transition. This one refuses the *removal of a block on money*, which fails in the
--    direction that looks like caution and is actually a permanent freeze.
--
--    Corrected the same way and with the functions `202608100001` created. A released hold is
--    terminal on `active = false`: re-activating one would let a release be blocked again with no
--    new dispute behind it, which is a hold nobody raised.
--
-- HOLD ENFORCEMENT, WHICH IS THIS BATCH'S EXIT GATE AND CLAUDE.md's SECOND HARD CONSTRAINT
--
-- "Release requires a valid Completion Certificate, Payment Eligibility record, approved Financial
-- Entitlement, funding confirmation, authority approval **and no active hold**."
--
-- Today, "no active hold" is enforced nowhere:
--
--   * `DisputeResolutionEngine.isHeld` exists and computes the right answer, and **no code path
--     calls it**. Not the release orchestration engine, not the payment execution engine, not a
--     route.
--   * `FinalSettlementEngine.close` takes `noOpenDisputes: boolean` **as a parameter**. The caller
--     asserts that nothing blocks closure. That is the weakest possible form of the constraint: the
--     party who wants the money released is the one who declares nothing is stopping it.
--
-- A hold is a cross-row property — it lives in another table than the thing it blocks — so no CHECK
-- and no schema can express it, and MONETARY_INVARIANTS is explicit that an invariant PostgreSQL can
-- enforce must not exist only as an application check. It gets triggers, at all three points where
-- a hold must bite:
--
--   * `release_requests` reaching CONDITIONS_MET — the release decision itself;
--   * `payment_instructions` being issued at all — the money movement, because an instruction could
--     otherwise be issued against a request that reached CONDITIONS_MET before the hold was placed;
--   * `final_settlement_accounts` reaching CLOSED — because closing an account with a live dispute
--     against its milestone is the same violation wearing a different noun, and it is the one place
--     the constraint was "enforced" by a caller-supplied boolean.
--
-- WHY THE LINKAGE KEYS CARRY WORKSPACE
--
-- `disputes.release_request_id` and `dispute_holds.release_request_id` had **no foreign key at all**
-- — the fourth and fifth instances of that defect, after `authorization_decisions` in Batch B and
-- `payment_instructions` in Batch C. They are restored composite on
-- `(tenant_id, workspace_id, release_request_id)` rather than the usual `(tenant_id, ...)`, and the
-- extra column is load-bearing rather than tidy:
--
--   the hold-enforcement triggers read `dispute_holds` **as the caller**, not as SECURITY DEFINER,
--   so under FORCE row-level security they see only the caller's tenant *and workspace*. A hold in
--   the same tenant but another workspace would be invisible, the count would come back zero, and
--   the release would proceed past a hold that exists. Forcing a hold into the same workspace as the
--   release request it holds makes the caller's own scope provably sufficient — so the trigger needs
--   no elevated authority to be correct, which is the outcome worth having.
--
-- This needs a `UNIQUE (tenant_id, workspace_id, id)` on `release_requests`. Added here, additively.
--
-- NO HISTORICAL MIGRATION IS MODIFIED. Forward-only, additive, and refusing rather than coercing.

DO $batch_d$
DECLARE
  closure CONSTANT TEXT[] := ARRAY[
    'disputes', 'dispute_evidence', 'dispute_positions', 'dispute_decisions', 'dispute_holds'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  FOREACH target IN ARRAY closure LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
      IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
    END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE5_BATCH_D_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table, and it adds hold '
      'enforcement that existing rows would have to already satisfy. Nothing has been changed. '
      'Backfill and convert deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(closure)
      AND NOT (c.conrelid::regclass::text = ANY(closure))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE5_BATCH_D_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Policies first: PostgreSQL refuses to alter the type of a column a policy predicates on.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    FOR rec IN
      SELECT policyname AS name FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = target
    LOOP
      EXECUTE format('DROP POLICY %I ON %I', rec.name, target);
    END LOOP;
  END LOOP;

  -- Step 2. Every foreign key on the closure. All recreated below, tenant-composite.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(closure)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. Converge identity on TEXT. Every UUID column, not only the keys: `raised_by`,
  -- `submitted_by`, `decided_by` and `party_id` are trust principals, and a UUID column cannot hold
  -- one.
  FOR rec IN
    SELECT c.table_name AS tbl, c.column_name AS col, c.column_default AS def
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(closure)
      AND c.data_type = 'uuid'
  LOOP
    IF rec.def IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', rec.tbl, rec.col);
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TEXT USING %I::text', rec.tbl, rec.col, rec.col);
    IF rec.def IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT gen_random_uuid()::text', rec.tbl, rec.col);
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(%I) BETWEEN 1 AND 200)',
      rec.tbl, rec.tbl || '_' || rec.col || '_len', rec.col);
  END LOOP;

  -- Step 4. Tenant scope, concurrency, schema versioning, and the parent-side uniques.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT', target);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES trust_tenants(tenant_id)',
      target, target || '_tenant_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (version >= 1)', target, target || '_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version >= 1)',
      target, target || '_schema_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      target);

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES trust_workspaces(workspace_id)',
      target, target || '_workspace_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
      'REFERENCES trust_workspaces(tenant_id, workspace_id)',
      target, target || '_tenant_workspace_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', target, target || '_tenant_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
  END LOOP;

  -- Step 5. Trust-runtime policies, FORCE, and the runtime grants.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace()) '
      'WITH CHECK (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace())',
      target || '_trust_scope', target);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  -- No DELETE. A dispute that can be deleted is a hold that can be deleted, and a hold that can be
  -- deleted is not a hold.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY closure LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
    END LOOP;
  END IF;
END
$batch_d$;

-- Step 6. The linkage graph, and the workspace-composite parent the hold triggers depend on.
DO $graph$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'disputes'
  ) THEN RETURN; END IF;

  -- The referenced side of the workspace-composite linkage keys. See this file's header: the extra
  -- column is what lets the hold triggers be correct while reading as the caller under FORCE RLS.
  ALTER TABLE release_requests
    ADD CONSTRAINT release_requests_tenant_workspace_id_unique UNIQUE (tenant_id, workspace_id, id);

  -- New, not restored. Both of these columns had no foreign key at all, so a dispute — and worse, a
  -- *hold* — could name a release request that does not exist. A hold against nothing blocks
  -- nothing, and would read in every report as protection that was in place.
  ALTER TABLE disputes
    ADD CONSTRAINT disputes_release_request_fk
    FOREIGN KEY (tenant_id, workspace_id, release_request_id)
    REFERENCES release_requests (tenant_id, workspace_id, id);

  ALTER TABLE dispute_holds
    ADD CONSTRAINT dispute_holds_release_request_fk
    FOREIGN KEY (tenant_id, workspace_id, release_request_id)
    REFERENCES release_requests (tenant_id, workspace_id, id);

  -- Restored tenant-composite, closing the hole row-level security cannot: foreign key checks run as
  -- the table owner and are not subject to RLS.
  ALTER TABLE dispute_evidence
    ADD CONSTRAINT dispute_evidence_dispute_fk
    FOREIGN KEY (tenant_id, dispute_id) REFERENCES disputes (tenant_id, id);

  ALTER TABLE dispute_positions
    ADD CONSTRAINT dispute_positions_dispute_fk
    FOREIGN KEY (tenant_id, dispute_id) REFERENCES disputes (tenant_id, id);

  ALTER TABLE dispute_decisions
    ADD CONSTRAINT dispute_decisions_dispute_fk
    FOREIGN KEY (tenant_id, dispute_id) REFERENCES disputes (tenant_id, id);

  ALTER TABLE dispute_holds
    ADD CONSTRAINT dispute_holds_dispute_fk
    FOREIGN KEY (tenant_id, dispute_id) REFERENCES disputes (tenant_id, id);
END
$graph$;

-- Step 7. The single-row and natural-uniqueness rules the engine enforces alone today.
DO $invariants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'dispute_holds'
  ) THEN RETURN; END IF;

  -- A released hold records when. Without this a hold could be deactivated with no time it was
  -- lifted, and the audit chain could not say how long money was blocked.
  ALTER TABLE dispute_holds
    ADD CONSTRAINT dispute_holds_released_at_follows_active
    CHECK ((NOT active) = (released_at IS NOT NULL));

  -- One active hold per dispute per release request. `raise` places exactly one; a second active row
  -- for the same pair could only come from a retry or a direct statement, and it would have to be
  -- released twice to unblock the release.
  CREATE UNIQUE INDEX IF NOT EXISTS dispute_holds_one_active_per_dispute_request
    ON dispute_holds (tenant_id, dispute_id, release_request_id)
    WHERE active;

  -- One decision per dispute. `decide` requires OPEN or MEDIATION and moves the dispute to DECIDED,
  -- so a second decision is unreachable through the engine — and two decisions on one dispute would
  -- leave which one resolved it undecidable.
  ALTER TABLE dispute_decisions
    ADD CONSTRAINT dispute_decisions_one_per_dispute UNIQUE (tenant_id, dispute_id);
END
$invariants$;

-- Step 8. Hold enforcement.
--
-- CLAUDE.md hard constraint 2 requires that release happen only with "no active hold". This is where
-- that stops being a sentence in a document. Both functions read `dispute_holds` as the caller
-- rather than as SECURITY DEFINER, which is safe precisely because the linkage keys added above
-- force a hold into the same workspace as the release request it holds.

CREATE OR REPLACE FUNCTION enforce_no_active_dispute_hold() RETURNS trigger
LANGUAGE plpgsql AS $hold$
DECLARE
  -- Argument 0: the status value that constitutes release, or '*' for "any write at all".
  -- Argument 1: the column naming the release request.
  guarded        TEXT := TG_ARGV[0];
  link_column    TEXT := TG_ARGV[1];
  candidate      TEXT;
  release_status TEXT;
  held           BIGINT;
BEGIN
  IF guarded <> '*' THEN
    release_status := to_jsonb(NEW) ->> 'status';
    -- Not the guarded state, so nothing is being released and nothing needs checking.
    IF release_status IS DISTINCT FROM guarded THEN RETURN NEW; END IF;
  END IF;

  candidate := to_jsonb(NEW) ->> link_column;
  IF candidate IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO held
    FROM dispute_holds
    WHERE tenant_id = NEW.tenant_id
      AND workspace_id = NEW.workspace_id
      AND release_request_id = candidate
      AND active;

  IF held > 0 THEN
    RAISE EXCEPTION
      'ACTIVE_DISPUTE_HOLD: % active hold(s) on release request %. Release requires no active hold, '
      'and a hold is lifted by resolving the dispute that placed it, not by writing past it.',
      held, candidate;
  END IF;

  RETURN NEW;
END
$hold$;

COMMENT ON FUNCTION enforce_no_active_dispute_hold() IS
  'Refuses a release-bearing write while an active dispute hold names the release request. Argument 0 is the status that constitutes release, or ''*'' for any write; argument 1 is the column naming the release request.';

-- The milestone-linked variant. A final settlement account references a milestone rather than a
-- release request, so the hold is reached through the release requests for that milestone. This is
-- the point where the constraint was previously "enforced" by `noOpenDisputes`, a boolean the caller
-- passes in — so the database refusing regardless is the whole improvement.
CREATE OR REPLACE FUNCTION enforce_no_active_dispute_hold_for_milestone() RETURNS trigger
LANGUAGE plpgsql AS $hold_ms$
DECLARE
  guarded        TEXT := TG_ARGV[0];
  account_status TEXT;
  held           BIGINT;
BEGIN
  account_status := to_jsonb(NEW) ->> 'status';
  IF account_status IS DISTINCT FROM guarded THEN RETURN NEW; END IF;

  SELECT count(*) INTO held
    FROM dispute_holds h
    JOIN release_requests r
      ON r.tenant_id = h.tenant_id
     AND r.workspace_id = h.workspace_id
     AND r.id = h.release_request_id
    WHERE h.tenant_id = NEW.tenant_id
      AND h.workspace_id = NEW.workspace_id
      AND r.milestone_id = NEW.milestone_id
      AND h.active;

  IF held > 0 THEN
    RAISE EXCEPTION
      'ACTIVE_DISPUTE_HOLD: % active hold(s) against milestone %. A settlement account does not '
      'close over a live dispute, and the caller''s own assurance that none exists is not evidence.',
      held, NEW.milestone_id;
  END IF;

  RETURN NEW;
END
$hold_ms$;

COMMENT ON FUNCTION enforce_no_active_dispute_hold_for_milestone() IS
  'Refuses closing a final settlement account while an active dispute hold names any release request for its milestone.';

DO $hold_triggers$
BEGIN
  -- The release decision itself. INSERT as well as UPDATE: a request created directly at
  -- CONDITIONS_MET would otherwise skip the check entirely.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'release_requests'
  ) THEN
    DROP TRIGGER IF EXISTS release_requests_no_active_hold ON release_requests;
    CREATE TRIGGER release_requests_no_active_hold
      BEFORE INSERT OR UPDATE ON release_requests
      FOR EACH ROW EXECUTE FUNCTION enforce_no_active_dispute_hold('CONDITIONS_MET', 'id');
  END IF;

  -- The money movement. Any instruction at all, whatever its status: an instruction could otherwise
  -- be issued against a request that reached CONDITIONS_MET before the hold was placed.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'payment_instructions'
  ) THEN
    DROP TRIGGER IF EXISTS payment_instructions_no_active_hold ON payment_instructions;
    CREATE TRIGGER payment_instructions_no_active_hold
      BEFORE INSERT ON payment_instructions
      FOR EACH ROW EXECUTE FUNCTION enforce_no_active_dispute_hold('*', 'release_request_id');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'final_settlement_accounts'
  ) THEN
    DROP TRIGGER IF EXISTS final_settlement_accounts_no_active_hold ON final_settlement_accounts;
    CREATE TRIGGER final_settlement_accounts_no_active_hold
      BEFORE INSERT OR UPDATE ON final_settlement_accounts
      FOR EACH ROW EXECUTE FUNCTION enforce_no_active_dispute_hold_for_milestone('CLOSED');
  END IF;
END
$hold_triggers$;

-- Step 9. Mutation boundaries, using the functions `202608100001` created.
DO $transitions$
DECLARE
  governed CONSTANT JSONB := $spec$
  [
    { "table": "disputes", "status": "status", "terminal": ["CLOSED"],
      "immutable": ["id","tenant_id","workspace_id","release_request_id","kind","description","raised_by","created_at","schema_version"] },
    { "table": "dispute_holds", "status": "active", "terminal": ["false"],
      "immutable": ["id","tenant_id","workspace_id","dispute_id","release_request_id","placed_at","schema_version"] }
  ]
  $spec$::JSONB;

  -- Never transitioned by any canonical engine. Evidence, positions and decisions are submissions —
  -- a retraction is a new record, never an edit, because a dispute's record of who said what is the
  -- thing an appeal is decided on.
  append_only CONSTANT TEXT[] := ARRAY[
    'dispute_evidence', 'dispute_positions', 'dispute_decisions'
  ];

  spec      JSONB;
  target    TEXT;
  arguments TEXT;
  missing   TEXT[] := '{}';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(governed) AS entries(value) LOOP
    target := spec ->> 'table';
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    -- Replaced, not supplemented. For `dispute_holds` this is the correction that matters: leaving
    -- the blanket trigger would keep every hold unreleasable.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_terminal_state', target);

    SELECT string_agg(format('%L', value), ', ' ORDER BY position)
      INTO arguments
      FROM jsonb_array_elements_text(spec -> 'immutable')
             WITH ORDINALITY AS columns(value, position);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION enforce_governed_aggregate_transition(%s)',
      target || '_governed_transition', target, arguments);

    -- `dispute_holds` names a boolean column, and `to_jsonb(OLD) ->> 'active'` renders it as
    -- 'true'/'false' — so 'false' is a terminal *state* here in exactly the same sense CLOSED is for
    -- a dispute. A released hold that could be re-activated would block a release with no new
    -- dispute behind it.
    SELECT format('%L', spec ->> 'status') || ', ' ||
           string_agg(format('%L', value), ', ' ORDER BY position)
      INTO arguments
      FROM jsonb_array_elements_text(spec -> 'terminal')
             WITH ORDINALITY AS states(value, position);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION enforce_terminal_aggregate_state(%s)',
      target || '_terminal_state', target, arguments);
  END LOOP;

  FOREACH target IN ARRAY append_only LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()
        AND c.relname = target AND t.tgname = target || '_append_only'
    ) THEN
      missing := missing || format('%s(append_only)', target);
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE5_BATCH_D_AUTHORITY_REFUSED: expected mutation boundary absent on %. Nothing has been '
      'changed.',
      array_to_string(missing, ', ');
  END IF;
END
$transitions$;

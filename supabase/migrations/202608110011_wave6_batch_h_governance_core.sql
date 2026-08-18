-- Batch H activates governance core, and closes an unconditional release path.
--
-- Eleven aggregates for canonical Engines 06-10 — governed execution, execution history, governed
-- milestone, milestone dependency, definition-of-done version, definition-of-done evaluation,
-- certification request, certification decision, digital certification record, payment trigger
-- definition, payment authorization proposal. `202608030006` and `202608030007` created their tables and
-- no production reader or writer, so this converges rather than creates.
--
-- The closure is the tightest of any batch: all thirty-two of its foreign keys point inside the eleven or
-- at the deprecated `workspaces` table, and nothing outside references any of them. Both facts are
-- re-verified at apply time, because they are facts about the database rather than about this file.
--
-- Structural facts, verified against a live migrated instance: `workspace_id UUID NOT NULL REFERENCES
-- workspaces(id)` on all eleven — the deprecated compatibility table — no `tenant_id` anywhere, identity
-- UUID against a TEXT trust runtime, and no `schema_version` or `updated_at`.
--
-- ## The defect this batch found
--
-- Batch G found triggers that refused what its engines did. Batch H found the opposite, and worse.
--
-- Only three of the eleven tables carry a mutation boundary of any kind — `certification_decisions`,
-- `digital_certification_records` and `execution_history` — and those three are correct. That is the first
-- time a batch's historical boundary has agreed with its engines. The other eight have nothing.
--
-- Four of those eight are the aggregates that gate a release:
--
--   * `dod_evaluations.mandatory_passed` is what `PaymentTriggerEngine.evaluate` reads to decide whether
--     `DOD_NOT_SATISFIED` blocks the release;
--   * `payment_trigger_definitions.amount_minor` is the sum a proposal inherits;
--   * `payment_authorization_proposals.status` is what `createEscrowReleaseIntent` reads — and nothing
--     else — before calling the provider adapter to create a real release intent;
--   * `payment_authorization_proposals.blockers` is the record of why it should not.
--
-- No engine ever updates a proposal. `propose()` appends one and that is the entire lifecycle. So on the
-- durable store, a BLOCKED proposal carrying `['DOD_NOT_SATISFIED', 'CERTIFICATION_REQUIRED']` was one
-- statement away from authorising a release:
--
--   UPDATE payment_authorization_proposals SET status = 'PROPOSED', blockers = '[]' WHERE id = ...;
--
-- after which `createEscrowReleaseIntent` instructs the certified Financial Provider to release funds for
-- work that was never certified. CLAUDE.md's second hard constraint says no unconditional "release now"
-- path exists. One did, and it needed no privilege beyond the write access the application already has.
--
-- This migration makes all seven append-only aggregates append-only *in the database*, and gives the four
-- their engines do transition governed-transition triggers naming everything except the columns the
-- lifecycle moves.
--
-- ## `version` carries two different meanings, so the triggers watch two different columns
--
--   * `governed_executions`, `governed_milestones` and `certification_requests` — the engine writes
--     `previous.version + 1` on every transition, so `version` *is* the concurrency counter and the
--     trigger's default is exactly right. No `row_version` is added: a second counter nothing maintains
--     would be worse than none.
--   * `dod_versions` — `version` is the revision the definition *is*, counted as `prior.length + 1`. It is
--     immutable, and `row_version` carries concurrency instead, the arrangement Batch E introduced.
--   * `payment_trigger_definitions` — written once as 1 and never changed, and the table is append-only,
--     so the append-only trigger already holds it.
--
-- ## The keys `202608110010` deferred
--
-- That migration scoped six tenant-blind unique keys on routed tables and deliberately left the rest,
-- saying "the batch that activates each one is the batch that should carry its key across". Six of those
-- deferred keys are on these eleven tables, and this is that batch, so they are carried across here.

DO $batch_h$
DECLARE
  closure CONSTANT TEXT[] := ARRAY[
    'governed_executions', 'execution_history', 'governed_milestones', 'milestone_dependencies',
    'dod_versions', 'dod_evaluations', 'certification_requests', 'certification_decisions',
    'digital_certification_records', 'payment_trigger_definitions', 'payment_authorization_proposals'
  ];
  -- Append-only in the engines. Seven of eleven, and four of the seven had nothing enforcing it.
  append_only CONSTANT TEXT[] := ARRAY[
    'execution_history', 'milestone_dependencies', 'dod_evaluations', 'certification_decisions',
    'digital_certification_records', 'payment_trigger_definitions', 'payment_authorization_proposals'
  ];
  -- Transitioned by their engines, and therefore governed rather than append-only.
  governed CONSTANT TEXT[] := ARRAY[
    'governed_executions', 'governed_milestones', 'certification_requests', 'dod_versions'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
    IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE6_BATCH_H_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table. Nothing has been changed. '
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
      'WAVE6_BATCH_H_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
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

  -- Step 2. Every foreign key on the closure, including the eleven pointing at the deprecated
  -- `workspaces`. All recreated below against the trust runtime.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(closure)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. The tenant-blind unique keys `202608110010` deferred to this batch. Dropped here and re-added
  -- tenant-and-workspace-scoped in step 6, so the rule is never absent within the transaction. A key on
  -- `(certificate_number)` alone means one tenant issuing certificate AP-CERT-2026-000001 stops every
  -- other tenant from issuing theirs, and the engine numbers certificates by counting its own rows — so
  -- every tenant produces the same first number.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'u' AND c.conrelid::regclass::text = ANY(closure)
      AND pg_get_constraintdef(c.oid) NOT LIKE '%tenant_id%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%workspace_id%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 4. Converge identity on TEXT. Every UUID column, not only the keys: `owner_user_id`, `actor_id`,
  -- `reviewer_id`, `issued_by` and `proposed_by` are trust principals, and a UUID column cannot hold one.
  -- A table's columns are converted in one ALTER so multi-column constraints stay valid at each statement
  -- boundary — `milestone_dependencies` carries `CHECK (predecessor_id <> successor_id)` and would
  -- otherwise fail partway comparing a converted column to an unconverted one.
  FOR rec IN
    SELECT c.table_name AS tbl,
           string_agg(format('ALTER COLUMN %I TYPE TEXT USING %I::text', c.column_name, c.column_name),
                      ', ' ORDER BY c.column_name) AS conversions,
           array_agg(c.column_name ORDER BY c.column_name) AS columns,
           array_agg(c.column_name ORDER BY c.column_name)
             FILTER (WHERE c.column_default IS NOT NULL) AS defaulted
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(closure)
      AND c.data_type = 'uuid'
    GROUP BY c.table_name
  LOOP
    IF rec.defaulted IS NOT NULL THEN
      FOREACH target IN ARRAY rec.defaulted LOOP
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', rec.tbl, target);
      END LOOP;
    END IF;

    EXECUTE format('ALTER TABLE %I %s', rec.tbl, rec.conversions);

    IF rec.defaulted IS NOT NULL THEN
      FOREACH target IN ARRAY rec.defaulted LOOP
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT gen_random_uuid()::text', rec.tbl, target);
      END LOOP;
    END IF;

    FOREACH target IN ARRAY rec.columns LOOP
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(%I) BETWEEN 1 AND 200)',
        rec.tbl, rec.tbl || '_' || target || '_len', target);
    END LOOP;
  END LOOP;

  -- Step 5. Tenant scope, schema versioning, and the parent-side unique keys.
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
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version >= 1)',
      target, target || '_schema_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', target);

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) '
      'REFERENCES trust_workspaces(workspace_id)',
      target, target || '_workspace_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
      'REFERENCES trust_workspaces(tenant_id, workspace_id)',
      target, target || '_tenant_workspace_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', target, target || '_tenant_id_unique');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, workspace_id, id)',
      target, target || '_tenant_workspace_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
  END LOOP;

  -- `row_version` for `dod_versions` only. The three governed tables use their domain `version`, which the
  -- engine already advances, and the seven append-only ones can never advance anything.
  ALTER TABLE dod_versions ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE dod_versions ADD CONSTRAINT dod_versions_row_version_ck CHECK (row_version >= 1);

  -- Step 6. The deferred keys, carried across with both scopes.
  CREATE UNIQUE INDEX IF NOT EXISTS execution_history_ws_sequence_unique
    ON execution_history (tenant_id, workspace_id, execution_id, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS milestone_dependencies_ws_edge_unique
    ON milestone_dependencies (tenant_id, workspace_id, predecessor_id, successor_id);
  CREATE UNIQUE INDEX IF NOT EXISTS dod_versions_ws_milestone_version_unique
    ON dod_versions (tenant_id, workspace_id, milestone_id, version);
  CREATE UNIQUE INDEX IF NOT EXISTS certification_decisions_ws_reviewer_unique
    ON certification_decisions (tenant_id, workspace_id, certification_request_id, reviewer_id);
  CREATE UNIQUE INDEX IF NOT EXISTS digital_certifications_ws_number_unique
    ON digital_certification_records (tenant_id, workspace_id, certificate_number);
  CREATE UNIQUE INDEX IF NOT EXISTS digital_certifications_ws_request_unique
    ON digital_certification_records (tenant_id, workspace_id, certification_request_id);

  -- Step 7. The governed currency set, wherever an amount exists.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = target AND column_name = 'currency'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (currency IN (''NGN'', ''USD''))',
      target, target || '_currency_ck');
  END LOOP;

  -- Step 8. Trust-runtime policies, FORCE row-level security, and the runtime grants.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    -- USING and WITH CHECK both. A USING-only policy hides other tenants' rows while letting a caller
    -- insert into their scope.
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace()) '
      'WITH CHECK (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace())',
      target || '_trust_scope', target);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY closure LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      -- No DELETE, and for the append-only seven no UPDATE either. A privilege withheld is a boundary the
      -- role cannot reach at all, which is stronger than a trigger it reaches and is refused by — and both
      -- are in place, because a privilege can be granted by an operator in a hurry.
      IF target = ANY(append_only) THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I TO assurapay_app', target);
        EXECUTE format('REVOKE UPDATE ON %I FROM assurapay_app', target);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
      END IF;
    END LOOP;
  END IF;

  -- Step 9. The mutation boundary the eight tables never had.
  FOREACH target IN ARRAY append_only LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    -- Dropped by name first so the three that already have one are rebuilt identically rather than
    -- duplicated, and so a trigger added by other means cannot survive as a second boundary.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',
      target || '_append_only', target);
  END LOOP;

  FOREACH target IN ARRAY governed LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
  END LOOP;
END
$batch_h$;

-- `digital_certification_records` keeps the trigger name `202608030007` gave it, which does not follow the
-- table name. Renamed here so the boundary is findable from the table, and so the loop above — which
-- derives the name from the table — does not leave the old one in place beside the new one.
DROP TRIGGER IF EXISTS digital_certifications_append_only ON digital_certification_records;

-- Written out rather than looped, because each table's immutable set is a different claim about what the
-- aggregate is, and a loop would hide four different claims behind one statement.

-- `state`, the two timestamps and `updated_at` move; nothing else. The contract an execution governs is
-- fixed at creation: a `contract_id` that could be rewritten would let a completed execution be reassigned
-- to a different agreement after the fact, taking its history with it.
CREATE TRIGGER governed_executions_governed_transition
  BEFORE UPDATE OR DELETE ON governed_executions
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'id', 'tenant_id', 'workspace_id', 'contract_id', 'title', 'owner_user_id', 'created_at',
    'schema_version');

-- `state` and `updated_at` move. `duration_days` does not: `project()` computes the execution's schedule
-- from these, so a duration that could change after planning would move a completion date that other
-- milestones depend on.
CREATE TRIGGER governed_milestones_governed_transition
  BEFORE UPDATE OR DELETE ON governed_milestones
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'id', 'tenant_id', 'workspace_id', 'execution_id', 'parent_milestone_id', 'title', 'owner_user_id',
    'duration_days', 'created_at', 'schema_version');

-- `status`, `reviewer_ids` and `updated_at` move — reviewers can be added while a request is open.
-- `dod_evaluation_id` and `requested_by` cannot: the evaluation is the evidence the certification rests
-- on, and the requester is half of the independence rule that stops self-certification.
CREATE TRIGGER certification_requests_governed_transition
  BEFORE UPDATE OR DELETE ON certification_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'id', 'tenant_id', 'workspace_id', 'execution_id', 'milestone_id', 'dod_evaluation_id',
    'requested_by', 'created_at', 'schema_version');

-- Only `status` and `published_at` move, and `version` is immutable because it is the revision the
-- definition *is*. `criteria` and `content_hash` are the standard a release turns on: a published
-- definition whose criteria could be edited is a bar that can be lowered to match the result, and the hash
-- is what makes the citation checkable.
CREATE TRIGGER dod_versions_governed_transition
  BEFORE UPDATE OR DELETE ON dod_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'milestone_id', 'version', 'criteria',
    'created_by', 'created_at', 'content_hash', 'schema_version');

DO $batch_h_invariants$
BEGIN
  -- Single-record rules the engines enforce and the schema did not. Each is checkable from one row, which
  -- is what makes it a constraint rather than a note in a document.

  -- The proposal's status and its blockers are one statement and have to agree. This is the constraint that
  -- closes the release path described in this file's header: `createEscrowReleaseIntent` reads the status
  -- and nothing else, so a PROPOSED row still carrying blockers is an authorised release whose own record
  -- says it should not have been. The append-only trigger stops the row being edited at all; this stops one
  -- being *written* incoherent in the first place.
  --
  -- `jsonb_typeof` first, and not for tidiness: `jsonb_array_length` *raises* on a scalar rather than
  -- returning false, so a constraint that only measures the length turns a malformed row into a confusing
  -- internal error instead of a clean refusal naming the rule it broke. The write is rejected either way;
  -- which one a reader sees is the difference between a diagnosis and a puzzle.
  ALTER TABLE payment_authorization_proposals
    ADD CONSTRAINT payment_authorization_proposals_blockers_follow_status
    CHECK (
      jsonb_typeof(blockers) = 'array'
      AND (status = 'BLOCKED') = (jsonb_array_length(blockers) > 0)
    );

  -- An execution cannot complete without having started, and only a completed one records a completion.
  -- `project()` reads these as the execution's actual span.
  ALTER TABLE governed_executions
    ADD CONSTRAINT governed_executions_completion_follows_start
    CHECK (completed_at IS NULL OR started_at IS NOT NULL);
  ALTER TABLE governed_executions
    ADD CONSTRAINT governed_executions_completed_at_follows_state
    CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL));

  -- A published or superseded definition records when it was published; a draft does not.
  ALTER TABLE dod_versions
    ADD CONSTRAINT dod_versions_published_at_follows_status
    CHECK ((status = 'DRAFT') = (published_at IS NULL));

  -- Zero-day work is not a milestone, which is what `INVALID_DURATION` says.
  ALTER TABLE governed_milestones
    ADD CONSTRAINT governed_milestones_duration_is_positive CHECK (duration_days >= 1);

  -- A milestone cannot be its own parent, and a dependency needs two different milestones. The longer
  -- cycles `MILESTONE_CYCLE` catches are properties of the whole graph and stay in the engine.
  ALTER TABLE governed_milestones
    ADD CONSTRAINT governed_milestones_parent_is_another
    CHECK (parent_milestone_id IS NULL OR parent_milestone_id <> id);

  -- The requester cannot be among their own reviewers. Certification is the point at which work becomes
  -- payable, so self-review is the shape of an unearned release — and `open()` already refuses it, which is
  -- exactly why it belongs here too.
  ALTER TABLE certification_requests
    ADD CONSTRAINT certification_requests_reviewer_is_independent
    CHECK (jsonb_typeof(reviewer_ids) = 'array' AND NOT (reviewer_ids ? requested_by));
  ALTER TABLE certification_requests
    ADD CONSTRAINT certification_requests_has_a_reviewer
    CHECK (jsonb_typeof(reviewer_ids) = 'array' AND jsonb_array_length(reviewer_ids) > 0);

  -- A decision with no rationale is not reviewable, and this record is the evidence a certification was
  -- considered rather than waved through.
  ALTER TABLE certification_decisions
    ADD CONSTRAINT certification_decisions_rationale_present
    CHECK (length(btrim(rationale)) > 0);

  -- An evaluation with no results has evaluated nothing, and `mandatory_passed` over an empty set would be
  -- a satisfied definition of done with no evidence at all.
  ALTER TABLE dod_evaluations
    ADD CONSTRAINT dod_evaluations_has_results
    CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) > 0);
END
$batch_h_invariants$;

DO $batch_h_references$
BEGIN
  -- The closure, workspace-carrying throughout. Every parent is one of the eleven, which is what makes
  -- this graph convertible in a single migration.

  ALTER TABLE execution_history
    ADD CONSTRAINT execution_history_execution_fk
    FOREIGN KEY (tenant_id, workspace_id, execution_id)
    REFERENCES governed_executions (tenant_id, workspace_id, id);

  ALTER TABLE governed_milestones
    ADD CONSTRAINT governed_milestones_execution_fk
    FOREIGN KEY (tenant_id, workspace_id, execution_id)
    REFERENCES governed_executions (tenant_id, workspace_id, id);
  -- Self-referencing, and nullable: a root milestone has no parent. MATCH SIMPLE means the key is not
  -- checked when the column is NULL, which is the behaviour wanted here.
  ALTER TABLE governed_milestones
    ADD CONSTRAINT governed_milestones_parent_fk
    FOREIGN KEY (tenant_id, workspace_id, parent_milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);

  ALTER TABLE milestone_dependencies
    ADD CONSTRAINT milestone_dependencies_execution_fk
    FOREIGN KEY (tenant_id, workspace_id, execution_id)
    REFERENCES governed_executions (tenant_id, workspace_id, id);
  ALTER TABLE milestone_dependencies
    ADD CONSTRAINT milestone_dependencies_predecessor_fk
    FOREIGN KEY (tenant_id, workspace_id, predecessor_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);
  ALTER TABLE milestone_dependencies
    ADD CONSTRAINT milestone_dependencies_successor_fk
    FOREIGN KEY (tenant_id, workspace_id, successor_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);

  ALTER TABLE dod_versions
    ADD CONSTRAINT dod_versions_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);

  ALTER TABLE dod_evaluations
    ADD CONSTRAINT dod_evaluations_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);
  ALTER TABLE dod_evaluations
    ADD CONSTRAINT dod_evaluations_definition_fk
    FOREIGN KEY (tenant_id, workspace_id, definition_id)
    REFERENCES dod_versions (tenant_id, workspace_id, id);

  ALTER TABLE certification_requests
    ADD CONSTRAINT certification_requests_execution_fk
    FOREIGN KEY (tenant_id, workspace_id, execution_id)
    REFERENCES governed_executions (tenant_id, workspace_id, id);
  ALTER TABLE certification_requests
    ADD CONSTRAINT certification_requests_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);
  -- The evidence the certification rests on.
  ALTER TABLE certification_requests
    ADD CONSTRAINT certification_requests_evaluation_fk
    FOREIGN KEY (tenant_id, workspace_id, dod_evaluation_id)
    REFERENCES dod_evaluations (tenant_id, workspace_id, id);

  ALTER TABLE certification_decisions
    ADD CONSTRAINT certification_decisions_request_fk
    FOREIGN KEY (tenant_id, workspace_id, certification_request_id)
    REFERENCES certification_requests (tenant_id, workspace_id, id);

  ALTER TABLE digital_certification_records
    ADD CONSTRAINT digital_certifications_request_fk
    FOREIGN KEY (tenant_id, workspace_id, certification_request_id)
    REFERENCES certification_requests (tenant_id, workspace_id, id);
  ALTER TABLE digital_certification_records
    ADD CONSTRAINT digital_certifications_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);

  ALTER TABLE payment_trigger_definitions
    ADD CONSTRAINT payment_trigger_definitions_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);
  -- The standard the release turns on. Not nullable, so every trigger names one.
  ALTER TABLE payment_trigger_definitions
    ADD CONSTRAINT payment_trigger_definitions_definition_fk
    FOREIGN KEY (tenant_id, workspace_id, required_dod_definition_id)
    REFERENCES dod_versions (tenant_id, workspace_id, id);

  ALTER TABLE payment_authorization_proposals
    ADD CONSTRAINT payment_authorization_proposals_trigger_fk
    FOREIGN KEY (tenant_id, workspace_id, trigger_id)
    REFERENCES payment_trigger_definitions (tenant_id, workspace_id, id);
  ALTER TABLE payment_authorization_proposals
    ADD CONSTRAINT payment_authorization_proposals_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES governed_milestones (tenant_id, workspace_id, id);
  -- Nullable, because a proposal for a trigger that does not require certification carries none.
  ALTER TABLE payment_authorization_proposals
    ADD CONSTRAINT payment_authorization_proposals_certification_fk
    FOREIGN KEY (tenant_id, workspace_id, certification_id)
    REFERENCES digital_certification_records (tenant_id, workspace_id, id);
END
$batch_h_references$;

COMMENT ON TABLE payment_authorization_proposals IS
  'Canonical Engine 10 payment authorization proposal. The record createEscrowReleaseIntent() reads — and nothing else — before instructing a certified Financial Provider, which is why it is append-only in the database as well as in the engine: before 202608110011 a BLOCKED proposal was one UPDATE away from authorising a release for uncertified work. Status and blockers are constrained to agree, so an incoherent row cannot be written either. AssuraPay never holds funds; this row is an instruction, not a transfer.';

COMMENT ON TABLE dod_evaluations IS
  'Canonical Engine 08 definition-of-done evaluation. mandatory_passed is what PaymentTriggerEngine.evaluate reads to decide whether DOD_NOT_SATISFIED blocks a release, so the row is append-only: a flipped boolean would manufacture a satisfied definition of done. An evaluation must carry at least one result.';

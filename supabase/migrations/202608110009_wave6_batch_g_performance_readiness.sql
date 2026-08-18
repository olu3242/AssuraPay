-- Batch G activates performance readiness, and repairs the boundary that had disabled three engines.
--
-- Six aggregates for canonical Engines 26-30 — acceptance criterion, success metric, dependency,
-- payment trigger rule, performance baseline, baseline variance. `202608030005` created their tables
-- with their own constraints and no production reader or writer, the position Batches A and E started
-- from, so this migration converges rather than creates.
--
-- Four structural facts, each verified against a live migrated instance rather than inferred:
--
--   1. `workspace_id UUID NOT NULL REFERENCES workspaces(id)` on all six — the *deprecated*
--      compatibility table, whose write path `202608080001` forbids. The same defect Batch A found.
--   2. No `tenant_id` at all, so no policy could express the tenant boundary.
--   3. Identity is `UUID` while the trust runtime is `TEXT` throughout.
--   4. No `row_version`, `schema_version` or `updated_at`.
--
-- No foreign key from outside the six references any of them, so converting identity is safe. Re-checked
-- at apply time below, because that is a fact about the database and not about this file.
--
-- ## The defect this batch found
--
-- Every batch since A has found a mutation boundary that contradicts its engines. Batch G's is the worst
-- of them, because it silently disables working code rather than merely permitting something it should
-- not.
--
-- `202608030005` put the blanket `prevent_append_only_mutation` trigger on five of the six tables. Three
-- of those five are aggregates their engines transition:
--
--   * `AcceptanceCriteriaEngine.confirm`  — DRAFT → CONFIRMED
--   * `SuccessMetricsEngine.confirm`      — DRAFT → CONFIRMED
--   * `PaymentTriggerRuleEngine.activate` — DRAFT → ACTIVE
--
-- On the durable path all three refuse with `append-only table`. The third is the consequential one.
-- `PaymentTriggerRuleEngine.evaluate` refuses any rule that is not ACTIVE, so a rule that cannot leave
-- DRAFT can never be evaluated — and `paymentEligibility.paymentTriggerRuleId` names that rule as the
-- authority a release rests on. The settlement path has therefore been citing a condition that, on
-- PostgreSQL, could never be satisfied or even assessed. That is a failure of CLAUDE.md's second hard
-- constraint arriving as an absence rather than as a wrong answer, which is why it went unnoticed:
-- nothing produced a bad release, because nothing could produce a release at all.
--
-- So those four tables — the three above plus `dependencies`, which the engine resolves and which
-- carried no trigger of any kind — get governed-transition triggers naming everything except the
-- columns their lifecycle moves. `performance_baselines` and `baseline_variances` keep append-only
-- protection, because a baseline has one status and never moves and a variance is an observation rather
-- than a state.
--
-- ## The reference Batch B had to leave open
--
-- `payment_eligibilities.payment_trigger_rule_id` has been `NOT NULL` with no foreign key since
-- `202608030008`, because the rule it names had no durable home to point at. It becomes a real key at
-- the end of this file. That is the reason Batch G is next in the register rather than later.

DO $batch_g$
DECLARE
  closure CONSTANT TEXT[] := ARRAY[
    'acceptance_criteria', 'success_metrics', 'dependencies', 'payment_trigger_rules',
    'performance_baselines', 'baseline_variances'
  ];
  -- The four whose engines transition them. Kept separate from the closure because the difference
  -- between these and the other two is the whole finding above, and a single list would lose it.
  governed CONSTANT TEXT[] := ARRAY[
    'acceptance_criteria', 'success_metrics', 'dependencies', 'payment_trigger_rules'
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
      'WAVE6_BATCH_G_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
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
      'WAVE6_BATCH_G_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
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

  -- Step 2. Every foreign key on the closure, including the six pointing at the deprecated
  -- `workspaces`. All recreated below against the trust runtime.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(closure)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- `performance_baselines.milestone_id` carries a bare `UNIQUE` from the historical migration, which
  -- is a cross-tenant constraint: one tenant baselining a milestone would refuse the same identifier
  -- to every other tenant. Dropped here and re-added tenant-and-workspace-scoped in step 4, which is
  -- where the engine's own rule — one baseline per milestone per workspace — actually lives.
  FOR rec IN
    SELECT c.conname AS name FROM pg_constraint c
    WHERE c.contype = 'u' AND c.conrelid::regclass::text = 'performance_baselines'
  LOOP
    EXECUTE format('ALTER TABLE performance_baselines DROP CONSTRAINT %I', rec.name);
  END LOOP;

  -- Step 3. Converge identity on TEXT. Every UUID column, not only the keys: `owner_id` and
  -- `recorded_by` are trust principals, and a UUID column cannot hold one. A table's columns are
  -- converted in one ALTER so multi-column constraints stay valid at each statement boundary.
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

  -- Step 4. Tenant scope, concurrency, schema versioning, and the parent-side unique keys.
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

    -- `row_version`, matching Batches E and F. None of these six owns a domain `version`, but the name
    -- is the platform's now and a second convention would be a second thing to remember.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (row_version >= 1)', target, target || '_row_version_ck');
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
    -- Carries the workspace, for the reason `202608110008` gives at length: a key on the tenant alone
    -- lets a child in one workspace reference a parent in another workspace of the same tenant.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, workspace_id, id)',
      target, target || '_tenant_workspace_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
  END LOOP;

  -- The engine's rule, expressed where two concurrent requests cannot both pass it. `baseline()` lists
  -- existing baselines and refuses `BASELINE_ALREADY_SET`, which two callers reading at the same time
  -- both clear.
  ALTER TABLE performance_baselines
    ADD CONSTRAINT performance_baselines_one_per_milestone
    UNIQUE (tenant_id, workspace_id, milestone_id);

  -- Step 5. The governed currency set, wherever an amount exists.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = target AND column_name = 'currency'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (currency IN (''NGN'', ''USD''))',
      target, target || '_currency_ck');
  END LOOP;

  -- Step 6. Trust-runtime policies, FORCE row-level security, and the runtime grants.
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

    -- FORCE, because ENABLE does not constrain the table owner.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY closure LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      -- No DELETE. History here is append-only or supersession-based, and a role that cannot issue the
      -- statement cannot reach a trigger that would refuse it.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
    END LOOP;
  END IF;

  -- Step 7. The mutation boundary, corrected.
  --
  -- The blanket trigger goes on the four the engines transition, replaced by the governed-transition
  -- function naming every column except the ones the lifecycle moves. Dropped by name for each table
  -- rather than by pattern, so a trigger added by other means is not silently left in place.
  FOREACH target IN ARRAY governed LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
  END LOOP;
END
$batch_g$;

-- Written out rather than looped, because each table's immutable set is a different claim about what the
-- aggregate is, and a loop would hide six different claims behind one statement.

-- Only `status` moves. Everything the criterion asserts about how it will be tested is fixed at
-- definition: a validator role or tolerance that could be rewritten after CONFIRMED would let the bar be
-- lowered to match the result.
CREATE TRIGGER acceptance_criteria_governed_transition
  BEFORE UPDATE OR DELETE ON acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'deliverable_id', 'description',
    'test_method', 'metric', 'tolerance', 'validator_role', 'retest_allowed', 'max_retests',
    'created_at', 'schema_version');

-- Only `status` moves. `weight_percent` especially: `confirm()` bounds the confirmed weights for a
-- milestone at 100%, and a weight that could change after confirmation would let the allocation be
-- exceeded one edit at a time without any single write breaking the rule.
CREATE TRIGGER success_metrics_governed_transition
  BEFORE UPDATE OR DELETE ON success_metrics
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'milestone_id', 'kind', 'name',
    'target_value', 'unit', 'direction', 'weight_percent', 'created_at', 'schema_version');

-- `status` and `resolved_at` move together, so both are absent here. `criticality` does not: `blockers()`
-- treats an OPEN BLOCKING dependency as a reason a milestone cannot proceed, and a criticality that could
-- be downgraded in place is a blocker that can be made to disappear without being resolved.
CREATE TRIGGER dependencies_governed_transition
  BEFORE UPDATE OR DELETE ON dependencies
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'milestone_id', 'kind', 'description',
    'owner_id', 'due_date', 'criticality', 'created_at', 'schema_version');

-- Only `status` moves, and the immutable set here is the load-bearing one in this batch. `amount_minor`,
-- `currency`, `rule_type`, `required_dod_package_id` and `required_acceptance_criterion_ids` are the
-- condition a release rests on. A rule whose amount could be rewritten after ACTIVE would let an
-- approved authority release a different sum than the one approved; a rule whose type or required
-- evidence could change would let a condition that has already been evaluated mean something else.
CREATE TRIGGER payment_trigger_rules_governed_transition
  BEFORE UPDATE OR DELETE ON payment_trigger_rules
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'milestone_id', 'name', 'rule_type',
    'required_dod_package_id', 'required_acceptance_criterion_ids', 'amount_minor', 'currency',
    'created_at', 'schema_version');

DO $batch_g_invariants$
BEGIN
  -- Single-record rules the engines enforce and the schema did not. Each is a rule a direct writer could
  -- otherwise break, and each is checkable from one row, which is what makes it a constraint rather than
  -- a note in a document.

  -- `retestAllowed` and `maxRetests` are one decision in two fields. `max_retests >= 0` alone admits
  -- both incoherent readings: retests forbidden with a limit of three, and retests allowed with none.
  ALTER TABLE acceptance_criteria
    ADD CONSTRAINT acceptance_criteria_retest_configuration
    CHECK ((retest_allowed AND max_retests >= 1) OR (NOT retest_allowed AND max_retests = 0));

  -- A BETWEEN tolerance needs an upper bound above its target. Below it, the band admits nothing, so
  -- every measurement fails and the deliverable reads as defective rather than the criterion as
  -- misconfigured.
  ALTER TABLE acceptance_criteria
    ADD CONSTRAINT acceptance_criteria_tolerance_range
    CHECK (
      tolerance ->> 'operator' <> 'BETWEEN'
      OR (
        tolerance ? 'upperBound'
        AND (tolerance ->> 'upperBound')::NUMERIC > (tolerance ->> 'target')::NUMERIC
      )
    );

  -- A metric carrying no weight cannot affect the outcome it claims to measure. The historical check
  -- already bounded the upper end.
  ALTER TABLE success_metrics
    ADD CONSTRAINT success_metrics_weight_is_material CHECK (weight_percent > 0);

  -- A resolution with no time it happened cannot be placed in the audit chain, and an open dependency
  -- carrying one is a contradiction a reader would have to guess about.
  ALTER TABLE dependencies
    ADD CONSTRAINT dependencies_resolved_at_follows_status
    CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL));

  -- What the rule type promises, the rule must carry. Without these a DOD_PUBLISHED rule could name no
  -- package and an ACCEPTANCE_PASSED rule no criteria, and `evaluate()` would then find nothing to check
  -- and report the condition met — a release authorised by a condition that never applied.
  ALTER TABLE payment_trigger_rules
    ADD CONSTRAINT payment_trigger_rules_dod_reference_present
    CHECK (rule_type NOT IN ('DOD_PUBLISHED', 'HYBRID') OR required_dod_package_id IS NOT NULL);
  ALTER TABLE payment_trigger_rules
    ADD CONSTRAINT payment_trigger_rules_acceptance_reference_present
    CHECK (
      rule_type NOT IN ('ACCEPTANCE_PASSED', 'HYBRID')
      OR jsonb_array_length(required_acceptance_criterion_ids) > 0
    );

  -- A plan that finishes before it starts is not a plan, and `recordVariance` measures the schedule
  -- variance in days from the planned due date, so an inverted pair yields a variance that reads as
  -- early delivery.
  ALTER TABLE performance_baselines
    ADD CONSTRAINT performance_baselines_dates_ordered
    CHECK (planned_due_date >= planned_start_date);

  -- An observed cost may be zero but never negative: a negative outlay is not a cost, it is a different
  -- event. The variance columns themselves stay signed, because ahead of schedule and under budget are
  -- as real as their opposites.
  ALTER TABLE baseline_variances
    ADD CONSTRAINT baseline_variances_actual_cost_not_negative
    CHECK (actual_cost_amount_minor IS NULL OR actual_cost_amount_minor >= 0);
  ALTER TABLE baseline_variances
    ADD CONSTRAINT baseline_variances_actual_scope_not_negative
    CHECK (actual_scope_item_count IS NULL OR actual_scope_item_count >= 0);
END
$batch_g_invariants$;

DO $batch_g_parent_keys$
BEGIN
  -- The referenced sides first. `202608110008` gave workspace-carrying unique keys to the parents that
  -- something already referenced, which is why `blueprint_milestones` has one and `deliverables` does
  -- not: nothing pointed at a deliverable until this batch. A foreign key needs a unique key on exactly
  -- its referenced columns and PostgreSQL will not infer one, so the batch that introduces the first
  -- reference to a parent is the batch that has to add it.
  CREATE UNIQUE INDEX IF NOT EXISTS deliverables_ws_id_key
    ON deliverables (tenant_id, workspace_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS blueprint_milestones_ws_id_key
    ON blueprint_milestones (tenant_id, workspace_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS dod_packages_ws_id_key
    ON dod_packages (tenant_id, workspace_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS performance_blueprints_ws_id_key
    ON performance_blueprints (tenant_id, workspace_id, id);
END
$batch_g_parent_keys$;

DO $batch_g_references$
BEGIN
  -- The closure, workspace-carrying throughout. Each parent is durable because an earlier batch made it
  -- so, which is what lets these be keys rather than bare identifiers.

  -- Engine 26's criterion is a criterion *of a deliverable*, made durable by Batch E.
  ALTER TABLE acceptance_criteria
    ADD CONSTRAINT acceptance_criteria_deliverable_fk
    FOREIGN KEY (tenant_id, workspace_id, deliverable_id)
    REFERENCES deliverables (tenant_id, workspace_id, id);

  -- Three aggregates hang off a blueprint milestone, also Batch E.
  ALTER TABLE success_metrics
    ADD CONSTRAINT success_metrics_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES blueprint_milestones (tenant_id, workspace_id, id);
  ALTER TABLE dependencies
    ADD CONSTRAINT dependencies_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES blueprint_milestones (tenant_id, workspace_id, id);
  ALTER TABLE payment_trigger_rules
    ADD CONSTRAINT payment_trigger_rules_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES blueprint_milestones (tenant_id, workspace_id, id);

  -- The definition of done a rule turns on. Nullable, and MATCH SIMPLE means the key is not checked when
  -- the column is NULL — which is right, because only DOD_PUBLISHED and HYBRID rules name one and the
  -- CHECK above is what requires it of them.
  ALTER TABLE payment_trigger_rules
    ADD CONSTRAINT payment_trigger_rules_dod_package_fk
    FOREIGN KEY (tenant_id, workspace_id, required_dod_package_id)
    REFERENCES dod_packages (tenant_id, workspace_id, id);

  ALTER TABLE performance_baselines
    ADD CONSTRAINT performance_baselines_blueprint_fk
    FOREIGN KEY (tenant_id, workspace_id, blueprint_id)
    REFERENCES performance_blueprints (tenant_id, workspace_id, id);
  ALTER TABLE performance_baselines
    ADD CONSTRAINT performance_baselines_milestone_fk
    FOREIGN KEY (tenant_id, workspace_id, milestone_id)
    REFERENCES blueprint_milestones (tenant_id, workspace_id, id);

  -- Intra-closure: a variance is a variance against one baseline.
  ALTER TABLE baseline_variances
    ADD CONSTRAINT baseline_variances_baseline_fk
    FOREIGN KEY (tenant_id, workspace_id, baseline_id)
    REFERENCES performance_baselines (tenant_id, workspace_id, id);
END
$batch_g_references$;

DO $batch_b_hole$
BEGIN
  -- The reference Batch B had to leave open, closed.
  --
  -- `payment_eligibilities.payment_trigger_rule_id` has been NOT NULL with no foreign key since
  -- `202608030008`. Not an oversight: the rule had no durable home, so there was nothing to point at, and
  -- Batch B recorded the gap rather than inventing a key to a table no engine could write. Batch G gives
  -- the rule a home, which is what makes this the batch that closes it.
  --
  -- Validated rather than NOT VALID, and that is a deliberate choice about what the column has meant.
  -- Every row in this table names a rule that could not have been stored, so on a populated deployment
  -- validation will fail — and it should. A dangling authority reference is not legacy data to be
  -- tolerated behind a constraint that quietly excuses it; it is an eligibility record whose stated
  -- condition never existed, and CLAUDE.md's second hard constraint makes that a thing to look at rather
  -- than to grandfather. A deployment in that position must reconcile its eligibility records
  -- deliberately, which is a decision for whoever owns those records and not for this file.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'payment_eligibilities_trigger_rule_fk' AND t.relname = 'payment_eligibilities'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE payment_eligibilities
      ADD CONSTRAINT payment_eligibilities_trigger_rule_fk
      FOREIGN KEY (tenant_id, workspace_id, payment_trigger_rule_id)
      REFERENCES payment_trigger_rules (tenant_id, workspace_id, id);
  END IF;
END
$batch_b_hole$;

COMMENT ON TABLE payment_trigger_rules IS
  'Canonical Engine 29 payment trigger rule. The condition a release rests on: paymentEligibility names it as the authority. Governed rather than append-only, because activate() moves DRAFT to ACTIVE and the blanket trigger 202608030005 installed made that transition — and therefore every evaluation — impossible on PostgreSQL. Every column except status is immutable, so an activated rule cannot be made to authorise a different amount or a different condition.';

COMMENT ON TABLE performance_baselines IS
  'Canonical Engine 30 performance baseline. Append-only and single-status by design: a baseline is the plan as it stood, and revising it would destroy the comparison every variance is measured against. One per milestone per workspace, enforced by a unique key rather than by the engine''s read-then-write.';

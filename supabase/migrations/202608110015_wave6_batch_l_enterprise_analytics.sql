-- Batch L activates enterprise analytics, and makes the platform's AI governance performable.
--
-- Nine aggregates for canonical Engines 56-60 — financial forecast, performance scorecard, portfolio
-- snapshot, renewal assessment, model registration, evaluation record, drift alert, model feedback,
-- recommendation.
--
-- The last batch in the durability register. These nine are all that still reference the deprecated
-- `workspaces`, and all that still predicate their policies on `has_active_workspace_membership()` — which is
-- what has kept `workspace_memberships` and `user_identities` alive. `202608110016` retires all three once
-- this migration has removed their last dependants.
--
-- The closure is exactly the nine, verified against a live instance in both directions: every inbound foreign
-- key comes from inside the batch, all pointing at `model_registrations` — the hub, with four children — and
-- outbound everything pointed at `workspaces` and nothing else.
--
-- ## The defect this batch found, and it is the sharpest of the programme
--
-- Four of the nine are aggregates their engines transition. **Every one of the four was broken, in both
-- possible directions at once**, and they sit in the engine whose own header calls it "the capstone
-- AI-governance engine for the whole platform".
--
-- Three carried a blanket append-only trigger from `202608030009`, so the transition refused:
--
--   * `FinancialPaymentIntelligenceEngine.review` — a financial forecast could never be reviewed. These
--     forecast FUNDING_DELAY, PAYMENT_FAILURE, LEAKAGE and RECONCILIATION_EXCEPTION, so the unreviewable
--     output is about money;
--   * `AiDecisionSupportEngine.deprecateModel` — a model could never be taken out of service.
--     `recordEvaluation` raises a drift alert automatically when a score falls below its threshold, so the
--     platform could detect that a model had gone wrong and then could not act on it;
--   * `AiDecisionSupportEngine.decideRecommendation` — a recommendation could never be accepted or
--     dismissed, while the engine's stated contract is that one "is never auto-executed — it starts PENDING
--     and requires an explicit human decideRecommendation call".
--
-- And the fourth had **no mutation boundary at all**. `drift_alerts` carried no trigger, so
-- `acknowledgeDrift` and `resolveDrift` worked — and so did rewriting a drift alert's severity or deleting
-- it outright. The record that a model has drifted was the one thing in the batch anybody could edit.
--
-- So every human decision point in the platform's AI governance was unperformable on the durable store,
-- while the evidence of model failure was freely editable. This migration inverts both: the four get
-- governed-transition triggers naming exactly what each engine moves, and the five that are measurements
-- get append-only ones.
--
-- ## Derived fields that become real constraints
--
-- `evaluation_records.passed` follows from `score >= threshold`, and both operands are in the row — so unlike
-- Batch K's `kpi_values.on_track`, this is a CHECK rather than an application invariant. It is the most
-- consequential of the three, because a falsified pass does not merely misreport: `recordEvaluation` raises
-- the drift alert only when `passed` is false, so a row claiming a pass below its own threshold suppresses
-- the alert that would have prompted anyone to look.
--
-- `performance_scorecards.overall_score` is the rounded mean of `metrics`, computable from the row.
-- `period_end > period_start` was already constrained by `202608030009` and is kept rather than restated —
-- the one pre-existing invariant in the batch.
--
-- Two status/timestamp pairs must agree: a RESOLVED drift alert has a `resolved_at` and an unresolved one
-- does not; a decided recommendation has a `decided_at` and a PENDING one does not. `openDrifts` filters on
-- status, so a row where the two disagree is visible to one query and invisible to the other.

DO $batch_l$
DECLARE
  conversion CONSTANT TEXT[] := ARRAY[
    'financial_forecasts', 'performance_scorecards', 'portfolio_snapshots', 'renewal_assessments',
    'model_registrations', 'evaluation_records', 'drift_alerts', 'model_feedback', 'recommendations'
  ];
  -- A measurement or a statement made at a moment. No engine passes any of these to `replace`.
  append_only CONSTANT TEXT[] := ARRAY[
    'performance_scorecards', 'portfolio_snapshots', 'renewal_assessments', 'evaluation_records',
    'model_feedback'
  ];
  -- Transitioned. Three were refused by a blanket append-only trigger; `drift_alerts` had no trigger at all.
  governed CONSTANT TEXT[] := ARRAY[
    'financial_forecasts', 'model_registrations', 'drift_alerts', 'recommendations'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  FOREACH target IN ARRAY conversion LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
    IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE6_BATCH_L_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table. Nothing has been changed. '
      'Backfill and convert deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(conversion)
      AND NOT (c.conrelid::regclass::text = ANY(conversion))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE6_BATCH_L_AUTHORITY_REFUSED: foreign key(s) from outside the batch reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Policies first: PostgreSQL refuses to alter the type of a column a policy predicates on. All
  -- nine predicate on `current_workspace_id()` and `has_active_workspace_membership()` — the superseded
  -- pair, and the last reason `workspace_memberships` exists.
  FOREACH target IN ARRAY conversion LOOP
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

  -- Step 2. Every foreign key on the set, including the intra-set ones and those pointing at `workspaces`.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(conversion)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. The tenant-blind unique key on the hub: `model_registrations (workspace_id, model_id,
  -- model_version)`. Named on the workspace but not the tenant, so it is re-added scoped below for
  -- uniformity with every other routed table.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'u' AND c.conrelid::regclass::text = ANY(conversion)
      AND pg_get_constraintdef(c.oid) NOT LIKE '%tenant_id%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 4. Converge identity on TEXT. Every UUID column, not only the keys: `submitted_by`, `assessed_by`,
  -- `party_id`, `scope_id` and `contract_id` are trust principals and cross-aggregate references, and a UUID
  -- column cannot hold one now the runtime keeps them as TEXT.
  FOR rec IN
    SELECT c.table_name AS tbl,
           string_agg(format('ALTER COLUMN %I TYPE TEXT USING %I::text', c.column_name, c.column_name),
                      ', ' ORDER BY c.column_name) AS conversions,
           array_agg(c.column_name ORDER BY c.column_name) AS columns,
           array_agg(c.column_name ORDER BY c.column_name)
             FILTER (WHERE c.column_default IS NOT NULL) AS defaulted
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(conversion)
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

  -- Step 5. Tenant scope, concurrency, schema versioning, and the scoped keys.
  FOREACH target IN ARRAY conversion LOOP
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
    -- None of these nine owns a domain `version`, so `row_version` is the only counter.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (row_version >= 1)', target, target || '_row_version_ck');

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

  -- Step 6. Trust-runtime policies, FORCE row-level security, and the runtime grants.
  FOREACH target IN ARRAY conversion LOOP
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
    -- FORCE, not merely ENABLE. All nine had ENABLE alone, which does not constrain the table owner.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY conversion LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      IF target = ANY(append_only) THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I TO assurapay_app', target);
        EXECUTE format('REVOKE UPDATE ON %I FROM assurapay_app', target);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
      END IF;
    END LOOP;
  END IF;

  -- Step 7. The mutation boundary, in both directions. The five measurements get append-only triggers; the
  -- four the engines transition lose theirs — including `drift_alerts`, which never had one — and get
  -- governed-transition triggers below.
  FOREACH target IN ARRAY append_only LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',
      target || '_append_only', target);
  END LOOP;

  FOREACH target IN ARRAY governed LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
  END LOOP;

  -- The intra-set keys, carried across with both scopes. `model_registrations` is the hub for four children.
  ALTER TABLE evaluation_records
    ADD CONSTRAINT evaluation_records_model_fk
    FOREIGN KEY (tenant_id, workspace_id, model_registration_id)
    REFERENCES model_registrations (tenant_id, workspace_id, id);
  ALTER TABLE drift_alerts
    ADD CONSTRAINT drift_alerts_model_fk
    FOREIGN KEY (tenant_id, workspace_id, model_registration_id)
    REFERENCES model_registrations (tenant_id, workspace_id, id);
  ALTER TABLE model_feedback
    ADD CONSTRAINT model_feedback_model_fk
    FOREIGN KEY (tenant_id, workspace_id, model_registration_id)
    REFERENCES model_registrations (tenant_id, workspace_id, id);
  ALTER TABLE recommendations
    ADD CONSTRAINT recommendations_model_fk
    FOREIGN KEY (tenant_id, workspace_id, model_registration_id)
    REFERENCES model_registrations (tenant_id, workspace_id, id);

  -- The deferred key, re-added tenant-scoped. A model version is registered once per workspace; the original
  -- key named the workspace but not the tenant, which is the shape `202608110010` removed six of.
  CREATE UNIQUE INDEX IF NOT EXISTS model_registrations_tenant_model_version_unique
    ON model_registrations (tenant_id, workspace_id, model_id, model_version);
END
$batch_l$;

-- Written out rather than looped: each immutable set is a different claim about what the aggregate is.

-- Only `review_status` moves. Everything else is the forecast a reviewer read in order to decide — the
-- model, its version, the prediction, the confidence and the rationale. These forecast payment failure and
-- leakage, so a mutable prediction means the record of what was accepted is not what was accepted.
CREATE TRIGGER financial_forecasts_governed_transition
  BEFORE UPDATE OR DELETE ON financial_forecasts
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'scope_id', 'forecast_type', 'model_id',
    'model_version', 'predicted_value', 'confidence', 'rationale', 'generated_at', 'schema_version');

-- Only `status` moves, and only to DEPRECATED. The model id, version, purpose and governing body are the
-- registration: every evaluation, drift alert, feedback item and recommendation in this batch references it,
-- so a mutable `model_id` silently re-attributes all of them to a different model.
CREATE TRIGGER model_registrations_governed_transition
  BEFORE UPDATE OR DELETE ON model_registrations
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'model_id', 'model_version', 'purpose',
    'governed_by', 'registered_at', 'schema_version');

-- `status` and `resolved_at` move — `acknowledgeDrift` sets the first, `resolveDrift` both. The description,
-- the severity and the model are the alert. This table had **no** trigger at all before this migration, so
-- the severity of a drift alert could be lowered and the alert itself deleted; it is the evidence that a
-- model has gone wrong, and it was the one thing in the batch nothing protected.
CREATE TRIGGER drift_alerts_governed_transition
  BEFORE UPDATE OR DELETE ON drift_alerts
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'model_registration_id', 'description',
    'severity', 'raised_at', 'schema_version');

-- `status` and `decided_at` move, which is the whole of `decideRecommendation`. The recommendation text, its
-- confidence and the model that produced it are what a human accepted or dismissed.
CREATE TRIGGER recommendations_governed_transition
  BEFORE UPDATE OR DELETE ON recommendations
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'scope_id', 'model_registration_id',
    'recommendation', 'confidence', 'created_at', 'schema_version');

-- One predicate, because the rule is a statement about the values of a `jsonb` object and PostgreSQL forbids
-- a subquery inside a CHECK. `jsonb_typeof` first, so a malformed value produces a refusal naming the rule
-- rather than an internal error from an aggregate over a scalar.
CREATE OR REPLACE FUNCTION assurapay_metrics_mean(metrics JSONB) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(metrics) <> 'object' THEN NULL
    ELSE (
      SELECT round(avg((value)::numeric))
      FROM jsonb_each_text(metrics) AS entry(key, value)
    )
  END
$$;

COMMENT ON FUNCTION assurapay_metrics_mean(JSONB) IS
  'The rounded mean of a metric object''s values, matching score()''s Math.round(averageOf(...)). NULL for a non-object, so the constraint that calls it refuses rather than raising.';

DO $batch_l_invariants$
BEGIN
  -- Derived, and checkable because both operands are in the row. The most consequential constraint in the
  -- batch: `recordEvaluation` raises a drift alert only when `passed` is false, so a row claiming a pass
  -- below its own threshold does not merely misreport — it suppresses the alert that would have prompted
  -- anyone to look at the model.
  ALTER TABLE evaluation_records
    ADD CONSTRAINT evaluation_records_passed_follows_threshold
    CHECK (passed = (score >= threshold));

  -- A scorecard measures something, and its headline is the rounded mean of what it measured. A scorecard
  -- whose overall score disagrees with its own metrics is the number a reader acts on.
  ALTER TABLE performance_scorecards
    ADD CONSTRAINT performance_scorecards_measures_something
    CHECK (jsonb_typeof(metrics) = 'object' AND metrics <> '{}'::jsonb);
  ALTER TABLE performance_scorecards
    ADD CONSTRAINT performance_scorecards_headline_follows_metrics
    CHECK (overall_score = assurapay_metrics_mean(metrics));

  -- A RESOLVED alert records when, and an unresolved one records nothing. `openDrifts` filters on status, so
  -- a row where the two disagree is visible to one query and invisible to the other.
  ALTER TABLE drift_alerts
    ADD CONSTRAINT drift_alerts_resolution_follows_status
    CHECK (
      (status = 'RESOLVED') = (resolved_at IS NOT NULL)
      AND (resolved_at IS NULL OR resolved_at >= raised_at)
    );

  -- The same for a decision. The engine's contract is that a recommendation is never auto-executed, so a
  -- PENDING row carrying a decision time reads as decided to anything sorting by it.
  ALTER TABLE recommendations
    ADD CONSTRAINT recommendations_decision_follows_status
    CHECK (
      (status <> 'PENDING') = (decided_at IS NOT NULL)
      AND (decided_at IS NULL OR decided_at >= created_at)
    );

  -- A registered model states what it is for and who governs it. A model with neither cannot be assessed for
  -- whether it is being used for what it was approved for, which is the whole point of registering it.
  ALTER TABLE model_registrations
    ADD CONSTRAINT model_registrations_is_governed
    CHECK (length(btrim(purpose)) > 0 AND length(btrim(governed_by)) > 0);

  -- A forecast names what produced it and why, as in Batch K.
  ALTER TABLE financial_forecasts
    ADD CONSTRAINT financial_forecasts_model_is_attributed
    CHECK (length(btrim(model_id)) > 0 AND length(btrim(model_version)) > 0
           AND length(btrim(rationale)) > 0);

  -- A renewal recommendation with no stated reasoning is a conclusion nobody can review, and
  -- `DO_NOT_RENEW` is a commercially consequential one.
  ALTER TABLE renewal_assessments
    ADD CONSTRAINT renewal_assessments_is_reasoned
    CHECK (length(btrim(rationale)) > 0 AND length(btrim(performance_history_summary)) > 0);

  -- A recommendation with nothing in it, and feedback with no comment, are rows that exist without saying
  -- anything — and the feedback comment is the only content a model owner acts on.
  ALTER TABLE recommendations
    ADD CONSTRAINT recommendations_says_something
    CHECK (length(btrim(recommendation)) > 0);
  ALTER TABLE model_feedback
    ADD CONSTRAINT model_feedback_says_something
    CHECK (length(btrim(comment)) > 0 AND length(btrim(output_reference)) > 0);
END
$batch_l_invariants$;

COMMENT ON TABLE drift_alerts IS
  'Canonical Engine 60 drift alert — the evidence that a registered model has gone wrong, raised automatically by recordEvaluation when a score falls below its threshold. Until 202608110015 this table had no mutation boundary of any kind: its severity could be lowered and the alert deleted outright. It is now governed, with the description, severity and model immutable and only the status and resolution time able to move.';

COMMENT ON TABLE model_registrations IS
  'Canonical Engine 60 model registration. Every model used anywhere in AssuraPay is expected to be registered here. Until 202608110015 a blanket append-only trigger refused deprecateModel, so a model the platform had detected as drifting could not be taken out of service on the durable store.';

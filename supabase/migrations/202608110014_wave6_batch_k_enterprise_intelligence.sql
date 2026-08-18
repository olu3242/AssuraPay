-- Batch K activates enterprise intelligence, and lets two engines run that could not.
--
-- Six aggregates for canonical Engines 51-55 — execution assurance index, settlement assurance index, KPI
-- definition, KPI value, dashboard snapshot, execution forecast.
--
-- These are the first of the group the accepted decision deferred "until the persistence boundary is
-- resolved". Batch J resolved it, and they turn out to be on the critical path rather than at the end of it:
-- these six tables are six of the sixteen still referencing the deprecated `workspaces`, and six of the
-- fifteen whose policies still call `has_active_workspace_membership()` — which is what keeps
-- `workspace_memberships` and `user_identities` from being retired.
--
-- ## The cleanest closure in the register
--
-- For the first time, nothing outside the batch references it, and nothing inside references anything outside
-- except the deprecated workspace table. The single intra-set key is
-- `kpi_values.kpi_definition_id -> kpi_definitions.id`. Both directions were verified against a live migrated
-- instance and both are re-verified at apply time below.
--
-- ## The defect this batch found
--
-- Batch G's shape, twice, and the second is worse. `202608030008` put blanket append-only triggers on all six
-- tables, and two of the six are aggregates their engines transition:
--
--   * `EnterpriseKpiEngine.retire` calls `replace('kpiDefinitions')`, so retiring a KPI refused on the
--     durable path and a definition could never leave ACTIVE;
--   * `PredictiveExecutionIntelligenceEngine.review` calls `replace('executionForecasts')`, so **a forecast
--     could never be reviewed**.
--
-- That second one contradicts the package's own stated AI-governance contract, written in its header: "a
-- forecast can never auto-decide anything — it starts NOT_REVIEWED and a human must explicitly accept or
-- reject it, mirroring the same AI-governance shape already established for Engine 16". On PostgreSQL the
-- human-in-the-loop step was unperformable, so every forecast stayed NOT_REVIEWED forever — the same class of
-- defect Batch I fixed for Engine 20's intelligence items, arrived at from the opposite direction: there the
-- database permitted publishing without review, here it forbade recording one.
--
-- Both are replaced with governed-transition triggers naming exactly what each engine moves. The other four
-- stay append-only, because an assurance index, a KPI value and a dashboard snapshot are each a value at a
-- moment and recomputing is a new row.
--
-- ## What else was missing
--
-- None of the six carried `tenant_id`, `row_version`, `schema_version` or `updated_at`. Identity was UUID
-- throughout — including `scope_id` and `generated_for`, which hold a trust principal and a reference the
-- runtime keeps as TEXT. All six had `ENABLE ROW LEVEL SECURITY` without `FORCE`, so the owning role was
-- unconstrained, which is the defect `persistence.rls-certification` corrected for the trust tables. And no
-- table had a unique key beyond its primary key.
--
-- ## Invariants that become constraints
--
-- The derived fields, which a row can contradict while reading as authoritative:
--
--   * an execution index is `overridden` with `score` 0 exactly when a mandatory gate failed, and
--     `failed_gates` is exactly the gates that did not pass. A high score beside a failed gate is a green
--     banner over work that did not pass its mandatory gates;
--   * a settlement index is the same shape driven by `active_hold` — CLAUDE.md's dispute hold. An index
--     reading healthy while a hold is active shows the platform's second hard constraint holding when it does
--     not;
--   * a dashboard snapshot holds only widgets its own role may see. `compose` filters them; a stored widget
--     outside the allow-list is a figure the viewer was never entitled to, persisted and readable from the
--     snapshot rather than from the engine that filtered it.
--
-- `kpi_values.on_track` is deliberately **not** constrained here. It follows from the definition's
-- `direction` and `target_value`, which live on the parent row, and PostgreSQL forbids a subquery inside a
-- CHECK. `kpiValueIsOnTrack` is exported so the engine and its checker share one comparison, and the store's
-- suite asserts it — a constraint that looked like it covered the rule would be worse than none.

DO $batch_k$
DECLARE
  conversion CONSTANT TEXT[] := ARRAY[
    'execution_assurance_indices', 'settlement_assurance_indices', 'kpi_definitions', 'kpi_values',
    'dashboard_snapshots', 'execution_forecasts'
  ];
  -- A value at a moment. No engine passes any of these to `replace`.
  append_only CONSTANT TEXT[] := ARRAY[
    'execution_assurance_indices', 'settlement_assurance_indices', 'kpi_values', 'dashboard_snapshots'
  ];
  -- Transitioned, and both refused before this migration.
  governed CONSTANT TEXT[] := ARRAY['kpi_definitions', 'execution_forecasts'];
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
      'WAVE6_BATCH_K_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
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
      'WAVE6_BATCH_K_AUTHORITY_REFUSED: foreign key(s) from outside the batch reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Policies first: PostgreSQL refuses to alter the type of a column a policy predicates on. These
  -- six predicate on `current_workspace_id()` and `has_active_workspace_membership()` — the superseded pair,
  -- and the reason `workspace_memberships` is still alive. Replaced below with the trust scope.
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

  -- Step 2. Every foreign key on the set, including those pointing at the deprecated `workspaces`.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(conversion)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. Converge identity on TEXT. Every UUID column, not only the keys: `scope_id` names an execution
  -- scope and `generated_for` a trust principal, and a UUID column cannot hold one.
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

  -- Step 4. Tenant scope, concurrency, schema versioning, and the scoped keys.
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
    -- `row_version` on every table. None of these six owns a domain `version` at all, so there is no
    -- question of a field doubling as the counter — the way `governedExecutions` does in Batch H.
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

  -- Step 5. Trust-runtime policies, FORCE row-level security, and the runtime grants.
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
    -- FORCE, not merely ENABLE. All six had ENABLE alone, which does not constrain the table owner.
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

  -- Step 6. The mutation boundary. The four that are measurements keep an append-only trigger; the two the
  -- engines transition lose theirs, and get governed-transition triggers below.
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

  -- The intra-set key, carried across with both scopes.
  ALTER TABLE kpi_values
    ADD CONSTRAINT kpi_values_definition_fk
    FOREIGN KEY (tenant_id, workspace_id, kpi_definition_id)
    REFERENCES kpi_definitions (tenant_id, workspace_id, id);

  -- A KPI is named once per workspace while it is ACTIVE. `define` refuses a blank name but not a duplicate
  -- one, and `retire` reads the definition then writes it — so two concurrent `define` calls for the same KPI
  -- both succeed today, after which every dashboard reporting that KPI has two definitions with different
  -- targets and no way to say which is meant. Partial, so a retired definition does not hold the name.
  CREATE UNIQUE INDEX IF NOT EXISTS kpi_definitions_one_active_per_name
    ON kpi_definitions (tenant_id, workspace_id, kind, name) WHERE status = 'ACTIVE';
END
$batch_k$;

-- Written out rather than looped: each immutable set is a different claim about what the aggregate is.

-- Only `status` moves, and only to RETIRED. The target, the direction and the unit are what every recorded
-- value was judged against — `recordValue` reads them to compute `on_track` — so a mutable target silently
-- rewrites the meaning of every value already stored against the definition.
CREATE TRIGGER kpi_definitions_governed_transition
  BEFORE UPDATE OR DELETE ON kpi_definitions
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'kind', 'name', 'target_value',
    'direction', 'unit', 'created_at', 'schema_version');

-- Only `review_status` moves. Everything else is the forecast: the model that produced it, its version, the
-- prediction, the confidence and the rationale a reviewer reads in order to decide. A mutable rationale means
-- the record of what was accepted is not the thing that was accepted.
CREATE TRIGGER execution_forecasts_governed_transition
  BEFORE UPDATE OR DELETE ON execution_forecasts
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'scope_id', 'forecast_type', 'model_id',
    'model_version', 'predicted_value', 'confidence', 'rationale', 'generated_at', 'schema_version');

-- Two predicates, because PostgreSQL forbids a subquery inside a CHECK and both rules are statements about
-- the elements of a `jsonb` array. Each opens with a CASE on `jsonb_typeof` rather than relying on `AND` to
-- short-circuit: SQL does not guarantee evaluation order, and `jsonb_array_length` raises on a scalar, so a
-- malformed value would produce an internal error instead of a refusal naming the rule it broke.

CREATE OR REPLACE FUNCTION assurapay_failed_gates_match(gates JSONB, failed JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(gates) <> 'array' OR jsonb_typeof(failed) <> 'array' THEN false
    ELSE (
      SELECT coalesce(
        array_agg(gate ->> 'gate' ORDER BY gate ->> 'gate')
          FILTER (WHERE (gate -> 'passed')::boolean IS NOT TRUE),
        '{}')
      FROM jsonb_array_elements(gates) AS gate
    ) = (
      SELECT coalesce(array_agg(name ORDER BY name), '{}')
      FROM jsonb_array_elements_text(failed) AS name
    )
  END
$$;

COMMENT ON FUNCTION assurapay_failed_gates_match(JSONB, JSONB) IS
  'True when the failed-gate list is exactly the mandatory gates that did not pass. A row naming a gate absent from its own gate list, or omitting one that failed, describes a different evaluation from the one it carries.';

CREATE OR REPLACE FUNCTION assurapay_widgets_visible_to_role(widgets JSONB, viewer_role TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(widgets) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(widgets) AS widget
      WHERE jsonb_typeof(widget -> 'allowedRoles') <> 'array'
         OR NOT (widget -> 'allowedRoles') ? viewer_role
    )
  END
$$;

COMMENT ON FUNCTION assurapay_widgets_visible_to_role(JSONB, TEXT) IS
  'True when every widget names the snapshot''s role in its allowedRoles. compose() filters to exactly that set; a stored widget outside it is a figure the viewer was never entitled to, materialised where it can be read without passing the filter again.';

DO $batch_k_invariants$
BEGIN
  -- An index with no factors has measured nothing, and `averageOf` returns 0 for an empty set — so it scores
  -- zero and shows the worst possible reading as though something had been measured.
  ALTER TABLE execution_assurance_indices
    ADD CONSTRAINT execution_assurance_indices_scores_something
    CHECK (jsonb_typeof(factors) = 'object' AND factors <> '{}'::jsonb);
  ALTER TABLE settlement_assurance_indices
    ADD CONSTRAINT settlement_assurance_indices_scores_something
    CHECK (jsonb_typeof(factors) = 'object' AND factors <> '{}'::jsonb);

  -- `overridden` is derived from whether a mandatory gate failed, and an overridden index scores zero. A high
  -- score beside a failed gate is a green banner over work that did not pass its mandatory gates, and the
  -- banner is what a reader acts on.
  ALTER TABLE execution_assurance_indices
    ADD CONSTRAINT execution_assurance_indices_override_follows_gates
    CHECK (
      jsonb_typeof(failed_gates) = 'array'
      AND overridden = (jsonb_array_length(failed_gates) > 0)
      AND (NOT overridden OR score = 0)
    );
  ALTER TABLE execution_assurance_indices
    ADD CONSTRAINT execution_assurance_indices_failed_gates_match
    CHECK (assurapay_failed_gates_match(mandatory_gates, failed_gates));

  -- The same shape driven by the dispute hold. CLAUDE.md's second hard constraint is what an active hold
  -- enforces; a settlement index reading healthy beside one shows the constraint holding when it does not.
  ALTER TABLE settlement_assurance_indices
    ADD CONSTRAINT settlement_assurance_indices_override_follows_hold
    CHECK (overridden = active_hold AND (NOT active_hold OR score = 0));

  -- A snapshot holds only widgets its own role may see.
  ALTER TABLE dashboard_snapshots
    ADD CONSTRAINT dashboard_snapshots_widgets_visible_to_role
    CHECK (assurapay_widgets_visible_to_role(widgets, role));

  -- A forecast names what produced it. For an AI-derived claim, being unable to say which model and version
  -- produced it is the whole of its evidential value gone: it can be neither reproduced nor attributed, and
  -- the package's own AI-governance contract makes retention part of the deal.
  ALTER TABLE execution_forecasts
    ADD CONSTRAINT execution_forecasts_model_is_attributed
    CHECK (length(btrim(model_id)) > 0 AND length(btrim(model_version)) > 0
           AND length(btrim(rationale)) > 0);
END
$batch_k_invariants$;

COMMENT ON TABLE execution_forecasts IS
  'Canonical Engine 55 execution forecast. Advisory only: it starts NOT_REVIEWED and a human must accept or reject it. Until 202608110014 a blanket append-only trigger refused that review, so on the durable store the human-in-the-loop step this aggregate exists for could not be performed and every forecast stayed NOT_REVIEWED forever.';

COMMENT ON TABLE execution_assurance_indices IS
  'Canonical Engine 51 execution assurance index. A governed read model: it never reads or writes another package''s store, and every factor and gate result is supplied by the caller. overridden, score and failed_gates are all derived from mandatory_gates and constrained to agree with it, because a high score beside a failed mandatory gate is a green banner over work that did not pass.';

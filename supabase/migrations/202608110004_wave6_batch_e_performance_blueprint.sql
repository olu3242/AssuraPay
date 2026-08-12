-- Batch E repairs the front of the canonical chain.
--
-- Batch E is the first batch of the sixty-seven `docs/persistence/DURABILITY_GAP_ANALYSIS.md`
-- registers: the six performance-blueprint aggregates of canonical Engines 16-20 — performance
-- blueprint, scope item, deliverable, blueprint milestone, milestone sequence edge, definition-of-done
-- package.
--
-- It is first for one reason. Three of these six are canonical chain links —
-- `performanceBlueprints`, `blueprintMilestones`, `dodPackages` — so six aggregates of work repair
-- three of the four broken links in `Contract → PerformanceBlueprint → Milestone →
-- DefinitionOfDonePackage → ExecutionWorkspace → …`. Nothing else in the register has that ratio.
--
-- Until now these six had no durable home at all. `PostgresTrustStore` refused every one of them with
-- PERSISTENCE_COLLECTION_NOT_MAPPED, which is why `trust_records` holds zero rows for them and there
-- is nothing to backfill — the same position Batches A-D each started from.
--
-- THE CLOSURE IS THE SIX, MEASURED NOT ASSUMED.
--
-- Computed against a live migrated instance. Every outbound foreign key from these six goes inside
-- the six or to `workspaces`, which convergence replaces, and **no table outside the six references
-- any of them**. `performance_blueprints.contract_id` points at the agreements model Batch F will
-- converge and carries no constraint today, so nothing breaks by converting it.
--
-- All six hold zero rows, re-verified below at apply time.
--
-- THE CONCURRENCY COLUMN CANNOT BE CALLED `version` HERE, AND THAT IS NOT A NAMING PREFERENCE.
--
-- `performance_blueprints.version` and `dod_packages.version` **already exist, as domain fields**.
-- `PerformanceBlueprintEngine.draft` sets `version = existing.length + 1` — this is blueprint
-- revision 3 of a contract, not row revision 3 of a record — and it is never updated: a new revision
-- is a new row, and the old one becomes SUPERSEDED.
--
-- Batches A-D added `version INTEGER` for optimistic concurrency and made the governed-transition
-- trigger require it to advance on every UPDATE. Doing that here would conflate two different
-- meanings in one column: superseding a blueprint would have to "advance" its revision number, which
-- would make revision 3 become revision 4 while still being the row that revision 4 supersedes.
--
-- So the concurrency column is `row_version`, on **all six** rather than only the two that collide —
-- one name across the batch means no per-table exception for a reader to remember. The domain
-- `version` joins the immutable list, because which revision a row *is* cannot change.
--
-- That needs the trigger function to stop hard-coding the column name, which Step 0 does by
-- generalising it rather than cloning it. A second near-identical function would be the
-- `runtime/duplicate-abstraction` finding this repository already carries one of.
--
-- WHAT THIS ENFORCES THAT NOTHING ENFORCED BEFORE
--
-- 1. Tenancy. Six tables scoped on `workspace_id UUID REFERENCES workspaces(id)` — the deprecated
--    compatibility table — with no tenant column, ENABLE row-level security and no FORCE, so the
--    boundary did not constrain the table owner.
--
-- 2. The governed currency set, for the first time outside the settlement batches.
--    `blueprint_milestones.currency` accepted any string. MONETARY_INVARIANTS applies wherever an
--    amount exists, not only where it moves. The amount bound itself was already there:
--    `CHECK (budget_amount_minor > 0)` dates from `202608030004`, and this migration adds no second
--    constraint for a rule the schema already carries — see Step 8.
--
-- 3. Ordered milestone dates. Neither `start_date` nor `due_date` was bounded, so a milestone could
--    be due before it started and every downstream date calculation would inherit the inversion.
--
-- 4. A tenant-scoped sequence-edge key. `UNIQUE (predecessor_id, successor_id)` predates tenancy and
--    is global — the same shape as the global `UNIQUE (certificate_number)` Batch A found. Not a live
--    defect, because milestone identifiers already make the pair unique, but a global constraint on
--    tenant data is one deployment away from refusing a second tenant's legitimate write.
--
-- 5. The uniqueness the engines enforce by counting. One ACTIVE blueprint per contract, one
--    PUBLISHED definition-of-done package per milestone, one blueprint revision per contract and
--    version, one package revision per milestone and version. Every one of those is a rule an engine
--    checks by reading rows first, which two concurrent requests both pass.
--
-- 6. Mutation boundaries. All six carried a blanket `<table>_append_only` trigger. **Four of them are
--    transitioned** — a blueprint is activated and superseded, a scope item and a deliverable are
--    confirmed, a package is published and superseded — so the blanket trigger would have refused
--    every one of those. Fifth instance of this defect, after five tables in `202608100001`, three in
--    `202608100002` and one in `202608110002`.
--
--    `blueprint_milestones` and `milestone_sequence_edges` stay append-only, and that was checked
--    rather than assumed: `BlueprintMilestone.status` declares a `CANCELLED` value, and **nothing in
--    the repository ever writes it**. A table is append-only because no engine transitions it, not
--    because its type lacks a second state.
--
-- WHAT THIS DELIBERATELY DOES NOT ENFORCE
--
-- The blueprint's total value allocation. `activate` refuses a total above 100 across every SCHEDULED
-- milestone, which is a cross-row sum over a set that has no completion signal: milestones are added
-- one at a time and the total is only meaningful when the blueprint is activated. A deferred
-- constraint trigger of the kind Batch C used for journal balance would fire at COMMIT of whichever
-- transaction happened to add a milestone, refusing a partial plan that is legitimately partial.
-- Enforcing it would need an explicit "plan complete" transition the domain does not have. Recorded
-- as a gap rather than approximated.
--
-- NO HISTORICAL MIGRATION IS MODIFIED. Forward-only, additive, and refusing rather than coercing.

-- Step 0. Let the governed-transition trigger be told which column carries concurrency.
--
-- A strict generalisation, replacing the function `202608100001` created rather than adding a sibling.
-- Existing triggers pass only immutable column names and are unaffected: with no `concurrency=`
-- marker the behaviour is identical, including the column it checks. Batch E passes the marker.
CREATE OR REPLACE FUNCTION enforce_governed_aggregate_transition() RETURNS trigger
LANGUAGE plpgsql AS $governed$
DECLARE
  -- The trigger arguments are the column names whose values may never change after the row is
  -- created, so one function serves every aggregate without knowing any of their shapes.
  --
  -- Optionally, the first argument may be `concurrency=<column>`, naming the column that carries
  -- optimistic concurrency. It exists because two aggregates already own a `version` column as a
  -- *domain* field — a blueprint revision, a package revision — and a row counter cannot share a name
  -- with a revision number without one of them lying.
  -- Zero, because TG_ARGV is zero-based. `TG_ARGV[1:n]` silently drops the first argument, which is
  -- always `id` — so an off-by-one here would have made the primary key mutable on all thirty-five
  -- aggregates the earlier batches govern, while every trigger still appeared to be in place.
  immutable_start  INTEGER := 0;
  concurrency      TEXT := 'version';
  immutable_column TEXT;
  before_row       JSONB := to_jsonb(OLD);
  after_row        JSONB;
BEGIN
  IF array_length(TG_ARGV, 1) >= 1 AND TG_ARGV[0] LIKE 'concurrency=%' THEN
    concurrency := substring(TG_ARGV[0] FROM 13);
    immutable_start := 1;
  END IF;

  -- History is not deletable. Enforced here as well as by withholding the DELETE privilege,
  -- because a privilege can be granted by an operator in a hurry and a trigger cannot.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AGGREGATE_ROW_IS_NOT_DELETABLE: %', TG_TABLE_NAME;
  END IF;

  after_row := to_jsonb(NEW);

  FOREACH immutable_column IN ARRAY TG_ARGV[immutable_start:array_length(TG_ARGV, 1)] LOOP
    -- IS DISTINCT FROM, not <>: a column going from NULL to a value, or the reverse, is a change,
    -- and <> would evaluate to NULL and let it through.
    IF before_row -> immutable_column IS DISTINCT FROM after_row -> immutable_column THEN
      RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE: %.%', TG_TABLE_NAME, immutable_column;
    END IF;
  END LOOP;

  -- Optimistic concurrency has to move forward or it is not concurrency control. Two writers that
  -- both read version 3 and both write version 4 would otherwise both succeed, and the second
  -- would silently discard the first.
  IF (after_row ->> concurrency)::BIGINT <= (before_row ->> concurrency)::BIGINT THEN
    RAISE EXCEPTION 'AGGREGATE_VERSION_MUST_ADVANCE: %.% (% -> %)',
      TG_TABLE_NAME, concurrency, before_row ->> concurrency, after_row ->> concurrency;
  END IF;

  RETURN NEW;
END
$governed$;

COMMENT ON FUNCTION enforce_governed_aggregate_transition() IS
  'Refuses DELETE, refuses any change to the columns named in the trigger arguments, and requires the concurrency column to advance. The concurrency column is `version` unless the first argument is `concurrency=<column>`, which exists because some aggregates own a domain `version` field that is not a row counter. Replaces the blanket append-only trigger on aggregates whose canonical engines perform lifecycle transitions.';

DO $batch_e$
DECLARE
  closure CONSTANT TEXT[] := ARRAY[
    'performance_blueprints', 'scope_items', 'deliverables', 'blueprint_milestones',
    'milestone_sequence_edges', 'dod_packages'
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
      'WAVE6_BATCH_E_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
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
      'WAVE6_BATCH_E_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
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

  -- Step 3. Converge identity on TEXT — the trust runtime's representation throughout. Every UUID
  -- column, not only the keys: `created_by` and `owner_id` are trust principals, and a UUID column
  -- cannot hold one.
  --
  -- All of a table's columns in ONE `ALTER TABLE`, which is not a tidiness choice.
  -- `milestone_sequence_edges` carries `CHECK (predecessor_id <> successor_id)` from the historical
  -- migration, and converting those columns one statement at a time fails partway with
  -- `operator does not exist: text <> uuid` — the check would be comparing a converted column to an
  -- unconverted one. Converting a table's columns together keeps every multi-column constraint valid
  -- at each statement boundary.
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

    -- `row_version`, not `version`. See this file's header: two of these tables own a domain `version`
    -- that is a revision number rather than a row counter.
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

  -- Step 5. The governed currency set, wherever an amount exists. Only `blueprint_milestones` carries
  -- one in this batch; the loop is written the same way as every other batch's so a table gaining a
  -- currency later is covered without remembering to add it.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = target AND column_name = 'currency'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (currency IN (''NGN'', ''USD''))',
      target, target || '_currency_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id, currency)',
      target, target || '_tenant_id_currency_unique');
  END LOOP;

  -- Step 6. Trust-runtime policies, FORCE, and the runtime grants.
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

    -- FORCE, because ENABLE does not constrain the table owner. All six carried ENABLE without FORCE.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  -- No DELETE. A blueprint that can be deleted is a contract whose plan can be made to disappear.
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
$batch_e$;

-- Step 7. The blueprint graph, restored tenant-composite. Foreign key checks run as the table owner
-- and are not subject to row-level security, so only a composite key stops a row in one tenant
-- referencing a parent in another.
DO $graph$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'performance_blueprints'
  ) THEN RETURN; END IF;

  ALTER TABLE scope_items
    ADD CONSTRAINT scope_items_blueprint_fk
    FOREIGN KEY (tenant_id, blueprint_id) REFERENCES performance_blueprints (tenant_id, id);

  ALTER TABLE deliverables
    ADD CONSTRAINT deliverables_blueprint_fk
    FOREIGN KEY (tenant_id, blueprint_id) REFERENCES performance_blueprints (tenant_id, id);

  ALTER TABLE deliverables
    ADD CONSTRAINT deliverables_scope_item_fk
    FOREIGN KEY (tenant_id, scope_item_id) REFERENCES scope_items (tenant_id, id);

  ALTER TABLE blueprint_milestones
    ADD CONSTRAINT blueprint_milestones_blueprint_fk
    FOREIGN KEY (tenant_id, blueprint_id) REFERENCES performance_blueprints (tenant_id, id);

  ALTER TABLE milestone_sequence_edges
    ADD CONSTRAINT milestone_sequence_edges_blueprint_fk
    FOREIGN KEY (tenant_id, blueprint_id) REFERENCES performance_blueprints (tenant_id, id);

  ALTER TABLE milestone_sequence_edges
    ADD CONSTRAINT milestone_sequence_edges_predecessor_fk
    FOREIGN KEY (tenant_id, predecessor_id) REFERENCES blueprint_milestones (tenant_id, id);

  ALTER TABLE milestone_sequence_edges
    ADD CONSTRAINT milestone_sequence_edges_successor_fk
    FOREIGN KEY (tenant_id, successor_id) REFERENCES blueprint_milestones (tenant_id, id);

  ALTER TABLE dod_packages
    ADD CONSTRAINT dod_packages_milestone_fk
    FOREIGN KEY (tenant_id, milestone_id) REFERENCES blueprint_milestones (tenant_id, id);
END
$graph$;

-- Step 8. What the historical migration did *not* already constrain.
--
-- Read before written, and most of what a first draft would add is already there:
-- `CHECK (quantity > 0)`, `CHECK (budget_amount_minor > 0)`,
-- `CHECK (value_allocation_percent > 0 AND value_allocation_percent <= 100)` and
-- `CHECK (predecessor_id <> successor_id)` all date from `202608030004`. Adding them again would be
-- two constraints for one rule, and the allocation bound a first draft reaches for — `>= 0` — is
-- *weaker* than the one already present, so it would have read as tightening while loosening.
--
-- What is genuinely absent is below.
DO $invariants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'blueprint_milestones'
  ) THEN RETURN; END IF;

  -- A milestone that is due before it starts cannot be scheduled, and every downstream date
  -- calculation would inherit the inversion. The historical migration bounds neither date.
  ALTER TABLE blueprint_milestones
    ADD CONSTRAINT blueprint_milestones_dates_ordered CHECK (due_date >= start_date);

  -- `UNIQUE (predecessor_id, successor_id)` predates tenancy and is global. Milestone identifiers make
  -- the pair naturally unique today, so this is not a live defect — but it is the same shape as the
  -- global `UNIQUE (certificate_number)` Batch A found, and a global constraint on tenant data is one
  -- deployment away from refusing a second tenant's legitimate write. Replaced with the scoped form,
  -- which also says what the rule means: an edge is unique *within a blueprint*.
  ALTER TABLE milestone_sequence_edges
    DROP CONSTRAINT IF EXISTS milestone_sequence_edges_predecessor_id_successor_id_key;
  ALTER TABLE milestone_sequence_edges
    ADD CONSTRAINT milestone_sequence_edges_unique
    UNIQUE (tenant_id, blueprint_id, predecessor_id, successor_id);

  -- One blueprint revision per contract and version number. `draft` computes the version by counting
  -- existing rows, which two concurrent drafts both read as the same number.
  ALTER TABLE performance_blueprints
    ADD CONSTRAINT performance_blueprints_contract_version_unique
    UNIQUE (tenant_id, contract_id, version);

  -- One ACTIVE blueprint per contract. `activate` supersedes every ACTIVE row first, so more than one
  -- means the supersession lost a race — and a contract with two active plans has no plan.
  CREATE UNIQUE INDEX IF NOT EXISTS performance_blueprints_one_active_per_contract
    ON performance_blueprints (tenant_id, contract_id)
    WHERE status = 'ACTIVE';

  -- The same two rules for definition-of-done packages, which version and supersede identically.
  -- `activate` requires a PUBLISHED package per milestone, so two would make which one gated the
  -- release undecidable.
  ALTER TABLE dod_packages
    ADD CONSTRAINT dod_packages_milestone_version_unique
    UNIQUE (tenant_id, milestone_id, version);

  CREATE UNIQUE INDEX IF NOT EXISTS dod_packages_one_published_per_milestone
    ON dod_packages (tenant_id, milestone_id)
    WHERE status = 'PUBLISHED';
END
$invariants$;

-- Step 9. Mutation boundaries.
DO $transitions$
DECLARE
  -- Four of the six. Each `immutable` list omits `status` and `row_version`, and includes the domain
  -- `version` where one exists, because which revision a row *is* cannot change.
  governed CONSTANT JSONB := $spec$
  [
    { "table": "performance_blueprints", "status": "status", "terminal": ["SUPERSEDED"],
      "immutable": ["id","tenant_id","workspace_id","contract_id","contract_version_id","agreement_intelligence_version_id","version","created_by","created_at","content_hash","schema_version"] },
    { "table": "scope_items", "status": "status", "terminal": ["CONFIRMED"],
      "immutable": ["id","tenant_id","workspace_id","blueprint_id","kind","description","assumptions","constraints","owner_id","created_at","schema_version"] },
    { "table": "deliverables", "status": "status", "terminal": ["CONFIRMED"],
      "immutable": ["id","tenant_id","workspace_id","blueprint_id","scope_item_id","title","quantity","unit","quality_standard","owner_id","due_date","acceptance_criteria","evidence_requirements","created_at","schema_version"] },
    { "table": "dod_packages", "status": "status", "terminal": ["SUPERSEDED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","version","deliverable_gate_ids","criteria","evidence_requirements","quality_gate","compliance_gate","risk_gate","payment_gate","created_by","created_at","content_hash","schema_version"] }
  ]
  $spec$::JSONB;

  -- Never transitioned by any canonical engine. `BlueprintMilestone.status` declares a CANCELLED value
  -- and nothing in the repository writes it, so the table is append-only because of what the engines
  -- do rather than because of what its type allows.
  append_only CONSTANT TEXT[] := ARRAY['blueprint_milestones', 'milestone_sequence_edges'];

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

    -- Replaced, not supplemented. Leaving the blanket trigger alongside the governed one would refuse
    -- every transition and make the new rules unreachable.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_terminal_state', target);

    -- `concurrency=row_version` first, then the immutable columns. Step 0 made that marker meaningful.
    SELECT format('%L', 'concurrency=row_version') || ', ' ||
           string_agg(format('%L', value), ', ' ORDER BY position)
      INTO arguments
      FROM jsonb_array_elements_text(spec -> 'immutable')
             WITH ORDINALITY AS columns(value, position);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION enforce_governed_aggregate_transition(%s)',
      target || '_governed_transition', target, arguments);

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
      'WAVE6_BATCH_E_AUTHORITY_REFUSED: expected mutation boundary absent on %. Nothing has been '
      'changed.',
      array_to_string(missing, ', ');
  END IF;
END
$transitions$;

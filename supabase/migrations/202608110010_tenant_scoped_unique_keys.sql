-- Six unique keys still partitioned the whole platform instead of a tenant.
--
-- Batches A-F converged identity and tenancy, and each added the tenant-scoped keys its aggregates
-- needed. What none of them did was remove the *historical* keys underneath. `202608030004` and
-- `202608030006` created these tables before tenancy existed, when a single-tenant deployment made
-- `UNIQUE (contract_id, version)` a reasonable thing to write; after the convergence the same constraint
-- means something quite different, and nothing dropped it.
--
-- Found while building a Batch G fixture, which is worth recording because it is how this class of defect
-- surfaces. Two tenants each founding a blueprint for their own contract `c-1` at version 1 is an
-- ordinary thing for two tenants to do, and the second was refused
-- `performance_blueprints_contract_id_version_key`. The fixture was right and the constraint was wrong.
--
-- The consequence is a cross-tenant denial of service that needs no privilege and no mistake: whichever
-- tenant reaches a `(contract_id, version)` pair first holds it against every other tenant on the
-- deployment, permanently, and the second tenant sees a duplicate-key error about a row it cannot see and
-- did not create. Row-level security does not help — a unique index is checked by the system, across every
-- row, the same reason `202608110008` had to put `workspace_id` in the foreign keys. This is that finding
-- one level up: the keys, not the references.
--
-- Six routed tables were affected, and the fix differs between them:
--
--   * `dod_packages` and `performance_blueprints` already carry tenant-scoped equivalents —
--     `dod_packages_milestone_version_unique` and `performance_blueprints_contract_version_unique` — so
--     the historical key is redundant as well as wrong, and is simply dropped.
--   * The other four have no equivalent, so dropping alone would lose a real rule: one approval decision
--     per approver step, one document version per draft revision, one execution certificate per signature
--     package, one negotiation round per number. Each is replaced by the same rule scoped to the tenant
--     and the workspace.
--
-- Scoped to tenant *and* workspace rather than tenant alone, for the reason `202608110008` gives: these
-- aggregates all live in a workspace, and a key that stops at the tenant would still let one workspace
-- occupy a value against another in the same tenant.
--
-- Eleven further tables have keys with the same shape — `contract_versions_v2`, `dod_versions`,
-- `execution_history`, `milestone_dependencies`, `certification_decisions`,
-- `digital_certification_records`, `agreement_intelligence_versions`, `contract_risk_assessments` among
-- them. They are deliberately untouched: no store route reaches them, so no engine can reach the defect,
-- and the batch that activates each one is the batch that should carry its key across. Fixing them here
-- would be changing constraints on tables this change has no test for.

DO $tenant_scoped_unique_keys$
DECLARE
  -- Redundant *and* wrong: a tenant-scoped equivalent already exists, named in the comment above.
  redundant CONSTANT TEXT[][] := ARRAY[
    ARRAY['dod_packages', 'dod_packages_milestone_id_version_key'],
    ARRAY['performance_blueprints', 'performance_blueprints_contract_id_version_key']
  ];
  -- Indexed as `redundant[i][2]`, not sliced. A slice of a two-dimensional array is itself
  -- two-dimensional, so assigning `redundant[i:i][1:2]` to a one-dimensional variable yields NULLs at
  -- every subscript — and the guards below then match nothing, so the migration reports success while
  -- changing not one key. It did exactly that before this was corrected.
BEGIN
  FOR i IN 1 .. array_length(redundant, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = redundant[i][2] AND n.nspname = current_schema()
    ) THEN
      -- Dropped as a constraint when it is one and as an index otherwise: `UNIQUE` in a CREATE TABLE
      -- makes a constraint, and DROP INDEX refuses to remove an index a constraint owns.
      IF EXISTS (
        SELECT 1 FROM pg_constraint con
          JOIN pg_class t ON t.oid = con.conrelid
        WHERE con.conname = redundant[i][2] AND t.relname = redundant[i][1]
      ) THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', redundant[i][1], redundant[i][2]);
      ELSE
        EXECUTE format('DROP INDEX %I', redundant[i][2]);
      END IF;
    END IF;
  END LOOP;
END
$tenant_scoped_unique_keys$;

DO $tenant_scoped_replacements$
DECLARE
  -- table, historical key, the columns the rule is really about.
  replacements CONSTANT TEXT[][] := ARRAY[
    ARRAY['agreement_approval_decisions', 'agreement_approval_decisions_request_id_step_key',
          'request_id, step'],
    ARRAY['agreement_document_versions', 'agreement_document_versions_draft_id_version_key',
          'draft_id, version'],
    ARRAY['agreement_execution_certificates', 'agreement_execution_certificates_package_id_key',
          'package_id'],
    ARRAY['negotiation_rounds', 'negotiation_rounds_contract_id_round_number_key',
          'contract_id, round_number']
  ];
BEGIN
  FOR i IN 1 .. array_length(replacements, 1) LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = replacements[i][1]
    );

    -- The scoped key first, so the rule is never absent — not even for the duration of this statement
    -- pair. A window with neither key is a window in which a duplicate can be written, and this runs
    -- inside the migration transaction precisely so that window cannot be observed.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id, %s)',
      replacements[i][1] || '_ws_scoped_unique', replacements[i][1], replacements[i][3]);

    IF EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = replacements[i][2] AND n.nspname = current_schema()
    ) THEN
      IF EXISTS (
        SELECT 1 FROM pg_constraint con
          JOIN pg_class t ON t.oid = con.conrelid
        WHERE con.conname = replacements[i][2] AND t.relname = replacements[i][1]
      ) THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', replacements[i][1], replacements[i][2]);
      ELSE
        EXECUTE format('DROP INDEX %I', replacements[i][2]);
      END IF;
    END IF;
  END LOOP;
END
$tenant_scoped_replacements$;

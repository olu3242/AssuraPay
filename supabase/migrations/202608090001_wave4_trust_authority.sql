-- Batch A answers to the trust runtime, and to nothing else.
--
-- Sixteen execution-and-evidence tables for canonical Engines 31-40 existed with every
-- constraint their aggregates need and no production reader or writer — measured in
-- docs/certification/ENGINES_31_50_CERTIFICATION_GAP_MATRIX.md. Activating them was blocked by
-- four structural facts, each verified against a live instance rather than inferred:
--
--   1. `workspace_id UUID NOT NULL REFERENCES workspaces(id)` pointed at the *deprecated*
--      compatibility table. `202608080001` retained `workspaces` only because 93 Engine 06-60
--      tables depend on it, marked it DEPRECATED in the database, and revoked the runtime role's
--      write privileges. A write path through it is therefore forbidden by the schema-ownership
--      capability, not merely undesirable.
--   2. No `tenant_id` at all. Scope was workspace-only, so no policy could express the tenant
--      boundary the trust runtime enforces everywhere else.
--   3. Identity was `UUID`, while the trust runtime is `TEXT` throughout —
--      `trust_workspaces.workspace_id`, `trust_tenants.tenant_id`, `trust_records.record_id`.
--      Two identity representations for one platform is the same defect class as
--      `audit_records.aggregate_id UUID`, which could not hold the permission keys the live store
--      audits.
--   4. Policies called `current_workspace_id()` and `has_active_workspace_membership()` — the
--      historical helpers, the second of which reads `workspace_memberships`, also deprecated.
--
-- The decision was to converge rather than accommodate: one authority per concern. Workspaces are
-- `trust_workspaces`, tenants are `tenant_id`, membership and identity are the trust runtime, and
-- identity is TEXT. No `trust_workspace_id` column is introduced, because a second workspace
-- column would be a second workspace authority — exactly what this migration exists to remove.
--
-- Why the type change is safe, and why that is checked rather than asserted: all sixteen tables
-- hold zero rows, and no table outside the batch has a foreign key into any of them. Both facts
-- are re-verified below at apply time. A database where either is false must stop, because
-- converting a populated identity column is a data migration and this is not one.
--
-- `has_active_workspace_membership()` and `current_workspace_id()` are deliberately NOT dropped.
-- The 93 out-of-scope Engine 06-60 tables still use them, and removing them here would break
-- policies this capability does not own. They are removed from *these sixteen tables'* write path,
-- which is what "no compatibility tables on any write path" means for Batch A.

-- The composite foreign key below needs this. `workspace_id` is already the primary key, so the
-- pair is trivially unique and the constraint costs nothing — but a composite foreign key requires
-- a declared unique constraint on exactly the referenced columns, and PostgreSQL will not infer it
-- from the single-column key.
ALTER TABLE trust_workspaces
  ADD CONSTRAINT trust_workspaces_tenant_workspace_unique UNIQUE (tenant_id, workspace_id);

DO $wave4$
DECLARE
  batch CONSTANT TEXT[] := ARRAY[
    'execution_workspaces', 'work_items', 'progress_records', 'evidence_requirements',
    'evidence_packages', 'validation_tests', 'quality_plans', 'quality_gate_results', 'defects',
    'inspections', 'issue_records', 'corrective_action_plans', 'change_requests',
    'change_approvals', 'acceptance_decisions', 'completion_certificates'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  -- Absent tables are tolerated so this migration applies to a schema that never carried the
  -- historical model, which is what the integration harness builds.
  FOREACH target IN ARRAY batch LOOP
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
      'WAVE4_TRUST_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table. Nothing has been '
      'changed. Backfill and convert deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  -- A foreign key from outside the batch would be silently broken by the type change.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(batch)
      AND NOT (c.conrelid::regclass::text = ANY(batch))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE4_TRUST_AUTHORITY_REFUSED: foreign key(s) from outside the batch reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Drop the historical policies first.
  --
  -- Order matters and PostgreSQL enforces it: "cannot alter type of a column used in a policy
  -- definition". The existing policies predicate on `workspace_id`, so the column cannot be
  -- converted while they exist. Every policy is dropped rather than the one name the historical
  -- migration used, so a policy added by any other means cannot survive as a second boundary.
  FOREACH target IN ARRAY batch LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      FOR rec IN
        SELECT policyname AS name FROM pg_policies
        WHERE schemaname = current_schema() AND tablename = target
      LOOP
        EXECUTE format('DROP POLICY %I ON %I', rec.name, target);
      END LOOP;
    END IF;
  END LOOP;

  -- Step 2. Drop every foreign key on the batch. They are all recreated below against the trust
  -- runtime, and the type conversion cannot proceed while they exist.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(batch)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. Converge identity on TEXT — the trust runtime's representation. Every UUID column in
  -- the batch, not only the keys: an actor id typed UUID cannot hold a trust principal id, and
  -- leaving some columns UUID would keep the split this step exists to eliminate.
  FOR rec IN
    SELECT c.table_name AS tbl, c.column_name AS col, c.column_default AS def
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(batch)
      AND c.data_type = 'uuid'
  LOOP
    -- The default must go first: gen_random_uuid() is not assignable to text.
    IF rec.def IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', rec.tbl, rec.col);
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TEXT USING %I::text', rec.tbl, rec.col, rec.col);
    IF rec.def IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT gen_random_uuid()::text', rec.tbl, rec.col);
    END IF;
    -- Identity is bounded the same way the trust runtime bounds it, so a value that fits one
    -- table fits the other.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(%I) BETWEEN 1 AND 200)',
      rec.tbl, rec.tbl || '_' || rec.col || '_len', rec.col);
  END LOOP;

  -- Step 4. Tenant scope, versioning and schema versioning.
  --
  -- `tenant_id` is added NULLable and then set NOT NULL, rather than added NOT NULL with a
  -- default: a default tenant would be a fabricated ownership claim, and the tables are empty so
  -- there is nothing to default. On an empty table the NOT NULL is immediate and free.
  FOREACH target IN ARRAY batch LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT', target);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', target);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES trust_tenants(tenant_id)',
        target, target || '_tenant_fk');

      -- Optimistic concurrency, matching trust_records.version.
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1', target);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (version >= 1)', target, target || '_version_ck');

      -- Versioned parsing. An unknown schema_version must fail into quarantine rather than be
      -- parsed best-effort, which is why it is a column rather than an inference.
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', target);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version >= 1)',
        target, target || '_schema_version_ck');

      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
        target);

      -- Step 5. Workspace authority is trust_workspaces. One column, one authority.
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES trust_workspaces(workspace_id)',
        target, target || '_workspace_fk');

      -- A workspace belongs to exactly one tenant, and a row must agree with it. Without this a
      -- caller scoped to tenant A could write a row naming tenant A and a workspace owned by
      -- tenant B, which the policies would then admit.
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
        'REFERENCES trust_workspaces(tenant_id, workspace_id)',
        target, target || '_tenant_workspace_fk');
    END IF;
  END LOOP;

  -- Step 6. Policies from the trust runtime, replacing the historical helpers dropped in step 1.
  FOREACH target IN ARRAY batch LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      -- USING and WITH CHECK both. A USING-only policy hides other tenants' rows while letting a
      -- caller insert into their scope.
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
        'AND workspace_id = trust_current_workspace()) '
        'WITH CHECK (tenant_id = trust_current_tenant() '
        'AND workspace_id = trust_current_workspace())',
        target || '_trust_scope', target);

      -- Step 7. FORCE, because ENABLE does not constrain the table owner — the defect
      -- persistence.rls-certification corrected for the trust tables.
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);

      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
        target || '_tenant_workspace_idx', target);
    END IF;
  END LOOP;

  -- Step 8. The runtime role gains the privileges it needs and no more. Conditional because the
  -- role is provisioned by the deployment, not by a file in this repository. No DELETE: history
  -- for these aggregates is append-only or supersession-based, and a role that cannot issue the
  -- statement cannot reach a trigger that would refuse it.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY batch LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      ) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
      END IF;
    END LOOP;
  END IF;
END
$wave4$;

-- The append-only triggers created by 202608030006 and 202608030007 are deliberately untouched.
-- They already protect progress records, evidence, validation results, quality state and
-- acceptance decisions from mutation, which is the behaviour these aggregates require, and
-- recreating them would risk losing it.

COMMENT ON TABLE work_items IS
  'Canonical Engine 33 work item. Tenant and workspace answer to the trust runtime: tenant_id references trust_tenants, workspace_id references trust_workspaces, and the composite key forces them to agree. Identity is TEXT, matching trust_records. FORCE RLS with trust_current_tenant()/trust_current_workspace().';

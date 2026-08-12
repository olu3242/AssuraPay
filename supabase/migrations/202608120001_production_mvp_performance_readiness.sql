-- Production MVP persistence completion for Engines 26-30.
--
-- This migration is deliberately a convergence over the relations the engine migrations already
-- declared. The
-- activation refuses non-empty legacy relations rather than inventing tenant ownership or rewriting
-- records whose identifiers were created under the superseded UUID authority.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TEMP TABLE assurapay_p1_tables(table_name TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO assurapay_p1_tables(table_name) VALUES
  ('acceptance_criteria'), ('success_metrics'), ('dependencies'),
  ('payment_trigger_rules'), ('performance_baselines'), ('baseline_variances');

DO $$
DECLARE entry RECORD; held BIGINT;
BEGIN
  FOR entry IN SELECT table_name FROM assurapay_p1_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', entry.table_name) INTO held;
    IF held <> 0 THEN
      RAISE EXCEPTION 'P1_PERSISTENCE_ACTIVATION_REFUSED: %.% rows; nothing has been changed',
        entry.table_name, held;
    END IF;
  END LOOP;
END $$;

-- Capture the relational graph before converting the UUID-era model. Every captured single-column
-- edge is rebuilt tenant-composite after both ends are TEXT-native. No reference is silently lost.
CREATE TEMP TABLE assurapay_p1_foreign_keys ON COMMIT DROP AS
SELECT
  child.relname AS child_table,
  con.conname,
  child_col.attname AS child_column,
  parent.relname AS parent_table,
  parent_col.attname AS parent_column
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class parent ON parent.oid = con.confrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
JOIN pg_attribute child_col ON child_col.attrelid = child.oid AND child_col.attnum = con.conkey[1]
JOIN pg_attribute parent_col ON parent_col.attrelid = parent.oid AND parent_col.attnum = con.confkey[1]
WHERE con.contype = 'f'
  AND child_ns.nspname = 'public'
  AND parent_ns.nspname = 'public'
  AND (child.relname IN (SELECT table_name FROM assurapay_p1_tables)
    OR parent.relname IN (SELECT table_name FROM assurapay_p1_tables))
  AND array_length(con.conkey, 1) = 1;

CREATE TEMP TABLE assurapay_p1_checks ON COMMIT DROP AS
SELECT child.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
WHERE con.contype = 'c' AND child_ns.nspname = 'public'
  AND child.relname IN (SELECT table_name FROM assurapay_p1_tables);

DO $$
DECLARE constraint_entry RECORD;
BEGIN
  FOR constraint_entry IN SELECT child_table, conname FROM assurapay_p1_foreign_keys LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', constraint_entry.child_table, constraint_entry.conname);
  END LOOP;
  FOR constraint_entry IN SELECT table_name, conname FROM assurapay_p1_checks LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', constraint_entry.table_name, constraint_entry.conname);
  END LOOP;
END $$;

DO $$
DECLARE entry RECORD; constraint_entry RECORD; column_entry RECORD;
BEGIN
  FOR entry IN SELECT table_name FROM assurapay_p1_tables LOOP
    -- Policies and historical triggers predicate on the retired workspace UUID authority.
    FOR constraint_entry IN
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = entry.table_name
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', constraint_entry.policyname, entry.table_name);
    END LOOP;
    FOR constraint_entry IN
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = format('public.%I', entry.table_name)::regclass AND NOT tgisinternal
    LOOP
      EXECUTE format('DROP TRIGGER %I ON public.%I', constraint_entry.tgname, entry.table_name);
    END LOOP;

    FOR column_entry IN
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = entry.table_name AND udt_name = 'uuid'
    LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', entry.table_name, column_entry.column_name);
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I TYPE TEXT USING %I::text',
        entry.table_name, column_entry.column_name, column_entry.column_name
      );
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id TEXT', entry.table_name);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', entry.table_name);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1', entry.table_name);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', entry.table_name);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (schema_version > 0)', entry.table_name, entry.table_name || '_schema_version_positive');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (row_version > 0)', entry.table_name, entry.table_name || '_row_version_positive');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', entry.table_name, entry.table_name || '_tenant_id_key');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', entry.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', entry.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I USING (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()) WITH CHECK (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace())',
      entry.table_name || '_trust_scope', entry.table_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) REFERENCES trust_workspaces(tenant_id, workspace_id)',
      entry.table_name, entry.table_name || '_trust_workspace_fkey'
    );
  END LOOP;
END $$;

DO $$
DECLARE constraint_entry RECORD;
BEGIN
  FOR constraint_entry IN SELECT * FROM assurapay_p1_checks LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I %s',
      constraint_entry.table_name, constraint_entry.conname, constraint_entry.definition
    );
  END LOOP;
END $$;

-- Restore every captured non-workspace edge as tenant-composite. Parents outside this activation
-- were converged by earlier certified batches and already expose `(tenant_id, id)`.
DO $$
DECLARE edge RECORD;
BEGIN
  FOR edge IN SELECT * FROM assurapay_p1_foreign_keys WHERE parent_table <> 'workspaces' LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = edge.parent_table AND column_name = 'tenant_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = edge.child_table AND column_name = 'tenant_id'
    ) THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES public.%I(tenant_id, %I)',
          edge.child_table, edge.conname || '_tenant', edge.child_column,
          edge.parent_table, edge.parent_column
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    ELSE
      BEGIN
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(%I)',
          edge.child_table, edge.conname, edge.child_column, edge.parent_table, edge.parent_column
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_relation(collection_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN CASE collection_name
    WHEN 'acceptanceCriteria' THEN 'public.acceptance_criteria'
    WHEN 'successMetrics' THEN 'public.success_metrics'
    WHEN 'dependencies' THEN 'public.dependencies'
    WHEN 'paymentTriggerRules' THEN 'public.payment_trigger_rules'
    WHEN 'performanceBaselines' THEN 'public.performance_baselines'
    WHEN 'baselineVariances' THEN 'public.baseline_variances'
    ELSE NULL
  END;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_list(collection_name TEXT)
RETURNS SETOF JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE relation_name TEXT; statement TEXT;
BEGIN
  relation_name := assurapay_p1_relation(collection_name);
  IF relation_name IS NULL THEN RAISE EXCEPTION 'P1_COLLECTION_NOT_MAPPED'; END IF;
  statement := format(
    'SELECT (to_jsonb(row_value) - ''tenant_id'' - ''schema_version'' - ''row_version'') || jsonb_build_object(''row_version'', row_version) FROM %s row_value ORDER BY id',
    relation_name
  );
  RETURN QUERY EXECUTE statement;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_append(
  collection_name TEXT, scoped_tenant TEXT, scoped_workspace TEXT, record JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE relation_name TEXT; normalized JSONB; statement TEXT;
BEGIN
  IF coalesce(record->>'workspace_id', record->>'workspaceId') IS DISTINCT FROM scoped_workspace THEN
    RAISE EXCEPTION 'P1_SCOPE_MISMATCH';
  END IF;
  relation_name := assurapay_p1_relation(collection_name);
  IF relation_name IS NULL THEN RAISE EXCEPTION 'P1_COLLECTION_NOT_MAPPED'; END IF;
  normalized := record || jsonb_build_object(
    'tenant_id', scoped_tenant, 'workspace_id', scoped_workspace, 'schema_version', 1, 'row_version', 1
  );
  statement := format('INSERT INTO %s SELECT (jsonb_populate_record(NULL::%s, $1)).*', relation_name, relation_name);
  EXECUTE statement USING normalized;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_replace(
  collection_name TEXT, scoped_tenant TEXT, scoped_workspace TEXT, record_id TEXT,
  expected_version INTEGER, record JSONB
) RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE relation_name TEXT; normalized JSONB; statement TEXT; assignments TEXT; affected INTEGER;
BEGIN
  IF coalesce(record->>'workspace_id', record->>'workspaceId') IS DISTINCT FROM scoped_workspace
     OR record->>'id' IS DISTINCT FROM record_id THEN
    RAISE EXCEPTION 'P1_SCOPE_MISMATCH';
  END IF;
  relation_name := assurapay_p1_relation(collection_name);
  IF relation_name IS NULL THEN RAISE EXCEPTION 'P1_COLLECTION_NOT_MAPPED'; END IF;
  normalized := record || jsonb_build_object('tenant_id', scoped_tenant, 'workspace_id', scoped_workspace);
  SELECT string_agg(
    format('%1$I = (jsonb_populate_record(NULL::%2$s, $1)).%1$I', column_name, relation_name), ', '
    ORDER BY ordinal_position
  ) INTO assignments
  FROM information_schema.columns
  WHERE table_schema = split_part(relation_name, '.', 1)
    AND table_name = split_part(relation_name, '.', 2)
    AND column_name NOT IN ('id', 'tenant_id', 'workspace_id', 'schema_version', 'row_version', 'created_at');
  statement := format(
    'UPDATE %s SET %s, row_version = row_version + 1 WHERE id = $2 AND tenant_id = $3 AND workspace_id = $4 AND row_version = $5',
    relation_name, assignments
  );
  EXECUTE statement USING normalized, record_id, scoped_tenant, scoped_workspace, expected_version;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 0 THEN
    statement := format(
      'SELECT CASE WHEN EXISTS (SELECT 1 FROM %s WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3) THEN -1 ELSE 0 END',
      relation_name
    );
    EXECUTE statement INTO affected USING record_id, scoped_tenant, scoped_workspace;
  END IF;
  RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_mutation_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AGGREGATE_ROW_IS_NOT_DELETABLE'; END IF;
  IF TG_ARGV[0] = 'append_only' THEN RAISE EXCEPTION 'append-only table'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'AGGREGATE_VERSION_MUST_ADVANCE'; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE entry RECORD; mode TEXT;
BEGIN
  FOR entry IN SELECT table_name FROM assurapay_p1_tables LOOP
    mode := CASE WHEN entry.table_name IN (
      'performance_baselines', 'baseline_variances'
    ) THEN 'append_only' ELSE 'governed' END;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION assurapay_p1_mutation_guard(%L)',
      entry.table_name || '_p1_mutation', entry.table_name, mode
    );
  END LOOP;
END $$;

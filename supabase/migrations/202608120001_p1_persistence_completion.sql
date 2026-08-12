-- P1 persistence completion: governance-core, agreement intelligence, enterprise intelligence,
-- enterprise analytics and the governed Agent Runtime.
--
-- This migration is deliberately a convergence over the relations the engine migrations already
-- declared. It creates only `analysis_reviews`, the one live aggregate with no prior relation. The
-- activation refuses non-empty legacy relations rather than inventing tenant ownership or rewriting
-- records whose identifiers were created under the superseded UUID authority.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS analysis_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPTED', 'REJECTED')),
  notes TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (tenant_id, id)
);

CREATE TEMP TABLE assurapay_p1_tables(table_name TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO assurapay_p1_tables(table_name) VALUES
  ('governed_executions'), ('execution_history'), ('governed_milestones'),
  ('milestone_dependencies'), ('dod_versions'), ('dod_evaluations'),
  ('certification_requests'), ('certification_decisions'), ('digital_certification_records'),
  ('payment_trigger_definitions'), ('payment_authorization_proposals'),
  ('contract_versions_v2'), ('contract_analysis_runs'), ('contract_risk_assessments'),
  ('contract_repository_documents'), ('agreement_intelligence_versions'), ('analysis_reviews'),
  ('execution_assurance_indices'), ('settlement_assurance_indices'), ('kpi_definitions'),
  ('kpi_values'), ('dashboard_snapshots'), ('execution_forecasts'),
  ('financial_forecasts'), ('performance_scorecards'), ('portfolio_snapshots'),
  ('renewal_assessments'), ('model_registrations'), ('evaluation_records'), ('drift_alerts'),
  ('model_feedback'), ('recommendations');

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
  SELECT count(*) INTO held FROM agent_runtime.records;
  IF held <> 0 THEN
    RAISE EXCEPTION 'P1_PERSISTENCE_ACTIVATION_REFUSED: agent_runtime.records=% rows; nothing has been changed', held;
  END IF;
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
  AND (
    child.relname IN (SELECT table_name FROM assurapay_p1_tables)
    OR parent.relname IN (SELECT table_name FROM assurapay_p1_tables)
  )
  AND array_length(con.conkey, 1) = 1;

CREATE TEMP TABLE assurapay_p1_checks ON COMMIT DROP AS
SELECT child.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
WHERE con.contype = 'c' AND child_ns.nspname = 'public'
  AND child.relname IN (SELECT table_name FROM assurapay_p1_tables);

-- Drop the entire captured edge set before converting either side. Doing this table-by-table would
-- leave an incoming UUID foreign key attached while its parent id is converted to TEXT.
DO $$
DECLARE constraint_entry RECORD;
BEGIN
  FOR constraint_entry IN
    SELECT child_table, conname FROM assurapay_p1_foreign_keys
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I',
      constraint_entry.child_table, constraint_entry.conname
    );
  END LOOP;
  FOR constraint_entry IN SELECT table_name, conname FROM assurapay_p1_checks LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I',
      constraint_entry.table_name, constraint_entry.conname
    );
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
          edge.child_table, edge.conname, edge.child_column,
          edge.parent_table, edge.parent_column
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

-- Agent Runtime uses one canonical relation by design: `record_type` is the discriminator and the
-- full advisory artifact remains the payload. Identity and scope are still first-class columns.
DO $$
DECLARE policy_entry RECORD; trigger_entry RECORD;
BEGIN
  FOR policy_entry IN SELECT policyname FROM pg_policies WHERE schemaname = 'agent_runtime' AND tablename = 'records' LOOP
    EXECUTE format('DROP POLICY %I ON agent_runtime.records', policy_entry.policyname);
  END LOOP;
  FOR trigger_entry IN
    SELECT tgname FROM pg_trigger WHERE tgrelid = 'agent_runtime.records'::regclass AND NOT tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER %I ON agent_runtime.records', trigger_entry.tgname);
  END LOOP;
END $$;
ALTER TABLE agent_runtime.records ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE agent_runtime.records ALTER COLUMN tenant_id TYPE TEXT USING tenant_id::text;
ALTER TABLE agent_runtime.records ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text;
ALTER TABLE agent_runtime.records ALTER COLUMN created_by TYPE TEXT USING created_by::text;
ALTER TABLE agent_runtime.records ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0);
ALTER TABLE agent_runtime.records ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0);
ALTER TABLE agent_runtime.records ADD CONSTRAINT agent_runtime_records_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE agent_runtime.records ADD CONSTRAINT agent_runtime_records_trust_workspace_fkey
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES trust_workspaces(tenant_id, workspace_id);
ALTER TABLE agent_runtime.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime.records FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_runtime_records_trust_scope ON agent_runtime.records
  USING (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace())
  WITH CHECK (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace());

CREATE OR REPLACE FUNCTION assurapay_p1_relation(collection_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN CASE collection_name
    WHEN 'governedExecutions' THEN 'public.governed_executions'
    WHEN 'executionHistory' THEN 'public.execution_history'
    WHEN 'governedMilestones' THEN 'public.governed_milestones'
    WHEN 'milestoneDependencies' THEN 'public.milestone_dependencies'
    WHEN 'dodVersions' THEN 'public.dod_versions'
    WHEN 'dodEvaluations' THEN 'public.dod_evaluations'
    WHEN 'certificationRequests' THEN 'public.certification_requests'
    WHEN 'certificationDecisions' THEN 'public.certification_decisions'
    WHEN 'digitalCertifications' THEN 'public.digital_certification_records'
    WHEN 'paymentTriggerDefinitions' THEN 'public.payment_trigger_definitions'
    WHEN 'paymentAuthorizationProposals' THEN 'public.payment_authorization_proposals'
    WHEN 'contractVersionsV2' THEN 'public.contract_versions_v2'
    WHEN 'contractAnalysisRuns' THEN 'public.contract_analysis_runs'
    WHEN 'analysisReviews' THEN 'public.analysis_reviews'
    WHEN 'contractRiskAssessments' THEN 'public.contract_risk_assessments'
    WHEN 'repositoryDocuments' THEN 'public.contract_repository_documents'
    WHEN 'agreementIntelligenceVersions' THEN 'public.agreement_intelligence_versions'
    WHEN 'executionAssuranceIndices' THEN 'public.execution_assurance_indices'
    WHEN 'settlementAssuranceIndices' THEN 'public.settlement_assurance_indices'
    WHEN 'kpiDefinitions' THEN 'public.kpi_definitions'
    WHEN 'kpiValues' THEN 'public.kpi_values'
    WHEN 'dashboardSnapshots' THEN 'public.dashboard_snapshots'
    WHEN 'executionForecasts' THEN 'public.execution_forecasts'
    WHEN 'financialForecasts' THEN 'public.financial_forecasts'
    WHEN 'performanceScorecards' THEN 'public.performance_scorecards'
    WHEN 'portfolioSnapshots' THEN 'public.portfolio_snapshots'
    WHEN 'renewalAssessments' THEN 'public.renewal_assessments'
    WHEN 'modelRegistrations' THEN 'public.model_registrations'
    WHEN 'evaluationRecords' THEN 'public.evaluation_records'
    WHEN 'driftAlerts' THEN 'public.drift_alerts'
    WHEN 'modelFeedback' THEN 'public.model_feedback'
    WHEN 'recommendations' THEN 'public.recommendations'
    ELSE NULL
  END;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_agent_type(collection_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE collection_name
    WHEN 'agentCapabilities' THEN 'capability'
    WHEN 'registeredAgents' THEN 'agent'
    WHEN 'promptVersions' THEN 'prompt'
    WHEN 'agentContextSnapshots' THEN 'context'
    WHEN 'agentMemory' THEN 'memory'
    WHEN 'agentApprovalRequests' THEN 'approval'
    WHEN 'agentTelemetry' THEN 'telemetry'
    WHEN 'agentGovernancePolicies' THEN 'governance_policy'
    WHEN 'agentExecutions' THEN 'execution'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION assurapay_p1_list(collection_name TEXT)
RETURNS SETOF JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE relation_name TEXT; agent_type TEXT; statement TEXT;
BEGIN
  agent_type := assurapay_p1_agent_type(collection_name);
  IF agent_type IS NOT NULL THEN
    RETURN QUERY SELECT payload || jsonb_build_object('rowVersion', row_version) FROM agent_runtime.records
      WHERE record_type = agent_type ORDER BY created_at, id;
    RETURN;
  END IF;
  relation_name := assurapay_p1_relation(collection_name);
  IF relation_name IS NULL THEN RAISE EXCEPTION 'P1_COLLECTION_NOT_MAPPED'; END IF;
  statement := format(
    'SELECT (to_jsonb(row_value) - ''tenant_id'' - ''schema_version'' - ''row_version'') || jsonb_build_object(''row_version'', row_version) FROM %s row_value ORDER BY created_at, id',
    relation_name
  );
  RETURN QUERY EXECUTE statement;
END $$;

CREATE OR REPLACE FUNCTION assurapay_p1_append(
  collection_name TEXT, scoped_tenant TEXT, scoped_workspace TEXT, record JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE relation_name TEXT; agent_type TEXT; normalized JSONB; statement TEXT;
BEGIN
  IF coalesce(record->>'workspace_id', record->>'workspaceId') IS DISTINCT FROM scoped_workspace THEN
    RAISE EXCEPTION 'P1_SCOPE_MISMATCH';
  END IF;
  agent_type := assurapay_p1_agent_type(collection_name);
  IF agent_type IS NOT NULL THEN
    INSERT INTO agent_runtime.records(
      id, tenant_id, workspace_id, record_type, version, status, payload, payload_hash,
      created_by, created_at, schema_version, row_version
    ) VALUES (
      record->>'id', scoped_tenant, scoped_workspace, agent_type,
      CASE WHEN (record->>'version') ~ '^[0-9]+$' THEN (record->>'version')::INTEGER ELSE NULL END,
      record->>'status', record, encode(digest(record::TEXT, 'sha256'), 'hex'),
      coalesce(record->>'created_by', record->>'createdBy', record->>'requested_by',
        record->>'requestedBy', record->>'actor_id', record->>'actorId', 'system'),
      coalesce((coalesce(record->>'created_at', record->>'createdAt'))::TIMESTAMPTZ, clock_timestamp()), 1, 1
    );
    RETURN;
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
DECLARE relation_name TEXT; agent_type TEXT; normalized JSONB; statement TEXT; assignments TEXT; affected INTEGER;
BEGIN
  IF coalesce(record->>'workspace_id', record->>'workspaceId') IS DISTINCT FROM scoped_workspace
     OR record->>'id' IS DISTINCT FROM record_id THEN
    RAISE EXCEPTION 'P1_SCOPE_MISMATCH';
  END IF;
  agent_type := assurapay_p1_agent_type(collection_name);
  IF agent_type IS NOT NULL THEN
    UPDATE agent_runtime.records SET
      version = CASE WHEN (record->>'version') ~ '^[0-9]+$' THEN (record->>'version')::INTEGER ELSE version END,
      status = record->>'status', payload = record,
      payload_hash = encode(digest(record::TEXT, 'sha256'), 'hex'), row_version = row_version + 1
    WHERE id = record_id AND tenant_id = scoped_tenant AND workspace_id = scoped_workspace
      AND record_type = agent_type AND row_version = expected_version;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected = 0 AND EXISTS (
      SELECT 1 FROM agent_runtime.records
      WHERE id = record_id AND tenant_id = scoped_tenant AND workspace_id = scoped_workspace
        AND record_type = agent_type
    ) THEN RETURN -1; END IF;
    RETURN affected;
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
  IF TG_TABLE_SCHEMA = 'agent_runtime' AND OLD.record_type IN ('context', 'memory', 'telemetry') THEN
    RAISE EXCEPTION 'append-only table';
  END IF;
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
      'execution_history', 'milestone_dependencies', 'dod_evaluations', 'certification_decisions',
      'digital_certification_records', 'payment_trigger_definitions', 'payment_authorization_proposals',
      'contract_analysis_runs', 'analysis_reviews', 'execution_assurance_indices',
      'settlement_assurance_indices', 'kpi_values', 'dashboard_snapshots', 'performance_scorecards',
      'portfolio_snapshots', 'renewal_assessments', 'evaluation_records', 'model_feedback'
    ) THEN 'append_only' ELSE 'governed' END;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION assurapay_p1_mutation_guard(%L)',
      entry.table_name || '_p1_mutation', entry.table_name, mode
    );
  END LOOP;
END $$;

CREATE TRIGGER agent_runtime_records_p1_mutation
BEFORE UPDATE OR DELETE ON agent_runtime.records
FOR EACH ROW EXECUTE FUNCTION assurapay_p1_mutation_guard('governed');

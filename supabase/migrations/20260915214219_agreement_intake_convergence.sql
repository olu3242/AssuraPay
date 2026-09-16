-- Canonical intake persistence. Identifiers match the existing TEXT trust schema.
CREATE TABLE agreement_intakes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('DIRECT_DESCRIPTION','INFORMAL_ARTIFACT','FORMAL_DOCUMENT')),
  source_artifact_ids JSONB NOT NULL CHECK (jsonb_typeof(source_artifact_ids) = 'array'),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  proposed_terms JSONB NOT NULL CHECK (jsonb_typeof(proposed_terms) = 'array'),
  clarifications JSONB NOT NULL CHECK (jsonb_typeof(clarifications) = 'array'),
  clarity_score INTEGER NOT NULL CHECK (clarity_score BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('INGESTED','NEEDS_CLARIFICATION','READY_FOR_REVIEW','REVIEWED','CONVERTED')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  converted_agreement_id TEXT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES trust_workspaces(tenant_id, workspace_id),
  CHECK ((status IN ('REVIEWED','CONVERTED')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK ((status = 'CONVERTED') = (converted_agreement_id IS NOT NULL))
);
CREATE INDEX agreement_intakes_workspace ON agreement_intakes(tenant_id, workspace_id, created_at, id);
ALTER TABLE agreement_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreement_intakes FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_intakes_scope ON agreement_intakes
  USING (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace())
  WITH CHECK (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace());

CREATE FUNCTION govern_agreement_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AGGREGATE_ROW_IS_NOT_DELETABLE';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.source_type, NEW.source_artifact_ids,
      NEW.source_hash, NEW.created_by, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.source_type, OLD.source_artifact_ids,
      OLD.source_hash, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE';
  END IF;
  IF OLD.status = 'CONVERTED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'AGGREGATE_STATE_IS_TERMINAL';
  END IF;
  IF OLD.status = 'REVIEWED' AND (
      NEW.status NOT IN ('REVIEWED','CONVERTED') OR
      (NEW.proposed_terms, NEW.clarifications, NEW.clarity_score, NEW.reviewed_by, NEW.reviewed_at)
        IS DISTINCT FROM
      (OLD.proposed_terms, OLD.clarifications, OLD.clarity_score, OLD.reviewed_by, OLD.reviewed_at)) THEN
    RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agreement_intake_governance BEFORE UPDATE OR DELETE ON agreement_intakes
  FOR EACH ROW EXECUTE FUNCTION govern_agreement_intake();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    GRANT SELECT, INSERT, UPDATE ON agreement_intakes TO assurapay_app;
  END IF;
END;
$$;

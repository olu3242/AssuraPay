-- Backfill relational scope without changing the integrity-checked payload.
-- The owner needs full visibility only inside this migration transaction.
ALTER TABLE trust_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE trust_workspaces NO FORCE ROW LEVEL SECURITY;
UPDATE trust_records AS policy SET tenant_id = workspace.tenant_id
FROM trust_workspaces AS workspace
WHERE policy.collection = 'legalPolicies' AND policy.workspace_id = workspace.workspace_id;
UPDATE trust_records AS version
SET tenant_id = policy.tenant_id, workspace_id = policy.workspace_id
FROM trust_records AS policy
WHERE version.collection = 'legalPolicyVersions'
  AND policy.collection = 'legalPolicies'
  AND policy.record_id = version.payload->>'legalPolicyId'
  AND policy.tenant_id IS NOT NULL AND policy.workspace_id IS NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trust_records
    WHERE collection IN ('legalPolicies','legalPolicyVersions')
      AND (tenant_id IS NULL OR workspace_id IS NULL)) THEN
    RAISE EXCEPTION 'LEGAL_POLICY_SCOPE_BACKFILL_REQUIRED: map legacy global or orphan policies to an authorized scope before retrying';
  END IF;
END;
$$;
ALTER TABLE trust_records FORCE ROW LEVEL SECURITY;
ALTER TABLE trust_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_policy_scope_boundary ON trust_records AS RESTRICTIVE
  USING (collection NOT IN ('legalPolicies','legalPolicyVersions') OR
    (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()))
  WITH CHECK (collection NOT IN ('legalPolicies','legalPolicyVersions') OR
    (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()));
ALTER TABLE trust_records ADD CONSTRAINT legal_policy_scope_required CHECK (
  collection NOT IN ('legalPolicies','legalPolicyVersions') OR
  (tenant_id IS NOT NULL AND workspace_id IS NOT NULL)
);

CREATE FUNCTION govern_legal_policy_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.collection NOT IN ('legalPolicies','legalPolicyVersions') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'TRUST_HISTORY_IS_APPEND_ONLY'; END IF;
  IF (NEW.collection, NEW.record_id, NEW.tenant_id, NEW.workspace_id) IS DISTINCT FROM
     (OLD.collection, OLD.record_id, OLD.tenant_id, OLD.workspace_id) THEN
    RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE';
  END IF;
  IF OLD.collection = 'legalPolicyVersions' AND OLD.payload->>'publicationStatus' IN ('PUBLISHED','SUPERSEDED') THEN
    IF (NEW.payload - 'publicationStatus' - 'effectiveTo' - 'tenantId' - 'workspaceId') IS DISTINCT FROM
       (OLD.payload - 'publicationStatus' - 'effectiveTo' - 'tenantId' - 'workspaceId') OR
       NEW.payload->>'publicationStatus' NOT IN ('PUBLISHED','SUPERSEDED') OR
       (OLD.payload->>'publicationStatus' = 'SUPERSEDED' AND NEW.payload IS DISTINCT FROM OLD.payload) THEN
      RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legal_policy_history BEFORE UPDATE OR DELETE ON trust_records
  FOR EACH ROW EXECUTE FUNCTION govern_legal_policy_history();

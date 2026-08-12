CREATE TABLE payment_trigger_evaluations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  payment_trigger_rule_id TEXT NOT NULL,
  eligible BOOLEAN NOT NULL,
  blockers JSONB NOT NULL,
  evaluated_by TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES trust_workspaces(tenant_id, workspace_id),
  FOREIGN KEY (tenant_id, payment_trigger_rule_id) REFERENCES payment_trigger_rules(tenant_id, id)
);

CREATE INDEX payment_trigger_evaluations_milestone_idx
  ON payment_trigger_evaluations(tenant_id, workspace_id, milestone_id, evaluated_at);

ALTER TABLE payment_trigger_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_trigger_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_trigger_evaluations_trust_scope ON payment_trigger_evaluations
  USING (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace())
  WITH CHECK (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace());

CREATE TRIGGER payment_trigger_evaluations_p1_mutation
  BEFORE UPDATE OR DELETE ON payment_trigger_evaluations
  FOR EACH ROW EXECUTE FUNCTION assurapay_p1_mutation_guard('append_only');

CREATE OR REPLACE FUNCTION assurapay_p1_relation(collection_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN CASE collection_name
    WHEN 'acceptanceCriteria' THEN 'public.acceptance_criteria'
    WHEN 'successMetrics' THEN 'public.success_metrics'
    WHEN 'dependencies' THEN 'public.dependencies'
    WHEN 'paymentTriggerRules' THEN 'public.payment_trigger_rules'
    WHEN 'paymentTriggerEvaluations' THEN 'public.payment_trigger_evaluations'
    WHEN 'performanceBaselines' THEN 'public.performance_baselines'
    WHEN 'baselineVariances' THEN 'public.baseline_variances'
    ELSE NULL
  END;
END $$;

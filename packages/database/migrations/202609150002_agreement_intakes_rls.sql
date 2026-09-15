-- Agreement intake RLS follows the same tenant/workspace context contract as the rest of AssuraPay.
-- Policies intentionally use transaction-local settings so pooled connections do not leak authority.
CREATE POLICY agreement_intakes_workspace_select ON agreement_intakes
FOR SELECT USING (
  tenant_id::text = current_setting('app.tenant_id', true)
  AND workspace_id::text = current_setting('app.workspace_id', true)
);
CREATE POLICY agreement_intakes_workspace_insert ON agreement_intakes
FOR INSERT WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true)
  AND workspace_id::text = current_setting('app.workspace_id', true)
);
CREATE POLICY agreement_intakes_workspace_update ON agreement_intakes
FOR UPDATE USING (
  tenant_id::text = current_setting('app.tenant_id', true)
  AND workspace_id::text = current_setting('app.workspace_id', true)
) WITH CHECK (
  tenant_id::text = current_setting('app.tenant_id', true)
  AND workspace_id::text = current_setting('app.workspace_id', true)
);

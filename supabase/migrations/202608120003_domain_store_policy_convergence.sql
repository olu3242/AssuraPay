BEGIN;

DROP POLICY domain_records_tenant_isolation ON domain_records;

CREATE POLICY domain_records_tenant_isolation ON domain_records
  USING (
    tenant_id = trust_current_tenant()
    AND (
      workspace_id IS NULL
      OR trust_current_workspace() IS NULL
      OR workspace_id = trust_current_workspace()
    )
  )
  WITH CHECK (
    tenant_id = trust_current_tenant()
    AND (
      workspace_id IS NULL
      OR trust_current_workspace() IS NULL
      OR workspace_id = trust_current_workspace()
    )
  );

COMMIT;

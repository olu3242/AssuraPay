-- Authentication deliveries are private to the identity named by the server-side scope.
-- Business deliveries require both tenant and workspace. Existing permissive trust policies
-- cannot widen this boundary because the second policy is restrictive.
CREATE POLICY notification_identity_delivery ON trust_records
  USING (collection = 'notificationDeliveries'
    AND trust_current_tenant() IS NULL AND tenant_id IS NULL AND workspace_id IS NULL
    AND principal_id = trust_current_actor()
    AND payload->>'purpose' IN ('VERIFY_EMAIL', 'LOGIN'))
  WITH CHECK (collection = 'notificationDeliveries'
    AND trust_current_tenant() IS NULL AND tenant_id IS NULL AND workspace_id IS NULL
    AND principal_id = trust_current_actor()
    AND payload->>'purpose' IN ('VERIFY_EMAIL', 'LOGIN'));
CREATE POLICY notification_delivery_boundary ON trust_records AS RESTRICTIVE
  USING (collection <> 'notificationDeliveries' OR
    (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()) OR
    (tenant_id IS NULL AND workspace_id IS NULL AND trust_current_tenant() IS NULL
      AND principal_id = trust_current_actor() AND payload->>'purpose' IN ('VERIFY_EMAIL','LOGIN')))
  WITH CHECK (collection <> 'notificationDeliveries' OR
    (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()) OR
    (tenant_id IS NULL AND workspace_id IS NULL AND trust_current_tenant() IS NULL
      AND principal_id = trust_current_actor() AND payload->>'purpose' IN ('VERIFY_EMAIL','LOGIN')));
ALTER TABLE trust_records ADD CONSTRAINT notification_delivery_scope CHECK (
  collection <> 'notificationDeliveries' OR
  ((tenant_id IS NOT NULL AND workspace_id IS NOT NULL) OR
   (tenant_id IS NULL AND workspace_id IS NULL AND principal_id IS NOT NULL
     AND COALESCE(payload->>'purpose' IN ('VERIFY_EMAIL','LOGIN'), FALSE)))
);

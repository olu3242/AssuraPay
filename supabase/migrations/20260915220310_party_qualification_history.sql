-- Both qualification collections are private workspace records with immutable history.
CREATE POLICY qualification_scope ON trust_records AS RESTRICTIVE
USING (collection NOT IN ('qualificationPolicies','partyQualifications') OR
 (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()))
WITH CHECK (collection NOT IN ('qualificationPolicies','partyQualifications') OR
 (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()));
ALTER TABLE trust_records ADD CONSTRAINT qualification_scope_required CHECK (
 collection NOT IN ('qualificationPolicies','partyQualifications') OR COALESCE(
 tenant_id IS NOT NULL AND workspace_id IS NOT NULL AND payload->>'tenantId' = tenant_id
 AND payload->>'workspaceId' = workspace_id AND payload->>'kind' IN ('SERIOUS_SELLER','DEDICATED_BUYER'), FALSE));
CREATE UNIQUE INDEX qualification_policy_version ON trust_records(tenant_id,workspace_id,(payload->>'kind'),(payload->>'version')) WHERE collection = 'qualificationPolicies';
CREATE UNIQUE INDEX qualification_history_version ON trust_records(tenant_id,workspace_id,(payload->>'qualificationId'),(payload->>'version')) WHERE collection = 'partyQualifications';
CREATE FUNCTION protect_qualification_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.collection IN ('qualificationPolicies','partyQualifications') THEN
  RAISE EXCEPTION 'TRUST_HISTORY_IS_APPEND_ONLY';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER qualification_history BEFORE UPDATE OR DELETE ON trust_records
 FOR EACH ROW EXECUTE FUNCTION protect_qualification_history();

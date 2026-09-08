-- Dedicated relational persistence for Agentic OS persona profiles.
--
-- Persona profiles are governance state, not opaque documents. The database therefore
-- enforces the two invariants the generic trust_records plane could not:
--   1. one version number per persona/specialization scope;
--   2. at most one active profile per persona/specialization scope.
--
-- Compatibility bridge: current PostgresTrustStore callers still address the canonical
-- `personaAgentProfiles` collection. A projection trigger mirrors those writes into this
-- typed table and makes the relational constraints authoritative immediately. A later
-- store-routing cleanup can read/write this table directly without changing the domain API.

CREATE TABLE IF NOT EXISTS persona_agent_profiles (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  workspace_id           TEXT NOT NULL,
  persona                TEXT NOT NULL,
  name                   TEXT NOT NULL,
  mission                TEXT NOT NULL,
  registered_agent_id    TEXT NOT NULL,
  prompt_id              TEXT NOT NULL,
  capability_id          TEXT NOT NULL,
  autonomy_level         INTEGER NOT NULL CHECK (autonomy_level BETWEEN 0 AND 5),
  allowed_roles          JSONB NOT NULL CHECK (jsonb_typeof(allowed_roles) = 'array'),
  allowed_action_classes JSONB NOT NULL CHECK (jsonb_typeof(allowed_action_classes) = 'array'),
  max_risk               TEXT NOT NULL CHECK (max_risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  industry               TEXT,
  organization_id        TEXT,
  active                 BOOLEAN NOT NULL DEFAULT FALSE,
  version                INTEGER NOT NULL CHECK (version >= 1),
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT persona_agent_profiles_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES trust_workspaces(workspace_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS persona_agent_profiles_scope_version_uq
  ON persona_agent_profiles (
    workspace_id,
    persona,
    COALESCE(industry, ''),
    COALESCE(organization_id, ''),
    version
  );

CREATE UNIQUE INDEX IF NOT EXISTS persona_agent_profiles_one_active_uq
  ON persona_agent_profiles (
    workspace_id,
    persona,
    COALESCE(industry, ''),
    COALESCE(organization_id, '')
  )
  WHERE active;

CREATE INDEX IF NOT EXISTS persona_agent_profiles_resolution_idx
  ON persona_agent_profiles (tenant_id, workspace_id, persona, active);

ALTER TABLE persona_agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE persona_agent_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS persona_agent_profiles_scope ON persona_agent_profiles;
CREATE POLICY persona_agent_profiles_scope ON persona_agent_profiles
  USING (
    tenant_id = trust_current_tenant()
    AND workspace_id = trust_current_workspace()
  )
  WITH CHECK (
    tenant_id = trust_current_tenant()
    AND workspace_id = trust_current_workspace()
  );

-- Configuration history is immutable except for activation state. A new semantic
-- configuration is a new version; UPDATE may only switch `active` and refresh updated_at.
CREATE OR REPLACE FUNCTION protect_persona_agent_profile_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.persona IS DISTINCT FROM OLD.persona
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.mission IS DISTINCT FROM OLD.mission
     OR NEW.registered_agent_id IS DISTINCT FROM OLD.registered_agent_id
     OR NEW.prompt_id IS DISTINCT FROM OLD.prompt_id
     OR NEW.capability_id IS DISTINCT FROM OLD.capability_id
     OR NEW.autonomy_level IS DISTINCT FROM OLD.autonomy_level
     OR NEW.allowed_roles IS DISTINCT FROM OLD.allowed_roles
     OR NEW.allowed_action_classes IS DISTINCT FROM OLD.allowed_action_classes
     OR NEW.max_risk IS DISTINCT FROM OLD.max_risk
     OR NEW.industry IS DISTINCT FROM OLD.industry
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PERSONA_AGENT_PROFILE_CONFIGURATION_IMMUTABLE';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS persona_agent_profiles_immutable_configuration ON persona_agent_profiles;
CREATE TRIGGER persona_agent_profiles_immutable_configuration
BEFORE UPDATE ON persona_agent_profiles
FOR EACH ROW EXECUTE FUNCTION protect_persona_agent_profile_immutability();

-- Existing generic rows are projected once on upgrade. The cast/checks deliberately fail
-- migration on malformed governance data rather than silently carrying corrupt profiles.
INSERT INTO persona_agent_profiles (
  id, tenant_id, workspace_id, persona, name, mission, registered_agent_id, prompt_id,
  capability_id, autonomy_level, allowed_roles, allowed_action_classes, max_risk,
  industry, organization_id, active, version, created_at
)
SELECT
  record_id,
  tenant_id,
  workspace_id,
  payload->>'persona',
  payload->>'name',
  payload->>'mission',
  payload->>'registeredAgentId',
  payload->>'promptId',
  payload->>'capabilityId',
  (payload->>'autonomyLevel')::integer,
  payload->'allowedRoles',
  payload->'allowedActionClasses',
  payload->>'maxRisk',
  NULLIF(payload->>'industry', ''),
  NULLIF(payload->>'organizationId', ''),
  COALESCE((payload->>'active')::boolean, false),
  COALESCE((payload->>'version')::integer, version, 1),
  COALESCE((payload->>'createdAt')::timestamptz, created_at)
FROM trust_records
WHERE collection = 'personaAgentProfiles'
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION project_persona_agent_profile_from_trust_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.collection <> 'personaAgentProfiles' THEN
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS NULL OR NEW.workspace_id IS NULL THEN
    RAISE EXCEPTION 'PERSONA_AGENT_PROFILE_SCOPE_REQUIRED';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW.payload - 'active') IS DISTINCT FROM (OLD.payload - 'active')
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'PERSONA_AGENT_PROFILE_CONFIGURATION_IMMUTABLE';
    END IF;

    UPDATE persona_agent_profiles
    SET active = COALESCE((NEW.payload->>'active')::boolean, false)
    WHERE id = NEW.record_id;
    RETURN NEW;
  END IF;

  INSERT INTO persona_agent_profiles (
    id, tenant_id, workspace_id, persona, name, mission, registered_agent_id, prompt_id,
    capability_id, autonomy_level, allowed_roles, allowed_action_classes, max_risk,
    industry, organization_id, active, version, created_at
  ) VALUES (
    NEW.record_id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.payload->>'persona',
    NEW.payload->>'name',
    NEW.payload->>'mission',
    NEW.payload->>'registeredAgentId',
    NEW.payload->>'promptId',
    NEW.payload->>'capabilityId',
    (NEW.payload->>'autonomyLevel')::integer,
    NEW.payload->'allowedRoles',
    NEW.payload->'allowedActionClasses',
    NEW.payload->>'maxRisk',
    NULLIF(NEW.payload->>'industry', ''),
    NULLIF(NEW.payload->>'organizationId', ''),
    COALESCE((NEW.payload->>'active')::boolean, false),
    COALESCE((NEW.payload->>'version')::integer, NEW.version, 1),
    COALESCE((NEW.payload->>'createdAt')::timestamptz, NEW.created_at)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trust_records_project_persona_agent_profile ON trust_records;
CREATE TRIGGER trust_records_project_persona_agent_profile
AFTER INSERT OR UPDATE ON trust_records
FOR EACH ROW
WHEN (NEW.collection = 'personaAgentProfiles')
EXECUTE FUNCTION project_persona_agent_profile_from_trust_record();

CREATE OR REPLACE FUNCTION refuse_persona_agent_profile_delete_from_trust_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.collection = 'personaAgentProfiles' THEN
    RAISE EXCEPTION 'PERSONA_AGENT_PROFILE_HISTORY_IMMUTABLE';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trust_records_refuse_persona_agent_profile_delete ON trust_records;
CREATE TRIGGER trust_records_refuse_persona_agent_profile_delete
BEFORE DELETE ON trust_records
FOR EACH ROW
WHEN (OLD.collection = 'personaAgentProfiles')
EXECUTE FUNCTION refuse_persona_agent_profile_delete_from_trust_record();

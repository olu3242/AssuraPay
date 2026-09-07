-- Dedicated relational persistence for Agentic OS persona profiles.
--
-- Persona profiles are governance state, not opaque documents. The database therefore
-- enforces the two invariants the generic trust_records plane could not:
--   1. one version number per persona/specialization scope;
--   2. at most one active profile per persona/specialization scope.

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

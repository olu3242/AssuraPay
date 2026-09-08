-- Finalizes direct relational ownership for Agentic OS persona profiles.
--
-- `PostgresTrustStore` now reads and writes `persona_agent_profiles` directly through
-- `persona-agent-repository.ts`. The generic trust_records projection introduced in
-- 202609070001 was only a migration bridge and is retired here so there is one source
-- of truth for persona-agent governance state.

DROP TRIGGER IF EXISTS trust_records_project_persona_agent_profile ON trust_records;
DROP FUNCTION IF EXISTS project_persona_agent_profile_from_trust_record();

DROP TRIGGER IF EXISTS trust_records_refuse_persona_agent_profile_delete ON trust_records;
DROP FUNCTION IF EXISTS refuse_persona_agent_profile_delete_from_trust_record();

-- Historical bridge rows are no longer live state. The dedicated table was backfilled
-- by 202609070001 before this migration can run, so deleting these rows cannot lose a
-- persona profile and prevents future readers from observing two authorities.
DELETE FROM trust_records WHERE collection = 'personaAgentProfiles';

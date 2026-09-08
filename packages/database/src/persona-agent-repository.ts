import type { SqlClient } from './postgres-client';
import { PostgresStoreError } from './store-error';

export const PERSONA_AGENT_COLLECTION = 'personaAgentProfiles';
export const PERSONA_AGENT_TABLE = 'persona_agent_profiles';

type Row = Record<string, unknown>;
type PersonaAgentRow = {
  id: string; tenant_id: string; workspace_id: string; persona: string; name: string; mission: string;
  registered_agent_id: string; prompt_id: string; capability_id: string; autonomy_level: number;
  allowed_roles: unknown; allowed_action_classes: unknown; max_risk: string; industry: string | null;
  organization_id: string | null; active: boolean; version: number; created_at: Date;
};

function stringField(record: Row, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${PERSONA_AGENT_COLLECTION}.${field} is required`);
  return value;
}
function optionalString(record: Row, field: string): string | null {
  const value = record[field];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${PERSONA_AGENT_COLLECTION}.${field} must be a non-empty string when supplied`);
  return value;
}
function stringArray(record: Row, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${PERSONA_AGENT_COLLECTION}.${field} must be a string array`);
  return value as string[];
}
function integerField(record: Row, field: string): number {
  const value = record[field];
  if (!Number.isInteger(value)) throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${PERSONA_AGENT_COLLECTION}.${field} must be an integer`);
  return value as number;
}
function booleanField(record: Row, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${PERSONA_AGENT_COLLECTION}.${field} must be boolean`);
  return value;
}
function createdAt(record: Row): string {
  const value = stringField(record, 'createdAt');
  if (Number.isNaN(Date.parse(value))) throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', `${PERSONA_AGENT_COLLECTION}.createdAt must be an instant`);
  return value;
}
function rowToRecord(row: PersonaAgentRow): Row {
  return {
    id: row.id, tenantId: row.tenant_id, workspaceId: row.workspace_id, persona: row.persona,
    name: row.name, mission: row.mission, registeredAgentId: row.registered_agent_id,
    promptId: row.prompt_id, capabilityId: row.capability_id, autonomyLevel: row.autonomy_level,
    allowedRoles: row.allowed_roles, allowedActionClasses: row.allowed_action_classes, maxRisk: row.max_risk,
    ...(row.industry === null ? {} : { industry: row.industry }),
    ...(row.organization_id === null ? {} : { organizationId: row.organization_id }),
    active: row.active, version: row.version, createdAt: row.created_at.toISOString(),
  };
}
const IMMUTABLE_FIELDS = [
  'tenantId','workspaceId','persona','name','mission','registeredAgentId','promptId','capabilityId',
  'autonomyLevel','allowedRoles','allowedActionClasses','maxRisk','industry','organizationId','version','createdAt',
] as const;
function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true;
  return left === right;
}

export const personaAgentRelation = {
  collection: PERSONA_AGENT_COLLECTION,
  table: PERSONA_AGENT_TABLE,

  async list(sql: SqlClient): Promise<Row[]> {
    const rows = await sql<PersonaAgentRow[]>`
      SELECT id, tenant_id, workspace_id, persona, name, mission, registered_agent_id,
             prompt_id, capability_id, autonomy_level, allowed_roles, allowed_action_classes,
             max_risk, industry, organization_id, active, version, created_at
      FROM persona_agent_profiles ORDER BY created_at ASC, id ASC
    `;
    return rows.map(rowToRecord);
  },

  async insert(sql: SqlClient, record: Row, tenantId: string): Promise<void> {
    const workspaceId = stringField(record, 'workspaceId');
    const carriedTenant = stringField(record, 'tenantId');
    if (carriedTenant !== tenantId) throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', 'personaAgentProfiles tenant does not match active trust scope');
    const autonomyLevel = integerField(record, 'autonomyLevel');
    if (autonomyLevel < 0 || autonomyLevel > 5) throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', 'personaAgentProfiles.autonomyLevel must be 0..5');
    const version = integerField(record, 'version');
    if (version < 1) throw new PostgresStoreError('PERSISTENCE_SCHEMA_VIOLATION', 'personaAgentProfiles.version must be >= 1');

    await sql`
      INSERT INTO persona_agent_profiles (
        id, tenant_id, workspace_id, persona, name, mission, registered_agent_id,
        prompt_id, capability_id, autonomy_level, allowed_roles, allowed_action_classes,
        max_risk, industry, organization_id, active, version, created_at
      ) VALUES (
        ${stringField(record, 'id')}, ${tenantId}, ${workspaceId}, ${stringField(record, 'persona')},
        ${stringField(record, 'name')}, ${stringField(record, 'mission')}, ${stringField(record, 'registeredAgentId')},
        ${stringField(record, 'promptId')}, ${stringField(record, 'capabilityId')}, ${autonomyLevel},
        ${sql.json(stringArray(record, 'allowedRoles') as never)}, ${sql.json(stringArray(record, 'allowedActionClasses') as never)},
        ${stringField(record, 'maxRisk')}, ${optionalString(record, 'industry')}, ${optionalString(record, 'organizationId')},
        ${booleanField(record, 'active')}, ${version}, ${createdAt(record)}
      )
    `;
  },

  async update(sql: SqlClient, record: Row): Promise<number> {
    const id = stringField(record, 'id');
    const [existing] = await sql<PersonaAgentRow[]>`
      SELECT id, tenant_id, workspace_id, persona, name, mission, registered_agent_id,
             prompt_id, capability_id, autonomy_level, allowed_roles, allowed_action_classes,
             max_risk, industry, organization_id, active, version, created_at
      FROM persona_agent_profiles WHERE id = ${id}
    `;
    if (!existing) return 0;

    const current = rowToRecord(existing);
    for (const field of IMMUTABLE_FIELDS) {
      if (!sameValue(current[field], record[field])) {
        throw new PostgresStoreError('PERSISTENCE_HISTORY_IMMUTABLE', `personaAgentProfiles/${id}: ${field} requires a new version`);
      }
    }

    const rows = await sql<{ id: string }[]>`
      UPDATE persona_agent_profiles SET active = ${booleanField(record, 'active')} WHERE id = ${id} RETURNING id
    `;
    return rows.length;
  },
};

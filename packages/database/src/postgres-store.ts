import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';
import {
  auditIntegrityHash as sharedAuditIntegrityHash,
  canonicalJson,
  redactAuditMetadata,
} from '@assurapay/shared';
import type { SqlClient } from './postgres-client';
import { sanitizeDatabaseFailure } from './postgres-client';
import { currentTrustScope, isScopeBearing, isTenantScoped } from './trust-scope';
import type { TrustScope } from './trust-scope';
import { BATCH_A_RELATIONS, batchARelation, isBatchACollection } from './batch-a-repository';
import { BATCH_B_RELATIONS, batchBRelation, isBatchBCollection } from './batch-b-repository';
import { BATCH_C_RELATIONS, batchCRelation, isBatchCCollection } from './batch-c-repository';
import { BATCH_D_RELATIONS, batchDRelation, isBatchDCollection } from './batch-d-repository';
import { BATCH_E_RELATIONS, batchERelation, isBatchECollection } from './batch-e-repository';
import { BATCH_F_RELATIONS, batchFRelation, isBatchFCollection } from './batch-f-repository';
import { BATCH_G_RELATIONS, batchGRelation, isBatchGCollection } from './batch-g-repository';
import { BATCH_H_RELATIONS, batchHRelation, isBatchHCollection } from './batch-h-repository';
import { BATCH_I_RELATIONS, batchIRelation, isBatchICollection } from './batch-i-repository';
import { BATCH_K_RELATIONS, batchKRelation, isBatchKCollection } from './batch-k-repository';
import { BATCH_L_RELATIONS, batchLRelation, isBatchLCollection } from './batch-l-repository';
import { BATCH_M_RELATIONS, batchMRelation, isBatchMCollection } from './batch-m-repository';
import { PostgresStoreError } from './store-error';

export { PostgresStoreError } from './store-error';
export type { PostgresStoreErrorCode } from './store-error';

const SQLSTATE = {
  uniqueViolation: '23505', foreignKeyViolation: '23503', checkViolation: '23514', notNullViolation: '23502',
  serializationFailure: '40001', deadlockDetected: '40P01', queryCanceled: '57014', adminShutdown: '57P01',
  cannotConnectNow: '57P03', connectionFailure: '08006', connectionDoesNotExist: '08003', invalidPassword: '28P01',
  insufficientPrivilege: '42501', undefinedTable: '42P01',
} as const;

function translate(error: unknown): PostgresStoreError {
  const code = (error as { code?: string } | null)?.code;
  const detail = sanitizeDatabaseFailure(error);
  if (detail.includes('TRUST_HISTORY_IS_APPEND_ONLY')) return new PostgresStoreError('PERSISTENCE_HISTORY_IMMUTABLE', detail);
  if (detail.includes('LEDGER_JOURNAL_DOES_NOT_BALANCE')) return new PostgresStoreError('PERSISTENCE_LEDGER_UNBALANCED', detail);
  if (detail.includes('ACTIVE_DISPUTE_HOLD')) return new PostgresStoreError('PERSISTENCE_RELEASE_HELD', detail);
  if (detail.includes('AGGREGATE_ROW_IS_NOT_DELETABLE') || detail.includes('AGGREGATE_FACT_IS_IMMUTABLE') || detail.includes('AGGREGATE_STATE_IS_TERMINAL') || detail.includes('AGGREGATE_VERSION_MUST_ADVANCE') || detail.includes('append-only table'))
    return new PostgresStoreError('PERSISTENCE_HISTORY_IMMUTABLE', detail);
  if (code === SQLSTATE.insufficientPrivilege && detail.includes('row-level security policy'))
    return new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', detail);
  switch (code) {
    case SQLSTATE.uniqueViolation: return new PostgresStoreError('PERSISTENCE_DUPLICATE_RECORD', detail);
    case SQLSTATE.foreignKeyViolation: return new PostgresStoreError('PERSISTENCE_SCOPE_INVALID', detail);
    case SQLSTATE.checkViolation:
    case SQLSTATE.notNullViolation: return new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD', detail);
    case SQLSTATE.serializationFailure:
    case SQLSTATE.deadlockDetected: return new PostgresStoreError('PERSISTENCE_CONFLICT', detail);
    case SQLSTATE.queryCanceled: return new PostgresStoreError('PERSISTENCE_TIMEOUT', detail);
    case SQLSTATE.adminShutdown:
    case SQLSTATE.cannotConnectNow:
    case SQLSTATE.connectionFailure:
    case SQLSTATE.connectionDoesNotExist:
    case SQLSTATE.invalidPassword:
    case SQLSTATE.insufficientPrivilege:
    case SQLSTATE.undefinedTable: return new PostgresStoreError('PERSISTENCE_UNAVAILABLE', detail);
    default: return error instanceof PostgresStoreError ? error : new PostgresStoreError('PERSISTENCE_UNAVAILABLE', detail);
  }
}
function fail(error: unknown): never { throw error instanceof PostgresStoreError ? error : translate(error); }

type DedicatedMapping = { table: string; idColumn: string; columns: Record<string, string> };
const DEDICATED: Record<string, DedicatedMapping> = {
  trustWorkspaces: { table: 'trust_workspaces', idColumn: 'workspace_id', columns: { tenantId: 'tenant_id', status: 'status', version: 'version' } },
  memberships: { table: 'trust_memberships', idColumn: 'membership_id', columns: { workspaceId: 'workspace_id', userId: 'user_id', status: 'status', role: 'role', effectiveFrom: 'effective_from', effectiveTo: 'effective_to', revokedAt: 'revoked_at', version: 'version' } },
  permissionGrants: { table: 'trust_permission_grants', idColumn: 'grant_id', columns: { workspaceId: 'workspace_id', userId: 'user_id', permissionKey: 'permission_key', effect: 'effect', scopeType: 'scope_type', scopeId: 'scope_id', sourceType: 'source_type', sourceId: 'source_id', effectiveFrom: 'effective_from', effectiveTo: 'effective_to', revokedAt: 'revoked_at' } },
};

const GOVERNED_DOCUMENTS = Object.freeze([
  'authenticationMethods','beneficiaryAccounts','consents','delegations','devices','evidenceLedgerEntries','fieldPermissions','authorityRules','invitations','identities','legalHolds','legalPolicies','legalPolicyVersions','organizationUnits','parties','policyAcceptances','policyAssignments','segregationRules','sessions','signaturePolicies','stepUpChallenges','trustOrganizations','verificationRequests','verificationResults',
  // Flow OS durable documents. These are intentionally explicit: a durable store still refuses every unknown collection.
  'flowInstances','flowStepInstances','flowSignals','humanTasks',
]);

export const POSTGRES_IDENTITY_PLANE_COLLECTIONS: readonly string[] = Object.freeze(['authenticationMethods','devices','identities','sessions','stepUpChallenges']);
const HISTORY_COLLECTIONS = Object.freeze(['auditRecords','outboxEvents']);
export const POSTGRES_TRUST_COLLECTIONS: readonly string[] = Object.freeze([
  ...Object.keys(DEDICATED), ...GOVERNED_DOCUMENTS, ...HISTORY_COLLECTIONS,
  ...Object.keys(BATCH_A_RELATIONS), ...Object.keys(BATCH_B_RELATIONS), ...Object.keys(BATCH_C_RELATIONS), ...Object.keys(BATCH_D_RELATIONS),
  ...Object.keys(BATCH_E_RELATIONS), ...Object.keys(BATCH_F_RELATIONS), ...Object.keys(BATCH_G_RELATIONS), ...Object.keys(BATCH_H_RELATIONS),
  ...Object.keys(BATCH_I_RELATIONS), ...Object.keys(BATCH_K_RELATIONS), ...Object.keys(BATCH_L_RELATIONS), ...Object.keys(BATCH_M_RELATIONS),
].sort());
export const POSTGRES_ROUTED_TABLES: readonly string[] = Object.freeze([...new Set([
  ...Object.values(DEDICATED).map((mapping) => mapping.table), 'trust_records',
  ...Object.values(BATCH_A_RELATIONS).map((relation) => relation.table), ...Object.values(BATCH_B_RELATIONS).map((relation) => relation.table),
  ...Object.values(BATCH_C_RELATIONS).map((relation) => relation.table), ...Object.values(BATCH_D_RELATIONS).map((relation) => relation.table),
  ...Object.values(BATCH_E_RELATIONS).map((relation) => relation.table), ...Object.values(BATCH_F_RELATIONS).map((relation) => relation.table),
  ...Object.values(BATCH_G_RELATIONS).map((relation) => relation.table), ...Object.values(BATCH_H_RELATIONS).map((relation) => relation.table),
  ...Object.values(BATCH_I_RELATIONS).map((relation) => relation.table), ...Object.values(BATCH_K_RELATIONS).map((relation) => relation.table),
  ...Object.values(BATCH_L_RELATIONS).map((relation) => relation.table), ...Object.values(BATCH_M_RELATIONS).map((relation) => relation.table),
])].sort());

const SCOPE_FIELDS = { tenantId: ['tenantId'], workspaceId: ['workspaceId'], principalId: ['userId','principalId','partyId','actorId'], status: ['status'], effectiveFrom: ['effectiveFrom','issuedAt','createdAt'], effectiveTo: ['effectiveTo','expiresAt'], revokedAt: ['revokedAt'] } as const;
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null { for (const key of keys) { const value = record[key]; if (typeof value === 'string' && value.length > 0) return value; } return null; }
function firstTimestamp(record: Record<string, unknown>, keys: readonly string[]): Date | null { for (const key of keys) { const value = record[key]; if (typeof value !== 'string') continue; const parsed = Date.parse(value); if (!Number.isNaN(parsed)) return new Date(parsed); } return null; }
export function payloadDigest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function requireRecordId(value: unknown): string { const id=(value as {id?:unknown}|null)?.id; if(typeof id!=='string'||id.length===0) throw new PostgresStoreError('PERSISTENCE_RECORD_ID_REQUIRED','every persisted record needs a string id'); return id; }
function asRecord(value: unknown): Record<string, unknown> { if(value===null||typeof value!=='object'||Array.isArray(value)) throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD','expected an object record'); return value as Record<string,unknown>; }
function rowToRecord<T>(row:{payload:unknown;payload_digest:string}):T { const payload=row.payload; if(payload===null||typeof payload!=='object') throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD','stored payload is not an object'); if(payloadDigest(payload)!==row.payload_digest) throw new PostgresStoreError('PERSISTENCE_CORRUPT_RECORD','stored payload does not match its digest'); return payload as T; }
export type PostgresTrustStoreOptions={now?:()=>Date;withinTransaction?:boolean};
const LOCK_ON_TRANSACTIONAL_READ=new Set<string>(['signaturePackages']);
type RelationalUpdate={update(sql:SqlClient,record:Record<string,unknown>):Promise<number>};
function relationalUpdateTarget(collection:string):RelationalUpdate|undefined { if(isBatchACollection(collection))return batchARelation(collection); if(isBatchBCollection(collection))return batchBRelation(collection); if(isBatchCCollection(collection))return batchCRelation(collection); if(isBatchDCollection(collection))return batchDRelation(collection); if(isBatchECollection(collection))return batchERelation(collection); if(isBatchFCollection(collection))return batchFRelation(collection); if(isBatchGCollection(collection))return batchGRelation(collection); if(isBatchHCollection(collection))return batchHRelation(collection); if(isBatchICollection(collection))return batchIRelation(collection); if(isBatchKCollection(collection))return batchKRelation(collection); if(isBatchLCollection(collection))return batchLRelation(collection); if(isBatchMCollection(collection))return batchMRelation(collection); return undefined; }

export class PostgresTrustStore implements TrustPersistence {
  private readonly now:()=>Date; private readonly withinTransaction:boolean;
  constructor(private readonly sql:SqlClient,options:PostgresTrustStoreOptions={}){this.now=options.now??(()=>new Date());this.withinTransaction=options.withinTransaction??false;}
  private async inScope<T>(run:(store:PostgresTrustStore)=>Promise<T>):Promise<T>{if(this.withinTransaction)return await run(this);const scope=currentTrustScope();if(!isScopeBearing(scope))return await run(this);try{return await this.sql.begin(async(tx)=>{await applyTrustScope(tx,scope);return await run(new PostgresTrustStore(tx,{now:this.now,withinTransaction:true}));});}catch(error){fail(error);}}
  async list<T>(collection:string):Promise<T[]>{return await this.inScope((store)=>store.listScoped<T>(collection));}
  async append<T>(collection:string,value:T):Promise<void>{await this.inScope((store)=>store.appendScoped(collection,value));}
  async replace<T extends {id:string}>(collection:string,value:T):Promise<void>{await this.inScope((store)=>store.replaceScoped(collection,value));}
  async audit(input:Omit<AuditRecord,'id'|'createdAt'|'integrityHash'|'previousHash'>):Promise<AuditRecord>{return await this.inScope((store)=>store.auditScoped(input));}
  async emit(input:Omit<OutboxEvent,'id'|'occurredAt'>):Promise<OutboxEvent>{return await this.inScope((store)=>store.emitScoped(input));}

  private async listScoped<T>(collection:string):Promise<T[]>{const dedicated=DEDICATED[collection];try{
    if(collection==='auditRecords'){const rows=await this.sql<AuditRow[]>`SELECT * FROM trust_audit_records ORDER BY coalesce(tenant_id, '') ASC, chain_position ASC`;return rows.map(auditRowToRecord) as unknown as T[];}
    if(collection==='outboxEvents'){const rows=await this.sql<OutboxRow[]>`SELECT * FROM trust_outbox_events ORDER BY occurred_at ASC, event_id ASC`;return rows.map(outboxRowToRecord) as unknown as T[];}
    if(dedicated)return await this.listDedicated<T>(collection);
    if(isBatchACollection(collection))return(await batchARelation(collection).list(this.sql))as unknown as T[];
    if(isBatchBCollection(collection))return(await batchBRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchCCollection(collection))return(await batchCRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchDCollection(collection))return(await batchDRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchECollection(collection))return(await batchERelation(collection).list(this.sql))as unknown as T[];
    if(isBatchFCollection(collection))return(await batchFRelation(collection).list(this.sql,{lock:this.withinTransaction&&LOCK_ON_TRANSACTIONAL_READ.has(collection)}))as unknown as T[];
    if(isBatchGCollection(collection))return(await batchGRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchHCollection(collection))return(await batchHRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchICollection(collection))return(await batchIRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchKCollection(collection))return(await batchKRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchLCollection(collection))return(await batchLRelation(collection).list(this.sql))as unknown as T[];
    if(isBatchMCollection(collection))return(await batchMRelation(collection).list(this.sql))as unknown as T[];
    this.requireGoverned(collection);const rows=await this.sql<StoredRow[]>`SELECT payload, payload_digest FROM trust_records WHERE collection = ${collection} ORDER BY created_at ASC, record_id ASC`;return rows.map((row)=>rowToRecord<T>(row));
  }catch(error){fail(error);}}

  private async listDedicated<T>(collection:string):Promise<T[]>{if(collection==='trustWorkspaces'){const rows=await this.sql<StoredRow[]>`SELECT payload, payload_digest FROM trust_workspaces ORDER BY created_at ASC, workspace_id ASC`;return rows.map((row)=>rowToRecord<T>(row));}if(collection==='memberships'){const rows=await this.sql<StoredRow[]>`SELECT payload, payload_digest FROM trust_memberships ORDER BY created_at ASC, membership_id ASC`;return rows.map((row)=>rowToRecord<T>(row));}const rows=await this.sql<StoredRow[]>`SELECT payload, payload_digest FROM trust_permission_grants ORDER BY created_at ASC, grant_id ASC`;return rows.map((row)=>rowToRecord<T>(row));}

  private async appendScoped<T>(collection:string,value:T):Promise<void>{const record=asRecord(value);const id=requireRecordId(value);const digest=payloadDigest(record);try{
    if(isBatchACollection(collection)){await batchARelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchBCollection(collection)){await batchBRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchCCollection(collection)){await batchCRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchDCollection(collection)){await batchDRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchECollection(collection)){await batchERelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchFCollection(collection)){await batchFRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchGCollection(collection)){await batchGRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchHCollection(collection)){await batchHRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchICollection(collection)){await batchIRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchKCollection(collection)){await batchKRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchLCollection(collection)){await batchLRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}if(isBatchMCollection(collection)){await batchMRelation(collection).insert(this.sql,record,this.requireRelationalTenant(collection,record));return;}
    if(collection==='trustWorkspaces'){const tenantId=firstString(record,['tenantId']);if(!tenantId)throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID','a workspace must name its tenant');await this.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenantId}) ON CONFLICT (tenant_id) DO NOTHING`;await this.sql`INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest, version) VALUES (${id}, ${tenantId}, ${firstString(record,['status'])??'ACTIVE'}, ${this.sql.json(record)}, ${digest}, ${asVersion(record)})`;return;}
    if(collection==='memberships'){const membershipWorkspaceId=requireScope(record,'workspaceId');const[membershipWorkspace]=await this.sql<{tenantId:string}[]>`SELECT tenant_id AS "tenantId" FROM trust_workspaces WHERE workspace_id = ${membershipWorkspaceId}`;if(!membershipWorkspace)throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID',`membership names workspace ${membershipWorkspaceId}, which does not exist or is outside this scope`);await this.sql`INSERT INTO trust_memberships (membership_id, workspace_id, tenant_id, user_id, status, role, effective_from, effective_to, revoked_at, payload, payload_digest, version) VALUES (${id}, ${membershipWorkspaceId}, ${membershipWorkspace.tenantId}, ${requireScope(record,'userId')}, ${firstString(record,['status'])??'ACTIVE'}, ${firstString(record,['role'])}, ${firstTimestamp(record,['effectiveFrom','createdAt'])}, ${firstTimestamp(record,['effectiveTo'])}, ${firstTimestamp(record,['revokedAt'])}, ${this.sql.json(record)}, ${digest}, ${asVersion(record)})`;return;}
    if(collection==='permissionGrants'){await this.sql`INSERT INTO trust_permission_grants (grant_id, workspace_id, user_id, permission_key, effect, scope_type, scope_id, source_type, source_id, effective_from, effective_to, revoked_at, payload, payload_digest) VALUES (${id}, ${requireScope(record,'workspaceId')}, ${requireScope(record,'userId')}, ${requireScope(record,'permissionKey')}, ${firstString(record,['effect'])??'ALLOW'}, ${firstString(record,['scopeType'])??'WORKSPACE'}, ${firstString(record,['scopeId'])}, ${firstString(record,['sourceType'])??'ROLE'}, ${firstString(record,['sourceId'])??'unspecified'}, ${firstTimestamp(record,['effectiveFrom','createdAt'])??this.now()}, ${firstTimestamp(record,['effectiveTo'])}, ${firstTimestamp(record,['revokedAt'])}, ${this.sql.json(record)}, ${digest})`;return;}
    this.requireGoverned(collection);await this.sql`INSERT INTO trust_records (collection, record_id, tenant_id, workspace_id, principal_id, status, effective_from, effective_to, revoked_at, version, payload, payload_digest) VALUES (${collection}, ${id}, ${firstString(record,SCOPE_FIELDS.tenantId)}, ${firstString(record,SCOPE_FIELDS.workspaceId)}, ${firstString(record,SCOPE_FIELDS.principalId)}, ${firstString(record,SCOPE_FIELDS.status)}, ${firstTimestamp(record,SCOPE_FIELDS.effectiveFrom)}, ${firstTimestamp(record,SCOPE_FIELDS.effectiveTo)}, ${firstTimestamp(record,SCOPE_FIELDS.revokedAt)}, ${asVersion(record)}, ${this.sql.json(record)}, ${digest})`;
  }catch(error){fail(error);}}

  private async replaceScoped<T extends {id:string}>(collection:string,value:T):Promise<void>{const record=asRecord(value);const id=requireRecordId(value);const digest=payloadDigest(record);const updatedAt=this.now();try{const relation=relationalUpdateTarget(collection);if(relation){this.requireRelationalTenant(collection,record);const affected=await relation.update(this.sql,record);this.requireAffected(affected,collection,id);return;}
    if(collection==='trustWorkspaces'){const rows=await this.sql<{workspace_id:string}[]>`UPDATE trust_workspaces SET status=${firstString(record,['status'])??'ACTIVE'}, payload=${this.sql.json(record)}, payload_digest=${digest}, version=${asVersion(record)}, updated_at=${updatedAt} WHERE workspace_id=${id} RETURNING workspace_id`;this.requireAffected(rows.length,collection,id);return;}
    if(collection==='memberships'){const rows=await this.sql<{membership_id:string}[]>`UPDATE trust_memberships SET status=${firstString(record,['status'])??'ACTIVE'}, role=${firstString(record,['role'])}, effective_from=${firstTimestamp(record,['effectiveFrom','createdAt'])}, effective_to=${firstTimestamp(record,['effectiveTo'])}, revoked_at=${firstTimestamp(record,['revokedAt'])}, payload=${this.sql.json(record)}, payload_digest=${digest}, version=${asVersion(record)}, updated_at=${updatedAt} WHERE membership_id=${id} RETURNING membership_id`;this.requireAffected(rows.length,collection,id);return;}
    if(collection==='permissionGrants'){const rows=await this.sql<{grant_id:string}[]>`UPDATE trust_permission_grants SET effect=${firstString(record,['effect'])??'ALLOW'}, scope_id=${firstString(record,['scopeId'])}, effective_to=${firstTimestamp(record,['effectiveTo'])}, revoked_at=${firstTimestamp(record,['revokedAt'])}, payload=${this.sql.json(record)}, payload_digest=${digest} WHERE grant_id=${id} RETURNING grant_id`;this.requireAffected(rows.length,collection,id);return;}
    this.requireGoverned(collection);const rows=await this.sql<{record_id:string}[]>`UPDATE trust_records SET tenant_id=${firstString(record,SCOPE_FIELDS.tenantId)}, workspace_id=${firstString(record,SCOPE_FIELDS.workspaceId)}, principal_id=${firstString(record,SCOPE_FIELDS.principalId)}, status=${firstString(record,SCOPE_FIELDS.status)}, effective_from=${firstTimestamp(record,SCOPE_FIELDS.effectiveFrom)}, effective_to=${firstTimestamp(record,SCOPE_FIELDS.effectiveTo)}, revoked_at=${firstTimestamp(record,SCOPE_FIELDS.revokedAt)}, version=${asVersion(record)}, payload=${this.sql.json(record)}, payload_digest=${digest}, updated_at=${updatedAt} WHERE collection=${collection} AND record_id=${id} RETURNING record_id`;this.requireAffected(rows.length,collection,id);
  }catch(error){fail(error);}}

  private async auditScoped(input:Omit<AuditRecord,'id'|'createdAt'|'integrityHash'|'previousHash'>):Promise<AuditRecord>{try{if(this.withinTransaction)return await this.appendAudit(this.sql,input);return await this.sql.begin(async(tx)=>this.appendAudit(tx,input));}catch(error){fail(error);}}
  private async appendAudit(sql:SqlClient,input:Omit<AuditRecord,'id'|'createdAt'|'integrityHash'|'previousHash'>):Promise<AuditRecord>{await sql`LOCK TABLE trust_audit_records IN EXCLUSIVE MODE`;const tenantId=input.tenantId??'';const[tail]=await sql<{chain_position:string;integrity_hash:string}[]>`SELECT chain_position, integrity_hash FROM trust_audit_records WHERE coalesce(tenant_id, '')=${tenantId} ORDER BY chain_position DESC LIMIT 1`;const chainPosition=tail?Number(tail.chain_position)+1:1;const previousHash=tail?.integrity_hash;const createdAt=this.now().toISOString();const metadata=redactAuditMetadata(input.metadata);const integrityHash=sharedAuditIntegrityHash({...input,metadata,createdAt,previousHash},(value)=>createHash('sha256').update(value).digest('hex'));const record:AuditRecord={id:randomUUID(),...input,metadata,createdAt,integrityHash,previousHash};await sql`INSERT INTO trust_audit_records (audit_id, chain_position, tenant_id, workspace_id, actor_id, event_type, aggregate_type, aggregate_id, correlation_id, metadata, previous_hash, integrity_hash, created_at) VALUES (${record.id}, ${chainPosition}, ${record.tenantId??null}, ${record.workspaceId??null}, ${record.actorId}, ${record.eventType}, ${record.aggregateType}, ${record.aggregateId}, ${record.correlationId}, ${sql.json(metadata)}, ${previousHash??null}, ${integrityHash}, ${createdAt})`;return record;}
  private async emitScoped(input:Omit<OutboxEvent,'id'|'occurredAt'>):Promise<OutboxEvent>{const event:OutboxEvent={...input,id:randomUUID(),occurredAt:this.now().toISOString()};try{await this.sql`INSERT INTO trust_outbox_events (event_id, tenant_id, workspace_id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id, occurred_at, published_at) VALUES (${event.id}, ${event.tenantId??null}, ${event.workspaceId??null}, ${event.aggregateType}, ${event.aggregateId}, ${event.eventType}, ${event.eventVersion}, ${this.sql.json(event.payload)}, ${event.correlationId}, ${event.occurredAt}, ${event.publishedAt??null})`;return event;}catch(error){fail(error);}}
  async transaction<T>(operation:(tx:TrustPersistence)=>Promise<T>):Promise<T>{if(this.withinTransaction)return await operation(this);try{return await this.sql.begin(async(tx)=>{const scope=currentTrustScope();if(isScopeBearing(scope))await applyTrustScope(tx,scope);return await operation(new PostgresTrustStore(tx,{now:this.now,withinTransaction:true}));});}catch(error){if(error instanceof PostgresStoreError)throw error;const translated=translate(error);if(translated.code!=='PERSISTENCE_UNAVAILABLE')throw translated;throw new PostgresStoreError('PERSISTENCE_TRANSACTION_FAILED',sanitizeDatabaseFailure(error));}}
  private requireGoverned(collection:string):void{if(!GOVERNED_DOCUMENTS.includes(collection))throw new PostgresStoreError('PERSISTENCE_COLLECTION_NOT_MAPPED',`${collection} has no mapping in the durable trust store`);}
  private requireRelationalTenant(collection:string,record:Record<string,unknown>):string{const scope=currentTrustScope();if(!scope?.tenantId)throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID',`${collection} requires an established tenant scope; the aggregate carries no tenant of its own`);const workspaceId=record.workspaceId;if(typeof workspaceId!=='string'||workspaceId.length===0)throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID',`${collection} record names no workspace`);if(scope.workspaceId&&scope.workspaceId!==workspaceId)throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID',`${collection} record belongs to a workspace other than the caller's scope`);return scope.tenantId;}
  private requireAffected(affected:number,collection:string,id:string):void{if(affected===0)throw new PostgresStoreError('PERSISTENCE_RECORD_NOT_FOUND',`${collection}/${id} does not exist; replace does not create`);}
}

type StoredRow={payload:unknown;payload_digest:string};
type AuditRow={audit_id:string;chain_position:string;tenant_id:string|null;workspace_id:string|null;actor_id:string;event_type:string;aggregate_type:string;aggregate_id:string;correlation_id:string;metadata:Record<string,unknown>;previous_hash:string|null;integrity_hash:string;created_at:Date};
type OutboxRow={event_id:string;tenant_id:string|null;workspace_id:string|null;aggregate_type:string;aggregate_id:string;event_type:string;event_version:number;payload:Record<string,unknown>;correlation_id:string;occurred_at:Date;published_at:Date|null};
function auditRowToRecord(row:AuditRow):AuditRecord{const record:AuditRecord={id:row.audit_id,actorId:row.actor_id,eventType:row.event_type,aggregateType:row.aggregate_type,aggregateId:row.aggregate_id,correlationId:row.correlation_id,metadata:row.metadata,createdAt:row.created_at.toISOString(),integrityHash:row.integrity_hash};if(row.tenant_id!==null)record.tenantId=row.tenant_id;if(row.workspace_id!==null)record.workspaceId=row.workspace_id;if(row.previous_hash!==null)record.previousHash=row.previous_hash;return record;}
function outboxRowToRecord(row:OutboxRow):OutboxEvent{const event:OutboxEvent={id:row.event_id,aggregateType:row.aggregate_type,aggregateId:row.aggregate_id,eventType:row.event_type,eventVersion:row.event_version,payload:row.payload,correlationId:row.correlation_id,occurredAt:row.occurred_at.toISOString()};if(row.tenant_id!==null)event.tenantId=row.tenant_id;if(row.workspace_id!==null)event.workspaceId=row.workspace_id;if(row.published_at!==null)event.publishedAt=row.published_at.toISOString();return event;}
function requireScope(record:Record<string,unknown>,field:string):string{const value=record[field];if(typeof value!=='string'||value.length===0)throw new PostgresStoreError('PERSISTENCE_SCOPE_INVALID',`${field} is required`);return value;}
export async function applyTrustScope(sql:SqlClient,scope:TrustScope):Promise<void>{await sql`SELECT set_config('app.tenant_id', ${scope.tenantId??''}, true), set_config('app.workspace_id', ${scope.workspaceId??''}, true), set_config('app.actor_id', ${scope.actorId??''}, true)`;}
function asVersion(record:Record<string,unknown>):number{const value=record.version;return typeof value==='number'&&Number.isInteger(value)&&value>=1?value:1;}

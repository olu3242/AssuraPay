import { randomUUID } from 'node:crypto';
import { PermissionService } from '@assurapay/permissions';
import { requireActiveWorkspace, type RequestContext, type TrustPersistence } from '@assurapay/shared';
import type { Party } from './index';

export type QualificationKind = 'SERIOUS_SELLER' | 'DEDICATED_BUYER';
export type QualificationStatus = 'NOT_STARTED' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'EXPIRED' | 'REVOKED' | 'APPEALED' | 'RECONSIDERED';
export type QualificationStage = 'AGREEMENT' | 'FUNDING' | 'RELEASE';
export type QualificationPolicy = {
  id: string; tenantId: string; workspaceId: string; kind: QualificationKind; version: number;
  requiredEvidence: string[]; transactionTypes: string[]; stages: QualificationStage[];
  validityDays: number; createdBy: string; createdAt: string;
};
export type QualificationRecord = {
  id: string; qualificationId: string; tenantId: string; workspaceId: string;
  partyId: string; applicantUserId: string; kind: QualificationKind; capacity: string;
  policyId: string; status: QualificationStatus; version: number;
  evidence: Array<{requirement: string; reference: string}>; riskFlags: string[];
  reasonCode: string; actorId: string; createdAt: string; expiresAt?: string;
};
const transitions: Record<QualificationStatus, QualificationStatus[]> = {
  NOT_STARTED: ['SUBMITTED'], SUBMITTED: ['UNDER_REVIEW'], UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED', 'EXPIRED', 'REVOKED'], REJECTED: ['APPEALED'],
  SUSPENDED: ['APPEALED', 'REVOKED'], EXPIRED: ['APPEALED'], REVOKED: ['APPEALED'],
  APPEALED: ['RECONSIDERED'], RECONSIDERED: ['APPROVED', 'REJECTED'],
};
const kinds = ['SERIOUS_SELLER', 'DEDICATED_BUYER'];
const reasons = ['APPLICATION_STARTED', 'EVIDENCE_SUBMITTED', 'REVIEW_STARTED', 'REQUIREMENTS_MET', 'EVIDENCE_INSUFFICIENT', 'RISK_REVIEW_REQUIRED', 'POLICY_VIOLATION', 'VALIDITY_EXPIRED', 'APPEAL_SUBMITTED', 'APPEAL_REVIEWED'];

/** Qualifications live in the party bounded context; all history is append-only. */
export class QualificationService {
  constructor(private readonly store: TrustPersistence, private readonly now = () => new Date()) {}
  async publishPolicy(context: RequestContext, input: Pick<QualificationPolicy, 'kind' | 'requiredEvidence' | 'transactionTypes' | 'stages' | 'validityDays'>) {
    requireActiveWorkspace(context);
    await new PermissionService(this.store).requirePermission(context, 'legal:create');
    if (!kinds.includes(input.kind) || !Number.isInteger(input.validityDays) || input.validityDays < 1 || input.validityDays > 730 || !input.requiredEvidence?.length || !input.transactionTypes?.length || !input.stages?.length || input.stages.some(s => !['AGREEMENT','FUNDING','RELEASE'].includes(s))) throw new Error('INVALID_QUALIFICATION_POLICY');
    return this.store.transaction(async tx => {
      const policies = await tx.list<QualificationPolicy>('qualificationPolicies');
      const previous = policies.filter(p => p.workspaceId === context.activeWorkspaceId && p.kind === input.kind);
      const policy: QualificationPolicy = { ...input, id: randomUUID(), tenantId: context.tenantId, workspaceId: context.activeWorkspaceId, version: Math.max(0, ...previous.map(p => p.version)) + 1, createdBy: context.actorUserId, createdAt: this.now().toISOString() };
      await tx.append('qualificationPolicies', policy);
      await this.audit(tx, context, policy.id, 'QualificationPolicyPublished', {kind: policy.kind, version: policy.version});
      return policy;
    });
  }
  async start(context: RequestContext, input: {partyId: string; kind: QualificationKind; capacity: string; policyId: string}) {
    requireActiveWorkspace(context);
    await new PermissionService(this.store).requirePermission(context, 'parties:create');
    if (!kinds.includes(input.kind) || !input.capacity?.trim()) throw new Error('INVALID_QUALIFICATION_APPLICATION');
    return this.store.transaction(async tx => {
      const party = (await tx.list<Party>('parties')).find(p => p.id === input.partyId && p.workspaceId === context.activeWorkspaceId && p.status === 'ACTIVE');
      if (!party) throw new Error('PARTY_NOT_FOUND');
      const policy = (await tx.list<QualificationPolicy>('qualificationPolicies')).find(p => p.id === input.policyId && p.workspaceId === context.activeWorkspaceId && p.kind === input.kind);
      if (!policy) throw new Error('QUALIFICATION_POLICY_NOT_FOUND');
      const record: QualificationRecord = {id: randomUUID(), qualificationId: randomUUID(), tenantId: context.tenantId, workspaceId: context.activeWorkspaceId, partyId: party.id, applicantUserId: context.actorUserId, kind: input.kind, capacity: input.capacity, policyId: policy.id, status: 'NOT_STARTED', version: 1, evidence: [], riskFlags: [], reasonCode: 'APPLICATION_STARTED', actorId: context.actorUserId, createdAt: this.now().toISOString()};
      await tx.append('partyQualifications', record);
      await this.audit(tx, context, record.qualificationId, 'QualificationStarted', {kind: record.kind});
      return record;
    });
  }
  async history(context: RequestContext, id: string) {
    requireActiveWorkspace(context);
    const records = (await this.store.list<QualificationRecord>('partyQualifications')).filter(r => r.qualificationId === id && r.tenantId === context.tenantId && r.workspaceId === context.activeWorkspaceId).sort((a,b) => a.version - b.version);
    if (!records.length) throw new Error('QUALIFICATION_NOT_FOUND');
    if (records[0].applicantUserId !== context.actorUserId) await new PermissionService(this.store).requirePermission(context, 'parties:request-verification');
    return records;
  }
  async transition(context: RequestContext, id: string, input: {status: QualificationStatus; reasonCode: string; evidence?: QualificationRecord['evidence']; riskFlags?: string[]}) {
    requireActiveWorkspace(context);
    return this.store.transaction(async tx => {
      const service = new QualificationService(tx, this.now);
      const history = await service.history(context, id);
      const previous = history[history.length - 1];
      if (!transitions[previous.status].includes(input.status)) throw new Error('QUALIFICATION_TRANSITION_DENIED');
      if (!reasons.includes(input.reasonCode)) throw new Error('QUALIFICATION_REASON_REQUIRED');
      const applicantAction = ['SUBMITTED','APPEALED'].includes(input.status);
      if (applicantAction && previous.applicantUserId !== context.actorUserId) throw new Error('QUALIFICATION_APPLICANT_REQUIRED');
      if (!applicantAction) {
        await new PermissionService(tx).requirePermission(context, 'parties:request-verification');
        if (previous.applicantUserId === context.actorUserId) throw new Error('QUALIFICATION_INDEPENDENT_REVIEW_REQUIRED');
      }
      const policy = (await tx.list<QualificationPolicy>('qualificationPolicies')).find(p => p.id === previous.policyId && p.workspaceId === context.activeWorkspaceId);
      if (!policy) throw new Error('QUALIFICATION_POLICY_NOT_FOUND');
      const evidence = applicantAction ? input.evidence ?? previous.evidence : previous.evidence;
      if (['SUBMITTED','APPROVED'].includes(input.status) && policy.requiredEvidence.some(requirement => !evidence.some(e => e.requirement === requirement && typeof e.reference === 'string' && e.reference.trim()))) throw new Error('QUALIFICATION_EVIDENCE_REQUIRED');
      if (input.status === 'EXPIRED' && (!previous.expiresAt || Date.parse(previous.expiresAt) > this.now().getTime())) throw new Error('QUALIFICATION_NOT_EXPIRED');
      const record: QualificationRecord = {...previous, id: randomUUID(), version: previous.version + 1, status: input.status, evidence, riskFlags: applicantAction ? previous.riskFlags : input.riskFlags ?? previous.riskFlags, reasonCode: input.reasonCode, actorId: context.actorUserId, createdAt: this.now().toISOString(), expiresAt: input.status === 'APPROVED' ? new Date(this.now().getTime() + policy.validityDays * 86400000).toISOString() : previous.expiresAt};
      await tx.append('partyQualifications', record);
      await this.audit(tx, context, id, 'QualificationTransitioned', {from: previous.status, to: record.status, reasonCode: record.reasonCode, version: record.version, policyId: policy.id});
      return record;
    });
  }
  async assertEligible(context: RequestContext, input: {partyId: string; kind: QualificationKind; transactionType: string; stage: QualificationStage}) {
    requireActiveWorkspace(context);
    const policies = (await this.store.list<QualificationPolicy>('qualificationPolicies')).filter(p => p.workspaceId === context.activeWorkspaceId && p.tenantId === context.tenantId && p.kind === input.kind).sort((a,b) => b.version - a.version);
    const policy = policies[0];
    if (!policy) throw new Error('QUALIFICATION_POLICY_REQUIRED');
    if (!policy.transactionTypes.includes(input.transactionType) || !policy.stages.includes(input.stage)) return;
    const records = (await this.store.list<QualificationRecord>('partyQualifications')).filter(r => r.workspaceId === context.activeWorkspaceId && r.tenantId === context.tenantId && r.partyId === input.partyId && r.kind === input.kind && r.policyId === policy.id);
    const latest = new Map<string, QualificationRecord>();
    for (const record of records) if (!latest.has(record.qualificationId) || latest.get(record.qualificationId)!.version < record.version) latest.set(record.qualificationId, record);
    if (![...latest.values()].some(r => r.status === 'APPROVED' && !!r.expiresAt && Date.parse(r.expiresAt) > this.now().getTime())) throw new Error('PARTY_QUALIFICATION_REQUIRED');
  }
  private audit(store: TrustPersistence, context: RequestContext, id: string, eventType: string, metadata: Record<string, unknown>) {
    return store.audit({tenantId: context.tenantId, workspaceId: context.activeWorkspaceId, actorId: context.actorUserId, eventType, aggregateType: 'PartyQualification', aggregateId: id, correlationId: context.correlationId, metadata});
  }
}

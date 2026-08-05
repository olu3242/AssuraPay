import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';
const now = () => new Date().toISOString();
const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');
function workspace(c: RequestContext) {
  requireActiveWorkspace(c);
  return c.activeWorkspaceId;
}
async function find<T extends { id: string; workspaceId: string }>(
  s: TrustPersistence,
  k: string,
  c: RequestContext,
  id: string,
) {
  const x = (await s
    .list<T>(k))
    .find((v) => v.id === id && v.workspaceId === workspace(c));
  if (!x) throw new Error('NOT_FOUND');
  return x;
}
async function event(
  s: TrustPersistence,
  c: RequestContext,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  await s.audit({
    tenantId: c.tenantId,
    workspaceId: workspace(c),
    actorId: c.actorUserId,
    eventType: type,
    aggregateType,
    aggregateId,
    correlationId: c.correlationId,
    metadata: payload,
  });
  await s.emit({
    tenantId: c.tenantId,
    workspaceId: workspace(c),
    aggregateType,
    aggregateId,
    eventType: type,
    eventVersion: 1,
    payload,
    correlationId: c.correlationId,
  });
}

export type Agreement = {
  id: string;
  workspaceId: string;
  contractNumber: string;
  title: string;
  contractType: string;
  ownerUserId: string;
  status:
    | 'DRAFT'
    | 'NEGOTIATION'
    | 'AWAITING_APPROVAL'
    | 'APPROVED'
    | 'AWAITING_SIGNATURE'
    | 'PARTIALLY_SIGNED'
    | 'EXECUTED';
  createdAt: string;
  version: number;
};
export type TemplateVersion = {
  id: string;
  workspaceId: string;
  templateKey: string;
  version: number;
  variableSchema: Array<{ key: string; required: boolean }>;
  contentHash: string;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  createdBy: string;
  createdAt: string;
};
export type DocumentVersion = {
  id: string;
  workspaceId: string;
  contractId: string;
  draftId: string;
  number: number;
  contentReference: string;
  contentHash: string;
  status: 'DRAFT' | 'NEGOTIATED' | 'APPROVED' | 'EXECUTED';
  createdBy: string;
  createdAt: string;
  supersedesId?: string;
  aiProposed: boolean;
};
export type ContractDraft = {
  id: string;
  workspaceId: string;
  contractId: string;
  templateVersionId: string;
  documentVersionId: string;
  status: 'WORKING' | 'LOCKED' | 'SUBMITTED' | 'RETURNED' | 'SUPERSEDED';
  variables: Record<string, unknown>;
  lockedBy?: string;
  createdBy: string;
  createdAt: string;
  version: number;
};
export type ContractComment = {
  id: string;
  workspaceId: string;
  contractId: string;
  body: string;
  visibility: 'INTERNAL' | 'SHARED';
  authorId: string;
  createdAt: string;
};
export class ContractAuthoringEngine {
  constructor(private s: TrustPersistence) {}
  async create(
    c: RequestContext,
    i: {
      contractNumber: string;
      title: string;
      contractType: string;
      ownerUserId: string;
    },
  ) {
    const w = workspace(c);
    if (
      (await this.s
        .list<Agreement>('agreements'))
        .some(
          (x) => x.workspaceId === w && x.contractNumber === i.contractNumber,
        )
    )
      throw new Error('CONTRACT_NUMBER_EXISTS');
    const x: Agreement = {
      id: randomUUID(),
      workspaceId: w,
      ...i,
      status: 'DRAFT',
      createdAt: now(),
      version: 1,
    };
    await this.s.append('agreements', x);
    await event(this.s, c, 'ContractCreated', 'Agreement', x.id);
    return x;
  }
  async createTemplateVersion(
    c: RequestContext,
    i: {
      templateKey: string;
      variableSchema: Array<{ key: string; required: boolean }>;
      content: string;
    },
  ) {
    const w = workspace(c),
      all = (await this.s
        .list<TemplateVersion>('templateVersions'))
        .filter((x) => x.workspaceId === w && x.templateKey === i.templateKey);
    const x: TemplateVersion = {
      id: randomUUID(),
      workspaceId: w,
      templateKey: i.templateKey,
      version: all.length + 1,
      variableSchema: i.variableSchema,
      contentHash: hash(i.content),
      status: 'DRAFT',
      createdBy: c.actorUserId,
      createdAt: now(),
    };
    await this.s.append('templateVersions', x);
    return x;
  }
  async publishTemplate(c: RequestContext, id: string) {
    const x = await find<TemplateVersion>(this.s, 'templateVersions', c, id);
    if (x.status !== 'DRAFT') throw new Error('PUBLISHED_TEMPLATE_IMMUTABLE');
    for (const p of (await this.s
      .list<TemplateVersion>('templateVersions'))
      .filter(
        (v) =>
          v.workspaceId === x.workspaceId &&
          v.templateKey === x.templateKey &&
          v.status === 'PUBLISHED',
      ))
      await this.s.replace('templateVersions', { ...p, status: 'SUPERSEDED' });
    const y = { ...x, status: 'PUBLISHED' as const };
    await this.s.replace('templateVersions', y);
    await event(this.s, c, 'ContractTemplatePublished', 'TemplateVersion', id, {
      contentHash: x.contentHash,
    });
    return y;
  }
  async createDraft(
    c: RequestContext,
    contractId: string,
    templateVersionId: string,
    contentReference: string,
    content: string,
    aiProposed = false,
  ) {
    const contract = await find<Agreement>(this.s, 'agreements', c, contractId),
      template = await find<TemplateVersion>(
        this.s,
        'templateVersions',
        c,
        templateVersionId,
      );
    if (template.status !== 'PUBLISHED')
      throw new Error('PUBLISHED_TEMPLATE_REQUIRED');
    const draftId = randomUUID();
    const doc: DocumentVersion = {
      id: randomUUID(),
      workspaceId: contract.workspaceId,
      contractId,
      draftId,
      number: 1,
      contentReference,
      contentHash: hash(content),
      status: 'DRAFT',
      createdBy: c.actorUserId,
      createdAt: now(),
      aiProposed,
    };
    const d: ContractDraft = {
      id: draftId,
      workspaceId: contract.workspaceId,
      contractId,
      templateVersionId,
      documentVersionId: doc.id,
      status: 'WORKING',
      variables: {},
      createdBy: c.actorUserId,
      createdAt: now(),
      version: 1,
    };
    await this.s.append('documentVersions', doc);
    await this.s.append('contractDrafts', d);
    return d;
  }
  async setVariables(c: RequestContext, id: string, values: Record<string, unknown>) {
    const d = await find<ContractDraft>(this.s, 'contractDrafts', c, id);
    if (d.status !== 'WORKING') throw new Error('DRAFT_NOT_EDITABLE');
    const x = {
      ...d,
      variables: { ...d.variables, ...values },
      version: d.version + 1,
    };
    await this.s.replace('contractDrafts', x);
    return x;
  }
  async lock(c: RequestContext, id: string) {
    const d = await find<ContractDraft>(this.s, 'contractDrafts', c, id);
    if (d.status !== 'WORKING') throw new Error('DRAFT_NOT_EDITABLE');
    const x = {
      ...d,
      status: 'LOCKED' as const,
      lockedBy: c.actorUserId,
      version: d.version + 1,
    };
    await this.s.replace('contractDrafts', x);
    return x;
  }
  async submit(c: RequestContext, id: string) {
    const d = await find<ContractDraft>(this.s, 'contractDrafts', c, id),
      t = await find<TemplateVersion>(
        this.s,
        'templateVersions',
        c,
        d.templateVersionId,
      );
    if (!['WORKING', 'LOCKED'].includes(d.status))
      throw new Error('DRAFT_NOT_SUBMITTABLE');
    const missing = t.variableSchema
      .filter(
        (v) =>
          v.required &&
          (d.variables[v.key] === undefined || d.variables[v.key] === ''),
      )
      .map((v) => v.key);
    if (missing.length)
      throw new Error(`REQUIRED_VARIABLES_MISSING:${missing.join(',')}`);
    const x = { ...d, status: 'SUBMITTED' as const, version: d.version + 1 };
    await this.s.replace('contractDrafts', x);
    await event(this.s, c, 'ContractDraftSubmitted', 'ContractDraft', id, {
      documentVersionId: d.documentVersionId,
    });
    return x;
  }
  async revise(
    c: RequestContext,
    id: string,
    contentReference: string,
    content: string,
  ) {
    const d = await find<ContractDraft>(this.s, 'contractDrafts', c, id);
    if (d.status === 'LOCKED') throw new Error('DRAFT_LOCKED');
    const old = await find<DocumentVersion>(
      this.s,
      'documentVersions',
      c,
      d.documentVersionId,
    );
    const doc: DocumentVersion = {
      ...old,
      id: randomUUID(),
      number: old.number + 1,
      contentReference,
      contentHash: hash(content),
      createdBy: c.actorUserId,
      createdAt: now(),
      supersedesId: old.id,
    };
    await this.s.append('documentVersions', doc);
    const x = {
      ...d,
      documentVersionId: doc.id,
      status: 'WORKING' as const,
      version: d.version + 1,
    };
    await this.s.replace('contractDrafts', x);
    return x;
  }
  async comment(
    c: RequestContext,
    contractId: string,
    body: string,
    visibility: 'INTERNAL' | 'SHARED',
  ) {
    await find<Agreement>(this.s, 'agreements', c, contractId);
    const x: ContractComment = {
      id: randomUUID(),
      workspaceId: workspace(c),
      contractId,
      body,
      visibility,
      authorId: c.actorUserId,
      createdAt: now(),
    };
    await this.s.append('contractComments', x);
    return x;
  }
  async comments(c: RequestContext, contractId: string, external = false) {
    return (await this.s
      .list<ContractComment>('contractComments'))
      .filter(
        (x) =>
          x.workspaceId === workspace(c) &&
          x.contractId === contractId &&
          (!external || x.visibility === 'SHARED'),
      );
  }
}

export type ClauseVersion = {
  id: string;
  workspaceId: string;
  clauseKey: string;
  version: number;
  bodyHash: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  guidance: string;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED' | 'SUPERSEDED';
  createdAt: string;
};
export type ClauseInstance = {
  id: string;
  workspaceId: string;
  draftId: string;
  clauseVersionId?: string;
  bodyHash: string;
  source: 'LIBRARY' | 'CUSTOM';
  createdAt: string;
};
export type ClauseDeviation = {
  id: string;
  workspaceId: string;
  instanceId: string;
  baselineVersionId: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
};
export class ClauseIntelligenceEngine {
  constructor(private s: TrustPersistence) {}
  async createVersion(
    c: RequestContext,
    i: {
      clauseKey: string;
      body: string;
      risk: ClauseVersion['risk'];
      guidance: string;
    },
  ) {
    const w = workspace(c),
      n =
        (await this.s
          .list<ClauseVersion>('clauseVersions'))
          .filter((x) => x.workspaceId === w && x.clauseKey === i.clauseKey)
          .length + 1;
    const x: ClauseVersion = {
      id: randomUUID(),
      workspaceId: w,
      clauseKey: i.clauseKey,
      version: n,
      bodyHash: hash(i.body),
      risk: i.risk,
      guidance: i.guidance,
      status: 'DRAFT',
      createdAt: now(),
    };
    await this.s.append('clauseVersions', x);
    return x;
  }
  async publish(c: RequestContext, id: string) {
    const x = await find<ClauseVersion>(this.s, 'clauseVersions', c, id);
    if (x.status !== 'DRAFT') throw new Error('PUBLISHED_CLAUSE_IMMUTABLE');
    const y = { ...x, status: 'PUBLISHED' as const };
    await this.s.replace('clauseVersions', y);
    return y;
  }
  async retire(c: RequestContext, id: string) {
    const x = await find<ClauseVersion>(this.s, 'clauseVersions', c, id);
    const y = { ...x, status: 'RETIRED' as const };
    await this.s.replace('clauseVersions', y);
    return y;
  }
  async insert(
    c: RequestContext,
    draftId: string,
    i: { clauseVersionId?: string; customBody?: string },
  ) {
    let bodyHash: string, source: ClauseInstance['source'];
    if (i.clauseVersionId) {
      const v = await find<ClauseVersion>(
        this.s,
        'clauseVersions',
        c,
        i.clauseVersionId,
      );
      if (v.status !== 'PUBLISHED')
        throw new Error('PUBLISHED_CLAUSE_REQUIRED');
      bodyHash = v.bodyHash;
      source = 'LIBRARY';
    } else {
      if (!i.customBody) throw new Error('CLAUSE_CONTENT_REQUIRED');
      bodyHash = hash(i.customBody);
      source = 'CUSTOM';
    }
    const x: ClauseInstance = {
      id: randomUUID(),
      workspaceId: workspace(c),
      draftId,
      clauseVersionId: i.clauseVersionId,
      bodyHash,
      source,
      createdAt: now(),
    };
    await this.s.append('clauseInstances', x);
    return x;
  }
  async deviate(
    c: RequestContext,
    instanceId: string,
    baselineVersionId: string,
    proposed: string,
    summary: string,
  ) {
    const b = await find<ClauseVersion>(
      this.s,
      'clauseVersions',
      c,
      baselineVersionId,
    );
    const x: ClauseDeviation = {
      id: randomUUID(),
      workspaceId: workspace(c),
      instanceId,
      baselineVersionId,
      risk: b.risk,
      summary,
      status: 'PENDING',
      createdAt: now(),
    };
    await this.s.append('clauseDeviations', x);
    await event(this.s, c, 'ClauseDeviationDetected', 'ClauseDeviation', x.id, {
      risk: b.risk,
      proposedHash: hash(proposed),
    });
    return x;
  }
  async approve(c: RequestContext, id: string) {
    const x = await find<ClauseDeviation>(this.s, 'clauseDeviations', c, id);
    const y = { ...x, status: 'APPROVED' as const };
    await this.s.replace('clauseDeviations', y);
    return y;
  }
  async guidance(c: RequestContext, id: string, external = false) {
    if (external) throw new Error('INTERNAL_GUIDANCE_FORBIDDEN');
    return (await find<ClauseVersion>(this.s, 'clauseVersions', c, id)).guidance;
  }
}

export type NegotiationRound = {
  id: string;
  workspaceId: string;
  contractId: string;
  number: number;
  submittedBy: string;
  documentVersionId: string;
  status: 'SUBMITTED' | 'WITHDRAWN' | 'ACCEPTED';
  mandatoryOpenItems: string[];
  createdAt: string;
};
export class NegotiationEngine {
  constructor(private s: TrustPersistence) {}
  async submit(
    c: RequestContext,
    i: {
      contractId: string;
      documentVersionId: string;
      participantIds: string[];
      mandatoryOpenItems: string[];
    },
  ) {
    if (!i.participantIds.includes(c.actorUserId))
      throw new Error('NEGOTIATION_PARTICIPANT_REQUIRED');
    const n =
      (await this.s
        .list<NegotiationRound>('negotiationRounds'))
        .filter(
          (x) =>
            x.workspaceId === workspace(c) && x.contractId === i.contractId,
        ).length + 1;
    const x: NegotiationRound = {
      id: randomUUID(),
      workspaceId: workspace(c),
      contractId: i.contractId,
      number: n,
      submittedBy: c.actorUserId,
      documentVersionId: i.documentVersionId,
      status: 'SUBMITTED',
      mandatoryOpenItems: i.mandatoryOpenItems,
      createdAt: now(),
    };
    await this.s.append('negotiationRounds', x);
    await event(this.s, c, 'NegotiationRoundSubmitted', 'NegotiationRound', x.id);
    return x;
  }
  async withdraw(c: RequestContext, id: string) {
    const x = await find<NegotiationRound>(this.s, 'negotiationRounds', c, id);
    if (x.submittedBy !== c.actorUserId)
      throw new Error('NEGOTIATION_UNAUTHORIZED');
    const y = { ...x, status: 'WITHDRAWN' as const };
    await this.s.replace('negotiationRounds', y);
    return y;
  }
  async accept(c: RequestContext, id: string) {
    const x = await find<NegotiationRound>(this.s, 'negotiationRounds', c, id);
    if (x.mandatoryOpenItems.length)
      throw new Error('MANDATORY_POSITIONS_UNRESOLVED');
    const y = { ...x, status: 'ACCEPTED' as const };
    await this.s.replace('negotiationRounds', y);
    return y;
  }
}

export type ApprovalPolicy = {
  id: string;
  workspaceId: string;
  version: number;
  steps: Array<{
    role: string;
    minimumAssurance: 'IAL1_BASIC' | 'IAL2_VERIFIED' | 'IAL3_HIGH_ASSURANCE';
  }>;
  status: 'DRAFT' | 'PUBLISHED';
  createdAt: string;
};
export type ApprovalRequest = {
  id: string;
  workspaceId: string;
  contractId: string;
  documentVersionId: string;
  documentHash: string;
  policyId: string;
  requesterId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'INVALIDATED';
  completedSteps: number;
  createdAt: string;
};
export type ApprovalDecision = {
  id: string;
  workspaceId: string;
  requestId: string;
  step: number;
  approverId: string;
  decision: 'APPROVE' | 'REJECT';
  conditions: string[];
  createdAt: string;
};
export class ApprovalWorkflowEngine {
  constructor(private s: TrustPersistence) {}
  async policy(c: RequestContext, steps: ApprovalPolicy['steps']) {
    if (!steps.length) throw new Error('APPROVAL_STEPS_REQUIRED');
    const x: ApprovalPolicy = {
      id: randomUUID(),
      workspaceId: workspace(c),
      version: 1,
      steps,
      status: 'PUBLISHED',
      createdAt: now(),
    };
    await this.s.append('approvalPolicies', x);
    return x;
  }
  async route(
    c: RequestContext,
    i: { contractId: string; documentVersionId: string; policyId: string },
  ) {
    const p = await find<ApprovalPolicy>(this.s, 'approvalPolicies', c, i.policyId),
      d = await find<DocumentVersion>(
        this.s,
        'documentVersions',
        c,
        i.documentVersionId,
      );
    if (p.status !== 'PUBLISHED') throw new Error('PUBLISHED_POLICY_REQUIRED');
    const x: ApprovalRequest = {
      id: randomUUID(),
      workspaceId: workspace(c),
      ...i,
      documentHash: d.contentHash,
      requesterId: c.actorUserId,
      status: 'PENDING',
      completedSteps: 0,
      createdAt: now(),
    };
    await this.s.append('approvalRequests', x);
    await event(this.s, c, 'ApprovalRequestRouted', 'ApprovalRequest', x.id, {
      policyId: p.id,
      policyVersion: p.version,
    });
    return x;
  }
  async decide(
    c: RequestContext,
    id: string,
    decision: 'APPROVE' | 'REJECT',
    conditions: string[] = [],
    roles: string[] = [],
  ) {
    const r = await find<ApprovalRequest>(this.s, 'approvalRequests', c, id);
    if (r.status !== 'PENDING') throw new Error('APPROVAL_DECISION_IMMUTABLE');
    if (r.requesterId === c.actorUserId)
      throw new Error('REQUESTER_SELF_APPROVAL_BLOCKED');
    const p = await find<ApprovalPolicy>(this.s, 'approvalPolicies', c, r.policyId),
      step = p.steps[r.completedSteps];
    if (!step || !roles.includes(step.role))
      throw new Error('APPROVER_AUTHORITY_REQUIRED');
    const levels = { IAL0_UNVERIFIED: 0, IAL1_BASIC: 1, IAL2_VERIFIED: 2, IAL3_HIGH_ASSURANCE: 3 };
    if (levels[c.identityAssuranceLevel] < levels[step.minimumAssurance])
      throw new Error('STEP_UP_REQUIRED');
    const x: ApprovalDecision = {
      id: randomUUID(),
      workspaceId: workspace(c),
      requestId: id,
      step: r.completedSteps,
      approverId: c.actorUserId,
      decision,
      conditions,
      createdAt: now(),
    };
    await this.s.append('approvalDecisions', x);
    const completed = r.completedSteps + 1,
      y = {
        ...r,
        completedSteps: completed,
        status:
          decision === 'REJECT'
            ? ('REJECTED' as const)
            : completed === p.steps.length
              ? ('APPROVED' as const)
              : ('PENDING' as const),
      };
    await this.s.replace('approvalRequests', y);
    return x;
  }
  async invalidateOnChange(c: RequestContext, id: string, currentHash: string) {
    const r = await find<ApprovalRequest>(this.s, 'approvalRequests', c, id);
    if (r.documentHash === currentHash) return r;
    const y = { ...r, status: 'INVALIDATED' as const };
    await this.s.replace('approvalRequests', y);
    await event(this.s, c, 'ApprovalInvalidated', 'ApprovalRequest', id);
    return y;
  }
}

export type SignaturePackage = {
  id: string;
  workspaceId: string;
  contractId: string;
  approvalRequestId: string;
  documentVersionId: string;
  documentHash: string;
  signers: Array<{
    userId: string;
    authorityReference: string;
    witnessRequired: boolean;
    signedAt?: string;
    witnessedAt?: string;
  }>;
  status:
    'DRAFT' | 'SENT' | 'PARTIALLY_SIGNED' | 'COMPLETED' | 'DECLINED' | 'VOID';
  providerKey: string;
  createdAt: string;
};
export type ExecutionCertificate = {
  id: string;
  workspaceId: string;
  packageId: string;
  contractId: string;
  documentHash: string;
  canonicalHash: string;
  status: 'VALID' | 'REVOKED';
  issuedAt: string;
};
export interface SignatureProvider {
  providerKey: string;
  send(p: SignaturePackage): Promise<{ reference: string }>;
}
export class DigitalExecutionEngine {
  constructor(
    private s: TrustPersistence,
    private provider: SignatureProvider,
    private webhookSecret: string,
  ) {}
  async create(
    c: RequestContext,
    i: {
      contractId: string;
      approvalRequestId: string;
      documentVersionId: string;
      signers: SignaturePackage['signers'];
    },
  ) {
    const a = await find<ApprovalRequest>(
        this.s,
        'approvalRequests',
        c,
        i.approvalRequestId,
      ),
      d = await find<DocumentVersion>(
        this.s,
        'documentVersions',
        c,
        i.documentVersionId,
      );
    if (
      a.status !== 'APPROVED' ||
      a.documentVersionId !== d.id ||
      a.documentHash !== d.contentHash
    )
      throw new Error('EXACT_APPROVED_DOCUMENT_REQUIRED');
    if (!i.signers.length || i.signers.some((x) => !x.authorityReference))
      throw new Error('SIGNATORY_AUTHORITY_REQUIRED');
    const x: SignaturePackage = {
      id: randomUUID(),
      workspaceId: workspace(c),
      ...i,
      documentHash: d.contentHash,
      status: 'DRAFT',
      providerKey: this.provider.providerKey,
      createdAt: now(),
    };
    await this.s.append('signaturePackages', x);
    return x;
  }
  async send(c: RequestContext, id: string) {
    const x = await find<SignaturePackage>(this.s, 'signaturePackages', c, id);
    if (x.status !== 'DRAFT') throw new Error('PACKAGE_NOT_SENDABLE');
    await this.provider.send(x);
    const y = { ...x, status: 'SENT' as const };
    await this.s.replace('signaturePackages', y);
    return y;
  }
  async callback(
    c: RequestContext,
    id: string,
    payload: {
      eventId: string;
      userId: string;
      action: 'SIGNED' | 'WITNESSED' | 'DECLINED';
      documentHash: string;
    },
    signature: string,
  ) {
    const expected = createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest();
    const supplied = Buffer.from(signature, 'hex');
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new Error('INVALID_PROVIDER_WEBHOOK');
    if (
      (await this.s
        .list<{ eventId: string }>('signatureCallbacks'))
        .some((x) => x.eventId === payload.eventId)
    )
      return await find<SignaturePackage>(this.s, 'signaturePackages', c, id);
    const p = await find<SignaturePackage>(this.s, 'signaturePackages', c, id);
    if (payload.documentHash !== p.documentHash)
      throw new Error('DOCUMENT_HASH_MISMATCH');
    await this.s.append('signatureCallbacks', {
      id: randomUUID(),
      workspaceId: workspace(c),
      eventId: payload.eventId,
      createdAt: now(),
    });
    if (payload.action === 'DECLINED') {
      const y = { ...p, status: 'DECLINED' as const };
      await this.s.replace('signaturePackages', y);
      return y;
    }
    const signers = p.signers.map((x) =>
      x.userId !== payload.userId
        ? x
        : payload.action === 'SIGNED'
          ? { ...x, signedAt: now() }
          : { ...x, witnessedAt: now() },
    );
    const complete = signers.every(
      (x) => x.signedAt && (!x.witnessRequired || x.witnessedAt),
    );
    const y = {
      ...p,
      signers,
      status: complete ? ('COMPLETED' as const) : ('PARTIALLY_SIGNED' as const),
    };
    await this.s.replace('signaturePackages', y);
    return y;
  }
  async issue(c: RequestContext, id: string) {
    const p = await find<SignaturePackage>(this.s, 'signaturePackages', c, id);
    if (p.status !== 'COMPLETED')
      throw new Error('SIGNATURE_PACKAGE_INCOMPLETE');
    const existing = (await this.s
      .list<ExecutionCertificate>('agreementExecutionCertificates'))
      .find((x) => x.packageId === id);
    if (existing) return existing;
    const canonicalHash = hash({
      packageId: id,
      contractId: p.contractId,
      documentHash: p.documentHash,
      signers: p.signers.map((x) => ({
        userId: x.userId,
        authorityReference: x.authorityReference,
        signedAt: x.signedAt,
        witnessedAt: x.witnessedAt,
      })),
    });
    const x: ExecutionCertificate = {
      id: randomUUID(),
      workspaceId: workspace(c),
      packageId: id,
      contractId: p.contractId,
      documentHash: p.documentHash,
      canonicalHash,
      status: 'VALID',
      issuedAt: now(),
    };
    await this.s.append('agreementExecutionCertificates', x);
    await event(
      this.s,
      c,
      'ExecutionCertificateIssued',
      'ExecutionCertificate',
      x.id,
      { canonicalHash },
    );
    return x;
  }
  async revoke(c: RequestContext, id: string) {
    const x = await find<ExecutionCertificate>(
      this.s,
      'agreementExecutionCertificates',
      c,
      id,
    );
    const y = { ...x, status: 'REVOKED' as const };
    await this.s.replace('agreementExecutionCertificates', y);
    return y;
  }
}
export const deterministicSignatureProvider: SignatureProvider = {
  providerKey: 'sandbox',
  async send(p) {
    return { reference: `sandbox:${p.id}` };
  },
};

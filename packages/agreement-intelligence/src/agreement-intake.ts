import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext, TrustPersistence } from '@assurapay/shared';
import { requireActiveWorkspace } from '@assurapay/shared';

export type AgreementIntakeSourceType =
  | 'DIRECT_DESCRIPTION'
  | 'INFORMAL_ARTIFACT'
  | 'FORMAL_DOCUMENT';

export type IntakeSourceReference = {
  artifactId?: string;
  section?: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
};

export type ProposedAgreementTerm = {
  key: string;
  value: unknown;
  confidence: number;
  sourceReferences: IntakeSourceReference[];
};

export type ClarificationItem = {
  id: string;
  key: string;
  question: string;
  required: boolean;
  status: 'OPEN' | 'RESOLVED';
  answer?: unknown;
};

export type AgreementIntake = {
  id: string;
  workspaceId: string;
  sourceType: AgreementIntakeSourceType;
  sourceArtifactIds: string[];
  sourceHash: string;
  proposedTerms: ProposedAgreementTerm[];
  clarifications: ClarificationItem[];
  clarityScore: number;
  status: 'INGESTED' | 'NEEDS_CLARIFICATION' | 'READY_FOR_REVIEW' | 'CONVERTED';
  createdBy: string;
  createdAt: string;
  convertedAgreementId?: string;
};

const REQUIRED_TERMS = ['title', 'parties', 'scope', 'currency', 'value', 'paymentTerms'];
const now = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

function workspace(context: RequestContext) {
  requireActiveWorkspace(context);
  return context.activeWorkspaceId;
}

function assessClarity(terms: ProposedAgreementTerm[]) {
  const keys = new Set(terms.filter((term) => term.value !== undefined && term.value !== null && term.value !== '').map((term) => term.key));
  const present = REQUIRED_TERMS.filter((key) => keys.has(key));
  return Math.round((present.length / REQUIRED_TERMS.length) * 100);
}

function buildClarifications(terms: ProposedAgreementTerm[]): ClarificationItem[] {
  const keys = new Set(terms.filter((term) => term.value !== undefined && term.value !== null && term.value !== '').map((term) => term.key));
  return REQUIRED_TERMS.filter((key) => !keys.has(key)).map((key) => ({
    id: randomUUID(),
    key,
    question: `Provide the agreement ${key}.`,
    required: true,
    status: 'OPEN' as const,
  }));
}

/**
 * Converges direct descriptions, informal artifacts and formal documents into one
 * governed intake representation. Extraction remains proposal-only: this engine
 * cannot accept terms for a party, activate an agreement, approve completion or
 * release payment.
 */
export class AgreementIntakeEngine {
  constructor(private persistence: TrustPersistence) {}

  async ingest(
    context: RequestContext,
    input: {
      sourceType: AgreementIntakeSourceType;
      sourceArtifactIds?: string[];
      rawSource: string;
      proposedTerms: ProposedAgreementTerm[];
    },
  ) {
    if (!input.rawSource.trim()) throw new Error('AGREEMENT_SOURCE_REQUIRED');
    for (const term of input.proposedTerms) {
      if (!Number.isFinite(term.confidence) || term.confidence < 0 || term.confidence > 1)
        throw new Error('INVALID_EXTRACTION_CONFIDENCE');
      if (input.sourceType !== 'DIRECT_DESCRIPTION' && !term.sourceReferences.length)
        throw new Error('SOURCE_REFERENCE_REQUIRED');
    }

    const clarifications = buildClarifications(input.proposedTerms);
    const clarityScore = assessClarity(input.proposedTerms);
    const record: AgreementIntake = {
      id: randomUUID(),
      workspaceId: workspace(context),
      sourceType: input.sourceType,
      sourceArtifactIds: input.sourceArtifactIds ?? [],
      sourceHash: digest(input.rawSource),
      proposedTerms: input.proposedTerms,
      clarifications,
      clarityScore,
      status: clarifications.length ? 'NEEDS_CLARIFICATION' : 'READY_FOR_REVIEW',
      createdBy: context.actorUserId,
      createdAt: now(),
    };
    await this.persistence.append('agreementIntakes', record);
    await this.persistence.audit({
      tenantId: context.tenantId,
      workspaceId: record.workspaceId,
      actorId: context.actorUserId,
      eventType: 'AgreementIntakeCreated',
      aggregateType: 'AgreementIntake',
      aggregateId: record.id,
      correlationId: context.correlationId,
      metadata: { sourceType: record.sourceType, clarityScore, sourceHash: record.sourceHash },
    });
    return record;
  }

  async resolveClarification(context: RequestContext, intakeId: string, clarificationId: string, answer: unknown) {
    const record = (await this.persistence.list<AgreementIntake>('agreementIntakes')).find(
      (item) => item.id === intakeId && item.workspaceId === workspace(context),
    );
    if (!record) throw new Error('NOT_FOUND');
    if (record.status === 'CONVERTED') throw new Error('CONVERTED_INTAKE_IMMUTABLE');
    const target = record.clarifications.find((item) => item.id === clarificationId);
    if (!target) throw new Error('CLARIFICATION_NOT_FOUND');
    if (answer === undefined || answer === null || answer === '') throw new Error('CLARIFICATION_ANSWER_REQUIRED');

    const clarifications = record.clarifications.map((item) =>
      item.id === clarificationId ? { ...item, answer, status: 'RESOLVED' as const } : item,
    );
    const proposedTerms = [
      ...record.proposedTerms.filter((term) => term.key !== target.key),
      { key: target.key, value: answer, confidence: 1, sourceReferences: [] },
    ];
    const open = clarifications.some((item) => item.required && item.status === 'OPEN');
    const updated: AgreementIntake = {
      ...record,
      clarifications,
      proposedTerms,
      clarityScore: assessClarity(proposedTerms),
      status: open ? 'NEEDS_CLARIFICATION' : 'READY_FOR_REVIEW',
    };
    await this.persistence.replace('agreementIntakes', updated);
    return updated;
  }

  async markConverted(context: RequestContext, intakeId: string, agreementId: string) {
    const record = (await this.persistence.list<AgreementIntake>('agreementIntakes')).find(
      (item) => item.id === intakeId && item.workspaceId === workspace(context),
    );
    if (!record) throw new Error('NOT_FOUND');
    if (record.status !== 'READY_FOR_REVIEW') throw new Error('INTAKE_NOT_READY');
    if (!agreementId) throw new Error('AGREEMENT_ID_REQUIRED');
    const updated: AgreementIntake = { ...record, status: 'CONVERTED', convertedAgreementId: agreementId };
    await this.persistence.replace('agreementIntakes', updated);
    return updated;
  }
}

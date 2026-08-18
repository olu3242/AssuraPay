import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  agreementIntelligenceVersionSchema,
  analysisFindingSchema,
  analysisRunSchema,
  contractVersionSchema,
  intelligenceItemSchema,
  repositoryDocumentSchema,
  riskAssessmentSchema,
  riskLevelForScore,
  sourceReferenceSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  AgreementIntelligenceVersion,
  AnalysisFinding,
  AnalysisRun,
  ContractVersion,
  IntelligenceItem,
  RepositoryDocument,
  RiskAssessment,
  SourceReference,
} from './index';

/**
 * Compile-time proof that this package's Batch I domain types and their canonical Zod schemas describe the
 * same shape, plus the rules those schemas enforce.
 *
 * Two invariants are deliberately absent, for different reasons.
 *
 * The **content hash** cannot be verified by a schema or a constraint: checking that `contentHash` is the
 * digest of `items` means computing SHA-256, which a Zod refinement could do but a database CHECK cannot,
 * and splitting the rule across the two would put the authority in the weaker place. It stays in the
 * engine — where `review()` now recomputes it, which it did not before this batch.
 *
 * The **supersession chain** — that at most one version per contract is ACTIVE, and that a superseded one
 * is actually marked SUPERSEDED — is a property of a set, so it is a partial unique index rather than a
 * schema rule, the same division every batch since B has made.
 */

export const sourceReferenceSchemaConforms: SchemaMatchesType<
  z.infer<typeof sourceReferenceSchema>,
  SourceReference
> = true;

export const contractVersionSchemaConforms: SchemaMatchesType<
  z.infer<typeof contractVersionSchema>,
  ContractVersion
> = true;

export const analysisFindingSchemaConforms: SchemaMatchesType<
  z.infer<typeof analysisFindingSchema>,
  AnalysisFinding
> = true;

export const analysisRunSchemaConforms: SchemaMatchesType<
  z.infer<typeof analysisRunSchema>,
  AnalysisRun
> = true;

/**
 * The risk assessment is asserted field by field rather than whole, and the reason is a limitation of the
 * checker rather than a gap in the shape.
 *
 * `SchemaMatchesType` is built on the `(<T>() => T extends X ? 1 : 2)` invariance trick, which is exact but
 * not reliably transitive on deeply nested structures. Here the schema's `explanations` element expands
 * `SourceReference` inline while the domain's names the alias, and the whole-object comparison reports a
 * mismatch even though every part is identical: each field below passes, the key sets match, and
 * `sourceReferenceSchemaConforms` above establishes the nested type directly. Weakening the helper to make
 * one aggregate pass would weaken it for the thirty-odd that legitimately rely on it, so the assertion is
 * decomposed instead.
 *
 * The drift protection is unchanged. A field added, removed or retyped on either side still fails
 * `pnpm typecheck` — the key-set assertion catches the first two and the per-field ones the third.
 */
type RiskInferred = z.infer<typeof riskAssessmentSchema>;

export const riskAssessmentKeysConform: SchemaMatchesType<
  keyof RiskInferred,
  keyof RiskAssessment
> = true;
export const riskId: SchemaMatchesType<RiskInferred['id'], RiskAssessment['id']> = true;
export const riskWorkspaceId: SchemaMatchesType<
  RiskInferred['workspaceId'],
  RiskAssessment['workspaceId']
> = true;
export const riskContractId: SchemaMatchesType<
  RiskInferred['contractId'],
  RiskAssessment['contractId']
> = true;
export const riskContractVersionId: SchemaMatchesType<
  RiskInferred['contractVersionId'],
  RiskAssessment['contractVersionId']
> = true;
export const riskAnalysisRunId: SchemaMatchesType<
  RiskInferred['analysisRunId'],
  RiskAssessment['analysisRunId']
> = true;
export const riskVersion: SchemaMatchesType<RiskInferred['version'], RiskAssessment['version']> = true;
export const riskDimensions: SchemaMatchesType<
  RiskInferred['dimensions'],
  RiskAssessment['dimensions']
> = true;
export const riskScore: SchemaMatchesType<RiskInferred['score'], RiskAssessment['score']> = true;
export const riskLevel: SchemaMatchesType<RiskInferred['level'], RiskAssessment['level']> = true;
export const riskExplanations: SchemaMatchesType<
  RiskInferred['explanations'],
  RiskAssessment['explanations']
> = true;
export const riskStatus: SchemaMatchesType<RiskInferred['status'], RiskAssessment['status']> = true;
export const riskCreatedAt: SchemaMatchesType<
  RiskInferred['createdAt'],
  RiskAssessment['createdAt']
> = true;

export const repositoryDocumentSchemaConforms: SchemaMatchesType<
  z.infer<typeof repositoryDocumentSchema>,
  RepositoryDocument
> = true;

export const intelligenceItemSchemaConforms: SchemaMatchesType<
  z.infer<typeof intelligenceItemSchema>,
  IntelligenceItem
> = true;

export const agreementIntelligenceVersionSchemaConforms: SchemaMatchesType<
  z.infer<typeof agreementIntelligenceVersionSchema>,
  AgreementIntelligenceVersion
> = true;

const stamp = '2026-08-11T09:00:00.000Z';
const HASH = 'a'.repeat(64);
const citation: SourceReference = { documentVersionId: 'cv-1', section: '4.2' };

describe('Batch I citations', () => {
  it('refuses a citation that ends before it starts', () => {
    expect(sourceReferenceSchema.safeParse({ ...citation, startOffset: 10, endOffset: 40 }).success).toBe(
      true,
    );
    expect(sourceReferenceSchema.safeParse({ ...citation, startOffset: 40, endOffset: 10 }).success).toBe(
      false,
    );
  });

  it('requires every finding above INFO to cite a source', () => {
    const finding: AnalysisFinding = {
      id: 'f-1',
      type: 'UNCAPPED_LIABILITY',
      severity: 'HIGH',
      title: 'Liability is uncapped',
      sourceReferences: [citation],
      confidence: 0.9,
      reviewStatus: 'NOT_REVIEWED',
    };
    expect(analysisFindingSchema.safeParse(finding).success).toBe(true);
    // An uncited HIGH finding is an assertion about the contract with nothing behind it.
    expect(analysisFindingSchema.safeParse({ ...finding, sourceReferences: [] }).success).toBe(false);
    // INFO is exempt, and deliberately so: an informational note is an observation, not a claim.
    expect(
      analysisFindingSchema.safeParse({ ...finding, severity: 'INFO', sourceReferences: [] }).success,
    ).toBe(true);
  });
});

describe('Batch I analysis runs name the model that produced them', () => {
  const run: AnalysisRun = {
    id: 'ar-1',
    workspaceId: 'workspace-1',
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    method: 'DETERMINISTIC',
    inputHash: HASH,
    outputHash: 'b'.repeat(64),
    findings: [],
    status: 'COMPLETED',
    requestedBy: 'user-1',
    createdAt: stamp,
  };

  it('accepts a deterministic run with no model', () => {
    expect(analysisRunSchema.safeParse(run).success).toBe(true);
  });

  it('refuses a model-assisted run that cannot say which model', () => {
    // For an AI-derived claim about a contract, being unable to name the model and prompt is the whole of
    // its evidential value gone: the finding can be neither reproduced nor attributed.
    expect(analysisRunSchema.safeParse({ ...run, method: 'AI_ASSISTED' }).success).toBe(false);
    expect(
      analysisRunSchema.safeParse({
        ...run,
        method: 'AI_ASSISTED',
        modelId: 'm-1',
        modelVersion: '2026-08',
        promptVersion: 'p-3',
      }).success,
    ).toBe(true);
    // HYBRID is model-assisted too, and half the metadata is not enough.
    expect(
      analysisRunSchema.safeParse({ ...run, method: 'HYBRID', modelId: 'm-1' }).success,
    ).toBe(false);
  });
});

describe('Batch I risk levels follow from their scores', () => {
  const assessment: RiskAssessment = {
    id: 'ra-1',
    workspaceId: 'workspace-1',
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    analysisRunId: 'ar-1',
    version: 1,
    dimensions: { liability: 70, termination: 50 },
    score: 60,
    level: 'HIGH',
    explanations: [{ dimension: 'liability', sourceReferences: [citation] }],
    status: 'DRAFT',
    createdAt: stamp,
  };

  it('agrees with the engine at every threshold', () => {
    expect(riskAssessmentSchema.safeParse(assessment).success).toBe(true);
    for (const [score, level] of [
      [0, 'LOW'],
      [29, 'LOW'],
      [30, 'MODERATE'],
      [59, 'MODERATE'],
      [60, 'HIGH'],
      [79, 'HIGH'],
      [80, 'CRITICAL'],
      [100, 'CRITICAL'],
    ] as const) {
      expect(riskLevelForScore(score), `score ${score}`).toBe(level);
      expect(
        riskAssessmentSchema.safeParse({ ...assessment, score, level }).success,
        `score ${score}`,
      ).toBe(true);
    }
  });

  it('refuses a banner that does not describe its own number', () => {
    // The level is derived, not chosen, and the banner is what a reader acts on.
    expect(riskAssessmentSchema.safeParse({ ...assessment, score: 4, level: 'CRITICAL' }).success).toBe(
      false,
    );
    expect(riskAssessmentSchema.safeParse({ ...assessment, score: 95, level: 'LOW' }).success).toBe(
      false,
    );
  });

  it('refuses an assessment that measured nothing, or an uncited explanation', () => {
    // `assess()` divides by `Math.max(1, count)`, so an empty set scores zero and shows a LOW banner that
    // reads as a finding rather than as an absence of one.
    expect(
      riskAssessmentSchema.safeParse({ ...assessment, dimensions: {}, score: 0, level: 'LOW' }).success,
    ).toBe(false);
    expect(
      riskAssessmentSchema.safeParse({
        ...assessment,
        explanations: [{ dimension: 'liability', sourceReferences: [] }],
      }).success,
    ).toBe(false);
    // A dimension out of a hundred, which is what `INVALID_RISK_SCORE` guards.
    expect(
      riskAssessmentSchema.safeParse({ ...assessment, dimensions: { liability: 140 } }).success,
    ).toBe(false);
  });
});

describe('Batch I published intelligence has been reviewed', () => {
  const item: IntelligenceItem = {
    id: 'ii-1',
    type: 'OBLIGATION',
    value: { text: 'Supplier maintains insurance' },
    sourceReferences: [citation],
    confidence: 0.8,
    reviewStatus: 'ACCEPTED',
  };
  const version: AgreementIntelligenceVersion = {
    id: 'aiv-1',
    workspaceId: 'workspace-1',
    contractId: 'c-1',
    contractVersionId: 'cv-1',
    version: 1,
    items: [item],
    status: 'PUBLISHED',
    createdBy: 'user-1',
    createdAt: stamp,
    contentHash: HASH,
  };

  it('refuses a published version with an item still awaiting review', () => {
    expect(agreementIntelligenceVersionSchema.safeParse(version).success).toBe(true);
    // The human-in-the-loop rule for machine-extracted terms: this is what keeps an AI reading of a
    // contract from becoming the contract's terms unreviewed.
    expect(
      agreementIntelligenceVersionSchema.safeParse({
        ...version,
        items: [{ ...item, reviewStatus: 'PENDING' }],
      }).success,
    ).toBe(false);
    // A draft may of course still be pending — that is what a draft is.
    expect(
      agreementIntelligenceVersionSchema.safeParse({
        ...version,
        status: 'DRAFT',
        items: [{ ...item, reviewStatus: 'PENDING' }],
      }).success,
    ).toBe(true);
  });

  it('refuses a published version where every item was rejected', () => {
    // Publishing nothing accepted would present a reviewed-and-rejected reading as the agreement's terms.
    expect(
      agreementIntelligenceVersionSchema.safeParse({
        ...version,
        items: [{ ...item, reviewStatus: 'REJECTED' }],
      }).success,
    ).toBe(false);
  });

  it('requires every item to cite a source, without exemption', () => {
    // Unlike findings, there is no INFO tier here: these items become parties, milestones and payment
    // triggers downstream, so an uncited one is an unverifiable term entering the settlement path.
    expect(
      agreementIntelligenceVersionSchema.safeParse({
        ...version,
        items: [{ ...item, sourceReferences: [] }],
      }).success,
    ).toBe(false);
    expect(agreementIntelligenceVersionSchema.safeParse({ ...version, items: [] }).success).toBe(false);
  });
});

describe('Batch I contract versions and repository documents', () => {
  const version: ContractVersion = {
    id: 'cv-1',
    workspaceId: 'workspace-1',
    contractId: 'c-1',
    number: 2,
    kind: 'AMENDMENT',
    documentReference: 'store://contracts/cv-1.pdf',
    documentHash: HASH,
    executionCertificateId: 'cert-1',
    status: 'ACTIVE',
    supersedesId: 'cv-0',
    createdAt: stamp,
  };

  it('refuses a version that supersedes itself', () => {
    expect(contractVersionSchema.safeParse(version).success).toBe(true);
    // `registerExecuted` marks the superseded version SUPERSEDED, so a self-reference would set the new
    // version's own status and leave the chain pointing at nothing.
    expect(contractVersionSchema.safeParse({ ...version, supersedesId: 'cv-1' }).success).toBe(false);
  });

  it('requires a real document hash, because verify() compares against it', () => {
    expect(contractVersionSchema.safeParse({ ...version, documentHash: 'abc' }).success).toBe(false);
  });

  it('accepts only the document types the repository allows', () => {
    const document: RepositoryDocument = {
      id: 'rd-1',
      workspaceId: 'workspace-1',
      contractVersionId: 'cv-1',
      storageReference: 'store://docs/rd-1',
      contentHash: HASH,
      mimeType: 'application/pdf',
      classification: 'CONFIDENTIAL',
      tags: ['insurance'],
      legalHold: false,
      createdAt: stamp,
    };
    expect(repositoryDocumentSchema.safeParse(document).success).toBe(true);
    // `MIME_NOT_ALLOWED`. A repository that will store any bytes under any type is not a controlled one.
    expect(repositoryDocumentSchema.safeParse({ ...document, mimeType: 'image/png' }).success).toBe(
      false,
    );
  });
});

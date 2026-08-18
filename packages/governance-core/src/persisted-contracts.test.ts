import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  certificationDecisionSchema,
  certificationRequestSchema,
  digitalCertificationRecordSchema,
  dodCriterionSchema,
  dodEvaluationSchema,
  dodVersionSchema,
  executionHistorySchema,
  governedExecutionSchema,
  governedMilestoneSchema,
  milestoneDependencySchema,
  paymentAuthorizationProposalSchema,
  paymentTriggerDefinitionSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  CertificationDecision,
  CertificationRequest,
  DefinitionOfDoneVersion,
  DigitalCertificationRecord,
  DodCriterion,
  DodEvaluation,
  Execution,
  ExecutionHistory,
  MilestoneDependency,
  MilestoneNode,
  PaymentAuthorizationProposal,
  PaymentTriggerDefinition,
} from './index';

/**
 * Compile-time proof that this package's Batch H domain types and their canonical Zod schemas describe the
 * same shape, plus the rules those schemas enforce.
 *
 * Three cross-row invariants are deliberately absent, because a single-record schema cannot express any of
 * them:
 *
 *   - **the legal execution state machine**, which `transition()` enforces from a table of allowed edges. A
 *     row knows its state but not the state it came from, so the edge is a property of two rows;
 *   - **acyclicity of the milestone graph** beyond a self-edge and a self-parent, which is a property of
 *     the whole graph — the same division Batch E made for its sequence edges;
 *   - **which criteria were mandatory**, which lives in the definition rather than the evaluation. The
 *     evaluation's own consistency — a passing verdict cannot contain a failed result — is checkable from
 *     one row and is enforced.
 *
 * Everything else here is a single-record rule, so the schema and the database both carry it, and
 * `202608110011` makes each one a constraint as well.
 */

export const dodCriterionSchemaConforms: SchemaMatchesType<
  z.infer<typeof dodCriterionSchema>,
  DodCriterion
> = true;

export const governedExecutionSchemaConforms: SchemaMatchesType<
  z.infer<typeof governedExecutionSchema>,
  Execution
> = true;

export const executionHistorySchemaConforms: SchemaMatchesType<
  z.infer<typeof executionHistorySchema>,
  ExecutionHistory
> = true;

export const governedMilestoneSchemaConforms: SchemaMatchesType<
  z.infer<typeof governedMilestoneSchema>,
  MilestoneNode
> = true;

export const milestoneDependencySchemaConforms: SchemaMatchesType<
  z.infer<typeof milestoneDependencySchema>,
  MilestoneDependency
> = true;

export const dodVersionSchemaConforms: SchemaMatchesType<
  z.infer<typeof dodVersionSchema>,
  DefinitionOfDoneVersion
> = true;

export const dodEvaluationSchemaConforms: SchemaMatchesType<
  z.infer<typeof dodEvaluationSchema>,
  DodEvaluation
> = true;

export const certificationRequestSchemaConforms: SchemaMatchesType<
  z.infer<typeof certificationRequestSchema>,
  CertificationRequest
> = true;

export const certificationDecisionSchemaConforms: SchemaMatchesType<
  z.infer<typeof certificationDecisionSchema>,
  CertificationDecision
> = true;

export const digitalCertificationRecordSchemaConforms: SchemaMatchesType<
  z.infer<typeof digitalCertificationRecordSchema>,
  DigitalCertificationRecord
> = true;

export const paymentTriggerDefinitionSchemaConforms: SchemaMatchesType<
  z.infer<typeof paymentTriggerDefinitionSchema>,
  PaymentTriggerDefinition
> = true;

export const paymentAuthorizationProposalSchemaConforms: SchemaMatchesType<
  z.infer<typeof paymentAuthorizationProposalSchema>,
  PaymentAuthorizationProposal
> = true;

const stamp = '2026-08-11T09:00:00.000Z';

const proposal: PaymentAuthorizationProposal = {
  id: 'pap-1',
  workspaceId: 'workspace-1',
  triggerId: 'ptd-1',
  milestoneId: 'gm-1',
  amountMinor: 5_000_000,
  currency: 'NGN',
  status: 'PROPOSED',
  blockers: [],
  proposedBy: 'user-1',
  proposedAt: stamp,
  idempotencyKey: 'idem-0001',
};

describe('Batch H authorization proposals cannot contradict themselves', () => {
  it('accepts a proposal that is blocked and says why, and one that is clear and says nothing', () => {
    expect(paymentAuthorizationProposalSchema.safeParse(proposal).success).toBe(true);
    expect(
      paymentAuthorizationProposalSchema.safeParse({
        ...proposal,
        status: 'BLOCKED',
        blockers: ['DOD_NOT_SATISFIED', 'CERTIFICATION_REQUIRED'],
      }).success,
    ).toBe(true);
  });

  it('refuses a proposal whose status and blockers disagree', () => {
    // `createEscrowReleaseIntent` reads nothing but the status before instructing the provider, so a
    // PROPOSED row that still carries blockers is an authorised release whose own record says it should not
    // have been. This is the shape a tampered row would take.
    expect(
      paymentAuthorizationProposalSchema.safeParse({
        ...proposal,
        blockers: ['DOD_NOT_SATISFIED'],
      }).success,
    ).toBe(false);
    // And the reverse is simply unreadable: blocked, but by nothing.
    expect(
      paymentAuthorizationProposalSchema.safeParse({ ...proposal, status: 'BLOCKED' }).success,
    ).toBe(false);
  });

  it('refuses a proposal that would release nothing', () => {
    expect(paymentAuthorizationProposalSchema.safeParse({ ...proposal, amountMinor: 0 }).success).toBe(
      false,
    );
  });
});

describe('Batch H evaluations cannot claim more than their results support', () => {
  const evaluation: DodEvaluation = {
    id: 'de-1',
    workspaceId: 'workspace-1',
    milestoneId: 'gm-1',
    definitionId: 'dv-1',
    results: [{ criterionKey: 'cube-test', passed: true, reason: 'Met at 28 days' }],
    mandatoryPassed: true,
    manualReviewRequired: false,
    evidenceReferences: ['lab-cert-1'],
    evaluatedBy: 'user-1',
    evaluatedAt: stamp,
  };

  it('refuses a passing verdict over a failed result', () => {
    expect(dodEvaluationSchema.safeParse(evaluation).success).toBe(true);
    // `PaymentTriggerEngine.evaluate` reads `mandatoryPassed` alone to decide whether DOD_NOT_SATISFIED
    // blocks a release, so a flipped boolean over failing results manufactures a satisfied definition.
    expect(
      dodEvaluationSchema.safeParse({
        ...evaluation,
        results: [{ criterionKey: 'cube-test', passed: false, reason: 'Below strength' }],
      }).success,
    ).toBe(false);
    // Failing results with a failing verdict is coherent, and is the ordinary blocked case.
    expect(
      dodEvaluationSchema.safeParse({
        ...evaluation,
        mandatoryPassed: false,
        results: [{ criterionKey: 'cube-test', passed: false, reason: 'Below strength' }],
      }).success,
    ).toBe(true);
  });

  it('refuses an evaluation with no results at all', () => {
    expect(dodEvaluationSchema.safeParse({ ...evaluation, results: [] }).success).toBe(false);
  });
});

describe('Batch H certification independence', () => {
  const request: CertificationRequest = {
    id: 'cr-1',
    workspaceId: 'workspace-1',
    executionId: 'ge-1',
    milestoneId: 'gm-1',
    dodEvaluationId: 'de-1',
    requestedBy: 'user-requester',
    status: 'PENDING',
    reviewerIds: ['user-reviewer'],
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
  };

  it('refuses a requester who is among their own reviewers', () => {
    expect(certificationRequestSchema.safeParse(request).success).toBe(true);
    // Certification is where work becomes payable, so self-review is the shape of an unearned release.
    expect(
      certificationRequestSchema.safeParse({
        ...request,
        reviewerIds: ['user-reviewer', 'user-requester'],
      }).success,
    ).toBe(false);
  });

  it('refuses a request with no reviewer', () => {
    expect(certificationRequestSchema.safeParse({ ...request, reviewerIds: [] }).success).toBe(false);
  });
});

describe('Batch H execution and definition coherence', () => {
  const execution: Execution = {
    id: 'ge-1',
    workspaceId: 'workspace-1',
    contractId: 'c-1',
    title: 'Foundation package',
    ownerUserId: 'user-1',
    state: 'ACTIVE',
    startedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    version: 2,
  };

  it('refuses an execution that completed without starting', () => {
    expect(governedExecutionSchema.safeParse(execution).success).toBe(true);
    expect(
      governedExecutionSchema.safeParse({
        ...execution,
        state: 'COMPLETED',
        startedAt: undefined,
        completedAt: stamp,
      }).success,
    ).toBe(false);
  });

  it('pairs the completed state with the time it completed', () => {
    expect(governedExecutionSchema.safeParse({ ...execution, state: 'COMPLETED' }).success).toBe(false);
    expect(
      governedExecutionSchema.safeParse({ ...execution, state: 'COMPLETED', completedAt: stamp })
        .success,
    ).toBe(true);
    // An ACTIVE execution carrying a completion time is the same contradiction from the other side.
    expect(governedExecutionSchema.safeParse({ ...execution, completedAt: stamp }).success).toBe(false);
  });

  it('refuses a history entry that does not change the state', () => {
    const entry: ExecutionHistory = {
      id: 'eh-1',
      workspaceId: 'workspace-1',
      executionId: 'ge-1',
      fromState: 'PLANNED',
      toState: 'ACTIVE',
      actorId: 'user-1',
      reason: 'Site handover complete',
      sequence: 2,
      occurredAt: stamp,
    };
    expect(executionHistorySchema.safeParse(entry).success).toBe(true);
    expect(executionHistorySchema.safeParse({ ...entry, toState: 'PLANNED' }).success).toBe(false);
    // The creation record has no prior state, which is how a reader tells the first entry from the rest.
    expect(
      executionHistorySchema.safeParse({ ...entry, fromState: undefined, sequence: 1 }).success,
    ).toBe(true);
  });

  it('refuses duplicate criterion keys and an empty definition', () => {
    const criterion: DodCriterion = {
      key: 'cube-test',
      description: 'Cube test at 28 days',
      mandatory: true,
      evidenceRequirementKeys: ['lab-cert'],
      evaluationType: 'MANUAL',
    };
    const definition: DefinitionOfDoneVersion = {
      id: 'dv-1',
      workspaceId: 'workspace-1',
      milestoneId: 'gm-1',
      version: 1,
      status: 'DRAFT',
      criteria: [criterion],
      createdBy: 'user-1',
      createdAt: stamp,
      contentHash: 'a'.repeat(64),
    };
    expect(dodVersionSchema.safeParse(definition).success).toBe(true);
    expect(dodVersionSchema.safeParse({ ...definition, criteria: [] }).success).toBe(false);
    // A criterion key is how a result names what it evaluated, so two criteria sharing one make every
    // result about them ambiguous.
    expect(
      dodVersionSchema.safeParse({ ...definition, criteria: [criterion, { ...criterion }] }).success,
    ).toBe(false);
  });

  it('pairs publication with the time it happened', () => {
    const definition: DefinitionOfDoneVersion = {
      id: 'dv-1',
      workspaceId: 'workspace-1',
      milestoneId: 'gm-1',
      version: 1,
      status: 'PUBLISHED',
      criteria: [
        {
          key: 'cube-test',
          description: 'Cube test at 28 days',
          mandatory: true,
          evidenceRequirementKeys: ['lab-cert'],
          evaluationType: 'MANUAL',
        },
      ],
      createdBy: 'user-1',
      createdAt: stamp,
      publishedAt: stamp,
      contentHash: 'a'.repeat(64),
    };
    expect(dodVersionSchema.safeParse(definition).success).toBe(true);
    // A payment trigger names a definition as the standard a release turns on, so a publication with no
    // moment cannot be placed in the audit chain.
    expect(dodVersionSchema.safeParse({ ...definition, publishedAt: undefined }).success).toBe(false);
    expect(dodVersionSchema.safeParse({ ...definition, status: 'DRAFT' }).success).toBe(false);
  });

  it('refuses a self-parent and a self-dependency', () => {
    const milestone: MilestoneNode = {
      id: 'gm-1',
      workspaceId: 'workspace-1',
      executionId: 'ge-1',
      title: 'Slab complete',
      ownerUserId: 'user-1',
      state: 'PLANNED',
      durationDays: 10,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
    expect(governedMilestoneSchema.safeParse(milestone).success).toBe(true);
    expect(governedMilestoneSchema.safeParse({ ...milestone, parentMilestoneId: 'gm-1' }).success).toBe(
      false,
    );
    // Zero-day work is not a milestone.
    expect(governedMilestoneSchema.safeParse({ ...milestone, durationDays: 0 }).success).toBe(false);

    const dependency: MilestoneDependency = {
      id: 'md-1',
      workspaceId: 'workspace-1',
      executionId: 'ge-1',
      predecessorId: 'gm-1',
      successorId: 'gm-2',
      dependencyType: 'FINISH_TO_START',
      createdAt: stamp,
    };
    expect(milestoneDependencySchema.safeParse(dependency).success).toBe(true);
    // A milestone that cannot start until it finishes is a permanent block that reads as an ordinary one.
    expect(milestoneDependencySchema.safeParse({ ...dependency, successorId: 'gm-1' }).success).toBe(
      false,
    );
  });
});

describe('Batch H trigger definitions', () => {
  const trigger: PaymentTriggerDefinition = {
    id: 'ptd-1',
    workspaceId: 'workspace-1',
    milestoneId: 'gm-1',
    name: 'On certification',
    requiredDodDefinitionId: 'dv-1',
    certificationRequired: true,
    amountMinor: 5_000_000,
    currency: 'NGN',
    escrowProviderKey: 'partner-bank',
    status: 'ACTIVE',
    createdAt: stamp,
    version: 1,
  };

  it('requires a standard to check and an amount to release', () => {
    expect(paymentTriggerDefinitionSchema.safeParse(trigger).success).toBe(true);
    expect(paymentTriggerDefinitionSchema.safeParse({ ...trigger, amountMinor: 0 }).success).toBe(false);
    // A real currency that is not in the supported set, which is a stronger check than a nonsense code:
    // the allow-list has to refuse sterling because the platform is not configured for it, not merely
    // refuse strings that do not look like currencies.
    expect(paymentTriggerDefinitionSchema.safeParse({ ...trigger, currency: 'GBP' }).success).toBe(false);
  });

  it('allows no orchestrator, because AssuraPay has no fallback of its own', () => {
    // `createEscrowReleaseIntent` refuses `ESCROW_ORCHESTRATOR_NOT_CONFIGURED` rather than guessing. The
    // non-custody constraint means there is nothing to fall back to, so absence is a legitimate state.
    expect(
      paymentTriggerDefinitionSchema.safeParse({ ...trigger, escrowProviderKey: undefined }).success,
    ).toBe(true);
  });

  it('accepts a certificate and refuses one with a malformed canonical hash', () => {
    const certificate: DigitalCertificationRecord = {
      id: 'dcr-1',
      workspaceId: 'workspace-1',
      certificationRequestId: 'cr-1',
      milestoneId: 'gm-1',
      certificateNumber: 'AP-CERT-2026-000001',
      canonicalHash: 'b'.repeat(64),
      status: 'CERTIFIED',
      issuedBy: 'user-1',
      issuedAt: stamp,
    };
    expect(digitalCertificationRecordSchema.safeParse(certificate).success).toBe(true);
    // The hash is what makes the certificate verifiable; a short one is not a digest.
    expect(
      digitalCertificationRecordSchema.safeParse({ ...certificate, canonicalHash: 'abc' }).success,
    ).toBe(false);
  });

  it('requires a decision to carry a rationale', () => {
    const decision: CertificationDecision = {
      id: 'cd-1',
      workspaceId: 'workspace-1',
      certificationRequestId: 'cr-1',
      reviewerId: 'user-reviewer',
      decision: 'APPROVE',
      rationale: 'Evidence complete and consistent',
      evidenceReferences: ['lab-cert-1'],
      decidedAt: stamp,
    };
    expect(certificationDecisionSchema.safeParse(decision).success).toBe(true);
    // This record is the evidence a certification was considered rather than waved through.
    expect(certificationDecisionSchema.safeParse({ ...decision, rationale: '' }).success).toBe(false);
  });
});

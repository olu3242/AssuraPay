import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  agreementSchema,
  approvalDecisionSchema,
  approvalPolicySchema,
  approvalRequestSchema,
  clauseDeviationSchema,
  clauseInstanceSchema,
  clauseVersionSchema,
  contractCommentSchema,
  contractDraftSchema,
  documentVersionSchema,
  executionCertificateSchema,
  negotiationRoundSchema,
  signatureCallbackSchema,
  signaturePackageSchema,
  templateVersionSchema,
  BATCH_F_AGGREGATES,
  BATCH_F_UNREACHED_STATES,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  Agreement,
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequest,
  ClauseDeviation,
  ClauseInstance,
  ClauseVersion,
  ContractComment,
  ContractDraft,
  DocumentVersion,
  ExecutionCertificate,
  NegotiationRound,
  SignatureCallback,
  SignaturePackage,
  TemplateVersion,
} from './index';

/**
 * Compile-time proof that this package's fifteen Batch F domain types and their canonical Zod schemas
 * describe the same shape, plus the rules those schemas enforce.
 *
 * Fifteen proofs for fifteen aggregates, with no exemption — which is why `SignatureCallback` is now a
 * named type. It was an inline object literal passed to `append`, and an aggregate with no type has
 * nothing to prove a schema against.
 *
 * Five cross-row invariants are deliberately absent, and `BATCH_F_UNENFORCED_INVARIANTS` names each one
 * with the reason. Four of the five are "the cited parent must currently be in state X" — a rule no
 * single-record schema can express and no foreign key can either, because the parent's state changes
 * after the child is written and, in the approval case, `invalidateOnChange` exists precisely to change
 * it. The fifth is the mutual reference between a draft and its document version.
 *
 * What a schema *can* carry, it does. `sha256Hex` on seven digest fields, the LIBRARY/CUSTOM pairing on
 * a clause instance, and the witness ordering on a signer are all single-record rules, so they are
 * enforced here rather than described in a comment.
 */

export const agreementSchemaConforms: SchemaMatchesType<z.infer<typeof agreementSchema>, Agreement> =
  true;

export const templateVersionSchemaConforms: SchemaMatchesType<
  z.infer<typeof templateVersionSchema>,
  TemplateVersion
> = true;

export const documentVersionSchemaConforms: SchemaMatchesType<
  z.infer<typeof documentVersionSchema>,
  DocumentVersion
> = true;

export const contractDraftSchemaConforms: SchemaMatchesType<
  z.infer<typeof contractDraftSchema>,
  ContractDraft
> = true;

export const contractCommentSchemaConforms: SchemaMatchesType<
  z.infer<typeof contractCommentSchema>,
  ContractComment
> = true;

export const clauseVersionSchemaConforms: SchemaMatchesType<
  z.infer<typeof clauseVersionSchema>,
  ClauseVersion
> = true;

export const clauseInstanceSchemaConforms: SchemaMatchesType<
  z.infer<typeof clauseInstanceSchema>,
  ClauseInstance
> = true;

export const clauseDeviationSchemaConforms: SchemaMatchesType<
  z.infer<typeof clauseDeviationSchema>,
  ClauseDeviation
> = true;

export const negotiationRoundSchemaConforms: SchemaMatchesType<
  z.infer<typeof negotiationRoundSchema>,
  NegotiationRound
> = true;

export const approvalPolicySchemaConforms: SchemaMatchesType<
  z.infer<typeof approvalPolicySchema>,
  ApprovalPolicy
> = true;

export const approvalRequestSchemaConforms: SchemaMatchesType<
  z.infer<typeof approvalRequestSchema>,
  ApprovalRequest
> = true;

export const approvalDecisionSchemaConforms: SchemaMatchesType<
  z.infer<typeof approvalDecisionSchema>,
  ApprovalDecision
> = true;

export const signaturePackageSchemaConforms: SchemaMatchesType<
  z.infer<typeof signaturePackageSchema>,
  SignaturePackage
> = true;

export const signatureCallbackSchemaConforms: SchemaMatchesType<
  z.infer<typeof signatureCallbackSchema>,
  SignatureCallback
> = true;

export const executionCertificateSchemaConforms: SchemaMatchesType<
  z.infer<typeof executionCertificateSchema>,
  ExecutionCertificate
> = true;

const stamp = '2026-08-11T09:00:00.000Z';
const digest = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('the digest fields are digests, not free text', () => {
  const version = {
    id: 'tv-1',
    workspaceId: 'ws-1',
    templateKey: 'vendor',
    version: 1,
    variableSchema: [{ key: 'vendor', required: true }],
    contentHash: digest,
    status: 'DRAFT' as const,
    createdBy: 'u-1',
    createdAt: stamp,
  };

  it('accepts a lower-case hexadecimal SHA-256 digest', () => {
    expect(templateVersionSchema.safeParse(version).success).toBe(true);
  });

  it('refuses anything that is not one', () => {
    // Every hash in this package comes from one `createHash('sha256')...digest('hex')` helper or is
    // copied from a field that did, so a value of any other shape is a defect rather than a variant.
    // Free text here would make the citation "this is the document that was approved" unverifiable.
    for (const contentHash of [
      '',
      'a3f1c9',
      digest.toUpperCase(),
      `${digest}a`,
      digest.slice(0, 63),
      `${'z'.repeat(64)}`,
    ]) {
      expect(
        templateVersionSchema.safeParse({ ...version, contentHash }).success,
        contentHash.slice(0, 12),
      ).toBe(false);
    }
  });

  it('accepts a template with no variables, which is a fixed-text template', () => {
    // `submit` checks required variables over this list, and that check passing on an empty list is the
    // correct outcome rather than a hole.
    expect(templateVersionSchema.safeParse({ ...version, variableSchema: [] }).success).toBe(true);
  });
});

describe('the agreement schema carries the whole declared lifecycle', () => {
  const agreement = {
    id: 'ag-1',
    workspaceId: 'ws-1',
    contractNumber: 'AP-2026-1',
    title: 'Vendor Agreement',
    contractType: 'DATA',
    ownerUserId: 'u-1',
    status: 'DRAFT' as const,
    createdAt: stamp,
    version: 1,
  };

  it('accepts every declared state, including the six no engine writes', () => {
    // Narrowing the schema to `DRAFT` — the only state `create` writes — would make it wrong the moment
    // the transitions are implemented, and would put the persistence layer in the position of deciding
    // what the contract lifecycle is.
    for (const status of [
      'DRAFT',
      'NEGOTIATION',
      'AWAITING_APPROVAL',
      'APPROVED',
      'AWAITING_SIGNATURE',
      'PARTIALLY_SIGNED',
      'EXECUTED',
    ]) {
      expect(agreementSchema.safeParse({ ...agreement, status }).success, status).toBe(true);
    }
    expect(agreementSchema.safeParse({ ...agreement, status: 'CANCELLED' }).success).toBe(false);
  });

  it('records which of those states nothing reaches', () => {
    // The record is what stops the next reader assuming a state is reachable and making it terminal.
    expect(BATCH_F_UNREACHED_STATES.agreements).toEqual([
      'NEGOTIATION',
      'AWAITING_APPROVAL',
      'APPROVED',
      'AWAITING_SIGNATURE',
      'PARTIALLY_SIGNED',
      'EXECUTED',
    ]);
    // Every collection named must be one this batch owns, and no state may be listed twice. Without
    // this the record can name an aggregate that moved batches, or a state that no longer exists, and
    // keep reading as though it were still describing something.
    for (const [collection, states] of Object.entries(BATCH_F_UNREACHED_STATES)) {
      expect(
        BATCH_F_AGGREGATES.some((entry) => entry.collection === collection),
        collection,
      ).toBe(true);
      expect(states.length, collection).toBeGreaterThan(0);
      expect(new Set(states).size, collection).toBe(states.length);
    }
  });

  it('refuses a revision below one, or a fractional one', () => {
    for (const version of [0, -1, 1.5]) {
      expect(agreementSchema.safeParse({ ...agreement, version }).success, String(version)).toBe(
        false,
      );
    }
  });
});

describe('the draft and document schemas keep a lineage reconstructible', () => {
  const document = {
    id: 'dv-2',
    workspaceId: 'ws-1',
    contractId: 'ag-1',
    draftId: 'dr-1',
    number: 2,
    contentReference: 'draft/2',
    contentHash: digest,
    status: 'DRAFT' as const,
    createdBy: 'u-1',
    createdAt: stamp,
    supersedesId: 'dv-1',
    aiProposed: false,
  };

  it('accepts a first version with no predecessor and a revision with one', () => {
    const { supersedesId: _omitted, ...first } = document;
    expect(documentVersionSchema.safeParse({ ...first, number: 1 }).success).toBe(true);
    expect(documentVersionSchema.safeParse(document).success).toBe(true);
  });

  it('refuses an unknown field, so a renamed column cannot slip through as an extra', () => {
    // `.strict()` matters most for this batch: four of these aggregates have a column whose name differs
    // from its field, and the repository is the only place the two vocabularies may meet. A schema that
    // ignored unknown keys would accept `version` alongside `number` and store neither reliably.
    expect(documentVersionSchema.safeParse({ ...document, version: 2 }).success).toBe(false);
  });

  const draft = {
    id: 'dr-1',
    workspaceId: 'ws-1',
    contractId: 'ag-1',
    templateVersionId: 'tv-1',
    documentVersionId: 'dv-1',
    status: 'WORKING' as const,
    variables: { vendor: 'Fictional Data Ltd' },
    createdBy: 'u-1',
    createdAt: stamp,
    version: 1,
  };

  it('accepts a working draft with no locker and a locked one with a locker', () => {
    expect(contractDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      contractDraftSchema.safeParse({ ...draft, status: 'LOCKED', lockedBy: 'u-2' }).success,
    ).toBe(true);
    // `lock` never clears `lockedBy`, so a submitted draft still records who locked it. The implication
    // runs one way, and the migration's column constraint says the same: LOCKED requires a locker, a
    // locker does not require LOCKED.
    expect(
      contractDraftSchema.safeParse({ ...draft, status: 'SUBMITTED', lockedBy: 'u-2' }).success,
    ).toBe(true);
  });

  it('accepts an empty variable map, which is what a new draft has', () => {
    expect(contractDraftSchema.safeParse({ ...draft, variables: {} }).success).toBe(true);
  });
});

describe('the clause schemas tie a source to its citation', () => {
  const instance = {
    id: 'ci-1',
    workspaceId: 'ws-1',
    draftId: 'dr-1',
    clauseVersionId: 'cv-1',
    bodyHash: digest,
    source: 'LIBRARY' as const,
    createdAt: stamp,
  };

  it('accepts the two pairings `insert` produces', () => {
    expect(clauseInstanceSchema.safeParse(instance).success).toBe(true);
    const { clauseVersionId: _omitted, ...custom } = instance;
    expect(clauseInstanceSchema.safeParse({ ...custom, source: 'CUSTOM' }).success).toBe(true);
  });

  it('refuses the two it does not', () => {
    // A LIBRARY clause with no citation claims a published baseline it cannot name; a CUSTOM clause with
    // one claims a baseline it deliberately departed from. Both would make deviation analysis wrong.
    const { clauseVersionId: _omitted, ...uncited } = instance;
    expect(clauseInstanceSchema.safeParse(uncited).success).toBe(false);
    expect(clauseInstanceSchema.safeParse({ ...instance, source: 'CUSTOM' }).success).toBe(false);
  });

  it('carries the four risk grades and refuses a fifth', () => {
    const deviation = {
      id: 'cd-1',
      workspaceId: 'ws-1',
      instanceId: 'ci-1',
      baselineVersionId: 'cv-1',
      risk: 'CRITICAL' as const,
      summary: 'Liability cap removed',
      status: 'PENDING' as const,
      createdAt: stamp,
    };
    for (const risk of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      expect(clauseDeviationSchema.safeParse({ ...deviation, risk }).success, risk).toBe(true);
    }
    expect(clauseDeviationSchema.safeParse({ ...deviation, risk: 'SEVERE' }).success).toBe(false);
    expect(clauseDeviationSchema.safeParse({ ...deviation, summary: '   ' }).success).toBe(false);
  });

  it('refuses a blank internal guidance reference', () => {
    const version = {
      id: 'cv-1',
      workspaceId: 'ws-1',
      clauseKey: 'liability',
      version: 1,
      bodyHash: digest,
      risk: 'HIGH' as const,
      guidance: 'Escalate to general counsel above ₦50m exposure',
      status: 'PUBLISHED' as const,
      createdAt: stamp,
    };
    expect(clauseVersionSchema.safeParse(version).success).toBe(true);
    expect(clauseVersionSchema.safeParse({ ...version, guidance: '' }).success).toBe(false);
  });
});

describe('the approval schemas keep authority answerable', () => {
  const policy = {
    id: 'ap-1',
    workspaceId: 'ws-1',
    version: 1,
    steps: [{ role: 'LEGAL', minimumAssurance: 'IAL2_VERIFIED' as const }],
    status: 'PUBLISHED' as const,
    createdAt: stamp,
  };

  it('refuses a policy with no steps, which would approve on creation', () => {
    // `every`/`length` semantics again: a request routed against an empty policy has
    // `completedSteps === steps.length` from the start.
    expect(approvalPolicySchema.safeParse(policy).success).toBe(true);
    expect(approvalPolicySchema.safeParse({ ...policy, steps: [] }).success).toBe(false);
  });

  it('refuses an assurance level below the lowest the engine compares against', () => {
    // `decide` grades IAL0_UNVERIFIED as zero, so a step demanding it demands nothing.
    expect(
      approvalPolicySchema.safeParse({
        ...policy,
        steps: [{ role: 'LEGAL', minimumAssurance: 'IAL0_UNVERIFIED' }],
      }).success,
    ).toBe(false);
  });

  const request = {
    id: 'ar-1',
    workspaceId: 'ws-1',
    contractId: 'ag-1',
    documentVersionId: 'dv-1',
    documentHash: digest,
    policyId: 'ap-1',
    requesterId: 'u-1',
    status: 'PENDING' as const,
    completedSteps: 0,
    createdAt: stamp,
  };

  it('starts at zero completed steps, so the count permits zero and the revision does not', () => {
    expect(approvalRequestSchema.safeParse(request).success).toBe(true);
    expect(approvalRequestSchema.safeParse({ ...request, completedSteps: -1 }).success).toBe(false);
    expect(approvalPolicySchema.safeParse({ ...policy, version: 0 }).success).toBe(false);
  });

  it('accepts an unconditional decision and refuses a blank condition', () => {
    const decision = {
      id: 'ad-1',
      workspaceId: 'ws-1',
      requestId: 'ar-1',
      step: 0,
      approverId: 'u-2',
      decision: 'APPROVE' as const,
      conditions: [] as string[],
      createdAt: stamp,
    };
    expect(approvalDecisionSchema.safeParse(decision).success).toBe(true);
    expect(approvalDecisionSchema.safeParse({ ...decision, conditions: ['  '] }).success).toBe(false);
    // The step index is zero-based, taken from the request's `completedSteps`.
    expect(approvalDecisionSchema.safeParse({ ...decision, step: -1 }).success).toBe(false);
  });
});

describe('the signature schemas keep an execution recomputable', () => {
  const signer = {
    userId: 'u-3',
    authorityReference: 'board-resolution-14',
    witnessRequired: true,
    signedAt: stamp,
    witnessedAt: '2026-08-11T09:05:00.000Z',
  };
  const pack = {
    id: 'sp-1',
    workspaceId: 'ws-1',
    contractId: 'ag-1',
    approvalRequestId: 'ar-1',
    documentVersionId: 'dv-1',
    documentHash: digest,
    signers: [signer],
    status: 'SENT' as const,
    providerKey: 'sandbox',
    createdAt: stamp,
  };

  it('refuses a package with no signers, which would complete immediately', () => {
    // `signers.every(...)` over an empty list is true, so an empty package is COMPLETED on arrival and
    // `issue` would mint an execution certificate for a document nobody signed.
    expect(signaturePackageSchema.safeParse(pack).success).toBe(true);
    expect(signaturePackageSchema.safeParse({ ...pack, signers: [] }).success).toBe(false);
  });

  it('refuses a signer with no cited authority to sign', () => {
    expect(
      signaturePackageSchema.safeParse({
        ...pack,
        signers: [{ ...signer, authorityReference: '' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a signature witnessed before it was made', () => {
    // `callback` writes `witnessedAt` only against a signer, and completion needs `signedAt` for every
    // signer. A witnessed-but-unsigned signer is a state no engine produces and one that would make the
    // completion test read as satisfied for the wrong reason.
    const { signedAt: _omitted, ...unsigned } = signer;
    expect(signaturePackageSchema.safeParse({ ...pack, signers: [unsigned] }).success).toBe(false);
    // An unsigned, unwitnessed signer is the normal state of a package that has just been sent.
    const { witnessedAt: _also, ...pending } = unsigned;
    expect(signaturePackageSchema.safeParse({ ...pack, signers: [pending] }).success).toBe(true);
  });

  it('requires both digests on a certificate', () => {
    const certificate = {
      id: 'ec-1',
      workspaceId: 'ws-1',
      packageId: 'sp-1',
      contractId: 'ag-1',
      documentHash: digest,
      canonicalHash: other,
      status: 'VALID' as const,
      issuedAt: stamp,
    };
    expect(executionCertificateSchema.safeParse(certificate).success).toBe(true);
    expect(executionCertificateSchema.safeParse({ ...certificate, canonicalHash: 'x' }).success).toBe(
      false,
    );
    expect(executionCertificateSchema.safeParse({ ...certificate, documentHash: '' }).success).toBe(
      false,
    );
  });

  it('takes a provider event identifier as required text rather than a digest', () => {
    // Not `sha256Hex`: the value is the provider's, and constraining its shape would refuse a
    // legitimate provider whose identifiers are not hex digests.
    const callback = { id: 'sc-1', workspaceId: 'ws-1', eventId: 'evt_9f2', createdAt: stamp };
    expect(signatureCallbackSchema.safeParse(callback).success).toBe(true);
    expect(signatureCallbackSchema.safeParse({ ...callback, eventId: '' }).success).toBe(false);
  });
});

describe('the Batch F registry', () => {
  it('covers fifteen aggregates across canonical Engines 11-15', () => {
    expect(BATCH_F_AGGREGATES).toHaveLength(15);
    expect([...new Set(BATCH_F_AGGREGATES.map((entry) => entry.engine))].sort()).toEqual([
      '11',
      '12',
      '13',
      '14',
      '15',
    ]);
  });

  it('names a distinct table for every collection', () => {
    // A repeated table would mean two aggregates writing over each other, and the failure would surface
    // as absence rather than as an error.
    const tables = BATCH_F_AGGREGATES.map((entry) => entry.table);
    expect(new Set(tables).size).toBe(tables.length);
    const collections = BATCH_F_AGGREGATES.map((entry) => entry.collection);
    expect(new Set(collections).size).toBe(collections.length);
  });
});

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  disputeDecisionSchema,
  disputeEvidenceSchema,
  disputeHoldSchema,
  disputePositionSchema,
  disputeSchema,
} from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type {
  Dispute,
  DisputeDecision,
  DisputeEvidence,
  DisputeHold,
  DisputePosition,
} from './index';

/**
 * Compile-time proof that this package's Batch D domain types and their canonical Zod schemas
 * describe the same shape, plus the rules those schemas enforce.
 *
 * **Hold enforcement is deliberately not tested here, because it cannot be.** Whether a hold blocks a
 * release is a property of two tables: the hold, and the release request or payment instruction it
 * blocks. No single-record schema can express it, so it is enforced by the triggers `202608110002`
 * adds at three points and proved against a live database in
 * `packages/database-testing/src/wave5-batch-d-repository.postgres.test.ts`.
 *
 * That is the third time this division has been drawn — segregation of duties in Batch B, journal
 * balance in Batch C, hold enforcement here — and it is the same rule each time: a cross-row
 * invariant asserted only in a unit test would be asserted in the one place it cannot hold.
 *
 * What *is* testable here is a hold's internal consistency, which is single-row.
 */

export const disputeSchemaConforms: SchemaMatchesType<z.infer<typeof disputeSchema>, Dispute> = true;

export const disputeEvidenceSchemaConforms: SchemaMatchesType<
  z.infer<typeof disputeEvidenceSchema>,
  DisputeEvidence
> = true;

export const disputePositionSchemaConforms: SchemaMatchesType<
  z.infer<typeof disputePositionSchema>,
  DisputePosition
> = true;

export const disputeDecisionSchemaConforms: SchemaMatchesType<
  z.infer<typeof disputeDecisionSchema>,
  DisputeDecision
> = true;

export const disputeHoldSchemaConforms: SchemaMatchesType<
  z.infer<typeof disputeHoldSchema>,
  DisputeHold
> = true;

const stamp = '2026-08-11T09:00:00.000Z';

describe('the dispute schema keeps a dispute attached to what it disputes', () => {
  const dispute = {
    id: 'dsp-1',
    workspaceId: 'ws-1',
    releaseRequestId: 'rr-1',
    kind: 'PAYMENT_DISPUTE' as const,
    description: 'Beneficiary disputes the settled amount against the accepted milestone',
    status: 'OPEN' as const,
    raisedBy: 'u-raiser',
    createdAt: stamp,
  };

  it('accepts every state the engine moves a dispute through', () => {
    for (const status of ['OPEN', 'MEDIATION', 'DECIDED', 'APPEALED', 'CLOSED']) {
      expect(disputeSchema.safeParse({ ...dispute, status }).success, status).toBe(true);
    }
  });

  it('refuses a dispute with no release request and no description', () => {
    // A dispute that names nothing blocks nothing, and a hold is placed against the release request
    // this field names.
    expect(disputeSchema.safeParse({ ...dispute, releaseRequestId: '' }).success).toBe(false);
    expect(disputeSchema.safeParse({ ...dispute, description: '   ' }).success).toBe(false);
  });

  it('refuses an unknown kind, an unknown status and an unknown field', () => {
    expect(disputeSchema.safeParse({ ...dispute, kind: 'COMPLAINT' }).success).toBe(false);
    expect(disputeSchema.safeParse({ ...dispute, status: 'WITHDRAWN' }).success).toBe(false);
    expect(disputeSchema.safeParse({ ...dispute, resolvedAmountMinor: 1 }).success).toBe(false);
  });
});

describe('the evidence, position and decision schemas keep the record answerable', () => {
  it('requires evidence to name an artefact and describe it', () => {
    const evidence = {
      id: 'de-1',
      workspaceId: 'ws-1',
      disputeId: 'dsp-1',
      reference: 'EVIDENCE-PACK-77',
      description: 'Signed acceptance certificate for the disputed milestone',
      submittedBy: 'u-submitter',
      submittedAt: stamp,
    };
    expect(disputeEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(disputeEvidenceSchema.safeParse({ ...evidence, reference: '' }).success).toBe(false);
    expect(disputeEvidenceSchema.safeParse({ ...evidence, description: ' ' }).success).toBe(false);
  });

  it('requires a position to come from a party and say something', () => {
    const position = {
      id: 'dp-1',
      workspaceId: 'ws-1',
      disputeId: 'dsp-1',
      partyId: 'party-1',
      position: 'The retention was applied twice',
      submittedAt: stamp,
    };
    expect(disputePositionSchema.safeParse(position).success).toBe(true);
    expect(disputePositionSchema.safeParse({ ...position, partyId: '' }).success).toBe(false);
    expect(disputePositionSchema.safeParse({ ...position, position: '\t' }).success).toBe(false);
  });

  it('requires a decision to carry its rationale', () => {
    const decision = {
      id: 'dd-1',
      workspaceId: 'ws-1',
      disputeId: 'dsp-1',
      decision: 'PARTIAL' as const,
      rationale: 'Retention correctly applied once; the duplicate line is reversed',
      decidedBy: 'u-adjudicator',
      decidedAt: stamp,
    };
    expect(disputeDecisionSchema.safeParse(decision).success).toBe(true);
    // An appeal is decided against the reasoning, not the outcome, so a blank rationale leaves an
    // appeal nothing to test.
    expect(disputeDecisionSchema.safeParse({ ...decision, rationale: '  ' }).success).toBe(false);
    expect(disputeDecisionSchema.safeParse({ ...decision, decision: 'DISMISSED' }).success).toBe(
      false,
    );
  });
});

describe('the hold schema keeps a hold internally consistent', () => {
  const active = {
    id: 'dh-1',
    workspaceId: 'ws-1',
    disputeId: 'dsp-1',
    releaseRequestId: 'rr-1',
    active: true,
    placedAt: stamp,
  };

  it('accepts an active hold with no release time, and a released one with it', () => {
    expect(disputeHoldSchema.safeParse(active).success).toBe(true);
    expect(
      disputeHoldSchema.safeParse({ ...active, active: false, releasedAt: stamp }).success,
    ).toBe(true);
  });

  it('refuses a released hold with no time, and an active hold that claims one', () => {
    // Without this, a hold could be deactivated with no record of when the block was lifted, and the
    // audit chain could not say how long money was held.
    expect(disputeHoldSchema.safeParse({ ...active, active: false }).success).toBe(false);
    expect(disputeHoldSchema.safeParse({ ...active, releasedAt: stamp }).success).toBe(false);
  });

  it('refuses a hold that names no dispute or no release request', () => {
    // A hold with no dispute behind it is a block nobody raised; a hold naming no release request
    // blocks nothing while reading as protection in place.
    expect(disputeHoldSchema.safeParse({ ...active, disputeId: '' }).success).toBe(false);
    expect(disputeHoldSchema.safeParse({ ...active, releaseRequestId: '' }).success).toBe(false);
  });
});

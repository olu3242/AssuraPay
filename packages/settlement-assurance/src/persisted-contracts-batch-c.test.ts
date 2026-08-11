import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { fundReservationSchema, fundingCommitmentSchema } from '@assurapay/domain-contracts';
import type { SchemaMatchesType } from '@assurapay/domain-contracts';
import type { FundReservation, FundingCommitment } from './index';

/**
 * Compile-time proof that this package's Batch C domain types and their canonical Zod schemas
 * describe the same shape, plus the rules those schemas enforce.
 *
 * These are Engine 44's aggregates. Their *tables* were converged by `202608100002` because Batch
 * B's foreign-key closure could not be converted in parts; this file is part of what actually
 * activates them — until now they had no schema, no repository and no route.
 */

export const fundingCommitmentSchemaConforms: SchemaMatchesType<
  z.infer<typeof fundingCommitmentSchema>,
  FundingCommitment
> = true;

export const fundReservationSchemaConforms: SchemaMatchesType<
  z.infer<typeof fundReservationSchema>,
  FundReservation
> = true;

const stamp = '2026-08-11T09:00:00.000Z';

describe('the funding-commitment schema keeps custody external', () => {
  const commitment = {
    id: 'fc-1',
    workspaceId: 'ws-1',
    milestoneId: 'ms-1',
    providerKey: 'partner-bank',
    externalCustodyReference: 'CUSTODY-99001',
    committedAmountMinor: 2_000_000,
    currency: 'NGN',
    status: 'PENDING_CONFIRMATION' as const,
    createdAt: stamp,
  };

  it('accepts a pending commitment and a confirmed one carrying its reference', () => {
    expect(fundingCommitmentSchema.safeParse(commitment).success).toBe(true);
    expect(
      fundingCommitmentSchema.safeParse({
        ...commitment,
        status: 'CONFIRMED',
        providerConfirmationReference: 'CONF-1',
        confirmedAt: stamp,
      }).success,
    ).toBe(true);
  });

  it('refuses a blank external custody reference', () => {
    // Non-custody rests on this field naming somebody else's ledger. A commitment with no external
    // reference is a commitment whose funds have no recorded custodian, which is the shape of
    // AssuraPay holding them.
    for (const externalCustodyReference of ['', '   ']) {
      expect(
        fundingCommitmentSchema.safeParse({ ...commitment, externalCustodyReference }).success,
        JSON.stringify(externalCustodyReference),
      ).toBe(false);
    }
  });

  it('refuses a zero commitment, an unsupported currency and a fractional amount', () => {
    expect(
      fundingCommitmentSchema.safeParse({ ...commitment, committedAmountMinor: 0 }).success,
    ).toBe(false);
    expect(fundingCommitmentSchema.safeParse({ ...commitment, currency: 'GBP' }).success).toBe(
      false,
    );
    expect(
      fundingCommitmentSchema.safeParse({ ...commitment, committedAmountMinor: 1_000.5 }).success,
    ).toBe(false);
  });

  it('refuses an unknown status and an unknown field', () => {
    expect(fundingCommitmentSchema.safeParse({ ...commitment, status: 'SETTLED' }).success).toBe(
      false,
    );
    // `.strict()`, so a field the domain type does not declare cannot ride along into the row.
    expect(
      fundingCommitmentSchema.safeParse({ ...commitment, internalBalanceMinor: 1 }).success,
    ).toBe(false);
  });
});

describe('the fund-reservation schema reserves something against something', () => {
  const reservation = {
    id: 'fr-1',
    workspaceId: 'ws-1',
    fundingCommitmentId: 'fc-1',
    invoiceId: 'inv-1',
    reservedAmountMinor: 925_000,
    status: 'RESERVED' as const,
    createdAt: stamp,
  };

  it('accepts a well-formed reservation', () => {
    expect(fundReservationSchema.safeParse(reservation).success).toBe(true);
  });

  it('refuses a zero reservation and a missing parent', () => {
    expect(fundReservationSchema.safeParse({ ...reservation, reservedAmountMinor: 0 }).success).toBe(
      false,
    );
    expect(
      fundReservationSchema.safeParse({ ...reservation, fundingCommitmentId: '' }).success,
    ).toBe(false);
    expect(fundReservationSchema.safeParse({ ...reservation, invoiceId: '' }).success).toBe(false);
  });
});

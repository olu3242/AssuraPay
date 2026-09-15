import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_INTAKE_COLLECTIONS,
  AGREEMENT_INTAKE_TABLES,
  isAgreementIntakeCollection,
} from './index';

describe('agreement intake PostgreSQL routing', () => {
  it('registers the engine collection and dedicated table', () => {
    expect(AGREEMENT_INTAKE_COLLECTIONS).toEqual(['agreementIntakes']);
    expect(AGREEMENT_INTAKE_TABLES).toEqual(['agreement_intakes']);
    expect(isAgreementIntakeCollection('agreementIntakes')).toBe(true);
    expect(isAgreementIntakeCollection('agreements')).toBe(false);
  });
});

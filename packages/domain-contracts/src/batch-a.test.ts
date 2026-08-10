import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BATCH_A_AGGREGATES,
  BATCH_A_COLLECTIONS,
  BATCH_A_SCHEMA_VERSION,
  BATCH_A_TABLES,
  batchAContract,
  describeSchemaFailure,
} from './batch-a';
import {
  calendarDate,
  identifier,
  instant,
  minorUnits,
  requiredText,
} from './primitives';

/**
 * The registry's own invariants, and the primitives every schema is built from.
 *
 * The per-aggregate shape assertions live with the packages that own the domain types — a
 * conformance proof has to see both definitions, and this package must not import an engine. What
 * is tested here is what only this package can be wrong about: whether the registry is internally
 * consistent, and whether the shared primitives enforce what their documentation claims.
 */

describe('the Batch A registry describes sixteen aggregates once each', () => {
  it('names sixteen collections and sixteen tables, with no duplicates', () => {
    expect(BATCH_A_AGGREGATES).toHaveLength(16);
    expect(new Set(BATCH_A_COLLECTIONS).size).toBe(16);
    expect(new Set(BATCH_A_TABLES).size).toBe(16);
  });

  it('resolves every collection to its own contract, and refuses a stranger', () => {
    for (const aggregate of BATCH_A_AGGREGATES) {
      const contract = batchAContract(aggregate.collection);
      expect(contract, aggregate.collection).toBe(aggregate);
    }
    // `trust_records` collections are not Batch A's, and a registry that answered for them would
    // route a trust aggregate to a domain table.
    expect(batchAContract('identities')).toBeUndefined();
    expect(batchAContract('trustWorkspaces')).toBeUndefined();
  });

  it('lists parents before children, so a replay satisfies its foreign keys', () => {
    // Foreign keys make the order load-bearing: work items reference execution workspaces,
    // progress records reference work items, corrective action plans reference issue records, and
    // completion certificates reference acceptance decisions.
    const position = (collection: string) =>
      BATCH_A_COLLECTIONS.indexOf(collection);
    for (const [child, parent] of [
      ['workItems', 'executionWorkspaces'],
      ['progressRecords', 'workItems'],
      ['evidencePackages', 'workItems'],
      ['validationTests', 'evidencePackages'],
      ['correctiveActionPlans', 'issueRecords'],
      ['completionCertificates', 'acceptanceDecisions'],
    ]) {
      expect(position(parent), `${parent} before ${child}`).toBeLessThan(
        position(child),
      );
    }
  });

  it('stamps every aggregate at the same schema version', () => {
    // Legacy readers parse by version, so a registry with two versions in it means two parsing
    // rules for one batch and no way to tell which applies.
    for (const aggregate of BATCH_A_AGGREGATES)
      expect(aggregate.schemaVersion, aggregate.collection).toBe(
        BATCH_A_SCHEMA_VERSION,
      );
  });

  it('maps every aggregate to a canonical engine in 31–40', () => {
    for (const aggregate of BATCH_A_AGGREGATES) {
      const engine = Number(aggregate.engine);
      expect(engine, aggregate.collection).toBeGreaterThanOrEqual(31);
      expect(engine, aggregate.collection).toBeLessThanOrEqual(40);
    }
  });

  it('rejects an empty object for every schema, so none of them is permissive by accident', () => {
    for (const aggregate of BATCH_A_AGGREGATES)
      expect(aggregate.schema.safeParse({}).success, aggregate.collection).toBe(
        false,
      );
  });
});

describe('a schema failure is described without the value that failed', () => {
  it('reports paths and issue codes only', () => {
    // These records carry evidence references, actor identities and narrative text, and the
    // standing constraint is that raw payloads never reach a log or an error. A Zod message
    // quotes the offending value; this must not.
    const schema = z
      .object({ severity: z.enum(['MINOR', 'MAJOR']), notes: z.string() })
      .strict();
    const result = schema.safeParse({ severity: 'token-abcdef', notes: 42 });
    expect(result.success).toBe(false);
    const described = result.success ? '' : describeSchemaFailure(result.error);
    expect(described).toContain('severity:invalid_enum_value');
    expect(described).toContain('notes:invalid_type');
    expect(described).not.toContain('token-abcdef');
  });

  it('bounds how much it reports, so one bad record cannot flood a log', () => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let index = 0; index < 20; index += 1)
      shape[`field${index}`] = z.string();
    const result = z.object(shape).safeParse({});
    const described = result.success ? '' : describeSchemaFailure(result.error);
    expect(described.split(', ')).toHaveLength(8);
  });

  it('names the root when the failure is not on a field', () => {
    const result = z.object({ a: z.string() }).safeParse('not an object');
    const described = result.success ? '' : describeSchemaFailure(result.error);
    expect(described).toBe('<root>:invalid_type');
  });
});

describe('the primitives enforce the bounds their documentation claims', () => {
  it('bounds an identifier to what the database CHECK permits', () => {
    // `CHECK (length(...) BETWEEN 1 AND 200)`, from 202608090001. A schema that permitted more
    // would turn a validation pass into a write failure.
    expect(identifier.safeParse('a').success).toBe(true);
    expect(identifier.safeParse('a'.repeat(200)).success).toBe(true);
    expect(identifier.safeParse('').success).toBe(false);
    expect(identifier.safeParse('a'.repeat(201)).success).toBe(false);
  });

  it('accepts the instant the engines actually produce, and refuses a zoneless one', () => {
    expect(instant.safeParse(new Date().toISOString()).success).toBe(true);
    expect(instant.safeParse('2026-08-10T09:00:00.000Z').success).toBe(true);
    expect(instant.safeParse('2026-08-10 09:00:00').success).toBe(false);
    expect(instant.safeParse('2026-08-10').success).toBe(false);
  });

  it('accepts only a real calendar date', () => {
    expect(calendarDate.safeParse('2026-08-10').success).toBe(true);
    expect(calendarDate.safeParse('2024-02-29').success).toBe(true);
    expect(calendarDate.safeParse('2026-02-30').success).toBe(false);
    expect(calendarDate.safeParse('2026-8-10').success).toBe(false);
    expect(calendarDate.safeParse('2026-08-10T00:00:00.000Z').success).toBe(
      false,
    );
  });

  it('accepts integer minor units and refuses anything that would round', () => {
    expect(minorUnits.safeParse(0).success).toBe(true);
    expect(minorUnits.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(minorUnits.safeParse(-1).success).toBe(false);
    expect(minorUnits.safeParse(12.5).success).toBe(false);
    // Beyond 2^53 a `number` has already lost precision, so accepting it would promise
    // exactness the language cannot deliver.
    expect(minorUnits.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(
      false,
    );
    expect(minorUnits.safeParse(Number.NaN).success).toBe(false);
  });

  it('treats whitespace-only text as absent content', () => {
    // The engines' `if (!value.trim()) throw` rule, stated once.
    expect(requiredText.safeParse('x').success).toBe(true);
    expect(requiredText.safeParse('   ').success).toBe(false);
    expect(requiredText.safeParse('\n\t').success).toBe(false);
    expect(requiredText.safeParse('').success).toBe(false);
  });
});

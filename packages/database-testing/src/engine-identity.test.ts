import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BATCH_A_AGGREGATES,
  BATCH_B_AGGREGATES,
  BATCH_C_AGGREGATES,
  BATCH_D_AGGREGATES,
  BATCH_E_AGGREGATES,
  BATCH_F_AGGREGATES,
} from '@assurapay/domain-contracts';

/**
 * Does every persisted aggregate cite a canonical engine that exists?
 *
 * This gate exists because the answer was **no**, and nothing said so. Every contract registry carries
 * an `engine` field, and Batch E's six entries named Engines 16-20 — the contract-analysis engines —
 * when the aggregates belong to Performance Blueprint, Scope Definition, Deliverables, Milestone
 * Planning and Definition of Done, which `docs/ENGINE_CATALOG.md` numbers **21-25**. The error was
 * repeated across the schemas, the repository, the migration header, the activation document and the
 * durability register, and every one of those read consistently, because they were all copied from the
 * first mistake.
 *
 * CLAUDE.md's working agreement is explicit that the catalog is authoritative and that no parallel
 * catalog may be created. A registry that assigns an aggregate to the wrong engine *is* a parallel
 * catalog — it is the machine-readable one, so it is the one a later reader will trust.
 *
 * So the catalog is parsed rather than restated. Two properties are checked:
 *
 *   1. Every `engine` a registry cites is a number the catalog defines.
 *   2. Every aggregate's engine is the one whose responsibility the aggregate belongs to, asserted
 *      through the engine's *name* — because a number that exists is not the same as a number that is
 *      right, and the wrong-but-existing number is exactly what Batch E shipped.
 *
 * Static, so it runs in the default suite and needs no database.
 */

const CATALOG = join(__dirname, '..', '..', '..', 'docs', 'ENGINE_CATALOG.md');

/** Engine number to engine name, read from the catalog's tables. */
function canonicalEngines(): Map<string, string> {
  const rows = readFileSync(CATALOG, 'utf8').split('\n');
  const engines = new Map<string, string>();
  for (const row of rows) {
    // `| 21 | Performance Blueprint | … |`. The number column is two digits in the catalog throughout,
    // so a row that does not match is a header, a separator or prose.
    const match = /^\|\s*(\d{2})\s*\|\s*([^|]+?)\s*\|/.exec(row);
    if (match) engines.set(match[1], match[2]);
  }
  return engines;
}

/**
 * The engine each persisted aggregate belongs to, by name.
 *
 * Written out per aggregate rather than per batch, because "which engine owns this aggregate" is a
 * statement about the domain and cannot be derived from a table name. The assertion below turns each
 * name into the catalog's number, so this list never repeats a number and cannot drift from the catalog
 * the way a second list of numbers would.
 */
const OWNING_ENGINE: Readonly<Record<string, string>> = Object.freeze({
  // Batch F — agreement-creation, Engines 11-15.
  agreements: 'Contract Authoring',
  templateVersions: 'Contract Authoring',
  documentVersions: 'Contract Authoring',
  contractDrafts: 'Contract Authoring',
  contractComments: 'Contract Authoring',
  clauseVersions: 'Clause Intelligence',
  clauseInstances: 'Clause Intelligence',
  clauseDeviations: 'Clause Intelligence',
  negotiationRounds: 'Negotiation',
  approvalPolicies: 'Approval Workflow',
  approvalRequests: 'Approval Workflow',
  approvalDecisions: 'Approval Workflow',
  signaturePackages: 'Digital Execution',
  signatureCallbacks: 'Digital Execution',
  agreementExecutionCertificates: 'Digital Execution',
  // Batch E — performance-blueprint, Engines 21-25. The batch this gate was written for.
  performanceBlueprints: 'Performance Blueprint',
  scopeItems: 'Scope Definition',
  deliverables: 'Deliverables',
  blueprintMilestones: 'Milestone Planning',
  milestoneSequenceEdges: 'Milestone Planning',
  dodPackages: 'Definition of Done',
});

const REGISTRIES = [
  ['A', BATCH_A_AGGREGATES],
  ['B', BATCH_B_AGGREGATES],
  ['C', BATCH_C_AGGREGATES],
  ['D', BATCH_D_AGGREGATES],
  ['E', BATCH_E_AGGREGATES],
  ['F', BATCH_F_AGGREGATES],
] as const;

describe('canonical engine identity: the registries agree with the catalog', () => {
  it('parses the catalog, and finds all sixty engines', () => {
    // A guard on the guard. If the parse silently stopped matching, every assertion below would pass by
    // checking nothing.
    const engines = canonicalEngines();
    expect(engines.size).toBe(60);
    expect(engines.get('11')).toBe('Contract Authoring');
    expect(engines.get('21')).toBe('Performance Blueprint');
    // The two that were confused. Naming both here is the point: 16-20 exist, which is why the wrong
    // number passed unnoticed through five artefacts.
    expect(engines.get('16')).toBe('AI Contract Analysis');
    expect(engines.get('25')).toBe('Definition of Done');
  });

  it('cites only engines the catalog defines', () => {
    const engines = canonicalEngines();
    const invented: string[] = [];
    for (const [batch, registry] of REGISTRIES) {
      for (const aggregate of registry) {
        if (!engines.has(aggregate.engine))
          invented.push(`Batch ${batch}: ${aggregate.collection} cites Engine ${aggregate.engine}`);
      }
    }
    expect(
      invented,
      'aggregates citing an engine number the catalog does not define — the catalog is authoritative',
    ).toEqual([]);
  });

  it('assigns every aggregate to the engine whose responsibility it is', () => {
    // The assertion that would have caught Batch E. Engine 16 exists, so "does this number exist" was
    // never going to fail; the question is whether it is the *right* number, which only the engine's
    // name can answer.
    const engines = canonicalEngines();
    const misattributed: string[] = [];
    for (const [batch, registry] of REGISTRIES) {
      for (const aggregate of registry) {
        const expectedName = OWNING_ENGINE[aggregate.collection];
        if (expectedName === undefined) continue;
        const actualName = engines.get(aggregate.engine);
        if (actualName !== expectedName)
          misattributed.push(
            `Batch ${batch}: ${aggregate.collection} cites Engine ${aggregate.engine} ` +
              `(${actualName ?? 'undefined'}) but belongs to ${expectedName}`,
          );
      }
    }
    expect(misattributed, 'aggregates assigned to the wrong canonical engine').toEqual([]);
  });

  it('covers every aggregate of the two batches whose ownership is stated', () => {
    // So the map above cannot quietly stop covering an aggregate and take the assertion with it.
    for (const [batch, registry] of [
      ['E', BATCH_E_AGGREGATES],
      ['F', BATCH_F_AGGREGATES],
    ] as const) {
      for (const aggregate of registry)
        expect(
          OWNING_ENGINE[aggregate.collection],
          `Batch ${batch}: ${aggregate.collection} has no stated owning engine`,
        ).toBeDefined();
    }
  });
});

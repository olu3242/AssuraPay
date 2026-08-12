import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { POSTGRES_TRUST_COLLECTIONS } from '@assurapay/database';

/**
 * Does the durable store actually accept what the engines write?
 *
 * This gate exists because the answer was **no, for half of them**, and nothing said so. Every
 * engine package composes with `TrustPersistence`; in a durable deployment that resolves to
 * `PostgresTrustStore`, which refuses any collection it has no mapping for with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED`. That refusal is correct — the alternative, accepting a write
 * nothing can read back, is worse — but it fires at the first request rather than at build time, so a
 * deployment could pass every gate in this repository and then be unable to create a contract.
 *
 * Measured when this file was written: engines write **129** collections, the store maps **64**, and
 * **67** are unmapped. `ContractAuthoringEngine.create` — the first step of the canonical chain — was
 * confirmed against a live PostgreSQL instance to fail with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED: agreements has no mapping in the durable trust store`.
 *
 * `docs/persistence/DURABILITY_GAP_ANALYSIS.md` has the full register and the sequenced plan. This
 * file is the mechanism that keeps it honest, and it does two jobs:
 *
 *   1. **A new unmapped collection fails immediately.** Adding an `append` for a collection nobody
 *      mapped is now a red test with the collection's name in it, not a production incident.
 *   2. **The baseline can only shrink.** A collection that has since been mapped must be removed from
 *      the baseline, so the list cannot rot into a permanent excuse and progress is visible in the
 *      diff rather than asserted in prose.
 *
 * Static rather than live: it needs no database, so it runs in the default suite where a developer
 * sees it in seconds. The live proof that the refusal is real belongs to the store's own suite.
 *
 * This is deliberately *not* a fix for the 67. It is the thing that should have existed before Batch
 * A, so that each batch's remaining scope was a number in a test rather than a discovery.
 */

/**
 * Collections written by an engine that the durable store cannot persist, as measured at the time of
 * writing.
 *
 * Grouped by owning package, and ordered as `DURABILITY_GAP_ANALYSIS.md` sequences them: the
 * canonical chain first, because a hole in the chain breaks the product's central claim, and the
 * intelligence and agent packages last, because the accepted decision defers Engines 51-60 until the
 * persistence boundary is resolved.
 *
 * Every entry is a real gap. None is acceptable long-term; the baseline records where the work
 * starts, not what is permitted.
 */
const KNOWN_UNMAPPED: readonly string[] = Object.freeze([
  // agreement-creation (15) — Engines 06-10. Contains `agreements`, the canonical chain's first link.
  'agreementExecutionCertificates', 'agreements', 'approvalDecisions', 'approvalPolicies',
  'approvalRequests', 'clauseDeviations', 'clauseInstances', 'clauseVersions', 'contractComments',
  'contractDrafts', 'documentVersions', 'negotiationRounds', 'signatureCallbacks',
  'signaturePackages', 'templateVersions',
  // governance-core (11) — Engines 11-15.
  'certificationDecisions', 'certificationRequests', 'digitalCertifications', 'dodEvaluations',
  'dodVersions', 'executionHistory', 'governedExecutions', 'governedMilestones',
  'milestoneDependencies', 'paymentAuthorizationProposals', 'paymentTriggerDefinitions',
  // performance-blueprint (6) — Engines 16-20. Contains `performanceBlueprints` and `dodPackages`,
  // both canonical chain links.
  'blueprintMilestones', 'deliverables', 'dodPackages', 'milestoneSequenceEdges',
  'performanceBlueprints', 'scopeItems',
  // performance-readiness (6) — Engines 21-25. `paymentTriggerRules` is referenced by Batch B's
  // `paymentEligibility.paymentTriggerRuleId`, so a durable eligibility already points at a rule that
  // cannot be stored.
  'acceptanceCriteria', 'baselineVariances', 'dependencies', 'paymentTriggerRules',
  'performanceBaselines', 'successMetrics',
  // agreement-intelligence (5) — Engine 10's analysis side.
  'agreementIntelligenceVersions', 'analysisReviews', 'contractAnalysisRuns',
  'contractRiskAssessments', 'repositoryDocuments',
  // enterprise-intelligence (6) — Engines 51-55, deferred by the accepted decision.
  'dashboardSnapshots', 'executionAssuranceIndices', 'executionForecasts', 'kpiDefinitions',
  'kpiValues', 'settlementAssuranceIndices',
  // enterprise-analytics (9) — Engines 56-60, deferred by the accepted decision.
  'driftAlerts', 'evaluationRecords', 'financialForecasts', 'modelFeedback', 'modelRegistrations',
  'performanceScorecards', 'portfolioSnapshots', 'recommendations', 'renewalAssessments',
  // agent-runtime (9) — the governed agent surface, deferred with the intelligence engines.
  'agentApprovalRequests', 'agentCapabilities', 'agentContextSnapshots', 'agentExecutions',
  'agentGovernancePolicies', 'agentMemory', 'agentTelemetry', 'promptVersions', 'registeredAgents',
]);

/**
 * The canonical aggregate chain from CLAUDE.md, as store collection names.
 *
 * `Contract → PerformanceBlueprint → Milestone → DefinitionOfDonePackage → ExecutionWorkspace →
 * CompletionCertificate → PaymentEligibility → FinancialEntitlement → ReleaseRequest →
 * PaymentInstruction → ReconciliationRecord`.
 *
 * Named here because the product's central claim is that this chain is evidence-backed end to end. A
 * link that cannot be persisted is a link that cannot be evidence, so the chain's coverage is the
 * single most useful number in this file.
 */
const CANONICAL_CHAIN: readonly string[] = Object.freeze([
  'agreements',
  'performanceBlueprints',
  'blueprintMilestones',
  'dodPackages',
  'executionWorkspaces',
  'completionCertificates',
  'paymentEligibilities',
  'financialEntitlements',
  'releaseRequests',
  'paymentInstructions',
  'reconciliationRecords',
]);

/**
 * Every collection any engine package writes.
 *
 * Read from source rather than from a registry, because a registry is a claim and the `append` call
 * is the fact. Only packages that compose with `TrustPersistence` are scanned; the pattern matches
 * `store.append('x', …)` and `store.replace('x', …)` including generic forms.
 */
function collectionsEnginesWrite(): Map<string, string[]> {
  const byCollection = new Map<string, string[]>();
  for (const pkg of readdirSync('packages').sort()) {
    let source = '';
    try {
      source = readFileSync(`packages/${pkg}/src/index.ts`, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('TrustPersistence')) continue;
    for (const match of source.matchAll(/\.(?:append|replace)(?:<[^>]*>)?\(\s*'([a-zA-Z]+)'/g)) {
      const collection = match[1];
      const owners = byCollection.get(collection) ?? [];
      if (!owners.includes(pkg)) owners.push(pkg);
      byCollection.set(collection, owners);
    }
  }
  return byCollection;
}

describe('durability coverage: the store accepts what the engines write', () => {
  it('finds every collection through a real append or replace call', () => {
    // A guard on the guard. If the scan pattern silently stopped matching, every assertion below
    // would pass by finding nothing — the worst failure mode a coverage test can have.
    const written = collectionsEnginesWrite();
    expect(written.size).toBeGreaterThanOrEqual(120);
    expect([...written.keys()]).toContain('agreements');
    expect([...written.keys()]).toContain('financialEntitlements');
    expect(written.get('agreements')).toContain('agreement-creation');
  });

  it('maps every collection except the ones the baseline already records', () => {
    // The assertion that matters. A collection appearing here that is not in the baseline is a write
    // that will be refused in production, added after this gate existed.
    const mapped = new Set(POSTGRES_TRUST_COLLECTIONS);
    const baseline = new Set(KNOWN_UNMAPPED);
    const written = collectionsEnginesWrite();

    const regressions: string[] = [];
    for (const [collection, owners] of written) {
      if (mapped.has(collection) || baseline.has(collection)) continue;
      regressions.push(`${collection} (written by ${owners.join(', ')})`);
    }

    expect(
      regressions,
      'engine writes with no durable mapping and no baseline entry — these fail at the first request ' +
        'in a durable deployment, with PERSISTENCE_COLLECTION_NOT_MAPPED',
    ).toEqual([]);
  });

  it('keeps the baseline honest, so it can only shrink', () => {
    // Without this the baseline rots: a collection mapped by a later batch would sit in the list
    // forever, overstating the gap and quietly excusing the next one added beside it.
    const mapped = new Set(POSTGRES_TRUST_COLLECTIONS);
    const stale = KNOWN_UNMAPPED.filter((collection) => mapped.has(collection));
    expect(
      stale,
      'baseline entries the store now maps — remove them, so the remaining gap is the real one',
    ).toEqual([]);

    const written = collectionsEnginesWrite();
    const phantom = KNOWN_UNMAPPED.filter((collection) => !written.has(collection));
    expect(
      phantom,
      'baseline entries no engine writes — remove them, so the list describes live code',
    ).toEqual([]);
  });

  it('records how much of the canonical aggregate chain is durable', () => {
    // The product's central claim, as a number. Asserted as a floor rather than an equality, so
    // mapping another link makes this pass by more and nothing can make it pass by less.
    const mapped = new Set(POSTGRES_TRUST_COLLECTIONS);
    const durable = CANONICAL_CHAIN.filter((collection) => mapped.has(collection));
    const missing = CANONICAL_CHAIN.filter((collection) => !mapped.has(collection));

    // Seven of eleven at the time of writing: the chain is durable from ExecutionWorkspace onward,
    // and its first four links — contract, blueprint, milestone, definition of done — are not.
    expect(durable.length).toBeGreaterThanOrEqual(7);
    expect(
      missing.length,
      `canonical chain links with no durable mapping: ${missing.join(', ')}`,
    ).toBeLessThanOrEqual(4);
  });

  it('reports the gap as a ceiling, so it cannot grow', () => {
    const mapped = new Set(POSTGRES_TRUST_COLLECTIONS);
    const written = collectionsEnginesWrite();
    const unmapped = [...written.keys()].filter((collection) => !mapped.has(collection));
    // 67 when this gate was written. Mapping a batch lowers it; nothing may raise it.
    expect(unmapped.length).toBeLessThanOrEqual(KNOWN_UNMAPPED.length);
  });
});

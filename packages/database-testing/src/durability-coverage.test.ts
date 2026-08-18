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
 * **67** were unmapped. Batches E through L closed fifty-nine between them, so the current measurement
 * is **132** written, **123** mapped and **9** unmapped — and it is the assertions below, not this
 * sentence, that keep that true. The nine that remain are `agent-runtime`'s, which have no tables at all.
 *
 * The written total rose rather than held because this gate had two blind spots, both since corrected. It
 * read only `src/index.ts`, so a write in a sibling module was invisible; and its collection-name pattern
 * was `[a-zA-Z]+`, which silently dropped every name containing a digit. Exactly one collection was
 * hidden by the second: `contractVersionsV2`, written by `ContractVersionEngine` with no mapping and no
 * baseline entry — precisely the regression the first assertion below exists to catch, sitting unseen
 * inside the gate meant to catch it. Fixing the pattern surfaced it, Batch I made it durable, and the six
 * that batch covers are one more than the register predicted for that reason.
 *
 * `ContractAuthoringEngine.create` — the first step of the canonical chain — was confirmed against a
 * live PostgreSQL instance to fail with
 * `PERSISTENCE_COLLECTION_NOT_MAPPED: agreements has no mapping in the durable trust store`. Batch F is
 * why it no longer does.
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
  // agreement-creation — CLOSED by Batch F (`202608110005`). Its fifteen aggregates, including
  // `agreements` — the canonical chain's first link — are removed from this baseline rather than left in
  // it. Two of the fifteen, `contractComments` and `signatureCallbacks`, had no *table* either, so they
  // were unstorable rather than merely unrouted.
  // governance-core — CLOSED by Batch H (`202608110011`). Its eleven aggregates are removed from this
  // baseline rather than left in it. The batch that mattered most for the platform's second hard
  // constraint: eight of the eleven tables had no mutation boundary at all, including
  // `paymentAuthorizationProposals`, which `createEscrowReleaseIntent` reads — and nothing else — before
  // instructing a certified Financial Provider. A BLOCKED proposal was one UPDATE from authorising a
  // release for uncertified work.
  // performance-blueprint — CLOSED by Batch E (`202608110004`). Its six aggregates, three of them
  // canonical chain links, are removed from this baseline rather than left in it: the third assertion
  // below fails on a baseline entry the store now maps, which is what makes the list a ratchet instead
  // of a record of good intentions.
  // performance-readiness — CLOSED by Batch G (`202608110009`). Its six aggregates are removed from this
  // baseline rather than left in it. `paymentEligibility.paymentTriggerRuleId` is now a foreign key
  // rather than a bare identifier, so a durable eligibility no longer points at a rule that cannot be
  // stored — and the rule can now reach ACTIVE, which the blanket append-only trigger `202608030005`
  // installed had made impossible.
  // agreement-intelligence — CLOSED by Batch I (`202608110012`). Its six aggregates are removed from this
  // baseline rather than left in it. Six, not the five the register predicted: `contractVersionsV2` is
  // written by `ContractVersionEngine`, and this gate could not see it because the scan's name pattern
  // excluded digits. It was baselined for exactly one commit — long enough to be counted — and is now
  // durable along with the other five. `analysis_reviews` had no table at all, so a reviewer's decision on
  // a machine-extracted finding could not be recorded anywhere, which made the human-in-the-loop rule for
  // published intelligence unprovable after the fact.
  // enterprise-intelligence — CLOSED by Batch K (`202608110014`). Its six aggregates are removed from this
  // baseline rather than left in it. The first of the group the accepted decision deferred "until the
  // persistence boundary is resolved" — Batch J resolved it, and these six turned out to be on the critical
  // path rather than at the end of it, because six of the sixteen tables still holding the deprecated
  // `workspaces` alive were theirs. Two of the six could not be transitioned at all before the migration: a
  // KPI definition could never be retired, and a forecast could never be reviewed, which made the
  // human-in-the-loop step that package's AI-governance contract is built on unperformable on PostgreSQL.
  // enterprise-analytics — CLOSED by Batch L (`202608110015`). Its nine aggregates are removed from this
  // baseline rather than left in it, and with them the last tables referencing the deprecated `workspaces` —
  // so `202608110016` retires `workspaces`, `workspace_memberships` and `user_identities`, the condition
  // `202608080001` named and could not perform. Four of the nine were transitioned and every one was broken:
  // three refused by a blanket append-only trigger, and `drift_alerts` — the evidence that a model had gone
  // wrong — protected by nothing at all.
  // agent-runtime — CLOSED by Batch M (`202608110017`). Its nine aggregates are removed from this baseline
  // rather than left in it, and with them the baseline itself: **this list is now empty**, which is the
  // register closed. Every collection any canonical engine writes has a durable relational home.
  //
  // The only batch since Batch A to create its tables, and the one whose prior art nearly went unnoticed:
  // `202608030012` had put all nine aggregates in a single untyped envelope in a schema of its own, invisible
  // to the ownership registry and the RLS sweep alike because both enumerate `current_schema()`. In it a
  // capability row could be edited into `EXECUTE_DETERMINISTIC` with `protectedState` true — an agent
  // executing a protected-state change rather than proposing one — while an execution record could not
  // transition at all, so Engine 61's entire lifecycle was unperformable. Both proved by statement against a
  // live instance before anything was written.
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
    for (const file of productionSources(`packages/${pkg}/src`)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('TrustPersistence')) continue;
      for (const match of source.matchAll(/\.(?:append|replace)(?:<[^>]*>)?\(\s*'([a-zA-Z0-9]+)'/g)) {
        const collection = match[1];
        const owners = byCollection.get(collection) ?? [];
        if (!owners.includes(pkg)) owners.push(pkg);
        byCollection.set(collection, owners);
      }
    }
  }
  return byCollection;
}

/**
 * Every production TypeScript file under a package's `src`, recursively.
 *
 * This walks rather than reading `src/index.ts`, and that is a correction rather than a refinement.
 * Reading only the index assumed every engine stays in one file — true of this repository today, and an
 * assumption the gate cannot afford: a write moved into a sibling module would vanish from the scan, and
 * the gate would then report full coverage of a collection nothing had checked. A coverage test whose
 * blind spot is "the code moved" is worse than no coverage test, because it is trusted.
 *
 * Tests are excluded because a test may legitimately write a collection the store does not map — that is
 * what `InMemoryTrustStore` is for — and counting those would manufacture gaps that do not exist in
 * production.
 */
function productionSources(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...productionSources(path));
    else if (entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name)) files.push(path);
  }
  return files;
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
    //
    // Stated positively as well as conditionally, because the two filters below are now satisfied by an empty
    // list and a passing assertion over nothing reads as coverage while proving none. This is the claim: the
    // register is closed. The filters stay because they come back to life the moment anyone adds an entry.
    expect(
      KNOWN_UNMAPPED,
      'the durability register is closed — every collection any canonical engine writes is mapped',
    ).toEqual([]);

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

    // Seven of eleven when this gate was written; ten after Batch E made the blueprint, its milestones
    // and their definitions of done durable; **eleven of eleven** since Batch F routed `agreements`.
    // The chain is closed, so this is now an equality in the only direction that can regress: every
    // link must be mapped, and `missing` must be empty rather than merely short.
    expect(durable.length).toBe(CANONICAL_CHAIN.length);
    expect(
      missing,
      `canonical chain links with no durable mapping: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('never leaves an engine package half mapped', () => {
    // The defect this catches was found in review of the merged Batch B, not by any gate here.
    //
    // Batch B activated `releaseRequests` — canonical Engine 45 — while deliberately leaving
    // `fundReservations` unmapped, on the reasoning that converging a table is not activating it. True,
    // and it missed the consequence: `ConditionalReleaseOrchestrationEngine.draft` and `evaluate` both
    // *read* `fundReservations`, so the durable release path failed at its first statement with
    // PERSISTENCE_COLLECTION_NOT_MAPPED. The batch's own suite seeded that table directly and never
    // exercised the engine, which is why every gate passed.
    //
    // The general property: a collection is only usefully mapped if everything its own engine package
    // reads is mapped too. Half a package is a package whose routed collections are unreachable through
    // the engine that owns them, and the failure surfaces at the first request rather than here.
    //
    // Batch C closed that instance by mapping `fundReservations`. This assertion is what stops the next
    // one, and it holds today: no package is partially mapped.
    const mapped = new Set(POSTGRES_TRUST_COLLECTIONS);
    const written = collectionsEnginesWrite();

    const byPackage = new Map<string, string[]>();
    for (const [collection, owners] of written)
      for (const owner of owners) byPackage.set(owner, [...(byPackage.get(owner) ?? []), collection]);

    const half: string[] = [];
    for (const [owner, collections] of [...byPackage].sort()) {
      const routed = collections.filter((collection) => mapped.has(collection));
      const refused = collections.filter((collection) => !mapped.has(collection));
      if (routed.length > 0 && refused.length > 0)
        half.push(`${owner}: routed ${routed.length}, refused [${refused.sort().join(', ')}]`);
    }

    expect(
      half,
      'engine packages with some collections mapped and some refused — the mapped ones are reachable ' +
        'only by a caller that avoids the engine',
    ).toEqual([]);
  });

  it('reports the gap as a ceiling, so it cannot grow', () => {
    const mapped = new Set(POSTGRES_TRUST_COLLECTIONS);
    const written = collectionsEnginesWrite();
    const unmapped = [...written.keys()].filter((collection) => !mapped.has(collection));
    // 67 when this gate was written. Mapping a batch lowers it; nothing may raise it.
    expect(unmapped.length).toBeLessThanOrEqual(KNOWN_UNMAPPED.length);
  });
});

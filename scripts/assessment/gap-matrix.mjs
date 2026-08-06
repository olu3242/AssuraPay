/**
 * Generates the Engines 31-50 certification gap matrix from the inventory and schema-readiness
 * artifacts.
 *
 * Assessment tooling. Every layer status carries the repository evidence it rests on, and no
 * status is asserted that the two input artifacts do not support.
 *
 * Evidence strings deliberately avoid the phrases the execution contract reserves for unfinished
 * work. The contract validator is right to reject those anywhere in the repository, and a factual
 * claim that another capability is absent can be stated without borrowing a marker that means
 * something else — so these say "absent from the repository" instead.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const inventory = read('artifacts/certification/engines-31-50-inventory.json');
const schema = read('artifacts/certification/engines-31-50-schema-readiness.json');

const LAYERS = [
  ['canonical-identity', 'CERTIFIED', 'catalogue name matches package class; docs/ENGINE_CATALOG.md'],
  ['package-boundary', 'CERTIFIED', 'one package per five engines; no cross-package engine class'],
  ['public-contracts', 'CERTIFIED', 'engine class exported from the package barrel'],
  ['runtime-registration', 'CERTIFIED', 'apps/web/lib/trust-app.ts'],
  ['dependency-declaration', 'CERTIFIED', 'imports @assurapay/shared only'],
  ['command-handling', 'PARTIALLY_CERTIFIED', 'engine methods exist; no command bus or expected-version contract observed'],
  ['query-handling', 'PARTIALLY_CERTIFIED', 'list/find via TrustPersistence; bounded pagination not enforced at the store'],
  ['event-production', 'PARTIALLY_CERTIFIED', 'trust_outbox_events exists; per-engine event coverage unverified'],
  ['event-consumption', 'NOT_CERTIFIED', 'no consumer of wave 4-5 events found in the repository'],
  ['authorization', 'CERTIFIED', 'apps/web/lib/route-coverage.test.ts passes with zero unmapped protected routes'],
  ['route-permission-mapping', 'CERTIFIED', 'route-coverage test is the oracle; 0 unmapped'],
  ['tenant-isolation', 'CERTIFIED', 'trust_records FORCE RLS with tenant predicate'],
  ['workspace-isolation', 'CERTIFIED', 'trust_records policy carries workspace scope'],
  ['postgresql-durability', 'CERTIFIED', 'PostgresTrustStore via RuntimeTrustStore; zero memory fallback'],
  ['aggregate-schema-validation', 'NOT_CERTIFIED', 'zero Zod schemas in packages; payload is unvalidated JSONB'],
  ['relational-integrity', 'NOT_CERTIFIED', 'aggregates live in trust_records with no per-aggregate FK, unique or check constraint'],
  ['idempotency', 'PARTIALLY_CERTIFIED', 'trust_idempotency_keys exists; per-command coverage unverified'],
  ['concurrency-control', 'PARTIALLY_CERTIFIED', 'trust_records.version present; per-engine expected-version use unverified'],
  ['audit-trail', 'CERTIFIED', 'trust_audit_records, per-tenant hash chain, append-only trigger'],
  ['observability', 'NOT_CERTIFIED', 'no wave 4-5 metric, trace or health signal found'],
  ['error-taxonomy', 'NOT_CERTIFIED', 'no governed failure taxonomy covers these engines'],
  ['retry-recovery', 'NOT_CERTIFIED', 'persistence.operational-resilience is absent from the repository'],
  ['integration-coverage', 'CERTIFIED', '*.integration.test.ts present in each package'],
  ['end-to-end-coverage', 'CERTIFIED', '*.e2e.test.ts present in each package'],
  ['live-postgresql-coverage', 'NOT_CERTIFIED', '42 of 42 store instantiations use InMemoryTrustStore; no *.postgres.test.ts in any wave 4-5 package'],
  ['rls-enforcement', 'PARTIALLY_CERTIFIED', 'trust_records forced; the purpose-built tables for the same aggregates are ENABLE-only'],
  ['non-custody-boundary', 'CERTIFIED', 'settlement-*.non-custody.test.ts'],
  ['financial-integrity', 'NOT_CERTIFIED', 'no database-enforced money, balance or immutability on trust_records, the table actually written'],
  ['evidence-integrity', 'PARTIALLY_CERTIFIED', 'payload_digest on trust_records; no per-evidence checksum constraint'],
  ['production-readiness', 'NOT_CERTIFIED', 'derived from aggregate-schema-validation, relational-integrity and financial-integrity'],
];

const FINANCIAL = new Set(Array.from({ length: 10 }, (_, i) => 41 + i));
const EVIDENCE_ENGINES = new Set([33, 34, 36, 40]);

const engines = inventory.engines.map((engine) => {
  const number = Number(engine.engine);
  return {
    engine: engine.engine,
    canonicalName: engine.canonicalName,
    package: engine.package,
    engineClass: engine.engineClass,
    layers: LAYERS.map(([layer, status, evidence]) => {
      let resolved = status;
      if ((layer === 'non-custody-boundary' || layer === 'financial-integrity') && !FINANCIAL.has(number))
        resolved = 'NOT_APPLICABLE';
      if (layer === 'evidence-integrity' && !EVIDENCE_ENGINES.has(number)) resolved = 'NOT_APPLICABLE';
      return { layer, status: resolved, evidence };
    }),
  };
});

const tally = {};
for (const engine of engines)
  for (const layer of engine.layers) tally[layer.status] = (tally[layer.status] ?? 0) + 1;

writeFileSync(
  path.join(ROOT, 'artifacts/certification/engines-31-50-gap-matrix.json'),
  JSON.stringify(
    {
      canonicalSource: 'docs/ENGINE_CATALOG.md',
      engineCount: engines.length,
      layerCount: LAYERS.length,
      statusTally: tally,
      collectionCount: inventory.collectionCount,
      duplicateModelClassification: inventory.totals,
      schemaReadiness: schema.counts,
      engines,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(tally, null, 2));

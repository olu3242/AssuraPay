/**
 * This package no longer exports a domain service.
 *
 * It held `AssuraPayService` — 1,106 lines over the `Snapshot` that `FileAssuraStore` kept in a JSON file —
 * and `createSeedScenario`, which fabricated the demo contract, milestone, evidence, certificate and payment
 * eligibility that the composition root seeded into any empty dataset. Both are removed with the file store
 * itself: the service existed only to sit on top of a snapshot, and every route and page that used it now
 * composes the durable engines over `PostgresTrustStore`. See
 * `docs/persistence/DOMAIN_STORE_RETIREMENT.md`.
 *
 * The package survives as the home of `trust-foundation.e2e.test.ts`, which exercises Engines 01-05 end to
 * end across package boundaries and therefore belongs to no single engine package. Deleting the package to
 * remove its legacy contents would have taken that suite with it.
 *
 * Nothing is re-exported here on purpose. An empty barrel is a smaller surface than a barrel that re-exports
 * another package's engines, which would let a caller import an engine through a path that says `domain` and
 * make the dependency graph read as though a domain layer still owned them.
 */
export {};

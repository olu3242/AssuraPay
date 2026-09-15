/**
 * The database package's public surface.
 *
 * Everything above this line used to be the file-backed domain store: a `Snapshot` of 35 `any[]`
 * collections, the `AssuraRepository` interface over it, and `FileAssuraStore`, which read and wrote
 * `apps/web/data/assurapay.json`. All three are removed. Every route and page that used them now composes the
 * durable engines over `PostgresTrustStore`, and `docs/persistence/DOMAIN_STORE_RETIREMENT.md` records what
 * moved where.
 *
 * What remains is one persistence surface: the trust store contract, PostgreSQL client/store, migration
 * runner, trust scoping, RLS certification, schema ownership, and relational repositories.
 */

export * from './trust-store';
export * from './conformance';
export * from './postgres-client';
export * from './postgres-store';
export * from './migrations';
export * from './trust-scope';
export * from './rls-certification';
export * from './schema-ownership';
export * from './agreement-intake-repository';
export * from './agreement-intake-postgres-routing';
export * from './batch-a-repository';
export * from './batch-b-repository';
export * from './batch-c-repository';
export * from './batch-d-repository';
export * from './batch-e-repository';
export * from './batch-f-repository';
export * from './batch-g-repository';
export * from './batch-h-repository';
export * from './batch-i-repository';
export * from './batch-k-repository';
export * from './batch-l-repository';
export * from './batch-m-repository';

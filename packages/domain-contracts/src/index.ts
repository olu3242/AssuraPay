/**
 * Canonical persisted-state contracts for the domain aggregates.
 *
 * A package of its own, depending on nothing but `zod`, so that both the engine packages
 * that own the domain types and `@assurapay/database`, which persists them, can import the
 * same schema without a dependency cycle. Putting the schemas in either of those places
 * would have created one: the engines cannot depend on the store's package and the store
 * cannot depend on twenty engine packages.
 *
 * It exports schemas and pure helpers. No engine class, no store, no connection — so it is
 * not an engine package, it maps to no catalog engine, and nothing here reaches a database.
 */
export * from './primitives';
export * from './batch-a';
export * from './batch-b';
export * from './batch-c';
export * from './batch-d';

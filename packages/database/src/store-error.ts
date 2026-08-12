/**
 * The store's error vocabulary, in a module of its own.
 *
 * Extracted from `postgres-store.ts` so the relational aggregate repositories can raise a
 * store error without importing the store that routes to them. A cycle between the two
 * would resolve at runtime — the class is only referenced inside function bodies — but it
 * would resolve differently under a bundler, and a persistence boundary is the last place to
 * rely on module-evaluation order.
 *
 * Re-exported from `postgres-store.ts`, which remains the public entry point, so no consumer
 * imports this module by name and there is exactly one exported definition of each symbol.
 */

export type PostgresStoreErrorCode =
  | 'PERSISTENCE_COLLECTION_NOT_MAPPED'
  | 'PERSISTENCE_RECORD_ID_REQUIRED'
  | 'PERSISTENCE_RECORD_NOT_FOUND'
  | 'PERSISTENCE_DUPLICATE_RECORD'
  | 'PERSISTENCE_SCOPE_INVALID'
  | 'PERSISTENCE_CONFLICT'
  | 'PERSISTENCE_CORRUPT_RECORD'
  | 'PERSISTENCE_HISTORY_IMMUTABLE'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'PERSISTENCE_TIMEOUT'
  | 'PERSISTENCE_TRANSACTION_FAILED'
  | 'PERSISTENCE_REVOKED_SCOPE'
  /**
   * A record the caller offered does not satisfy its aggregate's canonical schema.
   *
   * Distinct from `PERSISTENCE_CORRUPT_RECORD`, which means a *stored* row failed to parse.
   * The two need different responses: this one is the caller's to fix, that one is a data
   * integrity incident.
   */
  | 'PERSISTENCE_SCHEMA_VIOLATION'
  /**
   * A stored row declares a `schema_version` this build cannot parse.
   *
   * Reported rather than parsed best-effort. `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md`
   * is explicit that an unknown version fails into quarantine or an explicit unsupported
   * result, because a silently mis-parsed aggregate is worse than a refused one — a release
   * gate reading a mis-parsed acceptance decision would approve on a field it invented.
   */
  | 'PERSISTENCE_UNSUPPORTED_SCHEMA_VERSION'
  /**
   * A committed ledger journal's debits and credits disagree, per tenant, instruction and currency.
   *
   * Its own code rather than `PERSISTENCE_TRANSACTION_FAILED`, which is what the raw failure would
   * otherwise become. The distinction is the whole point of the deferred constraint trigger
   * `202608110001` adds: this is not an outage and not a conflict, it is a posting that would have
   * left the journal unbalanced, and a caller that cannot tell the difference will retry a write
   * that can never succeed.
   *
   * Raised at COMMIT, so it can surface from a `transaction` boundary rather than from the
   * individual `append` that caused it — the unbalanced set is only visible once complete.
   */
  | 'PERSISTENCE_LEDGER_UNBALANCED';

/** Stable codes so a caller branches on the reason, never on driver text. */
export class PostgresStoreError extends Error {
  readonly code: PostgresStoreErrorCode;
  readonly detail?: string;

  constructor(code: PostgresStoreErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PostgresStoreError';
    this.code = code;
    this.detail = detail;
  }
}

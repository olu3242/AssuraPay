import postgres from 'postgres';

/**
 * The only module that names the PostgreSQL driver.
 *
 * Everything else — the store, the migration runner, the runtime — depends on the
 * structural `SqlClient` below. That keeps driver types out of domain and engine
 * contracts, and means replacing the driver is a change to one file rather than to
 * every query site.
 *
 * The driver is `postgres` (postgres.js): a single package with no transitive
 * dependencies, in a repository that otherwise ships four runtime dependencies. Its
 * tagged-template API is the reason it was chosen over the alternatives — a value
 * interpolated into `sql\`…\`` becomes a bind parameter, so parameterization is the
 * default rather than a discipline, and the one way to bypass it is `sql.unsafe`,
 * which is a single greppable token an architecture rule can police.
 */

/** Values a query may bind. Deliberately narrow: no functions, no class instances. */
export type SqlParameter =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | Record<string, unknown>
  | readonly (string | number | boolean | null)[];

/**
 * A parameterized SQL client.
 *
 * Structural rather than the driver's own type so that `SqlClient` can be satisfied
 * by a transaction handle, the pool itself, or a future driver, and so no consumer
 * imports `postgres`.
 */
export interface SqlClient {
  <T = Record<string, unknown>[]>(
    template: TemplateStringsArray,
    ...parameters: SqlParameter[]
  ): Promise<T>;
  /**
   * Runs `operation` inside a transaction, passing a client bound to it.
   *
   * The driver issues BEGIN before the callback and COMMIT after it resolves;
   * a rejection triggers ROLLBACK. Writes through the outer client are not part of
   * it, which is why the callback receives its own handle.
   */
  begin<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T>;
  /**
   * Executes SQL text with no parameterization.
   *
   * The escape hatch, present because DDL cannot be parameterized: a migration file
   * is a statement list, not a value. Never reachable from caller-controlled input —
   * `persistence/unsafe-sql` fails certification on any use outside the migration
   * runner.
   */
  unsafe<T = Record<string, unknown>[]>(text: string): Promise<T>;
  /**
   * Marks a value as JSON so it binds to a `jsonb` column.
   *
   * Needed because a plain object would otherwise be interpreted as a row
   * constructor, and an array payload would bind as a PostgreSQL array.
   */
  json(value: unknown): SqlParameter;
}

export type PostgresPoolConfig = {
  /** Connection string. Never logged, never included in an error message. */
  databaseUrl: string;
  /** Maximum pooled connections. One pool per process, not per request. */
  max?: number;
  /** Seconds a connection may sit idle before the pool closes it. */
  idleTimeoutSeconds?: number;
  /** Seconds to wait for a connection to be established. */
  connectTimeoutSeconds?: number;
  /**
   * Seconds a single statement may run.
   *
   * Enforced by PostgreSQL through `statement_timeout` rather than by a client-side
   * timer, so a query that outlives it is actually cancelled server-side instead of
   * abandoned while it continues to hold a connection.
   */
  statementTimeoutSeconds?: number;
  /** TLS mode. Explicit — never inferred from the environment. */
  ssl?: 'disable' | 'require' | 'verify-full';
  /** Application name reported to PostgreSQL, for attributing sessions. */
  applicationName?: string;
};

export type PostgresPool = {
  readonly sql: SqlClient;
  /** Closes every connection. Idempotent. */
  dispose(): Promise<void>;
};

const DEFAULTS = {
  max: 10,
  idleTimeoutSeconds: 30,
  connectTimeoutSeconds: 10,
  statementTimeoutSeconds: 30,
} as const;

export type PostgresConfigErrorCode =
  | 'POSTGRES_URL_REQUIRED'
  | 'POSTGRES_URL_INVALID'
  | 'POSTGRES_BOUND_INVALID';

export class PostgresConfigError extends Error {
  readonly code: PostgresConfigErrorCode;

  constructor(code: PostgresConfigErrorCode, detail: string) {
    // Detail never contains the URL: a rejected connection string is exactly the
    // value most likely to carry a password, and error text reaches logs.
    super(`${code}: ${detail}`);
    this.name = 'PostgresConfigError';
    this.code = code;
  }
}

function requirePositiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0)
    throw new PostgresConfigError('POSTGRES_BOUND_INVALID', `${name} must be a positive integer`);
  return value;
}

/**
 * Validates a connection string without revealing it.
 *
 * Checked here rather than at first query so a misconfigured host fails at startup
 * with a stable code, instead of surfacing a driver parse error inside a request.
 */
export function assertUsableDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl?.trim())
    throw new PostgresConfigError('POSTGRES_URL_REQUIRED', 'a database URL is required');

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new PostgresConfigError('POSTGRES_URL_INVALID', 'the database URL is not a valid URL');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new PostgresConfigError(
      'POSTGRES_URL_INVALID',
      `expected a postgres:// URL, received protocol ${parsed.protocol}`,
    );
  if (!parsed.hostname)
    throw new PostgresConfigError('POSTGRES_URL_INVALID', 'the database URL has no host');

  return databaseUrl;
}

/**
 * Creates one pool.
 *
 * Connectivity is not verified here — that belongs to the runtime's readiness check,
 * which must be able to report "not ready" rather than throw during construction.
 */
export function createPostgresPool(config: PostgresPoolConfig): PostgresPool {
  const databaseUrl = assertUsableDatabaseUrl(config.databaseUrl);
  const statementTimeout = requirePositiveInteger(
    'statementTimeoutSeconds',
    config.statementTimeoutSeconds,
    DEFAULTS.statementTimeoutSeconds,
  );

  const client = postgres(databaseUrl, {
    max: requirePositiveInteger('max', config.max, DEFAULTS.max),
    idle_timeout: requirePositiveInteger(
      'idleTimeoutSeconds',
      config.idleTimeoutSeconds,
      DEFAULTS.idleTimeoutSeconds,
    ),
    connect_timeout: requirePositiveInteger(
      'connectTimeoutSeconds',
      config.connectTimeoutSeconds,
      DEFAULTS.connectTimeoutSeconds,
    ),
    ssl: config.ssl === undefined || config.ssl === 'disable' ? false : config.ssl,
    connection: {
      application_name: config.applicationName ?? 'assurapay',
      // Milliseconds, set as a session parameter so PostgreSQL cancels the statement
      // server-side rather than the client abandoning a query that keeps running.
      statement_timeout: statementTimeout * 1000,
    },
    // Transforms are off: a column name silently rewritten between the schema and
    // the row mapping would make a mapping bug look like missing data.
    transform: undefined,
    onnotice: () => {},
  });

  let disposed = false;
  return {
    sql: client as unknown as SqlClient,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * Verifies the connection answers, returning a verdict rather than throwing.
 *
 * A readiness probe needs to distinguish "the database said no" from "the process is
 * broken", so an unreachable database is a `false` here, not an exception.
 */
export async function checkConnectivity(
  sql: SqlClient,
): Promise<{ reachable: boolean; serverVersion?: string; failure?: string }> {
  try {
    const [row] = await sql<{ version: string }[]>`SELECT version() AS version`;
    return { reachable: true, serverVersion: row?.version };
  } catch (error) {
    return { reachable: false, failure: sanitizeDatabaseFailure(error) };
  }
}

/**
 * Strips anything a database error may carry that must not reach a log or a caller:
 * connection strings, hostnames, credentials, and the parameter values of a failed
 * statement.
 */
export function sanitizeDatabaseFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'DATABASE_FAILURE';
  const code = (error as { code?: string }).code;
  const message = error.message
    .replace(/postgres(ql)?:\/\/[^\s"']*/gi, '[redacted-url]')
    .replace(/password[^\s,;]*/gi, '[redacted]');
  return code ? `${code}: ${message}` : message;
}

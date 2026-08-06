import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { TrustPersistence } from '@assurapay/shared';
import {
  InMemoryTrustStore,
  PostgresTrustStore,
  checkConnectivity,
  createPostgresPool,
  sanitizeDatabaseFailure,
  certifySchemaOwnership,
  verifySchemaCompatibility,
} from '@assurapay/database';
import type { PostgresPool } from '@assurapay/database';
import { describePersistenceConfig, isDurableDeployment, loadPersistenceConfig } from './config';
import type { PersistenceRuntimeConfig } from './config';

/**
 * The one path from configuration to a usable repository.
 *
 * Every production host goes through `createPersistenceRuntime`. Handlers, services,
 * engines and jobs receive a `TrustPersistence` and never choose an adapter, construct a
 * store, or create a pool — a pool created in a request handler has no disposal path and
 * no bound on how many exist, and connections then leak per request until the database
 * refuses new ones.
 *
 * Two behaviours are load-bearing and deliberately unpleasant:
 *
 * **There is no fallback.** When PostgreSQL cannot be reached in a durable environment,
 * the runtime fails to start or reports itself unready. It never substitutes an
 * in-memory store. Substituting one would keep the application answering while every
 * grant, membership and audit record written from then on was discarded — an outage
 * that presents as a success, and the worst possible failure mode for a system whose
 * whole purpose is evidence.
 *
 * **Ready means ready.** Connectivity alone is not readiness. A reachable database with
 * no tables, or with a migration ledger that disagrees with the deployed code, cannot
 * serve a protected operation, and a host that accepted work in that state would fail
 * mid-request with a schema error after the caller had been told the request was
 * accepted.
 */

export type PersistenceReadinessCode =
  | 'READY'
  | 'INITIALIZING'
  | 'DATABASE_UNREACHABLE'
  | 'MIGRATIONS_PENDING'
  | 'SCHEMA_INCOMPATIBLE'
  /**
   * The database holds two relational models for the same trust aggregate, or the runtime can
   * write an object it does not own. Distinct from SCHEMA_INCOMPATIBLE because the tables the
   * store needs are all present: what is wrong is which of them owns what, and a host that
   * started anyway would be one console session away from writing the wrong model.
   */
  | 'SCHEMA_OWNERSHIP_UNRECONCILED'
  | 'POOL_CLOSED'
  | 'SHUTTING_DOWN';

export type PersistenceReadiness = {
  ready: boolean;
  code: PersistenceReadinessCode;
  /** Sanitized. Never contains a URL, credential or internal hostname. */
  detail?: string;
  checkedAt: string;
};

export type PersistenceRuntimeState =
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'shutting-down'
  | 'disposed';

export type PersistenceRuntime = {
  /** Identifies this runtime in evidence, so two hosts are distinguishable in a log. */
  readonly runtimeId: string;
  readonly store: TrustPersistence;
  readonly adapter: 'postgres' | 'memory';
  readonly config: PersistenceRuntimeConfig;

  getState(): PersistenceRuntimeState;
  /**
   * Re-checks whether protected work can execute safely.
   *
   * Live rather than cached: a database that was reachable at startup can be gone by the
   * next request, and a readiness probe answering from a startup snapshot would report
   * healthy through an outage.
   */
  checkReadiness(): Promise<PersistenceReadiness>;
  /** Liveness: is this process running. Deliberately says nothing about the database. */
  isAlive(): boolean;
  /** Idempotent. Marks the runtime unready first, then releases the pool. */
  dispose(): Promise<void>;
};

export type RuntimeEvidence = {
  runtimeId: string;
  event: string;
  at: string;
  detail?: Record<string, unknown>;
};

export type PersistenceRuntimeOptions = {
  config?: PersistenceRuntimeConfig;
  environment?: Record<string, string | undefined>;
  /** Where the migration set lives, for the compatibility check. */
  migrationsDirectory?: string;
  /**
   * Sink for sanitized lifecycle evidence. Defaults to nothing: a library that writes to
   * stdout by default makes a test suite noisy and a host's log format someone else's
   * decision.
   */
  onEvidence?: (evidence: RuntimeEvidence) => void;
};

export type RuntimeStartupErrorCode =
  | 'RUNTIME_DATABASE_UNREACHABLE'
  | 'RUNTIME_MIGRATIONS_PENDING'
  | 'RUNTIME_SCHEMA_INCOMPATIBLE'
  | 'RUNTIME_STARTUP_TIMEOUT';

export class RuntimeStartupError extends Error {
  readonly code: RuntimeStartupErrorCode;

  constructor(code: RuntimeStartupErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'RuntimeStartupError';
    this.code = code;
  }
}

function defaultMigrationsDirectory(): string {
  return path.resolve(process.cwd(), 'supabase/migrations');
}

/**
 * Fails a promise that takes too long, so a hanging connect cannot hold startup open.
 *
 * The timer is cleared in `finally` and the operation is *not* awaited before the race —
 * awaiting it first would resolve it before the timeout could ever win, which is a shape
 * this repository has already been bitten by and now forbids statically.
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  seconds: number,
  code: RuntimeStartupErrorCode,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RuntimeStartupError(code, `${what} exceeded ${seconds}s`)),
          seconds * 1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Builds the runtime, in an order where each step depends on the last having succeeded.
 *
 * Configuration, then pool, then connectivity, then migration ledger, then schema, then
 * the store, and only then ready. Marking ready after connectivity alone would accept
 * work against a database with no tables.
 */
export async function createPersistenceRuntime(
  options: PersistenceRuntimeOptions = {},
): Promise<PersistenceRuntime> {
  const runtimeId = randomUUID();
  const config = options.config ?? loadPersistenceConfig(options.environment);
  const emit = (event: string, detail?: Record<string, unknown>) =>
    options.onEvidence?.({ runtimeId, event, at: new Date().toISOString(), detail });
  const migrations = options.migrationsDirectory ?? defaultMigrationsDirectory();

  emit('runtime.initializing', describePersistenceConfig(config));

  if (config.adapter === 'memory') {
    // Only reachable in development and test: `loadPersistenceConfig` rejects a memory
    // adapter for every durable deployment class before this point.
    const runtime = memoryRuntime(runtimeId, config, emit);
    emit('runtime.ready', { adapter: 'memory' });
    return runtime;
  }

  let pool: PostgresPool | undefined;
  try {
    pool = createPostgresPool({
      databaseUrl: config.databaseUrl ?? '',
      max: config.poolMax,
      ssl: config.ssl,
      connectTimeoutSeconds: config.connectTimeoutSeconds,
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      statementTimeoutSeconds: config.statementTimeoutSeconds,
      applicationName: config.applicationName,
    });

    const connectivity = await withTimeout(
      () => checkConnectivity(pool!.sql),
      config.startupTimeoutSeconds,
      'RUNTIME_STARTUP_TIMEOUT',
      'connecting to the database',
    );
    if (!connectivity.reachable)
      throw new RuntimeStartupError(
        'RUNTIME_DATABASE_UNREACHABLE',
        connectivity.failure ?? 'the database did not answer',
      );
    emit('runtime.connected', { serverVersion: connectivity.serverVersion });

    if (config.verifyMigrations || config.verifySchema) {
      const compatibility = await withTimeout(
        () => verifySchemaCompatibility(pool!.sql, migrations),
        config.startupTimeoutSeconds,
        'RUNTIME_STARTUP_TIMEOUT',
        'verifying the schema',
      );

      // Verified, never applied. A host that migrated on startup would let any instance
      // that happened to boot first alter the schema under the others, and would put a
      // schema change on the same path as a page load.
      if (config.verifyMigrations && compatibility.pendingRequired.length > 0)
        throw new RuntimeStartupError(
          'RUNTIME_MIGRATIONS_PENDING',
          `${compatibility.pendingRequired.length} required migration(s) have not been applied; run the migration runner before starting this host`,
        );
      if (config.verifyMigrations && compatibility.divergent.length > 0)
        throw new RuntimeStartupError(
          'RUNTIME_SCHEMA_INCOMPATIBLE',
          `${compatibility.divergent.length} applied migration(s) no longer match their files`,
        );
      if (config.verifySchema && compatibility.missingTables.length > 0)
        throw new RuntimeStartupError(
          'RUNTIME_SCHEMA_INCOMPATIBLE',
          `missing required table(s): ${compatibility.missingTables.join(', ')}`,
        );
      // Non-required pending migrations are reported rather than fatal: they belong to a
      // bounded context this runtime does not read, and an operator should still see that
      // the database is behind the repository.
      emit('runtime.schema-verified', {
        pending: compatibility.pending.length,
        pendingRequired: compatibility.pendingRequired.length,
        divergent: compatibility.divergent.length,
      });
    }

    const runtime = postgresRuntime(runtimeId, config, pool, migrations, emit);
    emit('runtime.ready', { adapter: 'postgres' });
    return runtime;
  } catch (error) {
    // Partial resources are released. A failed startup that left a pool open would hold
    // connections a retry then cannot get.
    if (pool) await pool.dispose().catch(() => undefined);
    emit('runtime.startup-failed', { failure: describeFailure(error) });
    throw error;
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof RuntimeStartupError) return error.message;
  return sanitizeDatabaseFailure(error);
}

function memoryRuntime(
  runtimeId: string,
  config: PersistenceRuntimeConfig,
  emit: (event: string, detail?: Record<string, unknown>) => void,
): PersistenceRuntime {
  const store = new InMemoryTrustStore();
  let state: PersistenceRuntimeState = 'ready';

  return {
    runtimeId,
    store,
    adapter: 'memory',
    config,
    getState: () => state,
    async checkReadiness() {
      return {
        ready: state === 'ready',
        code: state === 'ready' ? 'READY' : state === 'shutting-down' ? 'SHUTTING_DOWN' : 'POOL_CLOSED',
        checkedAt: new Date().toISOString(),
      };
    },
    isAlive: () => state !== 'disposed',
    async dispose() {
      if (state === 'disposed') return;
      state = 'disposed';
      emit('runtime.disposed', { adapter: 'memory' });
    },
  };
}

function postgresRuntime(
  runtimeId: string,
  config: PersistenceRuntimeConfig,
  pool: PostgresPool,
  migrations: string,
  emit: (event: string, detail?: Record<string, unknown>) => void,
): PersistenceRuntime {
  const store = new PostgresTrustStore(pool.sql);
  let state: PersistenceRuntimeState = 'ready';

  return {
    runtimeId,
    store,
    adapter: 'postgres',
    config,
    getState: () => state,

    async checkReadiness(): Promise<PersistenceReadiness> {
      const checkedAt = new Date().toISOString();
      if (state === 'shutting-down')
        return { ready: false, code: 'SHUTTING_DOWN', checkedAt };
      if (state === 'disposed') return { ready: false, code: 'POOL_CLOSED', checkedAt };

      const connectivity = await checkConnectivity(pool.sql);
      if (!connectivity.reachable) {
        // Degraded, not disposed: the database may come back, and a runtime that tore
        // itself down on a transient failure would need a process restart to recover.
        state = 'degraded';
        emit('runtime.unready', { code: 'DATABASE_UNREACHABLE' });
        return {
          ready: false,
          code: 'DATABASE_UNREACHABLE',
          detail: connectivity.failure,
          checkedAt,
        };
      }

      if (config.verifySchema) {
        const compatibility = await verifySchemaCompatibility(pool.sql, migrations).catch(
          () => undefined,
        );
        if (!compatibility || compatibility.missingTables.length > 0) {
          state = 'degraded';
          emit('runtime.unready', { code: 'SCHEMA_INCOMPATIBLE' });
          return {
            ready: false,
            code: 'SCHEMA_INCOMPATIBLE',
            detail: compatibility
              ? `missing required table(s): ${compatibility.missingTables.join(', ')}`
              : 'the schema could not be read',
            checkedAt,
          };
        }
        if (config.verifyMigrations && compatibility.pendingRequired.length > 0) {
          state = 'degraded';
          emit('runtime.unready', { code: 'MIGRATIONS_PENDING' });
          return {
            ready: false,
            code: 'MIGRATIONS_PENDING',
            detail: `${compatibility.pendingRequired.length} required migration(s) pending`,
            checkedAt,
          };
        }

        // Ownership, after the tables exist and the migrations are in. Readiness must not be
        // satisfiable by "both schemas are present" — that was true of every database before
        // this capability, and it is the condition it exists to refuse. Findings are reported
        // by code and table only: the detail reaches logs, and a policy expression or a
        // connection string never should.
        // No schema passed: it is resolved from the connection's own `search_path`, so the
        // certification reads the schema the store actually writes rather than assuming one.
        const ownership = await certifySchemaOwnership(pool.sql).catch(() => undefined);
        if (!ownership || !ownership.safeToServe) {
          state = 'degraded';
          emit('runtime.unready', { code: 'SCHEMA_OWNERSHIP_UNRECONCILED' });
          return {
            ready: false,
            code: 'SCHEMA_OWNERSHIP_UNRECONCILED',
            detail: ownership
              ? ownership.findings
                  .filter((finding) => finding.severity === 'error')
                  .slice(0, 4)
                  .map((finding) => `${finding.code}${finding.table ? `:${finding.table}` : ''}`)
                  .join(', ')
              : 'schema ownership could not be read',
            checkedAt,
          };
        }
      }

      if (state === 'degraded') emit('runtime.recovered', {});
      state = 'ready';
      return { ready: true, code: 'READY', checkedAt };
    },

    // Liveness says only that the process is running. Conflating it with readiness makes
    // an orchestrator restart a healthy process because its database blinked.
    isAlive: () => state !== 'disposed',

    async dispose() {
      if (state === 'disposed') return;
      state = 'shutting-down';
      emit('runtime.shutting-down', {});
      await pool.dispose();
      state = 'disposed';
      emit('runtime.disposed', { adapter: 'postgres' });
    },
  };
}

export type ProtectedWorkGateErrorCode = 'PERSISTENCE_NOT_READY';

/**
 * Refuses protected work when persistence is not ready.
 *
 * A separate gate from authorization, and both apply: a caller may be perfectly
 * authorized while the store cannot record what they did. Beginning a governed mutation
 * in that state produces a state change with no audit record, or a response reporting a
 * change that never landed.
 */
export class ProtectedWorkGateError extends Error {
  readonly code: ProtectedWorkGateErrorCode = 'PERSISTENCE_NOT_READY';
  readonly readiness: PersistenceReadiness;

  constructor(readiness: PersistenceReadiness) {
    super(`PERSISTENCE_NOT_READY: ${readiness.code}`);
    this.name = 'ProtectedWorkGateError';
    this.readiness = readiness;
  }
}

export async function requirePersistenceReady(
  runtime: PersistenceRuntime,
): Promise<PersistenceReadiness> {
  const readiness = await runtime.checkReadiness();
  if (!readiness.ready) throw new ProtectedWorkGateError(readiness);
  return readiness;
}

export { isDurableDeployment };

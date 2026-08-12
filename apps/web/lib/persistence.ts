import type { AuditRecord, OutboxEvent, TrustPersistence } from '@assurapay/shared';
import { createPersistenceRuntime, requirePersistenceReady } from '@assurapay/runtime';
import type { PersistenceReadiness, PersistenceRuntime } from '@assurapay/runtime';

/**
 * The web application's persistence runtime — one per process, obtained once.
 *
 * `trust-app.ts` previously did this:
 *
 *     export const trustStore = (globalTrust.assurapayTrustStore ??= new InMemoryTrustStore());
 *
 * which is a production composition root constructing volatile storage unconditionally.
 * Every grant, membership and audit record the deployed application wrote was lost when
 * the process recycled, and nothing reported it: the application kept answering and
 * authorization kept deciding, against a store that had forgotten the last deploy.
 *
 * Persistence is now chosen by `createPersistenceRuntime` from validated server-only
 * configuration, which refuses an in-memory adapter for every durable deployment class.
 * There is no fallback here, no `databaseUrl ? postgres : memory`, and no `catch` that
 * substitutes a store — a failed initialization makes every repository call reject.
 */

const globalRuntime = globalThis as typeof globalThis & {
  assurapayPersistenceRuntime?: Promise<PersistenceRuntime>;
};

/**
 * The runtime, created at most once per process.
 *
 * Cached on `globalThis` because Next.js re-evaluates modules across dev-server reloads
 * and route bundles, and a module-level `let` would give each of them its own pool. The
 * promise is cached, not the resolved value, so two concurrent first requests await one
 * initialization instead of racing to create two pools.
 */
export function getPersistenceRuntime(): Promise<PersistenceRuntime> {
  globalRuntime.assurapayPersistenceRuntime ??= createPersistenceRuntime({
    // Hosts may launch Next from apps/web while migrations remain at the repository root.
    // Keep migration verification enabled and make that deployment path explicit rather than
    // deriving repository layout from process.cwd().
    migrationsDirectory: process.env.ASSURAPAY_MIGRATIONS_DIRECTORY,
    // Sanitized lifecycle evidence. Structured rather than prose so a log processor can
    // read it; never carries a URL, credential or parameter value.
    onEvidence: (evidence) => {
      if (process.env.VITEST) return;
      console.info(JSON.stringify({ component: 'persistence-runtime', ...evidence }));
    },
  });
  return globalRuntime.assurapayPersistenceRuntime;
}

/**
 * A `TrustPersistence` that resolves the runtime on first use.
 *
 * The composition root builds its engine objects at module load, and 161 route handlers
 * import those objects directly. Making initialization asynchronous without this would
 * mean rewriting every one of them.
 *
 * This defers; it does not fall back. Each method awaits the same runtime promise and
 * delegates to the real store. If initialization failed, every call rejects with that
 * failure — the engines are never handed a substitute, and no caller is told a write
 * succeeded against a store that was never built.
 */
class RuntimeTrustStore implements TrustPersistence {
  private async resolve(): Promise<TrustPersistence> {
    return (await getPersistenceRuntime()).store;
  }

  async list<T>(collection: string): Promise<T[]> {
    return await (await this.resolve()).list<T>(collection);
  }

  async append<T>(collection: string, value: T): Promise<void> {
    await (await this.resolve()).append(collection, value);
  }

  async replace<T extends { id: string }>(collection: string, value: T): Promise<void> {
    await (await this.resolve()).replace(collection, value);
  }

  async audit(
    input: Omit<AuditRecord, 'id' | 'createdAt' | 'integrityHash' | 'previousHash'>,
  ): Promise<AuditRecord> {
    return await (await this.resolve()).audit(input);
  }

  async emit(input: Omit<OutboxEvent, 'id' | 'occurredAt'>): Promise<OutboxEvent> {
    return await (await this.resolve()).emit(input);
  }

  /**
   * Transactions delegate to the underlying store's own.
   *
   * The callback receives the real transaction-scoped repository, not another instance of
   * this class — routing each nested call back through the runtime would put the inner
   * writes on a different connection, outside the transaction they appear to be inside.
   */
  async transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T> {
    return await (await this.resolve()).transaction(operation);
  }
}

/** The repository every engine in this application is composed with. */
export const trustStore: TrustPersistence = new RuntimeTrustStore();

/**
 * Refuses protected work when persistence is not ready.
 *
 * Called from the authorization funnel, so it applies to every protected route without a
 * handler having to remember it. Both gates are required and neither substitutes for the
 * other: a caller may be perfectly authorized while the store cannot record what they
 * did, and a governed mutation in that state produces either a state change with no audit
 * record or a response describing a change that never landed.
 */
export async function requireReadyPersistence(): Promise<PersistenceReadiness> {
  return await requirePersistenceReady(await getPersistenceRuntime());
}

/**
 * Releases the runtime.
 *
 * Idempotent, and safe to call when no runtime was ever created — a host that shuts down
 * before serving a request must not fail on the way out.
 */
export async function disposePersistenceRuntime(): Promise<void> {
  const pending = globalRuntime.assurapayPersistenceRuntime;
  if (!pending) return;
  globalRuntime.assurapayPersistenceRuntime = undefined;
  // A runtime that failed to initialize has nothing to release, and rethrowing here would
  // turn a clean shutdown into a crash.
  const runtime = await pending.catch(() => undefined);
  await runtime?.dispose();
}

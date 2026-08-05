import { disposePersistenceRuntime } from './persistence';

/**
 * Graceful shutdown for the persistence runtime.
 *
 * Registered once per process, from `instrumentation.ts`, which Next.js runs on the server
 * before anything serves a request.
 *
 * The sequence matters. Readiness goes false first, so an orchestrator stops routing to
 * this host before its pool closes; then the pool is released. Closing the pool first
 * would fail in-flight requests with connection errors after they had already been
 * accepted and, for a governed mutation, possibly after the mutation but before its audit
 * record.
 *
 * Idempotent, because SIGTERM can arrive twice and a hard SIGKILL usually follows a grace
 * period — a second handler run must not throw on a pool that is already closed.
 */

let registered = false;

export function registerPersistenceShutdown(): void {
  if (registered) return;
  registered = true;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await disposePersistenceRuntime();
      console.info(
        JSON.stringify({ component: 'persistence-runtime', event: 'shutdown.complete', signal }),
      );
    } catch (error) {
      // Reported, never rethrown: an exception here replaces a clean exit with a crash and
      // tells an operator nothing they can act on beyond what this line already says.
      console.error(
        JSON.stringify({
          component: 'persistence-runtime',
          event: 'shutdown.failed',
          signal,
          failure: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  };

  // `once`, so a repeated signal cannot start a second teardown alongside the first.
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  // The last resort: a process exiting for any other reason still releases its pool rather
  // than leaving the database holding a connection until its own idle timeout.
  process.once('beforeExit', () => void shutdown('beforeExit'));
}

/**
 * Next.js server instrumentation.
 *
 * Runs once per server process, before any request is served, which is the only place a
 * Next.js application can register process-level signal handlers. Without it the pool is
 * released only by the database's own idle timeout, and a rolling deploy leaves the
 * previous generation's connections held against the new one's budget.
 */
export async function register(): Promise<void> {
  // Server runtimes only. The edge runtime has no process signals, and importing the pool
  // there would pull the driver into a bundle that cannot use it.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerPersistenceShutdown } = await import('./lib/shutdown');
  registerPersistenceShutdown();
}

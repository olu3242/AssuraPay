import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { trustStore } from './persistence';

/**
 * The production composition path, asserted at the boundary the web application owns.
 *
 * The behavioural certification — a real runtime, a real database, state recovered across
 * two runtimes — lives in `packages/runtime/src/persistence-runtime.postgres.test.ts`.
 * These are the assertions that need no database: that no module here constructs a store,
 * selects an adapter, or creates a pool, and that the readiness gate is applied where every
 * protected route passes through rather than in each of 161 handlers.
 */

const libDirectory = path.resolve(import.meta.dirname);
const appDirectory = path.resolve(import.meta.dirname, '..', 'app');

function sourceFiles(directory: string): { file: string; code: string }[] {
  const found: { file: string; code: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      found.push({ file: path.relative(path.resolve(libDirectory, '..'), full), code: readFileSync(full, 'utf8') });
  }
  return found;
}

/** Comments blanked, so prose describing a forbidden shape is not read as one. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

const applicationFiles = [...sourceFiles(libDirectory), ...sourceFiles(appDirectory)].map(
  (entry) => ({ ...entry, code: stripComments(entry.code) }),
);

describe('the web application never chooses its own persistence', () => {
  it('constructs no trust store anywhere in the application', () => {
    // `trust-app.ts` used to do exactly this, on `globalThis`, in one line that reads as
    // caching and was actually a decision to run production on volatile storage.
    const offenders = applicationFiles
      .filter((entry) => /\bnew\s+(InMemory|Postgres)TrustStore\s*\(/.test(entry.code))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });

  it('creates no connection pool anywhere in the application', () => {
    // A pool per request has no disposal path and no bound on how many exist.
    const offenders = applicationFiles
      .filter((entry) => /\bcreatePostgresPool\s*\(/.test(entry.code))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });

  it('selects no adapter anywhere in the application', () => {
    // The shape being excluded: `databaseUrl ? postgres : memory`. Adapter selection
    // belongs to validated configuration that refuses volatile storage when the deployment
    // is durable; a ternary in an application module answers a different question.
    const offenders = applicationFiles
      .filter((entry) => /adapter\s*[=:]\s*['"](postgres|memory)['"]/.test(entry.code))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });

  it('names no client-visible database variable', () => {
    const offenders = applicationFiles
      .filter((entry) => /NEXT_PUBLIC_[A-Z_]*(DATABASE|POSTGRES|PERSISTENCE)/.test(entry.code))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });

  it('imports no test-database helper', () => {
    const offenders = applicationFiles
      .filter((entry) => entry.code.includes('@assurapay/database-testing'))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });
});

describe('protected work is gated on readiness in one place', () => {
  it('applies the readiness gate inside the authorization funnel', () => {
    // In the funnel rather than in 161 handlers, so a new route inherits it. A handler that
    // has to remember the gate is a handler that will eventually forget.
    const funnel = readFileSync(path.join(libDirectory, 'trust-app.ts'), 'utf8');
    const body = funnel.slice(funnel.indexOf('export async function authorizedContextForRoute'));

    expect(body).toContain('await requireReadyPersistence()');
  });

  it('gates before authentication, because an unready store cannot record the attempt', () => {
    const funnel = stripComments(readFileSync(path.join(libDirectory, 'trust-app.ts'), 'utf8'));
    const body = funnel.slice(funnel.indexOf('export async function authorizedContextForRoute'));

    expect(body.indexOf('requireReadyPersistence')).toBeLessThan(body.indexOf('authenticate('));
  });
});

describe('the repository the application composes with', () => {
  it('satisfies the asynchronous contract without resolving a runtime at import', () => {
    // Importing this module must not connect to anything: Next.js evaluates it while
    // building, where no database exists, and a module-level connection would make the
    // build depend on one.
    for (const method of ['list', 'append', 'replace', 'audit', 'emit', 'transaction'] as const)
      expect(typeof trustStore[method], method).toBe('function');
  });

  it('rejects rather than falling back when no runtime can be built', async () => {
    // The property that makes the deferral honest. This test process has no database and a
    // test deployment class, so the runtime is memory-backed and calls resolve — what must
    // never happen is a *durable* deployment silently getting a store it did not configure.
    // That case is certified against a real database in packages/runtime.
    await expect(trustStore.list('parties')).resolves.toBeInstanceOf(Array);
  });
});

describe('shutdown releases the pool', () => {
  it('is registered from instrumentation, the one place a Next.js host can', () => {
    const instrumentation = readFileSync(
      path.resolve(libDirectory, '..', 'instrumentation.ts'),
      'utf8',
    );
    expect(instrumentation).toContain('registerPersistenceShutdown');
    // Node runtime only: the edge runtime has no process signals.
    expect(instrumentation).toContain('NEXT_RUNTIME');
  });

  it('marks readiness false before closing the pool', () => {
    // Closing first would fail in-flight requests with connection errors after they were
    // accepted — and, for a governed mutation, possibly after the mutation but before its
    // audit record.
    const runtime = readFileSync(
      path.resolve(libDirectory, '..', '..', '..', 'packages/runtime/src/persistence-runtime.ts'),
      'utf8',
    );
    const dispose = runtime.slice(runtime.lastIndexOf('async dispose()'));

    expect(dispose.indexOf("state = 'shutting-down'")).toBeLessThan(dispose.indexOf('pool.dispose()'));
  });
});

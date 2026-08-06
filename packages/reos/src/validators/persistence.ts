import path from 'node:path';
import { readTextIfPresent, walkFiles } from '../util/fsx.ts';
import { declaresRuleVocabulary } from './exemption.ts';
import type { Finding } from '../types.ts';

/**
 * Static enforcement of the asynchronous persistence contract.
 *
 * `TrustPersistence` became asynchronous so a network-backed store could
 * implement it. That change is only durable if the shapes it forbids cannot come
 * back, and every one of them typechecks:
 *
 *   - a promise is truthy, so an unawaited governed write is invisible at the
 *     call site and silently lost on the durable path;
 *   - `void store.append(...)` compiles and reads as deliberate;
 *   - `.every(async …)` returns true for any non-empty list, because each
 *     predicate call yields a promise rather than a verdict;
 *   - `await provider.invoke(...)` inside `Promise.race` resolves before the
 *     timeout can win, disabling the bound it is raced against;
 *   - a method on the interface that returns a bare value re-imposes the
 *     synchronous constraint the migration removed.
 *
 * Each rule here corresponds to a defect that was actually found during the
 * migration, not to a hypothetical one. They are reported through the
 * architecture validator rather than as a twelfth certification step, because
 * they are boundary invariants of the same kind it already enforces.
 */

/** Methods on `TrustPersistence` that perform a governed write. */
const GOVERNED_WRITES = ['append', 'audit', 'emit', 'replace', 'transaction'];

/** Array methods whose predicate is called synchronously and cannot await. */
const SYNCHRONOUS_ARRAY_METHODS = [
  'every',
  'some',
  'filter',
  'find',
  'findLast',
  'findIndex',
  'findLastIndex',
  'sort',
];

export type AsyncPersistenceRule = {
  rule: string;
  /** What the rule forbids, and what goes wrong when it is violated. */
  rationale: string;
};

export const ASYNC_PERSISTENCE_RULES: readonly AsyncPersistenceRule[] = Object.freeze([
  {
    rule: 'persistence/sync-interface-method',
    rationale:
      'A TrustPersistence method returning a bare value cannot be implemented over a network, which is the constraint the asynchronous interface exists to remove.',
  },
  {
    rule: 'persistence/floating-governed-write',
    rationale:
      'An unawaited append, audit, emit, replace or transaction resolves after the caller has already reported success, so the audit trail loses records the response claimed were written.',
  },
  {
    rule: 'persistence/voided-governed-write',
    rationale:
      'Marking a governed write as intentionally ignored is never correct: history is append-only, and a discarded write is a missing record no reader can detect.',
  },
  {
    rule: 'persistence/async-predicate',
    rationale:
      'A synchronous array method calls its predicate and reads the return value immediately. An async predicate returns a promise, which is always truthy, so every, some and filter report the opposite of the truth.',
  },
  {
    rule: 'persistence/pre-awaited-race',
    rationale:
      'Awaiting a call inside Promise.race resolves it before the race begins, so the timeout it is raced against can never win and the bound is silently absent.',
  },
  {
    rule: 'persistence/driver-outside-adapter',
    rationale:
      'A driver import anywhere but the approved client module puts connection handling, error shapes and SQL construction in code that has no pool to manage, and makes replacing the driver a repository-wide edit rather than a one-file change.',
  },
  {
    rule: 'persistence/unsafe-sql',
    rationale:
      'Parameterization is what stops a tenant id, permission key or search term from being read as SQL. The driver binds interpolated values by default, so the only way to lose that is the unsafe escape hatch, which belongs to DDL alone.',
  },
  {
    rule: 'persistence/pool-outside-runtime',
    rationale:
      'A pool created in a handler, a service or an engine is a pool with no disposal path and no bound on how many exist. Connections then leak per request until the database refuses new ones.',
  },
  {
    rule: 'persistence/test-helper-in-production',
    rationale:
      'Test helpers create and drop databases and skip the checks production configuration performs. Reachable from production code, they turn a deployment into an unguarded schema operation.',
  },
  {
    rule: 'persistence/store-constructed-outside-runtime',
    rationale:
      'A store built in an application module is a store chosen by that module. Persistence must be selected once, from validated configuration that refuses volatile storage in a durable environment, or a single import quietly reintroduces the fallback the runtime exists to remove.',
  },
  {
    rule: 'persistence/client-database-variable',
    rationale:
      'A NEXT_PUBLIC_ variable is compiled into the browser bundle. One naming a database or a persistence mode publishes deployment topology and offers a client a say in where data goes.',
  },
  {
    rule: 'persistence/retired-table-reference',
    rationale:
      'A retired trust table is not the canonical owner of anything and no longer exists after reconciliation. SQL naming one either targets a model with no rows or resurrects a second writable model for an aggregate that already has an owner.',
  },
]);

/**
 * Trust-domain tables retired by `202608080001_trust_schema_ownership_reconciliation`.
 *
 * Restated here rather than imported from `@assurapay/database`: the validators must not
 * depend on the packages they validate, or a broken package takes the tool that would have
 * reported it down with it. `packages/database/src/schema-ownership.test.ts` pins the two
 * lists against each other, so drift fails a test rather than going unnoticed.
 */
const RETIRED_TRUST_TABLES = Object.freeze([
  'audit_records', 'authentication_methods', 'authority_rules', 'beneficiary_account_references',
  'consent_records', 'delegations', 'event_outbox', 'field_permissions', 'legal_entities',
  'legal_holds', 'legal_policies', 'legal_policy_versions', 'organization_units', 'organizations',
  'parties', 'permission_definitions', 'permission_grants', 'policy_acceptances',
  'policy_assignments', 'role_definitions', 'segregation_rules', 'signature_policies',
  'step_up_challenges', 'trusted_devices', 'user_sessions', 'verification_requests',
  'verification_results', 'workspace_invitations',
]);

/**
 * Modules allowed to name a retired table.
 *
 * The registry that records the retirement, and the validator's own vocabulary. Nothing else:
 * the point of retiring an object is that code stops referring to it.
 */
const RETIRED_TABLE_VOCABULARY = Object.freeze([
  'packages/database/src/schema-ownership.ts',
  'packages/reos/src/validators/persistence.ts',
  // The suite that certifies the retirement. It has to seed a retired table to prove the
  // migration refuses rather than discards, and recreate one to prove the certification
  // notices — neither of which is possible without naming them. A rule that forbade its own
  // evidence would be a rule nothing could demonstrate.
  'packages/database-testing/src/schema-ownership.postgres.test.ts',
]);

/**
 * Modules permitted to construct a store directly.
 *
 * The runtime, which selects between them from configuration, and the two stores' own
 * modules. Everything else — every handler, service, engine and composition root —
 * receives a `TrustPersistence` it did not choose.
 */
const STORE_CONSTRUCTION_MODULES = Object.freeze([
  'packages/runtime/src/persistence-runtime.ts',
  'packages/database/src/trust-store.ts',
  'packages/database/src/postgres-store.ts',
  'packages/database-testing/src/index.ts',
]);

/**
 * Modules permitted to name the PostgreSQL driver, and to create a pool.
 *
 * A short list on purpose. The point of the rule is that connection handling lives in one
 * place; a list that grows is the rule being negotiated away.
 */
const DRIVER_MODULES = Object.freeze([
  'packages/database/src/postgres-client.ts',
  'packages/database-testing/src/index.ts',
]);

/** Modules permitted to use the driver's unparameterized escape hatch. */
const UNSAFE_SQL_MODULES = Object.freeze([
  // DDL cannot be parameterized: a migration file is a statement list, not a value.
  'packages/database/src/migrations.ts',
  'packages/database/src/postgres-client.ts',
  'packages/database-testing/src/index.ts',
  // `SET LOCAL ROLE` and a table name in a count are identifiers, and PostgreSQL does not
  // bind identifiers. Every such use in this module passes through `quoteIdentifier`, which
  // refuses anything that is not a bare identifier — so the values that reach the statement
  // are a closed set the module itself defines, never anything from a request.
  'packages/database/src/rls-certification.ts',
]);

/** Test-only modules that production code must not reach. */
const TEST_HELPER_MODULES = Object.freeze(['@assurapay/database-testing']);

/**
 * Modules permitted to create the pool.
 *
 * The runtime, which owns exactly one per process and disposes it, plus the driver module
 * that implements creation and the test harness that needs its own.
 */
const POOL_CREATION_MODULES = Object.freeze([
  'packages/runtime/src/persistence-runtime.ts',
  'packages/database/src/postgres-client.ts',
  'packages/database-testing/src/index.ts',
]);

/**
 * The module that names the forbidden client variables in order to reject them.
 *
 * Scoped to this one rule rather than exempting the file wholesale: `config.ts` is
 * production code, and every other persistence rule still applies to it.
 */
const CLIENT_VARIABLE_VOCABULARY = Object.freeze(['packages/runtime/src/config.ts']);

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file);
}

/**
 * Blanks comment bodies while preserving line count and offsets.
 *
 * A comment can never be a violation, and a validator that reads its own prose as
 * code fails on the file explaining the rule — which is how a rule gets deleted
 * instead of obeyed. Line numbers must survive, because findings cite them.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix + ' '.repeat(match.length - prefix.length),
    );
}

/**
 * Source with comments blanked, or null when the file is absent or exempt.
 *
 * A file declaring `reos:rule-vocabulary` writes the forbidden shapes as fixture
 * data in order to prove the rule catches them, so its matches are the test, not
 * the violation. The exemption is the repository's existing one rather than a new
 * mechanism, so every use of it is still found by a single grep.
 */
function readCode(repoRoot: string, file: string): string | null {
  const text = readTextIfPresent(path.join(repoRoot, file));
  if (text === null || declaresRuleVocabulary(text)) return null;
  return stripComments(text);
}

function sourceFiles(repoRoot: string, roots: readonly string[]): string[] {
  const collected: string[] = [];
  for (const root of roots)
    collected.push(
      ...walkFiles(path.join(repoRoot, root), repoRoot).filter((file) =>
        /\.tsx?$/.test(file),
      ),
    );
  return collected.sort();
}

/**
 * Every method on the interface must declare a promise-returning signature.
 *
 * Read from the interface declaration rather than from an implementation: a class
 * may legitimately be `async` while the interface it satisfies is not, and it is
 * the interface that decides whether a Postgres adapter is possible.
 */
/**
 * Persistence contracts that must be asynchronous in every method.
 *
 * Both of them, not just the trust one. `AssuraRepository` is the Engine 06-60 contract, and it
 * carried exactly the defect `TrustPersistence` was fixed for: `getSnapshot(): Snapshot` and
 * `setSnapshot(...): void`, synchronous, across 115 call sites. A relational adapter cannot
 * implement either — JavaScript cannot block on I/O — so the only way to satisfy the old
 * signature was to hold the whole database in memory and return the cache, which is arrays
 * behind a PostgreSQL adapter rather than durability. Checking one contract and not the other
 * is how the second one stayed synchronous while the first was certified.
 */
const ASYNCHRONOUS_PERSISTENCE_CONTRACTS = Object.freeze([
  { name: 'TrustPersistence', location: 'packages/shared/src/trust.ts' },
  { name: 'AssuraRepository', location: 'packages/database/src/index.ts' },
]);

function checkInterfaceIsAsynchronous(repoRoot: string): Finding[] {
  return ASYNCHRONOUS_PERSISTENCE_CONTRACTS.flatMap(({ name, location }) =>
    checkOneContractIsAsynchronous(repoRoot, name, location),
  );
}

function checkOneContractIsAsynchronous(
  repoRoot: string,
  contract: string,
  location: string,
): Finding[] {
  const text = readTextIfPresent(path.join(repoRoot, location));
  if (text === null) return [];

  const declaration = text.match(
    new RegExp(String.raw`export interface ${contract}\s*\{([\s\S]*?)\n\}`),
  );
  if (!declaration) {
    return [
      {
        rule: 'persistence/sync-interface-method',
        severity: 'error',
        message: `${contract} is not declared as an interface in ${location}; the persistence contract cannot be checked.`,
        location,
        subject: contract,
      },
    ];
  }

  const findings: Finding[] = [];
  // Members are single-line in these declarations; a signature spanning lines would
  // still expose its return type on the line carrying the closing parenthesis.
  for (const line of declaration[1].split('\n')) {
    const member = line.match(/^\s{2}(\w+)(<[^>]*>)?\(.*\)\s*:\s*(.+);\s*$/);
    if (!member) continue;
    const [, name, , returnType] = member;
    if (/\bPromise</.test(returnType)) continue;
    findings.push({
      rule: 'persistence/sync-interface-method',
      severity: 'error',
      message: `${contract}.${name} returns ${returnType.trim()} rather than a Promise, so no network-backed store can implement it.`,
      location,
      subject: `${contract}.${name}`,
    });
  }
  return findings;
}

/**
 * A governed write whose promise is discarded.
 *
 * Matched on the statement's opening line, which is where the missing `await`
 * would go. A call used as an argument or an array element is preceded by `[`,
 * `(` or `,` and is excluded, since something else is responsible for awaiting
 * it — `Promise.all` over a list of writes is a legitimate shape.
 */
function checkFloatingWrites(repoRoot: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const call = new RegExp(
    String.raw`^\s*((?:this|tx|store|persistence|repository)(?:\.\w+)*)\.(${GOVERNED_WRITES.join('|')})\s*[(<]`,
  );

  for (const file of files) {
    const text = readCode(repoRoot, file);
    if (text === null) continue;
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      const match = line.match(call);
      if (!match) continue;

      // A statement continuing an argument list or array literal is awaited by
      // whatever opened it.
      const previous = lines
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.trim().length > 0);
      if (previous && /[[(,]$/.test(previous.trim())) continue;

      findings.push({
        rule: 'persistence/floating-governed-write',
        severity: 'error',
        message: `${file}:${index + 1} calls ${match[1]}.${match[2]} without awaiting it; the write may not have happened when the caller returns.`,
        location: `${file}:${index + 1}`,
        subject: `${file}:${match[1]}.${match[2]}`,
      });
    }
  }
  return findings;
}

/** `void` applied to a governed write — a discarded promise, stated deliberately. */
function checkVoidedWrites(repoRoot: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const voided = new RegExp(
    String.raw`\bvoid\s+([\w.]+)\.(${GOVERNED_WRITES.join('|')})\s*\(`,
  );

  for (const file of files) {
    const text = readCode(repoRoot, file);
    if (text === null) continue;

    for (const [index, line] of text.split('\n').entries()) {
      const match = line.match(voided);
      if (!match) continue;
      findings.push({
        rule: 'persistence/voided-governed-write',
        severity: 'error',
        message: `${file}:${index + 1} discards ${match[1]}.${match[2]} with void; a governed write may not be fire-and-forget.`,
        location: `${file}:${index + 1}`,
        subject: `${file}:${match[1]}.${match[2]}`,
      });
    }
  }
  return findings;
}

/** An async callback handed to an array method that cannot await it. */
function checkAsyncPredicates(repoRoot: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const predicate = new RegExp(
    String.raw`\.(${SYNCHRONOUS_ARRAY_METHODS.join('|')})\(\s*async\b`,
  );

  for (const file of files) {
    const text = readCode(repoRoot, file);
    if (text === null) continue;

    for (const [index, line] of text.split('\n').entries()) {
      const match = line.match(predicate);
      if (!match) continue;
      findings.push({
        rule: 'persistence/async-predicate',
        severity: 'error',
        message: `${file}:${index + 1} passes an async callback to .${match[1]}, which reads the returned promise as its verdict. Resolve the values first, then apply .${match[1]}.`,
        location: `${file}:${index + 1}`,
        subject: `${file}:${match[1]}`,
      });
    }
  }
  return findings;
}

/**
 * A raced call that was already awaited.
 *
 * Checked across lines, because the readable form puts each racer on its own
 * line and the `await` then sits at the start of the first one.
 */
function checkPreAwaitedRaces(repoRoot: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const text = readCode(repoRoot, file);
    if (text === null) continue;

    for (const match of text.matchAll(/Promise\.race\(\s*\[\s*(await\b)?/g)) {
      if (!match[1]) continue;
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({
        rule: 'persistence/pre-awaited-race',
        severity: 'error',
        message: `${file}:${line} awaits the first racer inside Promise.race, so nothing it is raced against can ever win.`,
        location: `${file}:${line}`,
        subject: `${file}:Promise.race`,
      });
    }
  }
  return findings;
}

/**
 * The driver is named in one module, the pool created in one place, and the
 * unparameterized escape hatch confined to DDL.
 *
 * Checked by import specifier and call shape rather than by convention, because each of
 * these reads as ordinary code at the site that gets it wrong: `import postgres from
 * 'postgres'` in a route handler is one line, and so is a pool created per request.
 */
function checkAdapterBoundaries(repoRoot: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const text = readCode(repoRoot, file);
    if (text === null) continue;
    const lines = text.split('\n');

    for (const [index, line] of lines.entries()) {
      const at = `${file}:${index + 1}`;

      // The driver, by name. Matched on the import specifier so a variable called
      // `postgres` is not mistaken for the package.
      if (
        /from\s+['"](postgres|pg|postgres\.js)['"]/.test(line) &&
        !DRIVER_MODULES.includes(file)
      )
        findings.push({
          rule: 'persistence/driver-outside-adapter',
          severity: 'error',
          message: `${at} imports the PostgreSQL driver. Only ${DRIVER_MODULES.join(' and ')} may name it; everything else depends on SqlClient.`,
          location: at,
          subject: file,
        });

      if (/\.unsafe\s*\(/.test(line) && !UNSAFE_SQL_MODULES.includes(file) && !isTestFile(file))
        findings.push({
          rule: 'persistence/unsafe-sql',
          severity: 'error',
          message: `${at} calls the driver's unparameterized escape hatch. Interpolate values into a tagged template instead, which binds them as parameters.`,
          location: at,
          subject: file,
        });

      if (
        /\bcreatePostgresPool\s*\(/.test(line) &&
        !isTestFile(file) &&
        !POOL_CREATION_MODULES.includes(file)
      )
        findings.push({
          rule: 'persistence/pool-outside-runtime',
          severity: 'error',
          message: `${at} creates a connection pool. Pools belong to the application runtime, which owns exactly one and disposes it.`,
          location: at,
          subject: file,
        });

      // A store built anywhere but the runtime is a store chosen by that module. This is
      // the rule that would have caught `trust-app.ts`'s
      // `globalThis.assurapayTrustStore ??= new InMemoryTrustStore()` — a production
      // composition root selecting volatile storage in one line that reads as caching.
      if (
        /\bnew\s+(InMemory|Postgres)TrustStore\s*\(/.test(line) &&
        !isTestFile(file) &&
        !STORE_CONSTRUCTION_MODULES.includes(file)
      )
        findings.push({
          rule: 'persistence/store-constructed-outside-runtime',
          severity: 'error',
          message: `${at} constructs a trust store directly. Obtain one from the persistence runtime, which selects the adapter from validated configuration and refuses volatile storage in a durable environment.`,
          location: at,
          subject: file,
        });

      // A client-visible variable naming a database. Matched on the name, so it is caught
      // in configuration code, a Next.js config file, or a deployment manifest alike.
      if (
        /NEXT_PUBLIC_[A-Z_]*(DATABASE|POSTGRES|PERSISTENCE)[A-Z_]*/.test(line) &&
        !isTestFile(file) &&
        !CLIENT_VARIABLE_VOCABULARY.includes(file)
      )
        findings.push({
          rule: 'persistence/client-database-variable',
          severity: 'error',
          message: `${at} references a NEXT_PUBLIC_ variable naming a database or persistence mode. Such a variable is compiled into the browser bundle; use the server-only equivalent.`,
          location: at,
          subject: file,
        });

      // SQL naming a retired trust table. Matched only in statement position, so a
      // TypeScript identifier that happens to share the name — `permissionGrants`, a
      // `parties` variable — is not a finding; what is forbidden is querying the object.
      if (!RETIRED_TABLE_VOCABULARY.includes(file)) {
        const sqlReference = line.match(
          new RegExp(
            String.raw`(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+"?(` +
              RETIRED_TRUST_TABLES.join('|') +
              String.raw`)"?\b`,
            'i',
          ),
        );
        if (sqlReference)
          findings.push({
            rule: 'persistence/retired-table-reference',
            severity: 'error',
            message: `${at} issues SQL against ${sqlReference[1]}, which was retired by 202608080001_trust_schema_ownership_reconciliation. The canonical owner is a trust_* table; see packages/database/src/schema-ownership.ts.`,
            location: at,
            subject: file,
          });
      }

      if (isTestFile(file)) continue;
      for (const helper of TEST_HELPER_MODULES)
        if (new RegExp(String.raw`from\s+['"][^'"]*${helper}['"]`).test(line))
          findings.push({
            rule: 'persistence/test-helper-in-production',
            severity: 'error',
            message: `${at} imports the test-database helper ${helper} from production code. It creates and drops databases and skips production configuration checks.`,
            location: at,
            subject: file,
          });
    }
  }

  return findings;
}

/**
 * Collects every asynchronous-persistence finding across the given roots.
 *
 * Test files are scanned for async predicates and pre-awaited races — a test can
 * assert the wrong thing for exactly the same reason production code can — but
 * exempted from the floating-write rule, where a deliberately unawaited call is
 * sometimes the thing under test.
 */
export function collectAsyncPersistenceFindings(
  repoRoot: string,
  roots: readonly string[] = ['packages', 'apps'],
): Finding[] {
  const files = sourceFiles(repoRoot, roots);
  const production = files.filter((file) => !isTestFile(file));

  return [
    ...checkInterfaceIsAsynchronous(repoRoot),
    ...checkFloatingWrites(repoRoot, production),
    ...checkVoidedWrites(repoRoot, production),
    ...checkAsyncPredicates(repoRoot, files),
    ...checkPreAwaitedRaces(repoRoot, files),
    ...checkAdapterBoundaries(repoRoot, files),
  ];
}

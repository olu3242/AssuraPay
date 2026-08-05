/*
 * reos:rule-vocabulary — fixtures write the forbidden shapes in order to test the
 * validator that forbids them.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASYNC_PERSISTENCE_RULES,
  RULE_VOCABULARY_TOKEN,
  collectAsyncPersistenceFindings,
} from './index.ts';
import { readTextIfPresent, walkFiles } from './util/fsx.ts';

/** Referenced indirectly so this file's own assertion does not carry the token twice. */
const TOKEN = RULE_VOCABULARY_TOKEN;

/**
 * The asynchronous persistence rules, tested by planting each violation.
 *
 * A static rule that has never fired is indistinguishable from one that cannot.
 * Every case here writes the exact shape a defect took during the migration, so
 * the rule is proven to catch it rather than asserted to.
 */

const scratchDirectories: string[] = [];

function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reos-persistence-'));
  scratchDirectories.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, 'utf8');
  }
  return root;
}

/** The contract as it stands, so a fixture only tests the rule it is about. */
const ASYNC_INTERFACE = `export interface TrustPersistence {
  list<T>(collection: string): Promise<T[]>;
  append<T>(collection: string, value: T): Promise<void>;
  audit(input: AuditInput): Promise<AuditRecord>;
  emit(input: OutboxInput): Promise<OutboxEvent>;
  transaction<T>(operation: (tx: TrustPersistence) => Promise<T>): Promise<T>;
}
`;

function rulesFired(findings: { rule: string }[]): string[] {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('persistence rules: the interface must be implementable over a network', () => {
  it('reports a method that returns a bare value', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': `export interface TrustPersistence {
  list<T>(collection: string): T[];
  append<T>(collection: string, value: T): Promise<void>;
}
`,
    });

    const findings = collectAsyncPersistenceFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('persistence/sync-interface-method');
    expect(findings[0].subject).toBe('TrustPersistence.list');
    expect(findings[0].message).toContain('T[]');
  });

  it('accepts the asynchronous contract', () => {
    const root = fakeRepo({ 'packages/shared/src/trust.ts': ASYNC_INTERFACE });
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('reports the interface having been replaced by something else entirely', () => {
    // A type alias or a class would pass a "does the name exist" probe while
    // removing the declaration the contract is read from.
    const root = fakeRepo({
      'packages/shared/src/trust.ts': 'export type TrustPersistence = Record<string, unknown>;\n',
    });

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/sync-interface-method']);
    expect(findings[0].subject).toBe('TrustPersistence');
  });
});

describe('persistence rules: a governed write may not float', () => {
  const withInterface = (source: string) => ({
    'packages/shared/src/trust.ts': ASYNC_INTERFACE,
    'packages/engine/src/index.ts': source,
  });

  it('reports an unawaited audit call', () => {
    const root = fakeRepo(
      withInterface(`export class Engine {
  async act() {
    this.store.audit({
      eventType: 'ThingHappened',
    });
  }
}
`),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/floating-governed-write']);
    expect(findings[0].location).toBe('packages/engine/src/index.ts:3');
  });

  it('accepts the same call once awaited', () => {
    const root = fakeRepo(
      withInterface(`export class Engine {
  async act() {
    await this.store.audit({ eventType: 'ThingHappened' });
    return this.store.append('things', { id: 'x' });
  }
}
`),
    );
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('accepts a write that is an element of a list something else awaits', () => {
    // `Promise.all` over writes is legitimate. A rule that flagged it would be
    // switched off, taking the real cases with it.
    const root = fakeRepo(
      withInterface(`export class Engine {
  async act() {
    await Promise.all([
      this.store.append('a', 1),
      this.store.append('b', 2),
    ]);
  }
}
`),
    );
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('reports a write discarded with void', () => {
    const root = fakeRepo(
      withInterface(`export class Engine {
  act() {
    void this.store.emit({ eventType: 'ThingHappened' });
  }
}
`),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/voided-governed-write']);
  });

  it('exempts test files, where an unawaited write can be the thing under test', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/engine.test.ts': `it('rejects', () => {
  store.append('things', { id: 'x' });
});
`,
    });
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });
});

describe('persistence rules: a synchronous array method cannot await', () => {
  it('reports an async predicate, in production code and in tests alike', () => {
    // A test asserting through `.filter(async …)` is as wrong as production code
    // doing it, and reports a pass either way.
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/index.ts': `export const gate = (ids: string[]) =>
  ids.every(async (id) => await check(id));
`,
      'packages/engine/src/engine.test.ts': `const kept = rows.filter(async (row) => await allowed(row));
`,
    });

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/async-predicate']);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.subject).sort()).toEqual([
      'packages/engine/src/engine.test.ts:filter',
      'packages/engine/src/index.ts:every',
    ]);
  });

  it('accepts values resolved before the aggregate is applied', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/index.ts': `export async function gate(ids: string[]) {
  const results = await Promise.all(ids.map(async (id) => await check(id)));
  return results.every((result) => result);
}
`,
    });
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });
});

describe('persistence rules: a race must not be pre-decided', () => {
  it('reports an awaited first racer', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/index.ts': `export async function call() {
  return Promise.race([
    await provider.invoke(input),
    timeout(30_000),
  ]);
}
`,
    });

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/pre-awaited-race']);
    expect(findings[0].location).toBe('packages/engine/src/index.ts:2');
  });

  it('accepts a race whose racers are unresolved', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/index.ts': `export async function call() {
  return await Promise.race([provider.invoke(input), timeout(30_000)]);
}
`,
    });
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });
});

describe('persistence rules: the adapter boundary holds', () => {
  const withInterface = (files: Record<string, string>) => ({
    'packages/shared/src/trust.ts': ASYNC_INTERFACE,
    ...files,
  });

  it('reports a driver import outside the approved client module', () => {
    // One line in a route handler is all it takes to put connection handling somewhere
    // with no pool to manage and no disposal path.
    const root = fakeRepo(
      withInterface({
        'apps/web/app/api/route.ts': "import postgres from 'postgres';\nexport const GET = () => undefined;\n",
      }),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/driver-outside-adapter']);
    expect(findings[0].location).toBe('apps/web/app/api/route.ts:1');
  });

  it('permits the driver inside the module that owns it', () => {
    const root = fakeRepo(
      withInterface({
        'packages/database/src/postgres-client.ts': "import postgres from 'postgres';\nexport const x = 1;\n",
      }),
    );
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('reports the unparameterized escape hatch outside DDL', () => {
    const root = fakeRepo(
      withInterface({
        'packages/engine/src/index.ts':
          'export const find = (id: string) => sql.unsafe(`SELECT * FROM t WHERE id = ${id}`);\n',
      }),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/unsafe-sql']);
  });

  it('permits the escape hatch in the migration runner, where the SQL is a statement list', () => {
    const root = fakeRepo(
      withInterface({
        'packages/database/src/migrations.ts': 'await tx.unsafe(migration.sql);\n',
      }),
    );
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('reports a pool created outside the runtime', () => {
    // A pool per request is a pool with no bound on how many exist.
    const root = fakeRepo(
      withInterface({
        'apps/web/lib/handler.ts':
          "export async function handle() {\n  const pool = createPostgresPool({ databaseUrl });\n  return pool;\n}\n",
      }),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/pool-outside-runtime']);
  });

  it('reports production code importing the test-database helpers', () => {
    // They create and drop databases and skip every check production configuration
    // performs, so reaching them from production turns a deploy into a schema operation.
    const root = fakeRepo(
      withInterface({
        'apps/web/lib/app.ts':
          "import { createTestDatabase } from '@assurapay/database-testing';\nexport const x = createTestDatabase;\n",
      }),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/test-helper-in-production']);
  });

  it('reports a store constructed outside the runtime', () => {
    // The rule that would have caught the shape this replaced:
    // `globalThis.assurapayTrustStore ??= new InMemoryTrustStore()` in a production
    // composition root — one line that reads as caching and is actually a decision to run
    // on volatile storage.
    const root = fakeRepo(
      withInterface({
        'apps/web/lib/trust-app.ts':
          'export const trustStore = (global.x ??= new InMemoryTrustStore());\n',
      }),
    );

    const findings = collectAsyncPersistenceFindings(root);
    expect(rulesFired(findings)).toEqual(['persistence/store-constructed-outside-runtime']);
  });

  it('reports a durable store constructed outside the runtime too', () => {
    // Not only the memory one: a handler building its own PostgresTrustStore has chosen an
    // adapter, and would bypass the configuration that refuses volatile storage elsewhere.
    const root = fakeRepo(
      withInterface({
        'apps/web/lib/handler.ts': 'const store = new PostgresTrustStore(sql);\n',
      }),
    );

    expect(rulesFired(collectAsyncPersistenceFindings(root))).toEqual([
      'persistence/store-constructed-outside-runtime',
    ]);
  });

  it('permits the runtime to construct one, which is its job', () => {
    const root = fakeRepo(
      withInterface({
        'packages/runtime/src/persistence-runtime.ts':
          'const store = new PostgresTrustStore(pool.sql);\nconst pool = createPostgresPool(config);\n',
      }),
    );
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('reports a client-visible database variable', () => {
    // Compiled into the browser bundle: it publishes deployment topology and offers a
    // client a say in where data goes.
    const root = fakeRepo(
      withInterface({
        'apps/web/lib/config.ts': 'export const url = process.env.NEXT_PUBLIC_DATABASE_URL;\n',
      }),
    );

    expect(rulesFired(collectAsyncPersistenceFindings(root))).toEqual([
      'persistence/client-database-variable',
    ]);
  });

  it('permits a test importing them, which is what they are for', () => {
    const root = fakeRepo(
      withInterface({
        'packages/database/src/store.postgres.test.ts':
          "import { createTestDatabase } from '@assurapay/database-testing';\n",
      }),
    );
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });
});

describe('persistence rules: the vocabulary itself', () => {
  it('states a rationale for every rule', () => {
    for (const rule of ASYNC_PERSISTENCE_RULES) {
      expect(rule.rationale.length, rule.rule).toBeGreaterThan(60);
      expect(rule.rule.startsWith('persistence/'), rule.rule).toBe(true);
    }
  });

  it('has a test that fires every rule it declares', () => {
    // Kept honest by construction: adding a rule without a fixture fails here.
    const fired = new Set([
      'persistence/sync-interface-method',
      'persistence/floating-governed-write',
      'persistence/voided-governed-write',
      'persistence/async-predicate',
      'persistence/pre-awaited-race',
      'persistence/driver-outside-adapter',
      'persistence/unsafe-sql',
      'persistence/pool-outside-runtime',
      'persistence/test-helper-in-production',
      'persistence/store-constructed-outside-runtime',
      'persistence/client-database-variable',
    ]);
    expect(ASYNC_PERSISTENCE_RULES.map((rule) => rule.rule).filter((rule) => !fired.has(rule))).toEqual(
      [],
    );
    expect(fired.size).toBe(ASYNC_PERSISTENCE_RULES.length);
  });

  it('exempts a file that declares rule vocabulary, because its matches are fixture data', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/index.ts': `/* reos:rule-vocabulary — writes the shape in order to test the rule. */
export const fixture = 'ids.every(async (id) => await check(id))';
void store.append('things', 1);
`,
    });
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });

  it('keeps that exemption auditable by one grep, confined to the validator package', () => {
    // The exemption is a silencer if it spreads. Pinning its footprint means adding
    // it to an engine is a visible decision rather than a quiet one.
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const carriers = walkFiles(path.join(repoRoot, 'packages'), repoRoot)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => (readTextIfPresent(path.join(repoRoot, file)) ?? '').includes(TOKEN));

    expect(carriers.every((file) => file.startsWith('packages/reos/')), carriers.join(', ')).toBe(
      true,
    );
  });

  it('reads code, not prose: a comment describing a violation is not one', () => {
    const root = fakeRepo({
      'packages/shared/src/trust.ts': ASYNC_INTERFACE,
      'packages/engine/src/index.ts': `// Never write void this.store.append(...) or ids.every(async (id) => …).
/* A block comment may also mention this.store.audit({}) without being one. */
export const noop = () => undefined;
`,
    });
    expect(collectAsyncPersistenceFindings(root)).toEqual([]);
  });
});

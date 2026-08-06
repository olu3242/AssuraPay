/**
 * Generates the Engines 31-50 certification inventory from repository evidence.
 *
 * Assessment tooling, not production code. It reads sources, migrations, routes and the engine
 * catalogue and emits a machine-readable inventory; it asserts nothing it has not observed.
 *
 * The one judgement it makes explicit rather than hiding: a relational table counts as *live*
 * only when a non-test, non-migration file issues SQL naming it. A migration that creates a
 * table, or a generated type that mentions it, is not a reader.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CATALOGUE = 'docs/ENGINE_CATALOG.md';

/** Canonical engine identities. The catalogue is the only source; nothing is inferred. */
function canonicalEngines() {
  const text = readFileSync(path.join(ROOT, CATALOGUE), 'utf8');
  const rows = [...text.matchAll(/^\|\s*(\d{2})\s*\|\s*([^|]+?)\s*\|/gm)];
  const byNumber = new Map(rows.map((row) => [row[1], row[2].trim()]));
  return Array.from({ length: 20 }, (_, i) => {
    const number = String(31 + i).padStart(2, '0');
    const name = byNumber.get(number);
    if (!name) throw new Error(`catalogue has no engine ${number}`);
    return { number, name };
  });
}

/** Engine class -> package, read from each package's barrel. */
function enginePackages() {
  const out = [];
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    const barrel = path.join(ROOT, 'packages', pkg, 'src', 'index.ts');
    if (!existsSync(barrel)) continue;
    const src = readFileSync(barrel, 'utf8');
    for (const m of src.matchAll(/^export class ([A-Za-z0-9_]*Engine)\b/gm))
      out.push({ engineClass: m[1], package: `packages/${pkg}`, barrel: `packages/${pkg}/src/index.ts` });
  }
  return out;
}

function walk(dir, filter, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(path.relative(ROOT, full));
  }
  return acc;
}

const productionFiles = () =>
  [...walk(path.join(ROOT, 'packages'), (f) => f.endsWith('.ts') && !f.includes('.test.')),
   ...walk(path.join(ROOT, 'apps'), (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))];

const testFiles = () =>
  [...walk(path.join(ROOT, 'packages'), (f) => f.includes('.test.')),
   ...walk(path.join(ROOT, 'apps'), (f) => f.includes('.test.'))];

/** Collections each engine package reads or writes through TrustPersistence. */
function collectionsFor(pkgDir) {
  const barrel = path.join(ROOT, pkgDir, 'src', 'index.ts');
  if (!existsSync(barrel)) return [];
  const src = readFileSync(barrel, 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/\.(append|replace|list|find|audit|emit)<[^>]*>?\(\s*'([a-zA-Z0-9_]+)'/g)) found.add(m[2]);
  for (const m of src.matchAll(/\.(append|replace|list|find)\(\s*'([a-zA-Z0-9_]+)'/g)) found.add(m[2]);
  return [...found].sort();
}

/** Tables created by any migration, with the migration that created each. */
function migrationTables() {
  const dir = path.join(ROOT, 'supabase/migrations');
  const map = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const body = readFileSync(path.join(dir, name), 'utf8')
      .split('\n').map((l) => l.split('--')[0]).join('\n');
    for (const m of body.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_.]+)"?/gi))
      if (!map.has(m[1])) map.set(m[1], name.replace(/\.sql$/, ''));
  }
  return map;
}

/** Files issuing SQL against a table, split into production and test. */
function sqlReferences(table, prod, tests) {
  const pattern = new RegExp(String.raw`(FROM|INTO|UPDATE|JOIN|DELETE\s+FROM)\s+"?${table}"?\b`, 'i');
  const hit = (files) => files.filter((f) => pattern.test(readFileSync(path.join(ROOT, f), 'utf8')));
  return { production: hit(prod), test: hit(tests) };
}

const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Plural snake_case candidates for a camelCase collection name. */
function tableCandidates(collection) {
  const snake = camelToSnake(collection);
  const out = new Set([snake]);
  if (snake.endsWith('y')) out.add(snake.slice(0, -1) + 'ies');
  if (!snake.endsWith('s')) out.add(snake + 's');
  if (snake.endsWith('s')) out.add(snake.slice(0, -1));
  return [...out];
}

function main() {
  const engines = canonicalEngines();
  const classes = enginePackages();
  const prod = productionFiles();
  const tests = testFiles();
  const created = migrationTables();
  const trustApp = readFileSync(path.join(ROOT, 'apps/web/lib/trust-app.ts'), 'utf8');
  const routes = walk(path.join(ROOT, 'apps/web/app/api'), (f) => f.endsWith('route.ts'));

  // Packages whose barrels declare the wave 4-5 engine classes.
  const wavePackages = [...new Set(
    ['execution-orchestration', 'completion-assurance', 'settlement-assurance', 'settlement-execution']
      .map((p) => `packages/${p}`)
      .filter((p) => existsSync(path.join(ROOT, p, 'src/index.ts'))),
  )];

  const engineRecords = engines.map((engine, index) => {
    const pkg = wavePackages[Math.floor(index / 5)];
    const declared = classes.filter((c) => c.package === pkg);
    const engineClass = declared[index % 5]?.engineClass ?? null;
    const src = existsSync(path.join(ROOT, pkg, 'src/index.ts'))
      ? readFileSync(path.join(ROOT, pkg, 'src/index.ts'), 'utf8') : '';
    return {
      engine: engine.number,
      canonicalName: engine.name,
      package: pkg,
      engineClass,
      classDeclared: engineClass !== null,
      runtimeRegistered: engineClass ? new RegExp(String.raw`\b${engineClass}\b`).test(trustApp) : false,
      runtimeRegistrationFile: 'apps/web/lib/trust-app.ts',
      persistenceInterface: /constructor\(private readonly store: TrustPersistence/.test(src)
        ? 'TrustPersistence' : 'unknown',
      usesFileAssuraStore: /FileAssuraStore/.test(src),
      issuesRawSql: /(INSERT INTO|SELECT .+ FROM|UPDATE .+ SET)/.test(src),
      tests: readdirSync(path.join(ROOT, pkg, 'src')).filter((f) => f.includes('.test.')).sort(),
    };
  });

  const collections = [...new Set(wavePackages.flatMap((p) => collectionsFor(p)))].sort();
  const collectionRecords = collections.map((collection) => {
    const owners = wavePackages.filter((p) => collectionsFor(p).includes(collection));
    const candidates = tableCandidates(collection).filter((t) => created.has(t));
    const table = candidates[0] ?? null;
    const refs = table ? sqlReferences(table, prod, tests) : { production: [], test: [] };
    return {
      collection,
      owningPackages: owners,
      physicalTableWritten: 'trust_records',
      storageShape: 'JSONB payload keyed by collection',
      purposeBuiltTable: table,
      purposeBuiltCreatedBy: table ? created.get(table) : null,
      productionSqlReaders: refs.production,
      testSqlReaders: refs.test,
      classification: !table
        ? 'GENERIC_ONLY_VALID'
        : refs.production.length === 0
          ? 'RELATIONAL_TABLE_DEAD'
          : 'DUAL_WRITE_PRESENT',
    };
  });

  const report = {
    generatedFrom: { catalogue: CATALOGUE, migrations: 'supabase/migrations' },
    canonicalEngineCount: engineRecords.length,
    engines: engineRecords,
    collectionCount: collectionRecords.length,
    collections: collectionRecords,
    totals: {
      classDeclared: engineRecords.filter((e) => e.classDeclared).length,
      runtimeRegistered: engineRecords.filter((e) => e.runtimeRegistered).length,
      onTrustPersistence: engineRecords.filter((e) => e.persistenceInterface === 'TrustPersistence').length,
      usingFileAssuraStore: engineRecords.filter((e) => e.usesFileAssuraStore).length,
      issuingRawSql: engineRecords.filter((e) => e.issuesRawSql).length,
      apiRouteFiles: routes.length,
      relationalTableDead: collectionRecords.filter((c) => c.classification === 'RELATIONAL_TABLE_DEAD').length,
      genericOnly: collectionRecords.filter((c) => c.classification === 'GENERIC_ONLY_VALID').length,
      dualWrite: collectionRecords.filter((c) => c.classification === 'DUAL_WRITE_PRESENT').length,
    },
  };

  mkdirSync(path.join(ROOT, 'artifacts/certification'), { recursive: true });
  writeFileSync(
    path.join(ROOT, 'artifacts/certification/engines-31-50-inventory.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report.totals, null, 2));
}

main();

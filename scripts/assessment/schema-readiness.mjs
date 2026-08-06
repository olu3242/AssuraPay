/**
 * Measures how ready each wave 4-5 aggregate is to receive an explicit relational schema.
 *
 * Assessment tooling. It reports what the repository declares — it does not translate database
 * tables into domain types, because a table is a storage decision and a domain type is a
 * semantic one, and deriving the second from the first would launder the very drift this
 * program exists to measure.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const inventory = JSON.parse(
  readFileSync(path.join(ROOT, 'artifacts/certification/engines-31-50-inventory.json'), 'utf8'),
);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (full.endsWith('.ts') && !full.includes('.test.')) acc.push(full);
  }
  return acc;
}
const sources = walk(path.join(ROOT, 'packages'));
const text = new Map(sources.map((f) => [path.relative(ROOT, f), readFileSync(f, 'utf8')]));

/** Singular PascalCase candidates for a camelCase collection. */
function typeCandidates(collection) {
  const pascal = collection[0].toUpperCase() + collection.slice(1);
  const out = new Set([pascal]);
  if (pascal.endsWith('ies')) out.add(pascal.slice(0, -3) + 'y');
  if (pascal.endsWith('s')) out.add(pascal.slice(0, -1));
  return [...out];
}

const dataSchema = existsSync(path.join(ROOT, 'docs/DATA_SCHEMA.md'))
  ? readFileSync(path.join(ROOT, 'docs/DATA_SCHEMA.md'), 'utf8') : '';

const results = inventory.collections.map(({ collection }) => {
  let exported = null, declaresAny = null, decl = null;
  for (const name of typeCandidates(collection)) {
    for (const [file, src] of text) {
      const m = src.match(new RegExp(String.raw`export (?:type|interface) ${name}\b[^{]*\{([\s\S]*?)\n\}`));
      if (m) { exported = name; decl = file; declaresAny = /:\s*any\b|\bany\[\]/.test(m[1]); break; }
    }
    if (exported) break;
  }
  const zod = [...text].some(([, src]) =>
    new RegExp(String.raw`(${typeCandidates(collection).join('|')})Schema\s*=\s*z\.`).test(src));
  const documented = new RegExp(collection, 'i').test(dataSchema);

  const status = !exported
    ? (documented ? 'DOCUMENTATION_ONLY' : 'DOMAIN_DEFINITION_MISSING')
    : zod ? 'SCHEMA_READY'
    : declaresAny ? 'TYPE_CONTAINS_ANY'
    : 'TYPE_EXISTS_SCHEMA_MISSING';

  return { collection, exportedType: exported, declaredIn: decl, containsAny: declaresAny, zodSchema: zod, inDataSchemaDoc: documented, status };
});

const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
writeFileSync(
  path.join(ROOT, 'artifacts/certification/engines-31-50-schema-readiness.json'),
  JSON.stringify({ collectionCount: results.length, counts, results }, null, 2) + '\n',
);
console.log('counts:', JSON.stringify(counts, null, 2));
console.log('zod schemas anywhere in packages:',
  [...text].filter(([, s]) => /z\.object\(/.test(s)).length);
console.log('\nDOMAIN_DEFINITION_MISSING:', results.filter(r=>r.status==='DOMAIN_DEFINITION_MISSING').map(r=>r.collection).join(', ') || 'none');
console.log('DOCUMENTATION_ONLY:', results.filter(r=>r.status==='DOCUMENTATION_ONLY').map(r=>r.collection).join(', ') || 'none');
console.log('TYPE_CONTAINS_ANY:', results.filter(r=>r.status==='TYPE_CONTAINS_ANY').map(r=>r.collection).join(', ') || 'none');

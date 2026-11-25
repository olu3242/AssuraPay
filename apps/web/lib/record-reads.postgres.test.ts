import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '@assurapay/database';
import {
  createTestDatabaseInstance,
  migrationsDirectory,
  requireTestDatabaseUrl,
} from '@assurapay/database-testing';
import type { TestDatabase } from '@assurapay/database-testing';
import {
  BATCH_A_RELATIONS,
  BATCH_B_RELATIONS,
  BATCH_C_RELATIONS,
  BATCH_D_RELATIONS,
  BATCH_E_RELATIONS,
  BATCH_F_RELATIONS,
  BATCH_G_RELATIONS,
  BATCH_H_RELATIONS,
  BATCH_I_RELATIONS,
  BATCH_K_RELATIONS,
  BATCH_L_RELATIONS,
  BATCH_M_RELATIONS,
} from '@assurapay/database';
import { RECORD_TYPES, childLinksOf, type RecordTypeId } from './record-reads';

/**
 * integration: the record link graph is the database's, not a story about it.
 *
 * `RECORD_TYPES` declares which field on each aggregate points at which other aggregate, and the
 * record page walks that declaration to show a reader what a payment was for. A declaration about the
 * shape of a database is exactly the kind of thing that drifts: rename a column in a migration and the
 * Related tab silently shows nothing, which looks like an orphaned record rather than a bug. Worse, a
 * link invented in good faith would put a relationship on screen that the schema never enforced — and
 * the whole point of the record page is to answer *what obligation justified this money*, which is
 * worthless if the chain it draws is not the chain the database keeps.
 *
 * So the graph is checked against `pg_constraint`. Every declared link must be a real foreign key
 * between the two real tables, and the check is run after the migrations rather than against a
 * snapshot, so a migration that drops or renames a key fails here instead of at a reader's desk.
 *
 * The converse half matters as much and is asserted too: a foreign key that exists between two
 * declared types with no declared link means the record page is hiding a relationship the database
 * enforces.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];
afterAll(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

async function migratedDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabaseInstance();
  databases.push(database);
  await applyMigrations(database.sql, migrationsDirectory(), { appliedBy: 'integration-test' });
  return database;
}

/**
 * The table each collection is stored in, taken from the store's own relation registries.
 *
 * The first version of this test snake-cased the collection name, which is wrong and was caught
 * immediately: `agreements` is stored in **`agreements_v2`**. The mapping is not a convention, it is
 * data the repository layer already holds, so it is read from there rather than guessed. A collection
 * absent from every registry has no table and the assertions below say so.
 */
const COLLECTION_TABLES: ReadonlyMap<string, string> = new Map(
  [
    BATCH_A_RELATIONS,
    BATCH_B_RELATIONS,
    BATCH_C_RELATIONS,
    BATCH_D_RELATIONS,
    BATCH_E_RELATIONS,
    BATCH_F_RELATIONS,
    BATCH_G_RELATIONS,
    BATCH_H_RELATIONS,
    BATCH_I_RELATIONS,
    BATCH_K_RELATIONS,
    BATCH_L_RELATIONS,
    BATCH_M_RELATIONS,
  ].flatMap((registry) =>
    Object.values(registry).map(
      (relation) => [relation.collection, relation.table] as [string, string],
    ),
  ),
);

function tableOf(collection: string): string | undefined {
  return COLLECTION_TABLES.get(collection);
}

/** `fundingCommitmentId` → `funding_commitment_id`, the column a foreign key is declared on. */
function columnOf(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

type ForeignKey = {
  table: string;
  /** Every column of the key, in order, so a composite is one fact rather than several. */
  columns: string[];
  referencedTable: string;
  constraint: string;
};

/**
 * Columns that appear in a composite key as discriminators rather than as references.
 *
 * This schema deliberately carries `tenant_id`, `workspace_id` and `currency` inside composite keys
 * to make a cross-tenant or cross-currency reference unrepresentable. They are not links: no record
 * type *is* a currency. The first version of this test flattened every key to one column per row and
 * duly reported `release_requests.currency → financial_entitlements` as an undeclared relationship,
 * which is the kind of false finding that gets a guard disabled. Keys are now read whole and judged by
 * their referencing column.
 */
const DISCRIMINATOR_COLUMNS = new Set(['tenant_id', 'workspace_id', 'currency']);

/** Every foreign key in the schema, each as a single row carrying all of its columns. */
async function foreignKeys(database: TestDatabase): Promise<ForeignKey[]> {
  const rows = await database.sql<
    { table: string; columns: string[]; referenced_table: string; constraint_name: string }[]
  >`
    SELECT child.relname          AS table,
           parent.relname         AS referenced_table,
           constraint_rel.conname AS constraint_name,
           array_agg(attribute.attname ORDER BY key.ordinality) AS columns
      FROM pg_constraint constraint_rel
      JOIN pg_class child  ON child.oid  = constraint_rel.conrelid
      JOIN pg_class parent ON parent.oid = constraint_rel.confrelid
      JOIN unnest(constraint_rel.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_rel.conrelid
       AND attribute.attnum   = key.attnum
     WHERE constraint_rel.contype = 'f'
     GROUP BY child.relname, parent.relname, constraint_rel.conname
  `;
  return rows.map((row) => ({
    table: row.table,
    columns: row.columns,
    referencedTable: row.referenced_table,
    constraint: row.constraint_name,
  }));
}

describe('the record link graph matches the schema', () => {
  it('declares a real table for every record type', async () => {
    const database = await migratedDatabase();
    const present = new Set(
      (
        await database.sql<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        `
      ).map((row) => row.tablename),
    );

    const missing = RECORD_TYPES.filter((definition) => {
      const table = tableOf(definition.collection);
      return table === undefined || !present.has(table);
    }).map(
      (definition) =>
        `${definition.id} → collection '${definition.collection}' resolves to ` +
        `${tableOf(definition.collection) ?? 'no table in any relation registry'}`,
    );
    // Not vacuous: a wrong collection name would make `readRecord` return undefined for every id, so
    // the record page would 404 on records that exist.
    expect(missing, 'record types whose collection names no table in the schema').toEqual([]);
  }, 120_000);

  it('backs every declared parent link with a real foreign key', async () => {
    const database = await migratedDatabase();
    const keys = await foreignKeys(database);

    const unbacked: string[] = [];
    for (const definition of RECORD_TYPES) {
      const table = tableOf(definition.collection);
      for (const link of definition.parents) {
        const target = RECORD_TYPES.find((entry) => entry.id === link.type);
        if (!target) {
          unbacked.push(`${definition.id}.${link.field} → unknown type ${link.type}`);
          continue;
        }
        const expectedTable = tableOf(target.collection);
        const column = columnOf(link.field);
        // A composite key satisfies the link when it is declared on this table, points at the right
        // table, and carries the referencing column somewhere among its columns.
        const backed = keys.some(
          (key) =>
            key.table === table &&
            key.referencedTable === expectedTable &&
            key.columns.includes(column),
        );
        if (!backed) {
          const otherwise = keys
            .filter((key) => key.table === table && key.columns.includes(column))
            .map((key) => key.referencedTable);
          unbacked.push(
            `${definition.id}.${link.field} claims ${link.type} (${expectedTable}), but ` +
              `${table}.${column} has no foreign key to it` +
              (otherwise.length > 0
                ? ` — it references ${[...new Set(otherwise)].join(', ')}`
                : ' — the column appears in no foreign key at all'),
          );
        }
      }
    }

    expect(unbacked, 'declared links the database does not enforce').toEqual([]);
  }, 120_000);

  it('declares a link for every foreign key between two record types', async () => {
    // The converse. A relationship the database enforces and the graph omits is a relationship the
    // record page cannot show, so a reader asking what a release drew on would be told less than the
    // schema knows.
    const database = await migratedDatabase();
    const keys = await foreignKeys(database);
    const tableToType = new Map<string, RecordTypeId>(
      RECORD_TYPES.flatMap((definition) => {
        const table = tableOf(definition.collection);
        // A collection with no table is reported by the first assertion in this suite; skipping it
        // here keeps that one failure from becoming three.
        return table ? [[table, definition.id] as [string, RecordTypeId]] : [];
      }),
    );

    const undeclared: string[] = [];
    for (const key of keys) {
      const childType = tableToType.get(key.table);
      const parentType = tableToType.get(key.referencedTable);
      if (!childType || !parentType || childType === parentType) continue;

      // The referencing columns of the key — what it is actually about, once tenancy and currency
      // discriminators are set aside. A key made only of discriminators relates nothing.
      const referencing = key.columns.filter((column) => !DISCRIMINATOR_COLUMNS.has(column));
      if (referencing.length === 0) continue;

      const definition = RECORD_TYPES.find((entry) => entry.id === childType);
      const declared = referencing.some((column) =>
        definition?.parents.some(
          (link) => columnOf(link.field) === column && link.type === parentType,
        ),
      );
      if (!declared) {
        undeclared.push(
          `${key.table}(${referencing.join(', ')}) → ${key.referencedTable} (${key.constraint}) ` +
            `is enforced but ${childType} declares no link to ${parentType}`,
        );
      }
    }

    expect([...new Set(undeclared)], 'foreign keys between record types with no declared link').toEqual(
      [],
    );
  }, 120_000);
});

describe('the graph is wired in both directions', () => {
  it('derives a child link for every parent link', () => {
    // Children are inverted from parents rather than declared, so this asserts the inversion is total:
    // every declared parent link appears as a child link on the type it points at.
    const parentLinks = RECORD_TYPES.flatMap((definition) =>
      definition.parents.map((link) => `${link.type}←${definition.id}.${link.field}`),
    );
    const childLinks = RECORD_TYPES.flatMap((definition) =>
      childLinksOf(definition.id).map((link) => `${definition.id}←${link.type}.${link.field}`),
    );
    expect(childLinks.sort()).toEqual(parentLinks.sort());
    // Not vacuous: an empty graph would satisfy the equality.
    expect(parentLinks.length).toBeGreaterThan(15);
  });

  it('leaves exactly one root, and reaches every type from it', () => {
    // The chain has one head — a contract — and a type with no parent that is not the contract would
    // be a record floating free of any obligation, which is the one thing this platform cannot have.
    const roots = RECORD_TYPES.filter((definition) => definition.parents.length === 0);
    expect(roots.map((definition) => definition.id)).toEqual(['contracts']);

    const reached = new Set<RecordTypeId>(['contracts']);
    for (let pass = 0; pass < RECORD_TYPES.length; pass += 1) {
      for (const definition of RECORD_TYPES) {
        if (definition.parents.some((link) => reached.has(link.type))) reached.add(definition.id);
      }
    }
    const orphaned = RECORD_TYPES.filter((definition) => !reached.has(definition.id)).map(
      (definition) => definition.id,
    );
    expect(orphaned, 'record types that cannot be reached from a contract').toEqual([]);
  });
});

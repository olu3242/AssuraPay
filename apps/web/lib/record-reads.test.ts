import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogueKeys } from '@assurapay/permissions';
import type { RequestContext } from '@assurapay/shared';
import {
  RECORD_TYPES,
  childLinksOf,
  labelOf,
  readRecord,
  recordPermissionKeys,
  recordType,
  relatedTo,
  type CollectionReader,
} from './record-reads';
import { ROUTE_PERMISSION_REQUIREMENTS } from './route-permissions';

/**
 * The record read surface, as assertions.
 *
 * The link graph's agreement with the schema is proved in `record-reads.postgres.test.ts`, because
 * only a database can settle that. What is proved here is the behaviour built on top of it: that a
 * record in another workspace is indistinguishable from one that does not exist, that a related type
 * the caller cannot read is named without disclosing how many rows it holds, and that a reference to
 * something absent is reported rather than quietly dropped.
 *
 * These are one-line rules that read as obviously right and are each one reordering away from being
 * wrong, which is exactly what deserves a test.
 */

const WORKSPACE = 'workspace-a';

function context(activeWorkspaceId = WORKSPACE): RequestContext {
  return {
    actorUserId: 'user-1',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId,
    tenantId: 'tenant-a',
    memberships: [activeWorkspaceId],
    correlationId: 'corr-1',
  };
}

/** A reader over fixed rows, standing in for the store. */
function reader(collections: Record<string, Record<string, unknown>[]>): CollectionReader {
  return (async <T,>(collection: string) => (collections[collection] ?? []) as T[]) as CollectionReader;
}

const ALL_KEYS = new Set(recordPermissionKeys());

describe('a record is read only inside the caller’s workspace', () => {
  const invoices = recordType('invoices')!;

  it('returns the record when it belongs to the active workspace', async () => {
    const read = reader({ invoices: [{ id: 'inv-1', workspaceId: WORKSPACE, invoiceNumber: 'INV-001' }] });
    const found = await readRecord(context(), invoices, 'inv-1', read);
    expect(found?.id).toBe('inv-1');
  });

  it('reports a record in another workspace exactly as it reports one that does not exist', async () => {
    // The assertion the route's 404 depends on. If this ever answered "found, but forbidden", an
    // invoice id quoted in a document would confirm the invoice's existence to someone with no access
    // to the workspace holding it.
    const read = reader({ invoices: [{ id: 'inv-1', workspaceId: 'workspace-b', invoiceNumber: 'INV-001' }] });
    const foreign = await readRecord(context(), invoices, 'inv-1', read);
    const absent = await readRecord(context(), invoices, 'inv-nope', read);
    expect(foreign).toBeUndefined();
    expect(foreign).toEqual(absent);
  });

  it('does not match a record whose id is right and whose workspace is absent', async () => {
    // A row with no `workspaceId` at all must not fall through the filter. An unscoped row is not a
    // row belonging to everyone.
    const read = reader({ invoices: [{ id: 'inv-1', invoiceNumber: 'INV-001' }] });
    expect(await readRecord(context(), invoices, 'inv-1', read)).toBeUndefined();
  });
});

describe('related records are filtered by what the caller may read', () => {
  const invoices = recordType('invoices')!;

  const rows = {
    invoices: [
      {
        id: 'inv-1',
        workspaceId: WORKSPACE,
        invoiceNumber: 'INV-001',
        milestoneId: 'ms-1',
        financialEntitlementId: 'fe-1',
      },
    ],
    blueprintMilestones: [{ id: 'ms-1', workspaceId: WORKSPACE, title: 'Phase one delivery' }],
    financialEntitlements: [{ id: 'fe-1', workspaceId: WORKSPACE }],
    // Two reservations and one release hanging off this invoice, downward.
    fundReservations: [
      { id: 'res-1', workspaceId: WORKSPACE, invoiceId: 'inv-1' },
      { id: 'res-2', workspaceId: WORKSPACE, invoiceId: 'inv-1' },
    ],
    releaseRequests: [{ id: 'rr-1', workspaceId: WORKSPACE, invoiceId: 'inv-1' }],
  };

  it('walks both directions for a caller holding every read key', async () => {
    const related = await relatedTo(context(), invoices, rows.invoices[0]!, ALL_KEYS, reader(rows));

    expect(related.parents.map((entry) => entry.type).sort()).toEqual([
      'financial-entitlements',
      'milestones',
    ]);
    // The milestone's own title, not a manufactured label.
    expect(related.parents.find((entry) => entry.type === 'milestones')?.label).toBe(
      'Phase one delivery',
    );
    expect(related.children.map((entry) => entry.id).sort()).toEqual(['res-1', 'res-2', 'rr-1']);
    expect(related.withheld).toEqual([]);
  });

  it('names a withheld type without disclosing how many rows it holds', async () => {
    // The rule this module exists to get right. A caller who may read an invoice is not thereby
    // entitled to the releases drawn against it, and "2 reservations, withheld" would tell them how
    // much activity the invoice has seen.
    const partial = new Set(['invoices:read', 'milestones:read']);
    const related = await relatedTo(context(), invoices, rows.invoices[0]!, partial, reader(rows));

    expect(related.children).toEqual([]);
    expect(related.withheld).toContain('Fund reservation');
    expect(related.withheld).toContain('Release request');
    expect(related.withheld).toContain('Financial entitlement');

    // The withheld report itself carries no number. Asserted on its serialized form rather than on
    // the whole payload: the payload legitimately contains digits inside the ids of records the
    // caller *may* read, so a blanket "no digits" check fails for the wrong reason — as the first
    // version of this test did, on the visible milestone's own id.
    expect(JSON.stringify(related.withheld)).not.toMatch(/\d/);
    // And nothing count-shaped was added beside it, which is how a volume disclosure would creep back.
    expect(Object.keys(related).filter((key) => /count|total|length/i.test(key))).toEqual([]);
  });

  it('reports a parent the record names but the workspace does not hold', async () => {
    // A dangling reference in a chain that authorises money is a finding. Dropping it silently would
    // make the record look complete; migration `202611250001` is what stops new ones appearing, and
    // this is how an existing one becomes visible.
    const orphan = { ...rows.invoices[0]!, milestoneId: 'ms-gone' };
    const related = await relatedTo(
      context(),
      invoices,
      orphan,
      ALL_KEYS,
      reader({ ...rows, invoices: [orphan] }),
    );

    expect(related.danglingParents).toEqual([
      { type: 'milestones', field: 'milestoneId', id: 'ms-gone' },
    ]);
    expect(related.parents.map((entry) => entry.type)).not.toContain('milestones');
  });

  it('ignores a child in another workspace', async () => {
    const related = await relatedTo(
      context(),
      invoices,
      rows.invoices[0]!,
      ALL_KEYS,
      reader({
        ...rows,
        fundReservations: [{ id: 'res-x', workspaceId: 'workspace-b', invoiceId: 'inv-1' }],
      }),
    );
    expect(related.children.map((entry) => entry.id)).not.toContain('res-x');
  });

  it('skips a parent field the record leaves empty rather than looking up an empty id', async () => {
    const related = await relatedTo(
      context(),
      invoices,
      { ...rows.invoices[0]!, milestoneId: '' },
      ALL_KEYS,
      reader(rows),
    );
    expect(related.parents.map((entry) => entry.type)).not.toContain('milestones');
    expect(related.danglingParents).toEqual([]);
  });
});

describe('a label is the record’s own or the record’s id', () => {
  it('prefers a human field in declared order', () => {
    expect(labelOf({ id: 'x', contractNumber: 'C-1', title: 'ignored' })).toBe('C-1');
    expect(labelOf({ id: 'x', title: 'A title' })).toBe('A title');
  });

  it('falls back to the id rather than inventing a name', () => {
    // A label built from the type name plus a counter would put a number on screen that matches
    // nothing in the database, which is worse than showing the id.
    expect(labelOf({ id: 'res-1' })).toBe('res-1');
    expect(labelOf({ id: 'res-1', title: '   ' })).toBe('res-1');
  });
});

describe('the graph is wired once and used in both directions', () => {
  it('inverts every parent link into exactly one child link', () => {
    const parents = RECORD_TYPES.flatMap((definition) =>
      definition.parents.map((link) => `${link.type}<-${definition.id}.${link.field}`),
    ).sort();
    const children = RECORD_TYPES.flatMap((definition) =>
      childLinksOf(definition.id).map((link) => `${definition.id}<-${link.type}.${link.field}`),
    ).sort();
    expect(children).toEqual(parents);
    expect(parents.length).toBeGreaterThan(15);
  });

  it('names no type twice and resolves every declared link target', () => {
    const ids = RECORD_TYPES.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of RECORD_TYPES) {
      for (const link of definition.parents) {
        expect(recordType(link.type), `${definition.id}.${link.field}`).toBeDefined();
      }
    }
  });

  it('gives every type a distinct collection, so two types cannot read the same rows', () => {
    const collections = RECORD_TYPES.map((definition) => definition.collection);
    expect(new Set(collections).size).toBe(collections.length);
  });
});

describe('every record route is governed and grantable', () => {
  it('gates each record route on its own type’s read key', () => {
    for (const definition of RECORD_TYPES) {
      const requirement = ROUTE_PERMISSION_REQUIREMENTS[`/api/v1/${definition.id}/[id]|GET`];
      expect(requirement, `${definition.id} has no record route policy`).toBeDefined();
      expect(requirement).toEqual({
        access: 'permission',
        permissionKey: definition.permissionKey,
      });
    }
  });

  it('gates the audit trail on its own key, and that key is grantable', () => {
    expect(ROUTE_PERMISSION_REQUIREMENTS['/api/v1/audit-trail/[type]/[id]|GET']).toEqual({
      access: 'permission',
      permissionKey: 'audit-records:read',
    });
    expect(new Set(catalogueKeys())).toContain('audit-records:read');
  });

  it('makes every read key the surface gates on grantable to some role', () => {
    const grantable = new Set(catalogueKeys());
    const ungrantable = recordPermissionKeys().filter((key) => !grantable.has(key));
    // A key no role can hold gates a route nobody can ever reach, which is a dead screen rather
    // than a secure one.
    expect(ungrantable).toEqual([]);
  });

  it('keeps the record surface off the founding administrator', () => {
    // The decision taken when the financial read surface was built, restated here because this
    // surface is wider: reading every certificate, invoice and settlement is not administration, and
    // granting it on founding would quietly make the founder an assurance and finance role.
    const catalogue = readFileSync(
      path.join(process.cwd(), 'packages/permissions/src/catalogue.ts'),
      'utf8',
    );
    const administrator = catalogue.slice(
      catalogue.indexOf("role: 'WORKSPACE_ADMINISTRATOR'"),
      catalogue.indexOf("role: 'CONTRACT_AUTHOR'"),
    );
    expect(administrator.length).toBeGreaterThan(100);
    for (const key of recordPermissionKeys()) {
      expect(administrator, `WORKSPACE_ADMINISTRATOR holds ${key}`).not.toContain(`'${key}'`);
    }
  });

  it('never lets the audit key stand in for the subject’s own read key', () => {
    // `auditTrailResponse` requires both. Asserted against the source, because the second check is a
    // narrowing one and a narrowing check is the kind that gets removed as redundant.
    const source = readFileSync(path.join(process.cwd(), 'apps/web/lib/record-route.ts'), 'utf8');
    expect(source).toContain('held.has(definition.permissionKey)');
    expect(source).toContain("status: 403");
  });
});

describe('the record surface moves no money and holds no funds', () => {
  it('reads only, with no write, instruction or hold primitive anywhere in the surface', () => {
    // CLAUDE.md requires every change touching the money-movement path to assert the non-custody
    // constraint. This surface reads the settlement chain, so the assertion it owes is that reading
    // it cannot become acting on it: no append, no replace, no release, no hold.
    const sources = ['apps/web/lib/record-reads.ts', 'apps/web/lib/record-route.ts'].map((file) =>
      readFileSync(path.join(process.cwd(), file), 'utf8'),
    );
    for (const source of sources) {
      for (const forbidden of [
        '.append(',
        '.replace(',
        'holdFunds',
        'releaseFunds',
        'submitPayment',
        'paymentInstructions.submit',
        'releaseReservation',
      ]) {
        expect(source, `the record surface must not call ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('states no balance, because AssuraPay holds no funds to have one', () => {
    // The record surface returns rows as stored and derives nothing, so it cannot report a balance
    // even by accident — but a future helper that summed amounts here would, and this is what fails
    // when one is added.
    const source = readFileSync(path.join(process.cwd(), 'apps/web/lib/record-reads.ts'), 'utf8');
    for (const forbidden of ['balance', 'reduce(', 'totalAmount']) {
      expect(source.toLowerCase(), `the record surface must not compute ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { POSTGRES_IDENTITY_PLANE_COLLECTIONS, payloadDigest } from '@assurapay/database';
import type { SqlClient } from '@assurapay/database';
import { createTestDatabase, requireTestDatabaseUrl } from './index';
import type { TestDatabase } from './index';

/**
 * integration: the identity plane is reachable without a tenant, and nothing else became reachable.
 *
 * The defect these probes certify against was found by a browser, not by reading SQL. The first
 * Playwright journey ever run against the durable runtime failed on its first click:
 *
 *   Registration refused: PERSISTENCE_SCOPE_INVALID: 42501:
 *   new row violates row-level security policy for table "trust_records"
 *
 * `POST /v1/auth/register` could not write its own row. Three policies in `202608070001` carried an
 * untenanted branch whose comment said it existed so that "identity registration and activation
 * happen before the actor belongs to any tenant... Refusing those writes would make registration
 * impossible under forced RLS, so they are permitted" — and whose predicate,
 * `tenant_id IS NULL AND trust_current_tenant() IS NOT NULL`, admitted an untenanted row only for a
 * caller that already had a tenant. The branch written to permit the pre-tenant path was the one
 * predicate excluding it, and no test noticed because no test had ever entered the product from
 * outside. `202608110020_identity_plane_is_reachable_without_a_tenant.sql` argues the repair.
 *
 * ## Every probe runs as a role that does not own the tables
 *
 * The same discipline `rls-certification.postgres.test.ts` established for the same reason: `ENABLE
 * ROW LEVEL SECURITY` does not constrain a table's owner, so a suite probing as the owner can find
 * a policy "working" that a real connection would bypass entirely. `FORCE` is what makes the owner
 * subject to policy, and the probe role is what makes the result mean something either way.
 *
 * ## What would make this suite fail, and what that would mean
 *
 * Two failure directions, and both matter. If the identity-plane probes fail, registration or
 * sign-in is broken again and the product cannot be entered. If the boundary probes fail, the
 * fourth branch has been written too wide and an unscoped caller can see a tenant's aggregates —
 * which is the failure the repair had to avoid to be worth making. A repair that only proved the
 * first direction would be indistinguishable from deleting the policy.
 */

requireTestDatabaseUrl();

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.dispose();
});

const TENANT_A = { tenantId: 'tenant-a', workspaceId: 'workspace-a' };
const TENANT_B = { tenantId: 'tenant-b', workspaceId: 'workspace-b' };

/** A row shaped for `trust_records`, with the digest the table requires. */
function record(collection: string, id: string, payload: Record<string, unknown>) {
  return { collection, id, payload, digest: payloadDigest(payload) };
}

/**
 * Lifts `FORCE` for the duration of a seed.
 *
 * The fixture's job is to create the state the probes then fail to cross. Seeding through the
 * policies would mean the setup silently depended on the thing under test — and here it would be
 * circular in a way that hides the defect: an unscoped seed that succeeded because of the repair
 * would look like a fixture, not a finding.
 */
async function withoutForcedRls(sql: SqlClient, run: () => Promise<void>): Promise<void> {
  const tables = [
    'trust_records',
    'trust_audit_records',
    'trust_tenants',
    'trust_workspaces',
    // Included because the membership fixtures below write rows a tenant-scoped caller would be
    // required to write, and the fixture has no tenant scope: seeding through the policy would make
    // the setup depend on the branch under test.
    'trust_memberships',
  ];
  for (const table of tables) await sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
  try {
    await run();
  } finally {
    for (const table of tables) await sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
}

/** Two tenants, a workspace each, and rows on both sides of the boundary. */
async function seededDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
  databases.push(database);

  await withoutForcedRls(database.sql, async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await database.sql`INSERT INTO trust_tenants (tenant_id) VALUES (${tenant.tenantId})`;
      const workspace = record('trust_workspaces', tenant.workspaceId, {
        id: tenant.workspaceId,
        tenantId: tenant.tenantId,
        status: 'ACTIVE',
      });
      await database.sql`
        INSERT INTO trust_workspaces (workspace_id, tenant_id, status, payload, payload_digest)
        VALUES (${tenant.workspaceId}, ${tenant.tenantId}, 'ACTIVE', ${database.sql.json(workspace.payload)}, ${workspace.digest})
      `;

      // A workspace-scoped aggregate outside the identity plane, one per tenant. These are the
      // rows an unscoped caller must never see.
      const party = record('parties', `party-${tenant.tenantId}`, { id: `party-${tenant.tenantId}` });
      await database.sql`
        INSERT INTO trust_records (collection, record_id, workspace_id, payload, payload_digest)
        VALUES (${party.collection}, ${party.id}, ${tenant.workspaceId}, ${database.sql.json(party.payload)}, ${party.digest})
      `;
    }

    // An untenanted audit record: what registration writes before the actor belongs to anywhere.
    // Chain position 1 with no previous hash, so the chain it joins is well-formed rather than a
    // row jammed into someone else's sequence.
    await database.sql`
      INSERT INTO trust_audit_records (
        audit_id, chain_position, tenant_id, workspace_id, actor_id, event_type,
        aggregate_type, aggregate_id, correlation_id, previous_hash, integrity_hash
      ) VALUES (
        'audit-untenanted', 1, NULL, NULL, 'user-new', 'IdentityRegistered',
        'UserIdentity', 'user-new', 'corr-registration', NULL, 'hash-untenanted'
      )
    `;
  });

  return database;
}

/**
 * The non-owning role, required rather than optional.
 *
 * `TestDatabase.probeRole` is `string | undefined`, and interpolating `undefined` would emit
 * `SET LOCAL ROLE "undefined"` — which fails with a role-does-not-exist error that reads like an
 * environment problem. Worse, a suite that fell back to the owner would report every boundary probe
 * as passing while proving nothing, because `FORCE` is the only thing making the owner answerable
 * to a policy.
 */
function requireProbeRole(database: TestDatabase): string {
  if (!database.probeRole)
    throw new Error(
      'this suite requires the non-owning probe role: probing as the table owner would certify ' +
        'policies that a real connection does not even reach the same way',
    );
  return database.probeRole;
}

/** Runs `probe` as the non-owning role with no tenancy scope at all — registration's conditions. */
async function unscoped<T>(
  database: TestDatabase,
  probe: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const role = requireProbeRole(database);
  return await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);
    // Blank rather than merely unset, so the probe is deterministic whatever the pooled
    // connection was last used for.
    await tx`SELECT set_config('app.tenant_id', '', true)`;
    await tx`SELECT set_config('app.workspace_id', '', true)`;
    await tx`SELECT set_config('app.actor_id', '', true)`;
    return await probe(tx);
  });
}

/** Runs `probe` as the non-owning role inside one tenant's scope. */
async function scoped<T>(
  database: TestDatabase,
  tenant: { tenantId: string; workspaceId: string },
  probe: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const role = requireProbeRole(database);
  return await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${role}"`);
    await tx`SELECT set_config('app.tenant_id', ${tenant.tenantId}, true)`;
    await tx`SELECT set_config('app.workspace_id', ${tenant.workspaceId}, true)`;
    await tx`SELECT set_config('app.actor_id', 'user-1', true)`;
    return await probe(tx);
  });
}

describe('the identity plane is reachable without a tenant', () => {
  it('admits the registration write that was refused before the repair', async () => {
    const database = await seededDatabase();
    const identity = record('identities', 'user-new', { id: 'user-new', email: 'new@assurapay.test' });

    // The exact statement `PostgresTrustStore.append('identities', ...)` issues on the
    // registration path: no tenant, no workspace, nothing to be scoped against.
    await unscoped(database, async (tx) => {
      await tx`
        INSERT INTO trust_records (collection, record_id, payload, payload_digest)
        VALUES (${identity.collection}, ${identity.id}, ${database.sql.json(identity.payload)}, ${identity.digest})
      `;
    });

    const [row] = await unscoped(database, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_records WHERE collection = 'identities'`,
    );
    expect(row.n, 'an unscoped caller must be able to read back the identity it just registered').toBe('1');
  });

  it('keeps an activated session readable by the resolver that cannot be scoped', async () => {
    const database = await seededDatabase();

    // The second defect, and the one a reader is most likely to assume the collection-keyed branch
    // did not need to cover. `activate-context` promotes a session row from scope-less to
    // workspace-scoped; session resolution is how the scope is discovered, so it runs unscoped. A
    // policy admitting only *untenanted* rows would sign a user out at the moment they succeeded.
    const session = record('sessions', 'session-1', { id: 'session-1', userId: 'user-new' });
    await unscoped(database, async (tx) => {
      await tx`
        INSERT INTO trust_records (collection, record_id, workspace_id, payload, payload_digest)
        VALUES (${session.collection}, ${session.id}, ${TENANT_A.workspaceId}, ${database.sql.json(session.payload)}, ${session.digest})
      `;
    });

    const [row] = await unscoped(database, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_records WHERE collection = 'sessions'`,
    );
    expect(row.n, 'an activated session must still resolve for a caller that has no scope yet').toBe('1');
  });

  it('admits the untenanted audit record registration writes about itself', async () => {
    const database = await seededDatabase();

    const [row] = await unscoped(database, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_audit_records WHERE tenant_id IS NULL`,
    );
    expect(row.n, 'registration must be able to record itself before it has a tenant').toBe('1');
  });

  it('lets a scoped caller still read the identity plane, so sign-in works from inside a tenant', async () => {
    const database = await seededDatabase();
    const identity = record('identities', 'user-existing', { id: 'user-existing' });
    await unscoped(database, async (tx) => {
      await tx`
        INSERT INTO trust_records (collection, record_id, payload, payload_digest)
        VALUES (${identity.collection}, ${identity.id}, ${database.sql.json(identity.payload)}, ${identity.digest})
      `;
    });

    const [row] = await scoped(database, TENANT_A, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_records WHERE collection = 'identities'`,
    );
    expect(row.n, 'the repair must not have cost the scoped caller its existing access').toBe('1');
  });
});

describe('and nothing outside it became reachable', () => {
  it('still hides every tenant aggregate from an unscoped caller', async () => {
    const database = await seededDatabase();

    const [row] = await unscoped(database, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_records WHERE collection = 'parties'`,
    );
    // Two parties exist, one per tenant. An unscoped caller must see neither: this is the
    // assertion that distinguishes the repair from having deleted the policy.
    expect(row.n, 'an unscoped caller must not see a workspace-scoped aggregate').toBe('0');
  });

  it('still refuses an unscoped write outside the identity plane', async () => {
    const database = await seededDatabase();
    const party = record('parties', 'party-smuggled', { id: 'party-smuggled' });

    await expect(
      unscoped(database, async (tx) => {
        await tx`
          INSERT INTO trust_records (collection, record_id, workspace_id, payload, payload_digest)
          VALUES (${party.collection}, ${party.id}, ${TENANT_A.workspaceId}, ${database.sql.json(party.payload)}, ${party.digest})
        `;
      }),
      'an unscoped caller must not be able to write into a tenant workspace',
    ).rejects.toThrow(/row-level security/i);
  });

  it('still hides a tenanted audit record from an unscoped caller', async () => {
    const database = await seededDatabase();
    await withoutForcedRls(database.sql, async () => {
      await database.sql`
        INSERT INTO trust_audit_records (
          audit_id, chain_position, tenant_id, workspace_id, actor_id, event_type,
          aggregate_type, aggregate_id, correlation_id, previous_hash, integrity_hash
        ) VALUES (
          'audit-tenanted', 1, ${TENANT_A.tenantId}, ${TENANT_A.workspaceId}, 'user-1', 'Seeded',
          'Thing', 'thing-1', 'corr-1', NULL, 'hash-tenanted'
        )
      `;
    });

    const [row] = await unscoped(database, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_audit_records WHERE tenant_id IS NOT NULL`,
    );
    // Dropping the ambient-scope conjunct made untenanted history unscoped-readable. It must not
    // have made *tenanted* history unscoped-readable, which is a different and much larger claim.
    expect(row.n, 'an unscoped caller must not read a tenant’s audit history').toBe('0');
  });

  it('still keeps one tenant out of another tenant’s aggregates', async () => {
    const database = await seededDatabase();

    const [row] = await scoped(database, TENANT_A, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_records WHERE record_id = ${`party-${TENANT_B.tenantId}`}`,
    );
    expect(row.n, 'the cross-tenant boundary is untouched by the repair').toBe('0');
  });
});

describe('the policy and the store agree on what the identity plane is', () => {
  it('holds the same five collections in SQL as in TypeScript', async () => {
    const database = await seededDatabase();

    // Two independent statements of one set: `trust_collection_is_identity_plane()` decides whether
    // a row is visible, and `POSTGRES_IDENTITY_PLANE_COLLECTIONS` is what the store's readers
    // reason about. A sixth collection added to one alone would produce rows the policy hides from
    // the code that wrote them — so the sets are compared rather than trusted to stay in step.
    const candidates = [...POSTGRES_IDENTITY_PLANE_COLLECTIONS, 'parties', 'legalPolicyVersions'];
    const rows = await database.sql<{ collection: string; inPlane: boolean }[]>`
      SELECT collection, trust_collection_is_identity_plane(collection) AS "inPlane"
      FROM unnest(${candidates}::text[]) AS collection
    `;

    const sqlSet = rows.filter((row) => row.inPlane).map((row) => row.collection).sort();
    expect(sqlSet).toEqual([...POSTGRES_IDENTITY_PLANE_COLLECTIONS].sort());
  });

  it('leaves legalPolicyVersions outside the plane, as the migration says it does', async () => {
    const database = await seededDatabase();

    // Named rather than left to be discovered. `legalPolicyVersions` carries neither `tenantId` nor
    // `workspaceId` — it is scoped transitively through its parent policy — so it writes a
    // scope-less row and depends on the pre-existing untenanted branch, which still requires an
    // ambient tenant. That residual is a data-model gap rather than a policy one, and this
    // assertion is what stops the next reader from assuming the repair closed it.
    const [row] = await database.sql<{ inPlane: boolean }[]>`
      SELECT trust_collection_is_identity_plane('legalPolicyVersions') AS "inPlane"
    `;
    expect(row.inPlane).toBe(false);

    const version = record('legalPolicyVersions', 'version-1', { id: 'version-1' });
    await expect(
      unscoped(database, async (tx) => {
        await tx`
          INSERT INTO trust_records (collection, record_id, payload, payload_digest)
          VALUES (${version.collection}, ${version.id}, ${database.sql.json(version.payload)}, ${version.digest})
        `;
      }),
      'a scope-less non-identity row still needs a scoped caller, exactly as before the repair',
    ).rejects.toThrow(/row-level security/i);
  });
});

/**
 * The membership-discovery repair, which is the identity plane's argument one layer up.
 *
 * `202608110021`. After registration was repaired, the browser journey founded an organization
 * successfully and was then told "No workspace memberships yet" — the row existed, was ACTIVE, and
 * named the caller, and an unscoped read returned nothing. `GET /v1/me/workspaces` answers "which
 * workspaces may I enter", which is how a caller learns its tenant, and both policies it reads
 * required a tenant already. The effect was that every return visit was unusable: the only way in
 * was to found a new organization each time.
 */
describe('a caller can discover the memberships that name its tenant', () => {
  /** Runs `probe` knowing the actor but not the tenant — the state a freshly signed-in caller is in. */
  async function actorOnly<T>(
    database: TestDatabase,
    userId: string,
    probe: (tx: SqlClient) => Promise<T>,
  ): Promise<T> {
    const role = requireProbeRole(database);
    return await database.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "${role}"`);
      await tx`SELECT set_config('app.tenant_id', '', true)`;
      await tx`SELECT set_config('app.workspace_id', '', true)`;
      await tx`SELECT set_config('app.actor_id', ${userId}, true)`;
      return await probe(tx);
    });
  }

  /** A membership for `userId` in `tenant`'s workspace, seeded as the fixture rather than through the policy. */
  async function withMembership(
    database: TestDatabase,
    tenant: { tenantId: string; workspaceId: string },
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<void> {
    const membership = record('trust_memberships', `m-${userId}-${tenant.tenantId}`, { id: userId, status });
    await withoutForcedRls(database.sql, async () => {
      await database.sql`
        INSERT INTO trust_memberships (membership_id, workspace_id, tenant_id, user_id, status, payload, payload_digest)
        VALUES (
          ${`m-${userId}-${tenant.tenantId}`}, ${tenant.workspaceId}, ${tenant.tenantId},
          ${userId}, ${status}, ${database.sql.json(membership.payload)}, ${membership.digest}
        )
      `;
    });
  }

  it('reads its own membership with no tenant scope at all', async () => {
    const database = await seededDatabase();
    await withMembership(database, TENANT_A, 'user-member', 'ACTIVE');

    const [row] = await actorOnly(database, 'user-member', async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_memberships`,
    );
    expect(row.n, 'a signed-in caller must be able to read the membership that names its tenant').toBe('1');
  });

  it('sees the workspace that membership points at', async () => {
    const database = await seededDatabase();
    await withMembership(database, TENANT_A, 'user-member', 'ACTIVE');

    const [row] = await actorOnly(database, 'user-member', async (tx) =>
      tx<{ id: string }[]>`SELECT workspace_id AS id FROM trust_workspaces`,
    );
    // The workspaces policy reaches into memberships, and the memberships policy reaches into
    // nothing — which is the whole reason `tenant_id` was denormalised onto the membership. Written
    // the obvious way instead, this query fails with
    // `infinite recursion detected in policy for relation "trust_memberships"`.
    expect(row?.id).toBe(TENANT_A.workspaceId);
  });

  it('sees only its own memberships, not everyone else’s', async () => {
    const database = await seededDatabase();
    await withMembership(database, TENANT_A, 'user-member', 'ACTIVE');
    await withMembership(database, TENANT_B, 'user-other', 'ACTIVE');

    const rows = await actorOnly(database, 'user-member', async (tx) =>
      tx<{ userId: string }[]>`SELECT user_id AS "userId" FROM trust_memberships`,
    );
    expect(rows.map((row) => row.userId)).toEqual(['user-member']);
  });

  it('hides a workspace whose membership is not ACTIVE', async () => {
    const database = await seededDatabase();
    await withMembership(database, TENANT_A, 'user-suspended', 'SUSPENDED');

    const [row] = await actorOnly(database, 'user-suspended', async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_workspaces`,
    );
    // Matching `listAuthorizedWorkspaces`, which filters on an ACTIVE membership. A suspended
    // membership that still revealed its workspace would list somewhere `activateContext` then
    // refuses with `WORKSPACE_ACCESS_DENIED` — an entry that looks available and is not.
    expect(row.n).toBe('0');
  });

  it('refuses a caller granting itself a membership', async () => {
    const database = await seededDatabase();
    const membership = record('trust_memberships', 'm-self-granted', { id: 'user-attacker' });

    // The actor branch is on USING only. On WITH CHECK it would let any caller insert an ACTIVE
    // membership naming itself in any workspace of any tenant, and the row would satisfy the very
    // policy meant to constrain it — a tenancy escalation with no authentication step. This is the
    // assertion that keeps the read fix from becoming a write hole.
    await expect(
      actorOnly(database, 'user-attacker', async (tx) => {
        await tx`
          INSERT INTO trust_memberships (membership_id, workspace_id, tenant_id, user_id, status, payload, payload_digest)
          VALUES (
            'm-self-granted', ${TENANT_A.workspaceId}, ${TENANT_A.tenantId},
            'user-attacker', 'ACTIVE', ${database.sql.json(membership.payload)}, ${membership.digest}
          )
        `;
      }),
      'reading your own membership must not imply being able to create one',
    ).rejects.toThrow(/row-level security/i);
  });

  it('still keeps one tenant’s memberships from another tenant', async () => {
    const database = await seededDatabase();
    await withMembership(database, TENANT_B, 'user-other', 'ACTIVE');

    const [row] = await scoped(database, TENANT_A, async (tx) =>
      tx<{ n: string }[]>`SELECT count(*)::text AS n FROM trust_memberships`,
    );
    expect(row.n, 'the tenant branch is unchanged: A still sees nothing of B').toBe('0');
  });
});

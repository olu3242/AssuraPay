import { describe, expect, it } from 'vitest';
import {
  PostgresTrustStore,
  enterMutableTrustScope,
  enterTrustScope,
  withTrustScope,
} from '@assurapay/database';
import { OrganizationService } from '@assurapay/organizations';
import { createTestDatabase, requireTestDatabaseUrl } from './index';

/**
 * integration: the ambient trust scope reaches more than the first store operation.
 *
 * Written because it did not, and the failure was invisible to every one of the 461 PostgreSQL proofs
 * that preceded it.
 * `GET /v1/me/workspaces` returned `[]` for a caller holding an ACTIVE membership in an ACTIVE
 * workspace. PostgreSQL's statement log for one such request:
 *
 *   begin / set_config(app.actor_id=…) / SELECT … trust_memberships / commit
 *   SELECT … trust_memberships     <- no begin, no set_config
 *   SELECT … trust_workspaces      <- no begin, no set_config
 *
 * The route's first read was scoped and every later read was not, so forced row-level security
 * returned nothing to the reads that mattered.
 *
 * ## The cause, and why no suite could have caught it
 *
 * `AsyncLocalStorage.enterWith` binds the *current* execution context. `authorizedContextForRoute` is
 * an async function that authenticated and *then* entered the scope — after its first `await`, in a
 * context the route handler awaiting it does not reliably share. So the funnel's own read
 * (`resolveMemberships`, which runs inside the funnel) was scoped, and the route's reads were not.
 * `POST /v1/tenants` escaped it only because it calls `enterTrustScope` in the handler's own body.
 *
 * Every existing suite established scope with `withTrustScope`, which is lexical and cannot exhibit
 * this. The mechanism was only ever exercised in the one form that works.
 *
 * ## What each test here pins
 *
 * The three cases are the three propagation shapes, and keeping the broken one is deliberate: it is
 * the regression guard. If someone reverts the funnel to entering the scope after authentication, the
 * third test still passes and the second fails — naming exactly what broke.
 */

requireTestDatabaseUrl();

/** Founds a workspace under a tenant scope, then reads it back the way a signed-in caller does. */
async function foundThenList(
  organizations: OrganizationService,
  userId: string,
  read: (userId: string) => Promise<{ id: string }[]>,
): Promise<{ workspaceId: string; listed: string[] }> {
  const workspace = await withTrustScope({ tenantId: `tenant-${userId}`, actorId: userId }, () =>
    organizations.createWorkspace({
      tenantId: `tenant-${userId}`,
      workspaceType: 'ORGANIZATION',
      name: `Workspace ${userId}`,
      slug: `workspace-${userId}`,
      ownerUserId: userId,
      defaultCurrency: 'NGN',
      timezone: 'Africa/Lagos',
      countryCode: 'NG',
      correlationId: 'c1',
    }),
  );
  const listed = await read(userId);
  return { workspaceId: workspace.id, listed: listed.map((entry) => entry.id) };
}

describe('a multi-read engine method sees its rows when the scope propagates', () => {
  it('lists an authorized workspace from an actor-only scope, through two independent reads', async () => {
    const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
    try {
      const organizations = new OrganizationService(new PostgresTrustStore(database.sql));
      const userId = 'user-lexical-scope';

      // `listAuthorizedWorkspaces` reads `memberships` and then `trustWorkspaces` — two separate
      // `list()` calls, so two separate transactions, so two separate scope applications. That is
      // exactly the shape that fails in the Next.js runtime.
      const { workspaceId, listed } = await foundThenList(organizations, userId, (id) =>
        withTrustScope({ actorId: id }, () => organizations.listAuthorizedWorkspaces(id)),
      );

      expect(
        listed,
        'both reads must see their rows: the actor-keyed policies permit them and the rows exist',
      ).toEqual([workspaceId]);
    } finally {
      await database.dispose();
    }
  });

  it('reaches the caller when the funnel binds in its prologue and fills in afterwards', async () => {
    const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
    try {
      const organizations = new OrganizationService(new PostgresTrustStore(database.sql));
      const userId = 'user-prologue-scope';

      const { workspaceId, listed } = await foundThenList(organizations, userId, async (id) => {
        // Exactly what `authorizedContextForRoute` now does: bind an empty scope before the first
        // await, authenticate, then assign into the object that is already bound.
        const funnel = async () => {
          const scope = enterMutableTrustScope();
          await Promise.resolve();
          scope.actorId = id;
          return { actorUserId: id };
        };
        const context = await funnel();
        return await organizations.listAuthorizedWorkspaces(context.actorUserId);
      });

      expect(
        listed,
        'the route must see its rows through both reads, not only the first',
      ).toEqual([workspaceId]);
    } finally {
      await database.dispose();
    }
  });

  it('does NOT reach the caller when the funnel enters the scope after awaiting', async () => {
    const database = await createTestDatabase({ applyAllMigrations: false, applyRls: true });
    try {
      const organizations = new OrganizationService(new PostgresTrustStore(database.sql));
      const userId = 'user-late-scope';

      const { listed } = await foundThenList(organizations, userId, async (id) => {
        const funnel = async () => {
          await Promise.resolve();
          enterTrustScope({ actorId: id });
          return { actorUserId: id };
        };
        const context = await funnel();
        return await organizations.listAuthorizedWorkspaces(context.actorUserId);
      });

      // The shape the platform shipped with, pinned so the repair cannot be undone quietly. Empty
      // rather than throwing, which is what made it so hard to see: an unscoped read under forced RLS
      // is indistinguishable from a caller who genuinely has no memberships.
      expect(
        listed,
        'if this is no longer empty, enterWith propagation changed — re-read the note in trust-scope.ts',
      ).toEqual([]);
    } finally {
      await database.dispose();
    }
  });
});

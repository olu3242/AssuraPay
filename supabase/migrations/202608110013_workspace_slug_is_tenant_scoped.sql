-- A workspace slug is unique within its tenant, and nothing enforced it.
--
-- `OrganizationService.createWorkspace` refuses `WORKSPACE_SLUG_EXISTS` by listing `trustWorkspaces` and
-- comparing slugs. That is a read-then-write with no index behind it, so two concurrent registrations
-- claiming the same slug both read an empty set and both succeed. The only unique index on a slug anywhere
-- is `workspaces_slug_idx`, which sits on the deprecated `workspaces` table that this batch retires — so
-- the rule was enforced on a table with no reader and unenforced on the table with one.
--
-- ## Per tenant, not global
--
-- The application cannot check a slug globally: `trust_workspaces` forces row-level security under a
-- tenant-scoped policy, so the engine's read sees only its own tenant's rows. An index has no such limit,
-- so a global index here would refuse writes the application believed were fine and report a constraint
-- name to a caller who could not have known.
--
-- Global uniqueness is also the wrong rule. It would tell one tenant that another holds a name, and let
-- whichever tenant claimed `acme` first hold it against every other tenant on the deployment, permanently
-- — the cross-tenant denial of service `202608110010` removed six instances of. A slug identifies a
-- workspace inside the tenant that owns it, and that is the scope it should be unique in.
--
-- The engine's own check stays, so a caller gets `WORKSPACE_SLUG_EXISTS` rather than an index name. This
-- index is what makes the rule true under concurrency rather than usually.
--
-- ## On a JSON expression, because that is where the slug is
--
-- `trust_workspaces` promotes `workspace_id`, `tenant_id`, `status` and `version` to columns and keeps the
-- rest of the aggregate in `payload`. A slug column exists only on the deprecated `workspaces` table, which
-- is the other half of why the rule was unenforced: the index was written against the shape that has no
-- reader. An expression index on `payload->>'slug'` is indexing the same value the engine compares, rather
-- than a column that would have to be added and kept in step with the payload by a trigger.
--
-- `WHERE ... IS NOT NULL` matters here in a way it would not on a column: a workspace written before this
-- migration, or by a future caller that omits the field, has no `slug` key at all, and `->>` yields NULL
-- rather than raising. Without the predicate every such row would collide with every other one in its
-- tenant on a NULL — which, since NULLs are distinct in a unique index, they would not, but the partial
-- index states the intent rather than relying on that.

CREATE UNIQUE INDEX IF NOT EXISTS trust_workspaces_tenant_slug_unique
  ON trust_workspaces (tenant_id, (payload ->> 'slug'))
  WHERE payload ->> 'slug' IS NOT NULL;

COMMENT ON INDEX trust_workspaces_tenant_slug_unique IS
  'A workspace slug is unique within its tenant. Per tenant rather than global because row-level security makes a global check impossible for the application to perform, and because a global slug would let the first tenant to claim a name hold it against every other tenant.';

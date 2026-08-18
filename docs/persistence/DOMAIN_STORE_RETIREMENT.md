# Retiring the file-backed domain store — discovery

**Status: discovery complete, three defects reproduced.** This is Batch J of
`persistence.domain-store-durability`, and it is the item `DURABILITY_GAP_ANALYSIS.md` lists as future
state 4 — "`FileAssuraStore` is retired, and with it the three trust-domain compatibility tables" —
which future state 5 names as the condition holding Engines 51–60.

Everything below was measured against a live migrated PostgreSQL 16 instance or read from the source
named. Nothing here is inferred from the plan.

## What the register said, and what is actually true

The register records the eight `FileAssuraStore` routes as "a separate question from the 67 — they
work". The first half is right and the second half is wrong in a way that matters more than the 67 did:

> **They do not work in any durable deployment, and neither does anything else.**

`FileAssuraStore.load()` calls `assertDomainStoreAllowed()`, which throws `DOMAIN_STORE_NOT_DURABLE`
for `production`, `staging`, `release-candidate`, `hosted-pilot` and `persistent-preview`. That
refusal is correct — serving fabricated demo tenants as real data is worse — but it is not the end of
the consequence, because one of the eight routes is `POST /v1/workspaces`.

## Defect 1 — a durable deployment cannot be bootstrapped

`OrganizationService.createWorkspace` is the durable way to create a workspace. It appends to
`trustWorkspaces`, appends the founder's `OWNER` membership, writes an audit record and emits a domain
event. It is correct, and it has **zero callers anywhere in the repository**. The same is true of
`createOrganization` and `listAuthorizedWorkspaces`.

The only route that creates a workspace is `POST /v1/workspaces`, which composes
`AssuraPayService.createWorkspace` over `FileAssuraStore` — a different method on a different class
writing to a JSON file. In a durable deployment it throws before touching anything.

The consequence is not "one route is unavailable". Every protected route passes through
`authorizedContextForRoute`, which calls `enterTrustScope` with the tenant and workspace from the
verified identity. `issueFromSession` sets `tenantId: workspace?.tenantId` — so a caller with no
workspace carries no tenant, FORCE row-level security matches no row, and every read is denied. The
bootstrap chain is:

    register → session → assertion carrying no tenant → POST /v1/workspaces → dead end

161 routes go through the durable store. They are individually correct and collectively unreachable,
because nothing can create the first workspace that all of them require.

`POST /v1/workspaces/[id]/found` and `POST /v1/workspaces/[id]/activate-context` both presume the
workspace already exists. `found` documents the analogous deadlock for grants — "founding creates the
first grant, so requiring a permission would restore the deadlock it exists to break" — and the same
reasoning applies one level further out, where it was never applied.

## Defect 2 — `createWorkspace` cannot succeed under the durable boundary even when called

Reproduced against a live instance, in `wave6-workspace-bootstrap.postgres.test.ts`:

    PERSISTENCE_UNAVAILABLE: 42501: new row violates row-level security
    policy for table "trust_tenants"

`createWorkspace` mints `tenantId: randomUUID()` for every workspace. The store creates the tenant row
on demand, and `trust_tenants_self` refuses it because the minted tenant is not
`trust_current_tenant()`. Had that passed, `trust_workspaces_tenant_scope` would have refused the
workspace for the same reason.

So the engine that is supposed to found a workspace is incompatible with the boundary the platform
enforces. That is worth separating from defect 1: wiring a route to this engine without changing it
would move the failure, not fix it.

Minting a tenant per workspace is also wrong independently of row-level security. It makes tenant and
workspace 1:1, and every table Batches A through I converged carries a composite
`(tenant_id, workspace_id)` key and a `(tenant_id, workspace_id, id)` unique key. Those are only
meaningful if a tenant holds more than one workspace. The identity model and the persistence model
disagree, and the persistence model is the one with 108 tables behind it.

## Defect 3 — an out-of-scope write is reported as an outage

`translate()` maps SQLSTATE `42501` (`insufficient_privilege`) to `PERSISTENCE_UNAVAILABLE`. A write
refused by a row-level security policy is not an availability problem: the caller named a scope it does
not hold, and retrying will never succeed.

The same file already argues this exact point two blocks earlier, about the mutation-boundary triggers:

> All four mean the same thing to a caller — the database refused to change something it holds
> immutable — and they must not surface as PERSISTENCE_UNAVAILABLE, which reads as an outage and
> invites a retry that can never succeed.

An operator debugging the bootstrap above is told the database is unreachable. `42501` covers two
different things and they need separating: a row-level security refusal is a caller-scope error
(`PERSISTENCE_SCOPE_INVALID`), while a missing table grant is a genuine operational fault and stays
`PERSISTENCE_UNAVAILABLE`. PostgreSQL distinguishes them in the message — `violates row-level security
policy` against `permission denied for table` — which is the same signal the trigger translations
already key on.

## The eight routes, and where each one goes

Every collection these routes read has a durable owner among the 108 the store now maps, and every
engine they need is already composed in `apps/web/lib/trust-app.ts` over `trustStore`. This batch is a
re-pointing, not new persistence.

| Route | Durable destination |
|---|---|
| `GET /v1/me/workspaces` | `trust.organizations.listAuthorizedWorkspaces` |
| `POST /v1/workspaces` | `trust.organizations.createWorkspace`, after defect 2 is fixed |
| `POST /v1/organizations` | `trust.organizations.createOrganization` |
| `POST /v1/contracts` | `agreements.authoring.create` — the same engine `POST /v1/agreement-contracts` uses |
| `GET /v1/contracts` | `agreements` collection, scoped to the active workspace |
| `GET /v1/completion-certificates/[id]/verify` | `completion.certification.verify` |
| `GET /v1/payment-eligibility/[id]/blockers` | `paymentEligibilities`, blockers derived |
| `GET /v1/milestones/[id]/assurance` | a cross-engine read model — the one route with no direct equivalent |

### The one route that cannot be preserved

`POST /v1/contracts/[id]/approve` sets `status = 'APPROVED'` with an actor and a timestamp, and nothing
else. The durable path is `agreements.approvals.route` then `.decide`, which requires an approval
policy and a document version, records an `ApprovalRequest`, and holds a decision immutable once made.
Those are not the same operation: the legacy route approves a contract with no policy, no required
roles and no decision record, which is an approval trail that cannot be relied on.

It is already exposed durably as `POST /v1/approval-requests` and
`POST /v1/approval-requests/[id]/decisions`. The legacy shortcut is retired rather than re-pointed, and
that is a deliberate removal of a route rather than an oversight.

## The three compatibility tables cannot go yet, and the reason is measurable

This batch set out to retire `workspaces`, `workspace_memberships` and `user_identities` as well, because
`COMPATIBILITY_OBJECTS` names `persistence.domain-store-durability` as their retirement condition. **It
does not, and the reason only became visible on measuring it.**

`schema-ownership.ts` recorded `workspaces` as the foreign-key parent of 93 Engine 06–60 tables. Measured
against a fully migrated instance:

| Table | Dependants | Which |
|---|---|---|
| `workspaces` | **16** | 15 deferred-batch tables, plus `workspace_memberships` |
| `workspace_memberships` | **0** foreign keys | held by 15 policies calling `has_active_workspace_membership()` |
| `user_identities` | **1** | `workspace_memberships` |

The 93 became 16 because Batches A–I converged 77 of those tables onto `trust_workspaces` as they
activated them. The fifteen that remain are exactly the tables of the two deferred batches:
`dashboard_snapshots`, `execution_assurance_indices`, `execution_forecasts`, `kpi_definitions`,
`kpi_values`, `settlement_assurance_indices` (`enterprise-intelligence`, 6) and `drift_alerts`,
`evaluation_records`, `financial_forecasts`, `model_feedback`, `model_registrations`,
`performance_scorecards`, `portfolio_snapshots`, `recommendations`, `renewal_assessments`
(`enterprise-analytics`, 9). `agent-runtime`'s nine collections have no tables at all, so they hold nothing.

So retiring the three tables is blocked on activating those two batches, not on the file-backed store. The
sequence the register implies is one step short:

1. **Batch J — this one.** Retire `FileAssuraStore` in code. That resolves the boundary future state 5 names,
   which makes the deferred batches executable.
2. **Next.** Activate `enterprise-intelligence` (6) and `enterprise-analytics` (9). Each converges its tables
   onto `trust_workspaces` and off `has_active_workspace_membership()`, as Batches A–I did for their own.
3. **Then.** All sixteen dependants are gone and the three compatibility tables drop together.

Dropping them now would require `CASCADE`, which would take the fifteen deferred tables with it — deleting
the schema of two batches that have not been written yet, to retire three tables that harm nothing while the
runtime role holds no privilege on any of them (which `certifySchemaOwnership` verifies rather than assumes).

## Scope

In: the eight routes, the three defects, the assurance read model, and retiring `FileAssuraStore`,
`AssuraRepository`, `Snapshot`, `AssuraPayService`, `createSeedScenario` and `domain-store-environment`.

Out, and stated rather than quietly dropped: the three compatibility tables, for the measured reason above.
Also out, unchanged: the 24 collections still unmapped (`enterprise-intelligence`,
`enterprise-analytics`, `agent-runtime`). Future state 5 holds them until this boundary is resolved, and
resolving it is what this batch does — so they become executable after it, not during it, and they are now
the next thing on the critical path rather than the last.

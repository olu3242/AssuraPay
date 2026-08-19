# RC1 Production E2E Convergence — Phase A gap matrix

Canonical entry SHA: `b948b9ef63947af96ffd14ec08e85555c18797fc` (`main`, worktree clean).

Measured against the repository, not inferred from documents. Every number below came from a command whose
output is reproducible; where a figure is a count of source constructs the command is named.

## The finding that determines the whole phase

**The AssuraPay backend is complete, durable and certified. It is not reachable from a browser at all.**

| Measured | Value | How |
| --- | --- | --- |
| API routes | **163** | `find apps/web/app/api -name route.ts` |
| — permission-gated | 156 | `access: 'permission'` in `route-permissions.ts` |
| — identity-class | 6 | `access: 'identity'` |
| — public | 6 | `access: 'public'` |
| Pages | 23 | `find apps/web/app -name page.tsx` |
| **Total TSX in the app** | **517 lines** | `find apps/web/app -name '*.tsx' \| xargs wc -l` |
| `<form>` elements | **0** | `grep -ro '<form' apps/web/app` |
| `<input>` elements | **0** | same |
| `onSubmit` handlers | **0** | same |
| `fetch(` calls | **0** | same |
| `<button>` elements | 1 | the landing-page carousel |
| `useState` | 2 | the same carousel |
| `'use client'` components | 1 | `components/hero-carousel.tsx` |
| Browser harness | **none** | no `playwright.config.*`, no `e2e/`, no `@playwright/test` dependency |

So 163 routes have **zero browser callers**. Of the 23 pages, 21 render static descriptive prose — for
example `/approvals` renders a heading and one sentence with no queue and no data, and `/contracts` renders
five hardcoded stage cards. The one component that names governed surfaces, `TrustConsole`, is two lines long,
makes no network call, and says so in its own copy: the states it lists are *"handled by the secured API
workflow"* — it describes an API rather than calling one.

This is consistent with how the repository got here: thirteen persistence batches made the domain durable and
`202608110017` closed the register, while the front end was never built. It also confirms the hypothesis behind
this phase — the backend is complete and the production UX does not reach it.

## What that means for the RC1 superprompt

RC1 as specified requires **building the AssuraPay front end from zero**, then certifying it. The browser work
is not a thin layer over existing UI; there is no existing UI. Ordered by dependency:

| RC1 section | Prerequisite that does not exist yet | Size |
| --- | --- | --- |
| §5 Authentication | register/login/logout/session forms and client session handling | new |
| §5 Tenant bootstrap | tenant founding, workspace creation, context activation surfaces | new |
| §5 Agreement journey | agreement authoring, party editing, versioning, submit, review, approve | new |
| §5 Execution journey | blueprint, milestone, acceptance criteria, metrics, assignment | new |
| §5 Evidence journey | evidence submission, reviewer queue, decision, DoD evaluation | new |
| §5 Certification | certification request and issuance surfaces | new |
| §5 Settlement | eligibility, entitlement, release, instruction, provider, reconciliation | new |
| §10 Persona dashboards | 8 dashboards over governed reporting surfaces | new |
| §11 Action centre | derived task/reminder surface | new |
| §12 Analytics | Engines 51–60 reporting surfaces | new |
| §13 Agent runtime E2E | operator surfaces for Engines 61–70 | new |
| §4 Persona matrix | see the authority note below | needs deriving |
| §18 Suites | 13 named suites, none of which exists | new |

## The authority model does not have the personas the prompt names

§4 says to derive exact current roles from the canonical authorization catalog and not to invent permissions.
Derived: **the canonical model has no named roles.** `packages/permissions` expresses authority as permission
grants — `{ permissionKey, effect, scopeType, scopeId, sourceType: 'ROLE' | 'PERMISSION_SET' | 'DELEGATION',
sourceId }` — and `route-permissions.ts` classifies each route with a `resource:action` key, deny-by-default.
`sourceType: 'ROLE'` carries a free-form `sourceId` rather than a member of an enumerated set, so a role is a
label on a grant and not an object the repository defines. There is no role catalogue anywhere, so
"Organization Administrator", "Finance", "Auditor" and the rest are not canonical objects.

The catalogue that *does* exist, measured: **152 distinct permission keys across 80 resources**.

Consequence for §4, stated rather than worked around: a persona certification matrix must be built as **named
grant compositions over the existing permission keys**, declared in one place, with the matrix asserting what
each composition can and cannot reach. That satisfies "do not invent permissions" — the keys are the existing
ones — while giving the ten personas a definition the repository can check. Inventing a parallel role model
inside the trust packages would violate CLAUDE.md's boundary on Engines 01–05.

## Two facts that affect how browser certification must be built

**The session cookie is `Secure`.** `POST /v1/auth/login` sets
`assurapay_session=…; HttpOnly; Secure; SameSite=Lax`. Chromium treats `http://localhost` as a trustworthy
origin and does accept `Secure` cookies there, so a local harness should work — but this is the kind of
assumption that produces a suite that passes for the wrong reason, so the harness asserts the cookie is
actually present rather than inferring it from a 200.

**Login takes an email and no credential.** `trust.identity.login({ email, rawSessionToken, … })` issues a
session for any registered email; there is no password, passkey or assertion check on that path, and
`/v1/auth/assertion` is a separate route. This is recorded here as an observation about the current canonical
identity model, not changed as a side effect of building a UI: adding credential verification is a change to
Engine 01's contract and belongs in its own capability with its own certification. **RC1 must not present the
current login as authentication-grade in any promotion claim.**

## §6 SSO / DBO — not implemented anywhere, so not invented here

§6 asks for the canonical implementation of *Serious Seller Only* and *Dedicated Buyer Only* and says not to
invent a parallel model. Searched for every plausible spelling — `SERIOUS_SELLER`, `SeriousSeller`,
`serious-seller`, `DEDICATED_BUYER`, `DedicatedBuyer`, `dedicated-buyer`, and the bare acronyms — across
`packages`, `apps` and `docs`.

**One hit, and it is a different thing.** `docs/ENGINE_CATALOG.md` line 11 lists "SSO" among Engine 01's
concerns, where it means **Single Sign-On**. There is no serious-party qualification model in the repository: no
enum, no field, no policy, no eligibility check.

So §6's own instruction settles it — there is nothing to include in the golden transaction, and building a
qualification model would be inventing the parallel model the section forbids. If SSO/DBO is a real product
requirement it needs its own capability with its own domain design, because it would gate agreement and
transaction eligibility and therefore touches the release path.

## §7 financial provider boundary — the seam already exists

`packages/settlement-execution` exports `PaymentProviderGateway` as an interface and
`deterministicPaymentGateway` as an implementation, with the engine taking the gateway as a constructor
dependency. Its own comment states the deployment rule: real deployments must supply a gateway backed by the
licensed Financial Provider. The data seam is there too — `providerKey`, `providerReference`,
`providerReportedAmountMinor`, `providerStatementReference` — and `/v1/payment-instructions/[id]/submit`,
`/refresh-status` and `/reverse` are routed.

So §7 needs a browser-reachable journey and the nine certifications it lists, not a new adapter. Non-custody is
already structural: the gateway is injected, and AssuraPay sends instructions rather than holding balances.

## Eight blockers, found by clicking, in the order they were hidden behind each other

This is the section the document exists for. Each of these made the product unusable. **None was
visible to any of the 461 PostgreSQL proofs, the 880 unit tests, or the 168 REOS checks**, and each
became visible only once the one in front of it was repaired — so they were found one at a time, by
running the journey again after every fix.

That progression is the finding: *a platform can be exhaustively certified component by component and
still not open at all.* Eight independent defects stood between a working backend and a user reaching
their own workspace, and the suites could not see any of them because of a single shared property —
every test established its preconditions from inside. Suites called `IdentityService.activate()`
directly, set a tenant scope by hand, or used `InMemoryTrustStore`. They exercised transitions no user
could reach, through a store whose policies never ran. Nothing had ever entered the product from
outside, so nothing had ever tested the way in.

All eight are fixed. The browser journey passes: **7 of 7**.

### 1. Registration could not write its own row

```
Registration refused: PERSISTENCE_SCOPE_INVALID: 42501:
new row violates row-level security policy for table "trust_records"
```

`trust_records_scope`, `trust_audit_tenant_scope` and `trust_outbox_tenant_scope` each had an
untenanted branch written as `tenant_id IS NULL AND trust_current_tenant() IS NOT NULL` — admitting a
tenant-less row only for a caller that *already had* a tenant. The migration's own comments state the
opposite intent in prose: "identity registration and activation happen before the actor belongs to any
tenant… Refusing those writes would make registration impossible under forced RLS, so they are
permitted." The branch written to permit the pre-tenant path was the one predicate excluding it, in
three policies at once.

Fixed by `202608110020_identity_plane_is_reachable_without_a_tenant.sql`, which names the identity
plane — `identities`, `authenticationMethods`, `sessions`, `devices`, `stepUpChallenges` — as the set
guarded by the identity gateway rather than by tenancy, because it is what *establishes* scope and so
cannot be guarded by it. The branch is keyed on the collection rather than on the scope columns,
because an activated session is workspace-scoped and must still be readable by a resolver that has no
scope yet.

Additive: every row admitted before is admitted after, and the new branch reaches only those five
collections. `identity-plane-rls.postgres.test.ts` proves both directions — the plane is reachable
unscoped, and an unscoped caller still sees zero parties, zero tenanted audit records, and nothing of
another tenant.

### 2. No identity could ever become ACTIVE

Sign-in refused with `AUTHENTICATION_DENIED`. `register` creates `status: 'PENDING_VERIFICATION'`;
`login` requires `ACTIVE`; and the only engine method bridging them, `IdentityService.activate`, **had
no HTTP route anywhere in the application**. Every identity the platform could create was permanently
unable to sign in.

Fixed by adding email verification as the transition activation is meant to evidence: `register` mints
a single-use token and stores only its digest — the treatment `UserSession.sessionTokenHash` already
gets — and `POST /v1/auth/verify-email` consumes it. Exposing `activate(userId)` directly was rejected
because it would let anyone turn another person's dormant registration into a signable-into account.

**The delivery channel is a deployment statement with no default.** Engine 09 (Notification &
Communication) is Deferred, so the platform has no email transport at all.
`ASSURAPAY_IDENTITY_VERIFICATION_CHANNEL` must be stated; `DIRECT_RETURN` declares that a deployment
has no channel and that registration returns the token to its caller; `NOTIFICATION_ENGINE` is refused
at load with a message naming Engine 09. Infrastructure, not business truth — the rule that a token is
required, single-use and expiring is identical in every environment, which is what keeps it on the
permitted side of §19.

### 3. Identity-class routes had no signing keyring

`ASSERTION_KEYRING_REQUIRED` on tenant founding and sign-out. `assertions.ts` deliberately has no
default secret, so an unconfigured deployment fails closed — correct, and a deployment obligation the
harness had not met. The browser suite now generates a keyring per run rather than committing one.

### 4. The assertion route could not succeed on any input

```js
const body = await (await request.json()).catch(() => ({}));
```

`await` first, then `.catch` on a plain object — a `TypeError` on every request whose body parsed, and
an unhandled parse error on every request without one. Since the gateway authenticates *only* a signed
assertion and minting one was impossible, **all 156 permission-class routes and every identity-class
route were unreachable from a browser**, reporting `GATEWAY_ASSERTION_MISSING`. One `await` in the
wrong place. The route now also validates `minimumAssuranceLevel` against the defined set instead of
passing an attacker-controlled string through.

### 5. Membership discovery required the tenant scope it exists to establish

Founding an organization succeeded and the page said "No workspace memberships yet". The row existed,
was `ACTIVE`, and named the caller. `GET /v1/me/workspaces` answers "which workspaces may I enter" —
which is how a caller learns its tenant — and both policies it reads required a tenant already.
`202608070001`'s own comment shows the author reasoning about this trap one level down ("a policy keyed
on the active workspace would require knowing the answer first") and then keying it on the tenant,
which has the identical problem one level up.

**This made every return visit unusable**, not merely the first: the only way in was to found a new
organization each time.

The obvious repair — an actor-keyed branch on each policy — is mutually recursive, and PostgreSQL says
so rather than looping: `infinite recursion detected in policy for relation "trust_memberships"`. That
was measured, not predicted. `202608110021_membership_discovery_precedes_tenant_scope.sql` breaks the
cycle by denormalising `tenant_id` onto `trust_memberships` so its policy references no table, after
which the workspace policy may query memberships freely. The actor branch is on `USING` only — on
`WITH CHECK` it would let any caller grant itself an ACTIVE membership in any tenant's workspace, which
the suite asserts is refused.

### 6. Every store operation after a route's first ran unscoped

The largest of the eight, and the one with the widest blast radius. With the policies repaired, the
membership list was *still* empty — and PostgreSQL's statement log for one request showed why:

```
begin
set_config('app.tenant_id',…,'app.actor_id',$3)   -- applied
SELECT payload … FROM trust_memberships           -- scoped, returned the row
commit
SELECT payload … FROM trust_memberships           -- no begin, no set_config
SELECT payload … FROM trust_workspaces            -- no begin, no set_config
```

`enterTrustScope` uses `AsyncLocalStorage.enterWith`, which binds the *current* execution context.
`authorizedContextForRoute` is an async function that authenticated and *then* entered the scope —
after its first `await`, in a context the route handler awaiting it does not share. So the funnel's own
read was scoped and **every read the route performed afterwards was not**. Under forced RLS those reads
returned nothing, silently: an unscoped read is indistinguishable from a caller who genuinely has no
rows.

This was not specific to one route. Any route performing more than one independent store operation was
reading nothing after its first. `POST /v1/tenants` escaped only because it calls `enterTrustScope` in
the handler's own body.

Fixed by `enterMutableTrustScope()`, which binds an empty scope in the funnel's **synchronous
prologue** — before its first `await`, in the caller's own context — and fills it in once
authentication has said who the caller is. Re-asserting the scope after the fact was tried first and
does not work: by then there is no binding to update. `scope-propagation.postgres.test.ts` pins all
three shapes, including the broken one, so the repair cannot be undone quietly.

Two related scoping gaps fell out of the same investigation and are fixed with it.
`POST /v1/auth/assertion` is public, so it never had a scope at all, and the workspace and membership
reads inside issuance returned nothing — selecting a workspace the caller owned failed with
`ISSUANCE_WORKSPACE_UNKNOWN`. It now scopes by the resolved session's actor, and derives the tenant
from a workspace read that is *itself* the membership proof: `trust_workspaces_tenant_scope` reveals a
workspace to an actor-only caller only when that actor holds an ACTIVE membership, so naming someone
else's workspace returns nothing and enters no tenant.

### 7. A new organization's owner had no permissions in it

`Context activation refused: ENFORCEMENT_PERMISSION_DENIED`, on the workspace the caller had just
created and owned. `POST /v1/tenants` mints the tenant, workspace and OWNER membership;
`POST /v1/workspaces/{id}/found` writes the workspace's *first permission grant*; and nothing called
the second. Every other route is permission-gated, so the owner of a brand-new organization could do
nothing in it.

Not a platform defect — both routes existed and both are correct — but a real gap in the journey. The
bootstrap console now founds administration as part of founding the organization, which is what a user
means by the act. Both routes are identity-class by necessity and both are safe for the same reason:
the tenant cannot be named by the caller, and `bootstrapWorkspaceGrants` refuses unless the caller is
already an ACTIVE OWNER of a workspace holding no grant.

### 8. Activating a workspace context had no durable effect

Activation reported success and changed nothing. `POST /v1/workspaces/{id}/activate-context` called
`OrganizationService.activateContext`, which *computes* a `RequestContext` and returns it — the choice
was never written down. `GET /v1/auth/session` still reported no active workspace, and the next
assertion minted from that session carried no workspace either, so a client had to re-name the
workspace on every request. **The route was named for a state change it did not make.**

Fixed by `IdentityService.selectWorkspace`, which records the choice on the session row. Sessions
belong to Engine 01, so the persistence lives there; authorization stays with Engine 03, and the route
calls them in that order, so a refused activation writes nothing. Membership is deliberately not
re-checked in the identity engine — that would put a second authority on one question, which is what
CLAUDE.md's trust-foundation boundary exists to prevent.

`GET /v1/auth/session` now also reports the tenant, derived from the session's workspace through a
membership-filtered read rather than duplicated onto the session record, and returns
`activeWorkspaceId` alongside `workspaceId` — the session row and `RequestContext` name the same thing
differently, and a client reading the wrong one got an empty value and no error.

## What this leaves open, stated rather than closed

- **`POST /v1/auth/login` proves nothing about possession of the address.** It takes `{ email }` and
  returns a session. Pre-existing, and it is the §6 identity-provider gap. Email verification does not
  change it and the two must not be conflated: verification gates *activation*, not authentication.
  This is the most significant open item in the document.
- **`legalPolicyVersions` is scope-less by omission, not by design.** It carries neither `tenantId` nor
  `workspaceId` — it is scoped transitively through its parent policy — so it depends on the
  pre-existing untenanted branch and is *not* in the identity plane. Narrowing that branch to the
  identity plane would refuse it. A data-model gap; `identity-plane-rls.postgres.test.ts` asserts the
  current behaviour so the next reader does not mistake it for closed.
- **`/api/health/ready` can never report ready when the app is started the way the repository starts
  it.** `defaultMigrationsDirectory()` resolves `supabase/migrations` against `process.cwd()`, and
  `apps/web`'s own `start` script runs `next start` inside `apps/web`, where no such directory exists —
  `ENOENT: scandir '…/apps/web/supabase/migrations'`, a permanent 503. The harness starts from the
  repository root to work around it, but a deployment running `pnpm start` has an unusable readiness
  endpoint. The fix belongs in `packages/runtime`: resolve the directory from stated configuration
  rather than from the working directory.
- **A durable deployment must state TLS.** `/api/health/ready` returned `503
  PERSISTENCE_CONFIG_SSL_REQUIRED` until the harness pointed at an instance serving real TLS with
  `ASSURAPAY_DATABASE_SSL=require`. Correct gate behaviour, recorded because certifying against
  plaintext would have meant weakening it or certifying a composition production cannot use.
- **Health routes are under `/api`.** `/health/live` is a 404. Minor, but it cost a ten-minute
  readiness timeout that looked like a hung server.

## What already exists and must not be rebuilt

- `POST /v1/tenants` — founds tenant, first workspace and the caller's `OWNER` membership.
- `POST /v1/workspaces/[id]/found` — writes the workspace's first permission grant.
- `POST /v1/auth/assertion` — the cookie-to-assertion join. It existed and was broken; see blocker 4.
- `GET /v1/me/workspaces`, `POST /v1/workspaces`, `POST /v1/workspaces/[id]/activate-context`.
- `GET /api/health/live`, `GET /api/health/ready` — §15's endpoints exist.
- `apps/web/lib/assurance-read-model.ts` — the cross-engine read model for dashboards.
- The full settlement chain, agent runtime, and analytics engines, all durable and certified.

## Regression baseline (§2)

`repo:certify` 11/11 · REOS 168/168 · 132/132 durable mappings · empty coverage baseline · zero tables
with ENABLE-without-FORCE · `trust_migration_ledger` the only table without row-level security ·
migration `202608110018` keeping all 31 money columns exact, integral and safe-range bounded.

`certify:postgres` went **461 → 481**: +10 identity-plane proofs, +6 membership-discovery proofs,
+3 scope-propagation proofs, and +1 elsewhere. Unit tests went 880 → 882, and both of those additions
are the existing ratchets catching this work rather than new assertions of my own — the public-route set
and the authorization-coverage allowlist each had to be edited deliberately, with a reason, to admit
`verify-email`.

No proof was removed or relaxed. `assertUnscopedReadDenied` gained a predicate on
`trust_audit_records` so that it states the invariant the schema actually claims — no *tenanted* row
leaks to an unscoped caller — rather than passing because the fixture happened to seed both its rows
with a tenant.

## Honest scoping

Phases B through H are a multi-week front-end programme, not a single change. This branch delivers
Phase A, the harness, the persona matrix, the bootstrap surface, and the eight repairs above — which
were not optional, because without them there is no journey to certify and no way into the product.

What it does **not** deliver is the rest of the lifecycle. Agreement, blueprint, milestone, assignment,
evidence, review, approval, certification, eligibility, entitlement, release, provider instruction,
reconciliation and reporting all remain uncertified through a browser. Their backends are durable and
proven.

The honest expectation for that work is set by this one. Eight blockers stood between a proven backend
and the first four screens; the eight were not exotic, and the reason none was caught is structural
rather than accidental. There is no reason to assume the rest of the lifecycle is in better shape than
its first four steps were, and the way to find out is to keep clicking.

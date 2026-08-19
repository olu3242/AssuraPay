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

So 163 routes have **zero browser callers**. Of the 23 pages, 21 are static descriptive placeholders — for
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

## Three defects the browser gate found by booting the real application

None of these was visible to any existing gate, because no existing gate started the production build and asked
it for readiness. They are recorded in the order the harness hit them, since each was hidden behind the one
before it.

**1. A durable deployment must state TLS, and the harness had not.** `/api/health/ready` returned
`503 PERSISTENCE_CONFIG_SSL_REQUIRED`. `loadPersistenceConfig` refuses a durable deployment that inherits a TLS
default and refuses one that sets `disable` — correct behaviour, and the reason the browser suite now runs
against a PostgreSQL instance serving real TLS with `ASSURAPAY_DATABASE_SSL=require`. Certifying against a
plaintext database would have meant either weakening that gate or certifying a composition production cannot
use.

**2. `/api/health/ready` can never report ready when the app is started the way the repository starts it.**
This is a product defect, not a harness one. `defaultMigrationsDirectory()` in `packages/runtime` resolves
`supabase/migrations` against `process.cwd()`; `apps/web`'s own `start` script runs `next start` **inside
`apps/web`**, where no such directory exists. The result is
`ENOENT: scandir '…/apps/web/supabase/migrations'` and a permanent 503. The harness works around it by starting
from the repository root with `next start apps/web`, which keeps the cwd at the root while still finding the
build output — but **a deployment that runs `pnpm start` has a readiness endpoint that cannot succeed**, and the
right fix is for the runtime to resolve the directory from a stated configuration value rather than from the
current working directory. That belongs in its own change against `packages/runtime`, not in a browser harness.

**3. Health routes are under `/api`.** `/health/live` is a 404; the route is `/api/health/live`. Minor, but it
cost a ten-minute readiness timeout that looked like a hung server, so it is written down.

## What already exists and must not be rebuilt

- `POST /v1/tenants` — founds tenant, first workspace and the caller's `OWNER` membership. Identity-class by
  necessity, since a permission check would need a grant that needs a workspace that does not exist yet.
- `GET /v1/me/workspaces`, `POST /v1/workspaces`, `POST /v1/workspaces/[id]/found`,
  `POST /v1/workspaces/[id]/activate-context`.
- `GET /health/live`, `GET /health/ready` — §15's readiness and liveness endpoints exist.
- `apps/web/lib/assurance-read-model.ts` — the cross-engine read model for dashboards.
- The full settlement chain, agent runtime, and analytics engines, all durable and certified.

## Regression baseline to preserve (§2)

`repo:certify` 11/11 · `certify:postgres` 461/461 · REOS 168/168 · 132/132 durable mappings · empty coverage
baseline · zero tables with ENABLE-without-FORCE · `trust_migration_ledger` the only table without row-level
security · migration `202608110018` keeping all 31 money columns exact, integral and safe-range bounded.

## Honest scoping

Phases B through H are a multi-week front-end programme, not a single change. This branch therefore delivers
the foundation and the first certified journey, and reports the remainder as outstanding with this matrix as
the plan of record. Nothing below the line it reaches is claimed as certified.

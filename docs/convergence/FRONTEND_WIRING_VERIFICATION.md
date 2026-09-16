# Frontend wiring verification — 2026-09-15

## Delivered

- Original PNG copied byte-for-byte to `apps/web/public/images/assurapay-symbol.png`.
- SHA-256: `19e86da74bafc59af78f9ac77dc0e250b46cf0734b7354bba2542cd776835fcd`.
- Header, footer and application logo links navigate to `/`.
- Shared application navigation connects account/workspace, agreements, performance, execution, settlements and workflow pages.
- Legacy authentication/onboarding pages redirect to the existing account/workspace flow.
- Agreement intake and workflow recovery obtain a fresh workspace assertion for every protected request.
- The workflow page renders live API state instead of fabricated metrics.
- Four explicit route permission checks now use the same canonical keys as the route policy. Both checks remain enforced.
- Intake displays reviewed terms and links to agreement management after conversion.
- Terms and privacy links lead to explicit unpublished-document notices, not invented legal policies.

## Evidence and limits

`pnpm exec playwright test --config playwright.navigation.config.ts`: 6 passed, 0 failed, 0 skipped.
The first five tests use actual local Next.js pages; the signed-out intake test reaches the actual session endpoint.
The sixth is a browser API-contract test with intercepted responses; it proves recovery request wiring and fresh assertions, not live provider recovery.

`pnpm exec vitest run apps/web/lib/workspace-fetch.test.ts apps/web/lib/route-coverage.test.ts apps/web/lib/route-permissions.test.ts`: 43 passed.
`pnpm exec vitest run apps/web/lib/frontend-routes.test.ts apps/web/lib/workspace-fetch.test.ts`: 7 passed (four overlap the previous command).
`pnpm typecheck`: passed after navigation/intake edits.

Earlier PostgreSQL run: 501 passed in 32 files, with no skips. That run predates the qualification-history migration and latest frontend edits.

## Not certified

The complete authenticated agreement-to-settlement browser journey, real email delivery, external provider callback/reconciliation, production deployment, and rollback drill remain unproven.
Several product sections still expose descriptive pages rather than a complete feature UI. Static route matching is not proof that every business operation completes.
Serious Seller / Dedicated Buyer implementation is in progress and not integrated into every transaction gate.
The supplied landing design includes sample transaction data; it is not a workspace dashboard.
Terms and privacy require approved documents from the product owner.

Implementation branch: `feat/assurapay-full-production-convergence` in `C:/Cdev/AssuraPay/AssuraPay-production-gaps`.
The original checkout also received the exact logo, homepage links, application navigation, and public entry redirects. Backend integration remains in the isolated convergence worktree.

## Final checks for this increment

- `pnpm build`: passed (`artifacts/convergence/navigation-production-build.log`).
- `pnpm exec next start apps/web --hostname 127.0.0.1 --port 3221`: started successfully.
- With `ASSURAPAY_NAVIGATION_BASE_URL=http://127.0.0.1:3221`, the navigation browser suite passed all 6 tests against the production build.
- Frontend route synchronization: 3 tests passed; all literal internal page links and frontend API references resolved, and inline route permissions matched the canonical policy.
- Current PostgreSQL boundary rerun: 2 files, 9 tests passed, including all newly present migrations (`navigation-postgres-boundaries.log`). This is narrower than rerunning all 501 database tests.
- No commit, main merge, remote deployment, provider payment or external email was performed for this increment.

Overall classification remains `ASSURAPAY_E2E_INCOMPLETE` pending the full production convergence mission.

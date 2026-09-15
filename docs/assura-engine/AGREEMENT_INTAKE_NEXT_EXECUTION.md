# Next executable slice

1. Wire persistence adapter/registry to `agreement_intakes` and validate migration conventions against repository database package.
2. Implement authenticated intake route handlers using existing agreement route helpers and permission model.
3. Wire the three-choice start and review/readiness UI to those routes.
4. Run focused package tests, then repository unit/integration/build.
5. Run live PostgreSQL/RLS and authenticated Playwright/accessibility/regression gates.
6. Fix every failure before changing certification status or merging PR #49.

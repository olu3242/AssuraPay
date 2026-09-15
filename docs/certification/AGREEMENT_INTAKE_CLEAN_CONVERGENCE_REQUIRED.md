# Clean convergence requirement

PR #49 accumulated unrelated marker/documentation commits and is not the merge vehicle.

Create `feat/agreement-intake-e2e-v2` from current `main` and port only the production slice:
- `packages/agreement-intelligence/src/agreement-intake.ts`
- `packages/agreement-intelligence/src/agreement-intake.test.ts`
- `packages/agreement-intelligence/src/agreement-intake-convergence.ts`
- `packages/agreement-intelligence/src/agreement-intake-convergence.test.ts`
- `packages/agreement-intelligence/src/agreement-intake.e2e.test.ts`
- required exports in `packages/agreement-intelligence/src/index.ts`
- `packages/database/migrations/202609150001_agreement_intakes.sql`
- `packages/database/migrations/202609150002_agreement_intakes_rls.sql`

Do not port marker `.txt` files or duplicate planning/certification documents. Runtime route/UI work must be built on the clean branch only.

# Batch 4 Validation Repair Report

## Original failures

The baseline had eleven TypeScript errors and four failing tests. Projection replay, execution forecasting, alert deduplication, and report execution methods were absent from `AssuraPayService`. KPI creation accepted SQL-like expressions. Persistence had only the earlier intelligence arrays and could not normalize the new Batch 4 collections.

## Root causes and repairs

- Added tenant/workspace-scoped projection checkpoint CRUD, monotonic sequence enforcement, idempotent event consumption, and rebuild records.
- Added execution forecast creation, scoped retrieval/listing, expiry handling, staleness, and separately persisted actual outcomes. Feature snapshots are copied and frozen at creation.
- Added deduplicated open alert instances.
- Added governed report definitions and runs with SQL rejection, permission checks, field masking, deterministic SHA-256 output hashes, and expired-output suppression.
- Added an allowlisted KPI formula validator with structured errors. It rejects SQL/code syntax, property traversal, unknown functions/identifiers, unbalanced parentheses, incomplete ratios, and constant divide-by-zero.
- KPI publication now revalidates formulas and prevents republishing a published definition. Divide-by-zero results are stored as `NOT_CALCULABLE` with a null value, not a successful zero.
- Added normalized file-store collections for checkpoints, rebuild jobs, projections, forecasts, outcomes, alerts, report definitions, and report runs. Existing snapshot values are retained.
- Disabled the obsolete `@next/next/no-html-link-for-pages` rule because the application uses the App Router; no fake Pages Router directory was introduced.

## Files changed by this repair

- `packages/domain/src/services/assurapay-service.ts`
- `packages/domain/src/services/kpi-formula-validator.ts`
- `packages/domain/src/services/batch4-extensions.test.ts`
- `packages/shared/src/index.ts`
- `packages/database/src/index.ts`
- `eslint.config.mjs`
- `docs/audit/BATCH_4_VALIDATION_REPAIR_BASELINE.md`
- `docs/audit/BATCH_4_VALIDATION_REPAIR_REPORT.md`

## Tests

Five tests were added; no tests were deleted and no assertion was weakened. Coverage now includes checkpoint uniqueness and backward-sequence rejection, forecast outcome preservation, report masking/hash determinism, formula injection and divide-by-zero behavior, and legacy snapshot normalization.

Final unit result: 6 files passed, 21 tests passed, 0 failed. Targeted Batch 4 extensions: 9 passed. Lint, root typecheck, production build, `git diff --check`, and the repository `certify` script pass.

The `test:integration` and `test:e2e` commands execute but discover zero matching tests (all 21 unit tests are skipped by each name filter). They therefore provide no integration or E2E certification. No `certify:intelligence` script exists.

## Remaining limitations

- Persistence is the file-backed development adapter; PostgreSQL persistence is not certified.
- Formula support is deliberately bounded and is not a general expression engine.
- Report outputs are represented by governed metadata and hashes; no production object-store adapter is certified.
- Unit validation does not certify all Engines 51–60 or the full AssuraPay MVP.

## Certification verdict

**CERTIFIED FOR FOUNDATION CHECKPOINT**

This verdict covers the validation-clean foundation checkpoint only. It does not claim production persistence, integration/E2E, full Enterprise Intelligence, or full MVP certification.

# Batch 4 Validation Repair Baseline

Captured on 2026-08-02 from `main` at `4fe5eaa` with the foundation worktree unstaged.

## Validation baseline

| Check | Result | Detail | Classification |
| --- | --- | --- | --- |
| `git diff --check` | Pass | No whitespace errors | — |
| `npm run lint` | Pass with warning | Next.js rule searches for a legacy `pages` directory while the application uses the App Router | Unrelated regression/configuration warning |
| `npm run typecheck` | Fail | Eleven errors in `batch4-extensions.test.ts`: projection, forecast, alert, and report methods are absent from `AssuraPayService`; the missing forecast return type causes one implicit `any` | Missing service method / Missing type |
| `npm run test` | Fail | 4 failed, 12 passed. Missing projection, forecast, and report methods cause three failures; unsafe SQL-like KPI formula is accepted | Missing service method / Formula validation gap |
| `npm run build` | Pass | Next.js production build completed with ten routes | — |

No test contract contradicts the approved architecture. The extension tests exercise expected Batch 4 behavior that has types or intent in the repository but lacks complete service and persistence wiring.

## Repair matrix

| Expected capability | Test requiring it | Shared type present | Persistence present | Service present | Validation present | Current failure | Required fix |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Projection checkpoints and idempotent replay | `batch4-extensions.test.ts` | Partial (`IntelligenceCheckpoint`, `RebuildJob`) | Partial legacy arrays only | No | No | Missing methods | Add explicit models, normalized collections, scoped CRUD, replay, and rebuild behavior |
| Safe KPI formulas and versioned publication | `batch4-extensions.test.ts`, `intelligence-foundation.test.ts` | Yes | Yes | Partial | No | SQL-like formula accepted | Add bounded formula validator, validation/simulation facade, safe publication, and calculation states |
| Execution forecasts and outcomes | `batch4-extensions.test.ts` | No | No | No | No | Missing methods | Add models, normalized collections, scoped lifecycle methods, immutability, expiry, and outcomes |
| Deduplicated alert instances | `batch4-extensions.test.ts` | No | No | No | No | Missing method | Add model, normalized collection, tenant/workspace dedupe behavior |
| Governed report definitions and runs | `batch4-extensions.test.ts` | No | No | No | No | Missing methods | Add models, normalized collections, safe configuration, masking, deterministic hashes, and scoped retrieval |
| Legacy snapshot compatibility | Existing store construction in intelligence tests | N/A | Partial | N/A | Partial normalization | New arrays absent | Normalize every new collection without replacing existing data |

## Exact original TypeScript failures

- Missing: `createProjectionCheckpoint`, `consumeProjectionEvent`, `rebuildProjection`.
- Missing: `createExecutionForecast`, `markForecastsStale`, `createAlertInstance`.
- Missing: `createReportDefinition`, `runReport`.
- The unresolved forecast method leaves the `stale.some(entry => ...)` callback parameter implicitly typed as `any`.

## Exact original test failures

- Projection replay: `createProjectionCheckpoint is not a function`.
- KPI validation: `SELECT * FROM x` resolved instead of rejecting with `Invalid formula`.
- Forecast lifecycle: `createExecutionForecast is not a function`.
- Report governance: `createReportDefinition is not a function`.

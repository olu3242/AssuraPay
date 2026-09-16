# Current state and reconciliation

## Run identity

- Required branch: `feat/assurapay-full-production-convergence`.
- Starting HEAD: `2ae1fe2419dcee1592e9fe1944cfabc805adab9c`.
- Worktree: `C:/Cdev/AssuraPay/AssuraPay-production-gaps`.
- Original user checkout remains separate; the requested logo/public navigation updates were also applied there. Backend convergence stays in this worktree.
- Node 24.16.0, pnpm 11.3.0, Next.js 14.2.35.
- Baseline inventory: 50 SQL migrations, 171 API route files, 25 page files.
- Replacement attachment f5b72cff contains the complete Waves 0–20; the earlier truncation is resolved.

## Reconciliation matrix

| Feature | Domain | Existing implementation / provenance | Proof | Remaining gap / action |
|---|---|---|---|---|
| Authentication and agreement consoles | Identity / web | Recovered PR 41 commits, present at starting HEAD; uncommitted hardening preserved | Prior targeted identity tests pass; new baseline has an erroneous request reference in assertion service | Fix scope boundary; certify HTTP and durable concurrency |
| Certification guard | Completion | Recovered PR 43 | Five targeted guard tests passed previously | Full browser chain unproven |
| Flow recovery | Flow orchestration | Recovered PR 48 ending at starting HEAD | Existing recovery tests | Reconcile provider and operator exceptions |
| Three-path intake | Agreement intelligence | origin/feat/agreement-intake-e2e-v2 at 6843c69 | Remote CI failed; tests and routes exist | Inspect canonical convergence, persistence, and authorization before adoption |
| Escrow convergence | Settlement assurance | origin/feat/escrow-agreement-convergence-e2e at 899ca23 | Remote CI failed | Avoid parallel agreement version/activation truth; review before adoption |
| Original merge repair | Database | Original checkout committed 0dae32b | Local commit exists | Existing convergence store already retains trust and Flow OS collections; compare before importing |
| Brand / global palette | Web | Uncommitted original checkout | Homepage/contracts/workflow browser checks in prior turn | Bring reviewed assets and dependency changes into convergence without copying credentials |
| Email delivery | Notifications | Uncommitted provider-neutral package and Resend adapter | Five contract tests previously passed | No live credentials; notification RLS policy failed boundary gate and must be corrected |
| PostgreSQL calendar dates | Database | Existing Batch L repository | Actual PostgreSQL scorecard test failed: dates shift back one day | Correct date decoding and prove across time zones |
| Browser provisioning | Database testing | Canonical test retained in this worktree | Original checkout replaces test with collection-name array | Preserve original edit; do not import its loss of assertions |

## Baseline evidence

Current rerun logs: `artifacts/convergence/full-batch-baseline/` (local).
Frozen install and lint pass. Formatting and typecheck fail before new code changes.
Typecheck: `apps/web/lib/trust-app.ts(520,5)` references undefined `request`.
Remaining gates are running; no successful certification is claimed.

Earlier local PostgreSQL run: 25 passing files, 4 failed files; 482 passed tests,
3 failed tests, 8 skipped. Failures include notification policy boundary, Batch L
calendar-date round-trip, and Batch A/G timeout failures. This is partial evidence,
not production or complete database certification.

Live email, payment provider, object storage/scanning and deployment remain unproven.
No production deployment or main merge is authorized. No secrets are copied into reports.

Latest frontend/navigation evidence is recorded in `FRONTEND_WIRING_VERIFICATION.md`. Full PostgreSQL run passed 501 tests in 32 files before the qualification migration; latest boundary rerun passed 9 tests.

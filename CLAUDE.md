# CLAUDE.md — AssuraPay

Working agreement for Claude / Claude Code sessions on this repository.

## Product one-liner

AssuraPay is an Execution Assurance Platform that transforms contractual obligations into governed, evidence-backed execution workflows and orchestrates settlement through certified Financial Providers without ever taking custody of funds.

## Hard constraints — never violate

1. **No custody, ever.** No code path may hold, pool, or have signing authority
   over end-user funds. All money movement happens through the licensed
   certified Financial Provider's own APIs through a Provider Adapter;
   AssuraPay only sends release/hold instructions.
2. **Every release is certified-work-backed.** No unconditional "release now" path exists. Release requires a valid Completion Certificate, Payment Eligibility record, approved Financial Entitlement, funding confirmation, authority approval and no active hold.
3. **Full audit trail.** Every state transition (created, funded-external,
   condition-verified, release-instructed, settled, disputed) is
   append-only and timestamped. Never mutate history in place.
4. **Naira-first, multi-currency-ready.** Default currency ₦ (NGN); design
   money fields as integer minor units (kobo) from day one.

## Canonical aggregate chain

The system is not centered on one mutable god object. The canonical chain is `Contract → PerformanceBlueprint → Milestone → DefinitionOfDonePackage → ExecutionWorkspace → CompletionCertificate → PaymentEligibility → FinancialEntitlement → ReleaseRequest → PaymentInstruction → ReconciliationRecord`. `AssuranceCase` may be used only as a cross-engine read model.

## Domain engines

See `docs/ENGINE_CATALOG.md` for the authoritative 60-engine catalog and `docs/ARCHITECTURE.md` for the six-wave dependency model.

Present the product through four platform pillars — Execution Assurance, Settlement Assurance, Intelligence, and Trust — while retaining the engine catalog as the authoritative domain decomposition. Use `docs/product/EXECUTION_ASSURANCE_MATURITY_MODEL.md` to distinguish the validated prototype, enterprise MVP, and target platform.

## Build conventions

- Next.js 14 (App Router) + TypeScript + Tailwind.
- Zod schemas mirror `docs/DATA_SCHEMA.md` exactly — schema doc is source of
  truth; regenerate types from it, don't let them drift.
- No ORM lock-in assumed yet; write data-access behind a repository interface
  so Postgres (via Supabase) can be swapped without touching engine logic.
- Prefer Claude's native capabilities and a small number of composable
  agents over heavy external orchestration platforms, consistent with prior
  Zenith AI builds.
- Every PR touching money-movement logic must include/update tests for the
  non-custody constraint (i.e., assert no code path calls a "hold funds"
  primitive that isn't the external Financial Provider's own escrow/hold API).

## Deliverable pattern

This repo follows the standard Zenith AI package pattern: landing page +
README + package.json + CLAUDE.md + PRD + BRD + architecture + diagram +
AI strategy + GTM + data schema, all production-grade, no stubs.

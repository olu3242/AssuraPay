# Escrow / Agreement Convergence

## Canonical chain

Agreement -> obligations/milestones -> escrow instruction -> external funding assurance -> execution -> evidence -> validation -> completion certification -> payment eligibility -> payment readiness -> conditional release -> independent approval -> payment execution -> reconciliation -> closure.

## Harmonization invariants

1. No second source of truth. Agreement/version, milestone, certification, funding, dispute, release and settlement state are read from their canonical domain aggregates.
2. No second custody model. AssuraPay is non-custodial. `EscrowFundingAssuranceEngine` records and confirms references to an external provider; it does not hold funds.
3. No caller-authored financial truth. API/UI/agents may request evaluation but must not supply authoritative booleans for funding, certification, eligibility, dispute or approval when canonical records exist.
4. No AI money movement. Agents may classify, extract and recommend. Deterministic policy + required human approval + governed command are required before a provider payment instruction.
5. No bypass path. New UI/API routes must call canonical engines through existing authorization/governed-command boundaries.
6. One identity chain. `tenantId`, `workspaceId`, `agreementId`, `agreementVersionId`, `milestoneId`, amount minor units and ISO currency remain traceable through funding, readiness, release, payment and reconciliation.
7. Amendments never mutate financial instructions silently. A changed executed agreement version compiles a new instruction and supersedes the old instruction through a governed transition.
8. Readiness is derived. `PaymentReadinessEngine` is an aggregator of authoritative domain state, not a competing lifecycle engine.
9. Events coordinate; they do not own protected state. Flow OS advances on canonical domain events only.
10. External provider state is reconciled, not assumed. Signed/idempotent provider events must be correlated to canonical provider references and reconciliation records.

## Completion gate

`ESCROW_AGREEMENT_CONVERGENCE_E2E_READY` is permitted only when durable PostgreSQL/RLS, governed API, provider/webhook idempotency, browser E2E, failure/retry/dispute/reconciliation drills and full CI are green. If a real provider or hosted environment is unavailable, use `ESCROW_AGREEMENT_CONVERGENCE_E2E_READY_WITH_EXTERNAL_BLOCKERS` and name the missing evidence.

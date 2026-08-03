# Settlement Assurance Architecture

## Goal
Provide a deterministic non-custodial settlement foundation that can turn a valid payment eligibility record into an entitlement, an invoice, a provider-confirmed funding reference and a condition-met release request, without AssuraPay ever taking custody of funds.

## Core Invariants
- AssuraPay never holds customer funds.
- Settlement state transitions remain domain-driven and auditable.
- Money values are stored in integer minor units.
- Payment success depends on provider confirmation rather than administrative assertions.

## Batch 9 implementation (Engines 41–45, `packages/settlement-assurance`)

`@assurapay/settlement-assurance` implements this model as the first half of Wave 5: `Payment Eligibility (41) → Financial Entitlement (42) → Invoice & Claim Management (43) → Escrow & Funding Assurance (44) → Conditional Release Orchestration (45)`, matching the canonical chain in `CLAUDE.md` up through `ReleaseRequest`. Unlike prior waves, Engines 41–45 cross-validate against **each other's own tables** where the reference is internal to this package (financial entitlement, invoice, fund reservation), while `milestoneId`, `completionCertificateId` and `paymentTriggerRuleId` remain opaque cross-package ids, following the same "externally supplied evidence" convention as `PaymentTriggerRuleEngine.evaluate` in `packages/performance-readiness`.

Financial entitlement, invoicing and release drafting only accept **integer minor units** (kobo) — every amount field is validated with `Number.isInteger` and rejects fractional or non-positive values. A financial entitlement's net payable can never be negative, and confirming it locks the record; an invoice auto-matches only on an exact amount match against the confirmed entitlement and cannot approve unless matched; a release request of type `FULL` must request exactly the entitlement's net payable.

**Engine 44 is the custody boundary of the whole platform.** `FundingCommitment` and `FundReservation` store only a `providerKey` and an `externalCustodyReference` — a pointer into the Financial Provider's own escrow record — never a balance AssuraPay itself holds. A commitment can only move from `PENDING_CONFIRMATION` to `CONFIRMED` when the caller-supplied `ExternalCustodyGateway.confirmFunding` (the Provider Adapter) itself reports `confirmed: true`; there is no local method that asserts funding unilaterally. Engine 45's `evaluate` only ever marks a release request `CONDITIONS_MET` or `BLOCKED` — it never authorizes or submits anything to a provider. Authorization (Financial Approval & Authority, Engine 46) and the actual payment instruction (Payment Execution & Treasury Integration, Engine 47) are deliberately out of scope and land in Batch 10.

See `packages/settlement-assurance/src/settlement-assurance.non-custody.test.ts` for the dedicated non-custody constraint suite required by `CLAUDE.md` for any PR touching money-movement logic.

A separate, pre-catalog demonstration of this same eligibility-to-settled-payment flow already exists in `packages/domain`'s `AssuraPayService` (see `packages/domain/src/services/settlement-assurance.test.ts`) — it predates the 60-engine catalog and, per `CLAUDE.md`, must not be extended with new trust-engine logic. `@assurapay/settlement-assurance` is the governed, catalog-aligned implementation going forward.

The in-memory `TrustPersistence` adapter and `deterministicCustodyGateway` certify orchestration only. Live PostgreSQL RLS and a production `ExternalCustodyGateway` backed by a real licensed Financial Provider remain deployment gates, consistent with prior batches.

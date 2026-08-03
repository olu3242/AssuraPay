# Settlement Assurance Architecture

## Goal
Provide a deterministic non-custodial settlement foundation that can turn a valid payment eligibility record into a settlement case, entitlement, invoice validation, funding confirmation, release request, and provider-backed payment instruction.

## Core Invariants
- AssuraPay never holds customer funds.
- Settlement state transitions remain domain-driven and auditable.
- Money values are stored in integer minor units.
- Payment success depends on provider confirmation rather than administrative assertions.

## Runtime Model
1. Certified milestone produces a payment eligibility record.
2. A settlement case is created from that eligibility.
3. A financial entitlement is calculated and approved.
4. An invoice is validated against entitlement.
5. Funding is confirmed through a deterministic sandbox commitment.
6. A release request is created and approved.
7. A payment instruction is issued through the provider abstraction and recorded as settled.

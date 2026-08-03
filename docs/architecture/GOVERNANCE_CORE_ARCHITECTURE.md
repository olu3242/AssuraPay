# Governance Core Architecture (Engines 06–10)

Batch 2 extends the Batch 1 trust boundary with one bounded package, `@assurapay/governance-core`. Every operation requires the existing authenticated workspace context; no identity, tenancy, party, legal, or permission abstraction is replaced.

The dependency direction is Execution → Milestone graph → immutable Definition of Done version/evaluation → human Certification → Payment Authorization Proposal. Execution history, certification decisions, and digital certification records are append-only. State changes emit through the existing outbox abstraction and significant decisions use the existing audit abstraction.

Payment triggers use integer minor units and can only create a governed authorization proposal. `EscrowReleaseOrchestrator` is an outbound interface that creates a provider intent; the engine has no transfer, debit, credit, balance, or custody capability. A human reviewer independent of the requester is authoritative for certification.

PostgreSQL persistence is defined by `202608030001_governance_core.sql`; the in-memory trust persistence remains the deterministic application/test adapter used by the current foundation.

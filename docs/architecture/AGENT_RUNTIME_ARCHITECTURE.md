# Agent Runtime Architecture — Engines 61–70

Batch 13 adds a governed execution-intelligence layer around, not inside, Engines 01–60. The only supported path is `User → AI Gateway → Prompt Registry → Agent Runtime → Capability Registry → deterministic engine contract → Governance → Audit`. Agents receive immutable references to agreements, blueprints, milestones and Definition of Done packages. They return proposals or deterministic read results; they never own those aggregates.

`AgentRuntimeEngine` is the sole execution entry point. It pins an active agent version, published prompt checksum, capability contract, context snapshot and governance-policy version. It supports bounded retry and cancellation, records append-only memory and telemetry, and emits audit/outbox records for material transitions. Capability declarations may expose `READ`, `PROPOSE`, or `EXECUTE_DETERMINISTIC`; a capability marked as protected state can only be `PROPOSE`. This makes direct certification, waiver, override, entitlement, release and payment mutation structurally invalid.

The registered operating identities are Atlas, Blueprint, DoD, Evidence, Validation, Risk, Settlement, Analytics, Advisor and Coordinator. Deployments create their workspace-specific versions and allowlists rather than relying on hidden defaults. Domain data is supplied by governed callers as an immutable `ExecutionContextSnapshot`; the agent package cannot reach into another package's persistence.

Human approval artifacts are proposal-hash-bound and single-use. Approval does not itself execute a protected action: the relevant deterministic engine remains responsible for authority, lifecycle and invariant checks.

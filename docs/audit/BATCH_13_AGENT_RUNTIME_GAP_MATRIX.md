# Batch 13 Agent Runtime Gap Matrix

| Requirement | Before | Certified implementation | Status |
| --- | --- | --- | --- |
| Governed lifecycle, retry, timeout, cancellation | No shared runtime | Pinned executions with bounded retry/provider timeout/terminal cancellation and audit | Implemented |
| Capability contracts | No shared registry | Owner, permission, deterministic contract, AI/approval/protected-state flags | Implemented |
| Ten agent identities | Documentation only | Canonical identity catalog plus versioned workspace registry and allowlists | Implemented |
| Prompt v2 | No shared lifecycle | Variables/output contracts, tests, checksum versions, publish and rollback | Implemented |
| AI Gateway v2 | Package-specific gateways | Model/rate/cost limits, retry/fallback, timeout and observability result | Implemented |
| Execution context | Ad hoc caller inputs | Immutable agreement/blueprint/milestone/DoD/history/tenant/user/permission snapshot | Implemented |
| Memory | None | Append-only conversation, reasoning metadata, tool/result history | Implemented |
| Human approvals | Domain-specific only | Human-only, proposal-bound and one-time approval artifacts | Implemented |
| Telemetry | None | Latency, cost, provider, errors, quality, hallucination and approval metrics | Implemented |
| Agent governance | No unified policy | Deny-by-default role/prompt/capability/model/approval policy plus audit | Implemented |
| Production providers and RLS certification | Not available locally | Contracts and migration supplied; environment certification required | Deployment gate |

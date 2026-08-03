# Agent Runtime Guide

Provision Batch 13 in this order: publish a governance policy; register capabilities backed by named deterministic contracts; publish versioned prompts with output contracts; register and activate one version of each agent identity; then create immutable context snapshots for each run. Invoke agents only through `AgentRuntimeEngine.execute`.

Retries are bounded by `maxAttempts`; model/provider retries and fallback are separately bounded by the AI Gateway policy. A cancelled, succeeded or failed execution is terminal. Operators monitor latency, provider, token cost, errors, hallucination flags, quality scores and approval-request rates through `AgentTelemetryEngine.summarize` and immutable audit events.

Do not encode business records in long-lived memory. Store governed record identifiers and source hashes, refresh context for a new execution, rotate provider credentials outside this package, and deactivate compromised capabilities or agent versions before incident investigation.

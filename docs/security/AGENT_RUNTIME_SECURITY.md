# Agent Runtime Security

- Governance denies execution when no active policy exists and independently allowlists role, prompt, capability and model.
- Workspace context is mandatory on every record and lookup. PostgreSQL RLS enforces tenant and workspace isolation in production.
- Protected lifecycle state is proposal-only. Agents cannot issue certificates, approve waivers or overrides, authorize releases, move funds, or call provider payment primitives.
- Approvals require a human actor distinct from the agent identity, are bound to the exact proposal hash, and can be consumed once.
- Prompts are checksum-versioned. Executions pin the published version used, preventing silent prompt drift.
- Context and memory are explicit and append-only; no hidden mutable reasoning state is treated as business evidence.
- Model, request-rate and per-invocation cost limits are enforced at the gateway. Provider fallback cannot bypass model policy.
- Audit metadata is sanitized by the shared persistence boundary; secrets and payment account details must never be placed in prompts or memory.

Production gates remain provider credential isolation, content filtering, malware-safe evidence retrieval, database role certification, retention policy, model red-team evaluation and external penetration testing.

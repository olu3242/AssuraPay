# Agent Runtime API Contracts

The package exposes TypeScript application-service contracts for Engines 61–70. Network adapters must authenticate the user, construct `RequestContext`, validate payloads, and call these services; they must not expose persistence objects or provider clients.

Primary operations are `AgentRuntimeEngine.execute/cancel`, `CapabilityRegistryEngine.register/deactivate`, `AgentRegistryEngine.register/activate`, `PromptRegistryEngine.createVersion/publish/rollback/render/test`, `ContextEngine.create/get`, `ExecutionMemoryEngine.append/history`, `HumanApprovalEngine.request/decide/consume`, `AgentTelemetryEngine.record/summarize`, and `AgentGovernanceEngine.publish/authorize`.

Errors are stable uppercase codes. HTTP adapters should map denial/approval codes to 403, missing records to 404, validation and terminal-state conflicts to 409 or 422, rate limits to 429, and unexpected provider failures to 502. Never serialize model credentials, internal provider errors or hidden reasoning.

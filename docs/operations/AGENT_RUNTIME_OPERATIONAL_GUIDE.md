# Agent Runtime Operational Guide

Alert on repeated failed executions, model-policy denials, cost-limit failures, anomalous hallucination flags, elevated approval requests and provider fallback. On incident, deactivate the affected capability, preserve execution/memory/telemetry/audit records, identify the pinned prompt and policy versions, and replay only against a non-production deterministic gateway.

Rollback prompts through `PromptRegistryEngine.rollback`; this publishes the selected prior version and retires the current one without deleting history. Agent rollback activates a prior registered version. Governance rollback is performed by publishing a new policy version containing the previously approved rules.

An AI response is never completion evidence, a certificate, an entitlement, a release authorization or proof of settlement. Operators route accepted proposals into the existing deterministic domain workflow, where all original authority and segregation-of-duty checks still apply.

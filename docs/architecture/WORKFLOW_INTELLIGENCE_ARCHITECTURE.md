# Workflow Intelligence Architecture — Engines 71–80

Batch 14 consumes version-pinned canonical outputs from Agreement Intelligence, Performance Blueprint, Milestone Planning, Definition of Done, Execution Orchestration, Completion Assurance, Settlement Assurance and Enterprise Analytics. It does not read their persistence directly and does not reproduce their transition rules. Inputs form an observation graph; outputs are immutable assessments, scores, predictions or recommendations suitable for Agent Runtime capabilities.

The flow is `canonical engine snapshots → workflow/dependency/SLA analysis → bottleneck/exception/risk analysis → schedule/resource recommendations → Execution Health`. Every recommendation is marked proposed or unreviewed. No class exposes milestone transition, evidence acceptance, certificate issuance, escalation delivery, schedule update, entitlement, release or payment operations.

`ExecutionHealthEngine` is the primary agreement KPI. Its explicit weights are milestone completion 20%, DoD compliance 20%, evidence quality 15%, validation 15%, approval velocity 10%, settlement readiness 10% and inverted execution risk 10%. Historical snapshots remain append-only and auditable.

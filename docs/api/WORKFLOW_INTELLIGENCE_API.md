# Workflow Intelligence API Reference

`POST /api/v1/workflow-intelligence` uses existing AssuraPay identity, session, tenant, workspace and correlation headers. The `operation` discriminator supports `workflow-status`, `dependency-analysis`, `bottleneck-report`, `sla-metrics`, `risk-prediction`, `resource-recommendations` and `execution-health` with an operation-specific `input` object.

Create-like immutable reports return 201. Validation, governance and authentication errors use the shared API error mapping. Every caller should pin canonical source versions; production adapters must enforce role-specific read and proposal permissions through the existing gateway and Agent Governance policy.

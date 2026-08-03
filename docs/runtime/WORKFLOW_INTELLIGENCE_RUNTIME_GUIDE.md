# Workflow Intelligence Runtime Guide

Build a version-pinned observation payload from canonical engine APIs. Validate tenant/workspace context, compute dependency and SLA reports, then persist workflow and execution-health snapshots. Expose recommendation capabilities through the Batch 13 Agent Runtime as read/propose capabilities only.

Run analysis when a canonical outbox event arrives or on a governed schedule. Deduplicate on source-version hashes in the production adapter. Alert on cycles, critical health, certain SLA breach, model-gateway failure and abnormal input volume. Never repair source state from this package.

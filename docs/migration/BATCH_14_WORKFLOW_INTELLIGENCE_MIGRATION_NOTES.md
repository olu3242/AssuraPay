# Batch 14 Migration Notes

Batch 14 is based on Batch 13 and therefore requires PR #7 (or equivalent commits) before application. Apply `202608030013_workflow_intelligence.sql` after the agent-runtime migration. Configure transaction-local tenant/workspace settings before reads or writes. No backfill or mutation of Engines 01–70 is required.

Seed Agent Runtime read/propose capabilities for workflow reports and execution-health recommendations. Do not grant protected lifecycle capabilities.

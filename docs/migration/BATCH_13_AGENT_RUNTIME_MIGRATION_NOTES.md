# Batch 13 Migration Notes

Apply `202608030012_agent_runtime.sql` after the Batch 12 migration. Configure `app.tenant_id` and `app.workspace_id` on every transaction before accessing agent runtime records. Existing Engines 01–60 require no schema or code changes.

Before enabling runtime traffic, seed workspace-specific governance, capabilities, prompts and the ten agent identities. No default policy is installed: absence of policy intentionally denies execution. Backfill is not required because execution memory and telemetry begin at rollout.

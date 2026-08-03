create schema if not exists workflow_intelligence;
create table if not exists workflow_intelligence.advisory_artifacts (
  id uuid primary key, tenant_id uuid not null, workspace_id uuid not null,
  agreement_id uuid not null, artifact_type text not null,
  source_versions jsonb not null, payload jsonb not null, payload_hash text not null,
  created_by uuid not null, created_at timestamptz not null default now()
);
create index if not exists workflow_intelligence_artifacts_scope on workflow_intelligence.advisory_artifacts (tenant_id, workspace_id, agreement_id, artifact_type, created_at desc);
alter table workflow_intelligence.advisory_artifacts enable row level security;
create policy workflow_intelligence_workspace_isolation on workflow_intelligence.advisory_artifacts
  using (tenant_id = current_setting('app.tenant_id', true)::uuid and workspace_id = current_setting('app.workspace_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid and workspace_id = current_setting('app.workspace_id', true)::uuid);
create or replace function workflow_intelligence.prevent_artifact_mutation() returns trigger language plpgsql as $$ begin raise exception 'workflow intelligence artifacts are append-only'; end $$;
create trigger workflow_intelligence_immutable before update or delete on workflow_intelligence.advisory_artifacts for each row execute function workflow_intelligence.prevent_artifact_mutation();

create schema if not exists agent_runtime;

create table if not exists agent_runtime.records (
  id uuid primary key,
  tenant_id uuid not null,
  workspace_id uuid not null,
  record_type text not null check (record_type in ('capability','agent','prompt','context','memory','approval','telemetry','governance_policy','execution')),
  version integer,
  status text,
  payload jsonb not null,
  payload_hash text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists agent_runtime_records_workspace_type on agent_runtime.records (tenant_id, workspace_id, record_type, created_at);
alter table agent_runtime.records enable row level security;

create policy agent_runtime_workspace_isolation on agent_runtime.records
  using (tenant_id = current_setting('app.tenant_id', true)::uuid and workspace_id = current_setting('app.workspace_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid and workspace_id = current_setting('app.workspace_id', true)::uuid);

create or replace function agent_runtime.prevent_record_mutation() returns trigger language plpgsql as $$
begin
  if old.record_type in ('context','memory','telemetry','execution') then raise exception 'agent runtime history is append-only'; end if;
  return new;
end $$;

create trigger agent_runtime_immutable_history before update or delete on agent_runtime.records
for each row execute function agent_runtime.prevent_record_mutation();

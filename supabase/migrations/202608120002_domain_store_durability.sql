BEGIN;

CREATE TABLE domain_records (
  tenant_id text NOT NULL,
  workspace_id text,
  collection text NOT NULL,
  record_id text NOT NULL,
  payload jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, collection, record_id),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (payload ->> 'id' = record_id),
  CHECK (payload ->> 'tenantId' = tenant_id)
);

CREATE INDEX domain_records_workspace_idx
  ON domain_records (tenant_id, workspace_id, collection);

ALTER TABLE domain_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_records FORCE ROW LEVEL SECURITY;

CREATE POLICY domain_records_tenant_isolation ON domain_records
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND (
      workspace_id IS NULL
      OR nullif(current_setting('app.workspace_id', true), '') IS NULL
      OR workspace_id = nullif(current_setting('app.workspace_id', true), '')
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')
    AND (
      workspace_id IS NULL
      OR nullif(current_setting('app.workspace_id', true), '') IS NULL
      OR workspace_id = nullif(current_setting('app.workspace_id', true), '')
    )
  );

CREATE FUNCTION domain_records_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.collection <> OLD.collection OR NEW.record_id <> OLD.record_id THEN
    RAISE EXCEPTION 'domain record identity is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER domain_records_guard_update
BEFORE UPDATE ON domain_records
FOR EACH ROW EXECUTE FUNCTION domain_records_guard_update();

COMMIT;

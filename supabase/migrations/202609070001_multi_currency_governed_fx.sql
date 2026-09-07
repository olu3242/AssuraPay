-- Governed multi-currency and FX persistence.
-- AssuraPay remains non-custodial: these records describe commercial obligations,
-- provider quotes/instructions and reconciled outcomes; they do not represent customer balances.

CREATE TABLE IF NOT EXISTS fx_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  source_currency TEXT NOT NULL CHECK (source_currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  source_amount_minor BIGINT NOT NULL CHECK (source_amount_minor >= 0),
  target_currency TEXT NOT NULL CHECK (target_currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  target_amount_minor BIGINT NOT NULL CHECK (target_amount_minor >= 0),
  rate_numerator BIGINT NOT NULL CHECK (rate_numerator > 0),
  rate_denominator BIGINT NOT NULL CHECK (rate_denominator > 0),
  rate_source TEXT NOT NULL CHECK (length(trim(rate_source)) > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > observed_at),
  status TEXT NOT NULL CHECK (status IN ('QUOTED','ACCEPTED','AUTHORIZED','EXPIRED','REJECTED')),
  accepted_by TEXT,
  authorized_by TEXT,
  idempotency_key TEXT NOT NULL,
  semantic_digest TEXT NOT NULL CHECK (length(trim(semantic_digest)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source_currency <> target_currency)
    OR (rate_numerator = rate_denominator AND source_amount_minor = target_amount_minor)
  ),
  CHECK (authorized_by IS NULL OR accepted_by IS NULL OR authorized_by <> accepted_by),
  UNIQUE (tenant_id, workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS fx_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  quote_id UUID NOT NULL REFERENCES fx_quotes(id),
  provider_id TEXT NOT NULL,
  source_currency TEXT NOT NULL CHECK (source_currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  source_amount_minor BIGINT NOT NULL CHECK (source_amount_minor >= 0),
  target_currency TEXT NOT NULL CHECK (target_currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  target_amount_minor BIGINT NOT NULL CHECK (target_amount_minor >= 0),
  rate_numerator BIGINT NOT NULL CHECK (rate_numerator > 0),
  rate_denominator BIGINT NOT NULL CHECK (rate_denominator > 0),
  rate_source TEXT NOT NULL,
  rate_timestamp TIMESTAMPTZ NOT NULL,
  rounding_mode TEXT NOT NULL CHECK (rounding_mode IN ('HALF_UP','DOWN')),
  status TEXT NOT NULL CHECK (status IN ('INSTRUCTED','CONFIRMED','FAILED','REVERSED')),
  provider_reference TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status <> 'CONFIRMED') OR (provider_reference IS NOT NULL AND confirmed_at IS NOT NULL)),
  UNIQUE (tenant_id, workspace_id, quote_id)
);

CREATE TABLE IF NOT EXISTS provider_currency_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  source_currency TEXT NOT NULL CHECK (source_currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  destination_currency TEXT NOT NULL CHECK (destination_currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  settlement_rail TEXT NOT NULL,
  supports_fx BOOLEAN NOT NULL DEFAULT false,
  quote_capability BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, provider_id, source_currency, destination_currency, settlement_rail)
);

CREATE TABLE IF NOT EXISTS reporting_currency_preferences (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD','CAD','GBP','EUR','NGN','GHS','KES','ZAR','JPY','BHD')),
  rate_policy TEXT NOT NULL DEFAULT 'TRANSACTION_DATE' CHECK (rate_policy IN ('TRANSACTION_DATE','SETTLEMENT_DATE','PERIOD_END','PERIOD_AVERAGE')),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id)
);

CREATE OR REPLACE FUNCTION refuse_final_fx_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FX_RECORD_DELETE_FORBIDDEN';
  END IF;
  IF OLD.status IN ('AUTHORIZED','EXPIRED','REJECTED','CONFIRMED','FAILED','REVERSED') THEN
    RAISE EXCEPTION 'FINAL_FX_RECORD_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fx_quotes_final_immutable ON fx_quotes;
CREATE TRIGGER fx_quotes_final_immutable
BEFORE UPDATE OR DELETE ON fx_quotes
FOR EACH ROW EXECUTE FUNCTION refuse_final_fx_mutation();

DROP TRIGGER IF EXISTS fx_conversions_final_immutable ON fx_conversions;
CREATE TRIGGER fx_conversions_final_immutable
BEFORE UPDATE OR DELETE ON fx_conversions
FOR EACH ROW EXECUTE FUNCTION refuse_final_fx_mutation();

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['fx_quotes','fx_conversions','provider_currency_capabilities','reporting_currency_preferences']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target || '_trust_scope', target);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace()) WITH CHECK (tenant_id = trust_current_tenant() AND workspace_id = trust_current_workspace())',
      target || '_trust_scope', target
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS fx_quotes_scope_status_idx ON fx_quotes(tenant_id, workspace_id, status, expires_at);
CREATE INDEX IF NOT EXISTS fx_conversions_scope_status_idx ON fx_conversions(tenant_id, workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS provider_currency_capabilities_route_idx ON provider_currency_capabilities(tenant_id, workspace_id, source_currency, destination_currency, active);

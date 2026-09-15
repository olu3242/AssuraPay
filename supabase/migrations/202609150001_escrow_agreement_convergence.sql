-- Agreement -> escrow -> settlement convergence.
-- Additive only: canonical funding/release/payment tables remain authoritative.

CREATE TABLE IF NOT EXISTS escrow_instructions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  agreement_id UUID NOT NULL,
  agreement_version_id UUID NOT NULL,
  milestone_id UUID NOT NULL,
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('DIRECT','MILESTONE_ESCROW','FULL_ESCROW','DEPOSIT_MILESTONES','RETAINER','PAY_ON_DELIVERY','EXTERNAL_PAYMENT')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
  provider_key TEXT,
  release_conditions JSONB NOT NULL,
  inspection_window_hours INTEGER,
  instruction_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPILED','FUNDING_PENDING','FUNDED','SUPERSEDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, workspace_id, agreement_version_id, milestone_id),
  UNIQUE (tenant_id, workspace_id, instruction_hash)
);

CREATE TABLE IF NOT EXISTS payment_readiness_assessments (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  escrow_instruction_id UUID NOT NULL REFERENCES escrow_instructions(id),
  milestone_id UUID NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  eligible BOOLEAN NOT NULL,
  blockers JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS escrow_instructions_workspace_milestone_idx ON escrow_instructions(tenant_id, workspace_id, milestone_id);
CREATE INDEX IF NOT EXISTS payment_readiness_workspace_milestone_idx ON payment_readiness_assessments(tenant_id, workspace_id, milestone_id, evaluated_at DESC);

ALTER TABLE escrow_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_readiness_assessments ENABLE ROW LEVEL SECURITY;

-- Match the repository-wide request-scoped tenant/workspace session variables used by durable persistence.
DROP POLICY IF EXISTS escrow_instructions_workspace_isolation ON escrow_instructions;
CREATE POLICY escrow_instructions_workspace_isolation ON escrow_instructions
USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS payment_readiness_workspace_isolation ON payment_readiness_assessments;
CREATE POLICY payment_readiness_workspace_isolation ON payment_readiness_assessments
USING (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true))
WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) AND workspace_id::text = current_setting('app.workspace_id', true));

-- Financial instruction history is immutable. Amendments compile a new agreement version/instruction.
CREATE OR REPLACE FUNCTION refuse_escrow_instruction_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ESCROW_INSTRUCTION_DELETE_FORBIDDEN'; END $$;
DROP TRIGGER IF EXISTS escrow_instructions_no_delete ON escrow_instructions;
CREATE TRIGGER escrow_instructions_no_delete BEFORE DELETE ON escrow_instructions FOR EACH ROW EXECUTE FUNCTION refuse_escrow_instruction_delete();

COMMENT ON TABLE escrow_instructions IS 'Immutable/version-bound agreement payment instructions; never custody records.';
COMMENT ON TABLE payment_readiness_assessments IS 'Append-only deterministic release-readiness decisions derived from canonical domain state.';

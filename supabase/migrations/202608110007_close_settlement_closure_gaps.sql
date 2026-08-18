-- Two closure rules that lived only in the engine, and the certificate that rests on them.
--
-- `SettlementClosureEngine.close` refuses an account with money still owed:
--
--   if (account.outstandingAmountMinor > 0) throw new Error('OUTSTANDING_BALANCE_UNRESOLVED');
--
-- and `issueCertificate` refuses an account that is not closed:
--
--   if (account.status !== 'CLOSED') throw new Error('ACCOUNT_NOT_CLOSED');
--
-- Neither rule reached the schema. `202608110001` constrained the settlement arithmetic and required a
-- closed account to record *when* it closed, but nothing required a closed account to owe nothing, and
-- the certificate's foreign key checked only that the account existed. A writer reaching the store
-- directly — `append`, `replace`, or SQL — could therefore persist a CLOSED account with a positive
-- outstanding balance, and then a certificate attesting it.
--
-- That combination is the one worth closing in the database rather than the engine. The financial
-- closure certificate is the evidence a milestone was settled in full; `issueCertificate` reads the
-- account's status and nothing else, so an account that says CLOSED while owing money is certified as
-- final, and the certificate is indistinguishable from a true one afterwards. Both halves are stated
-- here so that no path, including a future engine that forgets, can assert a closure that is not one.

DO $closure_owes_nothing$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'final_settlement_accounts'
  ) THEN RETURN; END IF;

  -- Guarded by name so a re-run is a no-op rather than a duplicate-object failure, matching every
  -- other constraint in this set.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'final_settlement_accounts_closed_owes_nothing'
      AND conrelid = 'final_settlement_accounts'::regclass
  ) THEN
    ALTER TABLE final_settlement_accounts
      ADD CONSTRAINT final_settlement_accounts_closed_owes_nothing
      CHECK (status <> 'CLOSED' OR outstanding_amount_minor = 0);
  END IF;
END
$closure_owes_nothing$;

DO $certificate_needs_closed_account$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'financial_closure_certificates'
  ) THEN RETURN; END IF;

  -- The account's status joins its identity key, so a child row can name the status it requires. The
  -- key carries `workspace_id` for the reason `202608110008` gives at length: a key on the tenant alone
  -- lets a certificate in one workspace cite an account in another workspace of the same tenant.
  -- Expressed as a unique index rather than a constraint because it is the referenced side of a
  -- foreign key and never a key anything looks up by.
  CREATE UNIQUE INDEX IF NOT EXISTS final_settlement_accounts_ws_id_status_key
    ON final_settlement_accounts (tenant_id, workspace_id, id, status);

  -- A constant, not a copy. A plain column holding 'CLOSED' would be a value a writer could set to
  -- anything and thereby choose which account status to demand; generated and stored, it is the same
  -- literal on every row, and the only way to satisfy the foreign key is for the referenced account to
  -- actually be closed. This is the same device `202608110003` used to make the digest chain a foreign
  -- key rather than a comparison someone remembers to perform.
  ALTER TABLE financial_closure_certificates
    ADD COLUMN IF NOT EXISTS required_account_status TEXT
    GENERATED ALWAYS AS ('CLOSED') STORED;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'financial_closure_certificates_closed_account_fk'
      AND conrelid = 'financial_closure_certificates'::regclass
  ) THEN
    -- Replaces the identity-only key rather than joining it: the stricter constraint implies the
    -- weaker one, and leaving both would mean two constraints to keep in agreement.
    ALTER TABLE financial_closure_certificates
      DROP CONSTRAINT IF EXISTS financial_closure_certificates_account_fk;
    ALTER TABLE financial_closure_certificates
      ADD CONSTRAINT financial_closure_certificates_closed_account_fk
      FOREIGN KEY (tenant_id, workspace_id, final_settlement_account_id, required_account_status)
      REFERENCES final_settlement_accounts (tenant_id, workspace_id, id, status);
  END IF;
END
$certificate_needs_closed_account$;

-- Cross-aggregate references carry the workspace, not just the tenant.
--
-- Every composite foreign key in Batches A-F was keyed `(tenant_id, <parent>_id)`. That is one scope
-- short. Row-level security confines a row to the caller's workspace, but a foreign key is checked by
-- the system, not through the policies: it asks only whether a row with that tenant and that id exists,
-- and it sees rows in every workspace of the tenant while doing so.
--
-- So in a tenant with more than one workspace, a writer in workspace A could name a parent belonging to
-- workspace B. The child row's own `workspace_id` is A, which is what RLS checks and what
-- `requireRelationalTenant` re-derives, so both boundaries are satisfied and the write is accepted.
-- Several engines never load the parent at all -- `LedgerPostingEngine.post` takes the payment
-- instruction id on trust -- so nothing in the application notices either.
--
-- The result is a row that belongs to one workspace and cites evidence from another, and RLS then hides
-- the halves from each other: a reader in A sees a ledger entry whose instruction does not exist, and a
-- reader in B sees an instruction with an entry it cannot account for. For a settlement chain whose
-- purpose is that every release traces to certified work, a link that crosses a tenancy boundary
-- undetected is the more serious kind of defect -- not a leak of data, but a loss of the meaning of the
-- evidence.
--
-- Reaching it requires a parent id from the other workspace, which is a UUID and not guessable. It is
-- not therefore hypothetical: ids travel in exports, logs and support tickets, and a person who is a
-- member of both workspaces has both halves legitimately in hand. The fix costs 25 unique keys and
-- makes the boundary structural, which is worth more than an argument about how the id might leak.
--
-- Mechanically: each referenced side gains `UNIQUE (tenant_id, workspace_id, ...)` covering exactly the
-- columns its children name, and each foreign key is dropped and re-added carrying `workspace_id`. The
-- constraint names are unchanged, so what the suites assert on still holds. Generated from the
-- migration set rather than typed, because 47 references transcribed by hand is 47 chances to omit the
-- column this migration exists to add.
--
-- No data changes. A deployment whose rows are all intra-workspace -- which is every deployment the
-- engines produced, since they always write parent and child in one workspace -- passes validation
-- untouched. If validation fails, it has found a genuine cross-workspace link, and that is a repair to
-- make deliberately rather than a constraint to relax.

DO $workspace_scoped_keys$
BEGIN
  -- The referenced sides first: a foreign key needs a unique key covering exactly its columns.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'agreement_approval_requests') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS agreement_approval_requests_ws_id_key
      ON agreement_approval_requests (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'agreement_document_versions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS agreement_document_versions_ws_id_key
      ON agreement_document_versions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'agreement_document_versions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS agreement_document_versions_ws_id_content_hash_key
      ON agreement_document_versions (tenant_id, workspace_id, id, content_hash);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'agreement_drafts') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS agreement_drafts_ws_id_key
      ON agreement_drafts (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'agreements_v2') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS agreements_v2_ws_id_key
      ON agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'approval_policies_v2') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS approval_policies_v2_ws_id_key
      ON approval_policies_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'authorization_decisions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS authorization_decisions_ws_id_key
      ON authorization_decisions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'blueprint_milestones') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS blueprint_milestones_ws_id_key
      ON blueprint_milestones (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'clause_instances_v2') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS clause_instances_v2_ws_id_key
      ON clause_instances_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'clause_versions_v2') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS clause_versions_v2_ws_id_key
      ON clause_versions_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'contract_template_versions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS contract_template_versions_ws_id_key
      ON contract_template_versions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'disputes') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS disputes_ws_id_key
      ON disputes (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'final_settlement_accounts') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS final_settlement_accounts_ws_id_key
      ON final_settlement_accounts (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'financial_entitlements') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS financial_entitlements_ws_id_currency_key
      ON financial_entitlements (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'fund_reservations') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS fund_reservations_ws_id_key
      ON fund_reservations (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'funding_commitments') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS funding_commitments_ws_id_key
      ON funding_commitments (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'invoices') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_ws_id_key
      ON invoices (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'invoices') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_ws_id_currency_key
      ON invoices (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'payment_eligibilities') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS payment_eligibilities_ws_id_key
      ON payment_eligibilities (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'payment_instructions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS payment_instructions_ws_id_key
      ON payment_instructions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'payment_instructions') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS payment_instructions_ws_id_currency_key
      ON payment_instructions (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'performance_blueprints') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS performance_blueprints_ws_id_key
      ON performance_blueprints (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'release_requests') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS release_requests_ws_id_currency_key
      ON release_requests (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'scope_items') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS scope_items_ws_id_key
      ON scope_items (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'signature_packages_v2') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS signature_packages_v2_ws_id_document_hash_key
      ON signature_packages_v2 (tenant_id, workspace_id, id, document_hash);
  END IF;
END
$workspace_scoped_keys$;

DO $workspace_scoped_references$
BEGIN

  -- Introduced by `202608100002_wave5_batch_b_settlement_authority`.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'authorization_decisions_release_request_currency_fk' AND t.relname = 'authorization_decisions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE authorization_decisions DROP CONSTRAINT authorization_decisions_release_request_currency_fk;
    ALTER TABLE authorization_decisions
      ADD CONSTRAINT authorization_decisions_release_request_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, release_request_id, currency)
      REFERENCES release_requests (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'financial_approval_decisions_authorization_fk' AND t.relname = 'financial_approval_decisions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE financial_approval_decisions DROP CONSTRAINT financial_approval_decisions_authorization_fk;
    ALTER TABLE financial_approval_decisions
      ADD CONSTRAINT financial_approval_decisions_authorization_fk
      FOREIGN KEY (tenant_id, workspace_id, authorization_id)
      REFERENCES authorization_decisions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'financial_entitlements_eligibility_fk' AND t.relname = 'financial_entitlements'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE financial_entitlements DROP CONSTRAINT financial_entitlements_eligibility_fk;
    ALTER TABLE financial_entitlements
      ADD CONSTRAINT financial_entitlements_eligibility_fk
      FOREIGN KEY (tenant_id, workspace_id, payment_eligibility_id)
      REFERENCES payment_eligibilities (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'fund_reservations_funding_commitment_fk' AND t.relname = 'fund_reservations'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE fund_reservations DROP CONSTRAINT fund_reservations_funding_commitment_fk;
    ALTER TABLE fund_reservations
      ADD CONSTRAINT fund_reservations_funding_commitment_fk
      FOREIGN KEY (tenant_id, workspace_id, funding_commitment_id)
      REFERENCES funding_commitments (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'fund_reservations_invoice_fk' AND t.relname = 'fund_reservations'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE fund_reservations DROP CONSTRAINT fund_reservations_invoice_fk;
    ALTER TABLE fund_reservations
      ADD CONSTRAINT fund_reservations_invoice_fk
      FOREIGN KEY (tenant_id, workspace_id, invoice_id)
      REFERENCES invoices (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'invoices_entitlement_currency_fk' AND t.relname = 'invoices'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE invoices DROP CONSTRAINT invoices_entitlement_currency_fk;
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_entitlement_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, financial_entitlement_id, currency)
      REFERENCES financial_entitlements (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'release_requests_entitlement_currency_fk' AND t.relname = 'release_requests'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE release_requests DROP CONSTRAINT release_requests_entitlement_currency_fk;
    ALTER TABLE release_requests
      ADD CONSTRAINT release_requests_entitlement_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, financial_entitlement_id, currency)
      REFERENCES financial_entitlements (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'release_requests_fund_reservation_fk' AND t.relname = 'release_requests'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE release_requests DROP CONSTRAINT release_requests_fund_reservation_fk;
    ALTER TABLE release_requests
      ADD CONSTRAINT release_requests_fund_reservation_fk
      FOREIGN KEY (tenant_id, workspace_id, fund_reservation_id)
      REFERENCES fund_reservations (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'release_requests_invoice_currency_fk' AND t.relname = 'release_requests'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE release_requests DROP CONSTRAINT release_requests_invoice_currency_fk;
    ALTER TABLE release_requests
      ADD CONSTRAINT release_requests_invoice_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, invoice_id, currency)
      REFERENCES invoices (tenant_id, workspace_id, id, currency);
  END IF;

  -- Introduced by `202608110001_wave5_batch_c_settlement_ledger`.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'financial_closure_certificates_account_fk' AND t.relname = 'financial_closure_certificates'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE financial_closure_certificates DROP CONSTRAINT financial_closure_certificates_account_fk;
    ALTER TABLE financial_closure_certificates
      ADD CONSTRAINT financial_closure_certificates_account_fk
      FOREIGN KEY (tenant_id, workspace_id, final_settlement_account_id)
      REFERENCES final_settlement_accounts (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'ledger_entries_instruction_currency_fk' AND t.relname = 'ledger_entries'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_instruction_currency_fk;
    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_entries_instruction_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, payment_instruction_id, currency)
      REFERENCES payment_instructions (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'payment_instructions_release_request_currency_fk' AND t.relname = 'payment_instructions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE payment_instructions DROP CONSTRAINT payment_instructions_release_request_currency_fk;
    ALTER TABLE payment_instructions
      ADD CONSTRAINT payment_instructions_release_request_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, release_request_id, currency)
      REFERENCES release_requests (tenant_id, workspace_id, id, currency);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'reconciliation_records_instruction_fk' AND t.relname = 'reconciliation_records'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE reconciliation_records DROP CONSTRAINT reconciliation_records_instruction_fk;
    ALTER TABLE reconciliation_records
      ADD CONSTRAINT reconciliation_records_instruction_fk
      FOREIGN KEY (tenant_id, workspace_id, payment_instruction_id)
      REFERENCES payment_instructions (tenant_id, workspace_id, id);
  END IF;

  -- Introduced by `202608110002_wave5_batch_d_dispute_linkage`.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'dispute_decisions_dispute_fk' AND t.relname = 'dispute_decisions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE dispute_decisions DROP CONSTRAINT dispute_decisions_dispute_fk;
    ALTER TABLE dispute_decisions
      ADD CONSTRAINT dispute_decisions_dispute_fk
      FOREIGN KEY (tenant_id, workspace_id, dispute_id)
      REFERENCES disputes (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'dispute_evidence_dispute_fk' AND t.relname = 'dispute_evidence'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE dispute_evidence DROP CONSTRAINT dispute_evidence_dispute_fk;
    ALTER TABLE dispute_evidence
      ADD CONSTRAINT dispute_evidence_dispute_fk
      FOREIGN KEY (tenant_id, workspace_id, dispute_id)
      REFERENCES disputes (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'dispute_holds_dispute_fk' AND t.relname = 'dispute_holds'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE dispute_holds DROP CONSTRAINT dispute_holds_dispute_fk;
    ALTER TABLE dispute_holds
      ADD CONSTRAINT dispute_holds_dispute_fk
      FOREIGN KEY (tenant_id, workspace_id, dispute_id)
      REFERENCES disputes (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'dispute_positions_dispute_fk' AND t.relname = 'dispute_positions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE dispute_positions DROP CONSTRAINT dispute_positions_dispute_fk;
    ALTER TABLE dispute_positions
      ADD CONSTRAINT dispute_positions_dispute_fk
      FOREIGN KEY (tenant_id, workspace_id, dispute_id)
      REFERENCES disputes (tenant_id, workspace_id, id);
  END IF;

  -- Introduced by `202608110003_wave5_close_batch_c_gaps`.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'reconciliation_records_instruction_currency_fk' AND t.relname = 'reconciliation_records'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE reconciliation_records DROP CONSTRAINT reconciliation_records_instruction_currency_fk;
    ALTER TABLE reconciliation_records
      ADD CONSTRAINT reconciliation_records_instruction_currency_fk
      FOREIGN KEY (tenant_id, workspace_id, payment_instruction_id, currency)
      REFERENCES payment_instructions (tenant_id, workspace_id, id, currency);
  END IF;

  -- Introduced by `202608110004_wave6_batch_e_performance_blueprint`.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'blueprint_milestones_blueprint_fk' AND t.relname = 'blueprint_milestones'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE blueprint_milestones DROP CONSTRAINT blueprint_milestones_blueprint_fk;
    ALTER TABLE blueprint_milestones
      ADD CONSTRAINT blueprint_milestones_blueprint_fk
      FOREIGN KEY (tenant_id, workspace_id, blueprint_id)
      REFERENCES performance_blueprints (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'deliverables_blueprint_fk' AND t.relname = 'deliverables'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE deliverables DROP CONSTRAINT deliverables_blueprint_fk;
    ALTER TABLE deliverables
      ADD CONSTRAINT deliverables_blueprint_fk
      FOREIGN KEY (tenant_id, workspace_id, blueprint_id)
      REFERENCES performance_blueprints (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'deliverables_scope_item_fk' AND t.relname = 'deliverables'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE deliverables DROP CONSTRAINT deliverables_scope_item_fk;
    ALTER TABLE deliverables
      ADD CONSTRAINT deliverables_scope_item_fk
      FOREIGN KEY (tenant_id, workspace_id, scope_item_id)
      REFERENCES scope_items (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'dod_packages_milestone_fk' AND t.relname = 'dod_packages'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE dod_packages DROP CONSTRAINT dod_packages_milestone_fk;
    ALTER TABLE dod_packages
      ADD CONSTRAINT dod_packages_milestone_fk
      FOREIGN KEY (tenant_id, workspace_id, milestone_id)
      REFERENCES blueprint_milestones (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'milestone_sequence_edges_blueprint_fk' AND t.relname = 'milestone_sequence_edges'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE milestone_sequence_edges DROP CONSTRAINT milestone_sequence_edges_blueprint_fk;
    ALTER TABLE milestone_sequence_edges
      ADD CONSTRAINT milestone_sequence_edges_blueprint_fk
      FOREIGN KEY (tenant_id, workspace_id, blueprint_id)
      REFERENCES performance_blueprints (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'milestone_sequence_edges_predecessor_fk' AND t.relname = 'milestone_sequence_edges'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE milestone_sequence_edges DROP CONSTRAINT milestone_sequence_edges_predecessor_fk;
    ALTER TABLE milestone_sequence_edges
      ADD CONSTRAINT milestone_sequence_edges_predecessor_fk
      FOREIGN KEY (tenant_id, workspace_id, predecessor_id)
      REFERENCES blueprint_milestones (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'milestone_sequence_edges_successor_fk' AND t.relname = 'milestone_sequence_edges'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE milestone_sequence_edges DROP CONSTRAINT milestone_sequence_edges_successor_fk;
    ALTER TABLE milestone_sequence_edges
      ADD CONSTRAINT milestone_sequence_edges_successor_fk
      FOREIGN KEY (tenant_id, workspace_id, successor_id)
      REFERENCES blueprint_milestones (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'scope_items_blueprint_fk' AND t.relname = 'scope_items'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE scope_items DROP CONSTRAINT scope_items_blueprint_fk;
    ALTER TABLE scope_items
      ADD CONSTRAINT scope_items_blueprint_fk
      FOREIGN KEY (tenant_id, workspace_id, blueprint_id)
      REFERENCES performance_blueprints (tenant_id, workspace_id, id);
  END IF;

  -- Introduced by `202608110005_wave6_batch_f_agreement_creation`.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_approval_decisions_request_fk' AND t.relname = 'agreement_approval_decisions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_approval_decisions DROP CONSTRAINT agreement_approval_decisions_request_fk;
    ALTER TABLE agreement_approval_decisions
      ADD CONSTRAINT agreement_approval_decisions_request_fk
      FOREIGN KEY (tenant_id, workspace_id, request_id)
      REFERENCES agreement_approval_requests (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_approval_requests_contract_fk' AND t.relname = 'agreement_approval_requests'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_approval_requests DROP CONSTRAINT agreement_approval_requests_contract_fk;
    ALTER TABLE agreement_approval_requests
      ADD CONSTRAINT agreement_approval_requests_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_approval_requests_document_fk' AND t.relname = 'agreement_approval_requests'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_approval_requests DROP CONSTRAINT agreement_approval_requests_document_fk;
    ALTER TABLE agreement_approval_requests
      ADD CONSTRAINT agreement_approval_requests_document_fk
      FOREIGN KEY (tenant_id, workspace_id, document_version_id, document_hash)
      REFERENCES agreement_document_versions (tenant_id, workspace_id, id, content_hash);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_approval_requests_policy_fk' AND t.relname = 'agreement_approval_requests'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_approval_requests DROP CONSTRAINT agreement_approval_requests_policy_fk;
    ALTER TABLE agreement_approval_requests
      ADD CONSTRAINT agreement_approval_requests_policy_fk
      FOREIGN KEY (tenant_id, workspace_id, policy_id)
      REFERENCES approval_policies_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_document_versions_contract_fk' AND t.relname = 'agreement_document_versions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_document_versions DROP CONSTRAINT agreement_document_versions_contract_fk;
    ALTER TABLE agreement_document_versions
      ADD CONSTRAINT agreement_document_versions_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_document_versions_supersedes_fk' AND t.relname = 'agreement_document_versions'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_document_versions DROP CONSTRAINT agreement_document_versions_supersedes_fk;
    ALTER TABLE agreement_document_versions
      ADD CONSTRAINT agreement_document_versions_supersedes_fk
      FOREIGN KEY (tenant_id, workspace_id, supersedes_id)
      REFERENCES agreement_document_versions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_drafts_contract_fk' AND t.relname = 'agreement_drafts'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_drafts DROP CONSTRAINT agreement_drafts_contract_fk;
    ALTER TABLE agreement_drafts
      ADD CONSTRAINT agreement_drafts_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_drafts_document_version_fk' AND t.relname = 'agreement_drafts'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_drafts DROP CONSTRAINT agreement_drafts_document_version_fk;
    ALTER TABLE agreement_drafts
      ADD CONSTRAINT agreement_drafts_document_version_fk
      FOREIGN KEY (tenant_id, workspace_id, current_document_version_id)
      REFERENCES agreement_document_versions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_drafts_template_version_fk' AND t.relname = 'agreement_drafts'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_drafts DROP CONSTRAINT agreement_drafts_template_version_fk;
    ALTER TABLE agreement_drafts
      ADD CONSTRAINT agreement_drafts_template_version_fk
      FOREIGN KEY (tenant_id, workspace_id, template_version_id)
      REFERENCES contract_template_versions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_execution_certificates_contract_fk' AND t.relname = 'agreement_execution_certificates'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_execution_certificates DROP CONSTRAINT agreement_execution_certificates_contract_fk;
    ALTER TABLE agreement_execution_certificates
      ADD CONSTRAINT agreement_execution_certificates_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agreement_execution_certificates_package_fk' AND t.relname = 'agreement_execution_certificates'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE agreement_execution_certificates DROP CONSTRAINT agreement_execution_certificates_package_fk;
    ALTER TABLE agreement_execution_certificates
      ADD CONSTRAINT agreement_execution_certificates_package_fk
      FOREIGN KEY (tenant_id, workspace_id, package_id, document_hash)
      REFERENCES signature_packages_v2 (tenant_id, workspace_id, id, document_hash);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'clause_deviations_v2_baseline_fk' AND t.relname = 'clause_deviations_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE clause_deviations_v2 DROP CONSTRAINT clause_deviations_v2_baseline_fk;
    ALTER TABLE clause_deviations_v2
      ADD CONSTRAINT clause_deviations_v2_baseline_fk
      FOREIGN KEY (tenant_id, workspace_id, baseline_version_id)
      REFERENCES clause_versions_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'clause_deviations_v2_instance_fk' AND t.relname = 'clause_deviations_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE clause_deviations_v2 DROP CONSTRAINT clause_deviations_v2_instance_fk;
    ALTER TABLE clause_deviations_v2
      ADD CONSTRAINT clause_deviations_v2_instance_fk
      FOREIGN KEY (tenant_id, workspace_id, instance_id)
      REFERENCES clause_instances_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'clause_instances_v2_clause_version_fk' AND t.relname = 'clause_instances_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE clause_instances_v2 DROP CONSTRAINT clause_instances_v2_clause_version_fk;
    ALTER TABLE clause_instances_v2
      ADD CONSTRAINT clause_instances_v2_clause_version_fk
      FOREIGN KEY (tenant_id, workspace_id, clause_version_id)
      REFERENCES clause_versions_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'clause_instances_v2_draft_fk' AND t.relname = 'clause_instances_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE clause_instances_v2 DROP CONSTRAINT clause_instances_v2_draft_fk;
    ALTER TABLE clause_instances_v2
      ADD CONSTRAINT clause_instances_v2_draft_fk
      FOREIGN KEY (tenant_id, workspace_id, draft_id)
      REFERENCES agreement_drafts (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'contract_comments_contract_fk' AND t.relname = 'contract_comments'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE contract_comments DROP CONSTRAINT contract_comments_contract_fk;
    ALTER TABLE contract_comments
      ADD CONSTRAINT contract_comments_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'negotiation_rounds_contract_fk' AND t.relname = 'negotiation_rounds'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE negotiation_rounds DROP CONSTRAINT negotiation_rounds_contract_fk;
    ALTER TABLE negotiation_rounds
      ADD CONSTRAINT negotiation_rounds_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'negotiation_rounds_document_version_fk' AND t.relname = 'negotiation_rounds'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE negotiation_rounds DROP CONSTRAINT negotiation_rounds_document_version_fk;
    ALTER TABLE negotiation_rounds
      ADD CONSTRAINT negotiation_rounds_document_version_fk
      FOREIGN KEY (tenant_id, workspace_id, document_version_id)
      REFERENCES agreement_document_versions (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'signature_packages_v2_approval_request_fk' AND t.relname = 'signature_packages_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE signature_packages_v2 DROP CONSTRAINT signature_packages_v2_approval_request_fk;
    ALTER TABLE signature_packages_v2
      ADD CONSTRAINT signature_packages_v2_approval_request_fk
      FOREIGN KEY (tenant_id, workspace_id, approval_request_id)
      REFERENCES agreement_approval_requests (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'signature_packages_v2_contract_fk' AND t.relname = 'signature_packages_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE signature_packages_v2 DROP CONSTRAINT signature_packages_v2_contract_fk;
    ALTER TABLE signature_packages_v2
      ADD CONSTRAINT signature_packages_v2_contract_fk
      FOREIGN KEY (tenant_id, workspace_id, contract_id)
      REFERENCES agreements_v2 (tenant_id, workspace_id, id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'signature_packages_v2_document_fk' AND t.relname = 'signature_packages_v2'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE signature_packages_v2 DROP CONSTRAINT signature_packages_v2_document_fk;
    ALTER TABLE signature_packages_v2
      ADD CONSTRAINT signature_packages_v2_document_fk
      FOREIGN KEY (tenant_id, workspace_id, document_version_id, document_hash)
      REFERENCES agreement_document_versions (tenant_id, workspace_id, id, content_hash);
  END IF;
END
$workspace_scoped_references$;

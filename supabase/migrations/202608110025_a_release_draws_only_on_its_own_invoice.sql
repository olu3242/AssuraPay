-- A release request's invoice, entitlement, milestone and reservation must be the same transaction.
--
-- `ConditionalReleaseOrchestrationEngine.draft` reads the entitlement, the invoice and the
-- reservation, and never compares them. It checks the amount and the release type; nothing requires
-- the reservation to be the one made for this invoice, or the entitlement to be the one the invoice
-- was raised against, or any of them to concern the same milestone.
--
-- So milestone A's entitlement can authorise an amount while milestone B's reservation pays it. Every
-- constraint that existed was satisfied: all three parents are real, all three are in the caller's
-- workspace, all three agree on currency. The money comes out of the wrong pot and the invoice whose
-- funds were taken still looks funded, so the shortfall surfaces at some later release that has no
-- obvious connection to the one that caused it.
--
-- ## Composite foreign keys, not a trigger
--
-- This is a pairing rule, not an aggregate, so it is expressible as a key — and this schema already
-- uses exactly that technique to make a currency mismatch impossible: `release_requests` references
-- `invoices (id, currency)` rather than `invoices (id)`. These two keys extend the same idea to the
-- rest of the pairing, which means the database rejects the combination structurally rather than
-- depending on a function running.
--
-- Each needs a unique index on the referenced columns, which is what the two indexes below are for.
-- They are not uniqueness rules in their own right — `id` is already unique, so adding columns to it
-- cannot constrain anything new. They exist only to make the composite references legal.

-- Step 1. The reservation's invoice, exposed as a referable key.
CREATE UNIQUE INDEX IF NOT EXISTS fund_reservations_tenant_ws_id_invoice_key
  ON fund_reservations (tenant_id, workspace_id, id, invoice_id);

-- Step 2. The invoice's entitlement and milestone, likewise.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_ws_id_entitlement_milestone_key
  ON invoices (tenant_id, workspace_id, id, financial_entitlement_id, milestone_id);

DO $release_pairing$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'release_requests'
  ) THEN RETURN; END IF;

  -- Step 3. The reservation a release draws on must be the reservation made for its invoice.
  --
  -- NOT VALID, deliberately, and for the same reason `202608110023` and `202608110024` report an
  -- existing breach instead of rewriting it. A NOT VALID foreign key is enforced on every insert and
  -- update from here on; what it does not do is fail this migration on rows written before the rule
  -- existed. Validating retroactively would either abort the migration on the hosts that most need
  -- the constraint, or require editing settled financial history to make the migration pass. Neither
  -- is acceptable, and a rule enforced from now on is worth more than a migration that cannot run.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'release_requests_reservation_matches_invoice_fk'
      AND conrelid = 'release_requests'::regclass
  ) THEN
    ALTER TABLE release_requests
      ADD CONSTRAINT release_requests_reservation_matches_invoice_fk
      FOREIGN KEY (tenant_id, workspace_id, fund_reservation_id, invoice_id)
      REFERENCES fund_reservations (tenant_id, workspace_id, id, invoice_id)
      NOT VALID;
  END IF;

  -- Step 4. The entitlement a release cites, and the milestone it names, must be the invoice's own.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'release_requests_entitlement_matches_invoice_fk'
      AND conrelid = 'release_requests'::regclass
  ) THEN
    ALTER TABLE release_requests
      ADD CONSTRAINT release_requests_entitlement_matches_invoice_fk
      FOREIGN KEY (tenant_id, workspace_id, invoice_id, financial_entitlement_id, milestone_id)
      REFERENCES invoices (tenant_id, workspace_id, id, financial_entitlement_id, milestone_id)
      NOT VALID;
  END IF;
END
$release_pairing$;

COMMENT ON INDEX fund_reservations_tenant_ws_id_invoice_key IS
  'Exists to make (id, invoice_id) referable, so a release request can be keyed to the reservation '
  'made for its own invoice. Not a uniqueness rule: id is already unique.';

COMMENT ON INDEX invoices_tenant_ws_id_entitlement_milestone_key IS
  'Exists to make (id, financial_entitlement_id, milestone_id) referable, so a release request '
  'cannot cite an entitlement or milestone that is not its invoice''s. Not a uniqueness rule.';

-- Reports what the NOT VALID keys leave behind, so a host knows whether it has any.
DO $release_pairing_report$
DECLARE
  crossed INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'release_requests'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO crossed
    FROM release_requests q
    LEFT JOIN fund_reservations r
      ON r.tenant_id = q.tenant_id AND r.workspace_id = q.workspace_id
     AND r.id = q.fund_reservation_id AND r.invoice_id = q.invoice_id
    LEFT JOIN invoices i
      ON i.tenant_id = q.tenant_id AND i.workspace_id = q.workspace_id
     AND i.id = q.invoice_id AND i.financial_entitlement_id = q.financial_entitlement_id
     AND i.milestone_id = q.milestone_id
   WHERE r.id IS NULL OR i.id IS NULL;

  IF crossed > 0 THEN
    RAISE WARNING
      'RELEASE_REQUESTS_ALREADY_CROSS_REFERENCED: % release request(s) name a reservation, '
      'entitlement or milestone that is not their invoice''s, and predate these keys. They are left '
      'as they are; correct them through the cancellation and reversal paths.', crossed;
  END IF;
END
$release_pairing_report$;

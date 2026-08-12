-- The invoice-number key was stricter than the engine, which made a legitimate correction impossible.
--
-- `202608100002` added `UNIQUE (tenant_id, workspace_id, invoice_number)` on `invoices`. Correct in
-- making the key tenant-scoped — the constraint it replaced predated tenancy — and wrong in being
-- unconditional.
--
-- `InvoiceClaimEngine.submit` refuses a duplicate like this:
--
--   .some((x) => x.workspaceId === workspaceId
--                && x.invoiceNumber === input.invoiceNumber
--                && x.status !== 'REJECTED')
--
-- The `status !== 'REJECTED'` clause is deliberate and load-bearing: rejecting an invoice is how a
-- claim is sent back for correction, and the corrected claim carries the **same invoice number**,
-- because that number is the counterparty's document reference rather than a surrogate key. An
-- unconditional unique constraint refuses that resubmission, so the durable path could reject an
-- invoice and then refuse to accept its correction — leaving a confirmed entitlement with no route to
-- an invoice at all.
--
-- Batch B's own activation exercised submission and rejection separately and never resubmitted after a
-- rejection, which is why every gate passed. Found in review of the merged change, confirmed against
-- both the engine and the constraint, and fixed here rather than restated as a caveat.
--
-- A partial unique index rather than a constraint, because a constraint cannot carry a predicate. That
-- is also why the constraint is dropped rather than altered. Nothing references it: the foreign keys on
-- `invoices` target `UNIQUE (tenant_id, id)`, so the index is not a key anything depends on.
--
-- FORWARD-ONLY. `202608100002` is not modified.

DO $invoice_number$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'invoices'
  ) THEN RETURN; END IF;

  -- Refuse rather than coerce: two live invoices sharing a number within one workspace would be
  -- ambiguous under the narrower rule too, and silently dropping the constraint would hide that.
  IF EXISTS (
    SELECT 1 FROM invoices
    WHERE status <> 'REJECTED'
    GROUP BY tenant_id, workspace_id, invoice_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'BATCH_B_INVOICE_NUMBER_REFUSED: a workspace holds more than one non-rejected invoice with the '
      'same number. The narrower key cannot be created without losing that distinction. Nothing has '
      'been changed.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = format('%I.invoices', current_schema())::regclass
      AND conname = 'invoices_workspace_number_unique'
  ) THEN
    ALTER TABLE invoices DROP CONSTRAINT invoices_workspace_number_unique;
  END IF;

  -- The engine's rule, stated once more in the column. A rejected invoice keeps its number and stops
  -- reserving it.
  CREATE UNIQUE INDEX IF NOT EXISTS invoices_live_number_unique
    ON invoices (tenant_id, workspace_id, invoice_number)
    WHERE status <> 'REJECTED';
END
$invoice_number$;

COMMENT ON INDEX invoices_live_number_unique IS
  'One live invoice per number per workspace. Partial on status <> REJECTED, matching InvoiceClaimEngine.submit: a rejected claim is corrected and resubmitted under the same counterparty document reference, so a rejected row must stop reserving its number.';

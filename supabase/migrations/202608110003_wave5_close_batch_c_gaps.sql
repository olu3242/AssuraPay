-- Closing the two gaps Batch C recorded rather than papered over.
--
-- `docs/persistence/WAVE_5_BATCH_C_ACTIVATION.md` named both under "Two gaps recorded rather than
-- papered over", and said of each that closing it "needs a change to a domain type, and this
-- capability is persistence". This migration is the other side of that sentence: the domain types
-- changed, so the columns can now exist.
--
-- 1. `reconciliation_records` held **two money amounts and no currency**.
--
--    Nothing was wrong in practice, because the two amounts are only ever compared to each other.
--    But MONETARY_INVARIANTS requires a currency to travel with every amount, and without the column
--    the foreign key to `payment_instructions` could not carry currency the way `ledger_entries`
--    does — so a reconciliation could be recorded against an instruction in a currency the
--    reconciliation never named, and nothing would notice.
--
--    Backfilled rather than guarded, because the value is *derivable*: the currency of a
--    reconciliation is the currency of the instruction it reconciles, which is a column on that
--    instruction. A deterministic backfill from the parent is not a judgement call, so refusing here
--    would be refusing to do arithmetic the schema already knows the answer to.
--
-- 2. `payment_instructions` held an `idempotency_key` and **no payload digest**.
--
--    MONETARY_INVARIANTS: "Reusing a key with a different semantic payload **fails**. This needs a
--    stored payload digest to compare against; a key alone cannot detect it." Without it,
--    `PaymentExecutionEngine.issue` returned the existing instruction for *any* repeat of the key —
--    so a retry that had drifted to a different beneficiary or a different amount was silently
--    accepted as the original. That is the single failure mode idempotency exists to prevent, and it
--    was the behaviour.
--
--    **Guarded, not backfilled**, and the asymmetry with the currency column is the point. The digest
--    is a SHA-256 over a canonical JSON payload computed by the engine; reproducing it in SQL would
--    mean reimplementing that canonicalisation in PL/pgSQL and keeping the two byte-identical
--    forever. A digest that disagrees with the one the application computes is worse than no digest:
--    every retry would look like a payload mismatch and every legitimate idempotent call would fail.
--    So a populated table is refused with an explanation instead.
--
--    In practice this refusal cannot fire: `payment_instructions` was dead until `202608110001`
--    activated it, so no deployment has rows. Stated rather than assumed.
--
-- NO HISTORICAL MIGRATION IS MODIFIED. Forward-only, additive.

DO $reconciliation_currency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'reconciliation_records'
  ) THEN RETURN; END IF;

  ALTER TABLE reconciliation_records ADD COLUMN IF NOT EXISTS currency TEXT;

  -- Derived from the parent, which is the only place the answer could come from. Runs under the
  -- migration's own transaction, so a failure leaves the column absent rather than half-populated.
  UPDATE reconciliation_records r
     SET currency = p.currency
    FROM payment_instructions p
   WHERE p.tenant_id = r.tenant_id
     AND p.id = r.payment_instruction_id
     AND r.currency IS NULL;

  -- Any row the backfill could not reach has no instruction to inherit from, which means the
  -- pre-existing foreign key was already violated. Refusing is the only honest outcome — inventing a
  -- currency for an orphan reconciliation would make a broken row look sound.
  IF EXISTS (SELECT 1 FROM reconciliation_records WHERE currency IS NULL) THEN
    RAISE EXCEPTION
      'WAVE5_GAP_CLOSURE_REFUSED: reconciliation_records holds row(s) whose payment instruction '
      'cannot be found, so their currency cannot be derived. Nothing has been changed.';
  END IF;

  ALTER TABLE reconciliation_records ALTER COLUMN currency SET NOT NULL;
  ALTER TABLE reconciliation_records
    ADD CONSTRAINT reconciliation_records_currency_ck CHECK (currency IN ('NGN', 'USD'));

  -- The whole reason the column exists: the key can now carry currency, so a reconciliation and the
  -- payment it reconciles cannot disagree about the unit. Replaces the tenant-only key
  -- `202608110001` added, which could not express this.
  ALTER TABLE reconciliation_records DROP CONSTRAINT IF EXISTS reconciliation_records_instruction_fk;
  ALTER TABLE reconciliation_records
    ADD CONSTRAINT reconciliation_records_instruction_currency_fk
    FOREIGN KEY (tenant_id, payment_instruction_id, currency)
    REFERENCES payment_instructions (tenant_id, id, currency);
END
$reconciliation_currency$;

DO $instruction_digest$
DECLARE
  rows BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'payment_instructions'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO rows FROM payment_instructions;
  IF rows > 0 THEN
    RAISE EXCEPTION
      'WAVE5_GAP_CLOSURE_REFUSED: payment_instructions holds % row(s), and payload_digest cannot be '
      'derived in SQL — it is a SHA-256 over a canonical JSON payload the application computes, and '
      'a digest that disagreed with the application''s would make every legitimate idempotent retry '
      'fail as a payload mismatch. Nothing has been changed. Backfill through the application, then '
      're-run.',
      rows;
  END IF;

  ALTER TABLE payment_instructions ADD COLUMN IF NOT EXISTS payload_digest TEXT;
  ALTER TABLE payment_instructions ALTER COLUMN payload_digest SET NOT NULL;
  ALTER TABLE payment_instructions
    ADD CONSTRAINT payment_instructions_payload_digest_len
    CHECK (length(payload_digest) BETWEEN 1 AND 200);

  -- Immutable, and that is what makes it evidence. A digest a writer could rewrite would let a
  -- drifted retry be made to match after the fact, which is precisely the comparison it exists to
  -- support. Added to the governed-transition trigger's immutable list by replacing the trigger with
  -- the same one plus this column.
  DROP TRIGGER IF EXISTS payment_instructions_governed_transition ON payment_instructions;
  CREATE TRIGGER payment_instructions_governed_transition
    BEFORE UPDATE OR DELETE ON payment_instructions
    FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
      'id', 'tenant_id', 'workspace_id', 'release_request_id', 'provider_key', 'idempotency_key',
      'payload_digest', 'beneficiary_reference', 'amount_minor', 'currency', 'created_at',
      'schema_version');
END
$instruction_digest$;

-- Reserved funds may never exceed the funds a provider confirmed.
--
-- AssuraPay takes no custody, so a fund reservation is a claim on money a licensed provider is
-- holding. Over-reserving means the platform has promised the same custodied naira twice: the
-- second release passes every internal gate, reaches the provider, and fails there — after a human
-- approved it and after the payer was told the funds were secured. The damage is done before
-- anything detects it.
--
-- `EscrowFundingAssuranceEngine.reserve` already sums the active reservations and compares them with
-- the commitment before appending. That check is correct in a single caller and worthless in two:
-- it is a read-then-write that runs in no transaction, so two concurrent reservations both read the
-- old total, both pass, and both insert. `docs/finance/MONETARY_INVARIANTS.md` is explicit that "an
-- invariant that PostgreSQL can enforce must not exist only as an application check", and lists
-- enforcing a monetary invariant "only in TypeScript" among its prohibited shortcuts. This is the
-- same defect `financial_closure_certificates` already solved with a partial unique index, recorded
-- there as "the engine counts ISSUED rows before issuing, which two concurrent requests both pass".
--
-- ## Why a trigger rather than an index or a check
--
-- A unique index cannot express it and a column `CHECK` cannot either: the rule is a property of a
-- *set* of rows in one table measured against a column in another. That leaves a trigger, which is
-- the mechanism `enforce_ledger_journal_balance` chose for the same reason.
--
-- ## Why it is not deferred, unlike the balance trigger
--
-- The balance trigger defers to COMMIT because a balanced journal is written leg by leg inside one
-- transaction, so the set is only correct once that transaction is done. Deferring here would not
-- work. Two concurrent reservations are two *separate* transactions, and neither can see the other's
-- uncommitted row at COMMIT or at any other time — so both would sum only their own and both would
-- pass. Deferral would produce a trigger that looks like enforcement and prevents nothing.
--
-- What actually serializes them is the lock below: the trigger takes `FOR UPDATE` on the parent
-- commitment before summing, so the second transaction blocks until the first commits, then re-reads
-- and sees it. Under READ COMMITTED each statement takes a fresh snapshot, which is what makes the
-- re-read see the committed row.
CREATE OR REPLACE FUNCTION enforce_fund_reservation_within_commitment() RETURNS trigger
LANGUAGE plpgsql AS $reservation$
DECLARE
  committed BIGINT;
  reserved  BIGINT;
BEGIN
  -- Only a reservation that actually holds funds constrains anything. RELEASED and CANCELLED rows
  -- have given their claim back, and re-checking on their transition would refuse a release whenever
  -- the commitment was already at its limit — which is precisely when a release must be allowed.
  IF NEW.status IS DISTINCT FROM 'RESERVED' THEN
    RETURN NULL;
  END IF;

  -- The lock, and the whole point of this function. Read as the caller rather than SECURITY DEFINER,
  -- exactly as the balance trigger does: under FORCE row-level security this sees the caller's tenant
  -- and workspace, which is the entire set that matters, because a commitment belongs to one
  -- workspace and a reservation cannot reference a commitment in another — the composite foreign key
  -- refuses it.
  SELECT committed_amount_minor INTO committed
    FROM funding_commitments
   WHERE tenant_id = NEW.tenant_id
     AND workspace_id = NEW.workspace_id
     AND id = NEW.funding_commitment_id
     FOR UPDATE;

  -- No visible parent. The composite foreign key is what reports that, with a better message than
  -- this trigger could; returning here leaves that refusal to it rather than masking it.
  IF committed IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(reserved_amount_minor), 0) INTO reserved
    FROM fund_reservations
   WHERE tenant_id = NEW.tenant_id
     AND workspace_id = NEW.workspace_id
     AND funding_commitment_id = NEW.funding_commitment_id
     AND status = 'RESERVED';

  IF reserved > committed THEN
    RAISE EXCEPTION
      'FUND_RESERVATIONS_EXCEED_COMMITTED_FUNDS: funding commitment % has % committed in minor '
      'units and % reserved against it. AssuraPay holds no funds, so a reservation beyond what the '
      'provider confirmed is a claim on money that does not exist.',
      NEW.funding_commitment_id, committed, reserved;
  END IF;

  RETURN NULL;
END
$reservation$;

COMMENT ON FUNCTION enforce_fund_reservation_within_commitment() IS
  'Refuses a fund reservation that would take the RESERVED total past the commitment''s confirmed '
  'amount. Locks the parent commitment so two concurrent reservations cannot both pass a stale sum.';

DO $reservation_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'fund_reservations'
  ) THEN RETURN; END IF;

  DROP TRIGGER IF EXISTS fund_reservations_within_commitment ON fund_reservations;
  -- INSERT *and* UPDATE. An insert is the path the engine takes, but an update that raised
  -- `reserved_amount_minor`, or moved a released row back to RESERVED, would reach the same illegal
  -- state while an INSERT-only trigger watched. Enforcement that a direct writer can step around is
  -- the thing this migration exists to stop.
  CREATE TRIGGER fund_reservations_within_commitment
    AFTER INSERT OR UPDATE ON fund_reservations
    FOR EACH ROW EXECUTE FUNCTION enforce_fund_reservation_within_commitment();
END
$reservation_trigger$;

-- Safe on populated tables, with one deliberate exception: a database that already holds an
-- over-reserved commitment keeps it. This migration adds no retroactive check, because a trigger
-- only sees rows written after it, and refusing to install over existing data would leave the
-- invariant unenforced on exactly the hosts that most need it. Any such row is a defect to correct
-- through the reservation lifecycle, not by rewriting settled financial history.
DO $reservation_report$
DECLARE
  breached INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'fund_reservations'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO breached FROM (
    SELECT r.funding_commitment_id
      FROM fund_reservations r
      JOIN funding_commitments c ON c.id = r.funding_commitment_id
     WHERE r.status = 'RESERVED'
     GROUP BY r.funding_commitment_id, c.committed_amount_minor
    HAVING sum(r.reserved_amount_minor) > c.committed_amount_minor
  ) AS over;

  IF breached > 0 THEN
    RAISE WARNING
      'FUND_RESERVATIONS_ALREADY_EXCEED_COMMITMENT: % funding commitment(s) are over-reserved and '
      'predate this trigger. They are left as they are; correct them through the reservation '
      'lifecycle.', breached;
  END IF;
END
$reservation_report$;

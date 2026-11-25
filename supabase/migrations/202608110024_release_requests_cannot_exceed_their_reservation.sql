-- Live release requests may never exceed the reservation they draw on.
--
-- `202608110023` stopped a funding commitment being reserved past what a provider confirmed. This is
-- the same invariant one level down, and it is the one that stops money leaving twice.
--
-- `ConditionalReleaseOrchestrationEngine.draft` compares each request with the reservation it names
-- and never sums across requests. Nothing marks a reservation consumed either: `releaseReservation`
-- is a separate HTTP call no engine triggers, so a reservation stays RESERVED through any number of
-- releases. Three sequential requests of 600,000 against a reservation of 1,000,000 therefore all
-- pass, all reach CONDITIONS_MET, and each can carry its own payment instruction — the instruction
-- idempotency key is unique per instruction, not per reservation. That settles 1,800,000 of
-- custodied funds against 1,000,000 reserved, and AssuraPay holds none of it to cover the
-- difference.
--
-- Unlike the reservation case this is not even a race. Sequential requests do it, which is why the
-- aggregate check matters more than the lock here — the lock only closes the fast version.
--
-- ## Which requests count
--
-- Everything except CANCELLED. A DRAFT request is a claim in progress and must count, or ten drafts
-- could be raised and then all evaluated. BLOCKED counts too: blocked is not finished, and a blocked
-- request can become CONDITIONS_MET when its blocker clears. Cancelling is how a claim is given
-- back, and `POST /release-requests/{id}/cancel` exists for exactly that — so CANCELLED is the one
-- status that frees room.
--
-- This permits what it should: several PARTIAL or STAGED releases against one reservation, as long
-- as together they stay inside it.
CREATE OR REPLACE FUNCTION enforce_release_within_reservation() RETURNS trigger
LANGUAGE plpgsql AS $release$
DECLARE
  reserved  BIGINT;
  requested BIGINT;
BEGIN
  -- A cancelled request has given its claim back and constrains nothing. Re-checking on the
  -- transition into CANCELLED would also refuse a cancellation whenever the reservation was already
  -- over-claimed, which is precisely when cancelling must be allowed.
  IF NEW.status = 'CANCELLED' THEN
    RETURN NULL;
  END IF;

  -- The lock, taken on the reservation before summing, so two concurrent requests cannot both pass a
  -- stale total. Read as the caller rather than SECURITY DEFINER, as the balance and reservation
  -- triggers do: under FORCE row-level security this sees the caller's tenant and workspace, and a
  -- release cannot reference a reservation outside its own — the composite foreign key refuses it.
  SELECT reserved_amount_minor INTO reserved
    FROM fund_reservations
   WHERE tenant_id = NEW.tenant_id
     AND workspace_id = NEW.workspace_id
     AND id = NEW.fund_reservation_id
     FOR UPDATE;

  -- No visible reservation. The composite foreign key reports that with a better message than this
  -- trigger could, so leave the refusal to it rather than masking it.
  IF reserved IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(requested_amount_minor), 0) INTO requested
    FROM release_requests
   WHERE tenant_id = NEW.tenant_id
     AND workspace_id = NEW.workspace_id
     AND fund_reservation_id = NEW.fund_reservation_id
     AND status <> 'CANCELLED';

  IF requested > reserved THEN
    RAISE EXCEPTION
      'RELEASES_EXCEED_RESERVED_FUNDS: fund reservation % holds % in minor units and has % requested '
      'against it by live release requests. AssuraPay holds no funds, so releasing more than was '
      'reserved pays out money the provider is not holding for this reservation.',
      NEW.fund_reservation_id, reserved, requested;
  END IF;

  RETURN NULL;
END
$release$;

COMMENT ON FUNCTION enforce_release_within_reservation() IS
  'Refuses a release request that would take the live requested total past the reservation it draws '
  'on. Locks the reservation so two concurrent requests cannot both pass a stale sum. CANCELLED '
  'requests are excluded, because cancelling is how a claim is released.';

DO $release_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'release_requests'
  ) THEN RETURN; END IF;

  DROP TRIGGER IF EXISTS release_requests_within_reservation ON release_requests;
  -- INSERT and UPDATE. An update raising `requested_amount_minor`, or moving a cancelled request back
  -- into a live status, reaches the same illegal state that an INSERT-only trigger would not see.
  CREATE TRIGGER release_requests_within_reservation
    AFTER INSERT OR UPDATE ON release_requests
    FOR EACH ROW EXECUTE FUNCTION enforce_release_within_reservation();
END
$release_trigger$;

-- Reports an existing breach rather than rewriting it, for the reason `202608110023` gives: a trigger
-- only sees rows written after it, and refusing to install over existing data would leave the
-- invariant unenforced on exactly the hosts that most need it. Settled financial history is corrected
-- through the cancellation and reversal paths, not by an UPDATE in a migration.
DO $release_report$
DECLARE
  breached INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'release_requests'
  ) THEN RETURN; END IF;

  SELECT count(*) INTO breached FROM (
    SELECT r.id
      FROM fund_reservations r
      JOIN release_requests q
        ON q.tenant_id = r.tenant_id
       AND q.workspace_id = r.workspace_id
       AND q.fund_reservation_id = r.id
       AND q.status <> 'CANCELLED'
     GROUP BY r.id, r.reserved_amount_minor
    HAVING sum(q.requested_amount_minor) > r.reserved_amount_minor
  ) AS over;

  IF breached > 0 THEN
    RAISE WARNING
      'RELEASES_ALREADY_EXCEED_RESERVATION: % fund reservation(s) back more live release than they '
      'hold and predate this trigger. They are left as they are; cancel or reverse the excess '
      'requests through their own lifecycle.', breached;
  END IF;
END
$release_report$;

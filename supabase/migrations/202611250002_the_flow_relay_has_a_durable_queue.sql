-- The flow relay gets a durable queue, with leases, backoff and a dead-letter state.
--
-- ## What was wrong
--
-- `FlowSignalRelay.drain` is complete and correct, and **nothing calls it**. Its only production
-- caller is `POST /api/v1/flows/{id}/advance`, a human action. That route's own comment says
-- "idempotent throughout, so a scheduler may call it as often as it likes" — there is no scheduler.
--
-- So the state of the platform is: engines issue certificates, assess eligibility and submit payment
-- instructions, each committing its authoritative event to `trust_outbox_events`, and the flow
-- tracking that journey sits where it was until a person remembers to poke it. An execution journey
-- does not stall visibly; it stalls silently, looking exactly like a journey with nothing to do.
--
-- ## Why a queue table rather than draining the outbox
--
-- `OutboxEvent.publishedAt` reads like the obvious marker and cannot be used: `trust_outbox_events`
-- is append-only history — it is evidence — and `relay.ts` already explains at length why the relay
-- must not pretend otherwise. The outbox is therefore never written by the relay, and the worker
-- needs its own place to record what it has done.
--
-- That place is per **workspace**, not per event, because `drain` is a per-workspace operation: it
-- evaluates every live flow, dispatches what became ready, then relays the events. Queueing
-- individual events would invite a worker to relay one event and leave the flow in `READY`, which
-- `relay.ts` documents as the trap that burns an event's idempotency key for ever.
--
-- ## The race this table exists to lose safely
--
-- Two replicas draining one workspace at the same time is the failure mode worth designing against.
-- `signal` dedupes on the idempotency key, so a double relay is survivable — but `drain` loops until
-- a pass changes nothing, and two concurrent loops would interleave evaluate/dispatch on the same
-- steps and waste the work either way. A lease makes it a non-event: `claim` takes rows with
-- `FOR UPDATE SKIP LOCKED`, so a second worker passes over a leased workspace instead of blocking on
-- it or duplicating it.
--
-- ## `enqueued_seq`, and the event that arrives mid-drain
--
-- The subtle bug a simpler design would ship. A worker claims a due workspace, drains it, and clears
-- `due_at`. If an event was committed *during* that drain, clearing `due_at` discards it and the
-- journey stalls until the next unrelated event happens to re-arm the workspace.
--
-- So every enqueue bumps `enqueued_seq`, the claim records which value it saw, and completion clears
-- `due_at` **only if the sequence has not moved**. An event that landed mid-drain leaves the
-- workspace due, and the worker picks it up on its next turn. `due_at` keeps the *earliest* pending
-- time rather than the latest, so a burst of events cannot push a workspace's turn further away.
--
-- ## Enqueue is a trigger, not application code
--
-- Deliberately, and the reason is this repository's own history: `DomainEventFlowBridge` carried a
-- comment describing the worker that would call it and had zero callers, and `dispatch` had none
-- either. A code path that must be remembered is a code path that gets forgotten. A trigger on the
-- insert cannot be forgotten by any engine, present or future: emit an event and the workspace
-- becomes due, whatever wrote it.

CREATE TABLE IF NOT EXISTS flow_relay_queue (
  -- TEXT to match `trust_outbox_events`, whose tenant and workspace columns are TEXT and nullable.
  tenant_id        TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,

  -- When this workspace became due. NULL means drained up to date: there is nothing to relay.
  due_at           TIMESTAMPTZ,
  -- Bumped on every enqueue. See the note above: this is what makes a mid-drain event survive.
  enqueued_seq     BIGINT NOT NULL DEFAULT 0 CHECK (enqueued_seq >= 0),
  -- The sequence the current lease holder saw when it claimed.
  claimed_seq      BIGINT,

  leased_by        TEXT,
  leased_until     TIMESTAMPTZ,

  -- Consecutive failures. Reset on success, so a workspace that fails twice and then succeeds is not
  -- carrying a grudge toward the dead-letter threshold.
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Backoff. The claim query refuses a row before this time.
  next_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  last_drained_at  TIMESTAMPTZ,

  -- DEAD_LETTERED is terminal for the worker and requires a human. It is a state rather than a
  -- deletion because a workspace whose flows cannot advance is a finding, and deleting the row would
  -- make the stall look like an idle workspace — the exact confusion this whole table removes.
  state            TEXT NOT NULL DEFAULT 'IDLE'
                     CHECK (state IN ('IDLE', 'LEASED', 'DEAD_LETTERED')),
  dead_lettered_at TIMESTAMPTZ,

  PRIMARY KEY (tenant_id, workspace_id),

  -- A lease and its holder travel together. Half a lease is how a workspace ends up either
  -- permanently claimed by nobody or claimable by everybody.
  CONSTRAINT flow_relay_queue_lease_whole CHECK ((leased_by IS NULL) = (leased_until IS NULL)),
  -- A claimed sequence without a lease is a worker's footprint left behind after it released.
  CONSTRAINT flow_relay_queue_claim_whole CHECK (claimed_seq IS NULL OR leased_by IS NOT NULL),
  -- The dead-letter state and its timestamp are one fact, asserted as one.
  CONSTRAINT flow_relay_queue_dead_letter_whole
    CHECK ((state = 'DEAD_LETTERED') = (dead_lettered_at IS NOT NULL)),
  -- LEASED means leased. Without this a row could report LEASED with no lease and be claimed twice.
  CONSTRAINT flow_relay_queue_leased_state
    CHECK (state <> 'LEASED' OR leased_by IS NOT NULL)
);

-- The claim query, and only it. Partial so the index stays the size of the backlog rather than the
-- size of the tenant list: a workspace that is up to date has `due_at IS NULL` and is not in here.
CREATE INDEX IF NOT EXISTS flow_relay_queue_due_idx
  ON flow_relay_queue (due_at)
  WHERE due_at IS NOT NULL AND state <> 'DEAD_LETTERED';

-- Finding the stalls, for the read route that surfaces them.
CREATE INDEX IF NOT EXISTS flow_relay_queue_dead_letter_idx
  ON flow_relay_queue (dead_lettered_at)
  WHERE state = 'DEAD_LETTERED';

COMMENT ON TABLE flow_relay_queue IS
  'Per-workspace schedule for the flow relay worker: when a workspace became due, who holds the '
  'lease, how many consecutive attempts have failed, and whether it has been dead-lettered. '
  'Scheduling metadata only — it holds no event payload and no business record.';

-- ---------------------------------------------------------------- the policy
--
-- Unscoped, like `trust_assertion_nonces` and for a comparable reason.
--
-- A worker's job is to find work *across* tenants: it cannot bind a tenant scope before it knows
-- which tenant has something to do, and a scoped read would return nothing, so the worker would
-- drain exactly the workspaces nobody needed it to. Scope is bound per workspace immediately after
-- the claim, and every read of actual business data — flows, steps, outbox events — happens inside
-- that scope under the ordinary policies. Nothing here widens what the drain itself can see.
--
-- What the table does expose to an unscoped reader is the list of tenant and workspace ids that have
-- orchestrated work, and their scheduling state. That is the honest cost, stated rather than
-- glossed: it is metadata, never a payload, never an amount and never a party. The alternative — a
-- scoped queue plus a privileged function to enumerate it — moves the same disclosure behind
-- SECURITY DEFINER and makes it harder to see.
ALTER TABLE flow_relay_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_relay_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_relay_queue_unscoped ON flow_relay_queue;
CREATE POLICY flow_relay_queue_unscoped ON flow_relay_queue
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------- the enqueue
--
-- SECURITY INVOKER, deliberately: the policy above already admits the write from any scope, so
-- SECURITY DEFINER would buy nothing and hand a trigger more authority than it needs.
CREATE OR REPLACE FUNCTION flow_relay_enqueue() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- An unscoped event belongs to no workspace, so there is no workspace to make due. The identity
  -- plane emits these (see `202608110020`), and they are not orchestrated.
  IF NEW.tenant_id IS NULL OR NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO flow_relay_queue AS queue (tenant_id, workspace_id, due_at, enqueued_seq)
  VALUES (NEW.tenant_id, NEW.workspace_id, NEW.occurred_at, 1)
  ON CONFLICT (tenant_id, workspace_id) DO UPDATE
    -- The earliest pending time wins, so a burst cannot push this workspace's turn later.
    SET due_at = LEAST(COALESCE(queue.due_at, NEW.occurred_at), NEW.occurred_at),
        enqueued_seq = queue.enqueued_seq + 1;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION flow_relay_enqueue() IS
  'Marks a workspace due for the flow relay whenever a domain event is committed for it. A trigger '
  'rather than application code, because the bridge this replaces had zero callers for exactly as '
  'long as calling it was somebody''s responsibility to remember.';

DROP TRIGGER IF EXISTS flow_relay_enqueue_on_outbox ON trust_outbox_events;
CREATE TRIGGER flow_relay_enqueue_on_outbox
  AFTER INSERT ON trust_outbox_events
  FOR EACH ROW
  EXECUTE FUNCTION flow_relay_enqueue();

-- ---------------------------------------------------------------- the probe
--
-- The invariants above are refusals, so they are demonstrated as refusals before this commits.
--
-- What this proves: that half a lease and an inconsistent dead-letter state are rejected by the
-- database, which is what stops a workspace being claimed twice or a stall being invisible. What it
-- does not prove is the concurrency property itself — that two workers cannot claim one row — which
-- needs two sessions and is proved in `flow-relay-queue.postgres.test.ts` with two independent
-- clients, the way replay protection across replicas is proved.
DO $$
DECLARE
  accepted BOOLEAN;
BEGIN
  -- Half a lease: a holder with no expiry.
  accepted := TRUE;
  BEGIN
    INSERT INTO flow_relay_queue (tenant_id, workspace_id, leased_by)
    VALUES ('probe-tenant', 'probe-workspace', 'worker-1');
  EXCEPTION
    WHEN check_violation THEN accepted := FALSE;
  END;
  IF accepted THEN
    RAISE EXCEPTION 'FLOW_RELAY_LEASE_NOT_WHOLE: a lease holder with no expiry was accepted';
  END IF;

  -- A dead-letter state with no timestamp, which would make a stall unreportable.
  accepted := TRUE;
  BEGIN
    INSERT INTO flow_relay_queue (tenant_id, workspace_id, state)
    VALUES ('probe-tenant', 'probe-workspace', 'DEAD_LETTERED');
  EXCEPTION
    WHEN check_violation THEN accepted := FALSE;
  END;
  IF accepted THEN
    RAISE EXCEPTION 'FLOW_RELAY_DEAD_LETTER_NOT_WHOLE: a dead-lettered row with no timestamp was accepted';
  END IF;

  -- And the ordinary row is accepted, so the probe above is not passing because every insert fails.
  INSERT INTO flow_relay_queue (tenant_id, workspace_id, due_at)
  VALUES ('probe-tenant', 'probe-workspace', now());
  IF NOT EXISTS (
    SELECT 1 FROM flow_relay_queue
     WHERE tenant_id = 'probe-tenant' AND workspace_id = 'probe-workspace'
  ) THEN
    RAISE EXCEPTION 'FLOW_RELAY_QUEUE_UNWRITABLE: a well-formed row was not stored';
  END IF;
  DELETE FROM flow_relay_queue WHERE tenant_id = 'probe-tenant';
END $$;

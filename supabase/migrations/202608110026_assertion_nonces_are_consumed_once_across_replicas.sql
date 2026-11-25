-- Identity assertion nonces, so replay protection survives more than one process.
--
-- `202608110025`'s predecessor commit made acting routes consume the assertion, which turned the
-- gateway's `ASSERTION_REPLAYED` refusal from unreachable code into a real control. But the only
-- replay store was `InMemoryAssertionReplayStore`, whose `guarantee` is `process-local`: correct
-- within one Node process and worth nothing across replicas, because two instances share no map.
--
-- `loadGatewayConfig` already refuses a process-local store under NODE_ENV=production unless
-- `IDENTITY_ASSERTION_ACCEPT_PROCESS_LOCAL_REPLAY=true`, so the gap was fenced rather than hidden —
-- but with no distributed store in existence, every production deployment had to set that flag and
-- declare itself single-instance. One extra replica behind a load balancer and the same assertion
-- authorises one action per instance.
--
-- This table is the shared state that fixes it. The uniqueness of `nonce` is the whole mechanism:
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING nonce` either returns a row, meaning this caller won
-- and may proceed, or returns nothing, meaning the nonce was already spent. One statement, so there
-- is no check-then-insert window for a second caller to slip through — which is exactly what
-- `AssertionReplayStore` requires of an implementation and what no amount of application logic can
-- provide across processes.
CREATE TABLE IF NOT EXISTS trust_assertion_nonces (
  nonce       TEXT PRIMARY KEY CHECK (length(nonce) BETWEEN 1 AND 200),
  -- The verifier's own expiry, not a duration computed here. Pruning has to agree with the window
  -- the verifier judged, or the guard could drop a nonce an assertion still considers live and
  -- silently re-admit the replay it exists to stop.
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pruning reads this, and only this. Without it, deleting spent nonces degrades into a sequential
-- scan of a table written once per acting request.
CREATE INDEX IF NOT EXISTS trust_assertion_nonces_expires_at_idx
  ON trust_assertion_nonces (expires_at);

COMMENT ON TABLE trust_assertion_nonces IS
  'Spent identity assertion nonces. Shared so replay protection holds across replicas rather than '
  'per process. Rows are ephemeral: a nonce past expires_at is garbage and is pruned.';

ALTER TABLE trust_assertion_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_assertion_nonces FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- the policy
--
-- Unscoped on purpose, and it is the one table in this schema where that is right.
--
-- A nonce is consumed *before* the caller's tenant is known — that is the point of consuming it, to
-- establish that the assertion presenting the tenant has not been used before. Registration and
-- tenant founding consume an assertion while the caller has no tenant at all. A tenant-scoped
-- policy here would refuse exactly the requests that most need replay protection, and
-- `202608110020` already had to make the same repair for `trust_audit_records` and
-- `trust_outbox_events` for the same reason: "a session-created event emitted at login has no
-- tenant yet".
--
-- Nothing is disclosed by that. A nonce is a random opaque value, carries no tenant, workspace,
-- subject or any other claim, and its presence says only that some assertion somewhere was spent.
-- Reading the whole table tells an attacker nothing it could use, and writing to it can only ever
-- *deny* an assertion, never admit one — a forged row refuses a legitimate request, which is a
-- denial-of-service against oneself, not an escalation. The valuable direction, admitting a replay,
-- requires *deleting* a row, and DELETE is granted below only to the owning role that prunes.
DO $nonce_policy$
BEGIN
  BEGIN
    CREATE POLICY trust_assertion_nonces_platform ON trust_assertion_nonces
      USING (true) WITH CHECK (true);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;

  -- SELECT and INSERT for the application role; DELETE as well, because pruning is part of
  -- consuming rather than a separate maintenance job — there is no worker in this platform to run
  -- one, and a table that is never pruned grows once per acting request forever.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON trust_assertion_nonces TO assurapay_app';
  END IF;
END
$nonce_policy$;

-- ---------------------------------------------------------------- the claim, asserted
--
-- The migration proves its own mechanism before it commits, in the shape `202608110020` and
-- `202608110018` established: assert the behaviour rather than trust that the DDL expressed it.
-- Run with no scope set, which is the registration path's conditions, so a policy that refused the
-- write would fail here rather than fail a user's first click.
DO $nonce_probe$
DECLARE
  first_win  TEXT;
  second_win TEXT;
BEGIN
  INSERT INTO trust_assertion_nonces (nonce, expires_at)
    VALUES ('migration-probe-nonce', now() + interval '1 hour')
    ON CONFLICT (nonce) DO NOTHING
    RETURNING nonce INTO first_win;

  INSERT INTO trust_assertion_nonces (nonce, expires_at)
    VALUES ('migration-probe-nonce', now() + interval '1 hour')
    ON CONFLICT (nonce) DO NOTHING
    RETURNING nonce INTO second_win;

  IF first_win IS NULL THEN
    RAISE EXCEPTION
      'ASSERTION_NONCE_INSERT_REFUSED: the first insert of a fresh nonce returned no row, so '
      'consuming an assertion would refuse every request including the first.';
  END IF;

  IF second_win IS NOT NULL THEN
    RAISE EXCEPTION
      'ASSERTION_NONCE_NOT_SINGLE_USE: the second insert of the same nonce returned a row, so the '
      'same assertion would authorise two actions. Replay protection would be inoperative.';
  END IF;

  DELETE FROM trust_assertion_nonces WHERE nonce = 'migration-probe-nonce';
END
$nonce_probe$;

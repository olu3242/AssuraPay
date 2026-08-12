-- A release request represents one exact payable amount. It may be retried through
-- the same payment instruction, but it must never produce a second instruction
-- under a different idempotency key.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM payment_instructions
    GROUP BY tenant_id, workspace_id, release_request_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'RELEASE_INSTRUCTION_CONVERGENCE_REFUSED: duplicate release instructions exist';
  END IF;

  BEGIN
    ALTER TABLE payment_instructions
      ADD CONSTRAINT payment_instructions_release_exactly_once
      UNIQUE (tenant_id, workspace_id, release_request_id);
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;

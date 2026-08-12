-- Batch C answers to the trust runtime, and the ledger answers to double entry.
--
-- Batch C is the settlement-and-money-movement set of the accepted wave 4-5 plan: canonical
-- Engines 44, 47, 48 and 50 — funding commitment, fund reservation, payment instruction, ledger
-- entry, reconciliation record, final settlement account, financial closure certificate. It is the
-- batch where money leaves the platform's description of itself and becomes an instruction to a
-- licensed provider, so `docs/finance/MONETARY_INVARIANTS.md` is enforced here at its strongest.
--
-- THE CLOSURE IS SELF-CONTAINED, AND THAT WAS MEASURED RATHER THAN ASSUMED.
--
-- Batch B had to converge two Batch C tables because foreign keys ran in both directions across
-- the boundary. Batch C's own closure was computed the same way, against a live migrated instance:
--
--   ledger_entries.payment_instruction_id          -> payment_instructions(id)
--   reconciliation_records.payment_instruction_id  -> payment_instructions(id)
--   financial_closure_certificates
--     .final_settlement_account_id                 -> final_settlement_accounts(id)
--
-- Every inbound foreign key into these five originates inside these five, and every outbound one
-- goes either inside them or to `workspaces`, which convergence replaces. No Batch D table
-- references them — `disputes.release_request_id` and `dispute_holds.release_request_id` are bare
-- UUID columns with no constraint, so nothing breaks. The convertible unit is therefore exactly
-- the five tables the historical set left unconverged.
--
-- `funding_commitments` and `fund_reservations` were converged by `202608100002` and deliberately
-- not activated there. This migration activates them: it grants on them, and the store begins
-- routing to them. Converging a table is not activating it, and this is the other half of that
-- distinction being executable.
--
-- All seven hold zero rows, re-verified below at apply time rather than assumed.
--
-- THE DOUBLE-ENTRY MECHANISM, WHICH IS THIS BATCH'S ENTRY GATE
--
-- `docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md` will not let Batch C begin
-- without "a decided double-entry enforcement mechanism — constraint, deferred trigger, or
-- transactional posting procedure". Decided here, with the alternatives and why they lose:
--
--   * A CHECK constraint cannot see other rows. Balance is a property of a set of postings, so a
--     CHECK can only ever restate a single row's own amount.
--   * A row-level AFTER INSERT trigger fires between the legs. It would refuse the first leg of
--     every balanced pair, which makes correct behaviour impossible rather than merely unchecked.
--   * A posting procedure alone — a function that writes both legs — is evadable by the direct
--     INSERT that Batches A and B exist to defend against. MONETARY_INVARIANTS names "enforcing
--     balance only in TypeScript" a prohibited shortcut, and a procedure a console session can
--     bypass is that shortcut wearing a SQL hat.
--
--   * CHOSEN: a deferred constraint trigger. `DEFERRABLE INITIALLY DEFERRED` fires at COMMIT, when
--     the whole posting is visible, so an intermediate unbalanced state inside a transaction is
--     permitted and an unbalanced *committed* state is impossible. It holds for every writer,
--     including one the application never mediated.
--
-- The journal key is `(tenant_id, payment_instruction_id, currency)`. It carries currency because
-- MONETARY_INVARIANTS requires a journal to balance independently per currency. It needs no new
-- grouping column: every posting against an instruction must itself balance, so the running total
-- over all postings for that instruction stays balanced, and inventing a `journal_id` the domain
-- type does not have would be inventing state.
--
-- The trigger reads `ledger_entries` as the caller, not as SECURITY DEFINER. Under FORCE row-level
-- security it therefore sees exactly the caller's tenant and workspace — which is the whole
-- journal, because an instruction's postings cannot span workspaces — and it gains no authority
-- the caller lacks.
--
-- WHAT ELSE THIS ENFORCES THAT NOTHING ENFORCED BEFORE
--
-- 1. Tenancy on five more tables, replacing `workspace_id UUID REFERENCES workspaces(id)` with
--    `trust_tenants`/`trust_workspaces` and FORCE row-level security.
--
-- 2. A foreign key from `payment_instructions.release_request_id`, which had none at all — the
--    third instance of this defect, after `authorization_decisions.release_request_id` in Batch B.
--    An instruction could name a release request that did not exist, in this tenant or any other,
--    which for a money-movement record is an instruction with no authority behind it. It is
--    restored carrying currency, so an instruction cannot claim in a currency its release request
--    did not authorise.
--
-- 3. Reconciliation uniqueness, which the exit gate requires:
--    `(tenant_id, payment_instruction_id, provider_statement_reference)`. Without it the same
--    provider statement line could be reconciled twice and both rows would look authoritative.
--
-- 4. Tenant-scoped idempotency. `UNIQUE (workspace_id, idempotency_key)` predates tenancy, and
--    MONETARY_INVARIANTS requires the key to be unique within tenant and operation scope.
--
-- 5. Settlement arithmetic: `outstanding = total_entitlement - total_settled`, previously three
--    independent bounds that permitted an account claiming to owe more than it was ever entitled
--    to.
--
-- 6. Mutation boundaries. `payment_instructions` carried **no trigger at all** and permitted
--    arbitrary UPDATE and DELETE on a money-movement record. `final_settlement_accounts` and
--    `financial_closure_certificates` carried blanket append-only triggers that would have refused
--    the transitions their engines perform — closing an account, revoking a certificate — the same
--    defect corrected for Batch A in `202608100001` and Batch B in `202608100002`, corrected the
--    same way and with the functions the first of those created. `ledger_entries` and
--    `reconciliation_records` are genuinely append-only and stay so, asserted rather than assumed.
--
--    `FAILED` is deliberately not a terminal state for `payment_instructions`, though it reads like
--    one: `PaymentExecutionEngine.submit` accepts `DRAFT` *or* `FAILED`, so a failed instruction is
--    retryable and `attempts` climbs. Only `REVERSED` is terminal. Naming FAILED terminal would
--    have made every retry impossible — the mirror image of the blanket-append-only defect, and
--    just as invisible until a provider rejected a payment in production.
--
-- NON-CUSTODY IS UNCHANGED. Nothing here holds, pools, or gains signing authority over funds:
-- `funding_commitments.external_custody_reference` and `payment_instructions.provider_reference`
-- name the licensed provider's own records, and no column in this batch represents a balance
-- AssuraPay controls. The `settlement-*.non-custody.test.ts` suites remain the gate.
--
-- NO HISTORICAL MIGRATION IS MODIFIED. Forward-only, additive, and refusing rather than coercing.

DO $batch_c$
DECLARE
  -- The five the historical set left unconverged. `funding_commitments` and `fund_reservations`
  -- are absent deliberately: `202608100002` already converged them, and re-running the conversion
  -- would fail on columns that are no longer UUID.
  closure CONSTANT TEXT[] := ARRAY[
    'payment_instructions', 'ledger_entries', 'reconciliation_records',
    'final_settlement_accounts', 'financial_closure_certificates'
  ];
  -- Activated by this migration: routed by the store, required at readiness. Seven, because the
  -- two Batch B converged are activated here.
  activated CONSTANT TEXT[] := ARRAY[
    'funding_commitments', 'fund_reservations', 'payment_instructions', 'ledger_entries',
    'reconciliation_records', 'final_settlement_accounts', 'financial_closure_certificates'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  -- Absent tables are tolerated, so this applies to a schema that never carried the historical
  -- per-engine model — which is what a trust-only deployment is.
  FOREACH target IN ARRAY activated LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    ) THEN
      EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
      IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
    END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE5_BATCH_C_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table, and it adds a deferred '
      'balance constraint that existing postings would have to already satisfy. Nothing has been '
      'changed. Backfill and convert deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  -- A foreign key from outside the closure would be silently broken by the type change. The
  -- closure was computed to make this list empty; the check is here because a later migration
  -- could add one, and then this migration would be the thing that broke it.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(closure)
      AND NOT (c.conrelid::regclass::text = ANY(closure))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE5_BATCH_C_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Policies first. PostgreSQL refuses to alter the type of a column a policy predicates
  -- on, and every one of these policies predicates on `workspace_id`. Every policy is dropped
  -- rather than the one name the historical migration used, so a policy added by any other means
  -- cannot survive as a second boundary.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    FOR rec IN
      SELECT policyname AS name FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = target
    LOOP
      EXECUTE format('DROP POLICY %I ON %I', rec.name, target);
    END LOOP;
  END LOOP;

  -- Step 2. Every foreign key on the closure, including the aggregate-to-aggregate ones. They are
  -- all recreated below, tenant-composite, against the trust runtime.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(closure)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. Converge identity on TEXT — the trust runtime's representation throughout. Every UUID
  -- column, not only the keys: an actor column typed UUID cannot hold a trust principal id, and
  -- leaving some columns UUID preserves the split this step exists to remove.
  FOR rec IN
    SELECT c.table_name AS tbl, c.column_name AS col, c.column_default AS def
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(closure)
      AND c.data_type = 'uuid'
  LOOP
    IF rec.def IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', rec.tbl, rec.col);
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TEXT USING %I::text', rec.tbl, rec.col, rec.col);
    IF rec.def IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT gen_random_uuid()::text', rec.tbl, rec.col);
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(%I) BETWEEN 1 AND 200)',
      rec.tbl, rec.tbl || '_' || rec.col || '_len', rec.col);
  END LOOP;

  -- Step 4. Tenant scope, concurrency, schema versioning, and the parent-side unique constraints
  -- the tenant-composite foreign keys need.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    -- Added NULLable then set NOT NULL rather than added with a default: a default tenant would be
    -- a fabricated ownership claim. The tables are empty, so the NOT NULL is immediate and free.
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT', target);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES trust_tenants(tenant_id)',
      target, target || '_tenant_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (version >= 1)', target, target || '_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version >= 1)',
      target, target || '_schema_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      target);

    -- Workspace authority is trust_workspaces. One column, one authority — no parallel
    -- `trust_workspace_id`, which would be a second workspace authority.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES trust_workspaces(workspace_id)',
      target, target || '_workspace_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
      'REFERENCES trust_workspaces(tenant_id, workspace_id)',
      target, target || '_tenant_workspace_fk');

    -- The referenced side of every tenant-composite aggregate key below. `id` is already the
    -- primary key so the pair is trivially unique, but PostgreSQL will not infer a composite
    -- foreign key's uniqueness from a single-column key — it must be declared.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', target, target || '_tenant_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
  END LOOP;

  -- Step 5. The governed currency set, on every table in the closure that carries an amount in a
  -- named currency. `reconciliation_records` and `financial_closure_certificates` have no currency
  -- column and are skipped — see the gap recorded in the Batch C activation document; adding one
  -- would require a change to the domain type, which this capability does not make.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = target AND column_name = 'currency'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (currency IN (''NGN'', ''USD''))',
      target, target || '_currency_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id, currency)',
      target, target || '_tenant_id_currency_unique');
  END LOOP;

  -- Step 6. Trust-runtime policies, FORCE, and the runtime grants.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    -- USING and WITH CHECK both. A USING-only policy hides other tenants' rows while letting a
    -- caller insert into their own scope, which plants data whose origin the owning tenant cannot
    -- see.
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace()) '
      'WITH CHECK (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace())',
      target || '_trust_scope', target);

    -- FORCE, because ENABLE does not constrain the table owner.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  -- No DELETE. Settlement history is append-only or supersession-based, and a role that cannot
  -- issue the statement cannot reach a trigger that would refuse it. Conditional because the role
  -- is provisioned by the deployment, not by a file in this repository. All seven activated,
  -- including the two `202608100002` converged and left ungranted.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY activated LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
    END LOOP;
  END IF;
END
$batch_c$;

-- Step 7. The aggregate graph, restored tenant-composite — and where currency must agree, carrying
-- currency too, so one constraint enforces tenant agreement and currency agreement together.
DO $graph$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'payment_instructions'
  ) THEN RETURN; END IF;

  -- New, not restored. `payment_instructions.release_request_id` had no foreign key at all, while
  -- the engine authorises against the release request it names — so a money-movement instruction
  -- could reference a release request that does not exist, in this tenant or any other. Carrying
  -- currency, so an instruction cannot claim in a currency the release request did not authorise.
  ALTER TABLE payment_instructions
    ADD CONSTRAINT payment_instructions_release_request_currency_fk
    FOREIGN KEY (tenant_id, release_request_id, currency)
    REFERENCES release_requests (tenant_id, id, currency);

  -- A posting must be in the instruction's currency. Otherwise a journal could "balance" across
  -- currencies, which MONETARY_INVARIANTS forbids without an explicit governed conversion event.
  ALTER TABLE ledger_entries
    ADD CONSTRAINT ledger_entries_instruction_currency_fk
    FOREIGN KEY (tenant_id, payment_instruction_id, currency)
    REFERENCES payment_instructions (tenant_id, id, currency);

  -- No currency column on the child, so tenant agreement only.
  ALTER TABLE reconciliation_records
    ADD CONSTRAINT reconciliation_records_instruction_fk
    FOREIGN KEY (tenant_id, payment_instruction_id)
    REFERENCES payment_instructions (tenant_id, id);

  ALTER TABLE financial_closure_certificates
    ADD CONSTRAINT financial_closure_certificates_account_fk
    FOREIGN KEY (tenant_id, final_settlement_account_id)
    REFERENCES final_settlement_accounts (tenant_id, id);
END
$graph$;

-- Step 8. The monetary and settlement invariants a single row can carry, and the tenant-scoped
-- uniqueness the exit gate names.
DO $invariants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'payment_instructions'
  ) THEN RETURN; END IF;

  -- A retry counter that can go backwards is a retry counter that can hide a retry.
  ALTER TABLE payment_instructions
    ADD CONSTRAINT payment_instructions_attempts_non_negative CHECK (attempts >= 0);

  -- Tenant-scoped idempotency. The historical `UNIQUE (workspace_id, idempotency_key)` predates
  -- tenancy.
  --
  -- Deliberately NOT widened to include `provider_key`, though MONETARY_INVARIANTS speaks of
  -- "operation scope": `PaymentExecutionEngine.issue` returns the existing instruction for a
  -- repeated key *regardless of provider*, so a key scoped per provider would admit a second
  -- instruction the engine intends to deduplicate — the database would be looser than the
  -- behaviour it is meant to enforce. The engine's rule is the canonical one; this makes it
  -- tenant-scoped and nothing more.
  ALTER TABLE payment_instructions
    DROP CONSTRAINT IF EXISTS payment_instructions_workspace_id_idempotency_key_key;
  ALTER TABLE payment_instructions
    ADD CONSTRAINT payment_instructions_idempotency_unique
    UNIQUE (tenant_id, workspace_id, idempotency_key);

  -- Reconciliation uniqueness, which the Batch C exit gate requires. Without it the same provider
  -- statement line reconciles twice against one instruction and both rows look authoritative.
  ALTER TABLE reconciliation_records
    ADD CONSTRAINT reconciliation_records_statement_unique
    UNIQUE (tenant_id, payment_instruction_id, provider_statement_reference);

  -- The two amounts a reconciliation compares were bounded by nothing. A negative reported amount
  -- would make a mismatch look like a match of a different sign.
  ALTER TABLE reconciliation_records
    ADD CONSTRAINT reconciliation_records_amounts_non_negative
    CHECK (provider_reported_amount_minor >= 0 AND recorded_amount_minor >= 0);

  -- `matched` must follow from the amounts it claims to compare, rather than being an independent
  -- assertion a caller can set either way.
  ALTER TABLE reconciliation_records
    ADD CONSTRAINT reconciliation_records_matched_follows_from_amounts
    CHECK (matched = (provider_reported_amount_minor = recorded_amount_minor));

  -- Settlement arithmetic. Three independent bounds permitted an account claiming to owe more than
  -- it was ever entitled to, which is the shape of an overpayment justified by its own record.
  ALTER TABLE final_settlement_accounts
    ADD CONSTRAINT final_settlement_accounts_outstanding_follows_from_parts
    CHECK (outstanding_amount_minor = total_entitlement_amount_minor - total_settled_amount_minor);

  -- A closed account must record when. The status column alone would let a closure be asserted
  -- with no time it happened, and the closure certificate references this account as evidence.
  ALTER TABLE final_settlement_accounts
    ADD CONSTRAINT final_settlement_accounts_closed_at_follows_status
    CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL));

  -- One closure certificate may be ISSUED per account at a time. The engine counts rows before
  -- issuing, which two concurrent requests both pass.
  CREATE UNIQUE INDEX IF NOT EXISTS financial_closure_certificates_one_issued_per_account
    ON financial_closure_certificates (tenant_id, final_settlement_account_id)
    WHERE status = 'ISSUED';
END
$invariants$;

-- Step 9. Double entry, enforced by the database.
--
-- The mechanism decision is argued in this file's header. This is the deferred constraint trigger
-- it chose: it fires at COMMIT, so the balanced pair is visible as a set, and an unbalanced
-- committed journal is impossible for any writer including one the application never mediated.
CREATE OR REPLACE FUNCTION enforce_ledger_journal_balance() RETURNS trigger
LANGUAGE plpgsql AS $balance$
DECLARE
  debits  BIGINT;
  credits BIGINT;
BEGIN
  -- Read as the caller, not SECURITY DEFINER. Under FORCE row-level security this sees exactly the
  -- caller's tenant and workspace, which is the whole journal — an instruction's postings cannot
  -- span workspaces, because the instruction itself belongs to one.
  SELECT
      coalesce(sum(amount_minor) FILTER (WHERE entry_type = 'DEBIT'), 0),
      coalesce(sum(amount_minor) FILTER (WHERE entry_type = 'CREDIT'), 0)
    INTO debits, credits
    FROM ledger_entries
    WHERE tenant_id = NEW.tenant_id
      AND payment_instruction_id = NEW.payment_instruction_id
      AND currency = NEW.currency;

  IF debits <> credits THEN
    RAISE EXCEPTION
      'LEDGER_JOURNAL_DOES_NOT_BALANCE: payment instruction % in % has debits of % and credits of '
      '%. A journal balances independently per currency, and a posting that leaves it unbalanced '
      'is refused at commit.',
      NEW.payment_instruction_id, NEW.currency, debits, credits;
  END IF;

  RETURN NULL;
END
$balance$;

COMMENT ON FUNCTION enforce_ledger_journal_balance() IS
  'Refuses a committed ledger journal whose debits and credits disagree, per tenant, payment '
  'instruction and currency. Deferred to COMMIT so a balanced posting may be written leg by leg.';

DO $balance_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ledger_entries'
  ) THEN RETURN; END IF;

  DROP TRIGGER IF EXISTS ledger_entries_journal_balance ON ledger_entries;
  CREATE CONSTRAINT TRIGGER ledger_entries_journal_balance
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_ledger_journal_balance();
END
$balance_trigger$;

-- Step 10. Mutation boundaries, using the functions `202608100001` created.
DO $transitions$
DECLARE
  governed CONSTANT JSONB := $spec$
  [
    { "table": "payment_instructions", "status": "status", "terminal": ["REVERSED"],
      "immutable": ["id","tenant_id","workspace_id","release_request_id","provider_key","idempotency_key","beneficiary_reference","amount_minor","currency","created_at","schema_version"] },
    { "table": "final_settlement_accounts", "status": "status", "terminal": ["CLOSED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","total_entitlement_amount_minor","currency","created_at","schema_version"] },
    { "table": "financial_closure_certificates", "status": "status", "terminal": ["REVOKED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","final_settlement_account_id","canonical_hash","issued_by","issued_at","schema_version"] }
  ]
  $spec$::JSONB;

  -- Never transitioned by any canonical engine. Their blanket append-only triggers stay untouched.
  -- `ledger_entries` is the journal itself, and MONETARY_INVARIANTS says posted entries are
  -- immutable; a correction is a compensating posting, never an edit.
  append_only CONSTANT TEXT[] := ARRAY['ledger_entries', 'reconciliation_records'];

  -- Governed by `202608100002` and asserted here for the same reason as the append-only pair: a
  -- later migration dropping one would leave an activated settlement aggregate with no boundary.
  already_governed CONSTANT TEXT[] := ARRAY['funding_commitments', 'fund_reservations'];

  spec      JSONB;
  target    TEXT;
  arguments TEXT;
  missing   TEXT[] := '{}';
BEGIN
  FOR spec IN SELECT value FROM jsonb_array_elements(governed) AS entries(value) LOOP
    target := spec ->> 'table';
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    -- Replaced, not supplemented. Leaving the blanket trigger alongside the governed one would
    -- refuse every transition and make the new rules unreachable.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_terminal_state', target);

    SELECT string_agg(format('%L', value), ', ' ORDER BY position)
      INTO arguments
      FROM jsonb_array_elements_text(spec -> 'immutable')
             WITH ORDINALITY AS columns(value, position);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION enforce_governed_aggregate_transition(%s)',
      target || '_governed_transition', target, arguments);

    SELECT format('%L', spec ->> 'status') || ', ' ||
           string_agg(format('%L', value), ', ' ORDER BY position)
      INTO arguments
      FROM jsonb_array_elements_text(spec -> 'terminal')
             WITH ORDINALITY AS states(value, position);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION enforce_terminal_aggregate_state(%s)',
      target || '_terminal_state', target, arguments);
  END LOOP;

  FOREACH target IN ARRAY append_only LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()
        AND c.relname = target AND t.tgname = target || '_append_only'
    ) THEN
      missing := missing || format('%s(append_only)', target);
    END IF;
  END LOOP;

  FOREACH target IN ARRAY already_governed LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()
        AND c.relname = target AND t.tgname = target || '_governed_transition'
    ) THEN
      missing := missing || format('%s(governed_transition)', target);
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE5_BATCH_C_AUTHORITY_REFUSED: expected mutation boundary absent on %. An activated '
      'settlement aggregate with no boundary accepts writes that quietly succeed, so this refuses '
      'rather than activating it.',
      array_to_string(missing, ', ');
  END IF;
END
$transitions$;

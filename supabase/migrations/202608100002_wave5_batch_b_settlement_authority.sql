-- Batch B answers to the trust runtime, and money answers to the monetary invariants.
--
-- Batch B is the entitlement-and-claim set of the accepted wave 4-5 plan: canonical Engines 41-43
-- and 45-46 — payment eligibility, financial entitlement, invoice, release request, approval
-- threshold, authorization decision, financial approval decision. It is the first batch that
-- carries money, so `docs/finance/MONETARY_INVARIANTS.md` becomes enforceable here rather than
-- aspirational.
--
-- THE BATCH BOUNDARY IN THE PLAN DOES NOT SURVIVE THE SCHEMA, AND THIS MIGRATION SAYS SO.
--
-- `docs/architecture/WAVE_4_5_DOMAIN_STORE_DURABILITY_DECISION.md` lists `fundReservations` and
-- `fundingCommitments` in Batch C. The foreign keys disagree, and they were computed against a
-- live migrated instance rather than read off the plan:
--
--   release_requests.fund_reservation_id  -> fund_reservations(id)     Batch B depends on Batch C
--   fund_reservations.invoice_id          -> invoices(id)              Batch C depends on Batch B
--   fund_reservations.funding_commitment_id -> funding_commitments(id) and on one more
--
-- `invoices` therefore has an inbound foreign key from a Batch C table, and `release_requests` has
-- an outbound one. Converting either side's identity from UUID to TEXT breaks the constraint on the
-- other. The transitive closure of Batch B under foreign keys — in both directions, because a type
-- change on either end breaks the key — is exactly nine tables: the seven of Batch B plus
-- `fund_reservations` and `funding_commitments`. There is no smaller convertible unit.
--
-- So this migration converges all nine and **activates only seven**. `fund_reservations` and
-- `funding_commitments` are left in the state `202608090001` left Batch A in: fit to receive their
-- aggregates, with no repository routing to them and no readiness requirement naming them. Batch C
-- activates them. Converging a table is not activating it, and the distinction is the reason this
-- is safe: all nine hold zero rows, re-verified below at apply time.
--
-- WHAT THIS ENFORCES THAT NOTHING ENFORCED BEFORE
--
-- 1. Tenancy. Nine tables scoped on `workspace_id UUID REFERENCES workspaces(id)` — the deprecated
--    compatibility table — with no tenant column at all. They now reference `trust_tenants` and
--    `trust_workspaces`, with a composite key forcing the pair to agree, and FORCE row-level
--    security predicated on `trust_current_tenant()`/`trust_current_workspace()`.
--
-- 2. Cross-tenant references. Every aggregate-to-aggregate foreign key inside the closure becomes
--    tenant-composite: `(tenant_id, parent_id) -> (tenant_id, id)`. This closes a hole row-level
--    security cannot: **foreign key checks run as the table owner and are not subject to RLS**, so
--    a single-column key would happily let a row in tenant A reference a parent in tenant B. The
--    policy would hide the parent from the caller while the constraint accepted it.
--
-- 3. Currency consistency. `docs/finance/MONETARY_INVARIANTS.md`: "A journal transaction balances
--    independently per currency. Amounts in different currencies are never summed into one balance
--    without an explicit governed conversion event." An invoice claiming against an entitlement in
--    a different currency is that unsummable case, and it was expressible only in application code.
--    The keys carrying currency now do so structurally:
--    `(tenant_id, financial_entitlement_id, currency) -> (tenant_id, id, currency)`.
--
-- 4. The governed currency set. `currency TEXT NOT NULL` accepted any string. CLAUDE.md is
--    Naira-first and multi-currency-ready, and NGN and USD are the only codes any canonical
--    behaviour uses, so those two are the governed set. An unsupported code is refused rather than
--    stored — MONETARY_INVARIANTS: "Unsupported or ambiguous currency is rejected."
--
-- 5. Deduction non-negativity. `financial_entitlements` checked its gross amount (> 0) and its net
--    (>= 0) and left retention, tax and penalty unconstrained, so a negative retention could
--    inflate the net payable past the gross. The engine already refuses it; the column now does
--    too. `variations_amount_minor` stays signed deliberately — a variation may legitimately reduce
--    the entitlement, and MONETARY_INVARIANTS constrains base contractual, claim, invoice,
--    entitlement, funding, release and payment amounts, which a variation delta is not.
--
-- 6. Segregation of duties. "The actor who proposes or calculates a monetary effect does not
--    thereby gain authority to approve or release it." `FinancialApprovalAuthorityEngine` raises
--    SEGREGATION_OF_DUTIES_VIOLATION when the approver is the requester, and MONETARY_INVARIANTS
--    says an invariant PostgreSQL can enforce must not exist only as an application check. It is a
--    cross-row rule, so it needs a trigger, and it gets one.
--
-- 7. Mutation boundaries. Six of the nine are transitioned by their canonical engines
--    (`financial_entitlements`, `invoices`, `release_requests`, `authorization_decisions`,
--    `fund_reservations`, `funding_commitments`); three never are (`payment_eligibilities`,
--    `approval_thresholds`, `financial_approval_decisions`). Three of the six carried a blanket
--    append-only trigger that would have refused the transitions their engines perform — the same
--    defect `202608100001` corrected for Batch A, and it is corrected the same way, with the
--    functions that migration already created.
--
-- NO HISTORICAL MIGRATION IS MODIFIED. Forward-only, additive, and refusing rather than coercing.

DO $batch_b$
DECLARE
  -- The convertible unit: Batch B plus the two Batch C tables its foreign keys entangle it with.
  closure CONSTANT TEXT[] := ARRAY[
    'payment_eligibilities', 'financial_entitlements', 'invoices', 'release_requests',
    'approval_thresholds', 'authorization_decisions', 'financial_approval_decisions',
    'fund_reservations', 'funding_commitments'
  ];
  -- Activated by this migration: routed by the store, required at readiness.
  activated CONSTANT TEXT[] := ARRAY[
    'payment_eligibilities', 'financial_entitlements', 'invoices', 'release_requests',
    'approval_thresholds', 'authorization_decisions', 'financial_approval_decisions'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  -- Absent tables are tolerated, so this applies to a schema that never carried the historical
  -- per-engine model — which is what a trust-only deployment is.
  FOREACH target IN ARRAY closure LOOP
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
      'WAVE5_BATCH_B_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table, and it converts a '
      'closure of nine tables together because their foreign keys cannot be converted separately. '
      'Nothing has been changed. Backfill and convert deliberately, then re-run.',
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
      'WAVE5_BATCH_B_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
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

  -- Step 5. The governed currency set, on every table that carries an amount.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = target AND column_name = 'currency'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (currency IN (''NGN'', ''USD''))',
      target, target || '_currency_ck');
    -- The referenced side of the currency-consistency keys. Only the tables another aggregate
    -- claims against need it, but declaring it uniformly costs one index and removes a special
    -- case a later batch would have to remember.
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
  -- is provisioned by the deployment, not by a file in this repository. Only the activated seven:
  -- granting on a table the store does not route to would be authority with no purpose.
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
$batch_b$;

-- Step 7. The aggregate graph, restored tenant-composite — and where currency must agree, carrying
-- currency too, so one constraint enforces tenant agreement and currency agreement together.
DO $graph$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'release_requests'
  ) THEN RETURN; END IF;

  ALTER TABLE financial_entitlements
    ADD CONSTRAINT financial_entitlements_eligibility_fk
    FOREIGN KEY (tenant_id, payment_eligibility_id)
    REFERENCES payment_eligibilities (tenant_id, id);

  ALTER TABLE invoices
    ADD CONSTRAINT invoices_entitlement_currency_fk
    FOREIGN KEY (tenant_id, financial_entitlement_id, currency)
    REFERENCES financial_entitlements (tenant_id, id, currency);

  ALTER TABLE release_requests
    ADD CONSTRAINT release_requests_entitlement_currency_fk
    FOREIGN KEY (tenant_id, financial_entitlement_id, currency)
    REFERENCES financial_entitlements (tenant_id, id, currency);

  ALTER TABLE release_requests
    ADD CONSTRAINT release_requests_invoice_currency_fk
    FOREIGN KEY (tenant_id, invoice_id, currency)
    REFERENCES invoices (tenant_id, id, currency);

  ALTER TABLE release_requests
    ADD CONSTRAINT release_requests_fund_reservation_fk
    FOREIGN KEY (tenant_id, fund_reservation_id)
    REFERENCES fund_reservations (tenant_id, id);

  ALTER TABLE fund_reservations
    ADD CONSTRAINT fund_reservations_funding_commitment_fk
    FOREIGN KEY (tenant_id, funding_commitment_id)
    REFERENCES funding_commitments (tenant_id, id);

  ALTER TABLE fund_reservations
    ADD CONSTRAINT fund_reservations_invoice_fk
    FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoices (tenant_id, id);

  ALTER TABLE financial_approval_decisions
    ADD CONSTRAINT financial_approval_decisions_authorization_fk
    FOREIGN KEY (tenant_id, authorization_id)
    REFERENCES authorization_decisions (tenant_id, id);

  -- New, not restored. `authorization_decisions.release_request_id` had no foreign key at all,
  -- while the engine reads the release request it names — so an authorization could be raised
  -- against a release request that does not exist, in this tenant or any other.
  ALTER TABLE authorization_decisions
    ADD CONSTRAINT authorization_decisions_release_request_currency_fk
    FOREIGN KEY (tenant_id, release_request_id, currency)
    REFERENCES release_requests (tenant_id, id, currency);
END
$graph$;

-- Step 8. Deduction non-negativity, and the natural uniqueness the engines enforce alone today.
DO $money$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'financial_entitlements'
  ) THEN
    -- A negative deduction inflates the net payable past the gross earned. The gross (> 0) and the
    -- net (>= 0) were checked; these three were not.
    ALTER TABLE financial_entitlements
      ADD CONSTRAINT financial_entitlements_retention_non_negative
      CHECK (retention_amount_minor >= 0);
    ALTER TABLE financial_entitlements
      ADD CONSTRAINT financial_entitlements_tax_non_negative
      CHECK (tax_amount_minor >= 0);
    ALTER TABLE financial_entitlements
      ADD CONSTRAINT financial_entitlements_penalty_non_negative
      CHECK (penalty_amount_minor >= 0);
    -- The arithmetic the engine performs, as a constraint. Stated so a direct write cannot produce
    -- an entitlement whose net does not follow from its parts.
    ALTER TABLE financial_entitlements
      ADD CONSTRAINT financial_entitlements_net_follows_from_parts
      CHECK (
        net_payable_amount_minor =
          gross_earned_amount_minor + variations_amount_minor
          - retention_amount_minor - tax_amount_minor - penalty_amount_minor
      );
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'invoices'
  ) THEN
    -- Was UNIQUE (workspace_id, invoice_number), which predates tenancy.
    EXECUTE (
      SELECT coalesce(string_agg(
        format('ALTER TABLE invoices DROP CONSTRAINT %I', c.conname), '; '), 'SELECT 1')
      FROM pg_constraint c
      WHERE c.conrelid = format('%I.invoices', current_schema())::regclass
        AND c.contype = 'u'
        AND (SELECT array_agg(a.attname::TEXT ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey))
            = ARRAY['invoice_number', 'workspace_id']
    );
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_workspace_number_unique
      UNIQUE (tenant_id, workspace_id, invoice_number);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'financial_approval_decisions'
  ) THEN
    -- DUPLICATE_APPROVER, in the database. Was UNIQUE (authorization_id, approver_id).
    EXECUTE (
      SELECT coalesce(string_agg(
        format('ALTER TABLE financial_approval_decisions DROP CONSTRAINT %I', c.conname), '; '),
        'SELECT 1')
      FROM pg_constraint c
      WHERE c.conrelid = format('%I.financial_approval_decisions', current_schema())::regclass
        AND c.contype = 'u'
        AND (SELECT array_agg(a.attname::TEXT ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey))
            = ARRAY['approver_id', 'authorization_id']
    );
    ALTER TABLE financial_approval_decisions
      ADD CONSTRAINT financial_approval_decisions_one_per_approver_unique
      UNIQUE (tenant_id, authorization_id, approver_id);
  END IF;
END
$money$;

-- Step 9. Segregation of duties, enforced by the database.
--
-- `docs/finance/MONETARY_INVARIANTS.md`: "The actor who proposes or calculates a monetary effect
-- does not thereby gain authority to approve or release it", and "An invariant that PostgreSQL can
-- enforce must not exist only as an application check." This one is cross-row — it compares an
-- approval against the authorization it approves — so a CHECK cannot express it and a trigger must.
CREATE OR REPLACE FUNCTION enforce_approval_segregation() RETURNS trigger
LANGUAGE plpgsql AS $segregation$
DECLARE
  requester TEXT;
BEGIN
  -- Read inside the same transaction as the insert, so a concurrent change to the authorization
  -- cannot slip a self-approval past this check.
  SELECT requested_by INTO requester
  FROM authorization_decisions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.authorization_id
  FOR SHARE;

  IF requester IS NULL THEN
    -- The composite foreign key should already have refused this. Reaching here means the key is
    -- absent, and admitting the row would approve an authorization that does not exist.
    RAISE EXCEPTION 'APPROVAL_AUTHORIZATION_NOT_FOUND: %', NEW.authorization_id;
  END IF;

  IF requester = NEW.approver_id THEN
    RAISE EXCEPTION
      'SEGREGATION_OF_DUTIES_VIOLATION: the actor who requested an authorization may not approve it';
  END IF;

  RETURN NEW;
END
$segregation$;

COMMENT ON FUNCTION enforce_approval_segregation() IS
  'Refuses a financial approval whose approver is the actor who requested the authorization. Cross-row, so a CHECK cannot express it. Mirrors FinancialApprovalAuthorityEngine SEGREGATION_OF_DUTIES_VIOLATION, which remains — the application refusal names the cause to the caller, this one holds for a direct statement.';

-- Step 10. Mutation boundaries, using the functions `202608100001` created.
DO $transitions$
DECLARE
  governed CONSTANT JSONB := $spec$
  [
    { "table": "financial_entitlements", "status": "status", "terminal": ["CONFIRMED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","payment_eligibility_id","currency","gross_earned_amount_minor","variations_amount_minor","retention_amount_minor","tax_amount_minor","penalty_amount_minor","net_payable_amount_minor","calculated_at","schema_version"] },
    { "table": "invoices", "status": "status", "terminal": ["APPROVED","REJECTED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","financial_entitlement_id","invoice_number","amount_minor","currency","submitted_by","created_at","schema_version"] },
    { "table": "release_requests", "status": "status", "terminal": ["CANCELLED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","financial_entitlement_id","invoice_id","fund_reservation_id","release_type","requested_amount_minor","currency","requested_by","created_at","schema_version"] },
    { "table": "authorization_decisions", "status": "status", "terminal": ["AUTHORIZED","REJECTED"],
      "immutable": ["id","tenant_id","workspace_id","release_request_id","requested_by","amount_minor","currency","required_approvals","created_at","schema_version"] },
    { "table": "fund_reservations", "status": "status", "terminal": ["RELEASED","CANCELLED"],
      "immutable": ["id","tenant_id","workspace_id","funding_commitment_id","invoice_id","reserved_amount_minor","created_at","schema_version"] },
    { "table": "funding_commitments", "status": "status", "terminal": ["CONFIRMED","CANCELLED"],
      "immutable": ["id","tenant_id","workspace_id","milestone_id","provider_key","external_custody_reference","committed_amount_minor","currency","created_at","schema_version"] }
  ]
  $spec$::JSONB;

  -- Never transitioned by any canonical engine. Their blanket append-only triggers stay untouched.
  append_only CONSTANT TEXT[] := ARRAY[
    'payment_eligibilities', 'approval_thresholds', 'financial_approval_decisions'
  ];

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

  -- The append-only three must still be append-only. A future migration dropping one of these
  -- would leave a settlement aggregate with no mutation boundary, and the only symptom would be a
  -- write that quietly succeeded.
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
      missing := missing || target;
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'BATCH_B_APPEND_ONLY_TRIGGER_MISSING: %. These aggregates are never transitioned by their '
      'canonical engines and must refuse every UPDATE and DELETE. Nothing has been changed.',
      array_to_string(missing, ', ');
  END IF;

  -- The segregation trigger, on insert. Approvals are append-only, so insert is the only path.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'financial_approval_decisions'
  ) THEN
    DROP TRIGGER IF EXISTS financial_approval_decisions_segregation
      ON financial_approval_decisions;
    CREATE TRIGGER financial_approval_decisions_segregation
      BEFORE INSERT ON financial_approval_decisions
      FOR EACH ROW EXECUTE FUNCTION enforce_approval_segregation();
  END IF;
END
$transitions$;

DO $comments$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'financial_entitlements'
  ) THEN
    COMMENT ON TABLE financial_entitlements IS
      'Canonical Engine 42 financial entitlement. Money is bigint minor units with a governed ISO currency; deductions are non-negative and the net payable is constrained to follow from its parts. Tenant and workspace answer to the trust runtime, and every claim against this entitlement must agree with it on both tenant and currency. CONFIRMED is terminal and the calculated amounts are immutable.';
    COMMENT ON TABLE fund_reservations IS
      'Canonical Engine 44 fund reservation — a Batch C aggregate. Converged by 202608100002 rather than activated, because its foreign keys entangle it with Batch B and the closure could not be converted in parts. No repository routes to it and no readiness check requires it until Batch C.';
  END IF;
END
$comments$;

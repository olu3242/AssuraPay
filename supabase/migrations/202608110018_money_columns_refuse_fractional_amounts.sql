-- Every money column refuses a fractional amount instead of rounding it.
--
-- Thirty-one columns across twenty-two tables, every one of them integer minor units per CLAUDE.md's fourth
-- constraint, and every one of them `BIGINT`. This migration converts all thirty-one to `NUMERIC` and gives
-- each an integrality CHECK and a magnitude bound.
--
-- ## Why an integer column is the wrong instrument here
--
-- A CHECK cannot save a value an integer column has already changed. The cast to `BIGINT` happens *before* any
-- constraint is evaluated, so `CHECK (amount_minor >= 0)` sees the rounded value and passes:
--
--     INSERT ... cost_minor = 100.5   -- stored as 101
--     INSERT ... cost_minor =  99.5   -- stored as 100
--
-- Both measured against a live instance. Half-away-from-zero, so the direction is not even consistent in a way
-- a reader could predict. Until now the only thing refusing a fractional amount anywhere in the platform was
-- the `minorUnits` contract in `packages/domain-contracts`, applied in the repository before the statement —
-- which means the guarantee held only for callers who went through a repository, and the database, which this
-- programme has spent thirteen batches making the authority, was the looser of the two.
--
-- ## The consequence that makes this a settlement defect rather than a rounding nit
--
-- `reconciliation_records` carries `provider_reported_amount_minor`, `recorded_amount_minor`, and
-- `matched BOOLEAN` with `CHECK (matched = (provider_reported_amount_minor = recorded_amount_minor))`. Two
-- amounts that differ by less than a kobo round to the same integer, and then the constraint does not merely
-- fail to notice — **it inverts**. Proved by statement against a live instance, with the provider reporting
-- 100.5 and the ledger holding 100.6:
--
--   * the truthful row, `matched = false`, is **REFUSED**: after rounding both columns read 101, so the
--     constraint demands the flag be true;
--   * the false row, `matched = true`, is **ACCEPTED** and stored.
--
-- So a reconciliation between two amounts that were not equal is recorded as a clean match, the exception that
-- should have been raised never is, and CLAUDE.md's third hard constraint makes that row permanent history.
-- The same mechanism sits under `financial_entitlements_net_follows_from_parts` and
-- `final_settlement_accounts_outstanding_follows_from_parts`, where the derived value is what a certified
-- Financial Provider is instructed to release.
--
-- ## The second bound, and why it belongs in the same change
--
-- `BIGINT` accepts values up to about 9.2 x 10^18. `minorUnits` in the schema contract is
-- `int().min(0).max(Number.MAX_SAFE_INTEGER)`, and every repository reads these columns through `Number(...)`.
-- So a stored amount above 2^53 - 1 loses precision on the way *out*, silently, and `Number.isInteger` still
-- answers true for the corrupted value — the read-side mirror of the write-side defect this migration closes.
-- The column was looser than the contract that describes it, which is the same shape as the write-side gap, so
-- both are closed together rather than leaving one for a reader to rediscover.
--
-- ## Safe on populated tables
--
-- Unlike the identity conversions of Batches A-M, this one needs no emptiness check and refuses nothing.
-- `BIGINT` to `NUMERIC` is a widening conversion: every value already stored is an integer within range, so
-- every row satisfies both new constraints by construction. `ALTER TABLE ... ALTER COLUMN ... TYPE` rewrites
-- the table and revalidates the existing CHECKs, all thirty-one of which are sign and derivation rules that
-- hold identically over NUMERIC.
--
-- Nothing else depends on the type: no view, no generated column, no index and no foreign key mentions any of
-- these columns, all verified against a live instance. The deferred double-entry constraint trigger sums
-- `ledger_entries.amount_minor`; PL/pgSQL is late-bound and NUMERIC sums exactly, so it is unaffected — and its
-- balance assertion becomes stronger, because the operands can no longer be rounded values.
--
-- ## The read path does not change
--
-- Deliberately verified rather than assumed: the postgres.js driver returns `NUMERIC` and `BIGINT` alike as
-- **strings**, precisely to avoid the precision loss a float conversion would cause. Every batch repository
-- already parses these columns through the same `integer()` reader, which asserts `Number.isInteger` after
-- parsing. So no repository, no schema and no engine changes with this migration.

DO $money_integrality$
DECLARE
  -- Listed explicitly rather than discovered by name pattern, so the set is auditable in review: a pattern
  -- would silently include a column added later that happens to match, and silently miss one that does not.
  -- The completeness assertion at the end of this block is what catches a column missing from this list.
  money CONSTANT TEXT[][] := ARRAY[
    ['agent_telemetry', 'cost_minor'],
    ['approval_thresholds', 'max_amount_minor'],
    ['approval_thresholds', 'min_amount_minor'],
    ['authorization_decisions', 'amount_minor'],
    ['baseline_variances', 'actual_cost_amount_minor'],
    ['baseline_variances', 'cost_variance_minor'],
    ['blueprint_milestones', 'budget_amount_minor'],
    ['final_settlement_accounts', 'outstanding_amount_minor'],
    ['final_settlement_accounts', 'total_entitlement_amount_minor'],
    ['final_settlement_accounts', 'total_settled_amount_minor'],
    ['financial_entitlements', 'gross_earned_amount_minor'],
    ['financial_entitlements', 'net_payable_amount_minor'],
    ['financial_entitlements', 'penalty_amount_minor'],
    ['financial_entitlements', 'retention_amount_minor'],
    ['financial_entitlements', 'tax_amount_minor'],
    ['financial_entitlements', 'variations_amount_minor'],
    ['fund_reservations', 'reserved_amount_minor'],
    ['funding_commitments', 'committed_amount_minor'],
    ['invoices', 'amount_minor'],
    ['ledger_entries', 'amount_minor'],
    ['payment_authorization_proposals', 'amount_minor'],
    ['payment_instructions', 'amount_minor'],
    ['payment_trigger_definitions', 'amount_minor'],
    ['payment_trigger_rules', 'amount_minor'],
    ['performance_baselines', 'planned_budget_amount_minor'],
    ['portfolio_snapshots', 'retained_amount_minor'],
    ['portfolio_snapshots', 'unpaid_amount_minor'],
    ['progress_records', 'earned_value_amount_minor'],
    ['reconciliation_records', 'provider_reported_amount_minor'],
    ['reconciliation_records', 'recorded_amount_minor'],
    ['release_requests', 'requested_amount_minor']
  ];
  -- 2^53 - 1. The largest integer a JavaScript number represents exactly, and the bound `minorUnits` already
  -- declares. Above it, a value read back through `Number(...)` is not the value that was stored.
  safe_integer CONSTANT NUMERIC := 9007199254740991;
  -- Money columns on tables of the *historical* trust model, which `202608080001` retires.
  --
  -- Found by the completeness assertion below rather than by inspection, and worth stating because the
  -- exclusion looks like a loophole and is not one. On any database where reconciliation has been applied
  -- neither table exists, so the conversion loop above would skip them anyway. They appear only in an upgrade
  -- rehearsal that deliberately defers `202608080001` in order to start from a pre-reconciliation database —
  -- and converting a table that the same migration run is about to drop is pointless work on a table with no
  -- reader and no writer.
  --
  -- What closes the loop is a different gate: both names are in `RETIRED_TRUST_HISTORICAL_TABLES`, so if either
  -- survives into a reconciled database `certifySchemaOwnership` already fails it with
  -- `OWNERSHIP_RETIRED_TABLE_PRESENT` — two models for one aggregate is a startup refusal, not a rounding
  -- question. So the exclusion cannot hide a live money column: a live one would mean that gate is already red.
  historical CONSTANT TEXT[] := ARRAY['delegations', 'authority_rules'];
  entry        TEXT[];
  tbl          TEXT;
  col          TEXT;
  remaining    TEXT[] := '{}';
  rec          RECORD;
BEGIN
  FOREACH entry SLICE 1 IN ARRAY money LOOP
    tbl := entry[1];
    col := entry[2];

    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = tbl AND column_name = col
    );

    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC', tbl, col);

    -- An amount of minor units is a whole number of them. `trunc` rather than `scale() = 0`, because
    -- `100.00` and `100` are the same amount and only one of them has scale zero.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I = trunc(%I))',
      tbl, col || '_is_integral', col, col, col);

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I <= %s)',
      tbl, col || '_within_safe_range', col, col, safe_integer);
  END LOOP;

  -- The completeness assertion. Any column whose name says it holds money and whose type is still an integer
  -- one was missed by the list above, and would keep rounding silently — so the migration refuses rather than
  -- reporting success over a partial conversion.
  FOR rec IN
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND data_type IN ('bigint', 'integer', 'smallint')
      AND (column_name LIKE '%\_minor' OR column_name LIKE '%minor\_units%'
           OR column_name LIKE '%amount%')
      AND NOT (table_name = ANY(historical))
  LOOP
    remaining := remaining || format('%s.%s (%s)', rec.table_name, rec.column_name, rec.data_type);
  END LOOP;

  IF array_length(remaining, 1) > 0 THEN
    RAISE EXCEPTION
      'MONEY_INTEGRALITY_INCOMPLETE: % money column(s) are still an integer type and will keep rounding a '
      'fractional amount rather than refusing it: %. Add them to this migration''s list.',
      array_length(remaining, 1), array_to_string(remaining, ', ');
  END IF;
END
$money_integrality$;

COMMENT ON COLUMN reconciliation_records.provider_reported_amount_minor IS
  'What the certified Financial Provider reported, in integer minor units. NUMERIC with an integrality CHECK rather than BIGINT since 202608110018: as an integer column it rounded, and because `matched` is a CHECK over the equality of this column and recorded_amount_minor, two amounts differing by less than a kobo rounded equal — which made the database refuse the truthful matched=false row and accept matched=true, recording a clean match for a genuine discrepancy.';

COMMENT ON COLUMN ledger_entries.amount_minor IS
  'Integer minor units. NUMERIC with an integrality CHECK since 202608110018, which also strengthens the deferred double-entry constraint: the sum it balances can no longer be a sum of rounded values.';

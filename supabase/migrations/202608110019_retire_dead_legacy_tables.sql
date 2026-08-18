-- Retires `contracts` and `milestones`, the last two tables in the schema with no boundary of any kind.
--
-- `202608010001` created both. Nothing has ever read or written either through the durable store: they are
-- absent from `POSTGRES_ROUTED_TABLES`, absent from `REQUIRED_STORE_TABLES`, and the only reference to their
-- names anywhere in TypeScript is the Batch L assertion that lists them as the known exceptions to row-level
-- security. Their live state, measured before this migration was written:
--
--   * zero rows in each;
--   * `relrowsecurity` false — not ENABLE-without-FORCE, which Batches A-M reduced from 59 tables to zero, but
--     **no row-level security at all**;
--   * zero policies;
--   * zero foreign keys, inbound or outbound.
--
-- The canonical aggregates that superseded them are `agreements` (Batch F, the chain's first link) and
-- `blueprint_milestones` / `governed_milestones` (Batches E and H). Those carry TEXT identity, tenant scope,
-- FORCE row-level security and governed mutation boundaries; these two carry none of it.
--
-- Why retire rather than secure them: forcing a boundary on a table with no reader and no writer is work that
-- looks like security and delivers none — the reasoning `DURABILITY_GAP_ANALYSIS.md` recorded for the 59
-- unforced tables, which held until each one either gained a repository or was dropped. These two never will.
-- Leaving them is how a future policy gets written against the superseded model, which is exactly what
-- `202608080001` had to correct for the thirty-one-table trust model.
--
-- After this migration the only table in the schema without row-level security is `trust_migration_ledger`,
-- which the schema owner writes and every host reads at startup — a table about the database rather than about
-- a tenant, and the one legitimate exception.

DO $retire_dead_legacy_tables$
DECLARE
  dead CONSTANT TEXT[] := ARRAY['contracts', 'milestones'];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  FOREACH target IN ARRAY dead LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
    IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
  END LOOP;

  -- "These tables are empty" is a claim about every database that will ever apply this migration, not about the
  -- one it was written against. Refuse rather than discard.
  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'DEAD_TABLE_RETIREMENT_REFUSED: % table(s) hold rows: %. These are legacy tables with no reader or '
      'writer, superseded by agreements and blueprint_milestones, but dropping rows is not a migration''s '
      'decision to make. Move them deliberately, then re-run. Nothing has been changed.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(dead)
      AND NOT (c.conrelid::regclass::text = ANY(dead))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'DEAD_TABLE_RETIREMENT_REFUSED: foreign key(s) from outside the set reference it: %. Something depends '
      'on these tables after all. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Both together, because a foreign key between them would otherwise decide the order.
  DROP TABLE IF EXISTS milestones, contracts;
END
$retire_dead_legacy_tables$;

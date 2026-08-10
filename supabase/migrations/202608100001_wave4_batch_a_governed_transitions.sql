-- Batch A becomes writable, and the database becomes the authority on what a write may change.
--
-- `202608090001` made the sixteen Engine 31-40 tables answer to the trust runtime: TEXT identity,
-- tenant and workspace foreign keys into `trust_tenants` and `trust_workspaces`, FORCE RLS with a
-- trust-scoped policy. It made them *fit to receive* the aggregates. It did not make them able to
-- hold them, and this migration closes three gaps that a cutover would otherwise have discovered
-- in production.
--
-- 1. ELEVEN TABLES CARRIED A BLANKET APPEND-ONLY TRIGGER, AND FIVE OF THEM ARE MUTATED BY THE
--    CANONICAL ENGINES.
--
--    `202608030006` and `202608030007` created `<table>_append_only` triggers refusing every
--    UPDATE and DELETE. For six tables that matches canonical behaviour exactly — nothing ever
--    calls `replace` on a progress record, an evidence requirement, a validation test, a quality
--    plan, a quality gate result or a change approval, and those triggers are left untouched.
--
--    For the other five it does not. `EvidenceManagementEngine.verify` transitions an evidence
--    package to VERIFIED or REJECTED; `QualityAssuranceEngine` moves a defect through IN_REWORK,
--    RESOLVED and CLOSED; `InspectionEngine.complete` records findings; `AcceptanceDecisionEngine`
--    supersedes the prior decision; `CompletionCertificationEngine.revoke` revokes a certificate.
--    Every one of those is a state transition the engine's own certification suite asserts, and
--    every one of them would have been refused by the trigger the moment reads and writes moved.
--    The comment in `202608090001` claiming the triggers "already protect ... which is the
--    behaviour these aggregates require" was wrong about those five.
--
--    `docs/persistence/WAVE_4_SCHEMA_AUTHORITY.md` decides this conflict: canonical engine
--    behaviour and state-transition tests are authority rank 5, existing relational table
--    definitions rank 9. The engine wins — but "the engine wins" is not "immutability is
--    abandoned". A blanket refusal is replaced by an explicit one: the row cannot be deleted, its
--    recorded facts cannot change, its version must advance, and once its lifecycle reaches a
--    terminal state nothing may touch it again. What was protected by accident is now protected on
--    purpose, and the parts that had to give way are named.
--
-- 2. FIVE TABLES HAD NO TRIGGER AT ALL AND PERMITTED ARBITRARY UPDATE AND DELETE.
--
--    `execution_workspaces`, `work_items`, `issue_records`, `corrective_action_plans` and
--    `change_requests` are mutated by their engines and were governed by nothing: a console
--    session could have rewritten a work item's assignee, or deleted an escalated issue, with no
--    trace. They get the same governed transition rules. All sixteen tables are now covered.
--
-- 3. TWO UNIQUE CONSTRAINTS WERE GLOBAL WHERE THE ENGINE'S RULE IS PER WORKSPACE.
--
--    `UNIQUE (milestone_id)` on `execution_workspaces` and `UNIQUE (certificate_number)` on
--    `completion_certificates` predate tenancy. The first forbids two tenants from ever executing
--    against the same milestone identifier. The second is worse: `CompletionCertificationEngine`
--    numbers certificates per workspace — `CERT-000001` is the first certificate *in a workspace* —
--    so the second workspace in a deployment would have failed to issue its first certificate.
--    Both become tenant-and-workspace scoped, which is what the engines mean.
--
--    Two natural uniqueness rules the engines enforce in application code and the database did not
--    are added as partial unique indexes: one CERTIFIED certificate per work item, and one ACTIVE
--    acceptance decision per work item. Both are cross-row invariants, so a CHECK cannot express
--    them, and both are exactly the "per-aggregate natural uniqueness" the accepted architecture
--    decision requires before an aggregate is activated.
--
-- NO EMPTINESS GUARD, DELIBERATELY. Unlike `202608090001`, nothing here converts a column type, so
-- there is no operation that is lossless only on an empty table. Adding a uniqueness rule to a
-- table that already violates it fails loudly with the conflicting rows named, which is the
-- correct outcome and better evidence than a refusal that inspects nothing.

CREATE OR REPLACE FUNCTION enforce_governed_aggregate_transition() RETURNS trigger
LANGUAGE plpgsql AS $governed$
DECLARE
  -- The trigger arguments are the column names whose values may never change after the row is
  -- created, so one function serves every aggregate without knowing any of their shapes.
  immutable_column TEXT;
  before_row       JSONB := to_jsonb(OLD);
  after_row        JSONB;
BEGIN
  -- History is not deletable. Enforced here as well as by withholding the DELETE privilege,
  -- because a privilege can be granted by an operator in a hurry and a trigger cannot.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AGGREGATE_ROW_IS_NOT_DELETABLE: %', TG_TABLE_NAME;
  END IF;

  after_row := to_jsonb(NEW);

  FOREACH immutable_column IN ARRAY TG_ARGV LOOP
    -- IS DISTINCT FROM, not <>: a column going from NULL to a value, or the reverse, is a change,
    -- and <> would evaluate to NULL and let it through.
    IF before_row -> immutable_column IS DISTINCT FROM after_row -> immutable_column THEN
      RAISE EXCEPTION 'AGGREGATE_FACT_IS_IMMUTABLE: %.%', TG_TABLE_NAME, immutable_column;
    END IF;
  END LOOP;

  -- Optimistic concurrency has to move forward or it is not concurrency control. Two writers that
  -- both read version 3 and both write version 4 would otherwise both succeed, and the second
  -- would silently discard the first.
  IF (after_row ->> 'version')::BIGINT <= (before_row ->> 'version')::BIGINT THEN
    RAISE EXCEPTION 'AGGREGATE_VERSION_MUST_ADVANCE: % (% -> %)',
      TG_TABLE_NAME, before_row ->> 'version', after_row ->> 'version';
  END IF;

  RETURN NEW;
END
$governed$;

COMMENT ON FUNCTION enforce_governed_aggregate_transition() IS
  'Refuses DELETE, refuses any change to the columns named in the trigger arguments, and requires the version column to advance. Replaces the blanket append-only trigger on aggregates whose canonical engines perform lifecycle transitions.';

CREATE OR REPLACE FUNCTION enforce_terminal_aggregate_state() RETURNS trigger
LANGUAGE plpgsql AS $terminal$
DECLARE
  -- Argument 0 names the status column; the rest are the states from which no transition exists.
  status_column TEXT := TG_ARGV[0];
  terminal      TEXT[] := TG_ARGV[1:array_length(TG_ARGV, 1) - 1];
  before_status TEXT;
BEGIN
  before_status := to_jsonb(OLD) ->> status_column;
  -- A lifecycle state is not private data, so naming it in the error is safe and is the only way
  -- the caller learns which state blocked the write.
  IF before_status = ANY(terminal) THEN
    RAISE EXCEPTION 'AGGREGATE_STATE_IS_TERMINAL: %.% is %',
      TG_TABLE_NAME, status_column, before_status;
  END IF;
  RETURN NEW;
END
$terminal$;

COMMENT ON FUNCTION enforce_terminal_aggregate_state() IS
  'Refuses any UPDATE to a row already in one of the terminal lifecycle states named in the trigger arguments. A terminal state that can be left is not terminal, and the engines treat these as final.';

DO $batch_a$
DECLARE
  -- Per aggregate: the table, its status column, its terminal states, and the facts that may never
  -- change. Written out rather than derived, because "which columns are immutable" is a statement
  -- about the domain and cannot be read off a schema.
  governed CONSTANT JSONB := $spec$
  [
    { "table": "execution_workspaces", "status": "status", "terminal": ["SUBMITTED"],
      "immutable": ["id","tenant_id","workspace_id","blueprint_id","milestone_id","created_at","schema_version"] },
    { "table": "work_items", "status": "status", "terminal": ["SUBMITTED","CANCELLED"],
      "immutable": ["id","tenant_id","workspace_id","execution_workspace_id","deliverable_id","title","assignee_id","created_at","schema_version"] },
    { "table": "evidence_packages", "status": "status", "terminal": ["VERIFIED","REJECTED"],
      "immutable": ["id","tenant_id","workspace_id","work_item_id","deliverable_id","files","created_at","schema_version"] },
    { "table": "defects", "status": "status", "terminal": ["CLOSED"],
      "immutable": ["id","tenant_id","workspace_id","work_item_id","severity","description","raised_by","created_at","schema_version"] },
    { "table": "inspections", "status": "status", "terminal": ["COMPLETED","CANCELLED"],
      "immutable": ["id","tenant_id","workspace_id","work_item_id","scheduled_for","checklist","reinspection_of_id","created_at","schema_version"] },
    { "table": "issue_records", "status": "status", "terminal": ["CLOSED"],
      "immutable": ["id","tenant_id","workspace_id","work_item_id","kind","severity","description","raised_by","created_at","schema_version"] },
    { "table": "corrective_action_plans", "status": "status", "terminal": ["VERIFIED"],
      "immutable": ["id","tenant_id","workspace_id","issue_id","action_plan","owner_id","due_date","created_at","schema_version"] },
    { "table": "change_requests", "status": "status", "terminal": ["IMPLEMENTED","REJECTED"],
      "immutable": ["id","tenant_id","workspace_id","blueprint_id","milestone_id","change_type","description","impact","requested_by","created_at","schema_version"] },
    { "table": "acceptance_decisions", "status": "status", "terminal": ["SUPERSEDED"],
      "immutable": ["id","tenant_id","workspace_id","work_item_id","decision","rationale","conditions","decided_by","decided_at","supersedes_id","schema_version"] },
    { "table": "completion_certificates", "status": "status", "terminal": ["REVOKED"],
      "immutable": ["id","tenant_id","workspace_id","work_item_id","milestone_id","certificate_number","acceptance_decision_id","canonical_hash","issued_by","issued_at","schema_version"] }
  ]
  $spec$::JSONB;

  -- The six whose canonical engines never transition them. Their blanket append-only triggers stay
  -- exactly as `202608030006` and `202608030007` created them; this list exists so the migration
  -- can assert that rather than leave it implied.
  append_only CONSTANT TEXT[] := ARRAY[
    'progress_records', 'evidence_requirements', 'validation_tests', 'quality_plans',
    'quality_gate_results', 'change_approvals'
  ];

  spec      JSONB;
  target    TEXT;
  arguments TEXT;
  missing   TEXT[] := '{}';
BEGIN
  -- Absent tables are tolerated for the same reason `202608090001` tolerates them: a schema that
  -- never carried the historical model is a legitimate deployment of the trust runtime alone.
  FOR spec IN SELECT value FROM jsonb_array_elements(governed) AS entries(value) LOOP
    target := spec ->> 'table';
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    -- The blanket trigger, where one exists, is replaced rather than supplemented. Leaving it in
    -- place alongside the governed one would refuse every transition and make the new rules
    -- unreachable — a boundary that cannot be exercised is not a boundary that has been tested.
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

  -- The append-only six must still be append-only. A future migration that dropped one of these
  -- triggers would otherwise leave an aggregate with no mutation boundary at all, and the only
  -- symptom would be a write that quietly succeeded.
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
      'BATCH_A_APPEND_ONLY_TRIGGER_MISSING: %. These aggregates are never transitioned by their '
      'canonical engines and must refuse every UPDATE and DELETE. Nothing has been changed.',
      array_to_string(missing, ', ');
  END IF;
END
$batch_a$;

-- Natural uniqueness, scoped to the tenant and workspace the engines scope to.
DO $uniqueness$
DECLARE
  obsolete RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'execution_workspaces'
  ) THEN
    -- Dropped by discovery rather than by name: what matters is that no unique constraint spans
    -- exactly `(milestone_id)`, whatever a past migration happened to call it.
    FOR obsolete IN
      SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid = format('%I.execution_workspaces', current_schema())::regclass
        AND c.contype = 'u'
        AND (SELECT array_agg(a.attname::TEXT ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) = ARRAY['milestone_id']
    LOOP
      EXECUTE format('ALTER TABLE execution_workspaces DROP CONSTRAINT %I', obsolete.conname);
    END LOOP;

    -- ExecutionOrchestrationEngine.open refuses a second workspace for a milestone it already
    -- executes. That rule is per workspace, and it was expressible only in application code.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'execution_workspaces_workspace_milestone_unique'
        AND conrelid = format('%I.execution_workspaces', current_schema())::regclass
    ) THEN
      ALTER TABLE execution_workspaces
        ADD CONSTRAINT execution_workspaces_workspace_milestone_unique
        UNIQUE (tenant_id, workspace_id, milestone_id);
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'completion_certificates'
  ) THEN
    FOR obsolete IN
      SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid = format('%I.completion_certificates', current_schema())::regclass
        AND c.contype = 'u'
        AND (SELECT array_agg(a.attname::TEXT ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) = ARRAY['certificate_number']
    LOOP
      EXECUTE format('ALTER TABLE completion_certificates DROP CONSTRAINT %I', obsolete.conname);
    END LOOP;

    -- CERT-000001 is the first certificate in a workspace, not in a database.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'completion_certificates_workspace_number_unique'
        AND conrelid = format('%I.completion_certificates', current_schema())::regclass
    ) THEN
      ALTER TABLE completion_certificates
        ADD CONSTRAINT completion_certificates_workspace_number_unique
        UNIQUE (tenant_id, workspace_id, certificate_number);
    END IF;

    -- CERTIFICATE_ALREADY_ISSUED, in the database. The engine counts CERTIFIED rows before
    -- issuing, which two concurrent requests both pass; a partial unique index is what makes the
    -- second one fail instead of producing a work item with two live certificates.
    CREATE UNIQUE INDEX IF NOT EXISTS completion_certificates_one_certified_per_work_item
      ON completion_certificates (tenant_id, workspace_id, work_item_id)
      WHERE status = 'CERTIFIED';

    COMMENT ON TABLE completion_certificates IS
      'Canonical Engine 40 completion certificate. Certificate numbers are unique per tenant and workspace, not globally, and at most one certificate per work item may be CERTIFIED. A certificate''s committed facts and its canonical hash are immutable; revocation is a status transition and REVOKED is terminal.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'acceptance_decisions'
  ) THEN
    -- AcceptanceDecisionEngine.decide supersedes the prior decision before appending the new one,
    -- so at most one is ACTIVE per work item. `latest` and `isAccepted` both assume it, and every
    -- downstream release gate reads them.
    CREATE UNIQUE INDEX IF NOT EXISTS acceptance_decisions_one_active_per_work_item
      ON acceptance_decisions (tenant_id, workspace_id, work_item_id)
      WHERE status = 'ACTIVE';
  END IF;
END
$uniqueness$;

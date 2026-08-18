-- Batch I activates agreement intelligence, and makes an AI reading of a contract reviewable evidence.
--
-- Six aggregates for canonical Engines 16-20 — contract version, analysis run, analysis review, risk
-- assessment, repository document, agreement intelligence version.
--
-- **Six, not five.** `contractVersionsV2` is written by `ContractVersionEngine` and was in neither the
-- durability register nor the coverage baseline, because that gate matched collection names with
-- `[a-zA-Z]+` and dropped every name containing a digit. The correction landed first, and it changed the
-- shape of this batch: `contract_versions_v2` looked like a foreign parent with no `tenant_id` — which
-- would have forced either an unbounded conversion or a bare identifier — and is in fact one of this
-- batch's own aggregates.
--
-- ## The closure is larger than the aggregate set, for the first time in the register
--
-- Five of the six tables exist; `analysis_reviews` has never existed and is created here, so a reviewer's
-- decision on a finding had nowhere to go at all. And two tables reference the closure that no engine
-- writes: `agreement_intelligence_items` and `contract_analysis_findings`. Both are leaves — nothing
-- references them — but their `*_id` columns point at aggregates whose identity this migration converts
-- from UUID to TEXT. Leaving them alone would either break their foreign keys or leave a UUID column
-- pointing at a TEXT one, which is the identity split the platform has been eliminating since Batch A. So
-- they are converged and governed without being routed: the arrangement Batch B named, activated
-- aggregates with a converged closure around them.
--
-- That is also why the usual "no foreign key from outside the closure" guard is written against the
-- *conversion* set rather than the aggregate set. The check still has teeth — it refuses a reference from
-- anywhere this migration does not convert — but it counts the two leaves as inside.
--
-- ## What this batch enforces that nothing did
--
-- These aggregates keep their child collections inline as `jsonb`, so rules that would be cross-row
-- elsewhere are checkable from one row here, and the database can hold them:
--
--   * a **published** intelligence version may contain no item still PENDING and must contain at least one
--     ACCEPTED. `publish()` refuses both; this is the human-in-the-loop rule that keeps a machine reading
--     of an agreement from becoming the agreement's terms unreviewed, and it is now a constraint rather
--     than only a guard;
--   * a risk **level must follow from its score** on the engine's own thresholds, so a CRITICAL banner
--     cannot sit above a score of four. The banner is what a reader acts on;
--   * every finding above INFO, every explanation and every intelligence item must **cite a source**.
--     `SOURCE_REFERENCE_REQUIRED` is the engine's rule and an uncited claim about a contract is an
--     assertion with nothing behind it.
--
-- ## The content hash is immutable, which required fixing the engine first
--
-- `contentHash` was a digest over each item *including* its review status, and `review()` changes that
-- status without recomputing the hash — so after any review the stored hash described a state that no
-- longer existed, while `publish()` emitted it as the citation for what was published. The engine now
-- digests only what was extracted: identity, type, value and sources. That never changes, which is what
-- lets `content_hash` be immutable here rather than a value that silently goes stale.
--
-- ## `confidence` is deliberately left unbounded
--
-- No engine bounds it, and the scale is stated nowhere in the repository. The only bound anywhere is
-- `CHECK (confidence BETWEEN 0 AND 1)` on the two leaf tables `202608030003` created — the two no engine
-- writes — so it constrains nothing that is actually stored: on the six routed aggregates `confidence` lives
-- inside a `jsonb` item or finding, where a value of 5000 is accepted today.
--
-- That bound is not adopted for the routed aggregates, because it is a guess with no authority behind it.
-- Guessing 0-1 would reject a gateway reporting percentages; guessing 0-100 would accept a probability of
-- 100 as certainty. It is a gap in the model rather than in the plumbing, and inventing a bound here would
-- bury it where the next reader takes it for a decision.

CREATE TABLE IF NOT EXISTS analysis_reviews (
  id                        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id                 TEXT NOT NULL,
  workspace_id              TEXT NOT NULL,
  run_id                    TEXT NOT NULL,
  finding_id                TEXT NOT NULL,
  decision                  TEXT NOT NULL CHECK (decision IN ('ACCEPTED', 'REJECTED')),
  -- A decision with no note is not reviewable, and this row is the evidence a finding was considered
  -- rather than clicked through.
  notes                     TEXT NOT NULL CHECK (length(btrim(notes)) > 0),
  reviewer_id               TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version            INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $batch_i$
DECLARE
  -- Every table whose identity this migration converts. Wider than the aggregate set by the two leaves
  -- that reference it, because a conversion that breaks their keys is not a conversion.
  conversion CONSTANT TEXT[] := ARRAY[
    'contract_versions_v2', 'contract_analysis_runs', 'analysis_reviews', 'contract_risk_assessments',
    'contract_repository_documents', 'agreement_intelligence_versions',
    'agreement_intelligence_items', 'contract_analysis_findings'
  ];
  -- Append-only in the engines. A run is a measurement taken at a moment and a review is one reviewer's
  -- position; neither is ever passed to `replace`.
  append_only CONSTANT TEXT[] := ARRAY['contract_analysis_runs', 'analysis_reviews'];
  -- Transitioned: a version superseded, an assessment validated, a document placed under legal hold, an
  -- intelligence version reviewed and published.
  governed CONSTANT TEXT[] := ARRAY[
    'contract_versions_v2', 'contract_risk_assessments', 'contract_repository_documents',
    'agreement_intelligence_versions'
  ];
  -- Converged, governed, and not routed. No engine writes either.
  converged CONSTANT TEXT[] := ARRAY['agreement_intelligence_items', 'contract_analysis_findings'];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
  FOREACH target IN ARRAY conversion LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('SELECT count(*) FROM %I', target) INTO rows;
    IF rows > 0 THEN occupied := occupied || format('%s=%s', target, rows); END IF;
  END LOOP;

  IF array_length(occupied, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE6_BATCH_I_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table. Nothing has been changed. '
      'Backfill and convert deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

  -- Against the conversion set, so the two leaves count as inside it. A reference from anywhere this
  -- migration does not convert is still refused.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid::regclass::text = ANY(conversion)
      AND NOT (c.conrelid::regclass::text = ANY(conversion))
  LOOP
    intruder := intruder || format('%s->%s', rec.child, rec.parent);
  END LOOP;

  IF array_length(intruder, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE6_BATCH_I_AUTHORITY_REFUSED: foreign key(s) from outside the conversion set reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Policies first: PostgreSQL refuses to alter the type of a column a policy predicates on.
  FOREACH target IN ARRAY conversion LOOP
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

  -- Step 2. Every foreign key on the conversion set, including those pointing at the deprecated
  -- `workspaces`. All recreated below against the trust runtime.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(conversion)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. The tenant-blind unique keys `202608110010` deferred to the batch that activates them. Four are
  -- on this closure: `contract_versions_v2 (contract_id, version_number)` and `(workspace_id,
  -- document_hash)`, `contract_risk_assessments (contract_version_id, version)`, and
  -- `agreement_intelligence_versions (contract_id, version)`. Every one is re-added scoped below — dropping
  -- a uniqueness guarantee and not replacing it would trade a cross-tenant collision for a duplicate
  -- revision, which is the worse of the two.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'u' AND c.conrelid::regclass::text = ANY(conversion)
      AND pg_get_constraintdef(c.oid) NOT LIKE '%tenant_id%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 4. Converge identity on TEXT. Every UUID column, not only the keys: `created_by`, `requested_by`
  -- and `execution_certificate_id` are trust principals and references, and a UUID column cannot hold one.
  -- A table's columns are converted in one ALTER so multi-column constraints stay valid at each statement
  -- boundary.
  FOR rec IN
    SELECT c.table_name AS tbl,
           string_agg(format('ALTER COLUMN %I TYPE TEXT USING %I::text', c.column_name, c.column_name),
                      ', ' ORDER BY c.column_name) AS conversions,
           array_agg(c.column_name ORDER BY c.column_name) AS columns,
           array_agg(c.column_name ORDER BY c.column_name)
             FILTER (WHERE c.column_default IS NOT NULL) AS defaulted
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(conversion)
      AND c.data_type = 'uuid'
    GROUP BY c.table_name
  LOOP
    IF rec.defaulted IS NOT NULL THEN
      FOREACH target IN ARRAY rec.defaulted LOOP
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', rec.tbl, target);
      END LOOP;
    END IF;

    EXECUTE format('ALTER TABLE %I %s', rec.tbl, rec.conversions);

    IF rec.defaulted IS NOT NULL THEN
      FOREACH target IN ARRAY rec.defaulted LOOP
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I SET DEFAULT gen_random_uuid()::text', rec.tbl, target);
      END LOOP;
    END IF;

    FOREACH target IN ARRAY rec.columns LOOP
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(%I) BETWEEN 1 AND 200)',
        rec.tbl, rec.tbl || '_' || target || '_len', target);
    END LOOP;
  END LOOP;

  -- Step 5. Tenant scope, schema versioning, and the parent-side unique keys.
  FOREACH target IN ARRAY conversion LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT', target);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES trust_tenants(tenant_id)',
      target, target || '_tenant_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version >= 1)',
      target, target || '_schema_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', target);
    -- `row_version` on every table in the set. None of these six owns a domain `version` that doubles as a
    -- counter — `contract_versions_v2.version_number`, `contract_risk_assessments.version` and
    -- `agreement_intelligence_versions.version` are all revisions the row *is* — so the counter is separate
    -- and those revisions are immutable.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (row_version >= 1)', target, target || '_row_version_ck');

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) '
      'REFERENCES trust_workspaces(workspace_id)',
      target, target || '_workspace_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
      'REFERENCES trust_workspaces(tenant_id, workspace_id)',
      target, target || '_tenant_workspace_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', target, target || '_tenant_id_unique');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, workspace_id, id)',
      target, target || '_tenant_workspace_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
  END LOOP;

  -- Step 6. Trust-runtime policies, FORCE row-level security, and the runtime grants. The two converged
  -- tables get all of this too: not routed does not mean not protected, and a table with no engine is
  -- exactly the kind that gets forgotten.
  FOREACH target IN ARRAY conversion LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace()) '
      'WITH CHECK (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace())',
      target || '_trust_scope', target);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY conversion LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      IF target = ANY(append_only) THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I TO assurapay_app', target);
        EXECUTE format('REVOKE UPDATE ON %I FROM assurapay_app', target);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
      END IF;
    END LOOP;
  END IF;

  -- Step 7. The mutation boundary. Append-only for the two the engines only append, and for the two
  -- converged leaves — no engine writes those at all, so nothing may rewrite them either.
  FOREACH target IN ARRAY append_only || converged LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',
      target || '_append_only', target);
  END LOOP;

  FOREACH target IN ARRAY governed LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
  END LOOP;

  -- The deferred keys, carried across with both scopes.
  CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_v2_ws_number_unique
    ON contract_versions_v2 (tenant_id, workspace_id, contract_id, version_number);
  CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_v2_ws_hash_unique
    ON contract_versions_v2 (tenant_id, workspace_id, document_hash);
  -- The other two step 3 dropped, owed back scoped. Both are revision keys the engines compute by counting
  -- what already exists: `assess()` derives an assessment's version from the count for the contract version,
  -- and `propose()` derives an intelligence version's from the count for the contract. Two concurrent calls
  -- read the same count and write the same revision, so without these a contract carries two "version 2"s
  -- and neither is the successor of the other — a worse outcome than the cross-tenant collision that made
  -- the original keys unacceptable.
  CREATE UNIQUE INDEX IF NOT EXISTS contract_risk_assessments_ws_version_unique
    ON contract_risk_assessments (tenant_id, workspace_id, contract_version_id, version);
  CREATE UNIQUE INDEX IF NOT EXISTS agreement_intelligence_versions_ws_version_unique
    ON agreement_intelligence_versions (tenant_id, workspace_id, contract_id, version);
  -- `registerExecuted` keeps at most one ACTIVE version per contract, marking the prior one SUPERSEDED. It
  -- reads the set first, which two concurrent registrations both clear; this is what actually prevents the
  -- second, and an agreement with two live versions is an agreement with two sets of terms.
  CREATE UNIQUE INDEX IF NOT EXISTS contract_versions_v2_one_active_per_contract
    ON contract_versions_v2 (tenant_id, workspace_id, contract_id) WHERE status = 'ACTIVE';
  -- `publish()` supersedes every other PUBLISHED version for the contract before publishing this one, so at
  -- most one reading of an agreement is live at a time.
  CREATE UNIQUE INDEX IF NOT EXISTS agreement_intelligence_one_published_per_contract
    ON agreement_intelligence_versions (tenant_id, workspace_id, contract_id) WHERE status = 'PUBLISHED';
  -- One review per reviewer per finding. `review()` does not check, so without this a reviewer could record
  -- two contradictory decisions on the same finding and the evidence would not say which stood.
  CREATE UNIQUE INDEX IF NOT EXISTS analysis_reviews_one_per_reviewer_finding
    ON analysis_reviews (tenant_id, workspace_id, run_id, finding_id, reviewer_id);
END
$batch_i$;

-- Written out rather than looped: each immutable set is a different claim about what the aggregate is.

-- Only `status` moves. The document hash and the certificate are what make a version citable — `verify()`
-- compares a document against that hash — and `version_number` is the revision the row *is*.
CREATE TRIGGER contract_versions_v2_governed_transition
  BEFORE UPDATE OR DELETE ON contract_versions_v2
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'contract_id', 'version_number',
    'version_kind', 'document_reference', 'document_hash', 'execution_certificate_id', 'supersedes_id',
    'created_at', 'schema_version');

-- Only `status` moves. The dimensions, the score and the level are the assessment: an assessment whose
-- score could be rewritten after validation is a risk rating that can be lowered once it has been signed
-- off, and `analysis_run_id` is the evidence it was derived from.
CREATE TRIGGER contract_risk_assessments_governed_transition
  BEFORE UPDATE OR DELETE ON contract_risk_assessments
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'contract_id', 'contract_version_id',
    'analysis_run_id', 'version', 'dimensions', 'score', 'level', 'explanations', 'created_at',
    'schema_version');

-- Only `legal_hold` moves, which is the one thing `hold()` sets. The content hash and the storage reference
-- are what identify the document; a mutable storage reference would let the bytes behind a hold be swapped
-- for others.
CREATE TRIGGER contract_repository_documents_governed_transition
  BEFORE UPDATE OR DELETE ON contract_repository_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'contract_version_id',
    'storage_reference', 'content_hash', 'mime_type', 'classification', 'tags', 'ocr_text_reference',
    'created_at', 'schema_version');

-- `status` and `items` move — `review()` changes an item's review status in place while the version is a
-- draft. `content_hash` does not, and that is only sound because the engine now digests what was extracted
-- rather than the review statuses too: see this file's header. `version` is the revision the row is.
CREATE TRIGGER agreement_intelligence_versions_governed_transition
  BEFORE UPDATE OR DELETE ON agreement_intelligence_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'contract_id', 'contract_version_id',
    'version', 'created_by', 'created_at', 'content_hash', 'schema_version');

-- Three predicates, because PostgreSQL forbids a subquery inside a CHECK constraint and every rule below
-- is a statement about the elements of a `jsonb` array. A subquery is perfectly legal inside a function
-- body, and an IMMUTABLE function may be called from a CHECK — so the rule lives in a named, reusable
-- predicate rather than being abandoned as unenforceable.
--
-- Each begins with a CASE on `jsonb_typeof` rather than relying on `AND` to short-circuit. SQL does not
-- guarantee evaluation order for `AND`, and `jsonb_array_length` *raises* on a scalar, so a malformed value
-- would produce an internal error instead of a clean refusal naming the rule it broke.

CREATE OR REPLACE FUNCTION assurapay_entries_cite_sources(entries JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(entries) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(entries) AS entry
      WHERE jsonb_typeof(entry -> 'sourceReferences') <> 'array'
         OR jsonb_array_length(entry -> 'sourceReferences') = 0
    )
  END
$$;

COMMENT ON FUNCTION assurapay_entries_cite_sources(JSONB) IS
  'True when every element of the array carries a non-empty sourceReferences array. An uncited claim about a contract is an assertion with nothing behind it.';

CREATE OR REPLACE FUNCTION assurapay_findings_cite_sources(findings JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(findings) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(findings) AS finding
      WHERE finding ->> 'severity' <> 'INFO'
        AND (
          jsonb_typeof(finding -> 'sourceReferences') <> 'array'
          OR jsonb_array_length(finding -> 'sourceReferences') = 0
        )
    )
  END
$$;

COMMENT ON FUNCTION assurapay_findings_cite_sources(JSONB) IS
  'True when every finding above INFO cites a source. INFO is exempt deliberately: an informational note is an observation, while anything above it is a claim a reviewer has to be able to check.';

CREATE OR REPLACE FUNCTION assurapay_intelligence_items_reviewed(items JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(items) <> 'array' THEN false
    WHEN jsonb_array_length(items) = 0 THEN false
    ELSE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(items) AS item
          WHERE item ->> 'reviewStatus' = 'PENDING'
        )
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(items) AS item
          WHERE item ->> 'reviewStatus' = 'ACCEPTED'
        )
  END
$$;

COMMENT ON FUNCTION assurapay_intelligence_items_reviewed(JSONB) IS
  'True when no item awaits review and at least one was accepted. The human-in-the-loop rule for machine-extracted contract terms: it is what keeps an AI reading of an agreement from becoming the agreement''s terms unreviewed.';

DO $batch_i_invariants$
BEGIN
  -- Single-record rules the engines enforce and the schema did not. Each is checkable from one row — which
  -- for these aggregates includes their child collections, because those live inline as `jsonb`.

  -- The level is derived from the score on `assess()`'s own thresholds. A row where the two disagree is a
  -- risk banner that does not describe its own number, and the banner is what a reader acts on.
  ALTER TABLE contract_risk_assessments
    ADD CONSTRAINT contract_risk_assessments_level_follows_score
    CHECK (
      level = CASE
        WHEN score >= 80 THEN 'CRITICAL'
        WHEN score >= 60 THEN 'HIGH'
        WHEN score >= 30 THEN 'MODERATE'
        ELSE 'LOW'
      END
    );
  -- No constraint bounding `score` is added: `202608030003` already declared
  -- `CHECK (score BETWEEN 0 AND 100)`, which survives this migration — `score` is INTEGER, so the identity
  -- conversion never touched it, and step 3 drops unique keys only. A second CHECK with the same predicate
  -- under a different name is noise that outlives whoever added it, and the next reader has to prove the two
  -- agree before changing either. `wave6-batch-i-repository.postgres.test.ts` asserts the existing one fires.
  -- An assessment with no dimensions has measured nothing, and `assess()` divides by `max(1, count)` — so an
  -- empty set scores zero and shows a LOW banner that reads as a finding rather than an absence of one.
  ALTER TABLE contract_risk_assessments
    ADD CONSTRAINT contract_risk_assessments_scores_something
    CHECK (jsonb_typeof(dimensions) = 'object' AND dimensions <> '{}'::jsonb);
  -- Every explanation cites a source. `jsonb_typeof` first, because `jsonb_array_length` raises on a scalar
  -- rather than returning false, and a constraint that raises gives a puzzle instead of a diagnosis.
  ALTER TABLE contract_risk_assessments
    ADD CONSTRAINT contract_risk_assessments_explanations_cite_sources
    CHECK (assurapay_entries_cite_sources(explanations));

  -- A published intelligence version has been reviewed: nothing still PENDING, and something ACCEPTED.
  -- This is the human-in-the-loop rule for machine-extracted terms — the one that keeps an AI reading of an
  -- agreement from becoming the agreement's terms unreviewed — and it is checkable here because the items
  -- live in the row.
  ALTER TABLE agreement_intelligence_versions
    ADD CONSTRAINT agreement_intelligence_versions_published_is_reviewed
    CHECK (
      jsonb_typeof(items) = 'array'
      AND jsonb_array_length(items) > 0
      AND (status = 'DRAFT' OR assurapay_intelligence_items_reviewed(items))
    );
  -- Every item cites a source, without the INFO exemption findings get: these items become parties,
  -- milestones and payment triggers downstream, so an uncited one is an unverifiable term entering the
  -- settlement path.
  ALTER TABLE agreement_intelligence_versions
    ADD CONSTRAINT agreement_intelligence_versions_items_cite_sources
    CHECK (assurapay_entries_cite_sources(items));

  -- Every finding above INFO cites a source. INFO is exempt deliberately: an informational note is an
  -- observation, while anything above it is a claim a reviewer has to be able to check.
  ALTER TABLE contract_analysis_runs
    ADD CONSTRAINT contract_analysis_runs_findings_cite_sources
    CHECK (assurapay_findings_cite_sources(findings));
  -- A model-assisted run names the model, its version and the prompt version. For an AI-derived claim about
  -- a contract, being unable to say what produced it is the whole of its evidential value gone: the finding
  -- can be neither reproduced nor attributed.
  ALTER TABLE contract_analysis_runs
    ADD CONSTRAINT contract_analysis_runs_model_is_attributed
    CHECK (
      method NOT IN ('AI_ASSISTED', 'HYBRID')
      OR (model_id IS NOT NULL AND model_version IS NOT NULL AND prompt_version IS NOT NULL)
    );

  -- A version cannot supersede itself: `registerExecuted` marks the superseded version SUPERSEDED, so a
  -- self-reference would set the new version's own status and leave the chain pointing at nothing.
  ALTER TABLE contract_versions_v2
    ADD CONSTRAINT contract_versions_v2_supersedes_another
    CHECK (supersedes_id IS NULL OR supersedes_id <> id);

  -- The repository stores PDF and Word documents only, which is what `MIME_NOT_ALLOWED` means. A repository
  -- that will hold any bytes under any type is not a controlled one, and the classification beside it is
  -- what governs who may read them.
  ALTER TABLE contract_repository_documents
    ADD CONSTRAINT contract_repository_documents_mime_is_allowed
    CHECK (
      mime_type IN (
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    );
END
$batch_i_invariants$;

DO $batch_i_references$
BEGIN
  -- The closure, workspace-carrying throughout.

  ALTER TABLE contract_analysis_runs
    ADD CONSTRAINT contract_analysis_runs_version_fk
    FOREIGN KEY (tenant_id, workspace_id, contract_version_id)
    REFERENCES contract_versions_v2 (tenant_id, workspace_id, id);

  ALTER TABLE analysis_reviews
    ADD CONSTRAINT analysis_reviews_run_fk
    FOREIGN KEY (tenant_id, workspace_id, run_id)
    REFERENCES contract_analysis_runs (tenant_id, workspace_id, id);

  ALTER TABLE contract_risk_assessments
    ADD CONSTRAINT contract_risk_assessments_version_fk
    FOREIGN KEY (tenant_id, workspace_id, contract_version_id)
    REFERENCES contract_versions_v2 (tenant_id, workspace_id, id);
  -- The analysis the assessment was derived from.
  ALTER TABLE contract_risk_assessments
    ADD CONSTRAINT contract_risk_assessments_run_fk
    FOREIGN KEY (tenant_id, workspace_id, analysis_run_id)
    REFERENCES contract_analysis_runs (tenant_id, workspace_id, id);

  ALTER TABLE contract_repository_documents
    ADD CONSTRAINT contract_repository_documents_version_fk
    FOREIGN KEY (tenant_id, workspace_id, contract_version_id)
    REFERENCES contract_versions_v2 (tenant_id, workspace_id, id);

  ALTER TABLE agreement_intelligence_versions
    ADD CONSTRAINT agreement_intelligence_versions_version_fk
    FOREIGN KEY (tenant_id, workspace_id, contract_version_id)
    REFERENCES contract_versions_v2 (tenant_id, workspace_id, id);

  -- Self-referencing and nullable: the first version of a contract supersedes nothing. MATCH SIMPLE means
  -- the key is not checked when the column is NULL, which is the behaviour wanted.
  ALTER TABLE contract_versions_v2
    ADD CONSTRAINT contract_versions_v2_supersedes_fk
    FOREIGN KEY (tenant_id, workspace_id, supersedes_id)
    REFERENCES contract_versions_v2 (tenant_id, workspace_id, id);

  -- The two converged leaves. Their keys are the reason they are in this migration at all.
  ALTER TABLE agreement_intelligence_items
    ADD CONSTRAINT agreement_intelligence_items_version_fk
    FOREIGN KEY (tenant_id, workspace_id, intelligence_version_id)
    REFERENCES agreement_intelligence_versions (tenant_id, workspace_id, id);
  ALTER TABLE contract_analysis_findings
    ADD CONSTRAINT contract_analysis_findings_run_fk
    FOREIGN KEY (tenant_id, workspace_id, analysis_run_id)
    REFERENCES contract_analysis_runs (tenant_id, workspace_id, id);
END
$batch_i_references$;

COMMENT ON TABLE agreement_intelligence_versions IS
  'Canonical Engine 20 agreement intelligence version. A machine reading of an agreement, which becomes the agreement''s parties, milestones and payment triggers downstream — so a PUBLISHED row is constrained to contain no item still awaiting review and at least one accepted, and every item must cite a source. content_hash is immutable and digests what was extracted rather than the review statuses, which is what makes it evidence rather than a value that goes stale on the first review.';

COMMENT ON TABLE analysis_reviews IS
  'Canonical Engine 17 analysis review. Created by 202608110012: a reviewer''s decision on a finding had no table at all before it. Append-only, one decision per reviewer per finding, and a rationale is required — the row exists to show a finding was considered rather than clicked through.';

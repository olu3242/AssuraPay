-- Batch F closes the canonical chain.
--
-- The fifteen agreement-creation aggregates of canonical Engines 11-15 — agreement, template version,
-- document version, contract draft, contract comment, clause version, clause instance, clause
-- deviation, negotiation round, approval policy, approval request, approval decision, signature
-- package, signature callback, execution certificate.
--
-- The largest batch in `docs/persistence/DURABILITY_GAP_ANALYSIS.md`, and the one that finishes what
-- Batch E started: `agreements` is the eleventh and last link of `Contract → PerformanceBlueprint →
-- Milestone → DefinitionOfDonePackage → ExecutionWorkspace → CompletionCertificate →
-- PaymentEligibility → FinancialEntitlement → ReleaseRequest → PaymentInstruction →
-- ReconciliationRecord` to gain a relational home. The census the gap analysis opened at seven of
-- eleven reaches eleven of eleven here.
--
-- Until now all fifteen were refused by `PostgresTrustStore` with PERSISTENCE_COLLECTION_NOT_MAPPED, so
-- there is nothing to backfill — the same position Batches A-E each started from.
--
-- TWO OF THE FIFTEEN HAVE NO TABLE, WHICH IS NEW.
--
-- `contractComments` and `signatureCallbacks` are written by `ContractAuthoringEngine.comment` and
-- `DigitalExecutionEngine.callback`, and neither has ever had a relation among the ninety-eight the
-- migrations declare. Every batch so far converged tables that already existed. Step 6 creates these
-- two, TEXT-native from the first statement, so they never carry the UUID identity the other thirteen
-- have to be converted out of.
--
-- THE CLOSURE IS THE THIRTEEN, MEASURED NOT ASSUMED.
--
-- Computed against a live migrated instance. **No table outside the thirteen references any of them**,
-- and every outbound foreign key goes inside the thirteen or to `workspaces`, which convergence
-- replaces. All thirteen hold zero rows, re-verified below at apply time; the migration raises
-- WAVE6_BATCH_F_AUTHORITY_REFUSED naming the populated table and changes nothing.
--
-- FOUR COLUMNS ARE NOT THE SNAKE_CASE OF THEIR FIELD, AND THAT IS THE SCHEMA'S DOING.
--
-- `agreement_document_versions.version` is the domain's `number`. `agreement_drafts`'
-- `current_document_version_id` is `documentVersionId`. `clause_versions_v2.guidance_reference` is
-- `guidance`. `negotiation_rounds.round_number` is `number`. Nothing here renames a column — historical
-- schema is not rewritten — so `batch-f-repository.ts` carries the mapping, and the canonical schemas
-- are `.strict()` so a mapping that forgets one fails immediately rather than writing nulls.
--
-- WHAT THIS ENFORCES THAT NOTHING ENFORCED BEFORE
--
-- The thirteen carried **no CHECK constraint of any kind**. Not a status value set, not a positive
-- revision, not a digest shape. Measured, not inferred: `pg_constraint` holds seven UNIQUE constraints
-- and zero CHECK constraints across all thirteen.
--
-- 1. Tenancy and FORCE row-level security. All thirteen were scoped on `workspace_id UUID REFERENCES
--    workspaces(id)` — the deprecated compatibility table — with no tenant column, ENABLE row-level
--    security and no FORCE, so the boundary did not constrain the table owner.
--
-- 2. Every declared status value set, for fifteen aggregates. A status column that accepts any string
--    is a lifecycle with no states.
--
-- 3. The digest shape, on all eight `%_hash` columns. Every hash written by these engines comes from
--    one `createHash('sha256')...digest('hex')` helper or is copied from a column that did, so
--    `^[0-9a-f]{64}$` is a fact about the data rather than an aspiration. A digest is what makes a
--    document citable as *the* document that was approved; free text there makes the citation
--    unverifiable.
--
-- 4. **The document-hash chain, as foreign keys.** `DigitalExecutionEngine.create` refuses unless
--    `a.documentHash === d.contentHash` — the approval must be an approval of exactly the document
--    being signed. That is a two-row invariant, and Batch C's currency trick makes it structural:
--    `agreement_document_versions` gains `UNIQUE (tenant_id, id, content_hash)`, and both the approval
--    request and the signature package reference `(tenant_id, document_version_id, document_hash)`
--    against it. The execution certificate does the same against the package. A row cannot name one
--    document and carry another's digest — enforced by the database rather than by remembering to
--    compare.
--
--    This is the batch's most load-bearing addition, because it is the agreement-side half of
--    "every release is certified-work-backed": an execution certificate that could cite a document it
--    was not computed from is a contract whose execution cannot be proved.
--
-- 5. The pairing a clause instance's source implies. `insert` writes LIBRARY with a published clause
--    version and CUSTOM with a body and no version, never any other combination. A LIBRARY clause with
--    no citation claims a baseline it cannot name; a CUSTOM clause with one claims a baseline it
--    deliberately departed from. Both would make deviation analysis wrong.
--
-- 6. Positive revisions and non-negative counts, on nine columns. Every revision in this batch is
--    computed by counting existing rows, so there is no revision zero.
--
-- 7. Non-empty step and signer lists. A policy with no steps approves a request the moment it is
--    routed, because `completedSteps === steps.length` from the start. A package with no signers
--    completes immediately, because `every` over an empty list is true — and `issue` would then mint an
--    execution certificate for a document nobody signed.
--
-- 8. Mutation boundaries. See Step 10; two of the four existing blanket append-only triggers
--    contradict their engines.
--
-- WHAT THIS DELIBERATELY DOES NOT ENFORCE
--
-- Four cross-row rules of the form "the cited parent must *currently* be in state X" — an APPROVED
-- approval request, a PUBLISHED clause version, a PUBLISHED template version. A foreign key can carry a
-- value across tables, which is how the digest chain above works, but it cannot require a current
-- status: the parent's status changes after the child is written, and in the approval case
-- `invalidateOnChange` exists precisely to change it. Putting the status in the key would force it to be
-- updated in lockstep, which is a worse rule than the engine's.
--
-- And the mutual reference. `agreement_document_versions.draft_id` and
-- `agreement_drafts.current_document_version_id` name each other; `createDraft` appends the document
-- version before the draft exists, as two separate `append` calls, so the document-version side cannot
-- be a foreign key without being deferrable — and a deferred constraint only helps inside a transaction
-- the store is never told about. Recorded rather than approximated.
--
-- NO HISTORICAL MIGRATION IS MODIFIED. Forward-only, additive, and refusing rather than coercing.

DO $batch_f$
DECLARE
  -- The thirteen that already exist. `contract_comments` and `signature_callbacks` are created in
  -- Step 6 and are deliberately absent here: they have no UUID identity to converge and no policy to
  -- drop.
  closure CONSTANT TEXT[] := ARRAY[
    'agreements_v2', 'contract_template_versions', 'agreement_document_versions', 'agreement_drafts',
    'clause_versions_v2', 'clause_instances_v2', 'clause_deviations_v2', 'negotiation_rounds',
    'approval_policies_v2', 'agreement_approval_requests', 'agreement_approval_decisions',
    'signature_packages_v2', 'agreement_execution_certificates'
  ];
  target   TEXT;
  occupied TEXT[] := '{}';
  intruder TEXT[] := '{}';
  rows     BIGINT;
  rec      RECORD;
BEGIN
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
      'WAVE6_BATCH_F_AUTHORITY_REFUSED: % table(s) hold rows: %. This migration converts identity '
      'columns from UUID to TEXT, which is lossless only on an empty table. Nothing has been changed. '
      'Backfill and convert deliberately, then re-run.',
      array_length(occupied, 1), array_to_string(occupied, ', ');
  END IF;

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
      'WAVE6_BATCH_F_AUTHORITY_REFUSED: foreign key(s) from outside the closure reference it: %. '
      'Converting identity types would break them. Nothing has been changed.',
      array_to_string(intruder, ', ');
  END IF;

  -- Step 1. Policies first: PostgreSQL refuses to alter the type of a column a policy predicates on.
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

  -- Step 2. Every foreign key on the closure. All recreated in Step 8, tenant-composite.
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(closure)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.name);
  END LOOP;

  -- Step 3. Converge identity on TEXT — the trust runtime's representation throughout. Every UUID
  -- column, not only the keys: `created_by`, `owner_user_id`, `requester_id`, `approver_id`,
  -- `submitted_by` and `locked_by` are trust principals, and a UUID column cannot hold one.
  --
  -- All of a table's columns in ONE `ALTER TABLE`. Batch E learned this the hard way: a multi-column
  -- CHECK spanning two columns converted one statement at a time fails partway with
  -- `operator does not exist: text <> uuid`. These thirteen carry no CHECK constraints at all, so
  -- nothing would break today — but `agreement_document_versions.supersedes_id` and `id` are compared
  -- by Step 9's lineage constraint, and doing it the safe way costs nothing.
  FOR rec IN
    SELECT c.table_name AS tbl,
           string_agg(format('ALTER COLUMN %I TYPE TEXT USING %I::text', c.column_name, c.column_name),
                      ', ' ORDER BY c.column_name) AS conversions,
           array_agg(c.column_name ORDER BY c.column_name) AS columns,
           array_agg(c.column_name ORDER BY c.column_name)
             FILTER (WHERE c.column_default IS NOT NULL) AS defaulted
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(closure)
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

  -- Step 4. Tenant scope, concurrency, schema versioning, and the parent-side uniques.
  FOREACH target IN ARRAY closure LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT', target);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES trust_tenants(tenant_id)',
      target, target || '_tenant_fk');

    -- `row_version`, not `version`. Five of these tables own a domain `version` that is a revision
    -- number, and `agreement_drafts` owns one that advances on every edit — see this file's header and
    -- `batch-f-repository.ts`. Batch E generalised the shared trigger to be told which column carries
    -- concurrency; this batch passes the same marker.
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (row_version >= 1)', target, target || '_row_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1', target);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (schema_version >= 1)',
      target, target || '_schema_version_ck');
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      target);

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES trust_workspaces(workspace_id)',
      target, target || '_workspace_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
      'REFERENCES trust_workspaces(tenant_id, workspace_id)',
      target, target || '_tenant_workspace_fk');

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', target, target || '_tenant_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
  END LOOP;

  -- Step 5. The digest shape, on every `%_hash` column in the closure.
  --
  -- Written as a loop over the catalogue rather than a list of eight, so a table gaining a hash column
  -- later is covered without anyone remembering to add it. Eight columns match today:
  -- `content_hash` on the template and document versions, `body_hash` on the clause version and
  -- instance, `document_hash` on the approval request, the signature package and the certificate, and
  -- `canonical_hash` on the certificate.
  FOR rec IN
    SELECT c.table_name AS tbl, c.column_name AS col
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name = ANY(closure)
      AND c.column_name LIKE '%\_hash'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I ~ ''^[0-9a-f]{64}$'')',
      rec.tbl, rec.tbl || '_' || rec.col || '_digest_ck', rec.col);
  END LOOP;

  -- Step 6. Trust-runtime policies, FORCE, and the runtime grants.
  FOREACH target IN ARRAY closure LOOP
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

    -- FORCE, because ENABLE does not constrain the table owner. All thirteen carried ENABLE without it.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;

  -- No DELETE. An agreement that can be deleted is a contract that can be made never to have existed.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
    FOREACH target IN ARRAY closure LOOP
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = target
      );
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
    END LOOP;
  END IF;
END
$batch_f$;

-- Step 7. The two tables that never existed.
--
-- TEXT-native from the first statement, tenant-scoped from the first statement, and FORCE from the
-- first statement — so they never carry the UUID identity, the missing tenant column or the
-- owner-exempt row-level security that the other thirteen had to be converted out of. This is what a
-- table created after the trust foundation looks like.
CREATE TABLE IF NOT EXISTS contract_comments (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         TEXT NOT NULL REFERENCES trust_tenants(tenant_id),
  workspace_id      TEXT NOT NULL REFERENCES trust_workspaces(workspace_id),
  contract_id       TEXT NOT NULL,
  body              TEXT NOT NULL,
  -- The boundary between privileged internal discussion and what a counterparty may read.
  -- `comments(..., external = true)` returns only SHARED, so this is a governed value set and not a
  -- label: a typo that stored 'Internal' would leak the comment to the counterparty view.
  visibility        TEXT NOT NULL CHECK (visibility IN ('INTERNAL', 'SHARED')),
  author_id         TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version    INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contract_comments_body_present CHECK (length(btrim(body)) > 0),
  CONSTRAINT contract_comments_id_len CHECK (length(id) BETWEEN 1 AND 200),
  CONSTRAINT contract_comments_tenant_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES trust_workspaces (tenant_id, workspace_id),
  CONSTRAINT contract_comments_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS signature_callbacks (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         TEXT NOT NULL REFERENCES trust_tenants(tenant_id),
  workspace_id      TEXT NOT NULL REFERENCES trust_workspaces(workspace_id),
  -- The provider's own event identifier. Not constrained to a digest shape: the value is the
  -- provider's, and demanding hex would refuse a legitimate provider whose identifiers are not.
  event_id          TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version    INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signature_callbacks_event_id_present CHECK (length(btrim(event_id)) > 0),
  CONSTRAINT signature_callbacks_id_len CHECK (length(id) BETWEEN 1 AND 200),
  CONSTRAINT signature_callbacks_tenant_workspace_fk
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES trust_workspaces (tenant_id, workspace_id),
  CONSTRAINT signature_callbacks_tenant_id_unique UNIQUE (tenant_id, id),
  -- Replay protection, scoped to the workspace. This is the constraint behind a defect this batch fixed
  -- in the engine: `callback`'s replay check matched on `eventId` alone across every workspace, so a
  -- provider event identifier reused in another account read as a replay — and the replay path returns
  -- the package unchanged, silently dropping a real signature event. Per workspace, because a provider
  -- event identifier is unique within the account it was issued for and nowhere wider.
  CONSTRAINT signature_callbacks_event_unique UNIQUE (tenant_id, workspace_id, event_id)
);

DO $new_tables$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['contract_comments', 'signature_callbacks'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace()) '
      'WITH CHECK (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace())',
      target || '_trust_scope', target);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I TO assurapay_app', target);
    END IF;
  END LOOP;
END
$new_tables$;

-- Step 8. The agreement graph, restored tenant-composite — and the digest chain, built into it.
--
-- Foreign key checks run as the table owner and are not subject to row-level security, so only a
-- composite key stops a row in one tenant referencing a parent in another.
--
-- Three of these carry a *digest* as well as an identifier, which is the batch's central structural
-- addition. `DigitalExecutionEngine.create` refuses unless the approval's `documentHash` equals the
-- document version's `contentHash`; that comparison is now a foreign key, so no code path can produce a
-- row that names one document and carries another's digest.
DO $graph$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'agreements_v2'
  ) THEN RETURN; END IF;

  -- The parent-side keys the digest chain references. A composite foreign key needs a *declared* UNIQUE
  -- on exactly the columns it references, in some order.
  ALTER TABLE agreement_document_versions
    ADD CONSTRAINT agreement_document_versions_tenant_id_hash_unique
    UNIQUE (tenant_id, id, content_hash);

  ALTER TABLE signature_packages_v2
    ADD CONSTRAINT signature_packages_v2_tenant_id_hash_unique
    UNIQUE (tenant_id, id, document_hash);

  ALTER TABLE agreement_document_versions
    ADD CONSTRAINT agreement_document_versions_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  -- The document lineage. Nullable on the first version of a draft, and MATCH SIMPLE lets a NULL
  -- through — which is what makes "no predecessor" expressible without a sentinel.
  ALTER TABLE agreement_document_versions
    ADD CONSTRAINT agreement_document_versions_supersedes_fk
    FOREIGN KEY (tenant_id, supersedes_id) REFERENCES agreement_document_versions (tenant_id, id);

  ALTER TABLE agreement_drafts
    ADD CONSTRAINT agreement_drafts_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  ALTER TABLE agreement_drafts
    ADD CONSTRAINT agreement_drafts_template_version_fk
    FOREIGN KEY (tenant_id, template_version_id)
    REFERENCES contract_template_versions (tenant_id, id);

  ALTER TABLE agreement_drafts
    ADD CONSTRAINT agreement_drafts_document_version_fk
    FOREIGN KEY (tenant_id, current_document_version_id)
    REFERENCES agreement_document_versions (tenant_id, id);

  ALTER TABLE contract_comments
    ADD CONSTRAINT contract_comments_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  ALTER TABLE clause_instances_v2
    ADD CONSTRAINT clause_instances_v2_draft_fk
    FOREIGN KEY (tenant_id, draft_id) REFERENCES agreement_drafts (tenant_id, id);

  -- Nullable: absent exactly when the clause is custom, which Step 9 ties to the `source` value.
  ALTER TABLE clause_instances_v2
    ADD CONSTRAINT clause_instances_v2_clause_version_fk
    FOREIGN KEY (tenant_id, clause_version_id) REFERENCES clause_versions_v2 (tenant_id, id);

  ALTER TABLE clause_deviations_v2
    ADD CONSTRAINT clause_deviations_v2_instance_fk
    FOREIGN KEY (tenant_id, instance_id) REFERENCES clause_instances_v2 (tenant_id, id);

  ALTER TABLE clause_deviations_v2
    ADD CONSTRAINT clause_deviations_v2_baseline_fk
    FOREIGN KEY (tenant_id, baseline_version_id) REFERENCES clause_versions_v2 (tenant_id, id);

  ALTER TABLE negotiation_rounds
    ADD CONSTRAINT negotiation_rounds_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  ALTER TABLE negotiation_rounds
    ADD CONSTRAINT negotiation_rounds_document_version_fk
    FOREIGN KEY (tenant_id, document_version_id)
    REFERENCES agreement_document_versions (tenant_id, id);

  ALTER TABLE agreement_approval_requests
    ADD CONSTRAINT agreement_approval_requests_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  ALTER TABLE agreement_approval_requests
    ADD CONSTRAINT agreement_approval_requests_policy_fk
    FOREIGN KEY (tenant_id, policy_id) REFERENCES approval_policies_v2 (tenant_id, id);

  -- Digest-carrying. The request's `document_hash` must be the cited version's `content_hash`, which is
  -- what `invalidateOnChange` compares against — so it cannot be a copy that drifted.
  ALTER TABLE agreement_approval_requests
    ADD CONSTRAINT agreement_approval_requests_document_fk
    FOREIGN KEY (tenant_id, document_version_id, document_hash)
    REFERENCES agreement_document_versions (tenant_id, id, content_hash);

  ALTER TABLE agreement_approval_decisions
    ADD CONSTRAINT agreement_approval_decisions_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES agreement_approval_requests (tenant_id, id);

  ALTER TABLE signature_packages_v2
    ADD CONSTRAINT signature_packages_v2_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  ALTER TABLE signature_packages_v2
    ADD CONSTRAINT signature_packages_v2_approval_request_fk
    FOREIGN KEY (tenant_id, approval_request_id)
    REFERENCES agreement_approval_requests (tenant_id, id);

  -- Digest-carrying. The package signs exactly the document version it names.
  ALTER TABLE signature_packages_v2
    ADD CONSTRAINT signature_packages_v2_document_fk
    FOREIGN KEY (tenant_id, document_version_id, document_hash)
    REFERENCES agreement_document_versions (tenant_id, id, content_hash);

  ALTER TABLE agreement_execution_certificates
    ADD CONSTRAINT agreement_execution_certificates_contract_fk
    FOREIGN KEY (tenant_id, contract_id) REFERENCES agreements_v2 (tenant_id, id);

  -- Digest-carrying, and the end of the chain. The certificate certifies exactly the package's
  -- document, which is exactly the approved document version's.
  ALTER TABLE agreement_execution_certificates
    ADD CONSTRAINT agreement_execution_certificates_package_fk
    FOREIGN KEY (tenant_id, package_id, document_hash)
    REFERENCES signature_packages_v2 (tenant_id, id, document_hash);
END
$graph$;

-- Step 9. The value sets, bounds and pairings the thirteen carried none of.
DO $invariants$
DECLARE
  -- Every declared lifecycle, taken from the canonical types rather than from the columns — the columns
  -- had nothing to take. `contract_comments` and `signature_callbacks` carry their own constraints in
  -- Step 7 and have no status.
  states CONSTANT JSONB := $spec$
  {
    "agreements_v2": ["DRAFT","NEGOTIATION","AWAITING_APPROVAL","APPROVED","AWAITING_SIGNATURE","PARTIALLY_SIGNED","EXECUTED"],
    "contract_template_versions": ["DRAFT","PUBLISHED","SUPERSEDED"],
    "agreement_document_versions": ["DRAFT","NEGOTIATED","APPROVED","EXECUTED"],
    "agreement_drafts": ["WORKING","LOCKED","SUBMITTED","RETURNED","SUPERSEDED"],
    "clause_versions_v2": ["DRAFT","PUBLISHED","RETIRED","SUPERSEDED"],
    "clause_deviations_v2": ["PENDING","APPROVED","REJECTED"],
    "negotiation_rounds": ["SUBMITTED","WITHDRAWN","ACCEPTED"],
    "approval_policies_v2": ["DRAFT","PUBLISHED"],
    "agreement_approval_requests": ["PENDING","APPROVED","REJECTED","INVALIDATED"],
    "signature_packages_v2": ["DRAFT","SENT","PARTIALLY_SIGNED","COMPLETED","DECLINED","VOID"],
    "agreement_execution_certificates": ["VALID","REVOKED"]
  }
  $spec$::JSONB;

  -- Revisions are counted from existing rows, so there is no revision zero. Step counts start at zero,
  -- so they are bounded differently — a distinction the schema keeps as `revisionNumber` and `count`.
  positive CONSTANT JSONB := $spec$
  {
    "agreements_v2": ["version"],
    "contract_template_versions": ["version"],
    "agreement_document_versions": ["version"],
    "agreement_drafts": ["version"],
    "clause_versions_v2": ["version"],
    "approval_policies_v2": ["version"],
    "negotiation_rounds": ["round_number"]
  }
  $spec$::JSONB;

  entry   RECORD;
  target  TEXT;
  column_ TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'agreements_v2'
  ) THEN RETURN; END IF;

  FOR entry IN SELECT key AS tbl, value AS allowed FROM jsonb_each(states) LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (status IN (%s))',
      entry.tbl, entry.tbl || '_status_ck',
      (SELECT string_agg(format('%L', value), ', ' ORDER BY ordinality)
         FROM jsonb_array_elements_text(entry.allowed) WITH ORDINALITY AS s(value, ordinality)));
  END LOOP;

  FOR entry IN SELECT key AS tbl, value AS cols FROM jsonb_each(positive) LOOP
    FOR column_ IN SELECT value FROM jsonb_array_elements_text(entry.cols) LOOP
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I >= 1)',
        entry.tbl, entry.tbl || '_' || column_ || '_positive_ck', column_);
    END LOOP;
  END LOOP;

  -- Counts, which legitimately start at zero. A request has completed no steps when it is routed, and
  -- `decide` writes the request's current count as the decision's step index.
  ALTER TABLE agreement_approval_requests
    ADD CONSTRAINT agreement_approval_requests_completed_steps_ck CHECK (completed_steps >= 0);
  ALTER TABLE agreement_approval_decisions
    ADD CONSTRAINT agreement_approval_decisions_step_ck CHECK (step >= 0);

  -- The risk grades, which are an input to review routing rather than a label. `deviate` copies the
  -- baseline clause version's grade, so a deviation cannot understate the risk of the clause it departs
  -- from — and neither column could hold a value outside the set even before that copy.
  ALTER TABLE clause_versions_v2
    ADD CONSTRAINT clause_versions_v2_risk_ck CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
  ALTER TABLE clause_deviations_v2
    ADD CONSTRAINT clause_deviations_v2_risk_ck CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));

  ALTER TABLE agreement_approval_decisions
    ADD CONSTRAINT agreement_approval_decisions_decision_ck CHECK (decision IN ('APPROVE', 'REJECT'));

  -- The pairing `insert` produces and no other. A LIBRARY clause with no citation claims a published
  -- baseline it cannot name; a CUSTOM clause with one claims a baseline it deliberately departed from.
  ALTER TABLE clause_instances_v2
    ADD CONSTRAINT clause_instances_v2_source_ck CHECK (source IN ('LIBRARY', 'CUSTOM'));
  ALTER TABLE clause_instances_v2
    ADD CONSTRAINT clause_instances_v2_citation_ck
    CHECK ((source = 'LIBRARY') = (clause_version_id IS NOT NULL));

  -- A locked draft names its locker. One-way on purpose: `lock` never clears `lockedBy`, so a submitted
  -- draft still records who locked it, and requiring the reverse would refuse that legitimate row.
  ALTER TABLE agreement_drafts
    ADD CONSTRAINT agreement_drafts_locked_by_ck
    CHECK (status <> 'LOCKED' OR locked_by IS NOT NULL);

  -- A document version does not supersede itself. A self-reference here is a lineage that cannot be
  -- walked back to a first version, so `revise`'s history becomes a loop.
  ALTER TABLE agreement_document_versions
    ADD CONSTRAINT agreement_document_versions_lineage_ck
    CHECK (supersedes_id IS NULL OR supersedes_id <> id);

  -- Non-empty lists, both of which have the same failure mode: an aggregate function over an empty set
  -- reporting satisfaction. `completedSteps === steps.length` holds from the start for an empty policy,
  -- and `signers.every(...)` is true of no signers — which would issue an execution certificate for a
  -- document nobody signed.
  ALTER TABLE approval_policies_v2
    ADD CONSTRAINT approval_policies_v2_steps_ck CHECK (jsonb_array_length(steps) >= 1);
  ALTER TABLE signature_packages_v2
    ADD CONSTRAINT signature_packages_v2_signers_ck CHECK (jsonb_array_length(signers) >= 1);

  -- Text that must carry content. `requiredText` in the canonical schemas; the same rule in the column,
  -- because a store is not the only thing that can write to a table.
  ALTER TABLE agreements_v2
    ADD CONSTRAINT agreements_v2_contract_number_present CHECK (length(btrim(contract_number)) > 0);
  ALTER TABLE agreements_v2
    ADD CONSTRAINT agreements_v2_title_present CHECK (length(btrim(title)) > 0);
  ALTER TABLE clause_versions_v2
    ADD CONSTRAINT clause_versions_v2_guidance_present
    CHECK (length(btrim(guidance_reference)) > 0);
  ALTER TABLE clause_deviations_v2
    ADD CONSTRAINT clause_deviations_v2_summary_present CHECK (length(btrim(summary)) > 0);
  ALTER TABLE agreement_document_versions
    ADD CONSTRAINT agreement_document_versions_reference_present
    CHECK (length(btrim(content_reference)) > 0);
END
$invariants$;

-- Step 10. Mutation boundaries.
--
-- Four of the thirteen carry a blanket `<table>_append_only` trigger from `202608030002`. **Two of them
-- contradict their engines**: `NegotiationEngine.withdraw` and `accept` transition a round, and
-- `DigitalExecutionEngine.revoke` transitions a certificate, so the blanket trigger would have refused
-- every one of those the moment the collections were routed. Sixth and seventh instance of this defect,
-- after five tables in `202608100001`, three in `202608100002`, one in `202608110002` and four in
-- `202608110004`.
--
-- The other two keep theirs. `agreement_document_versions` and `agreement_approval_decisions` are
-- transitioned by nothing, and removing a constraint that currently holds — to accommodate a lifecycle
-- nobody has implemented — is the same speculation as adding one, pointed the other way.
--
-- WHICH STATES ARE TERMINAL, AND WHY SO FEW.
--
-- A terminal state is a claim that no transition leaves it. Checked against the engines, that claim is
-- provable for exactly two tables in this batch, and the reason is worth recording: **the
-- agreement-creation engines guard their transitions far less than the settlement engines do.**
-- `retire` accepts a clause in any state, `approve` accepts a deviation in any state,
-- `invalidateOnChange` accepts a request in any state, and `revoke` accepts a certificate in any state —
-- so each of those can be re-applied to a row already in the state it writes. Declaring those states
-- terminal would refuse calls the engines currently make and succeed at.
--
-- Two are provable. `publishTemplate` requires DRAFT and only ever supersedes a PUBLISHED row, so
-- nothing updates a SUPERSEDED template version. And `callback` now refuses a closed package and `send`
-- requires DRAFT, so nothing updates a COMPLETED or DECLINED signature package — a guard this batch
-- added, because without it a stray provider event could move a DECLINED package to COMPLETED.
--
-- VOID is not listed, and neither is any state in `BATCH_F_UNREACHED_STATES`. A state nothing enters is
-- a state there is no evidence about, and inventing a refusal for one is how a future implementer
-- inherits a constraint nobody chose.
--
-- The unguarded transitions are recorded in `docs/persistence/POST_WAVE_5_FOLLOWUPS.md` rather than
-- fixed here: tightening five engines' status guards is a domain change, not a persistence one.
DO $transitions$
DECLARE
  -- Ten of the fifteen. Each `immutable` list omits `status`, `row_version` and whichever other columns
  -- the engines legitimately rewrite — and includes the domain `version` wherever it is a revision.
  --
  -- `agreement_drafts` is the exception: `version` is mutable there, because every one of
  -- `setVariables`, `lock`, `submit` and `revise` writes `d.version + 1`.
  governed CONSTANT JSONB := $spec$
  [
    { "table": "agreements_v2", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","contract_number","title","contract_type","owner_user_id","created_at","version","schema_version"] },
    { "table": "contract_template_versions", "terminal": ["SUPERSEDED"],
      "immutable": ["id","tenant_id","workspace_id","template_key","version","variable_schema","content_hash","created_by","created_at","schema_version"] },
    { "table": "agreement_drafts", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","contract_id","template_version_id","created_by","created_at","schema_version"] },
    { "table": "clause_versions_v2", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","clause_key","version","body_hash","risk","guidance_reference","created_at","schema_version"] },
    { "table": "clause_deviations_v2", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","instance_id","baseline_version_id","risk","summary","created_at","schema_version"] },
    { "table": "negotiation_rounds", "terminal": ["WITHDRAWN","ACCEPTED"],
      "immutable": ["id","tenant_id","workspace_id","contract_id","round_number","submitted_by","document_version_id","mandatory_open_items","created_at","schema_version"] },
    { "table": "approval_policies_v2", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","version","steps","created_at","schema_version"] },
    { "table": "agreement_approval_requests", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","contract_id","document_version_id","document_hash","policy_id","requester_id","created_at","schema_version"] },
    { "table": "signature_packages_v2", "terminal": ["COMPLETED","DECLINED"],
      "immutable": ["id","tenant_id","workspace_id","contract_id","approval_request_id","document_version_id","document_hash","provider_key","created_at","schema_version"] },
    { "table": "agreement_execution_certificates", "terminal": [],
      "immutable": ["id","tenant_id","workspace_id","package_id","contract_id","document_hash","canonical_hash","issued_at","schema_version"] }
  ]
  $spec$::JSONB;

  -- Five. Two because a blanket trigger already holds and nothing transitions them; three because they
  -- have no status column, so there is nothing to transition. `contract_comments` and
  -- `signature_callbacks` gain their trigger here, since Step 7 created them.
  append_only CONSTANT TEXT[] := ARRAY[
    'agreement_document_versions', 'agreement_approval_decisions', 'clause_instances_v2',
    'contract_comments', 'signature_callbacks'
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

    -- Replaced, not supplemented. Leaving a blanket trigger alongside the governed one would refuse
    -- every transition and make the new rules unreachable.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_append_only', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_governed_transition', target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_terminal_state', target);

    -- `concurrency=row_version` first, then the immutable columns. Batch E's Step 0 made that marker
    -- meaningful; without it the trigger would check a `version` column that means a revision here.
    SELECT format('%L', 'concurrency=row_version') || ', ' ||
           string_agg(format('%L', value), ', ' ORDER BY position)
      INTO arguments
      FROM jsonb_array_elements_text(spec -> 'immutable')
             WITH ORDINALITY AS columns(value, position);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW '
      'EXECUTE FUNCTION enforce_governed_aggregate_transition(%s)',
      target || '_governed_transition', target, arguments);

    -- Only where a terminal state is provable. An empty list means no trigger rather than a trigger
    -- with nothing to check: a terminal-state trigger over zero states never fires, and creating one
    -- would read as a boundary that is not there.
    IF jsonb_array_length(spec -> 'terminal') > 0 THEN
      SELECT format('%L', 'status') || ', ' ||
             string_agg(format('%L', value), ', ' ORDER BY position)
        INTO arguments
        FROM jsonb_array_elements_text(spec -> 'terminal')
               WITH ORDINALITY AS s(value, position);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION enforce_terminal_aggregate_state(%s)',
        target || '_terminal_state', target, arguments);
    END IF;
  END LOOP;

  FOREACH target IN ARRAY append_only LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = target
    );
    -- The three that had none get one; the two that had one keep exactly what they had.
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()
        AND c.relname = target AND t.tgname = target || '_append_only'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW '
        'EXECUTE FUNCTION prevent_append_only_mutation()',
        target || '_append_only', target);
    END IF;
  END LOOP;

  -- Assert the boundary is actually in place on all fifteen rather than leaving it implied. A trigger
  -- that failed to be created is a table with no mutation boundary and no sign of one.
  FOR spec IN SELECT value FROM jsonb_array_elements(governed) AS entries(value) LOOP
    target := spec ->> 'table';
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = current_schema()
        AND c.relname = target AND t.tgname = target || '_governed_transition'
    ) THEN
      missing := missing || format('%s(governed)', target);
    END IF;
  END LOOP;

  FOREACH target IN ARRAY append_only LOOP
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

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION
      'WAVE6_BATCH_F_AUTHORITY_REFUSED: expected mutation boundary absent on %. Nothing has been '
      'changed.',
      array_to_string(missing, ', ');
  END IF;
END
$transitions$;

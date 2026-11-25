-- The settlement chain names only milestones and contracts that exist.
--
-- ## What was wrong
--
-- The planning side of the schema constrains its milestone references and the settlement side did
-- not. `dod_packages`, `dependencies`, `success_metrics`, `performance_baselines` and
-- `payment_trigger_rules` all carry a composite foreign key to `blueprint_milestones`. Meanwhile
-- `invoices`, `financial_entitlements`, `funding_commitments`, `payment_eligibilities`,
-- `release_requests`, `completion_certificates`, `execution_workspaces` and
-- `final_settlement_accounts` carried a NOT NULL `milestone_id` with **no foreign key at all** — and
-- `performance_blueprints.contract_id` had none either, so the chain's first link was unenforced.
--
-- That is the inversion you would least choose. A milestone reference on a definition-of-done package
-- is a planning convenience; a milestone reference on an invoice is the obligation the money is paid
-- against. An invoice could name a milestone that had never existed, or one deleted from another
-- workspace's blueprint, and every constraint the schema had was satisfied. `payment_eligibilities`
-- could cite a completion certificate that was not there — the attestation that the work was done.
--
-- This matters beyond tidiness because of what the platform claims to be able to answer: where every
-- committed naira went, and *what contractual obligation justified it*. An unenforced `milestone_id`
-- means that question has no reliable answer at the database level — the join can simply come back
-- empty, and nothing distinguishes "no obligation was recorded" from "the obligation was deleted".
--
-- Found by `apps/web/lib/record-reads.postgres.test.ts`, which reads `pg_constraint` and refuses to
-- let the record page draw a relationship the database does not enforce. The same guard rejected two
-- links that were wrong in the other direction — a dispute attaches to a release request, and a final
-- settlement account to a milestone — and those were corrected in the declaration rather than here.
--
-- ## Why foreign keys rather than a trigger
--
-- This is referential integrity, which is what a foreign key is for. `202608110023` and `…0024` use
-- triggers because they enforce *sums* across sibling rows, which no key can express; `…0025` uses
-- composite keys because it binds a release to one invoice's parents. This migration is the plainest
-- case of the three and takes the plainest mechanism.
--
-- Each key carries `(tenant_id, workspace_id, …)` rather than the bare id, matching every other key
-- in this schema. That is not decoration: it makes a cross-tenant or cross-workspace reference
-- unrepresentable rather than merely forbidden by row-level security, so a bug in scope handling
-- cannot produce an invoice in one workspace pointing at a milestone in another.
--
-- ## Safe on populated tables
--
-- Every key is added NOT VALID. The rule binds every later write and no existing row is checked,
-- rejected or rewritten — settled financial history is not edited to make a migration pass, which is
-- the same decision `…0024` and `…0025` took and the reason they could be applied to live data. A
-- pre-existing breach therefore survives this migration and is reported by the reconciliation report
-- rather than silently corrected. Validating these keys later, once any breach is resolved, is a
-- separate operational step: `ALTER TABLE … VALIDATE CONSTRAINT …` takes only a row-level lock.
--
-- The columns are all NOT NULL, verified against the migrated schema before this was written, so
-- there is no MATCH SIMPLE escape here: a NULL component cannot quietly satisfy any of these keys.

-- `payment_eligibilities.completion_certificate_id` needs its parent to be uniquely addressable by
-- the same triple the key uses. `id` is already the primary key, so this index can never conflict
-- with existing data; it exists because PostgreSQL requires the referenced columns to be unique, and
-- every other table in the chain already carries the equivalent.
CREATE UNIQUE INDEX IF NOT EXISTS completion_certificates_ws_id_key
  ON completion_certificates (tenant_id, workspace_id, id);

DO $$
DECLARE
  link RECORD;
BEGIN
  FOR link IN
    SELECT *
      FROM (VALUES
        -- The chain's first link: a blueprint plans one contract.
        ('performance_blueprints', 'contract_id',             'agreements_v2',        'performance_blueprints_contract_fk'),
        -- Execution happens against a blueprint and one of its milestones.
        ('execution_workspaces',   'blueprint_id',            'performance_blueprints', 'execution_workspaces_blueprint_fk'),
        ('execution_workspaces',   'milestone_id',            'blueprint_milestones', 'execution_workspaces_milestone_fk'),
        -- The attestation that a milestone's work is done.
        ('completion_certificates','milestone_id',            'blueprint_milestones', 'completion_certificates_milestone_fk'),
        -- Eligibility is assessed for a milestone, against a certificate.
        ('payment_eligibilities',  'milestone_id',            'blueprint_milestones', 'payment_eligibilities_milestone_fk'),
        ('payment_eligibilities',  'completion_certificate_id','completion_certificates', 'payment_eligibilities_certificate_fk'),
        -- Everything downstream that names the obligation money is paid against.
        ('financial_entitlements', 'milestone_id',            'blueprint_milestones', 'financial_entitlements_milestone_fk'),
        ('funding_commitments',    'milestone_id',            'blueprint_milestones', 'funding_commitments_milestone_fk'),
        ('invoices',               'milestone_id',            'blueprint_milestones', 'invoices_milestone_fk'),
        ('release_requests',       'milestone_id',            'blueprint_milestones', 'release_requests_milestone_fk'),
        ('final_settlement_accounts','milestone_id',          'blueprint_milestones', 'final_settlement_accounts_milestone_fk')
      ) AS t(child_table, child_column, parent_table, constraint_name)
  LOOP
    -- Idempotent by constraint name, so re-running the migration is a no-op rather than an error.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = link.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id, %I) '
        || 'REFERENCES %I (tenant_id, workspace_id, id) NOT VALID',
        link.child_table, link.constraint_name, link.child_column, link.parent_table
      );
    END IF;
  END LOOP;
END $$;

-- A probe that proves each key was created as intended, before this transaction commits.
--
-- Written because a NOT VALID constraint is easy to add and easy to get wrong in a way nothing
-- notices: name the wrong column, reference the wrong table, or have the `IF NOT EXISTS` guard match
-- an unrelated constraint that already held the name, and the migration still succeeds while
-- enforcing nothing of what it claims. So the migration checks its own work rather than asserting it
-- in prose.
--
-- What this proves and what it does not, stated plainly. It proves that eleven foreign keys now exist
-- on the intended tables, over the intended columns, pointing at the intended parents. It does not
-- re-prove that PostgreSQL enforces foreign keys — that is the engine's behaviour, not this schema's,
-- and a probe pretending otherwise would be theatre. The first attempt here did try to insert an
-- invoice naming a milestone that does not exist; row-level security refused the row before any key
-- could, which is the database behaving correctly and the probe testing nothing. Rather than grant the
-- migration a scope and invent tenancy rows to write through, the behavioural half is left where it
-- belongs: `apps/web/lib/record-reads.postgres.test.ts` reads these keys back out of `pg_constraint`
-- after every migration, so a key that disappears or changes shape fails the build.
DO $$
DECLARE
  expected RECORD;
  found INTEGER;
BEGIN
  FOR expected IN
    SELECT *
      FROM (VALUES
        ('performance_blueprints_contract_fk',        'performance_blueprints',    'contract_id',              'agreements_v2'),
        ('execution_workspaces_blueprint_fk',         'execution_workspaces',      'blueprint_id',             'performance_blueprints'),
        ('execution_workspaces_milestone_fk',         'execution_workspaces',      'milestone_id',             'blueprint_milestones'),
        ('completion_certificates_milestone_fk',      'completion_certificates',   'milestone_id',             'blueprint_milestones'),
        ('payment_eligibilities_milestone_fk',        'payment_eligibilities',     'milestone_id',             'blueprint_milestones'),
        ('payment_eligibilities_certificate_fk',      'payment_eligibilities',     'completion_certificate_id','completion_certificates'),
        ('financial_entitlements_milestone_fk',       'financial_entitlements',    'milestone_id',             'blueprint_milestones'),
        ('funding_commitments_milestone_fk',          'funding_commitments',       'milestone_id',             'blueprint_milestones'),
        ('invoices_milestone_fk',                     'invoices',                  'milestone_id',             'blueprint_milestones'),
        ('release_requests_milestone_fk',             'release_requests',          'milestone_id',             'blueprint_milestones'),
        ('final_settlement_accounts_milestone_fk',    'final_settlement_accounts', 'milestone_id',             'blueprint_milestones')
      ) AS t(constraint_name, child_table, child_column, parent_table)
  LOOP
    SELECT count(*) INTO found
      FROM pg_constraint c
      JOIN pg_class child  ON child.oid  = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
     WHERE c.conname = expected.constraint_name
       AND c.contype = 'f'
       AND child.relname  = expected.child_table
       AND parent.relname = expected.parent_table
       -- The referencing column must actually be in the key. Without this the probe would pass for a
       -- constraint that carried only tenancy columns and related nothing.
       AND expected.child_column = ANY (
             SELECT a.attname
               FROM unnest(c.conkey) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           );

    IF found <> 1 THEN
      RAISE EXCEPTION
        'SETTLEMENT_CHAIN_REFERENCE_NOT_ENFORCED: % should constrain %.% to % but does not exist in that shape',
        expected.constraint_name, expected.child_table, expected.child_column, expected.parent_table;
    END IF;
  END LOOP;
END $$;

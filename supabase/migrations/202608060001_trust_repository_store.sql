-- Durable backing for the TrustPersistence contract.
--
-- The 20 migrations preceding this one describe a per-engine relational model that
-- had never been executed. They apply cleanly, but their column sets do not match
-- the records the engines actually write: user_identities requires
-- tenant_neutral_subject_id and primary_authentication_method, which no engine
-- sets, and audit_records types aggregate_id as UUID while PermissionService audits
-- a permission key there. Retrofitting them is a schema-reconciliation job with its
-- own risk; this migration gives the repository contract a schema shaped like the
-- contract, and leaves the historical tables in place and unmodified.
--
-- Entities whose invariants CLAUDE.md depends on get their own tables with real
-- foreign keys and real uniqueness: tenants, workspaces, memberships, grants,
-- audit, outbox, idempotency, bootstrap. The remaining trust collections share a
-- governed document table that still carries every dimension the platform filters,
-- scopes, or governs on as an explicit column — the payload holds only what nothing
-- queries, and carries a digest so a silent edit is detectable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- migration ledger

-- Applied migrations, by id and checksum. The checksum is what makes an edited
-- migration detectable: re-running a changed file against a database that already
-- applied it would otherwise diverge silently from every other environment.
-- IF NOT EXISTS because the runner must bootstrap this table before it can record
-- anything, including this migration. The definition is stated here so the schema is
-- readable as one document, but the runner owns its creation.
CREATE TABLE IF NOT EXISTS trust_migration_ledger (
  migration_id      TEXT PRIMARY KEY,
  checksum          TEXT NOT NULL,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by        TEXT NOT NULL,
  execution_ms      INTEGER NOT NULL CHECK (execution_ms >= 0),
  ordinal           INTEGER NOT NULL
);

COMMENT ON TABLE trust_migration_ledger IS
  'Applied migration ids with checksums. Rejects a modified applied migration rather than reapplying it.';

-- ---------------------------------------------------------------- tenancy

CREATE TABLE trust_tenants (
  tenant_id   TEXT PRIMARY KEY CHECK (length(tenant_id) BETWEEN 1 AND 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A workspace always belongs to a tenant. The foreign key is what makes an
-- accidental cross-tenant relationship unstorable rather than merely discouraged.
CREATE TABLE trust_workspaces (
  workspace_id  TEXT PRIMARY KEY CHECK (length(workspace_id) BETWEEN 1 AND 200),
  tenant_id     TEXT NOT NULL REFERENCES trust_tenants(tenant_id),
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  payload       JSONB NOT NULL DEFAULT '{}',
  payload_digest TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trust_workspaces_tenant_idx ON trust_workspaces(tenant_id);

-- ---------------------------------------------------------------- memberships

CREATE TABLE trust_memberships (
  membership_id  TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES trust_workspaces(workspace_id),
  user_id        TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  status         TEXT NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  role           TEXT,
  effective_from TIMESTAMPTZ,
  effective_to   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  payload        JSONB NOT NULL DEFAULT '{}',
  payload_digest TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A revoked membership must say when. Enforced rather than trusted, because
  -- authorization reads status and a lifecycle that disagrees with its timestamps
  -- is how a revoked principal keeps acting.
  CONSTRAINT trust_memberships_revocation_consistent
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CONSTRAINT trust_memberships_period_ordered
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);

-- One active membership per principal per workspace. Two would make
-- "is this caller a member" depend on which row a query happened to read first.
CREATE UNIQUE INDEX trust_memberships_active_unique
  ON trust_memberships(workspace_id, user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX trust_memberships_user_idx ON trust_memberships(user_id, status);

-- ---------------------------------------------------------------- permission grants

CREATE TABLE trust_permission_grants (
  grant_id       TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES trust_workspaces(workspace_id),
  user_id        TEXT NOT NULL,
  permission_key TEXT NOT NULL CHECK (length(permission_key) BETWEEN 1 AND 200),
  effect         TEXT NOT NULL CHECK (effect IN ('ALLOW', 'DENY', 'CONDITIONAL')),
  scope_type     TEXT NOT NULL,
  scope_id       TEXT,
  source_type    TEXT NOT NULL CHECK (source_type IN ('ROLE', 'PERMISSION_SET', 'DELEGATION')),
  source_id      TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  payload        JSONB NOT NULL DEFAULT '{}',
  payload_digest TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trust_permission_grants_period_ordered
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Deduplicated on the whole grant identity rather than on the key alone: the same
-- permission may legitimately be granted at two different scopes, from a role and
-- from a delegation, but the identical grant twice is a double-write.
CREATE UNIQUE INDEX trust_permission_grants_live_unique
  ON trust_permission_grants(
    workspace_id, user_id, permission_key, effect, scope_type,
    coalesce(scope_id, ''), source_type, source_id
  )
  WHERE revoked_at IS NULL;

CREATE INDEX trust_permission_grants_evaluation_idx
  ON trust_permission_grants(workspace_id, user_id, permission_key)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- bootstrap

-- The founding act, once per workspace. A preceding "are there any grants" read
-- cannot make that true under concurrency; a primary key can.
CREATE TABLE trust_bootstrap_state (
  workspace_id   TEXT PRIMARY KEY REFERENCES trust_workspaces(workspace_id),
  founder_user_id TEXT NOT NULL,
  role           TEXT NOT NULL,
  grant_count    INTEGER NOT NULL CHECK (grant_count > 0),
  bootstrapped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT NOT NULL
);

-- ---------------------------------------------------------------- audit chain

CREATE TABLE trust_audit_records (
  audit_id       TEXT PRIMARY KEY,
  chain_position BIGINT NOT NULL,
  tenant_id      TEXT,
  workspace_id   TEXT,
  actor_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  -- TEXT, not UUID: the platform audits permission keys, workspace ids and session
  -- ids through this column. Typing it UUID is what would make
  -- PermissionService.requirePermission fail to record its own denial.
  aggregate_id   TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}',
  previous_hash  TEXT,
  integrity_hash TEXT NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trust_audit_records_chain_unique UNIQUE (chain_position),
  -- Position 1 opens the chain and has no predecessor; every later record has one.
  CONSTRAINT trust_audit_records_genesis
    CHECK ((chain_position = 1) = (previous_hash IS NULL)),
  CONSTRAINT trust_audit_records_position_positive CHECK (chain_position >= 1)
);

CREATE INDEX trust_audit_records_scope_idx
  ON trust_audit_records(workspace_id, created_at);

CREATE INDEX trust_audit_records_aggregate_idx
  ON trust_audit_records(aggregate_type, aggregate_id);

-- History is append-only per CLAUDE.md constraint 3. Enforced in the database, so a
-- direct SQL edit is refused rather than merely discouraged by code review.
CREATE OR REPLACE FUNCTION trust_reject_history_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUST_HISTORY_IS_APPEND_ONLY: % on %', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER trust_audit_records_append_only
  BEFORE UPDATE OR DELETE ON trust_audit_records
  FOR EACH ROW EXECUTE FUNCTION trust_reject_history_mutation();

-- ---------------------------------------------------------------- outbox

CREATE TABLE trust_outbox_events (
  event_id       TEXT PRIMARY KEY,
  tenant_id      TEXT,
  workspace_id   TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  event_version  INTEGER NOT NULL CHECK (event_version >= 1),
  payload        JSONB NOT NULL,
  correlation_id TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);

-- The drain query. Partial so it stays small as published history accumulates.
CREATE INDEX trust_outbox_unpublished_idx
  ON trust_outbox_events(occurred_at)
  WHERE published_at IS NULL;

-- ---------------------------------------------------------------- idempotency

CREATE TABLE trust_idempotency_keys (
  scope          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  workspace_id   TEXT,
  result_digest  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key)
);

-- ---------------------------------------------------------------- governed documents

-- Trust collections without their own table. Every dimension the platform filters,
-- scopes or governs on is an explicit column; the payload holds the rest verbatim
-- with a digest over it, so an out-of-band edit is detectable.
CREATE TABLE trust_records (
  collection     TEXT NOT NULL CHECK (length(collection) BETWEEN 1 AND 100),
  record_id      TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 200),
  tenant_id      TEXT,
  workspace_id   TEXT,
  principal_id   TEXT,
  status         TEXT,
  effective_from TIMESTAMPTZ,
  effective_to   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  payload        JSONB NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, record_id)
);

CREATE INDEX trust_records_workspace_idx
  ON trust_records(collection, workspace_id);

CREATE INDEX trust_records_principal_idx
  ON trust_records(collection, principal_id);

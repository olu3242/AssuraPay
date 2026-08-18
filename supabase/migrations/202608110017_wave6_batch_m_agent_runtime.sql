-- Batch M activates the agent runtime, and closes the durability register.
--
-- Nine aggregates for canonical Engines 61-70 — capability, registered agent, prompt version, execution
-- context snapshot, memory entry, approval request, telemetry record, governance policy, execution.
--
-- The last batch, and the only one since Batch A that **creates rather than converges**. It is also the batch
-- whose discovery came closest to being missed, and that is worth stating before the DDL.
--
-- ## What the first scan missed, and why every gate missed it too
--
-- A by-name search of `current_schema()` for the nine tables found nothing and concluded there was no prior
-- art. There is: `202608030012_agent_runtime.sql` creates `agent_runtime.records`, a single generic envelope
-- for all nine aggregates discriminated by a `record_type` column, **in a schema of its own**. No TypeScript
-- file in the repository references it — no reader, no writer, no test.
--
-- The schema is the reason it survived to the last batch. `certifySchemaOwnership` and the RLS certification
-- both enumerate `current_schema()`, so an object outside it is governed by nothing: not the ownership
-- registry, not the FORCE row-level-security sweep that took ENABLE-without-FORCE from 59 tables to zero, not
-- the coverage gate. `202608110016` retired three deprecated tables the registry could see. This one was
-- invisible.
--
-- Four properties, the first three proved by statement against a live migrated instance:
--
--   * **a capability record can be edited into the shape its engine exists to refuse.** `UPDATE ... SET payload
--     = '{"mode":"EXECUTE_DETERMINISTIC","protectedState":true}'` returned `UPDATE 1`. That row is the only
--     thing standing between an agent and a direct protected-state change: `AgentRuntimeEngine.execute`
--     invokes the deterministic gateway when `mode = 'EXECUTE_DETERMINISTIC'` and no approval is required, and
--     `CapabilityRegistryEngine.register` raises `AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES` on exactly
--     that combination. The engine refuses to create one; the table permitted editing one into existence;
--   * **an execution cannot transition at all.** `QUEUED → RUNNING` raises `agent runtime history is
--     append-only`, because the trigger treats `execution` as history. Engine 61's whole lifecycle — start,
--     succeed, fail, cancel — was unperformable. The same defect Batches H, K and L each found, for the
--     fourth time;
--   * **a delete is neither performed nor refused.** The trigger is `BEFORE DELETE` and returns `NEW`, which
--     is unassigned in a delete context, so PL/pgSQL treats the row operation as skipped. `DELETE` reports
--     `DELETE 0` and the row remains. A caller is told nothing matched, which is the one outcome worse than
--     either allowing or refusing;
--   * its policy predicate is `current_setting('app.tenant_id', true)::uuid`, the pre-trust convention, while
--     `trust_current_tenant()` returns TEXT. Under the runtime's actual identity every statement against the
--     table raises `invalid input syntax for type uuid` — an error naming a type rather than a permission,
--     which is the hardest kind to diagnose as a tenancy failure.
--
-- And being one envelope it can hold no invariant of any of the nine: its only constraints are a primary key
-- and the `record_type` CHECK. `AGENT_CANNOT_SELF_APPROVE`, single-use consumption, the memory sequence, the
-- single active policy — none of them is expressible about a `payload` column.
--
-- So the lesson is the same one twice, and it is the note this programme ends on: an aggregate stored as an
-- untyped payload cannot carry its own rules, and an object outside `current_schema()` is outside the reach of
-- every gate built to notice that. The envelope is retired at the end of this migration.
--
-- ## The invariant this batch exists to hold
--
-- `AGENTS_MAY_ONLY_PROPOSE_PROTECTED_STATE_CHANGES` is the agent surface's version of CLAUDE.md's non-custody
-- constraint: an agent may propose a change to protected state and may never execute one. Here it is a CHECK,
-- and `mode` and `protected_state` are immutable columns — because `deactivate()` is a `replace`, so without
-- immutability the row could still be edited into the refused shape after it was created, which is precisely
-- what the retired envelope allowed.
--
-- `AGENT_CANNOT_SELF_APPROVE` is a CHECK too, rather than only an engine guard, because `action` may be
-- `CERTIFICATION`: an agent that approved its own request could manufacture certified work, and CLAUDE.md's
-- second hard constraint is that every release is certified-work-backed. Consumption is single-use and
-- hash-matched, so an approval for one proposal cannot authorise another.
--
-- ## Six transition, three are append-only
--
-- A capability is deactivated; an agent version and a governance policy are activated and superseded; a prompt
-- version moves between DRAFT, PUBLISHED and RETIRED; an approval is decided and then consumed; an execution
-- moves QUEUED → RUNNING → SUCCEEDED/FAILED/CANCELLED. The three that do not transition are records of what
-- happened: the governed references an execution was given, a memory entry — Engine 67 is "append-only,
-- explicit, inspectable memory" — and a telemetry measurement.
--
-- ## Sequence numbers computed by counting
--
-- `ExecutionMemoryEngine.append` derives `sequence` from `prior.length + 1`, and `AgentRegistryEngine` and
-- `AgentGovernanceEngine` derive `version` the same way. Each is a read-then-write two concurrent callers both
-- satisfy, so each gets a real unique key. Without one, a conversation's memory holds two entries claiming the
-- same position with nothing to say which came first — and for an inspectable audit of an agent's reasoning
-- that is the whole point lost.
--
-- The single-active partial indexes are safe against the engines' own order of operations: `activate`,
-- `publish` and the policy `publish` each clear the incumbent before claiming, in that order.
--
-- ## Keys deliberately not created
--
-- Three, each because it would be stricter than the engine that writes the rows:
--
--   * no unique key on a capability's name. `CapabilityRegistryEngine` looks capabilities up by id and never
--     by name, so a key there would refuse a write the engine permits — the mistake `202608110006` had to
--     correct for invoice numbers;
--   * no foreign key on `agent_approval_requests.execution_id`. Engine 68 is a gate that runs *before* the
--     action it authorises, and its own suite requests an approval for an execution that does not exist.
--     Requiring the row first would invert the order the approval exists to impose;
--   * no foreign keys from `agent_context_snapshots` to the aggregates it references. Engine 66 states that
--     the "caller supplies governed references/snapshots; this package never reads domain stores", so the
--     schema must not impose a read the engine forbids. A snapshot is the record of what an agent was allowed
--     to see, not a copy of it.
--
-- Memory and telemetry *do* carry foreign keys to their execution and their agent, because `execute()` writes
-- the execution row before either and an orphan measurement is spend attributed to nothing.

-- ---------------------------------------------------------------------------------------------------------
-- Shared predicates
-- ---------------------------------------------------------------------------------------------------------

-- `jsonb_typeof` first in every one of these. `jsonb_array_length` and `jsonb_array_elements` raise on a
-- scalar, and `AND` does not guarantee evaluation order, so a guard written as a conjunction produces an
-- internal error instead of a refusal naming the rule.

CREATE OR REPLACE FUNCTION assurapay_jsonb_is_text_array(value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(value) AS element
      WHERE jsonb_typeof(element.value) <> 'string' OR btrim(element.value #>> '{}') = ''
    )
  END
$$;

COMMENT ON FUNCTION assurapay_jsonb_is_text_array(JSONB) IS
  'True when the value is a JSON array whose every element is a non-blank string. The shape every string[] field of Batch M is stored as.';

CREATE OR REPLACE FUNCTION assurapay_jsonb_is_text_set(value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NOT assurapay_jsonb_is_text_array(value) THEN FALSE
    ELSE (
      SELECT count(*) = count(DISTINCT element.value)
      FROM jsonb_array_elements_text(value) AS element
    )
  END
$$;

-- Distinctness, and deliberately not sortedness. `ContextEngine.create` and `PromptRegistryEngine.createVersion`
-- both normalise with `[...new Set(x)].sort()`, so a conforming row is a sorted set — but JavaScript sorts by
-- UTF-16 code unit and PostgreSQL by collation, and the two disagree for values outside ASCII. A constraint on
-- the order would refuse rows the engine produces; a duplicate is a row contradicting its own normalisation in
-- any collation.
COMMENT ON FUNCTION assurapay_jsonb_is_text_set(JSONB) IS
  'True when the value is a JSON array of non-blank strings with no duplicates. Order is not constrained: JavaScript sort order and PostgreSQL collation order differ outside ASCII.';

CREATE OR REPLACE FUNCTION assurapay_jsonb_text_subset(value JSONB, allowed TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NOT assurapay_jsonb_is_text_array(value) THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(value) AS element
      WHERE element.value <> ALL(allowed)
    )
  END
$$;

COMMENT ON FUNCTION assurapay_jsonb_text_subset(JSONB, TEXT[]) IS
  'True when the value is a JSON array of non-blank strings drawn entirely from the allowed set. Used to hold a governance policy''s requireApprovalFor to the four ProtectedAction values.';

CREATE OR REPLACE FUNCTION assurapay_prompt_variables_present(template TEXT, required JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NOT assurapay_jsonb_is_text_array(required) THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(required) AS variable
      WHERE position('{{' || variable.value || '}}' IN template) = 0
    )
  END
$$;

-- `createVersion` refuses a required variable the template does not contain, and this is the durable form of
-- the same rule. Its consequence is what makes it worth a constraint rather than an engine check alone:
-- `render` raises `PROMPT_VALUE_MISSING` for a variable that cannot be substituted, and `template` is
-- immutable — so a row where the two disagree is a prompt that can never be rendered, permanently.
COMMENT ON FUNCTION assurapay_prompt_variables_present(TEXT, JSONB) IS
  'True when every required variable appears in the template as {{name}}, matching PromptRegistryEngine.createVersion.';

-- ---------------------------------------------------------------------------------------------------------
-- Mutation-boundary functions specific to this batch
-- ---------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_active_flag_is_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Read through `to_jsonb` rather than named directly, so one function serves both tables without knowing
  -- either shape — the same reason `enforce_governed_aggregate_transition` takes column names as arguments.
  flag  TEXT := COALESCE(TG_ARGV[0], 'active');
  was   BOOLEAN := (to_jsonb(OLD) ->> flag)::BOOLEAN;
  after BOOLEAN := (to_jsonb(NEW) ->> flag)::BOOLEAN;
BEGIN
  IF was IS NOT TRUE AND after IS TRUE THEN
    RAISE EXCEPTION 'AGGREGATE_CANNOT_BE_REACTIVATED: %.%', TG_TABLE_NAME, flag;
  END IF;
  RETURN NEW;
END
$$;

-- Attached to `agent_capabilities` and `agent_governance_policies`, and deliberately not to `registered_agents`.
-- `CapabilityRegistryEngine` has `deactivate` and no reactivation, and `AgentGovernanceEngine.publish` only
-- ever supersedes — so for both, `active` going back to true is a state no engine can produce. An agent is
-- different: `activate(id)` names a version, which legitimately restores a previous one, exactly as the prompt
-- registry's `rollback` republishes a retired version.
COMMENT ON FUNCTION enforce_active_flag_is_monotonic() IS
  'Refuses an update that turns a deactivated aggregate back on. Argument: the boolean column name, default "active".';

CREATE OR REPLACE FUNCTION enforce_agent_approval_finality() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- `decide` refuses a request that is not PENDING. Without this, a REJECTED request could be flipped to
  -- APPROVED — the CHECK constraints would all still hold, because the decider and the decision time are
  -- already recorded — and then consumed.
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'AGENT_APPROVAL_DECISION_IS_FINAL: % (% -> %)', OLD.id, OLD.status, NEW.status;
  END IF;

  -- Who decided, and when, are recorded once. A decision whose author can be rewritten is not evidence of who
  -- authorised the action.
  IF OLD.decided_by IS NOT NULL AND NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    RAISE EXCEPTION 'AGENT_APPROVAL_DECIDER_IS_WRITE_ONCE: %', OLD.id;
  END IF;
  IF OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'AGENT_APPROVAL_DECISION_TIME_IS_WRITE_ONCE: %', OLD.id;
  END IF;

  -- `consume` refuses an already-consumed approval. This is that rule in the schema: an approval authorises
  -- one protected action, once. Clearing or moving `consumed_at` would make it reusable.
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'AGENT_APPROVAL_IS_SINGLE_USE: %', OLD.id;
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION enforce_agent_approval_finality() IS
  'Engine 68 in the schema: a decision is final, its author and time are write-once, and an approval is consumable once.';

-- ---------------------------------------------------------------------------------------------------------
-- The nine tables
-- ---------------------------------------------------------------------------------------------------------
--
-- Identity is TEXT throughout, tenancy is explicit, and `created_at` carries no default: the instant a record
-- was created is the engine's claim about its own history, so a missing value is an error rather than silently
-- the moment of the INSERT.
--
-- Created in dependency order — the four an execution references, then executions, then the two that record
-- what an execution did.

-- Engine 62 — Capability registry
CREATE TABLE IF NOT EXISTS agent_capabilities (
  id                      TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id               TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                            REFERENCES trust_tenants (tenant_id),
  workspace_id            TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  name                    TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  owner                   TEXT NOT NULL CHECK (length(btrim(owner)) > 0),
  -- The permission Engine 03 evaluates before the capability runs. A capability with no permission is one
  -- nothing authorises.
  permission              TEXT NOT NULL CHECK (length(btrim(permission)) > 0),
  mode                    TEXT NOT NULL CHECK (mode IN ('READ', 'PROPOSE', 'EXECUTE_DETERMINISTIC')),
  -- A named contract the deterministic gateway dispatches on, never a function or a state handle.
  deterministic_contract  TEXT NOT NULL CHECK (length(btrim(deterministic_contract)) > 0),
  ai_allowed              BOOLEAN NOT NULL,
  human_approval_required BOOLEAN NOT NULL,
  protected_state         BOOLEAN NOT NULL,
  active                  BOOLEAN NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  row_version             INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version          INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The one this batch exists for. An agent may propose a change to protected state and never execute one.
  CONSTRAINT agent_capabilities_protected_state_may_only_propose
    CHECK (NOT protected_state OR mode = 'PROPOSE')
);

-- Engine 63 — Agent registry
CREATE TABLE IF NOT EXISTS registered_agents (
  id                     TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id              TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                           REFERENCES trust_tenants (tenant_id),
  workspace_id           TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  name                   TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  -- A domain revision, derived by counting prior versions of the same name. Distinct from `row_version`, which
  -- counts writes to this row — which is why the trigger below is told which column carries concurrency.
  version                INTEGER NOT NULL CHECK (version >= 1),
  owner                  TEXT NOT NULL CHECK (length(btrim(owner)) > 0),
  prompt_ids             JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(prompt_ids)),
  allowed_capability_ids JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(allowed_capability_ids)),
  active                 BOOLEAN NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version         INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engine 64 — Prompt registry
CREATE TABLE IF NOT EXISTS prompt_versions (
  id                 TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id          TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                       REFERENCES trust_tenants (tenant_id),
  workspace_id       TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  prompt_id          TEXT NOT NULL CHECK (length(prompt_id) BETWEEN 1 AND 200),
  version            INTEGER NOT NULL CHECK (version >= 1),
  template           TEXT NOT NULL CHECK (length(btrim(template)) > 0),
  required_variables JSONB NOT NULL CHECK (assurapay_jsonb_is_text_set(required_variables)),
  -- What the gateway validates a model's output against. A version with no output contract accepts anything a
  -- model returns.
  output_contract    TEXT NOT NULL CHECK (length(btrim(output_contract)) > 0),
  status             TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  -- A digest of the template, so what was published can be shown to be what ran.
  checksum           TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at         TIMESTAMPTZ NOT NULL,
  row_version        INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version     INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_variables_appear_in_template
    CHECK (assurapay_prompt_variables_present(template, required_variables))
);

-- Engine 66 — Execution context
--
-- `tenant_id` is both the routing column and the snapshot's own `tenantId` field, stored once. The domain type
-- carries a tenant of its own — the only aggregate in the batch that does — and two columns could disagree,
-- which would mean a snapshot claiming it was taken for a tenant other than the one it is stored under. One
-- column makes that unrepresentable.
CREATE TABLE IF NOT EXISTS agent_context_snapshots (
  id                     TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id              TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                           REFERENCES trust_tenants (tenant_id),
  workspace_id           TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  agreement_id           TEXT CHECK (agreement_id IS NULL OR length(agreement_id) BETWEEN 1 AND 200),
  blueprint_id           TEXT CHECK (blueprint_id IS NULL OR length(blueprint_id) BETWEEN 1 AND 200),
  milestone_ids          JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(milestone_ids)),
  definition_of_done_ids JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(definition_of_done_ids)),
  history_refs           JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(history_refs)),
  user_id                TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  -- The permissions in force when the snapshot was taken. An agent's reach is bounded by this list, so the
  -- snapshot is also the record of what it was entitled to.
  permissions            JSONB NOT NULL CHECK (assurapay_jsonb_is_text_set(permissions)),
  checksum               TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at             TIMESTAMPTZ NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version         INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engine 70 — Governance policy
CREATE TABLE IF NOT EXISTS agent_governance_policies (
  id                     TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id              TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                           REFERENCES trust_tenants (tenant_id),
  workspace_id           TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  version                INTEGER NOT NULL CHECK (version >= 1),
  allowed_roles          JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(allowed_roles)),
  allowed_prompt_ids     JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(allowed_prompt_ids)),
  allowed_capability_ids JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(allowed_capability_ids)),
  allowed_models         JSONB NOT NULL CHECK (assurapay_jsonb_is_text_array(allowed_models)),
  require_approval_for   JSONB NOT NULL CHECK (
    assurapay_jsonb_text_subset(
      require_approval_for, ARRAY['APPROVAL', 'WAIVER', 'OVERRIDE', 'CERTIFICATION'])),
  active                 BOOLEAN NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version         INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engine 61 — Agent runtime
--
-- Every reference is checked, because `execute()` reads all four before it writes the row: the agent, the
-- capability, the rendered prompt version and the context snapshot. An execution citing an agent or a
-- capability that does not exist is a run nobody can attribute or authorise.
CREATE TABLE IF NOT EXISTS agent_executions (
  id                  TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id           TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                        REFERENCES trust_tenants (tenant_id),
  workspace_id        TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  agent_id            TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 200),
  capability_id       TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 200),
  prompt_version_id   TEXT NOT NULL CHECK (length(prompt_version_id) BETWEEN 1 AND 200),
  context_snapshot_id TEXT NOT NULL CHECK (length(context_snapshot_id) BETWEEN 1 AND 200),
  status              TEXT NOT NULL
                        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  attempts            INTEGER NOT NULL CHECK (attempts >= 0),
  -- The output, which Engine 61 insists is "a proposal/result artifact, never protected state". SQL NULL means
  -- absent; the JSON value `null` is a proposal that is null.
  proposal            JSONB,
  error               TEXT CHECK (error IS NULL OR length(btrim(error)) > 0),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL,
  row_version         INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version      INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A run that left the queue records when it started, and a finished one records when it finished. Both
  -- directions, because a QUEUED row carrying a start time reads as started to anything sorting by it.
  CONSTRAINT agent_executions_start_follows_status
    CHECK ((status <> 'QUEUED') = (started_at IS NOT NULL)),
  CONSTRAINT agent_executions_completion_follows_status
    CHECK ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL)),
  -- A failure says why. `execute()` always records `lastError`, and a failed run with no error is one nobody
  -- can diagnose.
  CONSTRAINT agent_executions_failure_is_explained
    CHECK (status <> 'FAILED' OR error IS NOT NULL),
  CONSTRAINT agent_executions_timestamps_advance
    CHECK (
      (started_at IS NULL OR started_at >= created_at)
      AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    )
);

-- Engine 67 — Execution memory
CREATE TABLE IF NOT EXISTS agent_memory (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id      TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                   REFERENCES trust_tenants (tenant_id),
  workspace_id   TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  execution_id   TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 200),
  agent_id       TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 200),
  -- A position, from one. `append` computes `prior.length + 1`, which two concurrent callers both compute
  -- identically — the unique index below is what actually orders them.
  sequence       INTEGER NOT NULL CHECK (sequence >= 1),
  kind           TEXT NOT NULL
                   CHECK (kind IN ('USER', 'AGENT', 'REASONING_METADATA', 'TOOL', 'RESULT')),
  -- Required, and `jsonb` holds the JSON value `null` for an entry whose content was absent. A nullable column
  -- could not distinguish that from the JSON value either, so one canonical form is chosen.
  content        JSONB NOT NULL,
  content_hash   TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at     TIMESTAMPTZ NOT NULL,
  row_version    INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engine 69 — Telemetry
CREATE TABLE IF NOT EXISTS agent_telemetry (
  id                 TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id          TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                       REFERENCES trust_tenants (tenant_id),
  workspace_id       TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  execution_id       TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 200),
  agent_id           TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 200),
  provider           TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 200),
  latency_ms         INTEGER NOT NULL CHECK (latency_ms >= 0),
  -- Integer minor units, per CLAUDE.md's fourth constraint. Model spend is money like any other, and BIGINT
  -- because a token bill in kobo outgrows an INTEGER.
  --
  -- One limit of an integer column, measured here rather than assumed, because it is the same for every
  -- minor-units column in the platform: a fractional value is **rounded, not refused**. `100.5` inserts as
  -- `101` and `99.5` as `100`, since the cast to BIGINT happens before any CHECK can see the value, and no
  -- CHECK can inspect what was written before the cast. So the thing that refuses a fractional amount is the
  -- `minorUnits` contract in `packages/domain-contracts`, applied before the statement — not this column. The
  -- register records the gap: closing it in the database would mean NUMERIC with an integrality CHECK on every
  -- money column across all eleven batches, which is its own change with its own proofs.
  cost_minor         BIGINT NOT NULL CHECK (cost_minor >= 0),
  input_tokens       INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens      INTEGER NOT NULL CHECK (output_tokens >= 0),
  errors             INTEGER NOT NULL CHECK (errors >= 0),
  quality_score      NUMERIC CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100),
  -- The two flags an operator filters on when auditing what a model did.
  hallucination_flag BOOLEAN NOT NULL,
  approval_requested BOOLEAN NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  row_version        INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version     INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Engine 68 — Human approval
CREATE TABLE IF NOT EXISTS agent_approval_requests (
  id                     TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id              TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200)
                           REFERENCES trust_tenants (tenant_id),
  workspace_id           TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 200),
  -- No foreign key: this gate runs before the action it authorises. See the header.
  execution_id           TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 200),
  requested_by_agent_id  TEXT NOT NULL CHECK (length(requested_by_agent_id) BETWEEN 1 AND 200),
  action                 TEXT NOT NULL
                           CHECK (action IN ('APPROVAL', 'WAIVER', 'OVERRIDE', 'CERTIFICATION')),
  -- A digest, so what was approved can be recomputed from the proposal and shown to be the same thing.
  proposal_hash          TEXT NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  status                 TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by             TEXT CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 200),
  decided_at             TIMESTAMPTZ,
  consumed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL,
  row_version            INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  schema_version         INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A decision records who and when; a pending request records neither.
  CONSTRAINT agent_approval_requests_decision_follows_status
    CHECK ((status <> 'PENDING') = (decided_by IS NOT NULL)),
  CONSTRAINT agent_approval_requests_decider_and_time_agree
    CHECK ((decided_by IS NOT NULL) = (decided_at IS NOT NULL)),
  -- `AGENT_CANNOT_SELF_APPROVE`, in the schema rather than only in the engine: `action` may be `CERTIFICATION`,
  -- so an agent approving its own request could manufacture certified work.
  CONSTRAINT agent_approval_requests_no_self_approval
    CHECK (decided_by IS NULL OR decided_by <> requested_by_agent_id),
  -- Only an approved request is consumable.
  CONSTRAINT agent_approval_requests_consumption_requires_approval
    CHECK (consumed_at IS NULL OR status = 'APPROVED'),
  CONSTRAINT agent_approval_requests_timestamps_advance
    CHECK (
      (decided_at IS NULL OR decided_at >= created_at)
      AND (consumed_at IS NULL OR decided_at IS NULL OR consumed_at >= decided_at)
    )
);

-- ---------------------------------------------------------------------------------------------------------
-- Keys, references, tenancy and the mutation boundary
-- ---------------------------------------------------------------------------------------------------------

DO $batch_m$
DECLARE
  created CONSTANT TEXT[] := ARRAY[
    'agent_capabilities', 'registered_agents', 'prompt_versions', 'agent_context_snapshots',
    'agent_memory', 'agent_approval_requests', 'agent_telemetry', 'agent_governance_policies',
    'agent_executions'
  ];
  -- A record of what happened, not a thing with a lifecycle. No engine passes any of these to `replace`.
  append_only CONSTANT TEXT[] := ARRAY[
    'agent_context_snapshots', 'agent_memory', 'agent_telemetry'
  ];
  target TEXT;
BEGIN
  FOREACH target IN ARRAY created LOOP
    -- Both scopes, as `202608110008` established: a foreign key is checked by the system rather than through
    -- row-level security, so a tenant-only reference accepts a parent in another workspace of the same tenant.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) '
      'REFERENCES trust_workspaces(workspace_id)', target, target || '_workspace_fk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, workspace_id) '
      'REFERENCES trust_workspaces(tenant_id, workspace_id)', target, target || '_tenant_workspace_fk');

    -- What every cross-aggregate reference in this batch points at.
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, id)', target, target || '_tenant_id_unique');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (tenant_id, workspace_id, id)',
      target, target || '_tenant_workspace_id_unique');

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, workspace_id)',
      target || '_tenant_workspace_idx', target);

    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace()) '
      'WITH CHECK (tenant_id = trust_current_tenant() '
      'AND workspace_id = trust_current_workspace())', target || '_trust_scope', target);

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    -- FORCE from the first statement, not ENABLE. ENABLE alone does not constrain the table owner, which is
    -- what left 59 tables unprotected until `202608110010` and what the retired envelope still had.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assurapay_app') THEN
      IF target = ANY(append_only) THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I TO assurapay_app', target);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO assurapay_app', target);
      END IF;
    END IF;
  END LOOP;

  FOREACH target IN ARRAY append_only LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',
      target || '_append_only', target);
  END LOOP;
END
$batch_m$;

-- The counters the engines derive by counting rows. Each is a read-then-write two concurrent callers both
-- satisfy, so the index is the only thing that makes the number mean a position.
CREATE UNIQUE INDEX IF NOT EXISTS registered_agents_ws_name_version_unique
  ON registered_agents (tenant_id, workspace_id, name, version);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_ws_prompt_version_unique
  ON prompt_versions (tenant_id, workspace_id, prompt_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS agent_governance_policies_ws_version_unique
  ON agent_governance_policies (tenant_id, workspace_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_ws_execution_sequence_unique
  ON agent_memory (tenant_id, workspace_id, execution_id, sequence);

-- One incumbent each. `active()` and `render()` and `authorize()` all resolve with a single `find`, so a second
-- active row would make which one governs depend on row order — and for the governance policy that decides
-- which models, prompts and capabilities an agent may use at all.
CREATE UNIQUE INDEX IF NOT EXISTS registered_agents_single_active_version
  ON registered_agents (tenant_id, workspace_id, name) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_single_published
  ON prompt_versions (tenant_id, workspace_id, prompt_id) WHERE status = 'PUBLISHED';
CREATE UNIQUE INDEX IF NOT EXISTS agent_governance_policies_single_active
  ON agent_governance_policies (tenant_id, workspace_id) WHERE active;

-- What an execution ran, all four scoped to the tenant and the workspace.
ALTER TABLE agent_executions
  ADD CONSTRAINT agent_executions_agent_fk
  FOREIGN KEY (tenant_id, workspace_id, agent_id)
  REFERENCES registered_agents (tenant_id, workspace_id, id);
ALTER TABLE agent_executions
  ADD CONSTRAINT agent_executions_capability_fk
  FOREIGN KEY (tenant_id, workspace_id, capability_id)
  REFERENCES agent_capabilities (tenant_id, workspace_id, id);
ALTER TABLE agent_executions
  ADD CONSTRAINT agent_executions_prompt_version_fk
  FOREIGN KEY (tenant_id, workspace_id, prompt_version_id)
  REFERENCES prompt_versions (tenant_id, workspace_id, id);
ALTER TABLE agent_executions
  ADD CONSTRAINT agent_executions_context_snapshot_fk
  FOREIGN KEY (tenant_id, workspace_id, context_snapshot_id)
  REFERENCES agent_context_snapshots (tenant_id, workspace_id, id);

-- What an execution did. `execute()` writes the execution row before appending either, and an orphan telemetry
-- row is model spend attributed to nothing.
ALTER TABLE agent_memory
  ADD CONSTRAINT agent_memory_execution_fk
  FOREIGN KEY (tenant_id, workspace_id, execution_id)
  REFERENCES agent_executions (tenant_id, workspace_id, id);
ALTER TABLE agent_memory
  ADD CONSTRAINT agent_memory_agent_fk
  FOREIGN KEY (tenant_id, workspace_id, agent_id)
  REFERENCES registered_agents (tenant_id, workspace_id, id);
ALTER TABLE agent_telemetry
  ADD CONSTRAINT agent_telemetry_execution_fk
  FOREIGN KEY (tenant_id, workspace_id, execution_id)
  REFERENCES agent_executions (tenant_id, workspace_id, id);
ALTER TABLE agent_telemetry
  ADD CONSTRAINT agent_telemetry_agent_fk
  FOREIGN KEY (tenant_id, workspace_id, agent_id)
  REFERENCES registered_agents (tenant_id, workspace_id, id);

-- ---------------------------------------------------------------------------------------------------------
-- The six governed transitions
-- ---------------------------------------------------------------------------------------------------------
--
-- Written out rather than looped: each immutable set is a different claim about what the aggregate is.

-- Only `active` moves, which is the whole of `deactivate()`. Everything else is what the capability *is* — and
-- `mode` and `protected_state` being immutable is the constraint this batch exists for. The retired envelope
-- permitted exactly this edit, and it is the difference between an agent that proposes a protected-state
-- change and one that performs it.
CREATE TRIGGER agent_capabilities_governed_transition
  BEFORE UPDATE OR DELETE ON agent_capabilities
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'name', 'owner', 'permission', 'mode',
    'deterministic_contract', 'ai_allowed', 'human_approval_required', 'protected_state', 'created_at',
    'schema_version');

-- A deactivated capability stays deactivated: the engine has `deactivate` and no reactivation.
CREATE TRIGGER agent_capabilities_no_reactivation
  BEFORE UPDATE ON agent_capabilities
  FOR EACH ROW EXECUTE FUNCTION enforce_active_flag_is_monotonic('active');

-- Only `active` moves. The name, version, owner and the two allow-lists are the registered agent: a mutable
-- `allowed_capability_ids` would silently widen what an already-approved agent may do, and `execute()` checks
-- that list on every run.
CREATE TRIGGER registered_agents_governed_transition
  BEFORE UPDATE OR DELETE ON registered_agents
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'name', 'version', 'owner', 'prompt_ids',
    'allowed_capability_ids', 'created_at', 'schema_version');

-- Only `status` moves — DRAFT to PUBLISHED, PUBLISHED to RETIRED, and RETIRED back to PUBLISHED, which is what
-- `rollback` does. The template and its checksum are immutable, so what ran can always be recomputed from
-- what was published.
CREATE TRIGGER prompt_versions_governed_transition
  BEFORE UPDATE OR DELETE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'prompt_id', 'version', 'template',
    'required_variables', 'output_contract', 'checksum', 'created_at', 'schema_version');

-- The decision and the consumption move. What the approval is *for* — the execution, the requesting agent, the
-- action and the proposal digest — never does, which is what makes a consumed approval evidence that this
-- proposal was authorised rather than some other one.
CREATE TRIGGER agent_approval_requests_governed_transition
  BEFORE UPDATE OR DELETE ON agent_approval_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'execution_id',
    'requested_by_agent_id', 'action', 'proposal_hash', 'created_at', 'schema_version');

CREATE TRIGGER agent_approval_requests_finality
  BEFORE UPDATE ON agent_approval_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_agent_approval_finality();

-- Only `active` moves, which is the whole of superseding a policy. Everything else is the policy a workspace
-- was governed by at a version, and `authorize()` reads all four allow-lists on every execution.
CREATE TRIGGER agent_governance_policies_governed_transition
  BEFORE UPDATE OR DELETE ON agent_governance_policies
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'version', 'allowed_roles',
    'allowed_prompt_ids', 'allowed_capability_ids', 'allowed_models', 'require_approval_for', 'created_at',
    'schema_version');

-- A superseded policy is never restored: `publish` only ever creates a new active version.
CREATE TRIGGER agent_governance_policies_no_reactivation
  BEFORE UPDATE ON agent_governance_policies
  FOR EACH ROW EXECUTE FUNCTION enforce_active_flag_is_monotonic('active');

-- The status, the attempt count, the proposal, the error and the two timestamps move — the whole of Engine 61's
-- lifecycle, and the thing the retired envelope refused outright. What the run *was* does not move: a mutable
-- `capability_id` or `prompt_version_id` would re-attribute a completed run to a different capability or a
-- different prompt after the fact.
CREATE TRIGGER agent_executions_governed_transition
  BEFORE UPDATE OR DELETE ON agent_executions
  FOR EACH ROW EXECUTE FUNCTION enforce_governed_aggregate_transition(
    'concurrency=row_version', 'id', 'tenant_id', 'workspace_id', 'agent_id', 'capability_id',
    'prompt_version_id', 'context_snapshot_id', 'created_at', 'schema_version');

-- ---------------------------------------------------------------------------------------------------------
-- Retire the envelope
-- ---------------------------------------------------------------------------------------------------------

DO $retire_agent_runtime_envelope$
DECLARE
  rows     BIGINT;
  intruder TEXT[] := '{}';
  rec      RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'agent_runtime') THEN
    -- `202608030012` is not in `REQUIRED_TRUST_MIGRATIONS`, so a host may never have applied it. Nothing to
    -- retire is a valid state, not a failure.
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'agent_runtime' AND c.relname = 'records' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'SELECT count(*) FROM agent_runtime.records' INTO rows;
    IF rows > 0 THEN
      RAISE EXCEPTION
        'WAVE6_BATCH_M_RETIREMENT_REFUSED: agent_runtime.records holds % row(s). This migration drops the '
        'table, and dropping rows is not a migration''s decision to make. The nine typed tables above are '
        'its replacement; move the records deliberately, then re-run. Nothing has been changed.', rows;
    END IF;

    FOR rec IN
      SELECT c.conrelid::regclass::text AS child
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'agent_runtime.records'::regclass
    LOOP
      intruder := intruder || rec.child;
    END LOOP;

    IF array_length(intruder, 1) > 0 THEN
      RAISE EXCEPTION
        'WAVE6_BATCH_M_RETIREMENT_REFUSED: foreign key(s) from %s reference agent_runtime.records. '
        'Nothing has been changed.', array_to_string(intruder, ', ');
    END IF;
  END IF;

  DROP TABLE IF EXISTS agent_runtime.records;
  DROP FUNCTION IF EXISTS agent_runtime.prevent_record_mutation();
  -- Not CASCADE. If anything else was put in this schema since, the drop fails and says so rather than taking
  -- an unknown object with it.
  DROP SCHEMA IF EXISTS agent_runtime RESTRICT;
END
$retire_agent_runtime_envelope$;

-- ---------------------------------------------------------------------------------------------------------
-- What these tables are
-- ---------------------------------------------------------------------------------------------------------

COMMENT ON TABLE agent_capabilities IS
  'Canonical Engine 62 capability registry — what an agent is allowed to do, and in which mode. The row that holds AssuraPay''s agent-surface non-custody rule: a capability touching protected state may only PROPOSE, and both mode and protected_state are immutable. Until 202608110017 the only agent table in the schema was an untyped envelope in which this row could be edited into EXECUTE_DETERMINISTIC with protectedState true — the exact shape CapabilityRegistryEngine.register refuses to create.';

COMMENT ON TABLE agent_executions IS
  'Canonical Engine 61 agent execution — the only execution entry point, whose output is a proposal artifact and never protected state. Until 202608110017 an execution record could not transition at all: the retired envelope treated it as history, so QUEUED to RUNNING raised, and the whole lifecycle was unperformable on the durable store.';

COMMENT ON TABLE agent_approval_requests IS
  'Canonical Engine 68 human approval — the gate an agent''s protected action passes through. An agent cannot approve its own request (a CHECK, because the action may be CERTIFICATION and CLAUDE.md requires every release to be certified-work-backed), a decision is final, and an approval authorises one proposal, once, matched by digest.';

COMMENT ON TABLE agent_memory IS
  'Canonical Engine 67 execution memory — append-only, explicit, inspectable. The unique key on (tenant, workspace, execution, sequence) is what makes the sequence a position: the engine derives it by counting prior entries, which two concurrent appends compute identically.';

COMMENT ON TABLE agent_telemetry IS
  'Canonical Engine 69 telemetry. cost_minor is integer minor units per CLAUDE.md''s fourth constraint — model spend is money like any other — and both references are checked, because spend attributed to an agent that does not exist is a cost report nobody can act on.';

COMMENT ON TABLE agent_context_snapshots IS
  'Canonical Engine 66 execution context — the governed references an agent was given, and the permissions in force when it was taken. Carries no foreign keys to the aggregates it references: Engine 66 never reads domain stores, so the schema does not impose a read the engine forbids.';

COMMENT ON TABLE agent_governance_policies IS
  'Canonical Engine 70 agent governance policy — which roles, prompts, capabilities and models an agent may use, and which protected actions need a human. One active version per workspace, enforced by a partial unique index, because authorize() resolves the governing policy with a single find.';

COMMENT ON TABLE prompt_versions IS
  'Canonical Engine 64 prompt registry. One PUBLISHED version per prompt, because render() resolves with a single find; the template and its checksum are immutable, so what ran can be recomputed from what was published.';

COMMENT ON TABLE registered_agents IS
  'Canonical Engine 63 agent registry. One active version per name, and the allow-lists are immutable — a mutable allowed_capability_ids would silently widen what an already-approved agent may do, and execute() checks that list on every run.';

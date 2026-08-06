# Wave 4 schema authority

**Status: ACCEPTED.** Owner decision. Governs how a canonical schema is determined for the
aggregates of Engines 31–50 during `persistence.domain-store-durability`.

## Authority order

Lower-ranked evidence never silently overrides higher-ranked semantics.

1. Constitutional invariants and accepted amendments
2. `docs/ENGINE_CATALOG.md` — engine identity and ownership
3. Accepted ADRs
4. Canonical exported engine and domain contracts
5. Canonical engine behaviour and state-transition tests
6. Versioned public event contracts
7. Versioned public API contracts
8. `docs/DATA_SCHEMA.md`
9. Existing purpose-built relational table definitions
10. Current generic JSONB payload shape
11. Test fixtures and seed data

`docs/DATA_SCHEMA.md` sits at rank 8: **supporting evidence, not automatically authoritative**. It
is 5 KB with 10 headings against 35 aggregates, so for most aggregates it is silent, and where it
speaks and conflicts with canonical engine behaviour, engine behaviour wins.

The existing relational tables sit at rank 9. They were written before the engines settled and
nothing has ever read them, so a column in one of them is a *proposal* about the domain, not a
fact about it. That is why this document forbids deriving domain types from table shapes.

## Zod authority

Per aggregate: one canonical **persisted-state** schema; separate **command/input** schemas where
input semantics differ; separate **event** schemas where event contracts differ from aggregate
state.

Pattern, in order of preference:

1. **Canonical Zod schema → inferred TypeScript type.** Use where package boundaries permit.
2. Canonical domain type + compile-time conformance check + canonical Zod runtime schema.

For Wave 4 the situation favours pattern 2 in one specific respect and it is worth being explicit:
the gap matrix measured **35 of 35 aggregates already have exported domain types containing no
`any`**. Those types are canonical (rank 4) and are imported across packages. Replacing them
wholesale with inferred types risks changing published contracts as a side effect of adding
validation. So the rule for Wave 4 is:

- where an exported type is already canonical, add the Zod schema and a **compile-time conformance
  assertion** proving the two agree;
- never maintain two hand-written authoritative definitions that can drift — the conformance
  assertion is what makes one of them derived in effect.

## Database authority

PostgreSQL is authoritative for **persistence** invariants: nullability, uniqueness, foreign keys,
tenant linkage, workspace linkage, lifecycle state bounds, monetary precision, immutable posted
facts, journal balance, version uniqueness, idempotency uniqueness, relational ownership.

Two directions, both required:

- Zod validation does **not** replace database constraints. A schema that runs in one process
  cannot constrain a console session.
- Database rows do **not** define domain semantics. A nullable column is not evidence that the
  domain permits absence.

## Versioning

Every canonical persisted aggregate schema carries or derives: schema version, aggregate identity,
tenant identity, workspace identity where applicable, aggregate version or concurrency token,
lifecycle state where applicable, creation timestamp, update timestamp, provenance or actor
identity where applicable.

Legacy payload readers parse **by schema version**. An unknown version fails into quarantine or an
explicit unsupported-version result — never a best-effort parse, because a silently mis-parsed
aggregate is worse than a refused one.

## Conflict handling

When `docs/DATA_SCHEMA.md`, domain contracts, existing JSONB data and relational tables disagree:

1. record the conflict
2. identify the highest-authority source
3. determine whether existing data transforms without semantic loss
4. create an explicit compatibility mapping
5. quarantine irreconcilable records
6. never silently coerce
7. never edit historical migrations
8. use additive migrations and versioned transformations

**Stop only for the aggregate whose semantics are irreducibly ambiguous. Continue with the rest.**

## Extension envelope

An extension JSONB column may exist only for genuinely extensible, non-core metadata, and **must
itself be schema-validated**. Core state belongs in explicit columns.

The test for "core": if the database, a row-level security policy, a uniqueness rule, a foreign
key, a check constraint, or a report must see the field, it is core and gets a column. Unrestricted
JSONB is never the authoritative core state.

Equally, not every relational column becomes a public domain field. The dead tables carry columns
that were never part of any engine contract; activating a table is not a licence to publish its
shape.

## Prohibited shortcuts

Generating domain types from table introspection. Treating `docs/DATA_SCHEMA.md` as authoritative
where it contradicts engine behaviour. Two hand-maintained authoritative definitions. A Zod schema
presented as a substitute for a constraint. A best-effort parse of an unknown schema version.
Keeping core state in unvalidated JSONB.

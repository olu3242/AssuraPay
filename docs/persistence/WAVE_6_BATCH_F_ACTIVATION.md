# Wave 6 Batch F activation

**Status: IMPLEMENTED.** Records what the second batch of the durability gap did — the fifteen
agreement-creation aggregates of canonical Engines 11–15 — and what it deliberately did not do.

Follows `docs/persistence/DURABILITY_GAP_ANALYSIS.md`. Batch F is the second entry in that sequence and
the largest single batch in it.

## What closes here

**The canonical chain.** `agreements` is the eleventh and last link of `Contract →
PerformanceBlueprint → Milestone → DefinitionOfDonePackage → ExecutionWorkspace →
CompletionCertificate → PaymentEligibility → FinancialEntitlement → ReleaseRequest →
PaymentInstruction → ReconciliationRecord` to gain a relational home. The census in
`durability-coverage.test.ts` moves from **10 of 11 to 11 of 11**, and that test's assertion changes
shape accordingly: it was a floor, and it is now an equality, because a closed chain can only regress.

The register moves from **61 unmapped collections to 46**.

Before this batch, `ContractAuthoringEngine.create` — the first step of the entire product — failed
against PostgreSQL with `PERSISTENCE_COLLECTION_NOT_MAPPED: agreements has no mapping in the durable
trust store`. That was the finding that opened the gap analysis.

## Two aggregates had no table at all, which is new

Batches A–E each converged tables that already existed. `contractComments` and `signatureCallbacks` are
written by `ContractAuthoringEngine.comment` and `DigitalExecutionEngine.callback`, and **neither had a
relation among the ninety-eight the migrations declare**. They were unstorable rather than merely
unrouted — a distinction the other sixty-five registered collections do not have.

`202608110005` creates them, TEXT-native and tenant-scoped and FORCE from their first statement, so they
never carry the UUID identity, missing tenant column or owner-exempt row-level security that the other
thirteen had to be converted out of.

## Four columns are not the snake_case of their field

The schema has said so since `202608030002`, and nothing here renames a column:

| collection | field | column |
|---|---|---|
| `documentVersions` | `number` | `version` |
| `contractDrafts` | `documentVersionId` | `current_document_version_id` |
| `clauseVersions` | `guidance` | `guidance_reference` |
| `negotiationRounds` | `number` | `round_number` |

`batch-f-repository.ts` is the only place the two vocabularies may meet. The canonical schemas are
`.strict()`, so a mapping that forgot one fails validation immediately instead of writing a column of
nulls. `documentVersions` is the sharpest case: the name it does *not* mean — `version` — is what three
other tables in this batch call a revision, and what the persistence layer calls a row counter
everywhere else.

## The thirteen carried no CHECK constraint of any kind

Measured against a live migrated instance, not inferred: `pg_constraint` held **seven UNIQUE constraints
and zero CHECK constraints** across all thirteen. No status value set, no positive revision, no digest
shape. There are **132** now.

What is now enforced that nothing enforced before:

- **Every declared status value set, for eleven aggregates.** A status column that accepts any string is
  a lifecycle with no states. Four of the fifteen have no status column at all, and the test reads that
  from the catalogue rather than from a list, so the assertion cannot drift from the schema.
- **The digest shape, on all eight `%_hash` columns.** Every hash these engines write comes from one
  `createHash('sha256')…digest('hex')` helper or is copied from a column that did, so `^[0-9a-f]{64}$`
  is a fact about the data rather than an aspiration. The schemas say the same through a new
  `sha256Hex` primitive.
- **The pairing a clause instance's source implies** — `(source = 'LIBRARY') = (clause_version_id IS NOT
  NULL)`. A LIBRARY clause with no citation claims a baseline it cannot name; a CUSTOM clause with one
  claims a baseline it deliberately departed from.
- **Positive revisions and non-negative counts**, on nine columns. Every revision here is computed by
  counting existing rows, so there is no revision zero — while a step index legitimately starts at zero,
  which is why the two are bounded differently.
- **Non-empty step and signer lists.** Both have the same failure mode: an aggregate function over an
  empty set reporting satisfaction. `completedSteps === steps.length` holds from the start for a policy
  with no steps, and `signers.every(...)` is true of no signers — which would issue an execution
  certificate for a document nobody signed.
- **A locked draft names its locker**, one-way. `lock` never clears `lockedBy`, so requiring the reverse
  would refuse a submitted draft that legitimately still records who locked it.
- **Tenancy and FORCE row-level security** on all thirteen, which carried `ENABLE` without `FORCE` — a
  boundary that does not constrain the table owner.

## The digest chain is a foreign key

This is the batch's central structural addition, and the agreement-side half of "every release is
certified-work-backed".

`DigitalExecutionEngine.create` refuses unless `a.documentHash === d.contentHash` — the approval must be
an approval of exactly the document being signed. That is a two-row invariant, and Batch C's currency
trick makes it structural: `agreement_document_versions` gains `UNIQUE (tenant_id, id, content_hash)`,
and both the approval request and the signature package reference `(tenant_id, document_version_id,
document_hash)` against it. The execution certificate does the same against the package.

No code path can now produce a row that names one document and carries another's digest. A certificate
that could cite a document it was not computed from is a contract whose execution cannot be proved.

`document_hash` is also in the governed trigger's immutable list on both tables, which is what makes the
chain hold over time: `invalidateOnChange` compares that column against the document's current hash, so
a rewritable digest is an invalidation that can be made to find no change.

## Why so few terminal states, and why that is the honest answer

A terminal state is a claim that no transition leaves it. Checked against the engines, that claim is
provable for **three** tables out of the ten governed — and the reason is worth recording rather than
papering over: **the agreement-creation engines guard their transitions far less than the settlement
engines do.**

`retire` accepts a clause version in any state, `approve` accepts a deviation in any state,
`invalidateOnChange` accepts a request in any state, and `revoke` accepts a certificate in any state. Each
can therefore be re-applied to a row already in the state it writes. Declaring those states terminal
would refuse calls the engines currently make and succeed at.

The three that are provable:

- `contract_template_versions` → `SUPERSEDED`. `publishTemplate` requires DRAFT and only ever supersedes
  a PUBLISHED row, so nothing updates a superseded one.
- `signature_packages_v2` → `COMPLETED`, `DECLINED`. `send` requires DRAFT and `callback` now refuses a
  closed package — a guard this batch added, see below.
- `negotiation_rounds` → `WITHDRAWN`, `ACCEPTED`. Also a guard this batch added.

**A near-miss worth naming: `agreement_approval_requests` has no terminal state, and a first draft made
`APPROVED` one.** That would have made it impossible to invalidate an approval when the document
changed — `invalidateOnChange` checks no status and is specifically meant to fire on an approved
request — defeating the `EXACT_APPROVED_DOCUMENT_REQUIRED` guarantee at the exact moment it matters most.

No state named in `BATCH_F_UNREACHED_STATES` is made terminal. A state nothing enters is a state there is
no evidence about, and inventing a refusal for one is how a future implementer inherits a constraint
nobody chose.

## Three engine defects found by reading before writing

The read-first step has now found a real defect in every one of the six batches.

1. **Callback replay was matched globally, not per workspace.** `DigitalExecutionEngine.callback` checked
   `.some(x => x.eventId === payload.eventId)` across every workspace. A provider event identifier is
   unique within the account it was issued for, not across every account the platform serves — so a
   reused identifier read as a replay, and **the replay path returns the package unchanged, silently
   dropping a real signature event.** Now scoped to the workspace, with
   `UNIQUE (tenant_id, workspace_id, event_id)` in the column.

2. **A declined signature package could be resurrected.** `callback` checked nothing about the package's
   status, so a stray SIGNED event arriving after a signatory declined would recompute the signer list,
   find nothing outstanding, and move the package to COMPLETED. Now refused with
   `SIGNATURE_PACKAGE_CLOSED`, after the replay check so a duplicate delivery of the closing event stays
   idempotent.

3. **An accepted negotiation round could be withdrawn.** Neither `withdraw` nor `accept` checked the
   status, so a settled negotiation position could be reversed after both parties had agreed it. Now
   refused with `NEGOTIATION_ROUND_CLOSED`.

Two blanket append-only triggers also contradicted their engines — `negotiation_rounds` and
`agreement_execution_certificates` are transitioned by `withdraw`/`accept` and `revoke` — so the trigger
would have refused every one of those the moment the collections were routed. Sixth and seventh instance
of that defect.

## Which aggregates are append-only, and the two reasons

The line is not "no engine updates it today". That is a fact about the current implementation, and
encoding it as a permanent database rule is exactly the defect above.

- **Nothing to transition.** `clauseInstances`, `contractComments` and `signatureCallbacks` have no
  status column. A row with no lifecycle cannot have one refused.
- **A boundary that already holds.** `documentVersions` and `approvalDecisions` have carried a blanket
  trigger since `202608030002` and no engine transitions either. `documentVersions` *does* declare a
  four-state lifecycle, so the case is not "it has no states" — it is that removing a constraint which
  currently holds, to accommodate a lifecycle nobody has implemented, is the same speculation as adding
  one, pointed the other way.

The reverse case is `agreements` and `approvalPolicies`: transitioned by nothing, but with no trigger
today, so making them append-only would invent a refusal their own declared states contradict. They are
governed instead — identity immutable, no DELETE, concurrency enforced, transitions permitted if and when
someone writes them. Both therefore have an `update` in the repository, because a store that refused what
the database permits would be a second, quieter boundary disagreeing with the first. The two sets are
cross-checked at module load.

## A correction to Batch E: the engine numbers were wrong

`batch-e.ts` assigned its six aggregates to **Engines 16–20**. `docs/ENGINE_CATALOG.md` and
`performance-blueprint`'s own unit tests both number Performance Blueprint, Scope Definition,
Deliverables, Milestone Planning and Definition of Done **21–25**; 16–20 are the contract-analysis
engines, which belong to `agreement-intelligence`.

The error was repeated across the schemas, the repository, the migration header, the activation document
and the durability register, and every one of those read consistently — because they were all copied from
the first mistake. The register's other four package attributions were wrong too, in both directions.

CLAUDE.md is explicit that the catalog is authoritative and no parallel catalog may be created. A
registry that assigns an aggregate to the wrong engine *is* a parallel catalog, and it is the
machine-readable one, so it is the one a later reader trusts. All of it is corrected, and
`packages/database-testing/src/engine-identity.test.ts` now parses the catalog and asserts every
registry against it — by engine **name**, because "does this number exist" was never going to fail: 16
exists, which is why the wrong number passed unnoticed through five artefacts. The guard was verified to
reproduce the original failure before being left green.

## A harness fix, because the gate was leaking databases

`DROP DATABASE … WITH (FORCE)` terminates whatever is still connected to the target, and a non-superuser
may only terminate backends belonging to a role it is a member of. The certification role is neither a
superuser nor a member of `pg_signal_backend`, so when PostgreSQL's own background workers are attached
at drop time, FORCE fails with `permission denied to terminate process` and **the database is leaked**.

A real race, not a theoretical one: it surfaced on a different suite each run while certifying this batch,
and had left nine databases behind. Every one dropped without FORCE on the first attempt, because the
harness's own connections were already closed and only a transient background worker stood in the way. So
the plain drop is now attempted first and FORCE is the fallback. Full suite: 282 passing, **zero leaks**.

## What was delivered

| Piece | Where |
|---|---|
| 15 canonical persisted-state Zod schemas | `packages/domain-contracts/src/batch-f.ts` |
| `revisionNumber` and `sha256Hex` primitives | `packages/domain-contracts/src/primitives.ts` |
| 15 compile-time conformance assertions | `packages/agreement-creation/src/persisted-contracts.test.ts` |
| 15 relational repositories | `packages/database/src/batch-f-repository.ts` |
| Store routing for all 15 collections | `packages/database/src/postgres-store.ts` |
| Convergence of 13, creation of 2, invariants, digest chain, boundaries | `supabase/migrations/202608110005_wave6_batch_f_agreement_creation.sql` |
| Readiness requirement for the 15 tables | `packages/database/src/migrations.ts` |
| 3 engine defect fixes and their tests | `packages/agreement-creation/src/index.ts` |
| 28 live-PostgreSQL certification tests | `packages/database-testing/src/wave6-batch-f-repository.postgres.test.ts` |
| Canonical engine identity guard | `packages/database-testing/src/engine-identity.test.ts` |
| Baseline ratcheted 61 → 46, chain census 10 → 11 of 11 | `packages/database-testing/src/durability-coverage.test.ts` |
| Teardown that does not leak on a missing privilege | `packages/database-testing/src/index.ts` |

## What is not claimed

- **Four cross-row rules of the form "the cited parent must *currently* be in state X" are not
  enforced** — an APPROVED approval request, a PUBLISHED clause version, a PUBLISHED template version. A
  foreign key can carry a value across tables, which is how the digest chain works, but it cannot require
  a current status: the parent's status changes after the child is written, and in the approval case
  `invalidateOnChange` exists precisely to change it. Putting the status in the key would force it to be
  updated in lockstep, which is a worse rule than the engine's.
- **The mutual reference between a draft and its document version has no foreign key on one side.**
  `agreement_document_versions.draft_id` and `agreement_drafts.current_document_version_id` name each
  other, and `createDraft` appends the document version before the draft exists — two separate `append`
  calls — so that side cannot be a foreign key without being deferrable, and a deferred constraint only
  helps inside a transaction the store is never told about. The same absence means a crash between the
  two appends leaves an orphan document version.
- **`approvalRequests.completedSteps` is not bounded by the policy's step count.** `decide` reads
  `p.steps[r.completedSteps]` and refuses when the step does not exist; the bound lives in another
  table's JSONB array length, which no column constraint can reach.
- **Seven of the ten governed tables have no terminal state**, because their transition methods check
  nothing about the current status. Tightening five engines' status guards is a domain change rather than
  a persistence one, so it is recorded in `POST_WAVE_5_FOLLOWUPS.md` rather than done here.
- **No optimistic concurrency at the application boundary.** Unchanged from every prior batch.
- **Forty-six collections remain unmapped**, and the coverage gate holds that number as a ceiling.
- **No historical migration is modified** — `202608110005` is forward-only and additive. The one edit to
  `202608110004` is the engine-number correction in its header comment, on an unmerged migration that has
  only ever been applied to ephemeral test databases.

## Evidence

- 28 live-PostgreSQL tests: the chain closed and 56 tables required, TEXT identity and FORCE on all
  fifteen, the two created tables absent from every earlier migration, 132 CHECK constraints where there
  were none, the populated-table refusal leaving the schema untouched, exact round-trip of all fifteen
  aggregates, the four renamed columns in both directions, an optional reference absent rather than null,
  all three digest-chain foreign keys refusing a mismatch and the matching digest accepted, a non-digest
  hash refused through the store *and* a direct statement, the row counter advancing while a revision
  does not, the draft's own version advancing, a refused revision change, a refused non-advancing write
  naming `row_version`, a refused change to an approval's digest, three terminal-state refusals, refused
  DELETEs, append-only enforced in store and database for all five, the clause citation pairing, the
  locked-draft implication in both directions, empty step and signer lists, a self-superseding version, an
  unknown status, a zero round number, a negative step, workspace-scoped callback replay, a cross-tenant
  parent reference, and cross-tenant invisibility.
- 6 unit tests and 15 compile-time conformance proofs in `agreement-creation`, including the three engine
  defect fixes.
- 4 canonical engine identity tests, verified to fail on the original Batch E numbering.
- Full gates: typecheck 0, lint clean, **820** default, **282** PostgreSQL, `repo:certify` 11/11, zero
  harness leaks.

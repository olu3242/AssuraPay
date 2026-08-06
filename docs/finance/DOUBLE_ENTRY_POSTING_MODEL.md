# Double-entry posting model

**Status: ACCEPTED.** Owner decision. Governs the financial ledger for canonical Engine 48
(Reconciliation & Financial Ledger) and every engine that posts through it.

Deferred to Wave 5 — nothing here is implemented. It is recorded now because the gap matrix
measured that **double-entry integrity is currently enforced nowhere**, and the mechanism is a
decision rather than a discovery.

## The decision

Balance is enforced **transactionally, by PostgreSQL**: a governed posting procedure plus deferred
balance validation. Application-layer balance checks are supplementary and are **never the source
of truth**.

The reason is stated in the gap matrix: a row-level `CHECK` constraint cannot prove that debits
equal credits, because balance is a property of a *set* of rows. Any mechanism that checks balance
outside the transaction can be bypassed by a direct write, a partial insert, or a later mutation.

## Structures

Repository-native names where equivalent tables exist — `ledger_entries` already exists and is
already correctly typed. Canonical engine identities are not renamed.

**Journal transaction (header):** transaction identity, tenant, currency, posting status,
correlation and causation identity, source aggregate linkage, reversal linkage, idempotency
identity, created and posted timestamps.

**Journal entry (line):** line identity, transaction identity, account identity, tenant, currency,
debit-or-credit side, amount in minor units.

## Posting authority

All posted lines for one transaction are created through **one governed PostgreSQL posting
operation**. Direct arbitrary insertion of posted rows by a runtime application role is
**prohibited** — enforced by table privileges, not by convention.

The operation, in order:

1. validate tenant scope
2. validate journal identity and idempotency
3. validate every referenced account and source aggregate
4. validate every line's currency against the supported set
5. validate positive line amounts
6. validate debit-or-credit classification
7. validate balancing **independently per currency**
8. insert header and lines atomically
9. mark posted only after validation succeeds
10. create audit and outbox linkage in the same transaction
11. return the authoritative posted identity and version
12. roll back everything on any failure

## Balance enforcement

Both mechanisms, preferring the strongest the repository supports:

- a governed stored posting function with **restricted table privileges**, so the application role
  can call the function but cannot insert posted rows directly; and
- a **deferred constraint trigger** validating total debits equal total credits per transaction and
  per currency, at commit.

Deferred is the essential property. A non-deferred trigger fires on the first line, when the
transaction is legitimately unbalanced, so it must either reject valid postings or be written to
ignore the case it exists to catch.

The deferred validation must defeat: incomplete multi-line inserts, direct table writes, later
mutation, currency mixing, line deletion, and header finalisation before balance.

## Immutability

Once posted: lines cannot be updated, lines cannot be deleted, and the header cannot be materially
altered. Reversal is a **new balanced journal** linked to the original, and the original stays
visible and authoritative as history. Enforced by database permissions, triggers, or both — the
existing `ledger_entries_append_only` trigger is the right shape and currently protects a table
nothing writes.

## Draft state

**Prefer no persisted draft journal state.** If canonical engine behaviour proves a requirement,
then draft lines are not economic postings, must not affect balances, must not be exposed as
finalised ledger facts, must still post through the governed operation, and abandoned drafts need
explicit lifecycle handling.

## Required live-PostgreSQL tests

Each must fail before the mechanism exists and pass after — a test that cannot fail is not
evidence.

balanced posting succeeds · unbalanced posting fails **at commit** · balance enforced per currency
· zero or negative lines fail · duplicate idempotency is safe · same key with a different payload
fails · partial insertion rolls back · posted line update fails · posted line delete fails ·
header mutation fails · reversal creates a new balanced journal · original posting stays immutable
· cross-tenant account linkage fails · runtime roles cannot bypass the posting procedure ·
administrative roles remain explicitly governed

## Non-custody

The posting model records obligations and movements instructed through a licensed provider. It
does not, and must not, imply that AssuraPay holds or controls funds. **If any part of
implementation would require custody, that is a stop-and-report condition, not a design choice.**

## Prohibited shortcuts

A row-level `CHECK` presented as balance enforcement. A non-deferred balance trigger. Balance
checked only in the application. `GRANT INSERT` on posted journal tables to the runtime role. A
reversal that edits the original. A mutable `balance` column treated as authoritative instead of
derived from entries.

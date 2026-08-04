# Execution Ledger

Append-only history of REOS executions. Each `*.json` file is one execution
record, written by `pnpm repo:report`. `INDEX.md` is generated from those records.

## Rules

- **Append-only.** An entry is never rewritten or deleted. This mirrors CLAUDE.md
  hard constraint 3: history is appended to, never mutated in place.
- **Identity is `commit + capability`.** Re-running `repo:report` for the same
  execution appends nothing, so the ledger cannot accumulate duplicates.
- **`INDEX.md` is derived.** It is regenerated on every append; edit nothing here
  by hand.

## Entry fields

| Field | Meaning |
|---|---|
| `entryId` | `<commit-prefix>-<capability>` |
| `recordedAt` | when the execution was recorded |
| `capabilityId` | capability declared via `--capability`, or `null` |
| `lifecycle` | the capability's lifecycle at the time of recording |
| `branch` | branch the execution ran on |
| `commit` | HEAD at the time of recording |
| `manifestDigest` | digest of the execution manifest that was read |
| `validation` | per-validator pass/fail with error and warning counts |
| `certification` | availability, outcome and failing step ids |
| `supersedes` | capabilities already complete when this execution ran |

Because artifacts are generated before the commit that contains them, `commit` is
the state the execution observed — not the commit the entry ships in.

# Repository Execution Operating System (REOS)

REOS is the execution workflow that governs every AI implementation session on
this repository. It exists so that a future session depends on **repository
evidence**, never on a previous conversation.

REOS is infrastructure for AI execution. It contains no business functionality
and owns no domain logic.

## Why it exists

Long conversational prompts do not survive a context window, a session limit or
a new machine. The repository does. REOS moves the execution process into the
repository itself: discovery, investigation, planning, certification and
reporting are all commands with committed, machine-readable outputs.

Once REOS is in place, a session prompt can be as short as:

> Run `pnpm repo:next`, implement the selected capability, certify it, and update the manifest.

## The seven stages

| Stage | Command | Output | Determinism |
|---|---|---|---|
| 1. Discovery | `pnpm repo:discover` | `generated/discovery.json` | deterministic |
| 2. Forensics | `pnpm repo:forensics` | `generated/forensics.json` | deterministic |
| 3. Manifest | `pnpm repo:manifest` | `generated/execution-manifest.{json,md}` | deterministic |
| 4. Dependency resolution | `pnpm repo:dependencies` | `generated/dependency-resolution.{json,md}` | deterministic |
| 5. Implementation | — | your code | governed by `EXECUTION_CONTRACT.md` |
| 6. Certification | `pnpm repo:certify` | `generated/certification.{json,md}` | observational |
| 7. Execution report | `pnpm repo:report` | `generated/execution-report.{json,md}` + a ledger entry | observational |

`pnpm repo:governance` evaluates the staged reconciliation policy on its own.

Stages 1–4 are pure functions of repository state: the same state produces
byte-identical artifacts, so a diff in those files always means the repository
changed, never that the tool is noisy. Stages 6–7 record measurements and
therefore carry timestamps and durations.

## The pipeline

```
repo:discover → repo:forensics → repo:manifest → repo:dependencies
      → implementation → repo:certify → repo:report → repo:next
```

`pnpm repo:pipeline` runs stages 1–7 in one pass. `pnpm repo:next` runs stages
1–4 and prints the selected capability — that is the command a session starts
with. **No implementation may begin before discovery and dependency resolution.**

## Stage 1 — Repository discovery

Snapshots repository metadata, git state, workspace packages, applications, the
engine catalog, certification scripts, runtime registrations, documentation,
ADRs, migrations, tests and CI workflows.

Two derived facts matter most:

- **unregistered engines** — engine classes exported by a package but never
  instantiated in an application composition root, so unreachable at runtime;
- **duplicated engines** — the same engine class name exported by two packages.

## Stage 2 — Repository forensics

For each capability in `capability-registry.json`, REOS runs path, symbol and
test probes against HEAD, then — only when HEAD is incomplete — searches git for
the capability elsewhere. That distinction produces six statuses:

| Status | Meaning |
|---|---|
| `implemented` | every probe satisfied at HEAD |
| `partial` | some probes satisfied at HEAD |
| `missing` | no evidence at HEAD, on any ref, or in history |
| `lost` | absent at HEAD, but commits in history touched it |
| `unreachable` | present on a ref that is not merged into HEAD |
| `deferred` | declared out of scope by the engine catalog |

`lost` and `unreachable` are the statuses that matter after an interrupted
session: they tell a new agent that work exists somewhere and must be recovered
rather than rewritten.

### Capability lifecycle

Status answers *what does the evidence show*. Lifecycle answers *how far along is
it*, and is derived — never declared:

```
missing → planned → implementing → implemented → validated → certified → released
```

| Lifecycle | Derived from |
|---|---|
| `missing` | no evidence, and dependencies are unmet |
| `planned` | no evidence, dependencies met, so work can start now |
| `implementing` | some evidence probes satisfied |
| `implemented` | every probe satisfied |
| `validated` | implemented, and the test gates covering it are green |
| `certified` | validated, and the full `repo:certify` run is green |
| `released` | certified, and the evidence is present on the default branch |
| `deferred` | declared out of scope by the engine catalog |

`lost` and `unreachable` surface as lifecycle `missing`, because at HEAD nothing
is built. The status field is what tells an agent the work is recoverable.

Because `validated` and above depend on the last certification run, they are read
from the committed `certification.json` — itself repository state, which keeps the
manifest a pure function of the repository.

## Stage 3 — Execution manifest

`execution-manifest.json` is the authoritative execution input. It carries
repository identity, architecture, packages, applications, engine
reconciliation, runtime registrations, platform capabilities, the dependency
graph, the execution backlog and reconciliation findings.

**Engine reconciliation** compares what `docs/ENGINE_CATALOG.md` *declares*
against what the repository *shows*. Observed status is derived from evidence
alone: a package exists, it carries tests, and a certification script is wired
to it. Every disagreement becomes a finding rather than being silently resolved
in favour of either side.

## Stage 4 — Dependency resolution

Selects the single highest-priority executable capability, under four rules:

1. never duplicate completed work,
2. never violate dependencies,
3. never bypass certification,
4. never select blocked work.

Work requiring live infrastructure is deprioritised behind work that can be
completed offline, but remains selectable when nothing else is available. Every
rejection is recorded with its reason, so the choice is auditable.

## Stage 5 — Implementation

Governed by [`EXECUTION_CONTRACT.md`](./EXECUTION_CONTRACT.md). Placeholders,
TODOs and duplicate abstractions are rejected by the contract validator.

## Stage 6 — Certification

One runner executes every gate: lint, typecheck, unit, integration and E2E
tests, architecture validation, dependency validation, security validation and
the production build. Command steps reuse the repository's existing scripts;
validator steps run in-process.

The three validators encode this repository's hard constraints:

- **architecture** — package boundaries, alias wiring, the trust-foundation
  boundary for engines 01–05, and the rule that `AssuraPayService` must not
  absorb trust-engine logic;
- **dependencies** — declared dependencies match real imports, the workspace
  graph is acyclic, and every engine package is reachable;
- **security** — no custody primitive, no unconditional release path, no
  in-place mutation of append-only history, no committed secrets;
- **governance** — the staged reconciliation policy, below.

### Staged governance

Reconciliation findings are not advisory forever. `governance-policy.json` sets a
phase:

| Phase | Behaviour |
|---|---|
| 1 | report only; findings never fail certification |
| 2 | findings absent from the baseline fail; baselined ones warn |
| 3 | every finding fails; the baseline is ignored |

The repository runs **phase 2**: the 16 findings present when REOS landed are
baselined, so existing development is not blocked, while any *new* violation of
the same rules fails certification immediately.

Findings are baselined by `rule:subject`, not by message text, so rewording a
finding never silently moves it in or out of the baseline. When a violation is
fixed, its baseline entry becomes stale and REOS says so — that is the signal to
delete the entry, which is how phase 2 ratchets toward phase 3 without a flag day.

```bash
pnpm repo:governance                    # evaluate the policy
pnpm repo:governance --accept-baseline  # record current findings as pre-existing
```

Advancing to phase 3 means fixing the remaining baselined violations and then
setting `"phase": 3`. Individual rules can be exempted with a stated reason via
`exemptRules`, which demotes them to informational at every phase.

## Stage 7 — Execution report

Repository state, capability implemented and its lifecycle, files modified,
validation results, governance evaluation, certification outcome, remaining
backlog, recommended next capability, ledger entry id and commit SHA.

### Execution ledger

Stage 7 also appends to `docs/governance/execution-ledger/` — the durable history
of repository evolution. One immutable JSON file per execution, plus a generated
`INDEX.md`. Each entry records the timestamp, capability, lifecycle, branch,
commit, manifest digest, validation outcome, certification outcome and the
capabilities the execution superseded.

The ledger is append-only, in the same spirit as CLAUDE.md hard constraint 3.
Entry identity is `commit + capability`, so re-running `repo:report` for the same
execution appends nothing and rewrites nothing. The manifest digest ties an entry
to the exact manifest that execution read.

## Requirements

REOS runs on Node >= 22.18 using native TypeScript type stripping. It has **no
runtime dependencies** and no build step, so it works in a freshly cloned
repository before anything is installed.

## Artifacts

Generated artifacts live in [`generated/`](./generated) and are committed, because
they are the interface a future agent reads. Set `REOS_ARTIFACT_DIR` to redirect
them for a dry run.

Artifacts are always generated *before* the commit that contains them, so the
`head` they record is the preceding commit. Treat `head` as "the state REOS
observed", not "the commit this file ships in".

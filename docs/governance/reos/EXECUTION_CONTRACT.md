# REOS Execution Contract

Stage 5 of the [Repository Execution Operating System](./README.md). Every
implementation admitted to this repository satisfies this contract. It is
enforced mechanically by the `contract` validator inside `pnpm repo:certify`.

## Scope

The contract governs **the files a session changed** — the working tree plus any
commits ahead of the comparison base (`origin/main`, then `main`, then
`origin/master`). Pre-existing debt is reported but does not block new work; new
work is held to the full standard.

## What every implementation must include

| Element | Requirement |
|---|---|
| Interfaces | Types and contracts declared before implementation, mirroring `docs/DATA_SCHEMA.md` where money or aggregates are involved |
| Implementation | Complete behaviour, no partial paths |
| Dependency registration | Declared in the package's `package.json` using `workspace:*` |
| Lifecycle integration | Instantiated in an application composition root, or explicitly documented as library-only |
| Configuration | Read from configuration, never hardcoded |
| Telemetry | State transitions emitted through the existing audit/event surface |
| Logging | Failures surfaced with a stable error code, not a bare string |
| Metrics | Counters or durations where the capability has an SLO |
| Tests | At least one test in the owning package, and updated tests in the same change |
| Documentation | Updated when the change alters an engine's scope, a schema, or a public command |

## What is rejected

The contract validator fails the build on any of the following in changed files.

### Placeholders and markers

`TODO`, `FIXME`, `XXX`, `HACK`, "placeholder", "not implemented", "coming soon".

A file that must legitimately contain these words — a rule definition, or a test
that exercises the rule — declares the token `reos:rule-vocabulary` in a comment.
Grep for that token to audit every exemption. The same token exempts a file from
the plaintext-secret rule, for the same reason. It never exempts a file from the
custody, unconditional-release or audit-mutation rules, which match real call
sites rather than vocabulary. It is not a general escape hatch: using it to
smuggle in unfinished work defeats the contract.

### Incomplete implementations

`throw new Error('... not implemented ...')` in any form.

### Untested packages

A modified package with no test files at all fails. A modified package whose
tests were not also modified produces a warning — enough to notice, not enough
to block a pure refactor.

### Money-movement changes without a non-custody assertion

CLAUDE.md requires that every PR touching money-movement logic includes or
updates tests for the non-custody constraint. Changing
`packages/settlement-assurance` or `packages/settlement-execution` without
touching its non-custody suite is an error.

### Duplicate abstractions

The same engine class exported by two packages. Reported by
`runtime/duplicate-abstraction` in the manifest and by architecture validation.

### Unregistered engines

A new `*Engine` export not instantiated in any composition root produces a
warning: it is unreachable at runtime and probably incomplete.

## Hard constraints that outrank this contract

From `CLAUDE.md`. The security validator enforces these repository-wide, not just
on changed files:

1. **No custody, ever.** No code path may define or call a custody primitive.
   The forbidden set is `holdFunds`, `takeCustody`, `debitAccount`,
   `creditAccount`, `transferFunds`, `poolFunds`, `sweepFunds`, `commingleFunds`.
   Money movement happens through the certified Financial Provider's own API via
   a Provider Adapter.
2. **Every release is certified-work-backed.** No unconditional release path may
   exist: `forceRelease`, `releaseNow`, `releaseWithoutCertificate`,
   `skipCertificate`, `bypassEligibility`, `overrideHold` are all rejected.
3. **Full audit trail.** Append-only history is never mutated in place. Calling
   `splice`, `pop`, `shift`, `reverse` or `sort` on an audit, history, event,
   ledger or outbox collection is an error.
4. **Naira-first, integer minor units.** Money fields are integer kobo.

## Definition of done

A capability is done when all of the following hold:

- [ ] `pnpm repo:certify` is green end to end
- [ ] the capability's evidence probes in `capability-registry.json` are satisfied
- [ ] `pnpm repo:manifest` shows it as `implemented`
- [ ] `pnpm repo:report --capability=<id>` is written
- [ ] documentation updated where the change alters declared scope

If a capability cannot be completed — for example it requires infrastructure that
is not configured — do not partially implement it. Record the blocker and select
the next capability. A partial implementation that reports as `partial` forever
is worse than an honest `missing`.

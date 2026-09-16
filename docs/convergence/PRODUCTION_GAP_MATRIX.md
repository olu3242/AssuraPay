# Production gap matrix

Run: production-gaps-20260915. Evidence is provisional until final certification.

## Baseline and preserved work

Original checkout: `claude/git-pull-cqc04u`, `ccd19b83f84fee7d80148b77cc0e04105b1e2c2e`.
It had an unfinished merge of `7e49a2c8a66ab68834ab30f2c89ea63c985d7285`, staged Flow OS work,
uncommitted landing-page work and modified governance artifacts. Those user changes remain in place.

Convergence worktree: `C:/Cdev/AssuraPay/AssuraPay-production-gaps`.
Branch: `feat/production-gaps-single-batch`. Base: remote main `7e49a2c8a66ab68834ab30f2c89ea63c985d7285`.
Node `v24.16.0`; pnpm `11.3.0`; 49 baseline SQL migrations.

The three original local trust/CI commits were replayed, preserving both `trustAssessments` and
Flow OS collections. Existing PR 41 authentication/agreement/performance work, PR 43 certification
bindings and PR 48 operations UI were recovered through cherry-picks. Recovery is not certification.
PR 50 escrow compilation references `agreements` and `agreementVersions`; these require reconciliation
against the canonical contract model before adoption. PR 51 intake is also unmerged and unproven here.

## Measured unchanged baseline

| Gate               | Original checkout                                                              | Reconciled baseline before implementation                          |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Frozen install     | Pass                                                                           | Pass                                                               |
| Lint               | Fail: merge marker                                                             | Pass                                                               |
| Typecheck          | Fail: 3 merge-marker diagnostics                                               | Pass                                                               |
| Unit               | Merge markers prevent collection                                               | 104 files, 935 tests passed                                        |
| Integration filter | 58 files failed, 12 passed, 34 skipped; 1 failed, 35 passed, 476 skipped tests | 15 files passed, 89 filtered; 38 passed, 897 filtered tests        |
| Engine E2E filter  | Merge markers prevent collection                                               | 15 files passed, 89 filtered; 22 passed, 913 filtered tests        |
| Production build   | Fail: merge markers                                                            | Pass                                                               |
| PostgreSQL         | Not configured                                                                 | 29 files failed; 1 failed test; missing test database              |
| Browser            | Not configured                                                                 | Config refused missing `ASSURAPAY_TEST_DATABASE_URL`; no tests ran |

Filtered test counts above come from the existing name-filter scripts; they are not evidence of
critical-suite coverage. The original parallel baseline also saw a discovery determinism failure
while other tools changed Git refs; the sequential isolated baseline passed that test.
Logs live under `artifacts/convergence/*.log` locally.

## Capability evidence

| Capability                                     | Initial status   | Current evidence / remaining work                                                                                                |
| ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Possession authentication                      | PARTIAL          | PR 41 recovered; production direct return, concurrency, rate limiting and service-level issuance need hardening                  |
| Email and transactional notifications          | MISSING          | No production transport in baseline                                                                                              |
| Serious seller / dedicated buyer qualification | MISSING          | No canonical lifecycle or captured qualification policy                                                                          |
| Persona controls                               | PARTIAL          | Existing named canonical grant compositions; additional personas and transaction denial proofs needed                            |
| Legal policy version tenancy                   | PARTIAL          | Versions lack explicit parent scope in persisted payload                                                                         |
| Runtime readiness                              | PARTIAL          | Package-relative migration resolver and absolute override added; durable schema/migration bypass now refused; focused tests pass |
| Deployment migration command                   | PARTIAL          | Existing governed runner wired to command; live execution unproven                                                               |
| Payment provider                               | PARTIAL          | Deterministic gateways only; external adapter and callback certification needed                                                  |
| Browser workflow                               | PARTIAL          | Recovered agreement, performance and operations consoles; full chain unproven                                                    |
| Golden transaction                             | MISSING          | No complete browser-to-provider-to-reconciliation proof                                                                          |
| Failure/recovery                               | PARTIAL          | Existing domain tests and recovered operations; complete denial matrix outstanding                                               |
| Observability                                  | PARTIAL          | Runtime evidence/audit and Flow OS diagnostics exist; production metrics/runbooks outstanding                                    |
| Deployment                                     | EXTERNAL_BLOCKER | Deployment not authorized; no deployment smoke proof                                                                             |
| Live database                                  | EXTERNAL_BLOCKER | Connected Supabase shows Velocity projects only; AssuraPay target unresolved                                                     |

No production-convergence completion claim is supported by this baseline.

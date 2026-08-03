# Platform Build & Dependency Governance Certification

## Certification decision

The AssuraPay build runtime is certified for the recovered Engines 61–70 merge baseline.

## Evidence

| Gate | Result |
| --- | --- |
| pnpm version | Pinned and executed with 11.3.0 |
| Workspace discovery | Passed — 22 projects |
| Build-script policy | Passed — explicit `esbuild` and `unrs-resolver` allowlist |
| Frozen install | Passed — lockfile current, no ignored build scripts |
| Typecheck | Passed — `pnpm typecheck` |
| Lint | Passed — `pnpm lint` |
| Tests | Passed — 53 files, 123 tests |
| Production build | Passed — Next.js, 93 static pages |
| CI configuration | pnpm 11.3.0, Node 20, frozen lockfile, all four gates |

## Reproducibility invariants

- the package manager, workspace projects, local package resolution, direct dependencies, build-script approvals, and lock graph are explicit;
- no application relies on npm root hoisting for internal imports;
- private workspace packages cannot fall through to the public registry;
- CI fails on lockfile drift or unapproved dependency scripts;
- certification must be repeated after dependency, pnpm, Node, build-policy, workspace, or CI changes.

## Residual gates

This certification covers dependency installation and application validation. It does not replace production container, deployment target, software-composition analysis, vulnerability scanning, artifact signing, or provenance attestation.

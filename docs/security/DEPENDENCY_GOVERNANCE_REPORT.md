# Dependency Governance Report

## Authoritative model

`pnpm-lock.yaml` is the deterministic install graph for the pnpm workspace. `packageManager` pins the CLI. `pnpm-workspace.yaml` declares project discovery, local linking, and build-script approvals. Package manifests declare every directly imported internal package using `workspace:*`.

## Controls

- CI rejects lockfile drift with `--frozen-lockfile`.
- Private `@assurapay/*` dependencies resolve only to local workspace packages and are never fetched from the public registry.
- Strict dependency isolation prevents undeclared transitive imports.
- Application packages own their direct runtime dependencies.
- Build scripts are deny-by-default with two reviewed exceptions.
- The lockfile records integrity hashes for registry artifacts.

## Findings retained for later maintenance

- ESLint 8 and six transitive packages report upstream deprecation warnings. They do not block current certification but require a planned toolchain upgrade.
- The repository retains `package-lock.json` for historical compatibility, while CI now certifies pnpm. A later focused migration may remove dual-lock ambiguity after confirming all deployment systems use pnpm.
- Local certification used Node 24.16.0; GitHub Actions remains pinned to the supported Node 20 line and runs the same pnpm/frozen-lock gates.

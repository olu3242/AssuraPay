# AssuraPay Build Runtime Report

## Scope

This report covers the build-runtime investigation performed after recovery of the local Engines 61–70 merge. No application behavior was changed.

## Root causes

1. `pnpm-workspace.yaml` contained unresolved string placeholders for `esbuild` and `unrs-resolver` build approval.
2. The repository did not pin a package-manager version.
3. pnpm workspace package globs and local-link policy were absent, so only the root importer was recognized.
4. GitHub Actions used npm and therefore did not exercise the pnpm lockfile or build-script policy.
5. `eslint.config.mjs` directly imported undeclared `@eslint/eslintrc`; npm hoisting had masked it.
6. The web application and internal packages imported workspace packages without declaring them. npm root hoisting masked these manifest defects; pnpm strict linking exposed them.

## Resolution

- pinned `pnpm@11.3.0` in `package.json`;
- explicitly approved only `esbuild` and `unrs-resolver` build scripts;
- declared `apps/*` and `packages/*` as pnpm workspace projects;
- enabled local workspace linking and converted internal dependencies to `workspace:*`;
- declared the web application's direct Next/React and internal package dependencies;
- declared `@eslint/eslintrc@2.1.4` as a root dev dependency;
- regenerated the complete lockfile for all 22 workspace projects;
- changed CI to pnpm 11.3.0 with a frozen-lockfile install under Node 20.

## Outcome

The build runtime installs noninteractively, links private packages locally, rejects stale locks in CI, executes only approved dependency scripts, and passes all repository validation gates.

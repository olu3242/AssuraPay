# pnpm Build-Script Policy Report

## Policy

AssuraPay pins pnpm 11.3.0 and uses an explicit allowlist:

```yaml
allowBuilds:
  esbuild: true
  unrs-resolver: true
```

All other dependency lifecycle scripts remain denied unless reviewed and added through a certified change.

## Approved packages

- `esbuild@0.21.5` supplies the platform-specific binary required by Vite/Vitest tooling. Its install script verifies/selects the binary for the current platform.
- `unrs-resolver@1.12.2` supplies native resolver bindings used by the Next/ESLint resolution toolchain. Its install script selects the supported binding.

Both packages are integrity-pinned through `pnpm-lock.yaml`. Approval is by package identity; version changes still require lockfile review and full certification.

## Enforcement

- local development and Claude Code use the pinned package manager;
- GitHub Actions installs with `pnpm install --frozen-lockfile`;
- an unapproved build script fails rather than being silently executed;
- no `ignore-scripts`, blanket build approval, or security bypass is configured.

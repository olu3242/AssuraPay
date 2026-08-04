# REOS Agent Protocol

How an AI session executes work on this repository. Read this first; it replaces
the long implementation prompts that earlier sessions depended on.

## The short version

```bash
pnpm repo:next                              # what should I build?
# ... implement exactly that capability ...
pnpm repo:certify                           # is it correct?
pnpm repo:report --capability=<id>          # record what happened
```

## Rules

1. **Never start from memory.** A prior conversation is not evidence. Run
   `pnpm repo:next` and read `generated/execution-manifest.json`.
2. **Never implement what was not selected.** Stage 4 chose one capability. Build
   that one. If you disagree with the selection, change
   `capability-registry.json` and re-run stage 4 — the registry is the place to
   argue, not the implementation.
3. **Never trust a status you did not verify.** If the manifest says a capability
   is `implemented`, its evidence probes passed. If it says `lost` or
   `unreachable`, the work exists in git and must be recovered, not rewritten.
4. **Never fabricate a certification.** If a gate cannot run because
   infrastructure is missing, report it as blocked and name the missing
   configuration.
5. **Never commit with a red certification.** `pnpm repo:certify` must be green.

## Resuming an interrupted session

This is the case REOS was built for. The previous session's context is gone.

```bash
pnpm repo:discover     # is the worktree clean? what is HEAD?
pnpm repo:forensics    # is the expected work present, lost, or unreachable?
```

Then read `generated/forensics.json`:

- **`implemented`** — the work landed. Move on.
- **`partial`** — some evidence exists. Read the probe list to see exactly which
  files and symbols are missing, and finish those.
- **`lost`** — the symbol appears in history but not at HEAD. Recover it:
  `git log --all -S<symbol>` gives you the commits.
- **`unreachable`** — the work is on a ref that is not merged. `refsContaining`
  names the ref. Merge or cherry-pick; do not rewrite.
- **`missing`** — never built. Implement it.

If the expected work is absent from the repository entirely, it was never
committed. Say so plainly rather than reimplementing it from a description —
reimplementation silently discards whatever the original actually did.

## Adding a capability to the registry

`capability-registry.json` is the contract between planning and evidence. A
capability needs:

```jsonc
{
  "id": "domain.capability-name",
  "title": "Human readable name",
  "kind": "platform",
  "priority": 20,                    // lower runs first
  "dependsOn": ["other.capability"], // must be implemented first
  "evidence": {
    "paths":   ["packages/x/src/thing.ts"],       // files that must exist
    "symbols": ["ExportedName", "functionName"],  // identifiers that must appear
    "tests":   ["packages/x/src/thing.test.ts"]   // tests that must exist
  },
  "certify": "certify:x",
  "requiresLiveInfrastructure": false
}
```

Write evidence you can actually satisfy. Probes are the definition of done: a
capability is `implemented` exactly when every probe passes, so vague evidence
produces a meaningless status.

## Certification gates

| Gate | What it proves |
|---|---|
| `lint` | style and correctness rules |
| `typecheck` | the whole project typechecks |
| `test:unit` / `test:integration` / `test:e2e` | behaviour |
| `architecture` | package boundaries and the trust-foundation rule |
| `dependencies` | declared dependencies match real imports; graph is acyclic |
| `security` | non-custody, certified-release, audit-immutability |
| `contract` | no placeholders, tests present, non-custody test updated |
| `build` | the application builds for production |

Run a subset while iterating:

```bash
pnpm repo:certify --only=architecture,dependencies,security,contract   # fast, in-process
pnpm repo:certify --skip=build                                         # everything but the build
```

## Live infrastructure

Capabilities marked `requiresLiveInfrastructure` cannot be certified without
credentials. They are deprioritised automatically and listed under
`awaitingInfrastructure` in `dependency-resolution.json`.

`persistence.postgres-repository` and `persistence.rls-certification` need
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY`. Without them, report those certifications as blocked
and name the missing variables. Do not simulate a result.

## Committing

Group commits by capability, never by file type. A commit that mixes an engine
change with a REOS change is two commits.

Regenerate artifacts before committing so the manifest reflects the state you are
committing:

```bash
pnpm repo:manifest
pnpm repo:report --capability=<id>
```

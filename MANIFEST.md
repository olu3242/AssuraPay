# AssuraPay Package Manifest

This folder is the single harmonized source package for AssuraPay.

## Root

- `README.md` — product and package overview
- `CLAUDE.md` — Claude Code working agreement and implementation constraints
- `package.json` — Next.js project manifest
- `landing-page.html` — standalone landing-page prototype

## Product documentation

- `docs/PRD.md`
- `docs/BRD.md`
- `docs/ARCHITECTURE.md`
- `docs/ENGINE_CATALOG.md`
- `docs/DATA_SCHEMA.md`
- `docs/AI_STRATEGY.md`
- `docs/GTM.md`

## Execution governance

- `docs/governance/reos/README.md` — Repository Execution Operating System
- `docs/governance/reos/AGENT_PROTOCOL.md` — how an AI session executes work
- `docs/governance/reos/EXECUTION_CONTRACT.md` — Stage 5 implementation contract
- `docs/governance/reos/capability-registry.json` — capability evidence rules
- `docs/governance/reos/governance-policy.json` — staged reconciliation enforcement
- `docs/governance/execution-ledger/` — append-only execution history
- `docs/governance/reos/generated/` — generated execution artifacts
- `packages/reos/` — REOS implementation and `repo:*` command surface

## Supporting architecture

- `agents/agents.md`
- `diagrams/architecture-diagram.svg`

The previous nested ZIP files and duplicate root files are intentionally excluded. This folder should be treated as the authoritative AssuraPay architecture package.

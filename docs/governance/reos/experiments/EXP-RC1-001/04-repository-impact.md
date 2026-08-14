# EXP-RC1-001 — Repository Impact

## Decision

Integrate product-intent evidence **into REOS**. Do not create a parallel `.ai` operating system.

## REUSE

- `CLAUDE.md` as the top-level AI working agreement.
- `docs/governance/reos/AGENT_PROTOCOL.md` as the execution protocol.
- `docs/governance/reos/EXECUTION_CONTRACT.md` as the implementation contract.
- `docs/governance/reos/capability-registry.json` for capability/dependency/evidence definitions.
- `docs/governance/reos/generated/execution-manifest.json` for repository-derived execution state.
- `docs/governance/execution-ledger/` for append-only execution history.
- `pnpm repo:next`, `repo:certify`, `repo:report`, and `repo:pipeline` for execution and verification.
- Existing Vitest, PostgreSQL, Playwright, architecture, dependency, security, governance, and build gates.

## EXTEND

- REOS documentation with a product-experiment evidence model.
- RC1 convergence with explicit problem, workflow, E2E, adversarial-review, and impact artifacts.
- Future REOS validation so experiment status can be checked mechanically without allowing experiment prose to override repository evidence.

## ADD

- `docs/governance/reos/experiments/`.
- Machine-readable `status.json` per material experiment.
- Before/after workflow evidence.
- Human/AI/software/hybrid capability mapping.
- Independent adversarial-review artifact.
- Product-impact measurement distinct from repository build health.

## DO NOT TOUCH

- Canonical aggregate chain semantics.
- Non-custody settlement boundaries.
- Historical migrations.
- Existing REOS capability lifecycle semantics.
- Existing certification evidence or baselines merely to make this experiment green.
- Product runtime architecture solely to support experiment documentation.

## Architectural principle

REOS remains the repository execution authority. Product experiments are a traceability layer above it:

`Problem → Workflow → REOS capability → Code → Verification → E2E → Impact → Promotion`

A product experiment may consume REOS evidence; it may not manufacture or supersede it.

# REOS Product Experiments

Product experiments add **product-intent and outcome evidence** to REOS. They do not replace capability selection, architecture governance, tests, or certification.

REOS answers: **what can be built next, what exists, and whether repository gates pass?**

An experiment answers: **what user problem are we changing, why is the change worthwhile, and did the resulting workflow materially improve?**

## Rules

1. Use an experiment for a material product workflow, architecture change, RC convergence effort, or AI-assisted capability. Small fixes do not require one.
2. One experiment may contain multiple REOS capabilities, but every capability in scope must be explicitly listed in `status.json`.
3. Repository evidence remains authoritative. Experiment prose cannot override the execution manifest, capability registry, architecture rules, tests, or certification.
4. `BLOCKED`, `NOT TESTED`, and `FAILED` are first-class outcomes. Never convert them to `PASS` in prose.
5. Product certification requires both repository verification and the experiment exit gates relevant to the change.
6. Measure the before/after workflow. Shipping code alone is not evidence of product improvement.
7. Keep secrets, credentials, customer data, and production PII out of experiment artifacts.

## Minimal artifact set

Each experiment lives at `docs/governance/reos/experiments/<experiment-id>/` and should contain:

- `status.json` — machine-readable scope and gate state.
- `01-problem-definition.md` — persona, job, pain, frequency, baseline.
- `02-workflow-compression.md` — before/after workflow and target improvement.
- `03-capability-map.md` — HUMAN / AI / SOFTWARE / HYBRID ownership.
- `04-repository-impact.md` — REUSE / EXTEND / ADD / DO NOT TOUCH.
- `05-implementation-plan.md` — bounded work units mapped to REOS capabilities.
- `06-adversarial-review.md` — independent attempt to disprove correctness.
- `07-e2e-certification.md` — real persona/interface/auth/database/business-rule evidence.
- `08-impact-measurement.md` — measured before/after result and final product verdict.

Artifacts may begin as `PENDING`; they must not claim evidence that has not been executed.

## Lifecycle

`proposed → approved → implementing → validating → certified → released`

This lifecycle is separate from REOS capability lifecycle. A repository capability can be implemented while the product experiment remains blocked on E2E or impact evidence.

## First integration target

`EXP-RC1-001` applies this model to the Production MVP / RC1 convergence effort. It intentionally begins from the currently evidenced state rather than declaring a fresh green baseline.

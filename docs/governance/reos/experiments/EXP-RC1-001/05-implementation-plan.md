# EXP-RC1-001 — Implementation Plan

## Objective

Use the current Production MVP / RC1 convergence effort as the first real product experiment and add only the missing product-intent layer to the existing REOS execution system.

## Batch A — Control-layer scaffold

1. Establish experiment rules and lifecycle.
2. Seed machine-readable RC1 status without fabricating PASS states.
3. Record REUSE / EXTEND / ADD / DO NOT TOUCH.
4. Preserve existing REOS as the execution authority.

Exit: experiment structure exists and does not duplicate repository execution machinery.

## Batch B — Product-intent evidence

1. Write the bounded RC1 problem definition from repository and workflow evidence.
2. Map the current end-to-end workflow and target workflow compression.
3. Classify each decision/action as HUMAN, AI, SOFTWARE, or HYBRID.
4. Map the experiment to exact REOS capabilities and acceptance evidence.

Exit: implementation scope can be traced from product problem to repository capability.

## Batch C — Mechanical integration

1. Add an experiment schema/parser inside `packages/reos`.
2. Add a non-mutating experiment validation stage or certification gate.
3. Validate required artifact presence and allowed status values.
4. Fail on contradictory claims such as promotion authorized while a required gate is blocked/failed/not tested.
5. Surface experiment identity in execution reports when a capability is linked.
6. Add unit tests for experiment validation.

Exit: experiment governance is executable rather than prose-only.

## Batch D — RC1 evidence convergence

1. Complete production browser Golden Path certification.
2. Complete persona journeys against real authorization and durable persistence.
3. Complete operational readiness evidence.
4. Execute representative business simulation.
5. Run independent adversarial review in a fresh context.
6. Re-run repository certification.
7. Measure before/after workflow and record product impact.

Exit: all required gates have executed evidence.

## Promotion rule

Promotion remains unauthorized until repository certification and all RC1-required experiment gates are `pass`. A blocked or unavailable environment remains `blocked`; it is not waived by documentation.

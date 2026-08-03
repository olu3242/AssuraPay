# Target Architecture

## Architectural intent
AssuraPay uses a bounded, layered architecture:

1. Domain services encode the execution-assurance rules.
2. Repository interfaces isolate persistence from business logic.
3. Application routes orchestrate authorization, validation, and audit hooks.
4. The web experience surfaces persisted workflow state through the same domain services.

## Core runtime slices
- Workspace and organization foundation.
- Contract, blueprint, milestone, and definition-of-done lifecycle.
- Evidence, validation, acceptance, completion certification, and payment eligibility.

## Non-custody invariant
AssuraPay never holds or controls customer funds. This MVP limits itself to eligibility assessment and certification evidence.

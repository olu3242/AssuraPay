# Execution handoff — finish Batches 4–6

Use the existing AssuraPay composition root and route helpers to instantiate `AgreementIntakeEngine` and `AgreementIntakeConvergenceService`; bind the authoring port to `ContractAuthoringEngine.create`.

Implement the four API routes in `AGREEMENT_INTAKE_API.md`, then the three-choice start and converged review surfaces in `AGREEMENT_INTAKE_UI.md`. Do not create parallel agreement lifecycle APIs.

Persistence adapter must map `agreementIntakes` to the new PostgreSQL table and set tenant/workspace transaction-local context before queries so RLS is enforceable. Add migration registry entries if this repository requires explicit registration.

Run the full gate matrix in `AGREEMENT_THREE_PATH_GATES.md`. Fix failures rather than weakening gates. Only after unit/integration/live-postgres/build/accessibility/browser/regression are green may status move from IMPLEMENTED_AWAITING_FULL_CERTIFICATION to READY.

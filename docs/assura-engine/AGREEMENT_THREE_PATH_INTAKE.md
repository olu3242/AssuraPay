# Agreement Three-Path Intake — E2E Convergence

## Product contract
AssuraPay accepts three starting conditions without creating three agreement domains:

1. `DIRECT_DESCRIPTION` — no formal contract; a party describes the deal.
2. `INFORMAL_ARTIFACT` — quote, invoice, proposal, email/message transcript, PO or similar source.
3. `FORMAL_DOCUMENT` — existing contract/SOW or other formal agreement.

All three converge into the existing governed agreement lifecycle. AI/extraction is proposal-only and cannot accept terms for a party, activate an agreement, approve completion, or release payment.

## Batch 2 — Authoring convergence
A ready intake converts through the existing `ContractAuthoringEngine`; do not introduce a second Agreement aggregate. Conversion must preserve `intakeId`, `sourceType`, source hash/provenance and correlation ID in audit/event metadata. `markConverted` occurs only after canonical agreement creation succeeds. Retrying conversion must be idempotent and return the already-linked agreement.

## Batch 3 — Durable persistence
Persist agreement intake, source-artifact references and clarification state in the production persistence implementation. Enforce tenant/workspace isolation, immutable source hash/provenance after conversion, uniqueness for one canonical agreement per intake, and indexes for workspace/status/source type. Migration forward/backward checks and live PostgreSQL certification are required.

## Batch 4 — Governed HTTP API
Expose authenticated workspace-scoped routes for create/read intake, resolve clarification and convert. Reuse existing route permissions, request context, idempotency/correlation conventions and error mapping. Never accept client-supplied tenant/workspace/actor authority. Artifact/document paths must reference securely stored sources; do not persist raw sensitive document bodies in intake records.

## Batch 5 — Product surface
The agreement start UI presents exactly three entry choices: Create from scratch; Use what you already have; Upload a contract. All paths land on one review/readiness surface showing extracted/proposed terms, source/provenance where applicable, clarity gaps and a review action. Users resolve gaps before conversion. The UI must consume canonical APIs; no hardcoded lifecycle state or browser-only agreement records.

## Batch 6 — E2E certification
Certify each path from intake through canonical agreement creation, proposal/review, readiness and existing activation boundary. Negative tests prove: missing required terms cannot convert; artifact-derived claims require provenance; cross-workspace reads/mutations fail; AI cannot self-accept/activate; duplicate conversion is idempotent; failed conversion does not mark intake converted. Run unit, integration, live PostgreSQL, build, accessibility and browser E2E gates.

## Acceptance invariant
Three ways in. One agreement domain. One governed lifecycle. One downstream execution path: Agree → Perform → Prove → Verify → Pay.
